// Fixture for "the character can see a TikTok link":
//   A  lib/tiktok-link.ts            finding links, hosts, hashtags, the context text
//   B  lib/server/tiktok-lookup.ts   oEmbed, short links, page fallback, the SSRF guards
//   C  app/api/media-lookup/tiktok   the route
//   D  the chat plugin (../App/translated/tiktok-link-viewer.js), driven through a fake ctx
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const L = jiti("./lib/tiktok-link.ts");
const S = jiti("./lib/server/tiktok-lookup.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

// ---- A: helpers --------------------------------------------------------------------------------
eq("A1 finds a plain link", L.extractTikTokUrls("look https://www.tiktok.com/@scout2015/video/6718335390845095173 lol"), ["https://www.tiktok.com/@scout2015/video/6718335390845095173"]);
eq("A2 trims sentence punctuation", L.extractTikTokUrls("(see https://vm.tiktok.com/ZMabc123/), ok?"), ["https://vm.tiktok.com/ZMabc123/"]);
eq("A3 short /t/ link", L.extractTikTokUrls("https://www.tiktok.com/t/ZTRabc12/"), ["https://www.tiktok.com/t/ZTRabc12/"]);
eq("A4 same video twice with tracking params is one link", L.extractTikTokUrls("https://www.tiktok.com/@a/video/1?is_from_webapp=1 and https://www.tiktok.com/@a/video/1?utm=x").length, 1);
eq("A5 lookalike hosts are not TikTok", [L.extractTikTokUrls("https://eviltiktok.com/@a/video/1"), L.extractTikTokUrls("https://tiktok.com.evil.example/@a/video/1")], [[], []]);
eq("A6 max links", L.extractTikTokUrls("https://www.tiktok.com/@a/video/1 https://www.tiktok.com/@a/video/2 https://www.tiktok.com/@a/video/3", 2).length, 2);
eq("A7 no text", [L.extractTikTokUrls(""), L.extractTikTokUrls("nothing here")], [[], []]);
eq("A8 canonical form drops query and fragment", L.canonicalizeTikTokUrl("https://WWW.tiktok.com/@a/video/1/?x=1#y"), "https://www.tiktok.com/@a/video/1");
yes("A9 host allowlists", L.isAllowedTikTokHost("m.tiktok.com") && !L.isAllowedTikTokHost("tiktok.com.evil.example") && L.isAllowedTikTokImageHost("p16-sign.tiktokcdn-us.com") && !L.isAllowedTikTokImageHost("evil.example.com") && !L.isAllowedTikTokImageHost("tiktokcdn.com.evil.example"));
eq("A10 hashtags, any script, de-duplicated", L.extractHashtags("so #fyp #FYP #petsoftiktok #猫咪 lol"), ["fyp", "petsoftiktok", "猫咪"]);
const info = { url: "u", canonicalUrl: "u", title: "Scramble up ur name #fyp", author: "Scout", authorUrl: "", hashtags: ["fyp"], source: "oembed" };
const ctxText = L.formatTikTokContext(info);
yes("A11 context says what is known", /creator Scout/.test(ctxText) && /caption "Scramble up ur name #fyp"/.test(ctxText) && /hashtags #fyp/.test(ctxText), ctxText);
yes("A12 context says what is NOT known", /have not watched the video/.test(ctxText) && /do not invent/.test(ctxText));
yes("A13 failure text does not guess", /could not be read/.test(L.formatTikTokContext(null, "private")) && /do not guess/.test(L.formatTikTokContext(null)));

// ---- B: lookup ---------------------------------------------------------------------------------
const OEMBED = { version: "1.0", type: "video", title: "Scramble up ur name & I'll try to guess it #foryoupage #petsoftiktok", author_name: "Scout, Suki & Stella", author_url: "https://www.tiktok.com/@scout2015", thumbnail_url: "https://p16-sign.tiktokcdn-us.com/obj/cover.jpeg?x=1" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? String(url).startsWith(match) : match.test(String(url))) return handler(String(url), init);
    }
    return new Response("not found", { status: 404 });
  };
  f.calls = calls;
  return f;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const img = (type = "image/jpeg", body = JPEG, extra = {}) => new Response(body, { status: 200, headers: { "content-type": type, ...extra } });

