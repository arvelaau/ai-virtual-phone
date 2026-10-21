// Story mode, multi-character only (the lean restore of 2026-10-21): saved groups, the shared
// group story, projection to every participant, the roster message, and straight dialogue quotes.
// Drives the real lib/story-storage.ts through the in-memory dexie stub.
//
//   node _fx-story-group.mjs

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
// Sessions saved by the older (branch/group) build, present in the DB before the first hydrate.
const stub = await jiti.import("./_fx-dexie-stub.mjs");
const StubClass = stub.default ?? stub;
const origVersion = StubClass.prototype.version;
StubClass.prototype.version = function (...a) {
    const out = origVersion.apply(this, a);
    const origStores = out.stores;
    out.stores = (schema) => {
        const r = origStores.call(out, schema);
        if (this.name === "AiPhoneStoryDB" && this.sessions) {
            const now = new Date().toISOString();
            this.sessions.rows.set("old_branch", { id: "old_branch", characterId: "char_old", branchId: "branch_2", updatedAt: now, uiPrefs: {} });
            this.sessions.rows.set("old_group", { id: "old_group", characterId: "char_old", ownerType: "group", ownerId: "old_grp_id", participantIds: ["char_old", "char_old2"], branchId: "main", updatedAt: now, uiPrefs: {} });
        }
        return r;
    };
    return out;
};
const st = await jiti.import("./lib/story-storage.ts");
const eng = await jiti.import("./lib/story-engine.ts");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, Object.is(g, w), { got: g, want: w });

await st.hydrateStoryStorage();

// ── A. groups ────────────────────────────────────────────────────────────────────────
{
    ok("A0 starts with no groups", st.loadStoryGroups().length === 0);
    let threw = false;
    try { st.createStoryGroup(["a"]); } catch { threw = true; }
    ok("A1 one character is not a group", threw);
    threw = false;
    try { st.createStoryGroup(["a", "a"]); } catch { threw = true; }
    ok("A1b the same character twice is not a group", threw);

    const g = st.createStoryGroup(["char_a", "char_b", "char_c"], "  Road Trip  ");
    eq("A2 name is trimmed", g.name, "Road Trip");
    ok("A3 roster order is kept (first = primary)", g.characterIds.join(",") === "char_a,char_b,char_c", g.characterIds);
    eq("A4 default name", st.createStoryGroup(["x", "y"]).name, "Group Story");
    eq("A5 both saved", st.loadStoryGroups().length, 2);
    eq("A6 rename", st.renameStoryGroup(g.id, "Weekend")?.name, "Weekend");
    eq("A6b blank rename refused", st.renameStoryGroup(g.id, "   "), null);
    eq("A6c rename persisted", st.loadStoryGroups().find(x => x.id === g.id)?.name, "Weekend");
}

// ── B. the shared story ──────────────────────────────────────────────────────────────
{
    const group = st.loadStoryGroups().find(x => x.name === "Weekend");
    const s1 = st.createOrGetStoryGroupSession(group);
    eq("B1 bound to the primary character", s1.characterId, "char_a");
    eq("B2 carries the group id", s1.groupId, group.id);
    ok("B3 carries every participant", s1.participantIds.join(",") === "char_a,char_b,char_c", s1.participantIds);
    eq("B4 same session on the second call", st.createOrGetStoryGroupSession(group).id, s1.id);

    const own = st.createOrGetStorySession("char_a");
    ok("B5 a character's own story is NOT the group's", own.id !== s1.id && !own.groupId, own);
    eq("B6 and asking again returns the same own story", st.createOrGetStorySession("char_a").id, own.id);

    // editing the roster keeps the story and follows the new roster
    const edited = { ...group, characterIds: ["char_b", "char_a"] };
    const s2 = st.createOrGetStoryGroupSession(edited);
    eq("B7 roster edit keeps the same story", s2.id, s1.id);
    eq("B8 and rebinds to the new primary", s2.characterId, "char_b");
    ok("B9 and the new participants", s2.participantIds.join(",") === "char_b,char_a", s2.participantIds);
}

// ── C. projection: every participant remembers the group scene ───────────────────────────
{
    const group = st.loadStoryGroups().find(x => x.name === "Weekend");
    const session = st.createOrGetStoryGroupSession({ ...group, characterIds: ["char_a", "char_b", "char_c"] });
    st.pushStoryMessage({ sessionId: session.id, role: "user", rawContent: "we reach the lake", renderedContent: "we reach the lake" });
    st.pushStoryMessage({ sessionId: session.id, role: "assistant", rawContent: "<content>Mia laughs.</content>", renderedContent: "Mia laughs.", storySummary: "They reached the lake." });
    const seen = (id) => JSON.stringify(st.loadStoryProjectionEntries(id));
    ok("C1 the primary sees it", seen("char_a").includes("lake"));
    ok("C2 the second participant sees it", seen("char_b").includes("lake"));
    ok("C3 the third participant sees it", seen("char_c").includes("lake"));
    ok("C4 an outsider does NOT", !seen("char_zzz").includes("lake"));
}

