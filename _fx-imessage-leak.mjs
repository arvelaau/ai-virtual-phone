// Fixture: what must NOT reach the phone (state values, inner thoughts), how many bubbles may go
// out, and "what is the character doing right now".
//   A  bubbles     no 5-bubble cap; a long paragraph is split, never cut off
//   B  state tags  [Anxiety: 30], [焦虑值：30%] ... are removed; real brackets are not
//   C  user regex  the app's regex rules (which hide those things in the app) run on the reply too
//   D  schedule    what the character is doing at the moment the message arrives
//   E  wiring      the route and the snapshot builder really do all of it
//
//   node _fx-imessage-leak.mjs

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
const core = await jiti.import("./lib/imessage-webhook-core.ts");
const content = await jiti.import("./lib/imessage-content.ts");
const T = await jiti.import("./lib/imessage-time.ts");
const R = await jiti.import("./lib/regex-engine.ts");
const sync = await jiti.import("./lib/imessage-cloud-sync.ts");
const calStorage = await jiti.import("./lib/calendar-storage.ts");
const calUtils = await jiti.import("./lib/calendar-utils.ts");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), { got: g, want: w });

// ---- A: bubbles -----------------------------------------------------------------------------
const nine = Array.from({ length: 9 }, (_, i) => `message ${i}`).join("\n\n");
eq("A1 nine bubbles are nine bubbles (the old cap was 5)", core.modelOutputToBubbles(nine).length, 9);
const many = Array.from({ length: 80 }, (_, i) => `m${i}`).join("\n\n");
eq("A2 a runaway reply is still bounded", core.modelOutputToBubbles(many).length, core.MAX_REPLY_BUBBLES);
ok("A3 the guard is far above anything a person writes", core.MAX_REPLY_BUBBLES >= 30, core.MAX_REPLY_BUBBLES);