let f = fakeFetch([["https://www.tiktok.com/oembed", () => json(OEMBED)], ["https://p16-sign.tiktokcdn-us.com/", () => img()]]);
let r = await S.lookupTikTok("https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1", { fetchImpl: f, wantThumbnail: true });
eq("B1 oEmbed result", [r.ok, r.info?.author, r.info?.hashtags, r.info?.source, r.info?.authorUrl], [true, "Scout, Suki & Stella", ["foryoupage", "petsoftiktok"], "oembed", "https://www.tiktok.com/@scout2015"]);
yes("B2 oEmbed is asked about the canonical url (no tracking params)", /oembed\?url=https%3A%2F%2Fwww\.tiktok\.com%2F%40scout2015%2Fvideo%2F6718335390845095173$/.test(f.calls[0].url), f.calls[0].url);
yes("B3 the cover frame comes back as a data URL", /^data:image\/jpeg;base64,/.test(r.thumbnailDataUrl || ""));
r = await S.lookupTikTok("https://www.tiktok.com/@a/video/1", { fetchImpl: fakeFetch([["https://www.tiktok.com/oembed", () => json(OEMBED)]]), wantThumbnail: false });
eq("B4 no cover requested, none fetched", [r.ok, r.thumbnailDataUrl], [true, undefined]);

// short links
f = fakeFetch([
  ["https://vm.tiktok.com/ZMabc123/", () => new Response(null, { status: 301, headers: { location: "https://www.tiktok.com/@scout2015/video/6718335390845095173?_r=1&u_code=x" } })],
  ["https://www.tiktok.com/oembed", () => json(OEMBED)],
]);
r = await S.lookupTikTok("https://vm.tiktok.com/ZMabc123/", { fetchImpl: f });
eq("B5 a short link is followed, then oEmbed gets the real url", [r.ok, r.info?.canonicalUrl], [true, "https://www.tiktok.com/@scout2015/video/6718335390845095173"]);
yes("B6 redirects are followed by hand (never automatically)", f.calls[0].init.redirect === "manual");
f = fakeFetch([["https://vm.tiktok.com/EVIL/", () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })]]);
r = await S.lookupTikTok("https://vm.tiktok.com/EVIL/", { fetchImpl: f });
eq("B7 a redirect off TikTok is refused and nothing else is fetched", [r.ok, f.calls.length], [false, 1]);
yes("B8 ...with the metadata address never contacted", !f.calls.some((c) => /169\.254/.test(c.url)));

// refusals
eq("B9 not a TikTok host", (await S.lookupTikTok("https://example.com/@a/video/1", { fetchImpl: fakeFetch([]) })).code, "not_tiktok");
eq("B10 garbage", (await S.lookupTikTok("not a url", { fetchImpl: fakeFetch([]) })).code, "bad_url");
eq("B11 non-web scheme", (await S.lookupTikTok("file:///etc/passwd", { fetchImpl: fakeFetch([]) })).code, "bad_url");

