// The mascot's on-device feature-knowledge base.
// Stored in its own database, separate from chat history, so clearing the mascot's
// conversation never wipes its knowledge of what the app can do. Built-in entries
// auto-refresh by revision after a code update; if IndexedDB is unavailable for any
// reason, the same built-in knowledge is used directly instead.
//
// Content here is specific to THIS fork, not a translation of any upstream project's
// equivalent list -- navigation paths, feature names and even which features exist at
// all have diverged significantly. Verify against the actual UI before adding an entry
// here, and remove an entry the moment the feature it describes changes or is removed.

const MASCOT_KNOWLEDGE_DB_NAME = "AiPhoneMascotKnowledgeDB";
const MASCOT_KNOWLEDGE_DB_VERSION = 1;
const MASCOT_KNOWLEDGE_STORE = "knowledge";
const OWNER_FEATURES_KEY = "owner-custom-features";

export type MascotFeatureKnowledgeEntry = {
    id: string;
    title: string;
    location: string;
    facts: string[];
};

type MascotFeatureKnowledgeRecord = {
    key: string;
    revision: string;
    updatedAt: string;
    entries: MascotFeatureKnowledgeEntry[];
};

const OWNER_FEATURES: MascotFeatureKnowledgeRecord = {
    key: OWNER_FEATURES_KEY,
    revision: "2026-09-30.1",
    updatedAt: "2026-09-30T00:00:00.000Z",
    entries: [
        {
            id: "theme-presets",
            title: "Theme Presets",
            location: "Appearance → Theme Presets",
            facts: [
                "The current theme can be saved as a named preset, switched to later, and deleted; saving under an existing name (case-insensitive) updates that preset instead of creating a duplicate.",
                "A preset captures the theme color, wallpaper, icons, desktop layout, widgets, dock and desktop folders together; the wallpaper library itself stays shared across every preset rather than being duplicated into each one.",
                "In this fork the full Appearance app is currently only reachable by asking the mascot to open it -- there is no standalone home-screen icon for it. The quick \"Customize\" sheet (opened by long-pressing the home screen) only covers icon style, widgets and effects, not the full Appearance app or Theme Presets.",
            ],
        },
        {
            id: "api-bindings",
            title: "Global and per-app config bindings",
            location: "Settings → Config Bindings",
            facts: [
                "Resolution order is fixed: a character's own binding beats an app-level binding, which beats the global default.",
                "An app's own binding detail only configures its text and image-generation bindings; voice is not shown there and still comes from the character's or the global config.",
            ],
        },
        {
            id: "image-generation",
            title: "Image-generation API presets and per-character identity lock",
            location: "Settings → Image Generation API",
            facts: [
                "OpenAI-compatible configs can be saved, switched between and deleted as presets.",
                "Each character can separately have an appearance/identity prompt and a reference image with a movable face-selection box.",
                "The reference image can be turned off without deleting it; \"don't use the reference image for a non-selfie photo\" is on by default. NovelAI reads the identity prompt but never uses the reference image.",
            ],
        },
        {
            id: "checkphone-batch",
            title: "Check Phone batch generation and new-content badges",
            location: "Check Phone → top-right batch-generate button",
            facts: [
                "1 to 4 apps can be selected at once; this makes exactly one text-API call and writes the result into each selected app separately.",
                "An app that received new content this round shows a red dot on its icon, cleared once the user opens that app.",
            ],
        },
        {
            id: "chat-record-transfer",
            title: "Per-session chat record export/import",
            location: "1:1 chat → Chat Info (top-right) → Export Chat Records / Import Chat Records",
            facts: [
                "Exports the current direct-chat session (messages plus any local media they reference, embedded in the file) and can re-import a compatible file back into a session.",
                "This is a single-session transfer, distinct from the full-app backup in Settings → Data Management.",
                "Importing into the same session it was exported from is safe to repeat -- messages already present are skipped rather than duplicated. Importing into a different session keeps the messages but assigns them fresh ids so they never collide with that session's own history.",
            ],
        },
        {
            id: "profile-avatar",
            title: "User profile avatar",
            location: "Chat → Me tab → tap the profile avatar, or Settings → User Identity",
            facts: [
                "Tapping the avatar on the Me tab is a quick way to change the user's profile avatar from the photo library; the User Identity settings page can also change it.",
                "The Me-tab avatar, the avatar shown above the chat session list, and the user's Moments avatar are all the same profile picture and update together.",
                "The avatar shown inside chat bubbles is a separate system (a per-session override, or a global chat avatar) and never writes back to the profile avatar.",
            ],
        },
        {
            id: "chat-avatars",
            title: "Per-session avatars and a character changing its own avatar",
            location: "1:1 chat → Chat Info (top-right) → avatar settings",
            facts: [
                "\"My avatar\" and the character's avatar can each be changed independently for just that one session; changing \"my avatar\" there never touches the profile avatar, the session-list avatar, or any other chat.",
                "\"Notify the character when I change my avatar\" is on by default; when on, only a short system event (\"the user updated their avatar\") is written into the character's context -- when off, nothing is sent.",
                "The user can also send a real photo in chat and ask (or hint) that the character adopt it as their own avatar; the character decides in-character whether to accept, and accepting automatically sets that image as the character's avatar.",
                "This only works with a real image file -- a text-described \"photo\" bubble with no actual pixels behind it cannot become an avatar.",
            ],
        },
        {
            id: "global-chat-info",
            title: "Global Chat settings",
            location: "Chat → Me tab → Global Chat Info",
            facts: [
                "The user avatar, chat background, chat-room CSS and the recent-image count sent to the model apply to both 1:1 and group chats; the global status-bar/state-panel setting only applies to 1:1 chats.",
                "Precedence is: a session's own setting beats the global one; CSS additionally follows session CSS > global chat-room CSS > desktop appearance CSS.",
                "\"Reset all characters to default\" under the chat-room CSS section clears every session's own CSS in one action (after a confirmation showing the count) and falls everything back to the global chat-room CSS; any chat room currently open updates immediately.",
            ],
        },
        {
            id: "chat-sounds",
            title: "Chat notification sounds",
            location: "Chat → Me tab → Global Chat Info → sounds; 1:1 chat → Chat Info → Character-Specific Sounds",
            facts: [
                "There are 5 kinds: new message, send message, incoming call, outgoing call, and hangup. Turning one on reveals its audio-source setting -- upload a local file (kept on-device, under 8MB) or paste a URL -- with preview and clear buttons.",
                "The new-message sound has a \"Test Popup\" button: it simulates a real incoming message, showing the desktop notification banner and playing the sound.",
                "1:1 Chat Info has \"Character-Specific Sounds\": each kind can be set to follow-global, custom, or off for that one character; custom beats global. If custom is chosen but no audio is set, it falls back to the global audio for that kind.",
                "The new-message sound has two sub-toggles: don't play while that chat is open and on screen, and only play once per 10 seconds for a burst of messages from the same character. An unset sub-toggle on a character's custom setting inherits the global value.",
                "Sounds apply to both 1:1 and group chats (character-specific overrides are 1:1-only for now). System messages from a call (e.g. \"started a voice call\") never trigger the new-message sound.",
            ],
        },
        {
            id: "chat-unread",
            title: "Chat unread badges",
            location: "Chat app → session list",
            facts: [
                "A new message from a character increments that session's unread count and shows a red dot when the session isn't the one currently open; opening the session marks it read.",
                "The unread badge only appears in the Chat app's own session list -- the desktop Chat icon deliberately does not show one; this was a specific design choice and should not be suggested as something to add.",
            ],
        },
    ],
};

function openKnowledgeDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(MASCOT_KNOWLEDGE_DB_NAME, MASCOT_KNOWLEDGE_DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(MASCOT_KNOWLEDGE_STORE)) {
                request.result.createObjectStore(MASCOT_KNOWLEDGE_STORE, { keyPath: "key" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open the mascot feature-knowledge database"));
    });
}

async function readKnowledgeRecord(db: IDBDatabase): Promise<MascotFeatureKnowledgeRecord | null> {
    return new Promise(resolve => {
        const tx = db.transaction(MASCOT_KNOWLEDGE_STORE, "readonly");
        const request = tx.objectStore(MASCOT_KNOWLEDGE_STORE).get(OWNER_FEATURES_KEY);
        request.onsuccess = () => resolve((request.result as MascotFeatureKnowledgeRecord | undefined) || null);
        request.onerror = () => resolve(null);
    });
}

async function writeKnowledgeRecord(db: IDBDatabase, record: MascotFeatureKnowledgeRecord): Promise<void> {
    return new Promise(resolve => {
        const tx = db.transaction(MASCOT_KNOWLEDGE_STORE, "readwrite");
        tx.objectStore(MASCOT_KNOWLEDGE_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

function formatFeatureKnowledge(record: MascotFeatureKnowledgeRecord): string {
    const lines = record.entries.flatMap(entry => [
        `[${entry.title}] Location: ${entry.location}`,
        ...entry.facts.map(fact => `- ${fact}`),
    ]);
    return [
        "===== Current build's feature knowledge (on-device database) =====",
        "These are features this branch has actually implemented. When the user asks where something is, how to use it, or whether it exists, defer to this list over your own assumptions.",
        "Knowing a feature exists does not mean you can operate it directly: only act on the user's behalf when the current tool list actually offers that action; otherwise describe where it is and let the user do it themselves.",
        ...lines,
    ].join("\n");
}

export async function loadMascotFeatureKnowledgePrompt(): Promise<string> {
    if (typeof indexedDB === "undefined") return formatFeatureKnowledge(OWNER_FEATURES);
    try {
        const db = await openKnowledgeDb();
        let record = await readKnowledgeRecord(db);
        if (!record || record.revision !== OWNER_FEATURES.revision) {
            record = OWNER_FEATURES;
            await writeKnowledgeRecord(db, record);
        }
        db.close();
        return formatFeatureKnowledge(record);
    } catch {
        return formatFeatureKnowledge(OWNER_FEATURES);
    }
}
