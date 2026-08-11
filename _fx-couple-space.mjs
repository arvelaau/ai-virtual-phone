// Fixture for Couple Space stage 2a (data layer):
//   lib/couple-space-types.ts, lib/couple-space-storage.ts, lib/couple-space-memory.ts
//
// Drives the real modules, aliasing `dexie` to the in-memory stub.
//   node _fx-couple-space.mjs
//
// Non-vacuity notes at the bottom.

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

const S = await jiti.import("./lib/couple-space-storage.ts");
const M = await jiti.import("./lib/couple-space-memory.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 300));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

const ann = (over = {}) => ({
    id: "a1", characterId: "c1", title: "First date", date: "2024-03-03",
    recurring: true, createdAt: "2024-03-03T00:00:00.000Z", updatedAt: "2024-03-03T00:00:00.000Z",
    ...over,
});

// ───────────────────────────── A. date math ─────────────────────────────
const a1 = S.computeUpcomingAnniversary(ann(), "2026-03-01");
eq("A1 upcoming this year keeps the year", a1?.nextDate, "2026-03-03");
eq("A2 daysUntil counted forward", a1?.daysUntil, 2);
eq("A3 yearsSince from the original year", a1?.yearsSince, 2);

const a2 = S.computeUpcomingAnniversary(ann(), "2026-03-04");
eq("A4 a passed date rolls to next year", a2?.nextDate, "2027-03-03");
eq("A5 rolled yearsSince increments", a2?.yearsSince, 3);

const a3 = S.computeUpcomingAnniversary(ann(), "2026-03-03");
eq("A6 today is zero days away", a3?.daysUntil, 0);
eq("A7 today does not roll forward", a3?.nextDate, "2026-03-03");

const a4 = S.computeUpcomingAnniversary(ann({ recurring: false, date: "2026-12-25" }), "2026-12-20");
eq("A8 one-off keeps its date", a4?.nextDate, "2026-12-25");
eq("A9 one-off daysUntil", a4?.daysUntil, 5);
eq("A10 one-off has no yearsSince", a4?.yearsSince, undefined);

const a5 = S.computeUpcomingAnniversary(ann({ recurring: false, date: "2026-01-01" }), "2026-06-01");
check("A11 passed one-off reports negative days", (a5?.daysUntil ?? 0) < 0, a5);

// 29 February: 2027 is a common year, 2028 is a leap year.
const leap = ann({ date: "2024-02-29" });
eq("A12 Feb 29 falls back to Feb 28 in a common year",
    S.computeUpcomingAnniversary(leap, "2027-01-01")?.nextDate, "2027-02-28");
eq("A13 Feb 29 is kept in a leap year",
    S.computeUpcomingAnniversary(leap, "2028-01-01")?.nextDate, "2028-02-29");

eq("A14 year boundary counts one day",
    S.computeUpcomingAnniversary(ann({ date: "2020-01-01" }), "2026-12-31")?.daysUntil, 1);
check("A15 invalid stored date yields null",
    S.computeUpcomingAnniversary(ann({ date: "03/03/2024" }), "2026-01-01") === null);
check("A16 invalid today yields null",
    S.computeUpcomingAnniversary(ann(), "not-a-date") === null);
eq("A17 parseYmd rejects a bad month", S.parseYmd("2026-13-01"), null);

// ─────────────────────── B. computeUpcomingAnniversaries ────────────────
const many = [
    ann({ id: "far", title: "Far", date: "2020-12-01" }),
    ann({ id: "near", title: "Near", date: "2020-06-05" }),
    ann({ id: "past", title: "Past one-off", date: "2026-01-01", recurring: false }),
];
const list = S.computeUpcomingAnniversaries(many, { today: "2026-06-01" });
eq("B1 sorted nearest first", list[0]?.anniversary.id, "near");
eq("B2 passed one-offs hidden by default", list.length, 2);
eq("B3 hidePassedOneOffs=false keeps them",
    S.computeUpcomingAnniversaries(many, { today: "2026-06-01", hidePassedOneOffs: false }).length, 3);
eq("B4 withinDays filters",
    S.computeUpcomingAnniversaries(many, { today: "2026-06-01", withinDays: 30 }).length, 1);
eq("B5 limit honoured",
    S.computeUpcomingAnniversaries(many, { today: "2026-06-01", limit: 1 }).length, 1);

// ───────────────────────────── C. storage CRUD ──────────────────────────
S.clearCoupleSpace("char_luna");
S.clearCoupleSpace("char_rae");

const saved = S.addAnniversary("char_luna", { title: "The Long Walk Home", date: "2025-03-03", note: "  rained   all day " });
check("C1 add returns the anniversary", Boolean(saved?.id), saved);
// Regression guard: a blanket whitespace strip is invisible in Chinese and destroys English.
eq("C2 title keeps its spaces", saved?.title, "The Long Walk Home");
eq("C3 note whitespace collapsed but words kept", saved?.note, "rained all day");
eq("C4 recurring defaults true", saved?.recurring, true);
eq("C5 stored and reloaded", S.loadCoupleSpaceState("char_luna").anniversaries.length, 1);
eq("C6 other characters unaffected", S.loadCoupleSpaceState("char_rae").anniversaries.length, 0);

check("C7 empty title rejected", S.addAnniversary("char_luna", { title: "   ", date: "2025-01-01" }) === null);
check("C8 bad date rejected", S.addAnniversary("char_luna", { title: "Nope", date: "2025-1-1" }) === null);

const updated = S.updateAnniversary("char_luna", saved.id, { title: "The Walk Home", recurring: false });
eq("C9 update applies", updated?.title, "The Walk Home");
eq("C10 update keeps untouched fields", updated?.date, "2025-03-03");
eq("C11 update can clear recurring", updated?.recurring, false);
check("C12 update on unknown id returns null", S.updateAnniversary("char_luna", "nope", { title: "x" }) === null);

const wish = S.addWishlistItem("char_luna", { title: "Linen Scarf", wantedBy: "character", priceLabel: "$40" });
eq("C13 wishlist title keeps spaces", wish?.title, "Linen Scarf");
eq("C14 wantedBy respected", wish?.wantedBy, "character");
eq("C15 new wishes start wanted", wish?.status, "wanted");

const fulfilled = S.fulfillWishlistItem("char_luna", wish.id, "ord_7::item_2::1");
eq("C16 fulfil flips status", fulfilled?.status, "fulfilled");
eq("C17 fulfil links the gift record", fulfilled?.linkedGiftId, "ord_7::item_2::1");
check("C18 fulfil stamps a time", Boolean(fulfilled?.fulfilledAt), fulfilled);

S.addWishlistItem("char_luna", { title: "Second Wish" });
eq("C19 filter by status", S.loadWishlist("char_luna", { status: "wanted" }).length, 1);
eq("C20 filter by wantedBy", S.loadWishlist("char_luna", { wantedBy: "character" }).length, 1);
eq("C21 delete removes", S.deleteWishlistItem("char_luna", wish.id), true);
check("C22 deleting twice is false", S.deleteWishlistItem("char_luna", wish.id) === false);

eq("C23 delete anniversary", S.deleteAnniversary("char_luna", saved.id), true);
eq("C24 state empty again", S.loadCoupleSpaceState("char_luna").anniversaries.length, 0);

// ───────────────────────────── D. projections ───────────────────────────
M.clearAllCoupleSpaceProjections();

eq("D1 date label is human-readable", M.formatAnniversaryDateLabel("2026-03-03"), "3 March");
eq("D2 date label passes through junk", M.formatAnniversaryDateLabel("nope"), "nope");

M.recordAnniversaryAddedEvent({
    characterId: "char_luna",
    anniversary: ann({ id: "an1", title: "First Date", date: "2025-03-03", createdAt: "2026-05-01T10:00:00.000Z" }),
});
const entries = M.loadCoupleSpaceProjectionEntries("char_luna");
eq("D3 one projection entry", entries.length, 1);
check("D4 entry carries the Couple Space head", entries[0]?.content.startsWith("[Couple Space "), entries[0]?.content);
check("D5 entry names the anniversary", entries[0]?.content.includes("First Date"), entries[0]?.content);
check("D6 entry renders the date in words", entries[0]?.content.includes("3 March"), entries[0]?.content);
check("D7 recurring is stated", entries[0]?.content.includes("every year"), entries[0]?.content);

M.recordWishlistAddedEvent({
    characterId: "char_luna",
    characterName: "Luna",
    item: {
        id: "w1", characterId: "char_luna", title: "Linen Scarf", wantedBy: "character",
        status: "wanted", createdAt: "2026-05-02T10:00:00.000Z", updatedAt: "2026-05-02T10:00:00.000Z",
    },
});
const wishEntry = M.loadCoupleSpaceProjectionEntries("char_luna").find(e => e.id === "couple_space_wish_w1");
check("D8 character-wanted wish names the character", wishEntry?.content.includes("Luna"), wishEntry?.content);
check("D9 wish entry keeps the product spacing", wishEntry?.content.includes("Linen Scarf"), wishEntry?.content);

M.recordWishlistFulfilledEvent({
    characterId: "char_luna",
    item: {
        id: "w1", characterId: "char_luna", title: "Linen Scarf", wantedBy: "character",
        status: "fulfilled", createdAt: "2026-05-02T10:00:00.000Z", updatedAt: "2026-05-05T10:00:00.000Z",
        fulfilledAt: "2026-05-05T10:00:00.000Z",
    },
});
eq("D10 three entries now", M.loadCoupleSpaceProjectionEntries("char_luna").length, 3);
eq("D11 afterTimestamp filters",
    M.loadCoupleSpaceProjectionEntries("char_luna", { afterTimestamp: "2026-05-02T00:00:00.000Z" }).length, 2);
eq("D12 entries are chronological",
    M.loadCoupleSpaceProjectionEntries("char_luna")[0]?.id, "couple_space_anniversary_an1");

M.deleteCoupleSpaceProjectionEventsForWish("char_luna", "w1");
eq("D13 deleting a wish drops both its events", M.loadCoupleSpaceProjectionEntries("char_luna").length, 1);
M.deleteCoupleSpaceProjectionEventsForAnniversary("char_luna", "an1");
eq("D14 deleting the anniversary drops its event", M.loadCoupleSpaceProjectionEntries("char_luna").length, 0);
eq("D15 other characters untouched", M.loadCoupleSpaceProjectionEntries("char_rae").length, 0);


// ───────────────────────── E. reflections (stage 3) ─────────────────────────
const kv = await jiti.import("./lib/kv-db.ts");

S.clearCoupleSpace("char_luna");

const MULTI = "First line about us.\n\nSecond paragraph, after a blank line.";
const refl = S.addReflection("char_luna", { title: "  A quiet evening  ", body: MULTI });
check("E1 reflection saved", Boolean(refl?.id), refl);
// Regression guard: cleanMultiline first shipped as a literal space-strip, which would
// turn "First line about us." into "Firstlineaboutus."
check("E2 body keeps its spaces", refl?.body.includes("First line about us."), refl?.body);
check("E3 body keeps its paragraph break", refl?.body.includes("\n\n"), JSON.stringify(refl?.body));
eq("E4 title trimmed", refl?.title, "A quiet evening");
eq("E5 author defaults to user", refl?.author, "user");

const messy = S.addReflection("char_luna", { body: "line one\n\n\n\n\nline two   \n" });
eq("E6 blank-line runs collapsed to one", messy?.body, "line one\n\nline two");

check("E7 empty body rejected", S.addReflection("char_luna", { body: "   " }) === null);
// The "character" author exists from the start so AI-written reflections need no migration.
eq("E8 character author accepted",
    S.addReflection("char_luna", { body: "I keep thinking about it.", author: "character" })?.author, "character");

const allRefl = S.loadReflections("char_luna");
eq("E9 all three stored", allRefl.length, 3);
check("E10 newest first", allRefl[0]?.createdAt >= allRefl[allRefl.length - 1]?.createdAt, allRefl.map(r => r.createdAt));
eq("E11 filter by author", S.loadReflections("char_luna", { author: "character" }).length, 1);
eq("E12 limit honoured", S.loadReflections("char_luna", { limit: 2 }).length, 2);

const edited = S.updateReflection("char_luna", refl.id, { body: "Rewritten, still with spaces." });
eq("E13 update applies", edited?.body, "Rewritten, still with spaces.");
eq("E14 update keeps the title", edited?.title, "A quiet evening");
check("E15 update on unknown id is null", S.updateReflection("char_luna", "nope", { body: "x" }) === null);

eq("E16 delete works", S.deleteReflection("char_luna", refl.id), true);
eq("E17 two remain", S.loadReflections("char_luna").length, 2);

// Backward compatibility: states written before stage 3 have no "reflections" key at all.
kv.kvSet("ai_phone_couple_space_char_old", JSON.stringify({
    version: 1,
    anniversaries: [],
    wishlist: [{ id: "w9", title: "Old Wish", wantedBy: "user", status: "wanted", createdAt: "", updatedAt: "" }],
}));
const legacy = S.loadCoupleSpaceState("char_old");
eq("E18 legacy state loads without reflections", legacy.reflections.length, 0);
eq("E19 legacy wishlist still intact", legacy.wishlist.length, 1);

// ───────────────────────── F. reflection projections ─────────────────────────
M.clearAllCoupleSpaceProjections();
const projRefl = S.addReflection("char_luna", { title: "Anniversary week", body: "I want to remember how calm this felt." });
M.recordReflectionEvent({ characterId: "char_luna", characterName: "Luna", reflection: projRefl });
const rEntries = M.loadCoupleSpaceProjectionEntries("char_luna");
eq("F1 reflection projected", rEntries.length, 1);
check("F2 names the writer", rEntries[0]?.content.includes("The user wrote a reflection"), rEntries[0]?.content);
check("F3 names the character", rEntries[0]?.content.includes("Luna"), rEntries[0]?.content);
check("F4 includes the title", rEntries[0]?.content.includes("Anniversary week"), rEntries[0]?.content);
check("F5 includes the body", rEntries[0]?.content.includes("how calm this felt"), rEntries[0]?.content);
check("F6 carries the Couple Space head", rEntries[0]?.content.startsWith("[Couple Space "), rEntries[0]?.content);

M.recordReflectionEvent({
    characterId: "char_luna", characterName: "Luna",
    reflection: { ...projRefl, id: "r_ai", author: "character", body: "I have been thinking about her." },
});
const aiEntry = M.loadCoupleSpaceProjectionEntries("char_luna").find(e => e.id === "couple_space_reflection_r_ai");
check("F7 character-authored reads differently", aiEntry?.content.includes("Luna wrote a reflection"), aiEntry?.content);

M.deleteCoupleSpaceProjectionEventsForReflection("char_luna", projRefl.id);
eq("F8 deleting a reflection drops its projection", M.loadCoupleSpaceProjectionEntries("char_luna").length, 1);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: make computeUpcomingAnniversary skip the roll-forward branch and A4/A5/A14\n" +
    "fail; add a blanket whitespace strip to cleanText and C2/C3/C13 fail.",
);
process.exit(fail ? 1 : 0);
