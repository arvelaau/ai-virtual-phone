// Fixture: the iMessage runtime snapshot obeys the worldbook and the user's chat plugins like the
// in-app chat does, and a message the app could not mirror to iMessage can be explained.
//   A  worldbook      a keyword entry is in the template even though no message has matched it yet
//   B  plugins        llm.request hooks reach the template; a broken one never stops the sync
//   C  wiring         the snapshot builder actually does A and B
//   D  mirror log     every outcome has plain wording, and the log keeps the newest few
//
//   node _fx-imessage-snapshot.mjs

import path from "node:path";
import fs from "node:fs";
import { createJiti } from "jiti";

globalThis.window = globalThis;
globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const sync = await jiti.import("./lib/imessage-cloud-sync.ts");
const hooks = await jiti.import("./lib/chat-plugin-hooks.ts");
const asm = await jiti.import("./lib/llm-prompt-assembler.ts");
const mirror = await jiti.import("./lib/imessage-mirror.ts");
const store = await jiti.import("./lib/imessage-storage.ts");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), { got: g, want: w });

const SLOT = "__AI_PHONE_IMESSAGE_CLOUD_HISTORY_SLOT_V1__";
const text = (m) => typeof m.content === "string" ? m.content : m.content.map((p) => p.type === "text" ? p.text : "").join("");
const all = (msgs) => msgs.map(text).join("\n---\n");

// ---- A: worldbook ---------------------------------------------------------------------------
const character = {
    id: "c1", name: "Mira", avatar: null, persona: "A baker.", personality: "Warm.", createdAt: "", updatedAt: "",
};
const book = {
    id: "wb1", name: "Lore", entries: [
        { uid: "e1", key: "lighthouse", content: "LIGHTHOUSE-LORE the lighthouse keeper is her brother.", comment: "", use_regex: false, disable: false, constant: false, position: "before_char", insertion_order: 1 },
        { uid: "e2", key: "dragon", content: "DISABLED-LORE", comment: "", use_regex: false, disable: true, constant: false, position: "before_char", insertion_order: 2 },
        { uid: "e3", key: "", content: "ALWAYS-LORE", comment: "", use_regex: false, disable: false, constant: true, position: "before_char", insertion_order: 3 },
    ],
};
const base = {
    character, history: [{ id: "h1", sessionId: "s1", role: "user", content: "hi there", status: "sent", createdAt: new Date().toISOString() }],
    preset: null, worldBooks: [book], regexes: [], appId: "chat", appTags: ["chat", "text"],
    worldBookActivationContext: "hi there",
};
const withoutAll = all(asm.assemblePromptPayload({ ...base }));
const withAll = all(asm.assemblePromptPayload({ ...base, activateAllWorldBooks: true }));
ok("A1 without activateAll a keyword entry is missing (the bug)", !withoutAll.includes("LIGHTHOUSE-LORE"));
ok("A2 with activateAll the keyword entry is present", withAll.includes("LIGHTHOUSE-LORE"));
ok("A3 a constant entry is present either way", withoutAll.includes("ALWAYS-LORE") && withAll.includes("ALWAYS-LORE"));
ok("A4 a disabled entry stays out even with activateAll", !withAll.includes("DISABLED-LORE"));

// ---- B: plugins on the template -------------------------------------------------------------
const bus = hooks.getChatPluginHookBus();
const template = () => [
    { role: "system", content: "You are Mira." },
    { role: "assistant", content: "earlier reply" },
    { role: "system", content: SLOT },
    { role: "system", content: "Output rules: stay in character." },
];
let seen = null;
const register = (fn) => bus.registerTransform("fx-plugin", "llm.request", fn);
const clear = () => bus.removePlugin("fx-plugin");

