// Phase 4 (Story overhaul), Stage 1: lib/story-storage.ts's data-layer rewrite, ported from
// momo.float.phone (momo/main, reachable via e69f303 "story branches and multiplayer meetings"
// + 7fb9a8b "offline invites and story branch tools" + a5211d8, among others -- ported as the
// combined current state rather than replayed commit by commit). Adds a shared scheme
// repository (prose/status/theater/quick-input schemes, previously per-character in momo,
// never existed in any form here), multiplayer StoryGroups, and branch-aware StorySessions
// (ownerType/ownerId/branchId replacing the old one-session-per-character model).
//
// Deliberately NOT ported: momo's migrateLegacyStorySchemeData(), which folds each
// character's OLD per-character scheme lists into the new shared repository -- this fork
// never had that per-character storage, so there is nothing to migrate.
//
// This fixture drives the real lib/story-storage.ts (aliasing `dexie` to the shared
// in-memory stub, and lib/kv-db.ts for real too, since the scheme repository and groups
// live in KV, not IndexedDB).
//
//   node _fx-momo-story-schemes.mjs

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
let dispatched = [];
globalThis.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; console.log("FAIL", name, extra ?? ""); }
}

const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

const story = await jiti.import("./lib/story-storage.ts");
await story.hydrateStoryStorage();

// ── A. Scheme repository: defaults, round trip, sanitization ──
{
    const repo = story.loadStorySchemeRepository();
    check("A1 an empty repository backfills the built-in defaults", repo.proseStyleSchemes.length === 3 && repo.statusSchemes.length === 2 && repo.theaterSchemes.length === 2 && repo.quickInputSchemes.length === 1);
    check("A2 default entries are English, not a literal translation of the Chinese source", repo.proseStyleSchemes[0].name === "Natural" && repo.statusSchemes[0].name === "Relationship Meter");

    dispatched = [];
    const customRepo = {
        proseStyleSchemes: [{ id: "p1", name: "Custom Style", prompt: "write darkly" }],
        statusSchemes: repo.statusSchemes,
        theaterSchemes: repo.theaterSchemes,
        quickInputSchemes: repo.quickInputSchemes,
    };
    story.saveStorySchemeRepository(customRepo);
    check("A3 saving dispatches the repo-updated event", dispatched.includes(story.STORY_SCHEME_REPO_EVENT));
    const reloaded = story.loadStorySchemeRepository();
    check("A4 a saved custom prose scheme round-trips", reloaded.proseStyleSchemes.length === 1 && reloaded.proseStyleSchemes[0].name === "Custom Style");

    // A5: corrupt/malformed entries are dropped, not fatal; an empty resulting list falls
    // back to defaults rather than staying empty.
    story.saveStorySchemeRepository({
        proseStyleSchemes: [{ id: "", name: "no id" }, "not an object", null],
        statusSchemes: [],
        theaterSchemes: reloaded.theaterSchemes,
        quickInputSchemes: reloaded.quickInputSchemes,
    });
    const afterCorrupt = story.loadStorySchemeRepository();
    check("A5 malformed prose entries are dropped and the empty result falls back to defaults", afterCorrupt.proseStyleSchemes.length === 3);
    check("A5b an explicitly empty array (statusSchemes) also falls back to defaults", afterCorrupt.statusSchemes.length === 2);

    // Reset for later groups.
    story.saveStorySchemeRepository(story.loadStorySchemeRepository());
}

// ── B. resolveActiveStorySchemes: fallback on a dangling/missing choice ──
{
    const repo = story.loadStorySchemeRepository();
    const validId = repo.proseStyleSchemes[0].id;
    const resolvedValid = story.resolveActiveStorySchemes({ activeProseStyleSchemeId: validId });
    check("B1 a valid active id resolves to the matching scheme", resolvedValid.proseStyle?.id === validId);

    const resolvedDangling = story.resolveActiveStorySchemes({ activeProseStyleSchemeId: "does-not-exist" });
    check("B2 a dangling active id falls back to the repository's first scheme, not null", resolvedDangling.proseStyle?.id === repo.proseStyleSchemes[0].id);

    const resolvedUndefined = story.resolveActiveStorySchemes(undefined);
    check("B3 no settings at all still resolves status/theater to the first repository entry", resolvedUndefined.status !== null && resolvedUndefined.theater !== null);
}

// ── C. resolveActiveQuickInputScheme: selected -> legacy-content-match -> first ──
{
    const repo = story.loadStorySchemeRepository();
    const defaultScheme = repo.quickInputSchemes[0];
    const bySelection = story.resolveActiveQuickInputScheme({ activeQuickInputSchemeId: defaultScheme.id }, repo);
    check("C1 an explicit selection resolves directly", bySelection.id === defaultScheme.id);

    const byLegacyMatch = story.resolveActiveQuickInputScheme({ quickInputOptions: [...defaultScheme.options], quickInputCursor: defaultScheme.cursor }, repo);
    check("C2 legacy options matching an existing scheme's content resolve to that scheme (pre-migration fallback)", byLegacyMatch.id === defaultScheme.id);

    const byFallback = story.resolveActiveQuickInputScheme({}, repo);
    check("C3 no selection and no legacy data falls back to the repository's first scheme", byFallback.id === defaultScheme.id);
}

