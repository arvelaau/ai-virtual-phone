// Offline mode enter/exit session boundary (Point 2 of the 2026-09-08 analysis): explicit
// start/exit "visits" instead of a bare panel-visibility flip, a full-session wrap-up recap on
// exit (alongside the existing per-turn summaries), a brief-visit fallback note so the character
// can react to a fast exit even before/without the async LLM recap landing, and a best-effort
// calendar write on exit. Drives the real lib/chat-offline-storage.ts, lib/calendar-utils.ts and
// lib/calendar-storage.ts (aliasing `dexie` to the in-memory stub so chat-storage.ts's
// loadChatSessions() -- used by the projection reader -- is the real function, not a copy).
//
//   node _fx-offline-session.mjs

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
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const chatStorage = await jiti.import("./lib/chat-storage.ts");
const offline = await jiti.import("./lib/chat-offline-storage.ts");
const calUtils = await jiti.import("./lib/calendar-utils.ts");
const calStorage = await jiti.import("./lib/calendar-storage.ts");
const memSharing = await jiti.import("./lib/memory-sharing.ts");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, Object.is(g, w), { got: g, want: w });

await chatStorage.hydrateChatStorage();

function seedSession(id, contactId, isGroup = false) {
    chatStorage.saveChatSessions([
        ...chatStorage.loadChatSessions().filter(s => s.id !== id),
        {
            id, contactId, isGroup,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...(isGroup ? { participantIds: [contactId] } : {}),
        },
    ]);
}

const CHAR_ID = "char_test_1";
const SESSION_ID = "session_test_1";
seedSession(SESSION_ID, CHAR_ID, false);

// ── A. session CRUD ────────────────────────────────────────────────────────
{
    const s1 = offline.startChatOfflineSession(SESSION_ID);
    ok("A1 startChatOfflineSession creates a session with no endedAt", Boolean(s1.id) && !s1.endedAt, s1);
    eq("A2 getActiveChatOfflineSession finds it", offline.getActiveChatOfflineSession(SESSION_ID)?.id, s1.id);

    const s2 = offline.startChatOfflineSession(SESSION_ID);
    ok("A3 starting a second session while one is active auto-closes the first",
        offline.loadChatOfflineSessions(SESSION_ID).find(s => s.id === s1.id)?.endedAt !== undefined);
    eq("A3b the new session becomes active", offline.getActiveChatOfflineSession(SESSION_ID)?.id, s2.id);

    eq("A4 endChatOfflineSession on an unknown id returns null", offline.endChatOfflineSession(SESSION_ID, "does-not-exist"), null);

    const ended = offline.endChatOfflineSession(SESSION_ID, s2.id);
    ok("A5 endChatOfflineSession sets endedAt and returns turnCount", Boolean(ended?.session.endedAt) && ended?.turnCount === 0, ended);

    eq("A6 ending an already-ended session returns null", offline.endChatOfflineSession(SESSION_ID, s2.id), null);
    eq("A7 getActiveChatOfflineSession returns null after ending", offline.getActiveChatOfflineSession(SESSION_ID), null);

    const patched = offline.patchChatOfflineSession(SESSION_ID, s2.id, { fullSummary: "They talked about the weather.", calendarTitle: "Chat about weather" });
    eq("A8 patchChatOfflineSession updates fullSummary", patched?.fullSummary, "They talked about the weather.");
    eq("A8b patchChatOfflineSession updates calendarTitle", patched?.calendarTitle, "Chat about weather");
    eq("A9 patch on an unknown id returns null", offline.patchChatOfflineSession(SESSION_ID, "does-not-exist", { fullSummary: "x" }), null);
}

// ── B. turn <-> session association ──────────────────────────────────────────
{
    offline.clearChatOfflineTurns(SESSION_ID);
    const sess = offline.startChatOfflineSession(SESSION_ID);
    offline.appendChatOfflineTurn({
        sessionId: SESSION_ID, userContent: "hi", assistantContent: "<content>hey</content><summary>said hi</summary>",
        summary: "said hi", summaryTag: "summary", offlineSessionId: sess.id,
    });
    offline.appendChatOfflineTurn({
        sessionId: SESSION_ID, userContent: "other session's turn", assistantContent: "x",
        summary: "x", summaryTag: "summary", offlineSessionId: "some-other-session",
    });
    const turns = offline.getChatOfflineSessionTurns(SESSION_ID, sess.id);
    eq("B1 only turns tagged with this session id are returned", turns.length, 1, turns);
    eq("B2 a turn from a different session is excluded", turns[0]?.userContent, "hi");

    const endedNoTurns = offline.endChatOfflineSession(SESSION_ID, offline.startChatOfflineSession(SESSION_ID).id);
    // brief is `turnCount > 0 && isBriefOfflineSession(...)`, so a 0-turn session evaluates to
    // the boolean `false` here (not `undefined`) -- functionally identical everywhere it is
    // read (both loadChatOfflineSessionProjectionEntries and chat-room.tsx only ever check
    // truthiness), so this asserts the falsy value the real code actually produces.
    eq("B3 a session with 0 turns is never marked brief", Boolean(endedNoTurns?.session.brief), false, endedNoTurns);
}

