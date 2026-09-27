// Fixture for the momo.float.phone sync, per-session vs global chat overrides
// (vision-image-count, user avatar, chat background). Drives the REAL resolver
// functions via jiti (dexie aliased to the shared in-memory stub).
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;

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

// ── A. resolveVisionImagePromptLimit: global < session-override precedence ──
{
    // No global set, no session override: falls back to the session's own stored value / default.
    chatStorage.saveChatAppSettings({});
    const noOverride = { visionImagePromptLimit: 3, isGroup: false };
    check("A1 no global, no override flag: uses the session's own stored value", chatStorage.resolveVisionImagePromptLimit(noOverride) === 3);

    // Global is set, session does NOT explicitly override (usesGlobal !== false): global wins.
    chatStorage.saveChatAppSettings({ globalVisionImagePromptLimit: 5 });
    const followsGlobal = { visionImagePromptLimit: 3, isGroup: false };
    check("A2 global set, no explicit override: global wins over the stale per-session value", chatStorage.resolveVisionImagePromptLimit(followsGlobal) === 5);

    // Session explicitly overrides (usesGlobal === false): the session's own value wins even
    // though a global is set.
    const explicitOverride = { visionImagePromptLimit: 2, visionImagePromptLimitUsesGlobal: false, isGroup: false };
    check("A3 explicit per-session override wins over a set global", chatStorage.resolveVisionImagePromptLimit(explicitOverride) === 2);

    // Null/undefined session: does not throw, returns the built-in default.
    check("A4 null session does not throw", typeof chatStorage.resolveVisionImagePromptLimit(null) === "number");
}

// ── B. resolveChatUserAvatar: session override > global > identity fallback ──
{
    chatStorage.saveChatAppSettings({});
    check("B1 no override, no global: falls back to the identity avatar", chatStorage.resolveChatUserAvatar({ isGroup: false }, "identity.png") === "identity.png");
    check("B2 nothing at all: empty string, not null/undefined", chatStorage.resolveChatUserAvatar({ isGroup: false }, null) === "");

    chatStorage.saveChatAppSettings({ globalChatUserAvatar: "global.png" });
    check("B3 global set, no per-session override: global wins over the identity avatar", chatStorage.resolveChatUserAvatar({ isGroup: false }, "identity.png") === "global.png");

    check("B4 per-session override wins over both global and identity", chatStorage.resolveChatUserAvatar({ userAvatarOverride: "mine.png", isGroup: false }, "identity.png") === "mine.png");
}

// ── C. resolveChatBackgroundImage: session > global ──
{
    chatStorage.saveChatAppSettings({});
    check("C1 no session background, no global: empty string", chatStorage.resolveChatBackgroundImage({ isGroup: false }) === "");

    chatStorage.saveChatAppSettings({ globalChatBackgroundImage: "global-bg.png" });
    check("C2 global set, no session background: global wins", chatStorage.resolveChatBackgroundImage({ isGroup: false }) === "global-bg.png");

    check("C3 session background wins over a set global", chatStorage.resolveChatBackgroundImage({ backgroundImage: "session-bg.png", isGroup: false }) === "session-bg.png");
}

// ── D. Real pushChatMessage round trip: resolveVisionImagePromptLimit reflects a live session change ──
{
    chatStorage.saveChatSessions([{ id: "vg1", contactId: "charV", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, visionImagePromptLimit: 1 }]);
    chatStorage.saveChatAppSettings({ globalVisionImagePromptLimit: 4 });
    let session = chatStorage.loadChatSessions().find(s => s.id === "vg1");
    check("D1 fresh session with no override flag follows the global (4), not its stored 1", chatStorage.resolveVisionImagePromptLimit(session) === 4);

    // Now the session explicitly overrides.
    const sessions = chatStorage.loadChatSessions();
    const idx = sessions.findIndex(s => s.id === "vg1");
    sessions[idx] = { ...sessions[idx], visionImagePromptLimit: 7, visionImagePromptLimitUsesGlobal: false };
    chatStorage.saveChatSessions(sessions);
    session = chatStorage.loadChatSessions().find(s => s.id === "vg1");
    check("D2 after an explicit override, the session's own value (7) wins over the global (4)", chatStorage.resolveVisionImagePromptLimit(session) === 7);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
