import { loadCharacters } from "./character-storage";
import { loadChatMessages, loadChatSessions } from "./chat-storage";
import type { ChatMessage, ChatSession } from "./chat-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// Gift provenance: a queryable record of who gave what to whom, and when.
//
// The raw data already exists — `sendShoppingGiftMessage` (chat-room.tsx) writes ten
// provenance fields into `mediaData`, and AI-sent gifts arrive as `mediaType === "gift"`
// bubbles. What was missing is an index: `loadSentShoppingGiftIds` (shopping-gift-utils)
// walks every session x every message and then keeps only a Set of ids, discarding the
// recipient, the date and the price.
//
// This module is deliberately ADDITIVE. It does not replace that scan, because the scan is
// what stops an already-sent gift being offered for sending a second time — swapping it for
// an index read would make every historical gift re-giftable the moment the index was empty.
// Messages stay the source of truth for "was this sent"; this index is the source of truth
// for "what is our gift history".
//
// Append-only with respect to scanning: a gift that was given stays given even if the chat
// it was sent in is later deleted. Syncing never drops a record just because its message is
// gone, which is also what makes the history survive a cleared conversation.

const GIFT_PROVENANCE_KEY = "ai_phone_gift_provenance_v1";
const MAX_RECORDS = 800;

registerKvMigration(GIFT_PROVENANCE_KEY);

export type GiftDirection = "user_to_character" | "character_to_user";

export type GiftProvenanceRecord = {
    /** `shoppingGiftId` for shopping-order gifts, `msg:<messageId>` for AI-sent ones. */
    id: string;
    direction: GiftDirection;
    productName: string;
    /** ISO timestamp the gift was sent. */
    sentAt: string;
    messageId: string;
    sessionId: string;
    /** The character on the other side of the exchange. */
    counterpartId: string;
    counterpartName: string;
    isGroup: boolean;
    // ── Shopping-order origin (absent on AI-sent gifts) ──
    shoppingGiftId?: string;
    orderId?: string;
    itemId?: string;
    merchantLabel?: string;
    priceLabel?: string;
    previewIcon?: string;
    /** ISO timestamp the underlying order was delivered. */
    deliveredAt?: string;
    senderName?: string;
};

type GiftProvenanceIndex = {
    version: 1;
    records: GiftProvenanceRecord[];
};

const EMPTY_INDEX: GiftProvenanceIndex = { version: 1, records: [] };

