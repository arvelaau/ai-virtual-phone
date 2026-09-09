// Fixture for the Review app's memory projection (Stage 5): lib/review-memory.ts +
// the short-term-assembler.ts wiring (loadNativeTimeline, both prepareShortTermContext AND
// prepareGroupShortTermContext -- the two-site trap this codebase has hit twice before, plus a
// THIRD site found while wiring this up: prepareGroupShortTermContext's own sourceTag ternary,
// which is a separate hardcoded mapping from the raw.push tag and needed its own review branch).
//
//   node _fx-review-memory.mjs

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

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const memory = await jiti.import("./lib/review-memory.ts");
const assembler = await jiti.import("./lib/short-term-assembler.ts");
const chars = await jiti.import("./lib/character-storage.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 500));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

const CHAR_ID = "char_review_test";
chars.saveCharacters([{ id: CHAR_ID, name: "Review Tester", persona: "" }]);

const title = {
    id: "title1",
    kind: "movie",
    title: "The Great Escape",
    creator: "John Sturges",
    overview: "Prisoners plan an escape.",
    coverAssetId: null,
    source: { kind: "movie", provider: "manual" },
    status: "finished",
    grounding: null,
    myRating: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

// ── A: recordReviewJournalEvent / recordPublishedReviewEvent + loadReviewProjectionEntries ──
{
    const journalEntry = {
        id: "j1", titleId: "title1", authorType: "user", authorName: "User",
        body: "Just started this one, seems promising so far.",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        updatedAt: new Date(Date.now() - 60000).toISOString(),
    };
    memory.recordReviewJournalEvent(title, journalEntry, CHAR_ID);

    const published = {
        id: "p1", titleId: "title1", characterId: CHAR_ID, characterName: "Review Tester",
        rating: { value: 4.5, scale: 5 },
        headline: "A tense, well-crafted thriller from what I have gathered.",
        body: ["Paragraph one.", "Paragraph two."],
        groundingUsed: false,
        createdAt: new Date().toISOString(),
    };
    memory.recordPublishedReviewEvent(title, published);

    const entries = memory.loadReviewProjectionEntries(CHAR_ID);
    eq("A1 two projection entries recorded", entries.length, 2);
    check("A2 journal entry marked authorType user", entries.find(e => e.id === "review_journal_j1_" + CHAR_ID)?.authorType === "user", entries);
    check("A3 published entry marked authorType character", entries.find(e => e.id === "review_published_p1")?.authorType === "character", entries);
    check("A4 journal content includes the journal body text", entries.find(e => e.id.startsWith("review_journal"))?.content.includes("Just started this one"), entries);
    check("A5 published content includes the review headline", entries.find(e => e.id === "review_published_p1")?.content.includes("A tense, well-crafted thriller"), entries);
}

// ── B: prepareShortTermContext (1:1) surfaces a recent_review block ──
{
    const result = assembler.prepareShortTermContext(CHAR_ID, "chat", { userName: "User" });
    const reviewBlock = result.recentBlocks.find(b => b.tag === "recent_review");
    check("B1 1:1 prepareShortTermContext surfaces a recent_review block", Boolean(reviewBlock), result.recentBlocks.map(b => b.tag));
    check("B2 1:1 block content includes both recorded events", reviewBlock && reviewBlock.content.includes("Just started this one") && reviewBlock.content.includes("A tense, well-crafted thriller"), reviewBlock);

    const reviewUnified = result.unifiedRecentItems.filter(i => i.sourceApp === "review");
    eq("B3 1:1 unifiedRecentItems includes both review events", reviewUnified.length, 2);
    check("B4 1:1 unifiedRecentItems tags them recent_review", reviewUnified.length > 0 && reviewUnified.every(i => i.sourceTag === "recent_review"), reviewUnified.map(i => i.sourceTag));
}

// ── C: prepareGroupShortTermContext (group) ALSO surfaces the review events ──
// This is the two-site trap this project has shipped broken twice before -- verified here by
// actually driving the real function, not asserting on source text.
{
    const result = assembler.prepareGroupShortTermContext([CHAR_ID], [], { userName: "User" });
    const reviewUnified = result.unifiedRecentItems.filter(i => i.sourceApp === "review");
    eq("C1 group prepareGroupShortTermContext includes both review events", reviewUnified.length, 2);
    // This is the THIRD site found while wiring this up: the group function derives sourceTag
    // via its own hardcoded ternary, separate from the raw.push tag -- if that branch is missing,
    // review entries silently fall through to "recent_events" instead of "recent_review".
    check("C2 group unifiedRecentItems tags them recent_review, not the recent_events fallback",
        reviewUnified.length > 0 && reviewUnified.every(i => i.sourceTag === "recent_review"), reviewUnified.map(i => i.sourceTag));
    check("C3 group entries carry the actual recorded content",
        reviewUnified.some(i => i.text.includes("Just started this one")) && reviewUnified.some(i => i.text.includes("A tense, well-crafted thriller")),
        reviewUnified.map(i => i.text));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
