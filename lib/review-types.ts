export type ReviewTitleKind = "movie" | "book";

export type ReviewStatus = "not_started" | "in_progress" | "finished";

export type ReviewTitleSource =
  | { kind: "movie"; provider: "tmdb"; externalId: string }
  | { kind: "book"; provider: "open_library" | "google_books"; externalId: string }
  | { kind: ReviewTitleKind; provider: "manual" };

/**
 * A single deterministic fetch of real review/description text, keyed to the exact external id
 * the user picked when adding the title -- never re-searched per message. `sourceLabel` is
 * "Review" for TMDB movie reviews (real audience reviews) and "Description" for Google Books
 * (a publisher synopsis, not a review) -- an honest labeling distinction, not a data-shape one.
 */
export type ReviewGroundingSnippet = {
  sourceLabel: "Review" | "Description";
  status: "fetched" | "confirmed" | "edited" | "cleared";
  text: string; // what generation reads; "" when cleared
  originalText: string; // as-fetched, frozen, so "revert to fetched" is always possible
  sourceAuthor?: string;
  sourceUrl?: string;
  fetchedAt: string;
};

export type ReviewRating = { value: number; scale: 5 };

export type ReviewTitle = {
  id: string;
  kind: ReviewTitleKind;
  title: string;
  originalTitle?: string;
  year?: string;
  creator: string; // director(s) for movies, author(s) for books
  overview: string;
  coverAssetId: string | null; // lib/theme-storage.ts asset id
  source: ReviewTitleSource;
  status: ReviewStatus; // the discussion-mode gate
  grounding: ReviewGroundingSnippet | null;
  myRating: ReviewRating | null; // the user's own personal rating
  createdAt: string;
  updatedAt: string;
};

export type ReviewJournalEntry = {
  id: string;
  titleId: string;
  authorType: "user" | "character";
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ReviewDiscussionThread = {
  id: string;
  titleId: string;
  characterId: string;
  createdAt: string;
  updatedAt: string;
};

export type ReviewDiscussMode = "discuss_safe" | "discuss_free";

export type ReviewDiscussionMessage = {
  id: string;
  threadId: string;
  authorType: "user" | "character";
  content: string;
  modeAtSend: ReviewDiscussMode; // recorded per-message, so a thread can carry a mid-thread mode flip
  createdAt: string;
};

export type PublishedReview = {
  id: string;
  titleId: string;
  characterId: string;
  characterName: string;
  rating: ReviewRating;
  headline: string;
  body: string[];
  groundingUsed: boolean;
  memorySummary?: string;
  createdAt: string;
};

export const REVIEW_RATING_STEP = 0.5;
export const REVIEW_RATING_MAX = 5;
export const REVIEW_RATING_MIN = 0.5;

export function clampReviewRatingValue(value: number): number {
  if (!Number.isFinite(value)) return REVIEW_RATING_MIN;
  const stepped = Math.round(value / REVIEW_RATING_STEP) * REVIEW_RATING_STEP;
  return Math.min(REVIEW_RATING_MAX, Math.max(REVIEW_RATING_MIN, stepped));
}

export function makeReviewRating(value: number): ReviewRating {
  return { value: clampReviewRatingValue(value), scale: 5 };
}
