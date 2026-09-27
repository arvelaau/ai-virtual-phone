// Fixture for the momo.float.phone sync, unread-badge + active-session tracking.
// Drives the REAL functions via jiti (dexie aliased to the shared in-memory stub).
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; results.push({ name, extra }); }
}

const chatStorage = await jiti.import("./lib/chat-storage.ts");

chatStorage.saveChatSessions([
    { id: "u1", contactId: "charU", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false },
]);

// ── A. getActiveChatSessionId defaults to null, and setActiveChatSessionId updates it ──
{
    check("A1 no active session initially", chatStorage.getActiveChatSessionId() === null);
    chatStorage.setActiveChatSessionId("u1");
    check("A2 active session set", chatStorage.getActiveChatSessionId() === "u1");
}

// ── B. pushChatMessage increments unreadCount for an assistant reply while the session
//       is NOT the active one, and does not while it IS active ──
{
    chatStorage.setActiveChatSessionId(null);
    chatStorage.pushChatMessage({ sessionId: "u1", role: "assistant", content: "hi there" });
    let session = chatStorage.loadChatSessions().find(s => s.id === "u1");
    check("B1 unreadCount incremented when no session is active", session.unreadCount === 1);

    chatStorage.pushChatMessage({ sessionId: "u1", role: "assistant", content: "still here?" });
    session = chatStorage.loadChatSessions().find(s => s.id === "u1");
    check("B2 unreadCount increments again on a second message", session.unreadCount === 2);

    // Now make u1 the active session -- further assistant replies must NOT increment.
    chatStorage.setActiveChatSessionId("u1");
    chatStorage.pushChatMessage({ sessionId: "u1", role: "assistant", content: "while you're looking" });
    session = chatStorage.loadChatSessions().find(s => s.id === "u1");
    check("B3 unreadCount does NOT increment while the session is active", session.unreadCount === 2);

    // The user's own messages never bump unreadCount either way.
    chatStorage.setActiveChatSessionId(null);
    chatStorage.pushChatMessage({ sessionId: "u1", role: "user", content: "my own message" });
    session = chatStorage.loadChatSessions().find(s => s.id === "u1");
    check("B4 the user's own message never bumps unreadCount", session.unreadCount === 2);
}

// ── C. markChatSessionRead resets to 0 and is a no-op when already 0 ──
{
    chatStorage.markChatSessionRead("u1");
    let session = chatStorage.loadChatSessions().find(s => s.id === "u1");
    check("C1 markChatSessionRead resets unreadCount to 0", session.unreadCount === 0);

    // No-op path: calling it again on an already-zero session must not throw and must
    // leave it at 0 (this also exercises the early-return branch).
    chatStorage.markChatSessionRead("u1");
    session = chatStorage.loadChatSessions().find(s => s.id === "u1");
    check("C2 calling markChatSessionRead again on a zero session is a harmless no-op", session.unreadCount === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
