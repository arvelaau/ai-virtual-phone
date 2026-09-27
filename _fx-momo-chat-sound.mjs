// Fixture for the momo.float.phone sync, Chat Sound. Drives the real resolveChatSoundConfig
// (lib/chat-storage.ts) and shouldPlayNewMessageSound/markBurstPlayed (lib/chat-sound.ts,
// exported for this) via jiti.
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
const chatSound = await jiti.import("./lib/chat-sound.ts");

// ── A. resolveChatSoundConfig: per-field precedence (session field > global) ──
{
    chatStorage.saveChatAppSettings({
        globalChatSounds: { newMessage: { enabled: true, sourceType: "url", value: "https://x/global.mp3", muteActiveChat: true } },
    });

    // No session override at all: pure global.
    const globalOnly = chatStorage.resolveChatSoundConfig("newMessage", { sounds: undefined });
    check("A1 no session override: config is exactly the global one", globalOnly.value === "https://x/global.mp3" && globalOnly.muteActiveChat === true);

    // Session explicitly sets `enabled: false` (turned off for this character) but no audio of
    // its own: the explicit `enabled` field wins, `value`/`muteActiveChat` still inherit from global.
    const explicitOff = chatStorage.resolveChatSoundConfig("newMessage", { sounds: { newMessage: { enabled: false } } });
    check("A2 explicit enabled:false wins over global's enabled:true", explicitOff.enabled === false);
    check("A3 un-set fields (value) still inherit from global even when enabled is overridden", explicitOff.value === "https://x/global.mp3");

    // Session sets its own audio: value/sourceType override, muteActiveChat (unset on session) still inherits.
    const ownAudio = chatStorage.resolveChatSoundConfig("newMessage", { sounds: { newMessage: { enabled: true, sourceType: "file", value: "asset123" } } });
    check("A4 session's own value overrides global's", ownAudio.value === "asset123" && ownAudio.sourceType === "file");
    check("A5 muteActiveChat not set on session still inherits from global", ownAudio.muteActiveChat === true);

    // A key explicitly set to `undefined` on the session (e.g. after "clear audio") must NOT
    // clobber the global value underneath it.
    const clearedKey = chatStorage.resolveChatSoundConfig("newMessage", { sounds: { newMessage: { enabled: true, value: undefined } } });
    check("A6 an explicit `undefined` field does not overwrite the inherited global value", clearedKey.value === "https://x/global.mp3");
}

// ── B. shouldPlayNewMessageSound: the filtering rules, including the bilingual call check ──
{
    const baseMsg = (overrides) => ({
        id: `m${Math.random()}`, sessionId: "s1", role: "assistant", content: "hey there",
        status: "sent", createdAt: new Date().toISOString(), ...overrides,
    });

    check("B1 an ordinary text message plays", chatSound.shouldPlayNewMessageSound(baseMsg({}), false, false));
    check("B2 a silent-media-type message (tool_result) never plays", !chatSound.shouldPlayNewMessageSound(baseMsg({ mediaType: "tool_result" }), false, false));
    check("B3 a silent-origin message (reading_discuss) never plays", !chatSound.shouldPlayNewMessageSound(baseMsg({ origin: "reading_discuss" }), false, false));
    check("B4 an empty content + no mediaType bubble never plays", !chatSound.shouldPlayNewMessageSound(baseMsg({ content: "" }), false, false));

    // The bilingual call-narration check -- the whole reason isCallSystemContent (not a
    // hand-written Chinese-only regex) had to be used here.
    check("B5 legacy Chinese call narration is recognized and suppressed", !chatSound.shouldPlayNewMessageSound(baseMsg({ content: "[我向对方发起了语音通话]" }), false, false));
    check("B6 English call narration is ALSO recognized and suppressed", !chatSound.shouldPlayNewMessageSound(baseMsg({ content: "[I started a voice call with them]" }), false, false));

    // Burst dedupe: first message of a burst plays, second within the window does not.
    const burstMsg1 = baseMsg({ senderCharacterId: "charX" });
    check("B7 first message of a burst plays", chatSound.shouldPlayNewMessageSound(burstMsg1, false, true));
    chatSound.markBurstPlayed(burstMsg1);
    const burstMsg2 = baseMsg({ senderCharacterId: "charX" });
    check("B8 a second message from the same character within the burst window does not replay", !chatSound.shouldPlayNewMessageSound(burstMsg2, false, true));

    // Different character -> not deduped against charX's burst.
    const otherCharMsg = baseMsg({ senderCharacterId: "charY" });
    check("B9 a different character's message is unaffected by another character's burst window", chatSound.shouldPlayNewMessageSound(otherCharMsg, false, true));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
