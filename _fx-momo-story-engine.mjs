// Phase 4 (Story overhaul), Stage 2: lib/story-parser.ts's always-fold story_status/story_theater
// change, and lib/story-engine.ts's merge -- momo's new StoryGenerationOptions (settings prompt,
// independent-story memory skip, multiplayer roster, voice-format teaching) merged in alongside
// this fork's own pre-existing [Message]-dispatch/app-card support (untouched, not re-tested here
// -- already covered by _fx-narrative-app-card.mjs and _fx-offline-session.mjs).
//
// Drives the real lib/story-parser.ts, lib/story-engine.ts and lib/short-term-assembler.ts
// (the new afterTimestamp threading added this stage) via jiti, aliasing dexie to the shared
// in-memory stub.
//
//   node _fx-momo-story-engine.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; console.log("FAIL", name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
}
function eq(name, got, want) { check(`${name} (want ${JSON.stringify(want)})`, got === want, got); }

const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

const storyParser = await jiti.import("./lib/story-parser.ts");
const storyEngine = await jiti.import("./lib/story-engine.ts");
const story = await jiti.import("./lib/story-storage.ts");
const assembler = await jiti.import("./lib/short-term-assembler.ts");
const chars = await jiti.import("./lib/character-storage.ts");
const reviewMemory = await jiti.import("./lib/review-memory.ts");

await story.hydrateStoryStorage();

// ── 1. story-parser.ts: story_status/story_theater always fold, regardless of the user's own foldTags ──
{
    const raw = "Some prose.\n<story_status>HP: 10</story_status>\n<story_theater>*giggles*</story_theater>\nMore prose.";

    const withNoUserFoldTags = storyParser.parseStoryResponse(raw, [], { foldTags: "" });
    check("1a story_status folds even with an empty user foldTags setting", withNoUserFoldTags.renderedText.includes("<!--RHR-FOLD:story_status-->"), withNoUserFoldTags.renderedText);
    check("1b story_theater folds even with an empty user foldTags setting", withNoUserFoldTags.renderedText.includes("<!--RHR-FOLD:story_theater-->"), withNoUserFoldTags.renderedText);
    check("1c the raw <story_status> tag itself is gone from renderedText", !withNoUserFoldTags.renderedText.includes("<story_status>"), withNoUserFoldTags.renderedText);

    const withOtherUserFoldTags = storyParser.parseStoryResponse(raw, [], { foldTags: "think" });
    check("1d story_status still folds when the user's foldTags is some unrelated tag", withOtherUserFoldTags.renderedText.includes("<!--RHR-FOLD:story_status-->"), withOtherUserFoldTags.renderedText);

    eq("1e STORY_PARSER_VERSION bumped to 8", storyParser.STORY_PARSER_VERSION, 8);
}

// ── 2. selectStoryPresetPrompts ──
{
    const preset = {
        id: "p1", name: "Test Preset",
        prompts: [
            { identifier: "marker_one", marker: true, enabled: true },
            { identifier: "opt_a", marker: false, enabled: true },
            { identifier: "opt_b", marker: false, enabled: true },
        ],
        prompt_order: ["marker_one", "opt_a", "opt_b"],
    };

    const unchanged = storyEngine.selectStoryPresetPrompts(preset, undefined);
    check("2a undefined selectedIds returns the preset completely unfiltered", unchanged.prompts.every(p => p.enabled === true), unchanged);

    const filtered = storyEngine.selectStoryPresetPrompts(preset, ["opt_a"]);
    const byId = Object.fromEntries(filtered.prompts.map(p => [p.identifier, p.enabled]));
    eq("2b a marker entry stays enabled regardless of selection", byId.marker_one, true);
    eq("2c a selected non-marker entry stays enabled", byId.opt_a, true);
    eq("2d an unselected non-marker entry is disabled even though it started enabled", byId.opt_b, false);

    eq("2e a null preset passes through unchanged", storyEngine.selectStoryPresetPrompts(null, ["x"]), null);
}

