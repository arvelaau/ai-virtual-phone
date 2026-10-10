// Fixture for the momo.float.phone sync, Global Chat Info settings. Drives the real storage
// layer (lib/chat-storage.ts's globalChatCustomCSS + lib/settings-storage.ts's
// saveUserIdentities/USER_IDENTITIES_UPDATED_EVENT + lib/css-scoper.ts's scopeSessionCSS) via
// jiti. The page component itself is not driven here (it needs a DOM); this proves the storage
// and CSS-priority mechanics it's built on.
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
let lastDispatchedEvent = null;
globalThis.dispatchEvent = (event) => { lastDispatchedEvent = event; return true; };

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
const settingsStorage = await jiti.import("./lib/settings-storage.ts");
const cssScoper = await jiti.import("./lib/css-scoper.ts");

// ── A. globalChatCustomCSS round trip ──
{
    chatStorage.saveChatAppSettings({ globalChatCustomCSS: ".chat-msg-wrapper { color: red; }" });
    const loaded = chatStorage.loadChatAppSettings();
    check("A1 globalChatCustomCSS survives a save/load round trip", loaded.globalChatCustomCSS === ".chat-msg-wrapper { color: red; }");

    chatStorage.saveChatAppSettings({ ...loaded, globalChatCustomCSS: "" });
    check("A2 clearing it back to empty string persists", chatStorage.loadChatAppSettings().globalChatCustomCSS === "");
}

// ── B. CSS priority mechanics: scoping keeps global CSS session-scoped, same as per-session CSS ──
{
    const globalCSS = ".chat-msg-wrapper { background: blue; }";
    const scopedGlobal = cssScoper.scopeSessionCSS(globalCSS, ".session-abc123");
    check("B1 global chat CSS gets the same session-scoping treatment as per-session CSS", scopedGlobal.includes(".session-abc123") && scopedGlobal.includes(".chat-msg-wrapper"));

    // Empty CSS scopes to an empty string (so the settings page's `{globalChatCSS && (...)}` guard
    // correctly renders nothing rather than an empty <style> tag).
    check("B2 empty global CSS scopes to empty string", cssScoper.scopeSessionCSS("", ".session-abc123") === "");
}

// ── C. Profile-avatar change: saveUserIdentities + the update event ──
{
    settingsStorage.saveUserIdentities([{ id: "u1", name: "Me", avatarUrl: "" }]);
    lastDispatchedEvent = null;

    // Mirrors what handleProfileAvatarChange does: load, map the matching identity, save.
    const identities = settingsStorage.loadUserIdentities();
    settingsStorage.saveUserIdentities(identities.map(item => item.id === "u1" ? { ...item, avatarUrl: "data:image/webp;base64,xyz" } : item));

    const updated = settingsStorage.loadUserIdentities().find(i => i.id === "u1");
    check("C1 the matching identity's avatar is updated", updated?.avatarUrl === "data:image/webp;base64,xyz");
    check("C2 saveUserIdentities dispatches USER_IDENTITIES_UPDATED_EVENT so open panels can resync", lastDispatchedEvent?.type === settingsStorage.USER_IDENTITIES_UPDATED_EVENT);
}

// ── D. resetAllSessionCSS's core transform: only sessions with their own CSS are touched ──
{
    chatStorage.saveChatSessions([
        { id: "r1", contactId: "c1", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, customCSS: ".x{color:red}" },
        { id: "r2", contactId: "c2", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, customCSS: "" },
        { id: "r3", contactId: "c3", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false },
    ]);
    const sessions = chatStorage.loadChatSessions();
    const withCSS = sessions.filter(s => (s.customCSS || "").trim());
    check("D1 exactly one session (r1) has its own CSS", withCSS.length === 1 && withCSS[0].id === "r1");

    chatStorage.saveChatSessions(sessions.map(s => (s.customCSS || "").trim() ? { ...s, customCSS: "" } : s));
    const after = chatStorage.loadChatSessions();
    check("D2 r1's CSS is cleared", after.find(s => s.id === "r1")?.customCSS === "");
    check("D3 r2/r3 (which never had CSS) are unaffected", after.find(s => s.id === "r2")?.customCSS === "" && !after.find(s => s.id === "r3")?.customCSS);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
