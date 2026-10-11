// Fixture for inbound photos over iMessage: reading the attachment, handing it to the model
// as an image part, storing it, and saying so in the trace when the model cannot see it.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const C = jiti("./lib/imessage-content.ts");
const H = jiti("./lib/imessage-webhook-handler.ts");
const W = jiti("./lib/imessage-webhook-core.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

// ---- A: reading the attachment ----------------------------------------------------------
const att = (mimeType, extra = {}) => ({ type: "attachment", id: "a1", name: "IMG_1.jpg", mimeType, size: 1234, read: async () => new Uint8Array([1, 2, 3]), ...extra });
let r = C.readInboundContent(att("image/jpeg"));
eq("A1 jpeg is an image", [r.kind, r.mimeType, r.size], ["image", "image/jpeg", 1234]);
eq("A2 bytes come from read()", Array.from(await r.read()), [1, 2, 3]);
eq("A3 png/webp/gif ok", ["image/png", "image/webp", "image/gif"].map((m) => C.readInboundContent(att(m)).kind), ["image", "image", "image"]);
eq("A4 heic is read as an image attachment", C.readInboundContent(att("image/heic")).kind, "image");
yes("A5 heic is NOT model readable", !C.isModelReadableImage("image/heic"));
yes("A6 jpeg is model readable", C.isModelReadableImage("image/jpeg"));
r = C.readInboundContent(att("application/pdf"));
eq("A7 a pdf stays unsupported and names its type", [r.kind, r.type], ["unsupported", "attachment (application/pdf)"]);
eq("A8 an image with no read() is not an image", C.readInboundContent({ type: "attachment", mimeType: "image/png", name: "x" }).kind, "unsupported");

// ---- B: prompt ---------------------------------------------------------------------------
const tpl = { version: 1, slotToken: "T", beforeMessages: [{ role: "system", content: "SYS" }], afterMessages: [], baseHistoryLength: 0, createdAt: "" };
let msgs = W.buildPromptFromTemplate(tpl, [], "look at this", { mimeType: "image/png", dataBase64: "QUJD" });
const last = msgs[msgs.length - 1];
eq("B1 user turn carries text + image part", last.content, [
  { type: "text", text: "look at this" },
  { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
]);
msgs = W.buildPromptFromTemplate(tpl, [], "", { mimeType: "image/png", dataBase64: "QUJD" });
eq("B2 a captionless photo still gets a text part", msgs[msgs.length - 1].content[0], { type: "text", text: "[Image]" });
msgs = W.buildPromptFromTemplate(tpl, [], "plain");
eq("B3 text-only turn is unchanged", msgs[msgs.length - 1], { role: "user", content: "plain" });

// ---- C: handler ------------------------------------------------------------------------
const PHONE = "+15551234567";
function world(recognition) {
  const store = new Map();
  store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
  store.set("imessage-cloud/runtime/line1.json", { format: "x", version: 1, createdAt: "", line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true }, apiConfig: { enableImageRecognition: recognition }, promptTemplate: tpl });
  const w = { store, sent: [], gen: [] };
  w.deps = {
    readJson: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    putJson: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
    listRecentStored: async () => [],
    generate: async (_s, text, _r, image) => { w.gen.push({ text, image }); return "Nice photo!"; },
    send: async (t) => { w.sent.push(t); return "p" + w.sent.length; },
    now: () => 1_000_000,
  };
  return w;
}
const base = { messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound" };
let w = world(true);
let t = await H.handleInboundMessage(w.deps, { ...base, contentType: "image", text: "", image: { mimeType: "image/jpeg", dataBase64: "QUJD" } });
eq("C1 a photo with no caption is answered", [t.result, w.sent], ["replied", ["Nice photo!"]]);
eq("C2 the model received the image", w.gen[0].image, { mimeType: "image/jpeg", dataBase64: "QUJD" });
const media = [...w.store.entries()].find(([k]) => k.includes("/media/"));
yes("C3 the photo bytes were stored", media && media[1].dataBase64 === "QUJD", JSON.stringify([...w.store.keys()]));
const inbound = [...w.store.values()].find((v) => v.direction === "inbound");
eq("C4 inbound record points at the photo", inbound.image, { path: media[0], mimeType: "image/jpeg" });
eq("C5 captionless content placeholder", inbound.content, "[Image]");
yes("C6 trace has no 'recognition is off' warning", !/recognition is off/.test(t.detail ?? ""), t.detail);

w = world(false);
t = await H.handleInboundMessage(w.deps, { ...base, contentType: "image", text: "me at the beach", image: { mimeType: "image/png", dataBase64: "QUJD" } });
yes("C7 recognition off is called out in the trace", /image recognition is off/.test(t.detail ?? ""), t.detail);
eq("C8 caption is kept as the message text", w.gen[0].text, "me at the beach");

w = world(true);
t = await H.handleInboundMessage(w.deps, { ...base, contentType: "image too large (12 MB, limit 8 MB)", text: "" });
eq("C9 a refused photo is explained, not silently dropped", [t.result, t.reason], ["ignored", "ignored_non_text"]);
yes("C10 ...with the reason", /too large/.test(t.detail), t.detail);
eq("C11 ...and never reaches the model", w.gen.length, 0);

// ---- D: wiring ------------------------------------------------------------------------
const route = fs.readFileSync("app/api/imessage/webhook/route.ts", "utf8");
yes("D1 route enforces the size limit before reading", /size \?\? 0\) > MAX_INBOUND_IMAGE_BYTES/.test(route));
yes("D2 route re-checks after reading", /bytes\.byteLength > MAX_INBOUND_IMAGE_BYTES/.test(route));
yes("D3 route refuses HEIC", /isModelReadableImage\(inboundContent\.mimeType\)/.test(route));
const sync = fs.readFileSync("lib/imessage-cloud-sync.ts", "utf8");
yes("D4 browser pull imports the stored photo", /loadStoredImageDataUrl\(cloudConfig, stored\.image\)/.test(sync));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
