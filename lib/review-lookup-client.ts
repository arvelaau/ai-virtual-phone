import { loadMediaLookupSettings } from "./settings-storage";
import type { ReviewGroundingSnippet, ReviewTitleKind } from "./review-types";

export type MediaSearchResult = {
  kind: ReviewTitleKind;
  provider: "tmdb" | "open_library" | "google_books";
  externalId: string;
  title: string;
  creator: string;
  year?: string;
  coverUrl?: string;
};

export type MediaDetail = MediaSearchResult & {
  overview: string;
};

export type MediaLookupError = { ok: false; error: string };
export type MediaLookupResult<T> = { ok: true; data: T } | MediaLookupError;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function searchMovies(query: string): Promise<MediaLookupResult<MediaSearchResult[]>> {
  const apiKey = loadMediaLookupSettings().tmdbApiKey;
  const params = new URLSearchParams({ action: "search", query });
  if (apiKey) params.set("apiKey", apiKey);
  const response = await fetch(`/api/media-lookup/movie?${params.toString()}`);
  const data = await readJson(response);
  if (!response.ok || data.ok === false) return { ok: false, error: String(data.error ?? "search_failed") };
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: results.map((item) => ({
      kind: "movie" as const,
      provider: "tmdb" as const,
      externalId: String(item.externalId ?? ""),
      title: String(item.title ?? ""),
      creator: "",
      year: typeof item.year === "string" ? item.year : undefined,
      coverUrl: typeof item.posterUrl === "string" ? item.posterUrl : undefined,
    })),
  };
}

export async function detailMovie(id: string): Promise<MediaLookupResult<MediaDetail>> {
  const apiKey = loadMediaLookupSettings().tmdbApiKey;
  const params = new URLSearchParams({ action: "detail", id });
  if (apiKey) params.set("apiKey", apiKey);
  const response = await fetch(`/api/media-lookup/movie?${params.toString()}`);
  const data = await readJson(response);
  if (!response.ok || data.ok === false) return { ok: false, error: String(data.error ?? "detail_failed") };
  const detail = (data.detail ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    data: {
      kind: "movie",
      provider: "tmdb",
      externalId: String(detail.externalId ?? id),
      title: String(detail.title ?? ""),
      creator: String(detail.creator ?? ""),
      year: typeof detail.year === "string" ? detail.year : undefined,
      coverUrl: typeof detail.posterUrl === "string" ? detail.posterUrl : undefined,
      overview: typeof detail.overview === "string" ? detail.overview : "",
    },
  };
}

export async function fetchMovieReviewSnippet(id: string): Promise<MediaLookupResult<ReviewGroundingSnippet | null>> {
  const apiKey = loadMediaLookupSettings().tmdbApiKey;
  const params = new URLSearchParams({ action: "review", id });
  if (apiKey) params.set("apiKey", apiKey);
  const response = await fetch(`/api/media-lookup/movie?${params.toString()}`);
  const data = await readJson(response);
  if (!response.ok || data.ok === false) return { ok: false, error: String(data.error ?? "review_failed") };
  const review = data.review as Record<string, unknown> | null;
  if (!review) return { ok: true, data: null };
  const now = new Date().toISOString();
  return {
    ok: true,
    data: {
      sourceLabel: "Review",
      status: "fetched",
      text: String(review.text ?? ""),
      originalText: String(review.text ?? ""),
      sourceAuthor: typeof review.sourceAuthor === "string" ? review.sourceAuthor : undefined,
      sourceUrl: typeof review.sourceUrl === "string" ? review.sourceUrl : undefined,
      fetchedAt: now,
    },
  };
}

export async function searchBooks(
  query: string,
  provider: "open_library" | "google_books" = "google_books",
): Promise<MediaLookupResult<MediaSearchResult[]>> {
  const params = new URLSearchParams({ action: "search", query, provider });
  if (provider === "google_books") {
    const apiKey = loadMediaLookupSettings().googleBooksApiKey;
    if (apiKey) params.set("apiKey", apiKey);
  }
  const response = await fetch(`/api/media-lookup/book?${params.toString()}`);
  const data = await readJson(response);
  if (!response.ok || data.ok === false) return { ok: false, error: String(data.error ?? "search_failed") };
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: results.map((item) => ({
      kind: "book" as const,
      provider: (item.provider === "open_library" ? "open_library" : "google_books") as "open_library" | "google_books",
      externalId: String(item.externalId ?? ""),
      title: String(item.title ?? ""),
      creator: String(item.creator ?? ""),
      year: typeof item.year === "string" ? item.year : undefined,
      coverUrl: typeof item.coverUrl === "string" ? item.coverUrl : undefined,
    })),
  };
}

export async function detailBook(
  id: string,
  provider: "open_library" | "google_books" = "google_books",
): Promise<MediaLookupResult<{ detail: MediaDetail; grounding: ReviewGroundingSnippet | null }>> {
  const params = new URLSearchParams({ action: "detail", id, provider });
  if (provider === "google_books") {
    const apiKey = loadMediaLookupSettings().googleBooksApiKey;
    if (apiKey) params.set("apiKey", apiKey);
  }
  const response = await fetch(`/api/media-lookup/book?${params.toString()}`);
  const data = await readJson(response);
  if (!response.ok || data.ok === false) return { ok: false, error: String(data.error ?? "detail_failed") };
  const detail = (data.detail ?? {}) as Record<string, unknown>;
  const groundingRaw = detail.grounding as Record<string, unknown> | null;
  const now = new Date().toISOString();
  return {
    ok: true,
    data: {
      detail: {
        kind: "book",
        provider,
        externalId: String(detail.externalId ?? id),
        title: String(detail.title ?? ""),
        creator: String(detail.creator ?? ""),
        year: typeof detail.year === "string" ? detail.year : undefined,
        coverUrl: typeof detail.coverUrl === "string" ? detail.coverUrl : undefined,
        overview: typeof detail.overview === "string" ? detail.overview : "",
      },
      grounding: groundingRaw
        ? {
            sourceLabel: "Description",
            status: "fetched",
            text: String(groundingRaw.text ?? ""),
            originalText: String(groundingRaw.text ?? ""),
            fetchedAt: now,
          }
        : null,
    },
  };
}
