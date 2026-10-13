// Fixture for reading X (Twitter) posts, the shared link readers, the unified route, the
// iMessage webhook wiring and the "Social Link Viewer" chat plugin.
//   A  lib/x-link.ts                 urls, token, syndication payloads, the context text
//   B  lib/server/x-lookup.ts        the endpoint call and every guard
//   C  lib/server/link-readers.ts    TikTok + X behind one reader
//   D  app/api/media-lookup/link     the route
//   E  imessage webhook handler      links read for the character, stored words untouched
//   F  the plugin (../App/translated/social-link-viewer.js)
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const stub = path.resolve("_fx-spectrum-stub.mjs");
const jiti = require("jiti")(import.meta.url, {
  alias: { "@spectrum-ts/core/webhook": stub, "@spectrum-ts/core": stub, "@spectrum-ts/imessage": stub, "@": path.resolve(".") },
});
const X = jiti("./lib/x-link.ts");
const XL = jiti("./lib/server/x-lookup.ts");
const LR = jiti("./lib/server/link-readers.ts");
const H = jiti("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

// ---- payloads, shaped like what the syndication endpoint really returned ------------------------
const PHOTO_POST = {
  __typename: "Tweet", id_str: "266031293945503744", lang: "en",
  text: "Four more years. http://t.co/bAJE6Vom", display_text_range: [0, 16],
  created_at: "2012-11-07T04:16:18.000Z", favorite_count: 455700,
  user: { name: "Barack Obama", screen_name: "BarackObama" },
  entities: { media: [{ url: "http://t.co/bAJE6Vom" }], urls: [] },
  photos: [{ url: "https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg", width: 800, height: 532 }],
  mediaDetails: [{ type: "photo", url: "http://t.co/bAJE6Vom", media_url_https: "https://pbs.twimg.com/media/A7EiDWcCYAAZT1D.jpg" }],
};
const REPLY_POST = {
  __typename: "Tweet", text: "@jack @dorsey check https://t.co/abc &amp; this &lt;3", display_text_range: [14, 53],
  created_at: "2024-03-05T10:00:00.000Z", favorite_count: 12, conversation_count: 3,
  user: { name: "Zed", screen_name: "zed" },
  entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/page" }] },
};
const QUOTE_VIDEO_POST = {
  __typename: "Tweet", text: "this is wild https://t.co/vid", display_text_range: [0, 13],
  created_at: "2024-05-01T00:00:00.000Z", favorite_count: 2500,
  user: { name: "Mira", screen_name: "mira" },
  entities: { media: [{ url: "https://t.co/vid" }] },
  mediaDetails: [{ type: "video", media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg" }],
  video: { poster: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg" },
  quoted_tweet: { text: "original take", user: { name: "Orig", screen_name: "orig" } },
};

// ---- A: helpers ------------------------------------------------------------------------------
const ids = (s) => X.extractXStatusUrls(s).map((u) => X.parseXStatusUrl(u)?.id);
eq("A1 x.com", X.parseXStatusUrl("https://x.com/BarackObama/status/266031293945503744")?.id, "266031293945503744");
eq("A2 twitter.com with tracking params", X.parseXStatusUrl("https://twitter.com/jack/status/20?s=20&t=abc")?.handle, "jack");
eq("A3 mobile and www hosts", [X.parseXStatusUrl("https://mobile.twitter.com/a/status/12345")?.id, X.parseXStatusUrl("https://www.x.com/a/status/12345")?.id], ["12345", "12345"]);
eq("A4 fixup front-ends people paste", [X.parseXStatusUrl("https://fxtwitter.com/a/status/12345")?.id, X.parseXStatusUrl("https://vxtwitter.com/a/status/12345")?.id, X.parseXStatusUrl("https://fixupx.com/a/status/12345")?.id], ["12345", "12345", "12345"]);
eq("A5 i/web/status", X.parseXStatusUrl("https://x.com/i/web/status/1234567890")?.id, "1234567890");
eq("A6 legacy /statuses/ path", X.parseXStatusUrl("https://twitter.com/a/statuses/12345")?.id, "12345");
eq("A7 lookalike hosts are refused", ["https://x.com.evil.example/a/status/12345", "https://notx.com/a/status/12345", "https://evil.example/x.com/a/status/12345", "https://twitter.com.evil.example/a/status/12345"].map((u) => X.parseXStatusUrl(u)), [null, null, null, null]);
eq("A8 a profile or home link is not a post", [X.parseXStatusUrl("https://x.com/jack"), X.parseXStatusUrl("https://x.com/home")], [null, null]);
eq("A9 non-web scheme", X.parseXStatusUrl("ftp://x.com/a/status/12345"), null);
eq("A10 found in text, punctuation trimmed, deduped across hosts", ids("see (https://x.com/a/status/11111), and https://twitter.com/a/status/11111?s=1 plus https://x.com/b/status/22222!"), ["11111", "22222"]);
eq("A11 canonical url", X.parseXStatusUrl("https://twitter.com/jack/status/20?s=20")?.canonicalUrl, "https://x.com/jack/status/20");
eq("A12 token matches the one X's own embed derives", [X.syndicationToken("20"), X.syndicationToken("266031293945503744")], ["6dq1a2xwd93", "n7rfhxzwhkd"]);
yes("A13 image host allowlist", X.isAllowedXImageHost("pbs.twimg.com") && X.isAllowedXImageHost("video.twimg.com") && !X.isAllowedXImageHost("twimg.com.evil.example") && !X.isAllowedXImageHost("evil.example"));

const ref = (id, handle = "u") => ({ id, handle, canonicalUrl: `https://x.com/${handle}/status/${id}` });
let p = X.parseSyndicationPost(PHOTO_POST, ref("266031293945503744", "BarackObama"));
eq("A14 photo post", [p.author, p.handle, p.text, p.media, p.photoUrls.length, p.likes], ["Barack Obama", "BarackObama", "Four more years.", "photo", 1, 455700]);
p = X.parseSyndicationPost(REPLY_POST, ref("1"));
eq("A15 leading mentions trimmed by display range, t.co expanded, entities decoded", p.text, "check https://example.com/page & this <3");
eq("A16 reply count kept", p.replies, 3);
p = X.parseSyndicationPost(QUOTE_VIDEO_POST, ref("2"));
eq("A17 video post with a quote", [p.media, p.quoted?.handle, p.quoted?.text, typeof p.posterUrl], ["video", "orig", "original take", "string"]);
eq("A18 the media t.co link is removed from the text", p.text, "this is wild");
eq("A19 a tombstone is not a post", X.parseSyndicationPost({ __typename: "TweetTombstone" }, ref("3")), null);
eq("A20 junk is not a post", [X.parseSyndicationPost(null, ref("4")), X.parseSyndicationPost("x", ref("4")), X.parseSyndicationPost({}, ref("4"))], [null, null, null]);
let ctxText = X.formatXContext(X.parseSyndicationPost(PHOTO_POST, ref("266031293945503744", "BarackObama")));
yes("A21 context names author, handle, date and text", /Barack Obama \(@BarackObama\) posted on 7 Nov 2012: "Four more years\."/.test(ctxText), ctxText);
yes("A22 context says what was NOT seen", /not seen the replies, the rest of the thread, or any video/.test(ctxText) && /first picture/.test(ctxText));
yes("A23 likes are formatted", /455,700 likes/.test(ctxText));
ctxText = X.formatXContext(X.parseSyndicationPost(QUOTE_VIDEO_POST, ref("2")));
yes("A24 quote and video are stated", /It has a video/.test(ctxText) && /It quotes Orig \(@orig\): "original take"/.test(ctxText), ctxText);
yes("A25 failure text does not guess", /could not be read/.test(X.formatXContext(null, "deleted")) && /do not guess/.test(X.formatXContext(null)));

// ---- B: the lookup -----------------------------------------------------------------------------
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const img = (type = "image/jpeg", body = JPEG, extra = {}) => new Response(body, { status: 200, headers: { "content-type": type, ...extra } });
function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of handlers) if (String(url).startsWith(match)) return handler(String(url), init);
    return new Response("nope", { status: 404 });
  };
  f.calls = calls;
  return f;
}
let f = fakeFetch([["https://cdn.syndication.twimg.com/tweet-result", () => json(PHOTO_POST)], ["https://pbs.twimg.com/", () => img()]]);
let r = await XL.lookupXPost("https://twitter.com/BarackObama/status/266031293945503744?s=20", { fetchImpl: f, wantImage: true });
eq("B1 post read", [r.ok, r.info?.handle, r.info?.text], [true, "BarackObama", "Four more years."]);
yes("B2 the endpoint gets the id, the derived token and a language", /tweet-result\?id=266031293945503744&token=n7rfhxzwhkd&lang=en$/.test(f.calls[0].url), f.calls[0].url);
yes("B3 the picture is fetched from X's image host and returned as a data URL", /^data:image\/jpeg;base64,/.test(r.imageDataUrl || "") && /^https:\/\/pbs\.twimg\.com\//.test(f.calls[1].url), JSON.stringify(f.calls.map((c) => c.url)));
yes("B4 redirects are not followed for the picture", f.calls[1].init.redirect === "error");
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: fakeFetch([["https://cdn.syndication.twimg.com/", () => json(PHOTO_POST)]]), wantImage: false });
eq("B5 no picture requested, none fetched", [r.ok, r.imageDataUrl], [true, undefined]);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: fakeFetch([["https://cdn.syndication.twimg.com/", () => new Response("", { status: 404 })]]) });
eq("B6 404 is an honest 'not found'", [r.ok, r.code, /deleted, private/.test(r.error)], [false, "unreadable", true]);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: fakeFetch([["https://cdn.syndication.twimg.com/", () => json({ __typename: "TweetTombstone" })]]) });
eq("B7 a tombstone is unreadable", [r.ok, r.code], [false, "unreadable"]);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
eq("B8 timeout", [r.ok, r.code], [false, "timeout"]);
eq("B9 not an X link", (await XL.lookupXPost("https://example.com/a/status/12345", { fetchImpl: fakeFetch([]) })).code, "not_x");
eq("B10 not a url", (await XL.lookupXPost("nope", { fetchImpl: fakeFetch([]) })).code, "bad_url");
eq("B11 profile link is not a post", (await XL.lookupXPost("https://x.com/jack", { fetchImpl: fakeFetch([]) })).code, "not_x");
const withPhoto = (url, handler) => fakeFetch([
  ["https://cdn.syndication.twimg.com/", () => json({ ...PHOTO_POST, photos: [{ url }] })],
  [/^$/.source, handler],
  ["http", handler],
]);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: withPhoto("https://evil.example.com/p.jpg", () => img()), wantImage: true });
eq("B12 a picture from a foreign host is never fetched", [r.ok, r.imageDataUrl], [true, undefined]);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: withPhoto("http://pbs.twimg.com/p.jpg", () => img()), wantImage: true });
eq("B13 plain http picture is not fetched", r.imageDataUrl, undefined);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: withPhoto("https://pbs.twimg.com/p.jpg", () => img("text/html")), wantImage: true });
eq("B14 a non-image answer is dropped", r.imageDataUrl, undefined);
r = await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: withPhoto("https://pbs.twimg.com/p.jpg", () => img("image/jpeg", JPEG, { "content-length": "9000000" })), wantImage: true });
eq("B15 an oversized picture is dropped, the post is still read", [r.ok, r.imageDataUrl], [true, undefined]);
f = fakeFetch([["https://cdn.syndication.twimg.com/", () => json({ ...PHOTO_POST, photos: [{ url: "https://pbs.twimg.com/media/p.jpg" }] })], ["https://pbs.twimg.com/", () => img()]]);
await XL.lookupXPost("https://x.com/a/status/12345", { fetchImpl: f, wantImage: true });
yes("B16 a medium-size variant is requested", /name=medium/.test(f.calls[1].url), f.calls[1].url);

