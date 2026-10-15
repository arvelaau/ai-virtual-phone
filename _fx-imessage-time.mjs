// Fixture: the iMessage prompt knows what time it is NOW, not what time it was at the last sync,
// and a message the app mirrored to iMessage is not counted as the character having replied.
//   A  clock          the {{time}}-style value, in the USER's zone (the server's is UTC)
//   B  tokens         placeholders become real values per reply; nothing is mutated
//   C  stamps         "(2026-10-12 21:05)" in front of each turn, like the app
//   D  end to end     the real assembler leaves tokens, the server fills them
//   E  mirror x reply a mirrored line newer than the user's message must not swallow it
//
//   node _fx-imessage-time.mjs

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
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") } });
const T = await jiti.import("./lib/imessage-time.ts");
const core = await jiti.import("./lib/imessage-webhook-core.ts");
const ct = await jiti.import("./lib/character-time.ts");
const asm = await jiti.import("./lib/llm-prompt-assembler.ts");
const H = await jiti.import("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), { got: g, want: w });

// 2026-10-12 14:05 UTC = 21:05 in Jakarta (+7) = 10:05 in New York (-4, EDT)
const NOW = new Date(Date.UTC(2026, 9, 12, 14, 5, 0));
const LATER = new Date(Date.UTC(2026, 9, 12, 20, 40, 0));
const JKT = "Asia/Jakarta";
const NYC = "America/New_York";

// ---- A: clock -------------------------------------------------------------------------------
eq("A1 {{time}} shape, user's zone", T.formatMacroNow(NOW, JKT), "12 October 2026 21:05");
eq("A2 the same instant elsewhere", T.formatMacroNow(NOW, NYC), "12 October 2026 10:05");
eq("A3 midnight is 00:xx, not 24:xx", T.formatMacroNow(new Date(Date.UTC(2026, 9, 12, 17, 5, 0)), JKT), "13 October 2026 00:05");
const ctx = ct.buildCharacterTimeContext(NYC, NOW, JKT);
ok("A4 the user's zone can be passed (a server is UTC)", ctx.systemTimeZone === JKT && ctx.systemTime.includes("21:05"), ctx);
ok("A5 the character's clock is its own", ctx.characterTime.includes("10:05") && ctx.hasDifference, ctx);
ok("A6 a bad zone falls back instead of throwing", typeof ct.buildCharacterTimeContext(NYC, NOW, "Not/AZone").timeContext === "string");

// ---- B: tokens ------------------------------------------------------------------------------
const settings = { timeAware: true, systemTimeZone: JKT, characterTimeZone: NYC, includeTimeZone: true };
const tpl = () => [
    { role: "system", content: `Rules.\n${T.TIME_TOKEN_BLOCK}\nIt is ${T.TIME_TOKEN_NOW}, ${T.TIME_TOKEN_WEEKDAY}. You: ${T.TIME_TOKEN_CHARACTER_TIME} ${T.TIME_TOKEN_CHARACTER_WEEKDAY}` },
    { role: "system", content: [{ type: "text", text: `multi ${T.TIME_TOKEN_NOW}` }, { type: "image_url", image_url: { url: "data:x" } }] },
];
const input = tpl();
const before = JSON.stringify(input);
const out1 = T.applyFreshTime(input, settings, NOW);
const text1 = out1[0].content;
ok("B1 no token is left", !/__AIPHONE_/.test(JSON.stringify(out1)), text1);
ok("B2 the time-zone block names both clocks", text1.includes("TIME ZONES") && text1.includes("21:05") && text1.includes("10:05"), text1);
ok("B3 the weekday and {{time}} are the user's", text1.includes("12 October 2026 21:05, Monday"), text1);
ok("B4 a token inside multi-part content is replaced", out1[1].content[0].text === "multi 12 October 2026 21:05" && out1[1].content[1].type === "image_url", out1[1].content);
eq("B5 the input was not mutated", JSON.stringify(input), before);
const out2 = T.applyFreshTime(tpl(), settings, LATER);
ok("B6 a later reply sees a LATER time (the whole point)", out2[0].content.includes("20:40") === false && out2[0].content.includes("03:40") && out2[0].content !== text1, out2[0].content);
ok("B7 undefined settings = untouched (older snapshots)", T.applyFreshTime(tpl(), undefined, NOW)[0].content.includes(T.TIME_TOKEN_NOW));
const same = T.applyFreshTime(tpl(), { timeAware: true, systemTimeZone: JKT, includeTimeZone: false }, NOW)[0].content;
ok("B8 no character zone -> a plain 'Current time' line", same.includes("Current time:") && !same.includes("TIME ZONES"), same);

// ---- C: stamps ------------------------------------------------------------------------------
const turns = [
    { role: "user", content: "hi", at: NOW.toISOString() },
    { role: "user", content: "hello?", at: NOW.toISOString() },
    { role: "assistant", content: "hey", at: NOW.toISOString() },
    { role: "user", content: "later", at: LATER.toISOString() },
];
const stamped = T.stampTurns(turns, settings);
eq("C1 the first turn is stamped in the user's zone, zone spelled out", stamped[0].content, `(2026-10-12 21:05 ${JKT})\nhi`);
eq("C2 the same stamp from the same role is not repeated", stamped[1].content, "hello?");
eq("C3 a different role gets its own stamp", stamped[2].content, `(2026-10-12 21:05 ${JKT})\nhey`);
eq("C4 a later time is stamped later", stamped[3].content, `(2026-10-13 03:40 ${JKT})\nlater`);
const bare = T.stampTurns(turns, { ...settings, includeTimeZone: false });
eq("C5 without a zone difference the zone name is omitted", bare[0].content, "(2026-10-12 21:05)\nhi");
eq("C6 time-aware off -> no stamps at all", T.stampTurns(turns, { ...settings, timeAware: false }).map((t) => t.content), ["hi", "hello?", "hey", "later"]);
eq("C7 no settings -> no stamps", T.stampTurns(turns, undefined).map((t) => t.content), ["hi", "hello?", "hey", "later"]);
ok("C8 a multi-word message keeps its spaces (no blanket whitespace strip)", T.stampTurns([{ role: "user", content: "see you at the old pier", at: NOW }], settings)[0].content.endsWith("\nsee you at the old pier"));

// ---- D: end to end through the real assembler -----------------------------------------------
const character = { id: "c1", name: "Mira", avatar: null, persona: "A baker.", personality: "Warm.", createdAt: "", updatedAt: "", timeZone: NYC };
const preset = { prompts: [{ identifier: "t", name: "t", role: "system", content: "NOW={{time}} DAY={{weekday}} BLOCK={{timeContext}} CT={{characterTime}}", enabled: true }] };
const real = ct.buildCharacterTimeContext(NYC, new Date(), JKT);
const msgs = asm.assemblePromptPayload({
    character, history: [], preset, worldBooks: [], regexes: [], appId: "chat", appTags: ["chat", "text"],
    timeContext: { ...real, timeContext: T.TIME_TOKEN_BLOCK, characterTime: real.hasDifference ? T.TIME_TOKEN_CHARACTER_TIME : "", characterWeekday: real.hasDifference ? T.TIME_TOKEN_CHARACTER_WEEKDAY : "" },
    timeTokens: { now: T.TIME_TOKEN_NOW, weekday: T.TIME_TOKEN_WEEKDAY },
});
const joined = msgs.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""))).join("\n");
ok("D1 the assembler leaves a token for each moving part", joined.includes(`NOW=${T.TIME_TOKEN_NOW}`) && joined.includes(`DAY=${T.TIME_TOKEN_WEEKDAY}`) && joined.includes(`BLOCK=${T.TIME_TOKEN_BLOCK}`), joined.slice(0, 300));
ok("D2 and a token for the character's clock when the zones differ", real.hasDifference ? joined.includes(`CT=${T.TIME_TOKEN_CHARACTER_TIME}`) : true, joined);
const filled = T.applyFreshTime(msgs, settings, NOW).map((m) => m.content).join("\n");
ok("D3 filled in: the clock, the weekday and the block", filled.includes("NOW=12 October 2026 21:05") && filled.includes("DAY=Monday") && filled.includes("TIME ZONES"), filled.slice(0, 400));
// without the flag the macros read the machine's clock (the old behaviour = a frozen time)
const frozen = asm.assemblePromptPayload({ character, history: [], preset, worldBooks: [], regexes: [], appId: "chat", appTags: ["chat", "text"] })
    .map((m) => m.content).join("\n");
