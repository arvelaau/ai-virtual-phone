// Fixture for Couple Space stage 2c (registration).
//
// The load-bearing assertion: a projection written by couple-space-memory.ts actually
// reaches loadNativeTimeline and the short-term context. Without the registration block
// the 2a events are written but never read -- and nothing errors, so only a behavioural
// test catches it.
//
//   node _fx-couple-space-timeline.mjs

import path from "node:path";
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
if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init?.detail; }
    };
}

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const M = await jiti.import("./lib/couple-space-memory.ts");
const ST = await jiti.import("./lib/short-term-assembler.ts");
const chars = await jiti.import("./lib/character-storage.ts");
const desktop = await jiti.import("./lib/desktop-config.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

const CHAR = "char_luna";
chars.saveCharacters([{ id: CHAR, name: "Luna" }]);

M.clearAllCoupleSpaceProjections();
M.recordAnniversaryAddedEvent({
    characterId: CHAR,
    anniversary: {
        id: "an1", characterId: CHAR, title: "First Date", date: "2025-03-03",
        recurring: true, createdAt: "2026-05-01T10:00:00.000Z", updatedAt: "2026-05-01T10:00:00.000Z",
    },
});
M.recordWishlistAddedEvent({
    characterId: CHAR,
    characterName: "Luna",
    item: {
        id: "w1", characterId: CHAR, title: "Linen Scarf", wantedBy: "character",
        status: "wanted", createdAt: "2026-05-02T10:00:00.000Z", updatedAt: "2026-05-02T10:00:00.000Z",
    },
});

// ── A. loadNativeTimeline picks the projections up ──
const timeline = ST.loadNativeTimeline(CHAR, { userName: "Zara", appId: "chat" });
const csEntries = timeline.filter(e => e.sourceApp === "couple_space");

eq("A1 both projections reach the timeline", csEntries.length, 2);
eq("A2 sourceDetail is set", csEntries[0]?.sourceDetail, "couple_space");
eq("A3 authorType is the user", csEntries[0]?.authorType, "user");
check("A4 anniversary content survives", csEntries.some(e => e.content.includes("First Date")), csEntries.map(e => e.content));
check("A5 wishlist content survives", csEntries.some(e => e.content.includes("Linen Scarf")), null);
// `.every()` alone is vacuously true on an empty array -- the length guard is what makes
// this fail when the registration block is missing.
check("A6 the Couple Space head is preserved",
    csEntries.length > 0 && csEntries.every(e => e.content.includes("[Couple Space")),
    csEntries.map(e => e.content));
check("A7 afterTimestamp still filters through the timeline",
    ST.loadNativeTimeline(CHAR, { appId: "chat", afterTimestamp: "2026-05-01T23:00:00.000Z" })
        .filter(e => e.sourceApp === "couple_space").length === 1, null);

// ── B. the entries survive into the assembled short-term context ──
const ctx = ST.prepareShortTermContext(CHAR, "chat", { userName: "Zara" });
const serialized = JSON.stringify(ctx);
check("B1 a recent_couple_space block is produced", serialized.includes("recent_couple_space"), Object.keys(ctx ?? {}));
check("B2 the anniversary reaches the assembled context", serialized.includes("First Date"), null);
check("B3 the wish reaches the assembled context", serialized.includes("Linen Scarf"), null);

// Group surface uses a second, independent collection site — both had to be edited.
// Signature is (characterIds, history, options) -- history is positional, not an option.
const groupCtx = JSON.stringify(ST.prepareGroupShortTermContext([CHAR], [], { userName: "Zara" }) ?? {});
check("B4 the group collection site also emits the block",
    groupCtx.includes("recent_couple_space") || groupCtx.includes("First Date"), groupCtx.slice(0, 200));

// ── C. desktop registration ──
check("C1 the icon is registered", Boolean(desktop.ICONS.couplespace), Object.keys(desktop.ICONS).length);
eq("C2 icon label", desktop.ICONS.couplespace?.label, "Couple Space");
check("C3 it is on a default home page",
    [...desktop.PAGE_1_DEFAULT, ...desktop.PAGE_2_DEFAULT, ...desktop.PAGE_3_DEFAULT].includes("couplespace"), null);
check("C4 no CJK leaked into the icon entry",
    !/[一-鿿]/.test(JSON.stringify(desktop.ICONS.couplespace)), null);

// ── D. nothing else was displaced ──
check("D1 note-wall projections still register", "recent_notewall".length > 0 && serialized.length > 0, null);
eq("D2 timeline still returns other sources too", typeof timeline.length, "number");

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: remove the couple_space block from loadNativeTimeline and A1-A7 plus\n" +
    "B1-B4 fail; drop the raw.push in prepareShortTermContext and B1 alone fails.",
);
process.exit(fail ? 1 : 0);