// ── C. isBriefOfflineSession ──────────────────────────────────────────────
{
    eq("C1 a single turn is brief regardless of duration", offline.isBriefOfflineSession(1, 10 * 60 * 1000), true);
    eq("C2 many turns but a very short span is brief", offline.isBriefOfflineSession(5, 30 * 1000), true);
    eq("C3 many turns and a long span is NOT brief", offline.isBriefOfflineSession(5, 10 * 60 * 1000), false);
    eq("C4 zero duration with 2 turns is still brief (duration-based)", offline.isBriefOfflineSession(2, 0), true);
}

// ── D. loadChatOfflineSessionProjectionEntries ───────────────────────────────
{
    offline.clearChatOfflineTurns(SESSION_ID);
    const fresh = "session_test_projection";
    seedSession(fresh, CHAR_ID, false);

    // D1: ended, has fullSummary -> projects it
    const s1 = offline.startChatOfflineSession(fresh);
    offline.appendChatOfflineTurn({ sessionId: fresh, userContent: "u", assistantContent: "a", summary: "s", summaryTag: "summary", offlineSessionId: s1.id });
    offline.appendChatOfflineTurn({ sessionId: fresh, userContent: "u2", assistantContent: "a2", summary: "s2", summaryTag: "summary", offlineSessionId: s1.id });
    offline.endChatOfflineSession(fresh, s1.id);
    offline.patchChatOfflineSession(fresh, s1.id, { fullSummary: "A long stretch where they explored the city together." });

    // D2: ended, brief, no summary -> fallback note
    const s2 = offline.startChatOfflineSession(fresh);
    offline.appendChatOfflineTurn({ sessionId: fresh, userContent: "quick", assistantContent: "a", summary: "s", summaryTag: "summary", offlineSessionId: s2.id });
    offline.endChatOfflineSession(fresh, s2.id); // 1 turn -> brief

    // D3: ended, NOT brief, no summary yet -> no entry (covered by per-turn projections already)
    const s3 = offline.startChatOfflineSession(fresh);
    for (let i = 0; i < 5; i++) {
        offline.appendChatOfflineTurn({ sessionId: fresh, userContent: `u${i}`, assistantContent: `a${i}`, summary: `s${i}`, summaryTag: "summary", offlineSessionId: s3.id });
    }
    // manufacture a long duration by patching startedAt into the past before ending
    const sessions3 = offline.loadChatOfflineSessions(fresh).map(s => s.id === s3.id ? { ...s, startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() } : s);
    // no direct setter, so simulate via patch (endedAt only) after manually rewriting startedAt through the storage key is not exposed --
    // instead just end it immediately: 5 turns already exceeds BRIEF_OFFLINE_SESSION_MAX_TURNS(1), and duration will be ~0ms which IS brief.
    // So to test "not brief", use isBriefOfflineSession directly (already covered in C) and here just confirm
    // a many-turn, immediately-ended session (duration ~0) IS brief and DOES get a fallback note if no summary lands.
    offline.endChatOfflineSession(fresh, s3.id);

    // D4: still-active session -> no entry
    const s4 = offline.startChatOfflineSession(fresh);
    offline.appendChatOfflineTurn({ sessionId: fresh, userContent: "u", assistantContent: "a", summary: "s", summaryTag: "summary", offlineSessionId: s4.id });

    // D5: group session -> excluded entirely
    const groupSession = "session_test_group";
    seedSession(groupSession, CHAR_ID, true);
    const gs = offline.startChatOfflineSession(groupSession);
    offline.appendChatOfflineTurn({ sessionId: groupSession, userContent: "u", assistantContent: "a", summary: "s", summaryTag: "summary", offlineSessionId: gs.id });
    offline.endChatOfflineSession(groupSession, gs.id);
    offline.patchChatOfflineSession(groupSession, gs.id, { fullSummary: "Should never surface, group is out of scope." });

    const entries = offline.loadChatOfflineSessionProjectionEntries(CHAR_ID);
    const byId = new Map(entries.map(e => [e.id, e]));
    ok("D1 an ended session with a full summary projects it", [...byId.values()].some(e => e.content.includes("explored the city together")), entries);
    ok("D2 a brief session with no summary yet projects the fallback note", [...byId.values()].some(e => e.content.includes("barely any time passed")), entries);
    ok("D3 s3 (5 turns, ~0 duration) is brief too and also surfaces a fallback note (not silently dropped)",
        [...byId.values()].filter(e => e.content.includes("barely any time passed")).length === 2, entries);
    ok("D4 the still-active session never appears", !entries.some(e => e.id === `chat_offline_session_projection_${s4.id}`));
    ok("D5 the group session never appears even with a real summary", !entries.some(e => e.content.includes("Should never surface")));

    const afterEntries = offline.loadChatOfflineSessionProjectionEntries(CHAR_ID, { afterTimestamp: "9999-01-01T00:00:00.000Z" });
    eq("D6 afterTimestamp in the far future excludes everything", afterEntries.length, 0, afterEntries);

    const excludeEntries = offline.loadChatOfflineSessionProjectionEntries(CHAR_ID, { excludeSessionId: fresh });
    ok("D7 excludeSessionId drops that chat session's entries", !excludeEntries.some(e => e.sessionId === fresh));
}

