// Rolling per-character projection log for the Review app, mirroring lib/notewall-memory.ts's
// shape exactly: a capped KV-backed event log per character, read by short-term-assembler.ts's
// loadNativeTimeline so a character's own journal/review activity is remembered in later chats.

import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import type { PublishedReview, ReviewJournalEntry, ReviewTitle } from "./review-types";

const REVIEW_EVENT_PREFIX = "ai_phone_review_events_";
const MAX_EVENTS_PER_CHARACTER = 120;

registerDynamicPrefix(REVIEW_EVENT_PREFIX);

export type ReviewProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
  authorType: "user" | "character"; // journal entries are user; published reviews are character
};

function storageKey(characterId: string): string {
  return `${REVIEW_EVENT_PREFIX}${characterId}`;
}

function cleanEventText(value: string, maxLength: number): string {
  const text = String(value || "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function loadEvents(characterId: string): ReviewProjectionEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(storageKey(characterId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ReviewProjectionEntry =>
        entry && typeof entry.id === "string" && typeof entry.timestamp === "string" && typeof entry.content === "string"
        && (entry.authorType === "user" || entry.authorType === "character"),
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

function saveEvents(characterId: string, events: ReviewProjectionEntry[]): void {
  if (typeof window === "undefined") return;
  const compacted = [...events]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_EVENTS_PER_CHARACTER);
  kvSet(storageKey(characterId), JSON.stringify(compacted));
}

function upsertEvent(characterId: string, entry: ReviewProjectionEntry): void {
  const events = loadEvents(characterId).filter((item) => item.id !== entry.id);
  events.push(entry);
  saveEvents(characterId, events);
}

function titleLabel(title: ReviewTitle): string {
  return `${title.kind === "book" ? "the book" : "the movie"} "${title.title}"`;
}

/**
 * Journal entries have no character of their own (v1 only ever writes user-authored entries,
 * per lib/review-types.ts), so the character whose memory this should land in -- whichever
 * character the user is discussing the title with -- is passed in explicitly.
 */
export function recordReviewJournalEvent(title: ReviewTitle, entry: ReviewJournalEntry, characterId: string): void {
  const timestamp = entry.createdAt || new Date().toISOString();
  const time = formatChatTimestamp(timestamp);
  const body = cleanEventText(entry.body, 400);
  upsertEvent(characterId, {
    id: `review_journal_${entry.id}_${characterId}`,
    timestamp,
    authorType: "user",
    content: `[Review ${time}] The user wrote a journal entry about ${titleLabel(title)}: "${body}"`,
  });
}

export function recordPublishedReviewEvent(title: ReviewTitle, review: PublishedReview): void {
  const timestamp = review.createdAt || new Date().toISOString();
  const time = formatChatTimestamp(timestamp);
  const summary = cleanEventText(review.headline, 300);
  upsertEvent(review.characterId, {
    id: `review_published_${review.id}`,
    timestamp,
    authorType: "character",
    content: `[Review ${time}] ${review.characterName} published a ${review.rating.value}/5 review of ${titleLabel(title)}: "${summary}"`,
  });
}

export function loadReviewProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): ReviewProjectionEntry[] {
  const events = loadEvents(characterId);
  if (!options?.afterTimestamp) return events;
  return events.filter((entry) => entry.timestamp > options.afterTimestamp!);
}
