// Fixture: a TikTok link sent over real iMessage is read by the webhook itself (the chat
// plugin that does this inside the app cannot run on the server).
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const stub = path.resolve("_fx-spectrum-stub.mjs");
const jiti = require("jiti")(import.meta.url, {
  alias: { "@spectrum-ts/core/webhook": stub, "@spectrum-ts/core": stub, "@spectrum-ts/imessage": stub, "@": path.resolve(".") },
});
const H = jiti("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const PHONE = "+15551234567";
const LINK = "https://www.tiktok.com/@catguy/video/123";
const INFO = { url: LINK, canonicalUrl: LINK, title: "cat does a thing #cat", author: "@catguy", authorUrl: "", hashtags: ["cat"], source: "oembed" };

function world(opts = {}) {
  const store = new Map();
  store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
  store.set("imessage-cloud/runtime/line1.json", {
    format: "x", version: 1, createdAt: "",
    line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: opts.delay ?? 0 },
    apiConfig: { enableImageRecognition: opts.vision === true },
    promptTemplate: { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" },
  });
  const w = { store, sent: [], gen: [], lookups: [], clock: 1_000_000 };
  w.deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    listRecentStored: async () => [...store.entries()].filter(([k]) => k.includes("/messages/")).map(([, v]) => v),
    generate: async (_s, text, _h, images) => { w.gen.push({ text, images: images ?? [] }); return "ha that is so cute"; },
    send: async (t) => { w.sent.push(t); return "p" + w.sent.length; },
    now: () => w.clock,
    sleep: async (ms) => { w.clock += ms; },
    ...(opts.noReader ? {} : {
      readTikTok: async (url, o) => {
        w.lookups.push({ url, wantThumbnail: o.wantThumbnail });
        if (opts.reader) return opts.reader(url, o);
        return { ok: true, info: INFO, ...(o.wantThumbnail ? { thumbnailDataUrl: "data:image/jpeg;base64,QUJD" } : {}) };
      },
    }),
  };
  return w;
}
const msg = (text, over = {}) => ({ messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text, ...over });
const run = (w, text, over) => H.handleInboundMessage(w.deps, msg(text, over));

// A: the basics
let w = world();
let t = await run(w, `omg look ${LINK}`);
eq("A1 replied", [t.result, w.sent], ["replied", ["ha that is so cute"]]);
eq("A2 one lookup, for the link", w.lookups.map((l) => l.url), [LINK]);
yes("A3 the user's words come first, the context follows", w.gen[0].text.startsWith(`omg look ${LINK}\n\n(TikTok link context`), w.gen[0].text);
yes("A4 creator and caption are in it", /creator @catguy/.test(w.gen[0].text) && /caption "cat does a thing #cat"/.test(w.gen[0].text));
yes("A5 and it says the video was not watched", /have not watched the video/.test(w.gen[0].text));
yes("A6 the trace says a link was read", /read 1\/1 TikTok link\(s\)/.test(t.detail), t.detail);
const inbound = [...w.store.values()].find((v) => v.direction === "inbound");
eq("A7 the stored record keeps the user's words untouched", inbound.content, `omg look ${LINK}`);

// B: the cover frame
w = world({ vision: false });
await run(w, LINK);
eq("B1 no vision: the cover is not even requested", [w.lookups[0].wantThumbnail, w.gen[0].images.length], [false, 0]);
w = world({ vision: true });
t = await run(w, LINK);
eq("B2 vision on: the cover is requested and reaches the model", [w.lookups[0].wantThumbnail, w.gen[0].images], [true, [{ mimeType: "image/jpeg", dataBase64: "QUJD" }]]);
yes("B3 the trace mentions the cover", /with cover/.test(t.detail), t.detail);

// C: failures are stated honestly and never block the reply
w = world({ reader: async () => ({ ok: false, code: "unreadable", error: "TikTok did not return anything readable for this link (private, removed, or blocked)." }) });
t = await run(w, `see ${LINK}`);
yes("C1 unreadable: the model is told, and told not to guess", /could not be read/.test(w.gen[0].text) && /do not guess/.test(w.gen[0].text), w.gen[0].text);
eq("C2 the reply still goes out", [t.result, w.sent.length], ["replied", 1]);
yes("C3 trace counts 0 of 1", /read 0\/1/.test(t.detail), t.detail);
w = world({ reader: async () => { throw new Error("boom"); } });
t = await run(w, LINK);
eq("C4 a throwing reader is contained", [t.result, /could not be read/.test(w.gen[0].text)], ["replied", true]);

// D: when nothing should happen
w = world();
await run(w, "just saying hi, tiktok.com is fun");
eq("D1 text without a link: no lookup, text untouched", [w.lookups.length, w.gen[0].text], [0, "just saying hi, tiktok.com is fun"]);
w = world();
await run(w, "https://tiktok.com.evil.example/@a/video/1");
eq("D2 lookalike host is not looked up", w.lookups.length, 0);
w = world({ noReader: true });
await run(w, LINK);
eq("D3 no reader wired: the link passes through unchanged", w.gen[0].text, LINK);
w = world();
await run(w, "https://www.tiktok.com/@a/video/1 https://www.tiktok.com/@a/video/2 https://www.tiktok.com/@a/video/3");
eq("D4 at most two links per turn", w.lookups.length, 2);

// E: a burst, answered once, still reads the link from the earlier bubble
w = world({ delay: 30 });
const first = run(w, `check this ${LINK}`, { messageId: "m1" });
const second = (async () => { await Promise.resolve(); w.clock += 5000; return run(w, "so funny right", { messageId: "m2" }); })();
const results = await Promise.all([first, second]);
const answered = results.find((r) => r.reason === "replied");
yes("E1 one reply for the burst", w.gen.length === 1 && !!answered, JSON.stringify(results.map((r) => r.reason)));
yes("E2 the link from the first bubble was read", /creator @catguy/.test(w.gen[0]?.text || ""), w.gen[0]?.text);

// F: wiring
const route = fs.readFileSync("app/api/imessage/webhook/route.ts", "utf8").replace(/\r\n/g, "\n");
yes("F1 the route wires the real lookup, with a time limit", /readTikTok: \(url, options\) => lookupTikTok\(url, \{ wantThumbnail: options\.wantThumbnail, timeoutMs: 8000 \}\)/.test(route));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