// ── E. parseOfflineSessionSummary ────────────────────────────────────────────
{
    const both = offline.parseOfflineSessionSummary("<title>Coffee run</title>\n<summary>They grabbed coffee and talked.</summary>");
    eq("E1 title extracted", both.title, "Coffee run");
    eq("E1b summary extracted", both.summary, "They grabbed coffee and talked.");

    const noTitle = offline.parseOfflineSessionSummary("<summary>Just a summary, no title tag.</summary>");
    eq("E2 missing title -> empty string, summary still extracted", noTitle.title, "");
    eq("E2b", noTitle.summary, "Just a summary, no title tag.");

    const neither = offline.parseOfflineSessionSummary("Just plain prose with no tags at all.");
    eq("E3 no tags at all -> falls back to the whole trimmed text as summary", neither.summary, "Just plain prose with no tags at all.");
    eq("E3b", neither.title, "");
}

// ── F. calendar-utils.ts deriveOfflineSessionScheduleWindow ─────────────────
{
    const normal = calUtils.deriveOfflineSessionScheduleWindow("2026-03-05T14:00:00.000Z".replace("Z", ""), "2026-03-05T15:00:00.000Z".replace("Z", ""));
    // Use local-time-safe ISO strings without a trailing Z so Date() parses them as local time,
    // matching how `new Date(session.startedAt)` behaves on real, non-Z timestamps in the app.
    ok("F1 a normal daytime window returns a valid range", Boolean(normal), normal);
    ok("F1b start < end", normal && normal.startTime < normal.endTime, normal);

    const beforeOpen = calUtils.deriveOfflineSessionScheduleWindow("2026-03-05T05:00:00", "2026-03-05T05:05:00");
    ok("F2 a session before CALENDAR_HOUR_START is clamped into the window, not dropped", Boolean(beforeOpen), beforeOpen);
    eq("F2b clamped start is 08:00", beforeOpen?.startTime, "08:00");

    const afterClose = calUtils.deriveOfflineSessionScheduleWindow("2026-03-05T23:30:00", "2026-03-05T23:45:00");
    ok("F3 a session starting after CALENDAR_HOUR_END has no room and returns null", afterClose === null, afterClose);

    const tooShort = calUtils.deriveOfflineSessionScheduleWindow("2026-03-05T14:00:00", "2026-03-05T14:00:05");
    ok("F4 a near-zero-length session is padded up to a minimum visible block", Boolean(tooShort), tooShort);
    ok("F4b padded block is at least 15 minutes", tooShort && (Number(tooShort.endTime.replace(":", "")) - Number(tooShort.startTime.replace(":", ""))) >= 15, tooShort);

    // Starts at 22:00 (an hour of real room before the window closes at 23:00) and crosses into
    // the next calendar day -- exercises the "different date -> clamp to CALENDAR_HOUR_END"
    // branch while still leaving room to pad/return a real window (unlike starting AT 23:00
    // itself, which is F3's "no room at all" case).
    const crossesMidnight = calUtils.deriveOfflineSessionScheduleWindow("2026-03-05T22:00:00", "2026-03-06T01:00:00");
    ok("F5 a session crossing midnight is clamped to the start date, never split", Boolean(crossesMidnight) && crossesMidnight.date === "2026-03-05", crossesMidnight);
    eq("F5b clamped end is CALENDAR_HOUR_END (23:00)", crossesMidnight?.endTime, "23:00");
    eq("F5c clamped start is unchanged (22:00)", crossesMidnight?.startTime, "22:00");
}

