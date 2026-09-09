import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { deleteThemeAsset } from "./theme-storage";
import {
  clampReviewRatingValue,
  type PublishedReview,
  type ReviewDiscussionMessage,
  type ReviewDiscussionThread,
  type ReviewDiscussMode,
  type ReviewGroundingSnippet,
  type ReviewJournalEntry,
  type ReviewRating,
  type ReviewStatus,
  type ReviewTitle,
  type ReviewTitleKind,
  type ReviewTitleSource,
} from "./review-types";

const TITLES_KEY = "ai_phone_review_titles_v1";
const JOURNAL_KEY = "ai_phone_review_journal_v1";
const THREADS_KEY = "ai_phone_review_threads_v1";
const MESSAGES_KEY = "ai_phone_review_messages_v1";
const PUBLISHED_KEY = "ai_phone_review_published_v1";

registerKvMigration(TITLES_KEY);
registerKvMigration(JOURNAL_KEY);
registerKvMigration(THREADS_KEY);
registerKvMigration(MESSAGES_KEY);
registerKvMigration(PUBLISHED_KEY);

function generateId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanMultilineText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readArray<T>(key: string): unknown[] {
  try {
    const raw = kvGet(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as unknown[]) : [];
  } catch {
    return [];
  }
}

/* ═══════════════════════════════════════════
   Titles
   ═══════════════════════════════════════════ */

function normalizeTitleSource(raw: unknown, kind: ReviewTitleKind): ReviewTitleSource {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const provider = cleanText(record.provider, 32);
  if (kind === "movie" && provider === "tmdb") {
    const externalId = cleanText(record.externalId, 64);
    if (externalId) return { kind: "movie", provider: "tmdb", externalId };
  }
  if (kind === "book" && (provider === "open_library" || provider === "google_books")) {
    const externalId = cleanText(record.externalId, 64);
    if (externalId) return { kind: "book", provider, externalId };
  }
  return { kind, provider: "manual" };
}

function normalizeGroundingSnippet(raw: unknown): ReviewGroundingSnippet | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const sourceLabel = record.sourceLabel === "Description" ? "Description" : "Review";
  const status: ReviewGroundingSnippet["status"] =
    record.status === "confirmed" || record.status === "edited" || record.status === "cleared"
      ? record.status
      : "fetched";
  const originalText = cleanMultilineText(record.originalText, 4000);
  const text = status === "cleared" ? "" : cleanMultilineText(record.text, 4000) || originalText;
  if (!originalText && !text) return null;
  return {
    sourceLabel,
    status,
    text,
    originalText,
    sourceAuthor: cleanText(record.sourceAuthor, 120) || undefined,
    sourceUrl: cleanText(record.sourceUrl, 500) || undefined,
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : nowIso(),
  };
}

function normalizeRating(raw: unknown): ReviewRating | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const value = Number(record.value);
  if (!Number.isFinite(value)) return null;
  return { value: clampReviewRatingValue(value), scale: 5 };
}

export function normalizeReviewTitle(raw: unknown): ReviewTitle | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const title = cleanText(record.title, 200);
  if (!id || !title) return null;
  const kind: ReviewTitleKind = record.kind === "book" ? "book" : "movie";
  const status: ReviewStatus =
    record.status === "in_progress" || record.status === "finished" ? record.status : "not_started";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : nowIso();

  return {
    id,
    kind,
    title,
    originalTitle: cleanText(record.originalTitle, 200) || undefined,
    year: cleanText(record.year, 8) || undefined,
    creator: cleanText(record.creator, 200),
    overview: cleanMultilineText(record.overview, 2000),
    coverAssetId: cleanText(record.coverAssetId, 200) || null,
    source: normalizeTitleSource(record.source, kind),
    status,
    grounding: normalizeGroundingSnippet(record.grounding),
    myRating: normalizeRating(record.myRating),
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
  };
}

