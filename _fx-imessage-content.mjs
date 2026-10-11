// Fixture for lib/imessage-content.ts and its wiring into the webhook handler:
// quoted replies in, native replies + tag fallbacks out.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const C = jiti("./lib/imessage-content.ts");
const H = jiti("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

// ---- A: inbound -----------------------------------------------------------------------------
eq("A1 text", C.readInboundContent({ type: "text", text: "hi" }), { kind: "text", text: "hi" });
eq("A2 markdown", C.readInboundContent({ type: "markdown", markdown: "**hi**" }), { kind: "text", text: "**hi**" });
const reply = { type: "reply", content: { type: "text", text: "yes please" }, target: { id: "m9", content: { type: "text", text: "Want coffee?" } } };
eq("A3 quoted reply is read", C.readInboundContent(reply), { kind: "text", text: "yes please", quote: { id: "m9", preview: "Want coffee?" } });
eq("A4 reply to a photo keeps the id, empty preview",
  C.readInboundContent({ ...reply, target: { id: "m9", content: { type: "attachment" } } }).quote, { id: "m9", preview: "" });
yes("A5 reply with a non-text body is unsupported", C.readInboundContent({ type: "reply", content: { type: "attachment" }, target: {} }).kind === "unsupported");
eq("A6 attachment unsupported", C.readInboundContent({ type: "attachment" }).kind, "unsupported");
eq("A7 garbage", C.readInboundContent(null).kind, "unsupported");
eq("A8 model sees an in-app style quote", C.composeModelText("yes please", { preview: "Want coffee?" }), "[Quote:Want coffee?]yes please");
eq("A9 no quote, no tag", C.composeModelText("hello", undefined), "hello");
eq("A10 quote whitespace is collapsed", C.composeModelText("x", { preview: "a\n  b" }), "[Quote:a b]x");

// ---- B: outbound ----------------------------------------------------------------------------
const ctx = { currentId: "cur", currentText: "do you want coffee later", known: [{ id: "old1", text: "I love the rain" }] };
let p = C.planOutbound("[Quote:do you want coffee later]Sure!", ctx);
eq("B1 quote of the current message -> native reply", p.bubbles, [{ text: "Sure!", replyToId: "cur" }]);
p = C.planOutbound("[Reply to: ]Sure!", ctx);
eq("B2 the empty '[Reply to:]' that used to leak", p.bubbles, [{ text: "Sure!", replyToId: "cur" }]);
p = C.planOutbound("[Reply to: I love the rain]Me too", ctx);
eq("B3 an earlier message is found by its text", p.bubbles, [{ text: "Me too", replyToId: "old1" }]);
p = C.planOutbound("[引用:I love the rain]Me too", ctx);
eq("B4 legacy Chinese tag", p.bubbles, [{ text: "Me too", replyToId: "old1" }]);
p = C.planOutbound("[Quote:something never said]Hmm", ctx);
eq("B5 unknown quote degrades to a plain bubble", p.bubbles, [{ text: "Hmm" }]);
yes("B6 ...and says so", p.notes.some((n) => /not found/.test(n)), JSON.stringify(p.notes));
p = C.planOutbound("[Quote:]\n\nSure thing", ctx);
eq("B7 a quote tag alone applies to the next bubble", p.bubbles, [{ text: "Sure thing", replyToId: "cur" }]);
yes("B8 no raw tag survives in any case", ![ "[Reply to:]", "[Quote:x]hello", "[引用:x]hi" ].some((r) => /\[(Quote|Reply|引用)/i.test(C.planOutbound(r, ctx).bubbles.map((b) => b.text).join(" "))));

p = C.planOutbound("[VoiceNote:I miss you so much]", ctx);
eq("B9 voice note becomes its text", p.bubbles, [{ text: "I miss you so much" }]);
p = C.planOutbound("[Photo:WithRef:sunset at the pier]", ctx);
eq("B10 photo becomes a description, flag stripped", p.bubbles, [{ text: "📷 sunset at the pier" }]);
p = C.planOutbound("[Sticker:happy]", ctx);
eq("B11 sticker alone produces no bubble", p.bubbles, []);
p = C.planOutbound("Look: [Sticker:happy] fun", ctx);
yes("B12 sticker inside text is removed", p.bubbles.length === 1 && !/Sticker/.test(p.bubbles[0].text) && /Look:/.test(p.bubbles[0].text) && /fun/.test(p.bubbles[0].text), JSON.stringify(p.bubbles));
p = C.planOutbound("[RedPacket:100:Best wishes]", ctx);
yes("B13 red packet is readable text", p.bubbles[0]?.text === "🧧 100 · Best wishes", JSON.stringify(p.bubbles));
p = C.planOutbound("hello\n\n[Moments]a post[/Moments]", ctx);
eq("B14 action blocks are not sent", p.bubbles, [{ text: "hello" }]);
p = C.planOutbound("one\n\ntwo", ctx);
eq("B15 plain paragraphs unchanged", p.bubbles, [{ text: "one" }, { text: "two" }]);
p = C.planOutbound("Blue Ceramic Mug is great", ctx);
eq("B16 multi-word text intact", p.bubbles, [{ text: "Blue Ceramic Mug is great" }]);
p = C.planOutbound("[Stuff:keep me] and [3] stay", ctx);
eq("B17 unknown brackets are left alone", p.bubbles, [{ text: "[Stuff:keep me] and [3] stay" }]);

// ---- C: the handler uses it ----------------------------------------------------------------
const PHONE = "+15551234567";
const store = new Map();
store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
store.set("imessage-cloud/runtime/line1.json", { format: "x", version: 1, createdAt: "", line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: 0 }, apiConfig: {}, promptTemplate: { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" } });
const sends = [];
let seenByModel = "";
let n = 0;
const deps = {
  readJson: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
  putJson: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
  listRecentStored: async () => [],
  generate: async (_s, text) => { seenByModel = text; return "[Quote:Want coffee?]Sure!\n\nSee you there"; },
  send: async (text, replyToId) => { sends.push({ text, replyToId }); return "plat-" + (n += 1); },
  now: () => 1_000_000,
  sleep: async () => {},
};
const r = await H.handleInboundMessage(deps, {
  messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound",
  contentType: "text", text: "yes please", quote: { id: "m0", preview: "Want coffee?" },
});
eq("C1 replied", r.result, "replied");
eq("C2 the model saw the quote", seenByModel, "[Quote:Want coffee?]yes please");
eq("C3 quoting what the user quoted is answered natively; the second bubble is plain", sends, [{ text: "Sure!", replyToId: "m0" }, { text: "See you there", replyToId: undefined }]);
const outs = [...store.entries()].filter(([k]) => k.includes("/messages/")).map(([, v]) => v);
yes("C4 inbound record stores the quoted form", outs.some((m) => m.direction === "inbound" && m.content === "[Quote:Want coffee?]yes please"));
yes("C5 outbound records keep the platform id", outs.filter((m) => m.direction === "outbound").every((m) => /^plat-/.test(m.platformMessageId)), JSON.stringify(outs));

// native reply path: the model quotes the current message
store.clear();
store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
store.set("imessage-cloud/runtime/line1.json", { format: "x", version: 1, createdAt: "", line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: 0 }, apiConfig: {}, promptTemplate: { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" } });
sends.length = 0;
deps.generate = async () => "[Reply to: ]On it";
const r2 = await H.handleInboundMessage(deps, { messageId: "m2", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text: "can you check?" });
eq("C6 quote of the current message becomes replyToId", sends, [{ text: "On it", replyToId: "m2" }]);
yes("C7 the trace names the native reply", /native reply/.test(r2.detail ?? ""), r2.detail);

// ---- D: source guards ----------------------------------------------------------------------
const route = fs.readFileSync("app/api/imessage/webhook/route.ts", "utf8");
yes("D1 route reads inbound through readInboundContent", /readInboundContent\(message\.content\)/.test(route));
yes("D2 route falls back to a plain send if the native reply throws", /catch[\s\S]{0,120}fall through/.test(route));
yes("D3 time budget raised", /maxDuration = 300/.test(route) && /LLM_DEADLINE_MS = 280_000/.test(route));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
