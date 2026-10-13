// Spotify / Apple Music links: reading them, finding real links for songs, dropping invented ones.
//   A  lib/music-link.ts            urls, embed parsing, the context text
//   B  lib/server/music-lookup.ts   lookups, guards, search, verification
//   C  lib/server/link-readers.ts   music behind the shared reader
//   D  imessage content + handler   [MusicShare] -> real link bubble, dead links removed
//   E  the plugin                   ../App/translated/social-link-viewer.js
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const stub = path.resolve("_fx-spectrum-stub.mjs");
const jiti = require("jiti")(import.meta.url, {
  alias: { "@spectrum-ts/core/webhook": stub, "@spectrum-ts/core": stub, "@spectrum-ts/imessage": stub, "@": path.resolve(".") },
});
const M = jiti("./lib/music-link.ts");
const ML = jiti("./lib/server/music-lookup.ts");
const LR = jiti("./lib/server/link-readers.ts");
const C = jiti("./lib/imessage-content.ts");
const H = jiti("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const SP_TRACK = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
const SP_ALBUM = "https://open.spotify.com/album/6dVIqQ8qmQ5GBnJ9shOYGE";
const AP_SONG = "https://music.apple.com/us/album/blinding-lights-remix/1542842760?i=1542842761";

// ---- A -----------------------------------------------------------------------------------------
eq("A1 spotify track", M.parseMusicUrl(SP_TRACK)?.kind, "track");
eq("A2 spotify intl + query", M.parseMusicUrl("https://open.spotify.com/intl-id/album/6dVIqQ8qmQ5GBnJ9shOYGE?si=abc")?.id, "6dVIqQ8qmQ5GBnJ9shOYGE");
eq("A3 spotify embed form", M.parseMusicUrl("https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT")?.canonicalUrl, SP_TRACK);
eq("A4 spotify old user playlist", M.parseMusicUrl("https://open.spotify.com/user/someone/playlist/37i9dQZF1DXcBWIGoYBM5M")?.kind, "playlist");
eq("A5 spotify id of wrong length", M.parseMusicUrl("https://open.spotify.com/track/short"), null);
eq("A6 apple album link with ?i= is a song", { k: M.parseMusicUrl(AP_SONG)?.kind, t: M.parseMusicUrl(AP_SONG)?.trackId }, { k: "track", t: "1542842761" });
eq("A7 apple storefront", M.parseMusicUrl("https://music.apple.com/jp/album/x/123456")?.country, "jp");
eq("A8 apple playlist id", M.parseMusicUrl("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb")?.id, "pl.f4d106fed2bd41149aaacabb233eb5eb");
eq("A9 itunes host", M.parseMusicUrl("https://itunes.apple.com/us/album/foo/id1440857781")?.id, "1440857781");
eq("A10 lookalike host", M.parseMusicUrl("https://open.spotify.com.evil.example/track/4cOdK2wGLETKBW3PvgPWqT"), null);
eq("A11 another site", M.parseMusicUrl("https://example.com/track/4cOdK2wGLETKBW3PvgPWqT"), null);
eq("A12 profile / home page is not an item", M.parseMusicUrl("https://open.spotify.com/"), null);
eq("A13 extract strips punctuation and dedupes", M.extractMusicUrls(`listen (${SP_TRACK}), also ${SP_TRACK}!`, 3), [SP_TRACK]);
eq("A14 extract finds both services", M.extractMusicUrls(`${SP_TRACK} and ${AP_SONG}`, 3).length, 2);
yes("A15 image hosts", M.isAllowedMusicImageHost("image-cdn-ak.spotifycdn.com") && M.isAllowedMusicImageHost("is1-ssl.mzstatic.com") && !M.isAllowedMusicImageHost("evil.example") && !M.isAllowedMusicImageHost("mzstatic.com.evil.example"));

const embedHtml = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
const trackEmbed = embedHtml({ type: "track", name: "Never Gonna Give You Up", title: "Never Gonna Give You Up", artists: [{ name: "Rick Astley" }], releaseDate: { isoString: "1987-11-12T00:00:00Z" } });
const albumEmbed = embedHtml({ type: "album", title: "OK Computer", subtitle: "Radiohead", trackList: [{ title: "Airbag" }, { title: "Paranoid Android" }, { title: "Subterranean Homesick Alien" }] });
eq("A16 embed: track", M.parseSpotifyEmbedHtml(trackEmbed), { title: "Never Gonna Give You Up", by: "Rick Astley", year: "1987" });
eq("A17 embed: album", M.parseSpotifyEmbedHtml(albumEmbed), { title: "OK Computer", by: "Radiohead", tracks: ["Airbag", "Paranoid Android", "Subterranean Homesick Alien"], trackCount: 3 });
eq("A18 embed: junk", M.parseSpotifyEmbedHtml("<html>nothing</html>"), null);
eq("A19 embed: broken json", M.parseSpotifyEmbedHtml(`<script id="__NEXT_DATA__" type="application/json">{oops</script>`), null);

const ctx = M.formatMusicContext({ service: "spotify", kind: "track", url: SP_TRACK, title: "Never Gonna Give You Up", by: "Rick Astley", album: "Whenever You Need Somebody", year: "1987" });
yes("A20 context has the facts", /Spotify song "Never Gonna Give You Up" by Rick Astley/.test(ctx) && /Whenever You Need Somebody/.test(ctx) && /1987/.test(ctx), ctx);
yes("A21 context says what is NOT known", /cannot hear it/.test(ctx) && /do not invent/.test(ctx) && /for you only/.test(ctx));
const bad = M.formatMusicContext(null, "not found", { service: "apple_music", kind: "track" });
yes("A22 failure context is honest", /Apple Music link/.test(bad) && /could not be read/.test(bad) && /do not guess/.test(bad), bad);

// ---- B: lookups with a scripted fetch ---------------------------------------------------------
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
const html = (text, status = 200) => new Response(text, { status, headers: { "content-type": "text/html" } });
const png = () => new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });

function scripted(routes, log = []) {
  return async (url) => {
    log.push(url);
    for (const [test, make] of routes) if (test(url)) return make(url);
    return new Response("", { status: 404 });
  };
}

{
  const log = [];
  const f = scripted([
    [(u) => u.includes("/oembed"), () => json({ title: "Never Gonna Give You Up", thumbnail_url: "https://image-cdn-ak.spotifycdn.com/image/abc" })],
    [(u) => u.includes("/embed/track/"), () => html(trackEmbed)],
    [(u) => u.includes("spotifycdn.com"), () => png()],
  ], log);
  const r = await ML.lookupMusicLink(SP_TRACK, { fetchImpl: f, wantImage: true });
  eq("B1 spotify track read", r.ok && { t: r.info.title, by: r.info.by, y: r.info.year, img: Boolean(r.imageDataUrl) }, { t: "Never Gonna Give You Up", by: "Rick Astley", y: "1987", img: true });
  yes("B2 only fixed hosts were contacted", log.every((u) => /^https:\/\/(open\.spotify\.com|image-cdn-ak\.spotifycdn\.com)\//.test(u)), log.join(" "));
}
{
  // embed page unavailable: oEmbed alone still gives the title
  const f = scripted([[(u) => u.includes("/oembed"), () => json({ title: "Only Title", thumbnail_url: "https://evil.example/x.png" })], [(u) => u.includes("evil.example"), () => png()]]);
  const r = await ML.lookupMusicLink(SP_TRACK, { fetchImpl: f, wantImage: true });
  eq("B3 oEmbed-only still reads, and a foreign cover host is never fetched", r.ok && { t: r.info.title, img: Boolean(r.imageDataUrl) }, { t: "Only Title", img: false });
}
{
  const log = [];
  const f = scripted([[(u) => u.includes("/oembed"), () => json({ title: "x", thumbnail_url: "http://image-cdn-ak.spotifycdn.com/a" })], [(u) => u.includes("spotifycdn.com"), () => png()]], log);
  const r = await ML.lookupMusicLink(SP_TRACK, { fetchImpl: f, wantImage: true });
  yes("B4 plain http cover is not fetched", r.ok && !r.imageDataUrl && !log.some((u) => u.startsWith("http://")));
}
{
  const f = scripted([[(u) => u.includes("/oembed"), () => new Response("", { status: 404 })], [(u) => u.includes("/embed/"), () => new Response("", { status: 404 })]]);
  const r = await ML.lookupMusicLink(SP_TRACK, { fetchImpl: f });
  yes("B5 missing spotify item is an honest failure", !r.ok && r.code === "unreadable" && /not found/i.test(r.error), JSON.stringify(r));
}
{
  const f = scripted([
    [(u) => u.includes("itunes.apple.com/lookup") && u.includes("id=1542842761"), () => json({ resultCount: 1, results: [{ wrapperType: "track", trackName: "Blinding Lights (Remix)", artistName: "The Weeknd & ROSALIA", collectionName: "Blinding Lights (Remix) - Single", releaseDate: "2021-03-05T08:00:00Z", artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg" }] })],
    [(u) => u.includes("mzstatic.com/image/thumb/a/300x300bb.jpg"), () => png()],
  ]);
  const r = await ML.lookupMusicLink(AP_SONG, { fetchImpl: f, wantImage: true });
  eq("B6 apple song via the song id", r.ok && { t: r.info.title, by: r.info.by, a: r.info.album, y: r.info.year, img: Boolean(r.imageDataUrl) }, { t: "Blinding Lights (Remix)", by: "The Weeknd & ROSALIA", a: "Blinding Lights (Remix) - Single", y: "2021", img: true });
}
{
  const f = scripted([[(u) => u.includes("itunes.apple.com/lookup") && u.includes("entity=song"), () => json({ resultCount: 3, results: [
    { wrapperType: "collection", collectionName: "In Between Dreams", artistName: "Jack Johnson", releaseDate: "2005-03-01T08:00:00Z", trackCount: 15 },
    { wrapperType: "track", trackName: "Better Together" }, { wrapperType: "track", trackName: "Banana Pancakes" }] })]]);
  const r = await ML.lookupMusicLink("https://music.apple.com/us/album/in-between-dreams/1440857781", { fetchImpl: f });
  eq("B7 apple album with tracks", r.ok && { t: r.info.title, tr: r.info.tracks, n: r.info.trackCount }, { t: "In Between Dreams", tr: ["Better Together", "Banana Pancakes"], n: 15 });
}
{
  const f = scripted([[(u) => u.includes("music.apple.com") && u.includes("pl.f4d1"), () => html(`<meta property="og:title" content="Today&#x27;s Hits on Apple Music"><meta property="og:description" content="Playlist · 50 Songs">`)]]);
  const r = await ML.lookupMusicLink("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb", { fetchImpl: f });
  eq("B8 apple playlist via og tags", r.ok && { t: r.info.title, n: r.info.trackCount }, { t: "Today's Hits", n: 50 });
}
{
  const calls = [];
  const f = scripted([[(u) => u.includes("itunes.apple.com/lookup"), (u) => { calls.push(u); return json(u.includes("country=us") ? { resultCount: 1, results: [{ trackName: "S", artistName: "A" }] } : { resultCount: 0, results: [] }); }]]);
  const r = await ML.lookupMusicLink("https://music.apple.com/jp/song/s/1234567", { fetchImpl: f });
  yes("B9 falls back to the US storefront once", r.ok && calls.length === 2, JSON.stringify(calls));
}
{
  const r = await ML.lookupMusicLink("https://example.com/track/4cOdK2wGLETKBW3PvgPWqT", { fetchImpl: async () => { throw new Error("must not be called"); } });
  yes("B10 a non-music link never reaches the network", !r.ok && r.code === "not_music");
}
{
  const hang = (url, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }));
  const r = await ML.lookupMusicLink(AP_SONG, { fetchImpl: hang, timeoutMs: 40 });
  yes("B11 a stalled service times out cleanly", !r.ok && r.code === "timeout", JSON.stringify(r));
}

// search
{
  const f = scripted([[(u) => u.includes("itunes.apple.com/search"), () => json({ resultCount: 1, results: [{ trackName: "Blinding Lights", artistName: "The Weeknd", trackViewUrl: "https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378112&uo=4" }] })]]);
  const hit = await ML.searchMusicLink("Blinding Lights The Weeknd", { fetchImpl: f, env: {} });
  eq("B12 apple search gives a clean, real link", hit, { service: "apple_music", title: "Blinding Lights", artist: "The Weeknd", url: "https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378112" });
}
{
  const log = [];
  const f = scripted([
    [(u) => u.includes("accounts.spotify.com/api/token"), () => json({ access_token: "tok", expires_in: 3600 })],
    [(u) => u.includes("api.spotify.com/v1/search"), () => json({ tracks: { items: [{ name: "Blinding Lights", artists: [{ name: "The Weeknd" }], external_urls: { spotify: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b" } }] } })],
    [(u) => u.includes("itunes.apple.com/search"), () => json({ resultCount: 0, results: [] })],
  ], log);
  const hit = await ML.searchMusicLink("Blinding Lights", { prefer: "spotify", fetchImpl: f, env: { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }, now: 1 });
  eq("B13 spotify search with credentials", hit?.url, "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b");
}
{
  const log = [];
  const f = scripted([[(u) => u.includes("itunes.apple.com/search"), () => json({ resultCount: 1, results: [{ trackName: "T", artistName: "A", trackViewUrl: "https://music.apple.com/us/album/t/1234567?i=7654321" }] })]], log);
  const hit = await ML.searchMusicLink("T", { prefer: "spotify", fetchImpl: f, env: {} });
  yes("B14 spotify preferred but no credentials: Apple Music, and Spotify is never called", hit?.service === "apple_music" && !log.some((u) => u.includes("spotify")), JSON.stringify(log));
}
{
  const f = scripted([[(u) => u.includes("itunes.apple.com/search"), () => json({ resultCount: 1, results: [{ trackName: "T", artistName: "A", trackViewUrl: "https://evil.example/phish" }] })]]);
  eq("B15 a result that is not a music link is discarded", await ML.searchMusicLink("T", { fetchImpl: f, env: {} }), null);
}
eq("B16 empty query", await ML.searchMusicLink("   ", { fetchImpl: async () => { throw new Error("no"); } }), null);

// verification
{
  eq("B17 spotify real", await ML.verifyMusicLink(SP_TRACK, { fetchImpl: async () => json({ title: "x" }) }), true);
  eq("B18 spotify invented", await ML.verifyMusicLink(SP_TRACK, { fetchImpl: async () => new Response("", { status: 404 }) }), false);
  eq("B19 spotify unknown (server error) is left alone", await ML.verifyMusicLink(SP_TRACK, { fetchImpl: async () => new Response("", { status: 503 }) }), null);
  eq("B20 apple invented", await ML.verifyMusicLink(AP_SONG, { fetchImpl: async () => json({ resultCount: 0, results: [] }) }), false);
  eq("B21 apple real", await ML.verifyMusicLink(AP_SONG, { fetchImpl: async () => json({ resultCount: 1, results: [{}] }) }), true);
  eq("B22 network failure is unknown, not false", await ML.verifyMusicLink(AP_SONG, { fetchImpl: async () => { throw new Error("down"); } }), null);
}

// ---- C: shared reader --------------------------------------------------------------------------
{
  const lookups = {
    music: async (url) => ({ ok: true, info: { service: "spotify", kind: "track", url, title: "Song", by: "Band" } }),
    tiktok: async () => ({ ok: false, error: "nope" }),
  };
  eq("C1 classify", [LR.classifyLink(SP_TRACK), LR.classifyLink(AP_SONG), LR.classifyLink("https://example.com")], ["spotify", "apple_music", null]);
  const r = await LR.readLinksInText(`${SP_TRACK} and ${AP_SONG}`, { wantImages: false, lookups });
  eq("C2 both read", { total: r.total, readable: r.readable, kinds: r.kinds }, { total: 2, readable: 2, kinds: ["spotify", "apple_music"] });
  yes("C3 context is attached", r.blocks.every((b) => /Music link context, for you only/.test(b)));
  const bad = await LR.readLinksInText(SP_TRACK, { wantImages: false, lookups: { music: async () => ({ ok: false, code: "unreadable", error: "gone" }) } });
  yes("C4 an unreadable link is stated honestly", bad.readable === 0 && /could not be read/.test(bad.blocks[0]) && /Spotify link/.test(bad.blocks[0]), bad.blocks[0]);
  const thrown = await LR.readLinksInText(SP_TRACK, { wantImages: false, lookups: { music: async () => { throw new Error("boom"); } } });
  yes("C5 a throwing reader never throws out", thrown.total === 1 && thrown.readable === 0);
}

// ---- D: iMessage outbound ----------------------------------------------------------------------
{
  const plan = C.planOutbound("this one is perfect\n\n[MusicShare:Blinding Lights - The Weeknd]\n\nlisten tonight", { currentId: "m1", currentText: "hi", known: [] });
  eq("D1 the share is recorded with the bubble it lives in", plan.musicShares, [{ query: "Blinding Lights - The Weeknd", bubbleIndex: 1 }]);
  yes("D2 the text line is still there for when no link is found", plan.bubbles.some((b) => b.text.includes("Blinding Lights")), JSON.stringify(plan.bubbles));
  eq("D3 no music tag, no shares", C.planOutbound("hello", { currentId: "m", currentText: "", known: [] }).musicShares, []);
}
{
  const bubbles = [{ text: "this one is perfect" }, { text: "🎵 Blinding Lights - The Weeknd" }, { text: "listen tonight" }];
  const notes = [];
  const out = await H.finalizeMusicBubbles({ resolveMusicShare: async () => ({ url: "https://music.apple.com/us/album/x/1?i=2" }) }, bubbles, [{ query: "Blinding Lights", bubbleIndex: 1 }], notes);
  eq("D4 the link is its own bubble right after the song line", out.map((b) => b.text), ["this one is perfect", "🎵 Blinding Lights - The Weeknd", "https://music.apple.com/us/album/x/1?i=2", "listen tonight"]);
  yes("D5 trace note", notes.includes("1 music link(s) added"));
}
{
  const out = await H.finalizeMusicBubbles({ resolveMusicShare: async () => null }, [{ text: "🎵 Obscure" }], [{ query: "Obscure", bubbleIndex: 0 }], []);
  eq("D6 no link found: the text line stays", out.map((b) => b.text), ["🎵 Obscure"]);
}
{
  const notes = [];
  const out = await H.finalizeMusicBubbles(
    { verifyMusicLink: async (u) => (u === SP_TRACK ? false : true) },
    [{ text: `try this ${SP_TRACK}` }, { text: AP_SONG }, { text: SP_TRACK }],
    [], notes);
  eq("D7 an invented link is stripped, a real one kept, and an emptied bubble disappears", out.map((b) => b.text), ["try this", AP_SONG]);
  yes("D8 note", notes.includes("2 dead music link(s) removed"), notes.join("|"));
}
{
  const bubbles = [{ text: "a" }];
  const out = await H.finalizeMusicBubbles({ resolveMusicShare: async () => { throw new Error("x"); }, verifyMusicLink: async () => { throw new Error("y"); } }, bubbles, [{ query: "q", bubbleIndex: 0 }], []);
  eq("D9 failing services leave the bubbles untouched", out.map((b) => b.text), ["a"]);
}
{
  const out = await H.finalizeMusicBubbles(
    { resolveMusicShare: async () => ({ url: "https://music.apple.com/us/album/x/1?i=2" }) },
    [{ text: "🎵 One" }, { text: "🎵 Two" }, { text: "🎵 Three" }],
    [{ query: "One", bubbleIndex: 0 }, { query: "Two", bubbleIndex: 1 }, { query: "Three", bubbleIndex: 2 }], []);
  eq("D10 at most two links per reply", out.filter((b) => b.text.startsWith("https://")).length, 2);
}
{
  const out = await H.finalizeMusicBubbles(
    { resolveMusicShare: async () => ({ url: "https://music.apple.com/us/album/x/1?i=2" }) },
    [{ text: "🎵 One", replyToId: "p1" }], [{ query: "One", bubbleIndex: 0 }], []);
  yes("D11 the quote on the song line is kept, the link bubble is a plain one", out[0].replyToId === "p1" && out[1].replyToId === undefined);
}

// ---- E: the plugin -----------------------------------------------------------------------------
{
  const file = path.resolve("..", "App", "translated", "social-link-viewer.js");
  if (!fs.existsSync(file)) { console.log("(plugin not found, E skipped)"); }
  else {
    const src = fs.readFileSync(file, "utf8");
    const mod = await import(pathToFileURL(file).href + "?t=" + Math.random());
    yes("E1 version bumped and mentions music", mod.default.manifest.version === "1.1.0" && /Spotify/.test(mod.default.manifest.description));
    yes("E2 annotated marker covers the music block", /Music link context\|?/.test(src) && src.includes("Music link context"));
    const hooks = {};
    const store = new Map();
    const cacheless = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    const fetched = [];
    const ctx = {
      system: { settings: { get: () => undefined }, storage: cacheless, fetch: async (u) => { fetched.push(u); return new Response(JSON.stringify({ ok: true, kind: "spotify", context: "(Music link context, for you only, never quote it: stub)" }), { status: 200 }); } },
      hooks: { transform: (name, fn) => { hooks[name] = fn; return () => {}; } },
      ui: { toast: () => ({ close() {} }) },
    };
    mod.default.setup(ctx);
    await hooks["user.beforeSend"]({ text: `listen ${SP_TRACK}` });
    yes("E3 a Spotify link is sent to the lookup route", fetched.length === 1 && fetched[0].includes("/api/media-lookup/link?url=" + encodeURIComponent(SP_TRACK)), fetched.join(" "));
    await hooks["user.beforeSend"]({ text: "https://open.spotify.com/" });
    yes("E4 the Spotify home page is not a lookup", fetched.length === 1);
    const req = await hooks["llm.request"]({ messages: [{ role: "user", content: `listen ${AP_SONG}` }] });
    yes("E5 the context is attached to the model's copy only", /Music link context/.test(req.messages[0].content) && fetched.length === 2);
  }
}

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