// ---- C: one reader for both sites -----------------------------------------------------------------
const TT = "https://www.tiktok.com/@catguy/video/123";
const XP = "https://x.com/zed/status/55555";
const TTINFO = { url: TT, canonicalUrl: TT, title: "cat does a thing #cat", author: "@catguy", authorUrl: "", hashtags: ["cat"], source: "oembed" };
const lookups = (over = {}) => ({
  tiktok: async (url, o) => ({ ok: true, info: TTINFO, ...(o.wantThumbnail ? { thumbnailDataUrl: "data:image/jpeg;base64,VFQ=" } : {}) }),
  x: async (url, o) => ({ ok: true, info: X.parseSyndicationPost(REPLY_POST, ref("55555", "zed")), ...(o.wantImage ? { imageDataUrl: "data:image/png;base64,WFg=" } : {}) }),
  ...over,
});
eq("C1 classify", [LR.classifyLink(TT), LR.classifyLink(XP), LR.classifyLink("https://example.com/x")], ["tiktok", "x", null]);
eq("C2 links come back in the order they appear", LR.findLinks(`first ${XP} then ${TT}`, 5).map((l) => l.kind), ["x", "tiktok"]);
let res = await LR.readLinksInText(`look ${TT} and ${XP}`, { wantImages: true, lookups: lookups() });
eq("C3 both read, both pictures kept", [res.total, res.readable, res.kinds, res.images.map((i) => i.mimeType)], [2, 2, ["tiktok", "x"], ["image/jpeg", "image/png"]]);
yes("C4 each block is its own site's context", /TikTok link context/.test(res.blocks[0]) && /X post context/.test(res.blocks[1]), JSON.stringify(res.blocks));
res = await LR.readLinksInText(`look ${TT}`, { wantImages: false, lookups: lookups() });
eq("C5 pictures not wanted, none returned", res.images.length, 0);
res = await LR.readLinksInText(`a ${TT} b ${XP}`, { wantImages: true, maxImages: 1, lookups: lookups() });
eq("C6 picture cap", res.images.length, 1);
res = await LR.readLinksInText(`${XP}`, { wantImages: true, lookups: lookups({ x: async () => ({ ok: false, code: "unreadable", error: "deleted" }) }) });
yes("C7 an unreadable link yields an honest block", res.readable === 0 && res.total === 1 && /could not be read/.test(res.blocks[0]), JSON.stringify(res));
res = await LR.readLinksInText(`${XP}`, { wantImages: true, lookups: lookups({ x: async () => { throw new Error("boom"); } }) });
yes("C8 a throwing reader is contained", res.readable === 0 && /could not be read/.test(res.blocks[0]));
res = await LR.readLinksInText("nothing to read here https://example.com", { wantImages: true, lookups: lookups() });
eq("C9 no supported link: nothing happens", [res.total, res.blocks, res.images], [0, [], []]);
res = await LR.readLinksInText(`${TT} https://www.tiktok.com/@a/video/2 ${XP}`, { wantImages: false, maxLinks: 2, lookups: lookups() });
eq("C10 link cap", res.total, 2);

