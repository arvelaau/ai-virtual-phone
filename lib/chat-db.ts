// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // ── Anti-wipe guard ──────────────────────────────────────
        // The migration flag lives in volatile localStorage; the real data lives in
        // the far more durable IndexedDB. The flag can disappear independently of
        // the data (clearing the "cache" data module, privacy tooling, partial
        // eviction). No failure on this path may be allowed to fall through into
        // the "fresh install" migration branch below -- that branch treats an
        // empty localStorage read as real data and deletes the old keys, so the
        // very first full save after hydration (dbReplaceSessions = clear + put)
        // would wipe the real sessions/contacts tables in IndexedDB. That is the
        // "the phone reset to its initial state" incident.
        let indexedDbHasData = false;
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            indexedDbHasData = existingCount > 0;
        } catch (err) {
            // A failed probe (locked/quota/transient error) is not the same as an
            // empty database: fall back to a retrying direct IndexedDB read, and if
            // that also fails, throw and stay unhydrated -- every write path then
            // degrades to insert-only (see chat-storage.ts). Better to render empty
            // than to overwrite the real database with empty data.
            console.warn("[ChatDB] Pre-migration IndexedDB check failed; recovering directly:", err);
            const recovered = await loadFromIndexedDbWithRetries();
            if (recovered) {
                markMigrated();
                return recovered;
            }
            throw new Error(`[ChatDB] Could not read the local chat database (${
                err instanceof Error ? err.message : String(err)
            }); staying unhydrated to avoid overwriting real data`);
        }

        if (indexedDbHasData) {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            // A failed flag write (localStorage quota full) is only a performance
            // hit -- it must never also discard the data just read from IndexedDB.
            markMigrated();
            console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return { messages: fallbackMessages, sessions: fallbackSessions, contacts: fallbackContacts };
        }
    }

    // Already migrated: load from IndexedDB (with retries)
    const loaded = await loadFromIndexedDbWithRetries();
    if (!loaded) {
        throw new Error("[ChatDB] Failed to load after 3 attempts");
    }
    return loaded;
}

/** Writes the migration flag; a failure (e.g. localStorage quota full) is only a performance hit, never a data incident. */
function markMigrated(): void {
    try {
        window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
    } catch (err) {
        console.warn("[ChatDB] Failed to persist migration flag:", err);
    }
}

/** Reads everything from IndexedDB, retrying up to 3 times. Returns null on total failure (the caller decides whether to throw). */
async function loadFromIndexedDbWithRetries(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
} | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    return null;
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    chatDb.messages.put(msg).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    chatDb.messages.bulkPut(msgs).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

// Awaitable, error-propagating, chunked bulk write. A large batch write like a
// chat-record import must be able to observe the real result (a quota failure or
// write error has to reach and inform the user), and chunking avoids one giant
// transaction freezing the main thread -- the event loop gets a natural yield
// between chunks, keeping the page responsive.
const DB_BULK_PUT_CHUNK = 2000;
export async function dbBulkPutMessages(msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    for (let start = 0; start < msgs.length; start += DB_BULK_PUT_CHUNK) {
        await chatDb.messages.bulkPut(msgs.slice(start, start + DB_BULK_PUT_CHUNK));
    }
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).catch(err => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    chatDb.sessions.bulkPut(sessions).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    }).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
}

export function dbDeleteSession(id: string): void {
    chatDb.sessions.delete(id).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}
