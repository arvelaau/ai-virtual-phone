// Fixture for lib/review-storage.ts (Stage 1 of the movie/book review app).
//
// Runs the REAL storage module by aliasing `dexie` to the in-memory stub, exercising the
// actual kv-db.ts cache rather than a copy of the logic.
//
//   node _fx-review-storage.mjs

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

const storage = await jiti.import("./lib/review-storage.ts");
const types = await jiti.import("./lib/review-types.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

function makeTitle(overrides = {}) {
    const now = new Date().toISOString();
    return {
        id: overrides.id ?? `title_${Math.random().toString(36).slice(2, 8)}`,
        kind: "movie",
        title: "The Great Escape",
        creator: "John Sturges",
        overview: "A group of prisoners plan a daring escape.",
        coverAssetId: null,
        source: { kind: "movie", provider: "tmdb", externalId: "868" },
        status: "not_started",
        grounding: null,
        myRating: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

// ── A: title CRUD round trip ──
{
    const t1 = makeTitle({ id: "t1", title: "Movie One" });
    storage.upsertReviewTitle(t1);
    const loaded = storage.getReviewTitle("t1");
    check("A1 title round-trips", Boolean(loaded), loaded);
    eq("A2 title text survives multi-word intact", loaded?.title, "Movie One");
    eq("A3 kind preserved", loaded?.kind, "movie");
    eq("A4 source preserved", JSON.stringify(loaded?.source), JSON.stringify({ kind: "movie", provider: "tmdb", externalId: "868" }));

    const t2 = makeTitle({ id: "t1", title: "Movie One Updated" });
    storage.upsertReviewTitle(t2);
    const all = storage.loadReviewTitles();
    eq("A5 upsert replaces, not duplicates", all.filter(t => t.id === "t1").length, 1);
    eq("A6 upsert updates fields", storage.getReviewTitle("t1")?.title, "Movie One Updated");
}

// ── B: normalize rejects garbage, keeps valid ──
{
    check("B1 normalize rejects missing id", storage.normalizeReviewTitle({ title: "x" }) === null, null);
    check("B2 normalize rejects missing title", storage.normalizeReviewTitle({ id: "x" }) === null, null);
    check("B3 normalize rejects non-object", storage.normalizeReviewTitle("garbage") === null, null);
    const valid = storage.normalizeReviewTitle({ id: "ok", title: "OK", kind: "book" });
    check("B4 normalize accepts minimal valid input", Boolean(valid), valid);
    eq("B5 unknown status falls back to not_started", valid?.status, "not_started");
    eq("B6 book kind preserved", valid?.kind, "book");
}

// ── C: cleanText/cleanMultilineText survive multi-word English ──
{
    const t = storage.normalizeReviewTitle({
        id: "clean1",
        title: "A really quite long descriptive title with many words",
        overview: "Line one of the synopsis.\nLine two continues the plot without spoiling anything important.",
    });
    eq("C1 multi-word title survives cleanText unmangled", t?.title, "A really quite long descriptive title with many words");
    check("C2 multi-word overview survives cleanMultilineText unmangled",
        t?.overview.includes("Line one of the synopsis.") && t?.overview.includes("Line two continues the plot"),
        t?.overview);
    check("C3 newline preserved in overview", t?.overview.includes("\n"), t?.overview);
}

// ── D: journal entries ──
{
    const e1 = storage.addReviewJournalEntry({ titleId: "t1", authorType: "user", authorName: "Me", body: "First impressions after episode one." });
    const e2 = storage.addReviewJournalEntry({ titleId: "t1", authorType: "user", authorName: "Me", body: "Second entry, a bit later." });
    const entries = storage.loadReviewJournalEntries("t1");
    eq("D1 two journal entries stored", entries.length, 2);
    check("D2 sorted oldest first", entries[0].id === e1.id && entries[1].id === e2.id, entries.map(e => e.id));
    storage.deleteReviewJournalEntry(e1.id);
    eq("D3 delete removes one entry", storage.loadReviewJournalEntries("t1").length, 1);
}

// ── E: discussion threads + messages, mode-at-send recorded ──
{
    const thread = storage.getOrCreateReviewDiscussionThread("t1", "char_a");
    const thread2 = storage.getOrCreateReviewDiscussionThread("t1", "char_a");
    eq("E1 get-or-create is idempotent per (title, character)", thread.id, thread2.id);

    const m1 = storage.addReviewDiscussionMessage({ threadId: thread.id, authorType: "user", content: "What did you think so far?", modeAtSend: "discuss_safe" });
    const m2 = storage.addReviewDiscussionMessage({ threadId: thread.id, authorType: "character", content: "It is intriguing, though I only know what you have told me.", modeAtSend: "discuss_safe" });
    // simulate the title being marked finished mid-thread
    const m3 = storage.addReviewDiscussionMessage({ threadId: thread.id, authorType: "user", content: "Now that you know the ending, what do you think?", modeAtSend: "discuss_free" });

    const messages = storage.loadReviewDiscussionMessages(thread.id);
    eq("E2 three messages stored in order", messages.map(m => m.id).join(","), [m1.id, m2.id, m3.id].join(","));
    eq("E3 first two messages recorded safe mode", messages[0].modeAtSend + "," + messages[1].modeAtSend, "discuss_safe,discuss_safe");
    eq("E4 third message recorded free mode (mid-thread flip)", messages[2].modeAtSend, "discuss_free");
}

// ── F: published reviews with dual rating shapes ──
{
    const rating = types.makeReviewRating(4.5);
    eq("F1 rating clamps to 0.5 steps", rating.value, 4.5);
    eq("F2 rating scale fixed at 5", rating.scale, 5);
    eq("F3 rating clamps above max", types.makeReviewRating(9).value, 5);
    eq("F4 rating clamps below min", types.makeReviewRating(-2).value, 0.5);
    eq("F5 rating rounds to nearest half-step", types.makeReviewRating(3.7).value, 3.5);

    const review = storage.addPublishedReview({
        titleId: "t1", characterId: "char_a", characterName: "Char A",
        rating, headline: "A tense, well-crafted thriller from what I have gathered.",
        body: ["Paragraph one of the review.", "Paragraph two continues the thought."],
        groundingUsed: true,
    });
    const loaded = storage.loadPublishedReviews("t1");
    eq("F6 published review stored", loaded.length, 1);
    eq("F7 review id matches", loaded[0].id, review.id);
    eq("F8 body paragraphs preserved in order", loaded[0].body.join("|"), "Paragraph one of the review.|Paragraph two continues the thought.");

    // user's own personal rating lives on the title, independent of the character's review
    const titleWithMyRating = storage.upsertReviewTitle({ ...storage.getReviewTitle("t1"), myRating: types.makeReviewRating(3) });
    eq("F9 user's own rating stored independently on the title", titleWithMyRating.myRating.value, 3);
    eq("F10 character review rating unaffected by user's own rating", storage.loadPublishedReviews("t1")[0].rating.value, 4.5);
}

// ── G: grounding snippet lifecycle ──
{
    const fetched = { sourceLabel: "Review", status: "fetched", text: "A gripping tale.", originalText: "A gripping tale.", fetchedAt: new Date().toISOString() };
    const t = storage.normalizeReviewTitle({ ...makeTitle({ id: "g1" }), grounding: fetched });
    eq("G1 fetched snippet keeps its text", t?.grounding?.text, "A gripping tale.");
    eq("G2 fetched snippet label preserved", t?.grounding?.sourceLabel, "Review");

    const edited = { ...fetched, status: "edited", text: "A gripping tale, in my own words." };
    const t2 = storage.normalizeReviewTitle({ ...makeTitle({ id: "g2" }), grounding: edited });
    eq("G3 edited snippet keeps edited text, not original", t2?.grounding?.text, "A gripping tale, in my own words.");
    eq("G4 edited snippet still exposes original for revert", t2?.grounding?.originalText, "A gripping tale.");

    const cleared = { ...fetched, status: "cleared" };
    const t3 = storage.normalizeReviewTitle({ ...makeTitle({ id: "g3" }), grounding: cleared });
    eq("G5 cleared snippet has empty text (excluded from generation)", t3?.grounding?.text, "");
    eq("G6 cleared snippet still tracks status", t3?.grounding?.status, "cleared");

    const bookDescription = { sourceLabel: "Description", status: "confirmed", text: "A publisher synopsis.", originalText: "A publisher synopsis.", fetchedAt: new Date().toISOString() };
    const t4 = storage.normalizeReviewTitle({ ...makeTitle({ id: "g4", kind: "book" }), grounding: bookDescription });
    eq("G7 book grounding honestly labeled Description, not Review", t4?.grounding?.sourceLabel, "Description");
}

// ── H: cascade delete ──
{
    const cascadeTitle = makeTitle({ id: "cascade1" });
    storage.upsertReviewTitle(cascadeTitle);
    storage.addReviewJournalEntry({ titleId: "cascade1", authorType: "user", authorName: "Me", body: "A note." });
    const cThread = storage.getOrCreateReviewDiscussionThread("cascade1", "char_x");
    storage.addReviewDiscussionMessage({ threadId: cThread.id, authorType: "user", content: "Hi there, what do you think of this one?", modeAtSend: "discuss_safe" });
    storage.addPublishedReview({ titleId: "cascade1", characterId: "char_x", characterName: "X", rating: types.makeReviewRating(3), headline: "Decent.", body: ["Body."], groundingUsed: false });

    check("H0 pre-delete: journal/thread/message/review all present",
        storage.loadReviewJournalEntries("cascade1").length === 1 &&
        storage.loadReviewDiscussionThreads("cascade1").length === 1 &&
        storage.loadReviewDiscussionMessages(cThread.id).length === 1 &&
        storage.loadPublishedReviews("cascade1").length === 1,
        { journal: storage.loadReviewJournalEntries("cascade1").length, threads: storage.loadReviewDiscussionThreads("cascade1").length });

    await storage.deleteReviewTitle("cascade1");

    eq("H1 title itself removed", storage.getReviewTitle("cascade1"), null);
    eq("H2 journal entries cascaded", storage.loadReviewJournalEntries("cascade1").length, 0);
    eq("H3 discussion threads cascaded", storage.loadReviewDiscussionThreads("cascade1").length, 0);
    eq("H4 discussion messages cascaded (via thread id)", storage.loadReviewDiscussionMessages(cThread.id).length, 0);
    eq("H5 published reviews cascaded", storage.loadPublishedReviews("cascade1").length, 0);

    // control: an unrelated title's data must survive the cascade delete of a different title
    eq("H6 unrelated title's journal survives", storage.loadReviewJournalEntries("t1").length > 0, true);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