ok("D4 control: without tokens the time is whatever the sync machine said", !frozen.includes(T.TIME_TOKEN_NOW) && /NOW=\d+ \w+ \d{4}/.test(frozen), frozen.slice(0, 200));

// the whole template -> prompt path
const template = { version: 1, slotToken: "T", beforeMessages: [{ role: "system", content: `Now: ${T.TIME_TOKEN_NOW}` }], afterMessages: [{ role: "system", content: "Stay in character." }], baseHistoryLength: 0, createdAt: "" };
const recent = [{ role: "assistant", content: "earlier", createdAt: new Date(Date.UTC(2026, 9, 12, 13, 0, 0)).toISOString(), externalId: "a", direction: "outbound" }];
const built = core.buildPromptFromTemplate(template, recent, "what time is it for you?", undefined, { settings, now: NOW });
eq("D5 template: before, stamped history, stamped new message, after", built.map((m) => m.content), [
    "Now: 12 October 2026 21:05",
    `(2026-10-12 20:00 ${JKT})\nearlier`,
    `(2026-10-12 21:05 ${JKT})\nwhat time is it for you?`,
    "Stay in character.",
]);
const oldWay = core.buildPromptFromTemplate(template, recent, "hi");
eq("D6 without the time argument nothing changes (older callers)", oldWay.map((m) => m.content), [`Now: ${T.TIME_TOKEN_NOW}`, "earlier", "hi", "Stay in character."]);
const withImg = core.buildPromptFromTemplate(template, [], "look", [{ mimeType: "image/png", dataBase64: "AAA" }], { settings, now: NOW });
ok("D7 a photo turn is stamped too, and keeps its picture", withImg[1].content[0].text.endsWith("\nlook") && withImg[1].content[1].type === "image_url", withImg[1]);

