// Fixture for lib/review-engine.ts's pure logic (Stage 3 of the movie/book review app):
// discuss-mode selection and the review-write JSON contract parser. The full generation
// functions need a live API call and are covered by manual smoke testing instead.
//
//   node _fx-review-engine.mjs

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
globalThis.fetch = globalThis.fetch ?? (async () => { throw new Error("network not available in fixture"); });

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const engine = await jiti.import("./lib/review-engine.ts");
const contentTags = await jiti.import("./lib/content-tag-utils.ts");
const builtinPreset = await jiti.import("./lib/builtin-preset.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

// ── A: resolveDiscussMode ──
{
    eq("A1 not_started -> discuss_safe", engine.resolveDiscussMode({ status: "not_started" }), "discuss_safe");
    eq("A2 in_progress -> discuss_safe", engine.resolveDiscussMode({ status: "in_progress" }), "discuss_safe");
    eq("A3 finished -> discuss_free", engine.resolveDiscussMode({ status: "finished" }), "discuss_free");
}

// ── B: parseReviewWriteResponse -- well-formed, malformed-but-repairable, totally broken ──
{
    const wellFormed = engine.parseReviewWriteResponse(
        '{"rating": 4, "headline": "A tense, well-crafted thriller from what I have gathered.", "body": ["Paragraph one.", "Paragraph two."]}',
    );
    eq("B1 well-formed rating parses", wellFormed.rating, 4);
    eq("B2 well-formed headline parses", wellFormed.headline, "A tense, well-crafted thriller from what I have gathered.");
    eq("B3 well-formed body parses as array", wellFormed.body.join("|"), "Paragraph one.|Paragraph two.");

    // trailing comma + missing quote on a key -- jsonrepair should fix this
    const repairable = engine.parseReviewWriteResponse(
        '{"rating": 3.5, "headline": "Decent, if a little slow.", "body": ["Paragraph one.",],}',
    );
    eq("B4 repairable JSON still parses (trailing comma)", repairable.rating, 3.5);
    eq("B5 repairable JSON headline survives", repairable.headline, "Decent, if a little slow.");

    // wrapped in a code fence and a <think> block, like a real model response
    const wrapped = engine.parseReviewWriteResponse(
        '<think>Let me consider this.</think>\n```json\n{"rating": 5, "headline": "Loved it.", "body": ["Great stuff."]}\n```',
    );
    eq("B6 code-fence + think-block wrapper stripped correctly", wrapped.rating, 5);
    eq("B7 wrapped headline survives", wrapped.headline, "Loved it.");

    // totally broken -- not JSON at all, should fall back to hand-written content, never throw
    const broken = engine.parseReviewWriteResponse("I really enjoyed this one, it was great!");
    eq("B8 broken input falls back to a default rating rather than throwing", broken.rating, 3);
    check("B9 broken input's fallback headline/body derive from the raw text",
        broken.headline.includes("I really enjoyed this one") || broken.body.join(" ").includes("I really enjoyed this one"),
        broken);

    const empty = engine.parseReviewWriteResponse("");
    check("B10 empty input does not throw and returns a usable shape", typeof empty.rating === "number" && Array.isArray(empty.body), empty);
}

// ── C: multi-word English survives the local cleanText/cleanArray helpers (indirectly, via B) ──
{
    const longHeadline = engine.parseReviewWriteResponse(
        '{"rating": 4.5, "headline": "A really quite long and descriptive headline with many words in it", "body": ["One."]}',
    );
    eq("C1 long multi-word headline survives unmangled", longHeadline.headline, "A really quite long and descriptive headline with many words in it");
}

// ── D: content-tag-utils' review profile tags exactly match the three new preset entries ──
{
    const reviewGroup = contentTags.CONTENT_SCOPE_TAG_GROUPS.find((g) => g.id === "review");
    check("D1 review tag group registered", Boolean(reviewGroup), reviewGroup);
    const minorTagSets = (reviewGroup?.minors ?? []).map((m) => JSON.stringify(m.tags)).sort();
    const expected = [
        JSON.stringify(["review"]),
        JSON.stringify(["review", "discuss_safe"]),
        JSON.stringify(["review", "discuss_free"]),
        JSON.stringify(["review", "write"]),
    ].sort();
    eq("D2 review minors' tag arrays match exactly", minorTagSets.join(","), expected.join(","));

    // cross-check against the actual preset entries in builtin-preset.ts
    const preset = builtinPreset.createBuiltinPreset();
    const reviewEntries = preset.prompts.filter((p) => Array.isArray(p.tags) && p.tags[0] === "review");
    eq("D3 exactly three review-tagged preset entries exist", reviewEntries.length, 3);
    const presetTagSets = reviewEntries.map((p) => JSON.stringify(p.tags)).sort();
    const expectedPresetTags = [
        JSON.stringify(["review", "discuss_safe"]),
        JSON.stringify(["review", "discuss_free"]),
        JSON.stringify(["review", "write"]),
    ].sort();
    eq("D4 preset entry tags match the tag-profile minors exactly", presetTagSets.join(","), expectedPresetTags.join(","));

    check("D5 review_write entry teaches the JSON contract",
        reviewEntries.find((p) => p.identifier === "review_write")?.content.includes('"rating"'),
        reviewEntries.find((p) => p.identifier === "review_write")?.content.slice(0, 200));

    check("D6 all three entries reference the honest secondhand framing or grounding macros",
        reviewEntries.every((p) => p.content.includes("{{reviewOverview}}")),
        reviewEntries.map((p) => p.identifier));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