{
    const input = template();
    const out = await sync.applyChatPluginsToTemplate(input, "s1");
    eq("B1 no plugins -> untouched", out.applied, false);
    eq("B1b no plugins -> same messages", out.messages, input);
}
{
    register((p) => { seen = JSON.parse(JSON.stringify(p)); });
    const input = template();
    const snapshotBefore = JSON.stringify(input);
    const out = await sync.applyChatPluginsToTemplate(input, "s1");
    ok("B2 a plugin that changes nothing -> applied false", out.applied === false);
    ok("B2b the plugin saw the slot as the newest USER message", seen && seen.messages[2].role === "user" && seen.messages[2].content === SLOT, seen?.messages?.[2]);
    ok("B2c the plugin was told the purpose and session", seen && seen.purpose === "chat" && seen.sessionId === "s1", seen && { p: seen.purpose, s: seen.sessionId });
    eq("B2d the caller's array was not mutated", JSON.stringify(input), snapshotBefore);
    clear();
}
{
    register((p) => { p.messages.push({ role: "system", content: "STYLE: reply in lowercase." }); return p; });
    const out = await sync.applyChatPluginsToTemplate(template(), "s1");
    ok("B3 an appended instruction is applied", out.applied === true);
    const split = sync.splitPromptMessagesAtHistorySlot(out.messages);
    ok("B3b the slot is still found", split.found === true);
    ok("B3c the instruction lands after the history", all(split.afterMessages).includes("STYLE: reply in lowercase."));
    ok("B3d it is not in the part before the history", !all(split.beforeMessages).includes("STYLE:"));
    clear();
}
{
    register((p) => { p.messages[2] = { ...p.messages[2], content: `[note] ${p.messages[2].content}` }; return p; });
    const out = await sync.applyChatPluginsToTemplate(template(), "s1");
    const split = sync.splitPromptMessagesAtHistorySlot(out.messages);
    ok("B4 text a plugin puts next to the newest message keeps the slot findable", out.applied && split.found, split);
    ok("B4b the added text is kept before the new turn", all(split.beforeMessages).includes("[note]"));
    clear();
}
{
    register((p) => { p.messages = p.messages.filter((m) => m.content !== SLOT); return p; });
    const input = template();
    const out = await sync.applyChatPluginsToTemplate(input, "s1");
    ok("B5 a plugin that removes the slot -> the original template", out.applied === false && out.messages === input);
    clear();
}
{
    register(() => { throw new Error("boom"); });
    const input = template();
    const out = await sync.applyChatPluginsToTemplate(input, "s1");
    ok("B6 a throwing plugin never breaks the sync", out.applied === false && out.messages === input);
    clear();
}
{
    register((p) => { p.messages = "not an array"; return p; });
    const input = template();
    const out = await sync.applyChatPluginsToTemplate(input, "s1");
    ok("B7 a plugin returning garbage -> the original template", out.applied === false && out.messages === input);
    clear();
}
{
    const multi = [
        { role: "system", content: "You are Mira." },
        { role: "system", content: [{ type: "text", text: `before ${SLOT} after` }] },
    ];
    register((p) => { p.messages.push({ role: "system", content: "TAIL" }); return p; });
    const out = await sync.applyChatPluginsToTemplate(multi, "s1");
    const split = sync.splitPromptMessagesAtHistorySlot(out.messages);
    ok("B8 a slot inside multi-part content is found", out.applied && split.found);
    clear();
}
{
    const noSlot = [{ role: "system", content: "You are Mira." }];
    let called = false;
    register(() => { called = true; });
    const out = await sync.applyChatPluginsToTemplate(noSlot, "s1");
    ok("B9 no slot -> plugins are not even asked", out.applied === false && called === false);
    clear();
}