// ── 3. buildStorySettingsPrompt ──
{
    eq("3a undefined settings returns an empty string", storyEngine.buildStorySettingsPrompt(undefined, "User"), "");

    const clamped = storyEngine.buildStorySettingsPrompt({ minChars: 10, maxChars: 99999 }, "User");
    check("3b minChars below 50 clamps up to 50", clamped.includes("50-10000"), clamped);

    const third = storyEngine.buildStorySettingsPrompt({ userPerspective: "third" }, "User");
    check("3c third-person perspective is taught", third.toLowerCase().includes("third person"), third);

    const byName = storyEngine.buildStorySettingsPrompt({ userPerspective: "username" }, "Ren");
    check("3d username perspective includes the actual user name", byName.includes("Ren"), byName);

    const second = storyEngine.buildStorySettingsPrompt({}, "User");
    check("3e default (no userPerspective set) teaches second person", second.toLowerCase().includes("second person"), second);

    // Seed the shared scheme repository with a prose scheme that HAS a prompt.
    const repoWithPrompt = story.loadStorySchemeRepository();
    story.saveStorySchemeRepository({
        ...repoWithPrompt,
        proseStyleSchemes: [{ id: "ps1", name: "Fairy Tale", prompt: "write like a whimsical fairy tale" }],
    });
    const withSchemePrompt = storyEngine.buildStorySettingsPrompt({ activeProseStyleSchemeId: "ps1" }, "User");
    check("3f a non-empty prose scheme prompt is taught by name", withSchemePrompt.includes("[Fairy Tale]") && withSchemePrompt.includes("write like a whimsical fairy tale"), withSchemePrompt);

    // A scheme with an EMPTY prompt falls back to the legacy settings.proseStyle field instead.
    story.saveStorySchemeRepository({
        ...story.loadStorySchemeRepository(),
        proseStyleSchemes: [{ id: "ps2", name: "Empty", prompt: "" }],
    });
    const withLegacyFallback = storyEngine.buildStorySettingsPrompt({ activeProseStyleSchemeId: "ps2", proseStyle: "Noir" }, "User");
    check("3g an empty scheme prompt falls back to the legacy proseStyle field", withLegacyFallback.includes("Style: Noir."), withLegacyFallback);
    check("3g2 ...and does NOT emit an empty '[Empty]:' style line", !withLegacyFallback.includes("[Empty]"), withLegacyFallback);

    const withEntries = storyEngine.buildStorySettingsPrompt({
        customPromptEntries: [
            { id: "e1", name: "Tone", content: "Keep it lighthearted", enabled: true },
            { id: "e2", name: "Disabled one", content: "should not appear", enabled: false },
            { id: "e3", name: "Empty one", content: "   ", enabled: true },
        ],
    }, "User");
    check("3h an enabled, non-empty custom entry is included", withEntries.includes("Keep it lighthearted"), withEntries);
    check("3i a disabled entry is excluded", !withEntries.includes("should not appear"), withEntries);
    check("3j an enabled-but-blank entry is excluded", !withEntries.includes("Empty one"), withEntries);

    // Reset the repository to defaults so later groups aren't affected by this group's custom schemes.
    story.saveStorySchemeRepository(story.defaultStorySchemeRepository ? story.defaultStorySchemeRepository() : { proseStyleSchemes: [], statusSchemes: [], theaterSchemes: [], quickInputSchemes: [] });
}

// All characters used across groups 4 and 5 are seeded together, in one call -- saveCharacters
// fully REPLACES the stored list rather than merging, so seeding per-group would wipe earlier
// groups' characters out from under a later group that still needs them.
const CHAR_ID = "char_story_engine_test";
const MAIN_ID = "char_engine_main";
const P2_ID = "char_engine_p2";
const P3_ID = "char_engine_p3";
chars.saveCharacters([
    { id: CHAR_ID, name: "Story Tester", persona: "" },
    { id: MAIN_ID, name: "Nova", persona: "" },
    { id: P2_ID, name: "Reeve", persona: "a quiet detective", briefPersona: "the quiet detective" },
    { id: P3_ID, name: "Wisp", persona: "", personality: "chaotic and playful" },
]);