// ---- D: the unified route ---------------------------------------------------------------------------------
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://cdn.syndication.twimg.com/")) return json(PHOTO_POST);
  if (u.startsWith("https://pbs.twimg.com/")) return img();
  if (u.startsWith("https://www.tiktok.com/oembed")) return json({ title: "cat #cat", author_name: "@catguy", author_url: "https://www.tiktok.com/@catguy" });
  return new Response("", { status: 404 });
};
const route = jiti("./app/api/media-lookup/link/route.ts");
const get = (q) => route.GET(new Request("https://app.example/api/media-lookup/link" + q));
let resp = await get("?url=" + encodeURIComponent("https://x.com/BarackObama/status/266031293945503744") + "&image=1");
let body = await resp.json();
eq("D1 X post through the route", [resp.status, body.ok, body.kind, /Four more years/.test(body.context), /^data:image\/jpeg/.test(body.imageDataUrl || "")], [200, true, "x", true, true]);
resp = await get("?url=" + encodeURIComponent(TT));
body = await resp.json();
eq("D2 TikTok through the same route", [resp.status, body.kind, /creator @catguy/.test(body.context), body.imageDataUrl], [200, "tiktok", true, null]);
resp = await get("?url=" + encodeURIComponent("https://example.com/post"));
eq("D3 unsupported site", [resp.status, (await resp.json()).code], [400, "unsupported"]);
resp = await get("?url=" + encodeURIComponent("https://x.com/a/status/99999"));
body = await resp.json();
globalThis.fetch = async () => new Response("", { status: 404 });
resp = await get("?url=" + encodeURIComponent("https://x.com/a/status/99999"));
body = await resp.json();
eq("D4 an unreadable post is a 502 that still carries the honest context", [resp.status, body.ok, /could not be read/.test(body.context)], [502, false, true]);
resp = await get("");
eq("D5 missing url", resp.status, 400);

