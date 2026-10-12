// Fixture for lib/character-time.ts: the time-zone context the app puts in front of the model.
// It used to be Chinese ("当前系统时间" ...), with the character's local time as one line among
// dozens of user-clock timestamps. It is now English and states the rules explicitly.
process.env.TZ = "Asia/Jakarta"; // the "device" is in Jakarta for every case below
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const T = jiti("./lib/character-time.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

// Monday 12 Oct 2026, 14:05 UTC = 21:05 in Jakarta = 09:05 in Chicago (CDT, UTC-5)
const NOW = new Date("2026-10-12T14:05:00Z");
yes("device zone is the one this fixture set", T.getSystemTimeZone() === "Asia/Jakarta", T.getSystemTimeZone());

// ---- A: single character -----------------------------------------------------------------
let c = T.buildCharacterTimeContext("America/Chicago", NOW);
eq("A1 difference detected", c.hasDifference, true);
eq("A2 character fields", [c.characterTime, c.characterWeekday, c.characterTimeZone], ["12 Oct 2026, 09:05", "Monday", "America/Chicago"]);
eq("A3 system fields", [c.systemTime, c.systemWeekday, c.systemTimeZone], ["12 Oct 2026, 21:05", "Monday", "Asia/Jakarta"]);
yes("A4 states both clocks with their day part", /Right now for the USER: Monday, 12 Oct 2026, 21:05 \(evening\), Asia\/Jakarta\./.test(c.timeContext) && /Right now for YOU: Monday, 12 Oct 2026, 09:05 \(morning\), America\/Chicago\./.test(c.timeContext), c.timeContext);
yes("A5 states the difference", /Your clock is 12 hours behind theirs\./.test(c.timeContext), c.timeContext);
yes("A6 history timestamps are said to be the user's clock", /every timestamp in the conversation history is on the USER's clock/.test(c.timeContext));
yes("A7 tells the model to convert what the user says", /convert it before you react/.test(c.timeContext));
yes("A8 no Chinese left", !/[一-鿿]/.test(c.timeContext) && !/[一-鿿]/.test(c.systemTime + c.characterTime + c.systemWeekday + c.characterWeekday));
yes("A9 no {{macro}} that would need a second expansion pass", !/\{\{/.test(c.timeContext));

// ---- B: no difference / no zone -----------------------------------------------------------------
c = T.buildCharacterTimeContext("Asia/Jakarta", NOW);
eq("B1 same zone: plain current time", [c.hasDifference, c.timeContext, c.characterTime], [false, "Current time: 12 Oct 2026, 21:05, Monday", ""]);
c = T.buildCharacterTimeContext(undefined, NOW);
eq("B2 no zone set", [c.hasDifference, c.timeContext], [false, "Current time: 12 Oct 2026, 21:05, Monday"]);
c = T.buildCharacterTimeContext("Not/AZone", NOW);
eq("B3 invalid zone is ignored", c.hasDifference, false);

// ---- C: date and offsets ---------------------------------------------------------------------
c = T.buildCharacterTimeContext("Pacific/Auckland", NOW); // UTC+13 in October (NZDT)
yes("C1 calendar date can differ", /Tuesday, 13 Oct 2026, 03:05/.test(c.timeContext) && /6 hours ahead of theirs/.test(c.timeContext), c.timeContext);
yes("C2 deep-night wording", /\(deep night\)/.test(c.timeContext), c.timeContext);
c = T.buildCharacterTimeContext("Asia/Kolkata", NOW);
yes("C3 half-hour zones are exact", /1\.5 hours behind theirs/.test(c.timeContext), c.timeContext);
eq("C4 offset helper", [T.timeZoneOffsetHours(NOW, "America/Chicago"), T.timeZoneOffsetHours(NOW, "Asia/Kolkata", "UTC")], [-12, 5.5]);
eq("C5 day parts", [0, 4, 5, 6, 7, 11, 12, 13, 14, 17, 18, 21, 22, 23].map(T.describeDayPart),
  ["deep night", "deep night", "early morning", "early morning", "morning", "morning", "midday", "midday", "afternoon", "afternoon", "evening", "evening", "night", "night"]);

// ---- D: group ---------------------------------------------------------------------------
c = T.buildGroupTimeContext([{ name: "Mira", timeZone: "America/Chicago" }, { name: "Jun", timeZone: "Asia/Jakarta" }, { name: "Bo" }], NOW);
yes("D1 only members that differ are listed", /Mira: Monday, 12 Oct 2026, 09:05 \(morning\), America\/Chicago, 12 hours behind the user/.test(c.timeContext) && !/Jun:/.test(c.timeContext) && !/Bo:/.test(c.timeContext), c.timeContext);
yes("D2 group rules mention the user's clock", /every timestamp in the conversation history is on the USER's clock/.test(c.timeContext));
yes("D3 group context is English", !/[一-鿿]/.test(c.timeContext));
c = T.buildGroupTimeContext([{ name: "Jun", timeZone: "Asia/Jakarta" }], NOW);
eq("D4 nobody differs: plain current time", [c.hasDifference, c.timeContext], [false, "Current time: 12 Oct 2026, 21:05, Monday"]);

// ---- E: nothing outside this file depended on the Chinese strings ---------------------------------
const src = fs.readFileSync("lib/character-time.ts", "utf8");
yes("E1 the old exported name is gone", !/formatZonedChineseDateTime/.test(src));
const users = ["lib/chat-engine.ts", "lib/group-chat-engine.ts", "lib/llm-prompt-assembler.ts", "lib/macro-engine.ts", "lib/prompt-time.ts"].map((f) => fs.readFileSync(f, "utf8"));
yes("E2 no other file references the removed names", users.every((u) => !/formatZonedChineseDateTime|当前系统时间|角色本地时间/.test(u)));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