// ---- C: the snapshot builder really does it -------------------------------------------------
const src = fs.readFileSync(path.join(root, "lib/imessage-cloud-sync.ts"), "utf8").replace(/\r\n/g, "\n");
const builder = src.slice(src.indexOf("export async function buildIMessageCloudRuntimeSnapshot("), src.indexOf("export async function syncIMessageLineRuntimeToCloud("));
ok("C0 located the builder", builder.length > 2000 && builder.length < 20000, builder.length);
ok("C1 every worldbook entry is requested", /activateAllWorldBooks:\s*true/.test(builder));
ok("C2 the plugin prompt text is passed to the assembler", /customAppRichMediaDirectives:\s*pluginPromptHint/.test(builder));
ok("C3 the prompt.system hook is run for this session", /runChatPluginTransform\("prompt\.system"/.test(builder) && /buildChatPluginPromptFragments\(session\.id\)/.test(builder));
ok("C4 plugins are applied BEFORE the template is split",
    builder.indexOf("applyChatPluginsToTemplate(") > 0
    && builder.indexOf("applyChatPluginsToTemplate(") < builder.indexOf("splitPromptMessagesAtHistorySlot("),
    [builder.indexOf("applyChatPluginsToTemplate("), builder.indexOf("splitPromptMessagesAtHistorySlot(")]);
ok("C5 the snapshot records how it was built", /promptBuild:\s*\{/.test(builder));
ok("C6 the sync result reports it", /pluginRequestHookApplied:\s*snapshot\.promptBuild/.test(src));

// ---- D: mirror log --------------------------------------------------------------------------
const reasons = ["proactive", "all", "off", "group", "imported", "not_delivered", "not_text", "empty", "reply_to_local_user", "rate_limited", "already_mirrored", "no_cloud_backup", "no_bound_line",
    "missing_photon_env", "missing_supabase_env", "line_not_found", "bad_token", "send_error", "storage_error", "expired", "network_error"];
const words = reasons.map((r) => mirror.describeMirrorOutcome(r));
ok("D1 every known outcome has its own wording", new Set(words).size === reasons.length, words.filter((w, i) => words.indexOf(w) !== i));
ok("D2 none of them shows the raw code", reasons.every((r, i) => words[i] !== `Not sent: ${r}` && words[i] !== r), words);
ok("D3 an unknown http status is explained, not hidden", mirror.describeMirrorOutcome("http_503").includes("503"));
ok("D4 an unknown code is still shown", mirror.describeMirrorOutcome("weird_thing").includes("weird_thing"));
ok("D5 the proactive-only skip tells the user which setting to change", /Send everything/.test(mirror.describeMirrorOutcome("reply_to_local_user")));
// every reason decideMirror can return must be covered by wording
const decideSrc = fs.readFileSync(path.join(root, "lib/imessage-mirror.ts"), "utf8");
const union = decideSrc.slice(decideSrc.indexOf("export type MirrorDecision"), decideSrc.indexOf("export function normalizeMirrorMode"));
const codes = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((c) => !["send", "reason"].includes(c));
ok("D6 found the decision reasons", codes.length >= 9, codes);
ok("D7 each decision reason has wording", codes.every((c) => !mirror.describeMirrorOutcome(c).endsWith(`: ${c}`)), codes.filter((c) => mirror.describeMirrorOutcome(c).endsWith(`: ${c}`)));

for (let i = 0; i < 20; i += 1) store.recordIMessageMirror({ lineId: "L", sent: i % 2 === 0, reason: "all", text: `message number ${i}  with   spaces` });
const log = store.loadIMessageMirrorLog();
ok("D8 the log keeps only the newest few", log.length === 15, log.length);
ok("D9 newest first", log[0].preview.startsWith("message number 19"), log[0]);
ok("D10 a preview keeps its words (no blanket whitespace strip)", log[0].preview === "message number 19 with spaces", log[0].preview);
store.recordIMessageMirror({ lineId: "L", sent: false, reason: "x", text: "y".repeat(500) });
ok("D11 a long message is cut", store.loadIMessageMirrorLog()[0].preview.length <= 80);
const cloudSrc = src;
const runner = cloudSrc.slice(cloudSrc.indexOf("export async function mirrorLocalMessageToIMessage("), cloudSrc.indexOf("export { IMESSAGE_CLOUD_PREFIX"));
ok("D12 the runner writes a log line when it skips", /if \(!decision\.send\) \{\s*log\(false, decision\.reason\)/.test(runner));
ok("D13 the runner writes one when delivery fails or succeeds", /log\(delivery\.ok,/.test(runner));
ok("D14 a network failure is caught and logged, not thrown", /requestDelivery\(job\)\.catch\(/.test(runner) && runner.includes("network_error"));
ok("D15 the user's own typing is not logged", /reason === "not_assistant"\) return/.test(runner));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