function cleanText(value: unknown, maxLength: number): string {
    // Strips NULs and collapses runs of whitespace, but deliberately keeps the spaces
    // themselves: product names are English, so a blanket whitespace-removal strip would
    // turn "Blue Ceramic Mug" into "BlueCeramicMug". Harmless in Chinese, destructive here.
    return String(value ?? "")
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function isRecord(value: unknown): value is GiftProvenanceRecord {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<GiftProvenanceRecord>;
    return typeof entry.id === "string"
        && typeof entry.sentAt === "string"
        && typeof entry.productName === "string"
        && (entry.direction === "user_to_character" || entry.direction === "character_to_user");
}

function readIndex(): GiftProvenanceIndex {
    if (typeof window === "undefined") return { ...EMPTY_INDEX, records: [] };
    try {
        const raw = kvGet(GIFT_PROVENANCE_KEY);
        if (!raw) return { ...EMPTY_INDEX, records: [] };
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return { ...EMPTY_INDEX, records: [] };
        const records = (parsed as GiftProvenanceIndex).records;
        if (!Array.isArray(records)) return { ...EMPTY_INDEX, records: [] };
        return { version: 1, records: records.filter(isRecord) };
    } catch {
        // A corrupt index is recoverable: the next sync rebuilds it from messages.
        return { ...EMPTY_INDEX, records: [] };
    }
}

function writeIndex(index: GiftProvenanceIndex): void {
    if (typeof window === "undefined") return;
    const compacted = [...index.records]
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
        .slice(-MAX_RECORDS);
    kvSet(GIFT_PROVENANCE_KEY, JSON.stringify({ version: 1, records: compacted }));
}

function buildCharacterNameLookup(): Map<string, string> {
    const lookup = new Map<string, string>();
    try {
        for (const character of loadCharacters()) {
            if (character?.id) lookup.set(character.id, cleanText(character.name, 80));
        }
    } catch {
        // Name resolution is best-effort; an unresolved id still yields a usable record.
    }
    return lookup;
}

/**
 * Turn one `mediaType === "gift"` message into a provenance record.
 *
 * Returns null for anything that is not a gift bubble. Exported so a fixture can drive it
 * without standing up chat storage.
 */
export function buildGiftProvenanceRecord(
    msg: ChatMessage,
    session: Pick<ChatSession, "id" | "contactId" | "isGroup">,
    characterNames?: Map<string, string>,
): GiftProvenanceRecord | null {
    if (msg?.mediaType !== "gift") return null;
    if (msg.role !== "user" && msg.role !== "assistant") return null;

    const data = msg.mediaData ?? {};
    const direction: GiftDirection = msg.role === "user" ? "user_to_character" : "character_to_user";
    const shoppingGiftId = cleanText(data.shoppingGiftId, 200);
    const id = shoppingGiftId || `msg:${msg.id}`;

    // Who is on the other side of this exchange?
    //   user -> character : groups carry an explicit recipient, 1:1 falls back to the contact
    //   character -> user : groups name the sending character, 1:1 falls back to the contact
    let counterpartId = "";
    let counterpartName = "";
    if (direction === "user_to_character") {
        counterpartId = cleanText(data.recipientId, 120) || cleanText(session.contactId, 120);
        counterpartName = cleanText(data.recipientName, 80);
    } else {
        counterpartId = cleanText(msg.senderCharacterId, 120) || cleanText(session.contactId, 120);
        counterpartName = cleanText(msg.senderName, 80);
    }
    if (!counterpartName && counterpartId) {
        counterpartName = characterNames?.get(counterpartId) ?? "";
    }

    const productName = cleanText(data.giftName || data.label, 160);
    const sentAt = cleanText(data.giftSentAt, 40) || cleanText(msg.createdAt, 40) || new Date().toISOString();

    const record: GiftProvenanceRecord = {
        id,
        direction,
        productName,
        sentAt,
        messageId: msg.id,
        sessionId: session.id,
        counterpartId,
        counterpartName,
        isGroup: Boolean(session.isGroup),
    };

    if (shoppingGiftId) record.shoppingGiftId = shoppingGiftId;
    const orderId = cleanText(data.giftOrderId, 200);
    if (orderId) record.orderId = orderId;
    const itemId = cleanText(data.giftItemId, 200);
    if (itemId) record.itemId = itemId;
    const merchantLabel = cleanText(data.giftMerchantLabel, 120);
    if (merchantLabel) record.merchantLabel = merchantLabel;
    const priceLabel = cleanText(data.giftPriceLabel, 80);
    if (priceLabel) record.priceLabel = priceLabel;
    const previewIcon = cleanText(data.giftPreviewIcon, 200);
    if (previewIcon) record.previewIcon = previewIcon;
    const deliveredAt = cleanText(data.giftDeliveredAt, 40);
    if (deliveredAt) record.deliveredAt = deliveredAt;
    const senderName = cleanText(data.senderName, 80);
    if (senderName) record.senderName = senderName;

    return record;
}

/** Merge a scanned record into the existing set, preferring stored fields that the scan lost. */
function mergeRecord(
    existing: GiftProvenanceRecord | undefined,
    incoming: GiftProvenanceRecord,
): GiftProvenanceRecord {
    if (!existing) return incoming;
    return {
        ...existing,
        ...incoming,
        // A previously captured name outlives a deleted character, so never overwrite a
        // real name with an empty one.
        counterpartName: incoming.counterpartName || existing.counterpartName,
        productName: incoming.productName || existing.productName,
    };
}

export type GiftProvenanceSyncResult = {
    scannedMessages: number;
    giftsFound: number;
    added: number;
    updated: number;
};

/**
 * Rebuild the index from chat history. Safe to call repeatedly — it is idempotent and never
 * removes a record whose message has since been deleted.
 */
export function syncGiftProvenanceFromMessages(): GiftProvenanceSyncResult {
    const result: GiftProvenanceSyncResult = { scannedMessages: 0, giftsFound: 0, added: 0, updated: 0 };
    if (typeof window === "undefined") return result;

    const index = readIndex();
    const byId = new Map(index.records.map(record => [record.id, record]));
    const characterNames = buildCharacterNameLookup();

    for (const session of loadChatSessions()) {
        for (const msg of loadChatMessages(session.id)) {
            result.scannedMessages += 1;
            const record = buildGiftProvenanceRecord(msg, session, characterNames);
            if (!record) continue;
            result.giftsFound += 1;
            const existing = byId.get(record.id);
            if (existing) {
                result.updated += 1;
            } else {
                result.added += 1;
            }
            byId.set(record.id, mergeRecord(existing, record));
        }
    }

    writeIndex({ version: 1, records: [...byId.values()] });
    return result;
}

export type GiftHistoryOptions = {
    /** Restrict to gifts exchanged with one character. */
    characterId?: string;
    direction?: GiftDirection;
    /** Exclude group-chat gifts, which are not part of a two-person history. */
    excludeGroup?: boolean;
    limit?: number;
};

/** Gift history, newest first. */
export function loadGiftHistory(options: GiftHistoryOptions = {}): GiftProvenanceRecord[] {
    let records = readIndex().records;

    if (options.characterId) {
        records = records.filter(record => record.counterpartId === options.characterId);
    }
    if (options.direction) {
        records = records.filter(record => record.direction === options.direction);
    }
    if (options.excludeGroup) {
        records = records.filter(record => !record.isGroup);
    }

    records = [...records].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    return typeof options.limit === "number" ? records.slice(0, Math.max(0, options.limit)) : records;
}

export function loadGiftProvenance(id: string): GiftProvenanceRecord | null {
    if (!id) return null;
    return readIndex().records.find(record => record.id === id) ?? null;
}

/** Given/received counts for one character — the headline figure for Couple Space. */
export function countGiftsExchanged(characterId: string): { given: number; received: number } {
    const records = loadGiftHistory({ characterId, excludeGroup: true });
    return {
        given: records.filter(record => record.direction === "user_to_character").length,
        received: records.filter(record => record.direction === "character_to_user").length,
    };
}

/** Test seam: drop the stored index. */
export function clearGiftProvenanceIndex(): void {
    if (typeof window === "undefined") return;
    kvSet(GIFT_PROVENANCE_KEY, JSON.stringify(EMPTY_INDEX));
}