// ── D. data left by the older build is hidden, not destroyed ─────────────────────────────
{
    const ids = st.loadStorySessions().map(x => x.id);
    ok("D1 a leftover branch page is not listed", !ids.includes("old_branch"), ids);
    ok("D2 an older-build group story IS listed", ids.includes("old_group"), ids);
    eq("D3 and is recognised as a group story", st.getStorySessionGroupId({ ownerType: "group", ownerId: "old_grp_id" }), "old_grp_id");
    ok("D4 a character's own story ignores both", st.createOrGetStorySession("char_old").id !== "old_group" && st.createOrGetStorySession("char_old").id !== "old_branch");
    ok("D5 the older group story is projected to its participants", JSON.stringify(st.loadStoryProjectionEntries("char_old2")) !== undefined);
}

// ── E. deleting a group deletes its story and nothing else ───────────────────────────────
{
    const group = st.loadStoryGroups().find(x => x.name === "Weekend");
    const session = st.createOrGetStoryGroupSession({ ...group, characterIds: ["char_a", "char_b", "char_c"] });
    const own = st.createOrGetStorySession("char_a");
    st.pushStoryMessage({ sessionId: own.id, role: "user", rawContent: "just us", renderedContent: "just us" });
    st.deleteStoryGroup(group.id);
    ok("E1 the group is gone", !st.loadStoryGroups().some(x => x.id === group.id));
    ok("E2 its story is gone", !st.loadStorySessions().some(x => x.id === session.id));
    eq("E3 its messages are gone", st.loadStoryMessages(session.id).length, 0);
    ok("E4 a character's own story and messages survive", st.loadStoryMessages(own.id).length === 1);
}

// ── F. roster message + straight quotes ──────────────────────────────────────────────────
{
    eq("F1 no roster for a single character", eng.buildStoryRosterMessage([{ name: "Mia" }]), null);
    const roster = eng.buildStoryRosterMessage([
        { name: "Mia", briefPersona: "warm and chatty" },
        { name: "Ken", personality: "dry and quiet" },
        { name: "Zed" },
    ]);
    eq("F2 it is a system message", roster?.role, "system");
    ok("F3 lists every character with its profile", /1\. Mia: warm and chatty/.test(roster.content) && /2\. Ken: dry and quiet/.test(roster.content) && /3\. Zed(\n|$)/.test(roster.content), roster?.content);
    ok("F4 forbids merging speakers / deciding for the user", /Do not merge/.test(roster.content) && /user's actions/.test(roster.content));

    ok("F5 the quote rule asks for straight double quotes", /straight double quotes/.test(eng.STORY_QUOTE_RULE) && eng.STORY_QUOTE_RULE.includes('"'));
    ok("F6 and names no corner quote character", !/[「」『』]/.test(eng.STORY_QUOTE_RULE));

    const src = fs.readFileSync(path.join(root, "lib/story-engine.ts"), "utf8");
    const fnStart = src.indexOf("async function buildStoryPromptMessages");
    const fnEnd = src.indexOf("\nexport async function previewStoryPromptPayload", fnStart);
    ok("F7 located the prompt builder", fnStart > 0 && fnEnd > fnStart);
    const body = src.slice(fnStart, fnEnd);
    ok("F8 the quote rule is appended on every story prompt", body.includes("STORY_QUOTE_RULE"));
    ok("F9 the roster is only added for several participants", /participantIds && participantIds\.length > 1/.test(body));
    ok("F10 both generate paths forward participantIds", (src.match(/options\?\.participantIds/g) || []).length >= 2);
    ok("F11 no corner-quote characters in the story engine", !/[「」]/.test(src));

    const app = fs.readFileSync(path.join(root, "components/story/story-app-base.tsx"), "utf8");
    eq("F12 the UI passes participantIds to both generate calls", (app.match(/^\s+participantIds,$/gm) || []).length, 2);
    ok("F13 the UI has none of the removed extras", !/story-settings-page|story-pagination|TTS|speakText|POV|storyScheme|story-scheme/i.test(app));
    ok("F14 no corner-quote characters in the story UI/parser/css", !/[「」]/.test(app) && !/[「」]/.test(fs.readFileSync(path.join(root, "lib/story-parser.ts"), "utf8")));
}

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
