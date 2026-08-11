import { kvGet, kvKeysWithPrefix, kvSet, registerDynamicPrefix } from "./kv-db";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import type { Anniversary, ReflectionEntry, WishlistItem } from "./couple-space-types";

// Episodic half of the Couple Space memory wiring.
//
// Two layers are needed because the data is two shapes. Standing state -- the anniversary
// dates themselves, the wishlist as it stands right now -- is injected every turn through a
// macro, because the model has to know it on every turn, not only the turn it changed.
// This module is the other half: the things that HAPPENED, which belong in the event stream.
//
// Registering these in `loadNativeTimeline` also gets long-term memory for free:
// memory-summarizer.ts consumes `loadNativeTimeline` + `formatTimelineForSummarization`,
// so a projection entry reaches both short-term context and the summarization pipeline.
//
// Content deliberately carries its own `[Couple Space <time>]` head, matching the note-wall
// convention -- `formatStoredPromptEventContent` rewrites or strips that head depending on
// whether the surface is time-aware, and adds nothing when it is missing.

const COUPLE_SPACE_EVENT_PREFIX = "ai_phone_couple_space_events_";
const MAX_EVENTS_PER_CHARACTER = 120;
const EVENT_LABEL = "Couple Space";

registerDynamicPrefix(COUPLE_SPACE_EVENT_PREFIX);

export type CoupleSpaceProjectionEntry = {
    id: string;
    timestamp: string;
    content: string;
};

function storageKey(characterId: string): string {
    return `${COUPLE_SPACE_EVENT_PREFIX}${characterId}`;
}

function cleanEventText(value: unknown, maxLength: number): string {
    const text = String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function loadEventsByKey(key: string): CoupleSpaceProjectionEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((entry): entry is CoupleSpaceProjectionEntry =>
                entry
                && typeof entry.id === "string"
                && typeof entry.timestamp === "string"
                && typeof entry.content === "string")
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
        return [];
    }
}

function saveEventsByKey(key: string, events: CoupleSpaceProjectionEntry[]): void {
    if (typeof window === "undefined") return;
    const compacted = [...events]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-MAX_EVENTS_PER_CHARACTER);
    kvSet(key, JSON.stringify(compacted));
}

function upsertEvent(characterId: string, entry: CoupleSpaceProjectionEntry): void {
    if (!characterId || typeof window === "undefined") return;
    const key = storageKey(characterId);
    const events = loadEventsByKey(key).filter(item => item.id !== entry.id);
    events.push(entry);
    saveEventsByKey(key, events);
}

function head(timestamp: string): string {
    return `[${EVENT_LABEL} ${formatChatTimestamp(timestamp)}]`;
}

/** Human-readable date for prompt text: 2026-03-03 -> "3 March". */
export function formatAnniversaryDateLabel(date: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
    if (!match) return String(date ?? "");
    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];
    const month = months[Number(match[2]) - 1];
    if (!month) return String(date);
    return `${Number(match[3])} ${month}`;
}

export function recordAnniversaryAddedEvent(input: {
    characterId: string;
    anniversary: Anniversary;
}): void {
    const timestamp = input.anniversary.createdAt || new Date().toISOString();
    const title = cleanEventText(input.anniversary.title, 120);
    const when = formatAnniversaryDateLabel(input.anniversary.date);
    const repeat = input.anniversary.recurring ? ", which they mark every year" : "";
    const note = cleanEventText(input.anniversary.note, 300);
    const noteText = note ? ` They added a note: "${note}".` : "";

    upsertEvent(input.characterId, {
        id: `couple_space_anniversary_${input.anniversary.id}`,
        timestamp,
        content: `${head(timestamp)} The user saved an anniversary in Couple Space: "${title}" on ${when}${repeat}.${noteText}`,
    });
}