// ── 4. afterTimestamp threading through prepareShortTermContext (the new plumbing added this stage) ──
{
    const title = {
        id: "title_x", kind: "movie", title: "A Test Film", creator: "Nobody", overview: "",
        coverAssetId: null, source: { kind: "movie", provider: "manual" }, status: "finished",
        grounding: null, myRating: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const oldTs = new Date(Date.now() - 10 * 60000).toISOString();
    const newTs = new Date(Date.now() - 1 * 60000).toISOString();
    const cutoff = new Date(Date.now() - 5 * 60000).toISOString();

    reviewMemory.recordReviewJournalEvent(title, {
        id: "j_old", titleId: "title_x", authorType: "user", authorName: "User",
        body: "OLD_MARKER an early thought.", createdAt: oldTs, updatedAt: oldTs,
    }, CHAR_ID);
    reviewMemory.recordReviewJournalEvent(title, {
        id: "j_new", titleId: "title_x", authorType: "user", authorName: "User",
        body: "NEW_MARKER a later thought.", createdAt: newTs, updatedAt: newTs,
    }, CHAR_ID);

    const noFilter = assembler.prepareShortTermContext(CHAR_ID, "story", { userName: "User" });
    const noFilterText = noFilter.unifiedRecentItems.map(i => i.text).join("\n");
    check("4a with no afterTimestamp, both the old and new entries are present", noFilterText.includes("OLD_MARKER") && noFilterText.includes("NEW_MARKER"), noFilterText);

    const midFilter = assembler.prepareShortTermContext(CHAR_ID, "story", { userName: "User", afterTimestamp: cutoff });
    const midFilterText = midFilter.unifiedRecentItems.map(i => i.text).join("\n");
    check("4b with afterTimestamp between the two, only the new entry survives", !midFilterText.includes("OLD_MARKER") && midFilterText.includes("NEW_MARKER"), midFilterText);

    const futureFilter = assembler.prepareShortTermContext(CHAR_ID, "story", { userName: "User", afterTimestamp: new Date(Date.now() + 60000).toISOString() });
    const futureFilterText = futureFilter.unifiedRecentItems.map(i => i.text).join("\n");
    check("4c a far-future afterTimestamp excludes everything", !futureFilterText.includes("OLD_MARKER") && !futureFilterText.includes("NEW_MARKER"), futureFilterText);
}

// ── 5. buildStoryPromptMessages: multiplayer roster / independent-story memory skip / settings prompt / floating-chat-context / voice-format ──
{
    // 5a: no participantIds -> no multiplayer roster message.
    const soloMessages = await storyEngine.buildStoryPromptMessages(MAIN_ID, [], null, [], [], undefined, undefined, undefined, undefined, undefined);
    check("5a solo (no participantIds) has no multiplayer roster message", !soloMessages.some(m => m.content.includes("Multiplayer meeting story")), soloMessages);

    // 5b: 3 participants -> a roster message naming all three, using the persona-fallback chain.
    const multiMessages = await storyEngine.buildStoryPromptMessages(MAIN_ID, [], null, [], [], undefined, undefined, undefined, [MAIN_ID, P2_ID, P3_ID], undefined);
    const roster = multiMessages.find(m => m.content.includes("Multiplayer meeting story"));
    check("5b a multiplayer roster message is present for 3+ participants", Boolean(roster), multiMessages);
    check("5c the roster names all three characters", roster && ["Nova", "Reeve", "Wisp"].every(n => roster.content.includes(n)), roster);
    check("5d Reeve's line uses briefPersona over persona", roster && roster.content.includes("the quiet detective") && !roster.content.includes("a quiet detective:"), roster);
    check("5e Wisp's line falls back to personality when briefPersona/persona are empty", roster && roster.content.includes("chaotic and playful"), roster);

    // 5f: the very last message is always the voice-format teaching.
    const last = soloMessages[soloMessages.length - 1];
    eq("5f the last message role is system", last.role, "system");
    check("5g the last message is the voice-format prompt", last.content.startsWith("# Story prose format"), last.content);
    check("5h the voice-format prompt keeps the 「」 structural token untranslated", last.content.includes("「") && last.content.includes("」"), last.content);

    // 5i/5j: independent-story note present only when requested, and it actually SKIPS recent
    // short-term context (proven by the review-projection marker from group 4 NOT appearing).
    // Reuses CHAR_ID from group 4, which has real short-term events recorded.
    const dependentMessages = await storyEngine.buildStoryPromptMessages(CHAR_ID, [], null, [], [], undefined, undefined, undefined, undefined, { independent: false });
    const independentMessages = await storyEngine.buildStoryPromptMessages(CHAR_ID, [], null, [], [], undefined, undefined, undefined, undefined, { independent: true });
    check("5i no independent-branch note when independent is false", !dependentMessages.some(m => m.content.includes("Independent story branch")), dependentMessages);
    check("5j an independent-branch note IS present when independent is true", independentMessages.some(m => m.content.includes("Independent story branch")), independentMessages);
    const dependentText = dependentMessages.map(m => m.content).join("\n");
    const independentText = independentMessages.map(m => m.content).join("\n");
    check("5k the non-independent call sees the recent short-term marker", dependentText.includes("NEW_MARKER"), dependentText);
    check("5l the independent call does NOT see it -- context is genuinely skipped, not just labelled", !independentText.includes("NEW_MARKER"), independentText);

    // 5m: settings prompt appears when settings are given.
    const withSettings = await storyEngine.buildStoryPromptMessages(MAIN_ID, [], null, [], [], undefined, { minChars: 100, maxChars: 200 }, undefined, undefined, undefined);
    check("5m a settings prompt is injected when settings are provided", withSettings.some(m => m.content.includes("Story app generation settings")), withSettings);

    // 5n/5o: floating-chat-context only injects when the toggle is explicitly on AND content is non-empty.
    const withFloatingOn = await storyEngine.buildStoryPromptMessages(MAIN_ID, [], null, [], [], undefined, { floatingPhoneInContext: true }, "Hey, what's up?", undefined, undefined);
    check("5n floating chat context is injected when the toggle is on and content is given", withFloatingOn.some(m => m.content.includes("Hey, what's up?")), withFloatingOn);

    const withFloatingOff = await storyEngine.buildStoryPromptMessages(MAIN_ID, [], null, [], [], undefined, { floatingPhoneInContext: false }, "Hey, what's up?", undefined, undefined);
    check("5o floating chat context is NOT injected when the toggle is off, even with content given", !withFloatingOff.some(m => m.content.includes("Hey, what's up?")), withFloatingOff);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