// page fallback and failure
const PAGE = `<html><head><meta property="og:description" content="my cat &amp; me #cat #fyp"/><meta property="og:image" content="https://p16-sign.tiktokcdn.com/o.jpeg"/></head></html>`;
f = fakeFetch([["https://www.tiktok.com/oembed", () => new Response("", { status: 400 })], ["https://www.tiktok.com/@zed/video/9", () => new Response(PAGE, { status: 200 })]]);
r = await S.lookupTikTok("https://www.tiktok.com/@zed/video/9", { fetchImpl: f });
eq("B12 page fallback reads the og tags and the creator from the url", [r.ok, r.info?.title, r.info?.author, r.info?.source, r.info?.hashtags], [true, "my cat & me #cat #fyp", "@zed", "page", ["cat", "fyp"]]);
r = await S.lookupTikTok("https://www.tiktok.com/@zed/video/9", { fetchImpl: fakeFetch([["https://www.tiktok.com/oembed", () => new Response("", { status: 400 })], ["https://www.tiktok.com/@zed", () => new Response("<html></html>", { status: 200 })]]) });
eq("B13 nothing readable is an honest failure", [r.ok, r.code], [false, "unreadable"]);
r = await S.lookupTikTok("https://www.tiktok.com/@zed/video/9", { fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
eq("B14 a timeout is reported as one", [r.ok, r.code], [false, "unreadable"]);

// cover frame guards
const withThumb = (thumbUrl, thumbHandler) => fakeFetch([
  ["https://www.tiktok.com/oembed", () => json({ ...OEMBED, thumbnail_url: thumbUrl })],
  [/^https?:\/\/(?!www\.tiktok\.com\/oembed)/, thumbHandler],
]);
r = await S.lookupTikTok("https://www.tiktok.com/@a/video/1", { fetchImpl: withThumb("https://evil.example.com/c.jpg", () => img()), wantThumbnail: true });
eq("B15 a cover image from a foreign host is never fetched", [r.ok, r.thumbnailDataUrl], [true, undefined]);
r = await S.lookupTikTok("https://www.tiktok.com/@a/video/1", { fetchImpl: withThumb("http://p16.tiktokcdn.com/c.jpg", () => img()), wantThumbnail: true });
eq("B16 plain http cover is not fetched", r.thumbnailDataUrl, undefined);
r = await S.lookupTikTok("https://www.tiktok.com/@a/video/1", { fetchImpl: withThumb("https://p16.tiktokcdn.com/c.html", () => img("text/html")), wantThumbnail: true });
eq("B17 a non-image cover is dropped", r.thumbnailDataUrl, undefined);
r = await S.lookupTikTok("https://www.tiktok.com/@a/video/1", { fetchImpl: withThumb("https://p16.tiktokcdn.com/c.jpg", () => img("image/jpeg", JPEG, { "content-length": "9000000" })), wantThumbnail: true });
eq("B18 an oversized cover is dropped", r.thumbnailDataUrl, undefined);
yes("B19 the lookup still succeeds without the cover", r.ok === true);

// ---- C: the route ------------------------------------------------------------------------------
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://www.tiktok.com/oembed")) return json(OEMBED);
  if (u.startsWith("https://p16-sign.tiktokcdn-us.com/")) return img();
  return new Response("", { status: 404 });
};
const route = jiti("./app/api/media-lookup/tiktok/route.ts");
const get = (q) => route.GET(new Request("https://app.example/api/media-lookup/tiktok" + q));
let res = await get("?url=" + encodeURIComponent("https://www.tiktok.com/@scout2015/video/6718335390845095173") + "&thumb=1");
let body = await res.json();
eq("C1 route returns the reading", [res.status, body.ok, body.author, body.hashtags], [200, true, "Scout, Suki & Stella", ["foryoupage", "petsoftiktok"]]);
yes("C2 ...with the cover as a data URL", /^data:image\/jpeg;base64,/.test(body.thumbnailDataUrl || ""));
res = await get("?url=" + encodeURIComponent("https://www.tiktok.com/@a/video/1"));
body = await res.json();
eq("C3 no thumb flag: no cover", body.thumbnailDataUrl, null);
res = await get("?url=" + encodeURIComponent("https://example.com/x"));
eq("C4 non-TikTok url is a 400", [res.status, (await res.json()).code], [400, "not_tiktok"]);
res = await get("");
eq("C5 missing url", res.status, 400);
res = await get("?url=" + "a".repeat(3000));
eq("C6 oversized url", res.status, 400);

// ---- D: the plugin -----------------------------------------------------------------------------
const PLUGIN = path.resolve("../App/translated/tiktok-link-viewer.js");
const pluginSrc = fs.readFileSync(PLUGIN);
{
  let bad = 0;
  for (const c of pluginSrc) if (c < 9 || (c > 13 && c < 32) || c === 127) bad += 1;
  yes("D0 plugin file has no control characters", bad === 0);
}
const plugin = (await import(pathToFileURL(PLUGIN).href + "?v=" + Date.now())).default;
eq("D1 manifest", [plugin.manifest.id, plugin.manifest.apiVersion, plugin.manifest.permissions.includes("network")], ["tiktok-link-viewer", 1, true]);

function make(settings = {}, serverReply) {
  const store = new Map();
  const calls = [];
  const hooks = {};
  const toasts = [];
  const reply = serverReply || ((u) => ({ status: 200, body: { ok: true, title: "cat does a thing #cat", author: "@catguy", hashtags: ["cat"], thumbnailDataUrl: "data:image/jpeg;base64,AAAA" } }));
  plugin.setup({
    system: {
      settings: { get: (k) => settings[k] },
      storage: { get: (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } },
      fetch: async (url, init) => {
        calls.push(String(url));
        const r = await reply(String(url));
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      },
    },
    ui: { toast: (t) => { toasts.push(t); return { close() {} }; } },
    hooks: { transform: (name, fn) => { hooks[name] = fn; return () => {}; } },
  });
  return { hooks, calls, store, toasts };
}
const LINK = "https://www.tiktok.com/@catguy/video/123";

let p = make();
let sent = await p.hooks["user.beforeSend"]({ text: `omg look ${LINK}`, sessionId: "s1" });
eq("D2 sending is never altered or cancelled", [sent.text, sent.cancelled], [`omg look ${LINK}`, undefined]);
eq("D3 one lookup, to this app's own route, with the cover requested", [p.calls.length, /^\/api\/media-lookup\/tiktok\?url=/.test(p.calls[0]), /&thumb=1$/.test(p.calls[0])], [1, true, true]);
yes("D4 the user sees a notice while it reads", p.toasts.includes("Reading TikTok link..."));

let req = await p.hooks["llm.request"]({ sessionId: "s1", purpose: "chat", messages: [
  { role: "system", content: "SYS" },
  { role: "assistant", content: "hi" },
  { role: "user", content: `omg look ${LINK}` },
] });
const last = req.messages[2];
yes("D5 the link message gains the context and a cover part", Array.isArray(last.content) && last.content[0].type === "text" && last.content[1].type === "image_url" && last.content[1].image_url.url === "data:image/jpeg;base64,AAAA", JSON.stringify(last.content));
const lastText = last.content[0].text;
yes("D6 the original wording is intact and the context follows it", lastText.startsWith(`omg look ${LINK}\n\n(TikTok link context`) && /creator @catguy/.test(lastText) && /caption "cat does a thing #cat"/.test(lastText), lastText);
yes("D7 it says what the character does not know", /have not watched the video/.test(lastText));
eq("D8 no second lookup was needed", p.calls.length, 1);
eq("D9 other messages are untouched", [req.messages[0].content, req.messages[1].content], ["SYS", "hi"]);

const again = await p.hooks["llm.request"]({ sessionId: "s1", purpose: "chat", messages: req.messages });
yes("D10 running it twice does not stack the context", JSON.stringify(again.messages[2]) === JSON.stringify(req.messages[2]));

// cover off
p = make({ useCover: false });
await p.hooks["user.beforeSend"]({ text: LINK });
yes("D11 cover off: not requested", /&thumb=0$/.test(p.calls[0]));
req = await p.hooks["llm.request"]({ messages: [{ role: "user", content: LINK }] });
eq("D12 cover off: text only", typeof req.messages[0].content, "string");

// failure is honest
p = make({}, async () => ({ status: 502, body: { ok: false, error: "TikTok did not return anything readable for this link (private, removed, or blocked)." } }));
await p.hooks["user.beforeSend"]({ text: LINK });
req = await p.hooks["llm.request"]({ messages: [{ role: "user", content: `see ${LINK}` }] });
yes("D13 a failed read is stated, not papered over", /could not be read/.test(req.messages[0].content) && /do not guess/.test(req.messages[0].content), req.messages[0].content);
const callsBefore = p.calls.length;
await p.hooks["user.beforeSend"]({ text: LINK });
eq("D14 a failure is remembered briefly (no hammering)", p.calls.length, callsBefore);

// network error
p = make({}, async () => { throw new Error("offline"); });
await p.hooks["user.beforeSend"]({ text: LINK });
req = await p.hooks["llm.request"]({ messages: [{ role: "user", content: LINK }] });
yes("D15 an unreachable route degrades to the honest text", /could not be read/.test(req.messages[0].content));

// a link that never went through beforeSend (imported from iMessage) is read at request time
p = make();
req = await p.hooks["llm.request"]({ messages: [{ role: "user", content: `from my phone ${LINK}` }] });
eq("D16 imported link is read when the character is about to answer", [p.calls.length, /creator @catguy/.test(JSON.stringify(req.messages[0].content))], [1, true]);

// only the newest linked message triggers a lookup; older ones use the cache
p = make();
await p.hooks["llm.request"]({ messages: [
  { role: "user", content: "https://www.tiktok.com/@a/video/1" },
  { role: "assistant", content: "ok" },
  { role: "user", content: "https://www.tiktok.com/@a/video/2" },
] });
eq("D17 one lookup per request, for the latest message only", p.calls.length, 1);

// limits and settings
p = make({ maxLinks: 1 });
await p.hooks["user.beforeSend"]({ text: "https://www.tiktok.com/@a/video/1 https://www.tiktok.com/@a/video/2" });
eq("D18 maxLinks", p.calls.length, 1);
p = make({ serverBase: "https://other.example.app/" });
await p.hooks["user.beforeSend"]({ text: LINK });
yes("D19 a custom server address is used", p.calls[0].startsWith("https://other.example.app/api/media-lookup/tiktok?url="), p.calls[0]);
p = make();
const noLink = await p.hooks["llm.request"]({ messages: [{ role: "user", content: "just chatting about tiktok.com in general" }] });
eq("D20 text without a link is untouched and costs nothing", [noLink.messages[0].content, p.calls.length], ["just chatting about tiktok.com in general", 0]);
const lookalike = await p.hooks["llm.request"]({ messages: [{ role: "user", content: "https://tiktok.com.evil.example/@a/video/1" }] });
eq("D21 a lookalike domain is never sent to the lookup", [lookalike.messages[0].content, p.calls.length], ["https://tiktok.com.evil.example/@a/video/1", 0]);

// cache hygiene
p = make();
for (let i = 0; i < 40; i += 1) await p.hooks["user.beforeSend"]({ text: `https://www.tiktok.com/@a/video/${1000 + i}` });
const cache = p.store.get("tt_link_cache_v1");
const entries = Object.values(cache);
yes("D22 the cache is bounded and only the newest keep a cover image", entries.length <= 30 && entries.filter((e) => e.thumb).length <= 8, `${entries.length} entries, ${entries.filter((e) => e.thumb).length} covers`);

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