export function loadReviewTitles(): ReviewTitle[] {
  if (typeof window === "undefined") return [];
  return readArray(TITLES_KEY)
    .map(normalizeReviewTitle)
    .filter((item): item is ReviewTitle => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveReviewTitles(titles: ReviewTitle[]): void {
  if (typeof window === "undefined") return;
  const normalized = titles
    .map(normalizeReviewTitle)
    .filter((item): item is ReviewTitle => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  kvSet(TITLES_KEY, JSON.stringify(normalized));
}

export function getReviewTitle(id: string): ReviewTitle | null {
  return loadReviewTitles().find((title) => title.id === id) ?? null;
}

export function upsertReviewTitle(title: ReviewTitle): ReviewTitle {
  const titles = loadReviewTitles();
  const index = titles.findIndex((item) => item.id === title.id);
  const next = { ...title, updatedAt: nowIso() };
  if (index >= 0) {
    titles[index] = next;
  } else {
    titles.push(next);
  }
  saveReviewTitles(titles);
  return next;
}

/**
 * Deletes a title and cascades to its journal entries, discussion threads/messages and
 * published reviews (mirrors `reading-storage.ts`'s `deleteBook` cascade), plus the cover
 * image asset if one was stored via `lib/theme-storage.ts`.
 */
export async function deleteReviewTitle(id: string): Promise<void> {
  if (!id) return;
  const title = getReviewTitle(id);
  saveReviewTitles(loadReviewTitles().filter((item) => item.id !== id));
  saveReviewJournalEntries(loadReviewJournalEntries().filter((entry) => entry.titleId !== id));
  const threadIds = new Set(
    loadReviewDiscussionThreads()
      .filter((thread) => thread.titleId === id)
      .map((thread) => thread.id),
  );
  saveReviewDiscussionThreads(loadReviewDiscussionThreads().filter((thread) => thread.titleId !== id));
  saveReviewDiscussionMessages(loadReviewDiscussionMessages().filter((msg) => !threadIds.has(msg.threadId)));
  savePublishedReviews(loadPublishedReviews().filter((review) => review.titleId !== id));
  if (title?.coverAssetId) {
    await deleteThemeAsset(title.coverAssetId).catch(() => {});
  }
}

/* ═══════════════════════════════════════════
   Journal
   ═══════════════════════════════════════════ */

function normalizeJournalEntry(raw: unknown): ReviewJournalEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const titleId = cleanText(record.titleId, 120);
  const body = cleanMultilineText(record.body, 4000);
  if (!id || !titleId || !body) return null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : nowIso();
  return {
    id,
    titleId,
    authorType: record.authorType === "character" ? "character" : "user",
    authorName: cleanText(record.authorName, 80),
    body,
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
  };
}

export function loadReviewJournalEntries(titleId?: string): ReviewJournalEntry[] {
  if (typeof window === "undefined") return [];
  const entries = readArray(JOURNAL_KEY)
    .map(normalizeJournalEntry)
    .filter((item): item is ReviewJournalEntry => Boolean(item))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return titleId ? entries.filter((entry) => entry.titleId === titleId) : entries;
}

export function saveReviewJournalEntries(entries: ReviewJournalEntry[]): void {
  if (typeof window === "undefined") return;
  const normalized = entries
    .map(normalizeJournalEntry)
    .filter((item): item is ReviewJournalEntry => Boolean(item))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  kvSet(JOURNAL_KEY, JSON.stringify(normalized));
}

export function addReviewJournalEntry(input: {
  titleId: string;
  authorType: "user" | "character";
  authorName: string;
  body: string;
}): ReviewJournalEntry {
  const now = nowIso();
  const entry: ReviewJournalEntry = {
    id: generateId("review_journal"),
    titleId: cleanText(input.titleId, 120),
    authorType: input.authorType,
    authorName: cleanText(input.authorName, 80),
    body: cleanMultilineText(input.body, 4000),
    createdAt: now,
    updatedAt: now,
  };
  saveReviewJournalEntries([...loadReviewJournalEntries(), entry]);
  return entry;
}

export function deleteReviewJournalEntry(id: string): void {
  if (!id) return;
  saveReviewJournalEntries(loadReviewJournalEntries().filter((entry) => entry.id !== id));
}

/* ═══════════════════════════════════════════
   Discussion threads + messages
   ═══════════════════════════════════════════ */

function normalizeThread(raw: unknown): ReviewDiscussionThread | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const titleId = cleanText(record.titleId, 120);
  const characterId = cleanText(record.characterId, 120);
  if (!id || !titleId || !characterId) return null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : nowIso();
  return {
    id,
    titleId,
    characterId,
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
  };
}

export function loadReviewDiscussionThreads(titleId?: string): ReviewDiscussionThread[] {
  if (typeof window === "undefined") return [];
  const threads = readArray(THREADS_KEY)
    .map(normalizeThread)
    .filter((item): item is ReviewDiscussionThread => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return titleId ? threads.filter((thread) => thread.titleId === titleId) : threads;
}

export function saveReviewDiscussionThreads(threads: ReviewDiscussionThread[]): void {
  if (typeof window === "undefined") return;
  const normalized = threads
    .map(normalizeThread)
    .filter((item): item is ReviewDiscussionThread => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  kvSet(THREADS_KEY, JSON.stringify(normalized));
}

export function getOrCreateReviewDiscussionThread(titleId: string, characterId: string): ReviewDiscussionThread {
  const existing = loadReviewDiscussionThreads(titleId).find((thread) => thread.characterId === characterId);
  if (existing) return existing;
  const now = nowIso();
  const thread: ReviewDiscussionThread = {
    id: generateId("review_thread"),
    titleId: cleanText(titleId, 120),
    characterId: cleanText(characterId, 120),
    createdAt: now,
    updatedAt: now,
  };
  saveReviewDiscussionThreads([...loadReviewDiscussionThreads(), thread]);
  return thread;
}

function touchThread(threadId: string): void {
  const threads = loadReviewDiscussionThreads();
  const index = threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) return;
  threads[index] = { ...threads[index], updatedAt: nowIso() };
  saveReviewDiscussionThreads(threads);
}

function normalizeMessage(raw: unknown): ReviewDiscussionMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const threadId = cleanText(record.threadId, 120);
  const content = cleanMultilineText(record.content, 4000);
  if (!id || !threadId || !content) return null;
  const modeAtSend: ReviewDiscussMode = record.modeAtSend === "discuss_free" ? "discuss_free" : "discuss_safe";
  return {
    id,
    threadId,
    authorType: record.authorType === "character" ? "character" : "user",
    content,
    modeAtSend,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
  };
}

export function loadReviewDiscussionMessages(threadId?: string): ReviewDiscussionMessage[] {
  if (typeof window === "undefined") return [];
  const messages = readArray(MESSAGES_KEY)
    .map(normalizeMessage)
    .filter((item): item is ReviewDiscussionMessage => Boolean(item))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return threadId ? messages.filter((msg) => msg.threadId === threadId) : messages;
}

export function saveReviewDiscussionMessages(messages: ReviewDiscussionMessage[]): void {
  if (typeof window === "undefined") return;
  const normalized = messages
    .map(normalizeMessage)
    .filter((item): item is ReviewDiscussionMessage => Boolean(item))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  kvSet(MESSAGES_KEY, JSON.stringify(normalized));
}

export function addReviewDiscussionMessage(input: {
  threadId: string;
  authorType: "user" | "character";
  content: string;
  modeAtSend: ReviewDiscussMode;
}): ReviewDiscussionMessage {
  const message: ReviewDiscussionMessage = {
    id: generateId("review_msg"),
    threadId: cleanText(input.threadId, 120),
    authorType: input.authorType,
    content: cleanMultilineText(input.content, 4000),
    modeAtSend: input.modeAtSend,
    createdAt: nowIso(),
  };
  saveReviewDiscussionMessages([...loadReviewDiscussionMessages(), message]);
  touchThread(message.threadId);
  return message;
}

/* ═══════════════════════════════════════════
   Published reviews
   ═══════════════════════════════════════════ */

function normalizePublishedReview(raw: unknown): PublishedReview | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const titleId = cleanText(record.titleId, 120);
  const characterId = cleanText(record.characterId, 120);
  const rating = normalizeRating(record.rating);
  if (!id || !titleId || !characterId || !rating) return null;
  const body = Array.isArray(record.body)
    ? record.body.map((line) => cleanMultilineText(line, 900)).filter(Boolean).slice(0, 10)
    : [];
  return {
    id,
    titleId,
    characterId,
    characterName: cleanText(record.characterName, 80),
    rating,
    headline: cleanText(record.headline, 200),
    body,
    groundingUsed: Boolean(record.groundingUsed),
    memorySummary: cleanMultilineText(record.memorySummary, 500) || undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
  };
}

export function loadPublishedReviews(titleId?: string): PublishedReview[] {
  if (typeof window === "undefined") return [];
  const reviews = readArray(PUBLISHED_KEY)
    .map(normalizePublishedReview)
    .filter((item): item is PublishedReview => Boolean(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return titleId ? reviews.filter((review) => review.titleId === titleId) : reviews;
}

export function savePublishedReviews(reviews: PublishedReview[]): void {
  if (typeof window === "undefined") return;
  const normalized = reviews
    .map(normalizePublishedReview)
    .filter((item): item is PublishedReview => Boolean(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  kvSet(PUBLISHED_KEY, JSON.stringify(normalized));
}

export function addPublishedReview(review: Omit<PublishedReview, "id" | "createdAt">): PublishedReview {
  const full: PublishedReview = {
    ...review,
    id: generateId("review_pub"),
    createdAt: nowIso(),
  };
  savePublishedReviews([...loadPublishedReviews(), full]);
  return full;
}