// ---- E: the webhook ------------------------------------------------------------------------------
const PHONE = "+15551234567";
function world(opts = {}) {
  const store = new Map();
  store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
  store.set("imessage-cloud/runtime/line1.json", {
    format: "x", version: 1, createdAt: "",
    line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: 0 },
    apiConfig: { enableImageRecognition: opts.vision === true },
    promptTemplate: { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" },
  });
  const w = { store, sent: [], gen: [], seen: [] };
  w.deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    listRecentStored: async () => [],
    generate: async (_s, text, _h, images) => { w.gen.push({ text, images: images ?? [] }); return "wow"; },
    send: async (t) => { w.sent.push(t); return "p1"; },
    now: () => 1_000_000,
    sleep: async () => {},
    ...(opts.noReader ? {} : {
      readLinks: (text, o) => LR.readLinksInText(text, { wantImages: o.wantImages, lookups: lookups({
        x: async (url, ox) => { w.seen.push(url); return { ok: true, info: X.parseSyndicationPost(PHOTO_POST, ref("266031293945503744", "BarackObama")), ...(ox.wantImage ? { imageDataUrl: "data:image/jpeg;base64,QUJD" } : {}) }; },
      }) }),
    }),
  };
  return w;
}
const msg = (text) => ({ messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text });
let w = world({ vision: true });
let t = await H.handleInboundMessage(w.deps, msg("lol see https://x.com/BarackObama/status/266031293945503744"));
yes("E1 the post is read and appended to this turn's input", w.gen[0].text.startsWith("lol see https://x.com/") && /Barack Obama \(@BarackObama\) posted on 7 Nov 2012/.test(w.gen[0].text), w.gen[0].text);
eq("E2 the picture reaches the model when vision is on", w.gen[0].images, [{ mimeType: "image/jpeg", dataBase64: "QUJD" }]);
yes("E3 the trace names the site and the picture", /read 1\/1 X link\(s\) with picture/.test(t.detail), t.detail);
eq("E4 the user's words are stored untouched", [...w.store.values()].find((v) => v.direction === "inbound").content, "lol see https://x.com/BarackObama/status/266031293945503744");
w = world({ vision: false });
await H.handleInboundMessage(w.deps, msg("https://x.com/a/status/12345"));
eq("E5 vision off: no picture", w.gen[0].images.length, 0);
w = world({ vision: true });
t = await H.handleInboundMessage(w.deps, msg(`${TT} and https://x.com/a/status/12345`));
yes("E6 TikTok and X in one message, both read", /TikTok link context/.test(w.gen[0].text) && /X post context/.test(w.gen[0].text) && /read 2\/2 TikTok\/X link\(s\)/.test(t.detail), t.detail);
w = world({ noReader: true });
await H.handleInboundMessage(w.deps, msg("https://x.com/a/status/12345"));
eq("E7 no reader wired: unchanged", w.gen[0].text, "https://x.com/a/status/12345");
w = world();
await H.handleInboundMessage(w.deps, msg("no links here"));
eq("E8 no link: text untouched", [w.gen[0].text, w.seen.length], ["no links here", 0]);
const route2 = fs.readFileSync("app/api/imessage/webhook/route.ts", "utf8").replace(/\r\n/g, "\n");
yes("E9 the route wires the shared reader with a time limit", /readLinks: \(text, options\) => readLinksInText\(text, \{ wantImages: options\.wantImages, timeoutMs: 8000 \}\)/.test(route2));

