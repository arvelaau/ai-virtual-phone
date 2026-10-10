// Fixture for the history-slot splitter in lib/imessage-cloud-sync.ts.
//
// The runtime package is a prompt template with a marker where the chat history goes. If
// the marker could not be found the whole sync used to throw ("Could not find the message
// insertion point"), which meant the cloud index was never written and the webhook answered
// nothing. These cases pin: found in plain text, found inside multi-part content, and that
// a missing marker degrades instead of failing.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, {
  alias: { "@": path.resolve("."), dexie: path.resolve("_fx-dexie-stub.mjs") },
});
const sync = jiti("./lib/imessage-cloud-sync.ts");
const { assemblePromptPayload } = jiti("./lib/llm-prompt-assembler.ts");
const { createBuiltinPreset } = jiti("./lib/builtin-preset.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const TOKEN = "__AI_PHONE_IMESSAGE_CLOUD_HISTORY_SLOT_V1__";
const split = sync.splitPromptMessagesAtHistorySlot;
const texts = (msgs) => msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

// A. plain string content
let r = split([
  { role: "system", content: "SYS" },
  { role: "user", content: "old question" },
  { role: "assistant", content: "old answer" },
  { role: "system", content: TOKEN },
  { role: "system", content: "TAIL" },
]);
eq("A1 found", r.found, true);
eq("A2 before holds everything ahead of the slot", texts(r.beforeMessages), ["SYS", "old question", "old answer"]);
eq("A3 after holds what follows", texts(r.afterMessages), ["TAIL"]);
yes("A4 the token itself is gone", !JSON.stringify(r).includes(TOKEN));

// B. token embedded in the middle of one merged system message
r = split([{ role: "system", content: `head text\n${TOKEN}\ntail text` }]);
eq("B1 found inside a merged message", r.found, true);
eq("B2 head kept", texts(r.beforeMessages), ["head text\n"]);
eq("B3 tail kept", texts(r.afterMessages), ["\ntail text"]);

r = split([{ role: "system", content: TOKEN }]);
eq("B4 slot-only message leaves nothing on either side", [r.beforeMessages.length, r.afterMessages.length, r.found], [0, 0, true]);

// C. multi-part content (text + image): the token sits in a text part
r = split([
  { role: "user", content: [
    { type: "text", text: "look at this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "text", text: `${TOKEN} then after` },
  ] },
]);
eq("C1 found inside a text part", r.found, true);
eq("C2 the image stays on the before side", r.beforeMessages[0]?.content?.map?.((p) => p.type), ["text", "image_url"]);
eq("C3 text after the token survives", r.afterMessages[0]?.content?.[0]?.text, " then after");

r = split([
  { role: "user", content: [{ type: "text", text: "nothing here" }, { type: "image_url", image_url: { url: "u" } }] },
  { role: "system", content: TOKEN },
]);
eq("C4 an earlier multi-part message without the token is passed through", [r.found, r.beforeMessages.length], [true, 1]);

// D. the marker is missing: degrade, do not throw
let threw = false;
try {
  r = split([{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]);
} catch { threw = true; }
eq("D1 a missing marker no longer throws", threw, false);
eq("D2 reported as not found", r.found, false);
eq("D3 everything is kept as the before part", texts(r.beforeMessages), ["SYS", "hi"]);
eq("D4 nothing lands on the after side", r.afterMessages, []);
r = split([]);
eq("D5 an empty prompt degrades too", [r.found, r.beforeMessages.length], [false, 0]);

// E. the real path: assemblePromptPayload with the builtin preset keeps the marker findable
const preset = createBuiltinPreset();
const character = { id: "c1", name: "Mira", description: "A friendly person.", personality: "kind", scenario: "", firstMessage: "" };
const now = new Date().toISOString();
const mk = (id, role, content) => ({ id, sessionId: "s1", role, content, status: "sent", createdAt: now });
const assemble = (history, extra = {}) => assemblePromptPayload({
  character, history, preset, worldBooks: [], regexes: [], userIdentity: null,
  appId: "chat", appTags: ["chat", "text"], initialStateValues: [], scheduleSummary: "", currentSchedule: "",
  coreMemories: "", longTermMemories: "", worldBookActivationContext: "", recentBlocks: [], unifiedRecentItems: [],
  customStickerNames: "", customStickerExample: "", musicLocal: "", musicCloud: "", musicOnlineHint: "",
  enableVision: false, timeAware: false, tools: "", chatBilingualInstruction: "", offlineBilingualInstruction: "",
  offlineSummaryTag: "", nativeToolHistory: false, ...extra,
});
const hist = [mk("a", "user", "hello"), mk("b", "assistant", "hi there"), mk("slot", "system", TOKEN)];
r = split(assemble(hist));
eq("E1 the assembled builtin prompt has a findable marker", r.found, true);
yes("E2 earlier turns land before it", texts(r.beforeMessages).some((t) => t.includes("hello")));
r = split(assemble(hist, { timeAware: true }));
eq("E3 still findable with timeAware on", r.found, true);

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