// ── D. StoryGroup: create/update/delete ──
{
    let threwTooFew = false;
    try { story.createStoryGroup(["only-one"]); } catch { threwTooFew = true; }
    check("D1 creating a group with fewer than 2 characters throws", threwTooFew);

    const group = story.createStoryGroup(["char_a", "char_b"], "Test Meeting");
    check("D2 a group with 2+ characters is created", group.characterIds.length === 2 && group.name === "Test Meeting");
    check("D3 it's readable back via loadStoryGroups", story.loadStoryGroups().some((g) => g.id === group.id));

    const updated = story.updateStoryGroup(group.id, { characterIds: ["char_a", "char_b", "char_c"] });
    check("D4 updateStoryGroup grows the roster", updated?.characterIds.length === 3);

    const rejectedShrink = story.updateStoryGroup(group.id, { characterIds: ["char_a"] });
    check("D5 updateStoryGroup refuses to shrink below 2 characters (returns null, doesn't corrupt)", rejectedShrink === null);
    check("D5b ...and the group is unchanged", story.loadStoryGroups().find((g) => g.id === group.id)?.characterIds.length === 3);

    // D6: creating a session under this group, then deleting the group, cascades the session.
    const groupSession = story.createOrGetStorySession("char_a", { ownerType: "group", ownerId: group.id, participantIds: ["char_a", "char_b", "char_c"] });
    story.pushStoryMessage({ sessionId: groupSession.id, role: "user", rawContent: "hello group" });
    story.deleteStoryGroup(group.id);
    check("D6 deleting a group removes it from loadStoryGroups", !story.loadStoryGroups().some((g) => g.id === group.id));
    check("D6b ...and cascades its sessions (even the main branch, via allowMain)", story.loadStoryMessages(groupSession.id).length === 0);
}

// ── E. Branches: ownerKey computation, main-branch defaults, branch creation, ordering ──
{
    const main = story.createOrGetStorySession("char_branch_test");
    check("E1 a plain call with no options creates a single-owner main branch", main.ownerType === "single" && main.branchId === "main" && main.branchOrder === 0);
    check("E2 main branch inherits recent memory by default and is not independent", main.inheritRecentMemory === true && main.independentStory === false);

    const branch1 = story.createOrGetStorySession("char_branch_test", { branchId: "b1", branchName: "What If", independentStory: true, inheritRecentMemory: true });
    check("E3 a non-main branch does NOT inherit recent memory by default unless explicitly requested", branch1.independentStory === true && branch1.inheritRecentMemory === true);
    check("E4 requesting inheritRecentMemory on a branch locks it (inheritRecentMemoryLocked)", branch1.inheritRecentMemoryLocked === true);
    check("E5 a named branch keeps its given name and gets branchOrder 1", branch1.branchName === "What If" && branch1.branchOrder === 1);

    const branch2 = story.createOrGetStorySession("char_branch_test", { branchId: "b2" });
    check("E6 a second branch increments branchOrder past the first", branch2.branchOrder === 2);
    check("E6b an unnamed branch gets an auto-generated name", branch2.branchName.startsWith("Story Branch"));

    const forOwner = story.loadStorySessionsForOwner("single", "char_branch_test");
    check("E7 loadStorySessionsForOwner returns all 3 branches, ordered by branchOrder", forOwner.length === 3 && forOwner[0].branchId === "main" && forOwner[1].branchId === "b1" && forOwner[2].branchId === "b2");

    // E8: re-requesting the same branchId returns the EXISTING session, not a duplicate.
    const branch1Again = story.createOrGetStorySession("char_branch_test", { branchId: "b1" });
    check("E8 requesting an existing branchId again returns the same session, not a new one", branch1Again.id === branch1.id);

    // E9: deleting the main branch is refused unless allowMain is explicitly passed.
    story.deleteStorySessions([main.id]);
    check("E9 deleteStorySessions refuses to delete the main branch without allowMain", story.loadStorySessionsForOwner("single", "char_branch_test").some((s) => s.id === main.id));
    story.deleteStorySessions([branch1.id]);
    check("E10 a non-main branch deletes normally", !story.loadStorySessionsForOwner("single", "char_branch_test").some((s) => s.id === branch1.id));
}

// ── F. loadStoryProjectionEntries: independent-story exclusion ──
{
    const normalSession = story.createOrGetStorySession("char_projection_normal");
    story.pushStoryMessage({ sessionId: normalSession.id, role: "assistant", rawContent: "x", storySummary: "A normal story event happened." });
    const normalProjections = story.loadStoryProjectionEntries("char_projection_normal");
    check("F1 a normal (non-independent) story's summary is projected", normalProjections.length === 1 && normalProjections[0].content.includes("normal story event"));

    const indepSession = story.createOrGetStorySession("char_projection_indep", { branchId: "b1", independentStory: true });
    story.pushStoryMessage({ sessionId: indepSession.id, role: "assistant", rawContent: "x", storySummary: "A secret independent-branch event." });
    const indepProjections = story.loadStoryProjectionEntries("char_projection_indep");
    check("F2 an independent story's summary is NOT projected while excluded from memory", indepProjections.length === 0);

    story.updateStorySession(indepSession.id, { includedInMemoryAt: new Date().toISOString() });
    const indepProjectionsAfter = story.loadStoryProjectionEntries("char_projection_indep");
    check("F3 once explicitly included in memory (includedInMemoryAt set), the same story IS projected", indepProjectionsAfter.length === 1 && indepProjectionsAfter[0].content.includes("secret independent"));

    check("F4 the [Event ...] label is English (this fork's own fix), not momo's Chinese [事件 ...]", indepProjectionsAfter[0].content.startsWith("[Event "));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