// ---- F: the plugin -------------------------------------------------------------------------------------
const PLUGIN = path.resolve("../App/translated/social-link-viewer.js");
{
  let bad = 0;
  for (const c of fs.readFileSync(PLUGIN)) if (c < 9 || (c > 13 && c < 32) || c === 127) bad += 1;
  yes("F0 plugin has no control characters", bad === 0);
}
const plugin = (await import(pathToFileURL(PLUGIN).href + "?v=" + Date.now())).default;
eq("F1 manifest", [plugin.manifest.id, plugin.manifest.apiVersion], ["social-link-viewer", 1]);
function make(settings = {}, serverReply) {
  const store = new Map();
  const calls = [];
  const hooks = {};
  const reply = serverReply || ((u) => /tiktok/.test(decodeURIComponent(u))
    ? { status: 200, body: { ok: true, kind: "tiktok", context: "(TikTok link context, for you only, never quote it: creator @catguy, caption \"cat\".)", imageDataUrl: "data:image/jpeg;base64,VFQ=" } }
    : { status: 200, body: { ok: true, kind: "x", context: "(X post context, for you only, never quote it: Zed (@zed) posted: \"hello\".)", imageDataUrl: "data:image/png;base64,WFg=" } });
  plugin.setup({
    system: {
      settings: { get: (k) => settings[k] },
      storage: { get: (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } },
      fetch: async (url) => { calls.push(String(url)); const r = await reply(String(url)); return { ok: r.status < 400, status: r.status, json: async () => r.body }; },
    },
    ui: { toast: () => ({ close() {} }) },
    hooks: { transform: (name, fn) => { hooks[name] = fn; return () => {}; } },
  });
  return { hooks, calls, store };
}
const XLINK = "https://x.com/zed/status/55555";
let pl = make();
let sent = await pl.hooks["user.beforeSend"]({ text: `look ${XLINK}` });
eq("F2 sending is never altered", sent.text, `look ${XLINK}`);
yes("F3 one request to the unified route, picture requested", pl.calls.length === 1 && /^\/api\/media-lookup\/link\?url=/.test(pl.calls[0]) && /&image=1$/.test(pl.calls[0]), pl.calls[0]);
let req = await pl.hooks["llm.request"]({ messages: [{ role: "system", content: "S" }, { role: "user", content: `look ${XLINK}` }] });
let m = req.messages[1];
yes("F4 the server's context sits after the user's words, with the picture", Array.isArray(m.content) && m.content[0].text.startsWith(`look ${XLINK}\n\n(X post context`) && m.content[1].image_url.url === "data:image/png;base64,WFg=", JSON.stringify(m.content));
eq("F5 no second lookup", pl.calls.length, 1);
const again = await pl.hooks["llm.request"]({ messages: req.messages });
yes("F6 idempotent", JSON.stringify(again.messages[1]) === JSON.stringify(req.messages[1]));
pl = make({ useImage: false });
await pl.hooks["user.beforeSend"]({ text: XLINK });
req = await pl.hooks["llm.request"]({ messages: [{ role: "user", content: XLINK }] });
yes("F7 pictures off: text only and not requested", typeof req.messages[0].content === "string" && /&image=0$/.test(pl.calls[0]));
pl = make({}, async () => ({ status: 502, body: { ok: false, kind: "x", context: "(X post context, for you only, never quote it: the user shared a link to an X post but it could not be read (deleted). Say so honestly.)", error: "deleted" } }));
await pl.hooks["user.beforeSend"]({ text: XLINK });
req = await pl.hooks["llm.request"]({ messages: [{ role: "user", content: XLINK }] });
yes("F8 an unreadable link still gives the honest block, and no picture", /could not be read/.test(req.messages[0].content) && typeof req.messages[0].content === "string");
pl = make({}, async () => { throw new Error("offline"); });
await pl.hooks["user.beforeSend"]({ text: XLINK });
req = await pl.hooks["llm.request"]({ messages: [{ role: "user", content: XLINK }] });
yes("F9 unreachable route degrades to the honest text", /could not be read/.test(req.messages[0].content));
pl = make();
req = await pl.hooks["llm.request"]({ messages: [{ role: "user", content: `from my phone ${XLINK} and https://www.tiktok.com/@catguy/video/123` }] });
yes("F10 imported links are read at request time, both kinds", pl.calls.length === 2 && /X post context/.test(JSON.stringify(req.messages[0].content)) && /TikTok link context/.test(JSON.stringify(req.messages[0].content)), String(pl.calls.length));
pl = make();
const none = await pl.hooks["llm.request"]({ messages: [{ role: "user", content: "x.com is down, twitter.com too, https://x.com/jack" }] });
eq("F11 a profile link or plain domains are not links to read", [none.messages[0].content, pl.calls.length], ["x.com is down, twitter.com too, https://x.com/jack", 0]);
const fake = await pl.hooks["llm.request"]({ messages: [{ role: "user", content: "https://x.com.evil.example/a/status/12345" }] });
eq("F12 a lookalike host is never sent for lookup", pl.calls.length, 0);

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