// ── G. calendar-storage.ts preserves offline_session items on regeneration ──
{
    const OWNER = { ownerType: "character", ownerId: CHAR_ID };
    const weekStart = "2026-03-02"; // a Monday
    calStorage.replaceCalendarWeekItems(OWNER.ownerType, OWNER.ownerId, weekStart, [
        { id: "i_manual", date: "2026-03-03", weekday: "Tuesday", startTime: "09:00", endTime: "10:00", location: "", title: "Manual item", colorKey: "blue", source: "manual", createdAt: "x", updatedAt: "x" },
        { id: "i_generated", date: "2026-03-03", weekday: "Tuesday", startTime: "11:00", endTime: "12:00", location: "", title: "Generated item", colorKey: "blue", source: "generated", createdAt: "x", updatedAt: "x" },
        { id: "i_offline", date: "2026-03-03", weekday: "Tuesday", startTime: "14:00", endTime: "15:00", location: "", title: "Offline visit", colorKey: "blue", source: "offline_session", createdAt: "x", updatedAt: "x" },
    ]);

    const removed = calStorage.clearGeneratedWeekItems(OWNER.ownerType, OWNER.ownerId, weekStart);
    eq("G1 clearGeneratedWeekItems removes only the pure-generated item", removed.length === 1 && removed[0].id === "i_generated", true, removed);
    const afterClear = calStorage.loadCalendarWeekPlan(OWNER.ownerType, OWNER.ownerId, weekStart);
    ok("G1b manual item survives the clear", afterClear?.items.some(i => i.id === "i_manual"));
    ok("G1c offline_session item survives the clear too", afterClear?.items.some(i => i.id === "i_offline"), afterClear?.items);

    const cloned = calStorage.cloneWeekPlanWithManualEdits(OWNER.ownerType, OWNER.ownerId, weekStart, [
        { id: "i_fresh_gen", date: "2026-03-03", weekday: "Tuesday", startTime: "16:00", endTime: "17:00", location: "", title: "Fresh AI item", colorKey: "blue", source: "generated", createdAt: "x", updatedAt: "x" },
    ]);
    ok("G2 cloneWeekPlanWithManualEdits keeps the manual item", cloned.items.some(i => i.id === "i_manual"), cloned.items);
    ok("G2b cloneWeekPlanWithManualEdits also re-attaches the offline_session item", cloned.items.some(i => i.id === "i_offline"), cloned.items);
    ok("G2c the fresh generated item is present", cloned.items.some(i => i.id === "i_fresh_gen"), cloned.items);
}

// ── H. memory-sharing.ts isBorrowableTimelineEntry widened ──────────────────
{
    eq("H1 chat_offline_session is borrowable", memSharing.isBorrowableTimelineEntry({ sourceApp: "chat", sourceDetail: "chat_offline_session" }), true);
    eq("H2 chat_offline is still borrowable (unchanged)", memSharing.isBorrowableTimelineEntry({ sourceApp: "chat", sourceDetail: "chat_offline" }), true);
    eq("H3 chat/direct is still NOT borrowable (private chat stays private)", memSharing.isBorrowableTimelineEntry({ sourceApp: "chat", sourceDetail: "direct" }), false);
    eq("H4 chat/group is still NOT borrowable", memSharing.isBorrowableTimelineEntry({ sourceApp: "chat", sourceDetail: "group" }), false);
}

// ── I. short-term-assembler.ts wiring (source-level) ─────────────────────────
{
    const src = fs.readFileSync(path.join(root, "lib/short-term-assembler.ts"), "utf8");
    ok("I1 loadChatOfflineSessionProjectionEntries is imported", src.includes("loadChatOfflineSessionProjectionEntries"));
    ok("I2 sourceDetail union includes chat_offline_session", src.includes('"chat_offline_session"'));
    ok("I3 isChatOfflineEntry recognizes the new detail value",
        src.includes('entry.sourceDetail === "chat_offline" || entry.sourceDetail === "chat_offline_session"'));
    ok("I4 the new entries are pushed with sourceApp chat / sourceDetail chat_offline_session",
        /sourceApp:\s*"chat",\s*\n\s*sourceDetail:\s*"chat_offline_session"/.test(src));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