// ---- E: a mirrored message is not a reply ---------------------------------------------------
const PHONE = "+15551234567";
function world() {
    const store = new Map();
    store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
    store.set("imessage-cloud/runtime/line1.json", {
        format: "x", version: 1, createdAt: "", line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: 0 },
        apiConfig: {}, promptTemplate: { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" },
    });
    const w = { store, sent: [], gen: [], t: Date.UTC(2026, 9, 12, 14, 0, 0) };
    w.deps = {
        readJson: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
        putJson: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
        listRecentStored: async () => [...store.entries()].filter(([k]) => k.includes("/messages/")).map(([, v]) => v),
        generate: async (_s, text, history) => { w.gen.push({ text, history: history.map((m) => m.content) }); return "Reply"; },
        send: async (text) => { w.sent.push(text); return "p" + w.sent.length; },
        now: () => w.t,
        sleep: async (ms) => { w.t += ms; },
    };
    return w;
}
const inbound = (id, text) => ({ messageId: id, senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text });
const rec = (externalId, direction, role, content, ms, extra = {}) => ({
    format: "ai-phone-imessage-cloud-message", version: 1, direction, lineId: "line1", characterId: "c1", sessionId: "s1",
    externalId, createdAt: new Date(ms).toISOString(), role, content, ...extra,
});

{
    // The user texts; with a quiet window, the app (open, "send everything") mirrors a line meanwhile.
    const w = world();
    w.store.set("imessage-cloud/runtime/line1.json", { ...w.store.get("imessage-cloud/runtime/line1.json"), line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: 30 } });
    const t0 = w.t;
    const origSleep = w.deps.sleep;
    let injected = false;
    w.deps.sleep = async (ms) => {
        await origSleep(ms);
        if (!injected) {
            injected = true;
            // a line the app mirrored while the handler was waiting: newer than the user's message
            w.store.set("imessage-cloud/messages/line1/mirror_x_text.json", rec("mirror_x_text", "outbound", "assistant", "you still up?", w.t, { localMessageId: "local_1" }));
        }
    };
    const r = await H.handleInboundMessage(w.deps, inbound("m1", "hey mira"));
    ok("E1 the user's message is still answered", r.result === "replied", r);
    eq("E2 the model was given what the user actually said", w.gen[0]?.text, "hey mira");
    ok("E3 the mirrored line is in the history, not in the way", w.gen[0]?.history.includes("you still up?"), w.gen[0]);
    ok("E3b (time really passed)", w.t > t0);
}
{
    // control: a real earlier reply (no localMessageId) still means "already answered"
    const w = world();
    w.store.set("imessage-cloud/messages/line1/old_in.json", rec("old_in", "inbound", "user", "earlier question", w.t - 600_000));
    w.store.set("imessage-cloud/messages/line1/old_out.json", rec("old_out", "outbound", "assistant", "earlier answer", w.t - 500_000));
    const r = await H.handleInboundMessage(w.deps, inbound("m2", "new question"));
    ok("E4 an answered earlier message is not asked again", r.result === "replied" && w.gen[0].text === "new question", w.gen[0]);
}
{
    // the turn can never go to the model empty
    const w = world();
    const t = w.t;
    w.store.set("imessage-cloud/messages/line1/late_out.json", rec("late_out", "outbound", "assistant", "a real reply stamped after the message", t + 5_000));
    const r = await H.handleInboundMessage(w.deps, inbound("m3", "are you there"));
    ok("E5 even if everything looks answered, the model still gets the message", w.gen[0]?.text === "are you there", w.gen[0]);
    ok("E5b and replies", r.result === "replied", r);
}
const hsrc = fs.readFileSync(path.join(root, "lib/imessage-webhook-handler.ts"), "utf8");
ok("E6 source: mirrored records are excluded from 'the last reply'", /direction === "outbound" && !m\.localMessageId/.test(hsrc));

// ---- F: wiring ------------------------------------------------------------------------------
const sync = fs.readFileSync(path.join(root, "lib/imessage-cloud-sync.ts"), "utf8").replace(/\r\n/g, "\n");
const builder = sync.slice(sync.indexOf("export async function buildIMessageCloudRuntimeSnapshot("), sync.indexOf("export async function syncIMessageLineRuntimeToCloud("));
ok("F1 the snapshot is built with time tokens", /timeTokens:\s*\{\s*now:\s*TIME_TOKEN_NOW/.test(builder) && /timeContext:\s*tokenTime/.test(builder));
ok("F2 the snapshot records the user's zone for the server", /timeSettings,/.test(builder) && /systemTimeZone,/.test(builder));
const route = fs.readFileSync(path.join(root, "app/api/imessage/webhook/route.ts"), "utf8");
ok("F3 the webhook passes the snapshot's time settings and the real clock", /settings:\s*snapshot\.timeSettings/.test(route) && /now:\s*new Date\(\)/.test(route));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