export function recordWishlistAddedEvent(input: {
    characterId: string;
    characterName: string;
    item: WishlistItem;
}): void {
    const timestamp = input.item.createdAt || new Date().toISOString();
    const title = cleanEventText(input.item.title, 160);
    const characterName = cleanEventText(input.characterName, 80) || "them";
    const price = cleanEventText(input.item.priceLabel, 60);
    const priceText = price ? ` (${price})` : "";
    const note = cleanEventText(input.item.note, 300);
    const noteText = note ? ` They added: "${note}".` : "";
    const whose = input.item.wantedBy === "character"
        ? `something they think ${characterName} would want`
        : "something they want themselves";

    upsertEvent(input.characterId, {
        id: `couple_space_wish_${input.item.id}`,
        timestamp,
        content: `${head(timestamp)} The user added "${title}"${priceText} to the Couple Space wishlist, as ${whose}.${noteText}`,
    });
}

export function recordWishlistFulfilledEvent(input: {
    characterId: string;
    item: WishlistItem;
}): void {
    const timestamp = input.item.fulfilledAt || new Date().toISOString();
    const title = cleanEventText(input.item.title, 160);

    upsertEvent(input.characterId, {
        id: `couple_space_wish_fulfilled_${input.item.id}`,
        timestamp,
        content: `${head(timestamp)} "${title}" on the Couple Space wishlist was fulfilled.`,
    });
}

export function recordReflectionEvent(input: {
    characterId: string;
    characterName: string;
    reflection: ReflectionEntry;
}): void {
    const timestamp = input.reflection.createdAt || new Date().toISOString();
    const characterName = cleanEventText(input.characterName, 80) || "them";
    const title = cleanEventText(input.reflection.title, 120);
    const titleText = title ? ` titled "${title}"` : "";
    // Reflections are the most memory-relevant thing in Couple Space, so the body is kept
    // far longer than the other events -- this is the entry the summarizer will draw on.
    const body = cleanEventText(input.reflection.body, 900);
    const who = input.reflection.author === "character"
        ? `${characterName} wrote a reflection`
        : "The user wrote a reflection";

    upsertEvent(input.characterId, {
        id: `couple_space_reflection_${input.reflection.id}`,
        timestamp,
        content: `${head(timestamp)} ${who} about their relationship with ${characterName}${titleText}: "${body}"`,
    });
}

export function deleteCoupleSpaceProjectionEventsForReflection(characterId: string, reflectionId: string): void {
    if (!characterId || !reflectionId || typeof window === "undefined") return;
    const key = storageKey(characterId);
    const events = loadEventsByKey(key);
    const next = events.filter(entry => entry.id !== `couple_space_reflection_${reflectionId}`);
    if (next.length !== events.length) saveEventsByKey(key, next);
}

export function deleteCoupleSpaceProjectionEventsForAnniversary(characterId: string, anniversaryId: string): void {
    if (!characterId || !anniversaryId || typeof window === "undefined") return;
    const key = storageKey(characterId);
    const events = loadEventsByKey(key);
    const next = events.filter(entry => entry.id !== `couple_space_anniversary_${anniversaryId}`);
    if (next.length !== events.length) saveEventsByKey(key, next);
}

export function deleteCoupleSpaceProjectionEventsForWish(characterId: string, wishId: string): void {
    if (!characterId || !wishId || typeof window === "undefined") return;
    const key = storageKey(characterId);
    const events = loadEventsByKey(key);
    const next = events.filter(entry =>
        entry.id !== `couple_space_wish_${wishId}`
        && entry.id !== `couple_space_wish_fulfilled_${wishId}`);
    if (next.length !== events.length) saveEventsByKey(key, next);
}

export function loadCoupleSpaceProjectionEntries(
    characterId: string,
    options?: { afterTimestamp?: string },
): CoupleSpaceProjectionEntry[] {
    const events = loadEventsByKey(storageKey(characterId));
    if (!options?.afterTimestamp) return events;
    return events.filter(entry => entry.timestamp > options.afterTimestamp!);
}

/** Test seam / cleanup: drop every stored Couple Space event for every character. */
export function clearAllCoupleSpaceProjections(): void {
    if (typeof window === "undefined") return;
    for (const key of kvKeysWithPrefix(COUPLE_SPACE_EVENT_PREFIX)) {
        saveEventsByKey(key, []);
    }
}
