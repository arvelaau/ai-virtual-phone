// Fixture for the momo.float.phone sync, blacklist-simulation batch.
// Drives the REAL functions via jiti (dexie aliased to the shared in-memory stub so
// chat-storage.ts's Dexie-backed pushChatMessage/loadChatMessages run unmodified).
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
const chatEngine = await jiti.import("./lib/chat-engine.ts");
const preset = await jiti.import("./lib/builtin-preset.ts");

const CJK = /[一-鿿]/;

// ── A. The preset entry: exists, tagged correctly, English, version bumped ──
{
    const built = preset.createBuiltinPreset();
    const entry = built.prompts.find(p => p.identifier === "chat_blacklist");
    check("A1 chat_blacklist entry exists", Boolean(entry));
    check("A2 tags match chat_output_format's surface (co-injected together)",
        JSON.stringify(entry?.tags) === JSON.stringify(["chat", "text"]));
    check("A3 entry content has zero CJK", entry ? !CJK.test(entry.content) : false);
    const toggle = built.prompt_order.find(p => p.identifier === "chat_blacklist");
    check("A4 registered + enabled in prompt_order", toggle?.enabled === true);
    check("A5 prompt_order places it right after chat_output_format",
        built.prompt_order.findIndex(p => p.identifier === "chat_blacklist")
        === built.prompt_order.findIndex(p => p.identifier === "chat_output_format") + 1);
    check("A6 BUILTIN_PRESET_VERSION bumped to at least 286 (the blacklist entry's own bump)", preset.BUILTIN_PRESET_VERSION >= 286);
}

// ── B. appendEmptyGenerateGuardMessage: blacklist-event exemption ──
{
    const config = { preventEmptyGenerateRambling: true };
    const realUserMsg = { id: "u0", sessionId: "s1", role: "user", content: "hi", status: "sent", createdAt: new Date(Date.now() - 60000).toISOString() };

    // Normal case: history ends on an assistant message with no user reply after it in
    // `messages` -> guard SHOULD append the continuation prompt.
    {
        const history = [realUserMsg, { id: "a0", sessionId: "s1", role: "assistant", content: "hey", status: "sent", createdAt: new Date().toISOString() }];
        const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }];
        chatEngine.appendEmptyGenerateGuardMessage(messages, config, history);
        check("B1 normal case: continuation guard IS appended", messages.length === 3 && messages[2].role === "user");
    }

    // Blacklist-event case: an assistant already replied, and afterward a block event landed
    // in history -> guard must NOT fire (there IS an assistant turn with nothing but the
    // system event after it, which is exactly the shape the guard would otherwise flag).
    {
        const priorAssistant = { id: "a2", sessionId: "s1", role: "assistant", content: "hey", status: "sent", createdAt: new Date(Date.now() - 30000).toISOString() };
        const blockEvent = { id: "sys0", sessionId: "s1", role: "system", content: "blocked", status: "sent", createdAt: new Date().toISOString(), mediaData: { blacklistEvent: "block" } };
        const history = [realUserMsg, priorAssistant, blockEvent];
        const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }, { role: "system", content: "blocked" }];
        chatEngine.appendEmptyGenerateGuardMessage(messages, config, history);
        check("B2 blacklist-block-terminated history: guard does NOT append", messages.length === 3);
    }

    // Unblock event: same exemption applies.
    {
        const priorAssistant = { id: "a3", sessionId: "s1", role: "assistant", content: "hey", status: "sent", createdAt: new Date(Date.now() - 30000).toISOString() };
        const unblockEvent = { id: "sys1", sessionId: "s1", role: "system", content: "unblocked", status: "sent", createdAt: new Date().toISOString(), mediaData: { blacklistEvent: "unblock" } };
        const history = [realUserMsg, priorAssistant, unblockEvent];
        const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }, { role: "system", content: "unblocked" }];
        chatEngine.appendEmptyGenerateGuardMessage(messages, config, history);
        check("B3 blacklist-unblock-terminated history: guard does NOT append", messages.length === 3);
    }

    // Negative control: an ordinary system message after the assistant's turn (not a
    // blacklist event) must NOT be exempt -- the guard should still fire.
    {
        const plainSysMsg = { id: "sys2", sessionId: "s1", role: "system", content: "just a note", status: "sent", createdAt: new Date().toISOString() };
        const history = [realUserMsg, { id: "a1", sessionId: "s1", role: "assistant", content: "hey", status: "sent", createdAt: new Date().toISOString() }, plainSysMsg];
        const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }, { role: "system", content: "just a note" }];
        chatEngine.appendEmptyGenerateGuardMessage(messages, config, history);
        check("B4 ordinary system message (no blacklistEvent) is NOT exempt -> guard still appends", messages.length === 4);
    }
}

// ── C. Real storage round trip: pushChatMessage marks assistant replies rejected while blacklisted ──
{
    chatStorage.saveChatSessions([{ id: "bl1", contactId: "charB", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false }]);

    // Not blacklisted yet: assistant message must be sent normally.
    const before = chatStorage.pushChatMessage({ sessionId: "bl1", role: "assistant", content: "hello!" });
    check("C1 before blacklisting: assistant message is NOT rejected", before.status !== "rejected");

    // Blacklist the session (mirrors what handleToggleBlacklist's updateSession call does).
    const sessions = chatStorage.loadChatSessions();
    const idx = sessions.findIndex(s => s.id === "bl1");
    sessions[idx] = { ...sessions[idx], isBlacklisted: true };
    chatStorage.saveChatSessions(sessions);

    const afterBlock = chatStorage.pushChatMessage({ sessionId: "bl1", role: "assistant", content: "did you see my message?" });
    check("C2 after blacklisting: assistant message IS marked rejected", afterBlock.status === "rejected");

    // The user's own messages are never marked, even while blacklisted.
    const userMsg = chatStorage.pushChatMessage({ sessionId: "bl1", role: "user", content: "hello?" });
    check("C3 the user's own message is never marked rejected", userMsg.status !== "rejected");

    // Unblock: subsequent assistant messages go back to normal.
    sessions[idx] = { ...sessions[idx], isBlacklisted: false };
    chatStorage.saveChatSessions(sessions);
    const afterUnblock = chatStorage.pushChatMessage({ sessionId: "bl1", role: "assistant", content: "I'm back!" });
    check("C4 after unblocking: assistant message is normal again", afterUnblock.status !== "rejected");

    // Group chats are exempt entirely (feature is direct-chat only).
    chatStorage.saveChatSessions([...chatStorage.loadChatSessions(), { id: "blg1", contactId: "g1", isGroup: true, isBlacklisted: true, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, participantIds: ["charB"] }]);
    const groupMsg = chatStorage.pushChatMessage({ sessionId: "blg1", role: "assistant", content: "group hi" });
    check("C5 group session with isBlacklisted set is exempt (feature is direct-chat only)", groupMsg.status !== "rejected");
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