const sentence = "This is one sentence of the long story the character is telling you. ";
const long = sentence.repeat(60).trim(); // ~4,100 characters, no blank line
const pieces = core.modelOutputToBubbles(long);
ok("A4 a long paragraph becomes several bubbles", pieces.length >= 3, pieces.length);
ok("A5 each bubble fits", pieces.every((p) => p.length <= core.MAX_BUBBLE_CHARS), pieces.map((p) => p.length));
eq("A6 NOTHING is lost (it used to be cut with an ellipsis)", pieces.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
ok("A7 the cut falls after a full sentence", pieces.slice(0, -1).every((p) => /[.!?]$/.test(p)), pieces.map((p) => p.slice(-12)));
ok("A8 no ellipsis was added", !pieces.some((p) => p.includes("…")));
const blob = "x".repeat(3200);
const blobPieces = core.splitLongText(blob, 1500);
eq("A9 text with no break at all is still split, and complete", [blobPieces.length, blobPieces.join("").length], [3, 3200]);
const cjk = "今天天气很好。".repeat(400);
const cjkPieces = core.splitLongText(cjk, 1500);
ok("A10 Chinese sentence ends are used as cut points", cjkPieces.length >= 2 && cjkPieces.slice(0, -1).every((p) => p.endsWith("。")), cjkPieces.map((p) => p.slice(-2)));
eq("A11 a short text is untouched", core.splitLongText("hello world"), ["hello world"]);
ok("A12 multi-word text keeps its spaces (no blanket whitespace strip)", core.modelOutputToBubbles("see you at the old pier tonight")[0] === "see you at the old pier tonight");

// ---- B: loose state tags --------------------------------------------------------------------
const bubble = (raw) => core.modelOutputToBubbles(raw);
eq("B1 bare tag (already handled by the app's parser)", bubble("hi there [Anxiety:30]"), ["hi there"]);
eq("B2 a space after the colon", bubble("hi there [Anxiety: 30]"), ["hi there"]);
eq("B3 a full-width colon and a percent sign", bubble("hi there [焦虑值：30%]"), ["hi there"]);
eq("B4 over 100", bubble("hi there [Affection:72/100]"), ["hi there"]);
eq("B5 several in a row", bubble("hi there\n[好感度:72][占有欲: 40][Anxiety：15%]"), ["hi there"]);
eq("B6 a decimal", bubble("hi [Possessiveness: 33.5]"), ["hi"]);
eq("B7 a line that is ONLY state tags is dropped, not sent as an empty bubble", bubble("[Anxiety: 30][好感度: 70]"), []);
ok("B8 a timestamp is not a state value", bubble("meet me at [20:33] ok")[0].includes("[20:33]"));
ok("B9 an ordinary bracket stays", bubble("I read [Chapter] three")[0] === "I read [Chapter] three");
ok("B10 a number without brackets stays", bubble("I scored 90/100 on it")[0] === "I scored 90/100 on it");
ok("B11 a sticker tag is not mistaken for a state value", core.stripLooseStateTags("a [Sticker: 11] b").includes("[Sticker: 11]"));
eq("B12 stripping leaves no trailing blanks", core.stripLooseStateTags("hello [Anxiety: 30]\nnext"), "hello\nnext");
const plan = content.planOutbound("Miss you already.\n[好感度: 72][焦虑值：30%]\n\n[InnerThoughts]He is going to leave.[/InnerThoughts]", { currentId: "m1", currentText: "bye", known: [] });
eq("B13 end to end: only the words go out", plan.bubbles.map((b) => b.text), ["Miss you already."]);
const plan2 = content.planOutbound("[InnerThoughts]he hasn't replied yet\n\nand it hurts\n\nMiss you already.", { currentId: "m1", currentText: "bye", known: [] });
ok("B14 KNOWN LIMIT, pinned: an UNCLOSED multi-paragraph inner-thought block still leaks its later paragraphs",
    plan2.bubbles.some((b) => b.text.includes("it hurts")), plan2.bubbles);

// ---- C: user regex rules --------------------------------------------------------------------
const rule = (over) => ({ id: "r" + Math.random(), scriptName: "x", findRegex: "/\\[焦虑值:[^\\]]*\\]/g", replaceString: "", disabled: false, placement: [2], ...over });
const group = (...rules) => [{ id: "g", name: "g", rules }];
const ctx = { characterName: "Mira", userName: "Jo" };
const raw = "hello [焦虑值:30] there";
eq("C1 an ordinary output rule runs", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({})) }), "hello  there");
eq("C2 a DISPLAY rule that hides (empty replacement) runs too", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ markdownOnly: true })) }), "hello  there");
eq("C3 a display rule that restyles into HTML does NOT run", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ markdownOnly: true, replaceString: "<b>$0</b>" })) }), raw);
eq("C4 a prompt-only rule does not run", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ promptOnly: true })) }), raw);
eq("C5 a disabled rule does not run", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ disabled: true })) }), raw);
eq("C6 an input-only rule (placement 1) does not run on a reply", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ placement: [1] })) }), raw);
eq("C7 a rule scoped to group chat does not run on a 1:1 reply", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ tags: ["group_chat"] })) }), raw);
eq("C8 a rule scoped to chat does", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ tags: ["chat"] })) }), "hello  there");
eq("C9 a broken pattern is ignored, the others still run", core.applyReplyRegexes(raw, { ...ctx, regexes: group(rule({ findRegex: "/(/g" }), rule({})) }), "hello  there");
eq("C10 no rules -> exactly the input", core.applyReplyRegexes(raw, { ...ctx, regexes: [] }), raw);
eq("C11 macros work in a replacement", core.applyReplyRegexes("XX", { ...ctx, regexes: group(rule({ findRegex: "/XX/", replaceString: "{{char}} says hi" })) }), "Mira says hi");
eq("C12 rules run in order", core.applyReplyRegexes("a", { ...ctx, regexes: group(rule({ findRegex: "/a/", replaceString: "b" }), rule({ findRegex: "/b/", replaceString: "c" })) }), "c");
// the leaf module has to stay a leaf: the webhook is a Node route
const engineSrc = fs.readFileSync(path.join(root, "lib/regex-engine.ts"), "utf8");
const engineImports = [...engineSrc.matchAll(/^import .*? from "([^"]+)"/gm)].map((m) => m[1]);
ok("C13 regex-engine imports only types (nothing browser-side can come in with it)", engineSrc.split("\n").filter((l) => l.startsWith("import ")).every((l) => l.startsWith("import type")), engineImports);
const asmSrc = fs.readFileSync(path.join(root, "lib/llm-prompt-assembler.ts"), "utf8");
ok("C14 the assembler uses the same engine (one implementation, not two)", /from "\.\/regex-engine"/.test(asmSrc) && !/function runRegexRule\(/.test(asmSrc) && !/function applyRegex\(/.test(asmSrc));

// ---- D: what is the character doing right now ----------------------------------------------
const JKT = "Asia/Jakarta";
const NOW = new Date(Date.UTC(2026, 9, 12, 14, 5, 0)); // 21:05 on 12 Oct in Jakarta
const items = [
    { date: "2026-10-12", start: 9 * 60, end: 12 * 60, text: "09:00-12:00 @Studio Morning class" },
    { date: "2026-10-12", start: 20 * 60, end: 22 * 60, text: "20:00-22:00 @Home Cooking dinner" },
    { date: "2026-10-12", start: 21 * 60, end: 23 * 60, text: "21:00-23:00 @Home Watching a film" },
    { date: "2026-10-13", start: 20 * 60, end: 22 * 60, text: "20:00-22:00 @Gym Tomorrow's workout" },
];
eq("D1 the entries whose window contains now, joined like the app does", T.pickCurrentSchedule(items, NOW, JKT), "20:00-22:00 @Home Cooking dinner; 21:00-23:00 @Home Watching a film");
eq("D2 a gap in the day is 'none'", T.pickCurrentSchedule(items, new Date(Date.UTC(2026, 9, 12, 6, 0, 0)), JKT), "none");
eq("D3 the window is half-open: the end minute is already free", T.pickCurrentSchedule(items, new Date(Date.UTC(2026, 9, 12, 15, 0, 0)), JKT), "21:00-23:00 @Home Watching a film");
eq("D4 another day's entry does not apply", T.pickCurrentSchedule([items[3]], NOW, JKT), "none");
eq("D5 no calendar at all -> none", T.pickCurrentSchedule([], NOW, JKT), "none");
eq("D6 missing list -> none", T.pickCurrentSchedule(undefined, NOW, JKT), "none");
// the SERVER's clock is UTC: the same instant is a different day/minute there, and the user's zone must win
eq("D7 uses the USER's zone, not the server's", T.pickCurrentSchedule(items, NOW, "UTC"), "none");
eq("D8 midnight rolls the date over", T.pickCurrentSchedule(items, new Date(Date.UTC(2026, 9, 12, 17, 5, 0)), JKT), "none");
const tpl = [{ role: "system", content: `You are doing: ${T.TIME_TOKEN_SCHEDULE}` }];
const settings = { timeAware: true, systemTimeZone: JKT, includeTimeZone: false, scheduleItems: items };
eq("D9 the token is filled in per reply", T.applyFreshTime(tpl, settings, NOW)[0].content, "You are doing: 20:00-22:00 @Home Cooking dinner; 21:00-23:00 @Home Watching a film");
eq("D10 a later reply sees a later answer", T.applyFreshTime(tpl, settings, new Date(Date.UTC(2026, 9, 12, 15, 30, 0)))[0].content, "You are doing: 21:00-23:00 @Home Watching a film");
eq("D11 an old snapshot (no items) says none rather than leaving the token", T.applyFreshTime(tpl, { ...settings, scheduleItems: undefined }, NOW)[0].content, "You are doing: none");

// the real calendar -> items path
{
    const weekStart = calUtils.getWeekStartIso(NOW);
    const nextStart = calUtils.getWeekStartIso(new Date(NOW.getTime() + 7 * 86_400_000));
    const mk = (id, date, startTime, endTime, title) => ({ id, date, weekday: "", startTime, endTime, location: "Home", title, source: "manual" });
    const thisDay = calUtils.formatIsoDate(NOW);
    calStorage.saveCalendarWeekPlan({ ownerType: "character", ownerId: "c1", weekStart, items: [mk("a", thisDay, "20:00", "22:00", "Cooking dinner"), mk("bad", thisDay, "nonsense", "22:00", "Broken")], createdAt: "", updatedAt: "" });
    calStorage.saveCalendarWeekPlan({ ownerType: "character", ownerId: "c1", weekStart: nextStart, items: [mk("n", calUtils.formatIsoDate(new Date(NOW.getTime() + 7 * 86_400_000)), "09:00", "10:00", "Next week thing")], createdAt: "", updatedAt: "" });
    calStorage.saveCalendarWeekPlan({ ownerType: "character", ownerId: "someone-else", weekStart, items: [mk("z", thisDay, "20:00", "22:00", "Not mine")], createdAt: "", updatedAt: "" });
    const collected = sync.collectScheduleItems("c1", NOW);
    ok("D12 this week's and next week's entries are collected", collected.some((i) => i.text.includes("Cooking dinner")) && collected.some((i) => i.text.includes("Next week thing")), collected);
    ok("D13 only that character's calendar", !collected.some((i) => i.text.includes("Not mine")));
    ok("D14 an entry with an unreadable time is skipped, not guessed", !collected.some((i) => i.text.includes("Broken")), collected);
    ok("D15 minutes are right", collected.find((i) => i.text.includes("Cooking dinner"))?.start === 1200 && collected.find((i) => i.text.includes("Cooking dinner"))?.end === 1320);
}

// ---- E: wiring ------------------------------------------------------------------------------
const route = fs.readFileSync(path.join(root, "app/api/imessage/webhook/route.ts"), "utf8");
ok("E1 the webhook runs the user's regex rules on the model's reply", /content = applyReplyRegexes\(content,/.test(route) && /regexes: snapshot\.regexes/.test(route));
const syncSrc = fs.readFileSync(path.join(root, "lib/imessage-cloud-sync.ts"), "utf8").replace(/\r\n/g, "\n");
const builder = syncSrc.slice(syncSrc.indexOf("export async function buildIMessageCloudRuntimeSnapshot("), syncSrc.indexOf("export async function syncIMessageLineRuntimeToCloud("));
ok("E2 the snapshot prompt carries the schedule token, not a frozen value", /currentSchedule: TIME_TOKEN_SCHEDULE/.test(builder));
ok("E3 the snapshot stores the calendar items for the server", /scheduleItems: collectScheduleItems\(character\.id\)/.test(builder));
const coreSrc = fs.readFileSync(path.join(root, "lib/imessage-webhook-core.ts"), "utf8");
ok("E4 the old 5-bubble cap is gone", !/MAX_REPLY_BUBBLES = 5\b/.test(coreSrc));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
