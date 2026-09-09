import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

type MovieSearchResult = {
  externalId: string;
  title: string;
  originalTitle?: string;
  year?: string;
  posterUrl?: string;
  overview: string;
};

type MovieDetail = MovieSearchResult & {
  creator: string; // director(s), joined
};

function jsonError(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

function resolveApiKey(request: Request): string {
  const envKey = process.env.TMDB_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const url = new URL(request.url);
  return (url.searchParams.get("apiKey") || "").trim();
}

function yearFromDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 4) return undefined;
  return value.slice(0, 4);
}

function posterUrl(path: unknown): string | undefined {
  return typeof path === "string" && path ? `${TMDB_IMAGE_BASE_URL}${path}` : undefined;
}

async function tmdbFetch(path: string, apiKey: string): Promise<Record<string, unknown>> {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${TMDB_BASE_URL}${path}${separator}api_key=${encodeURIComponent(apiKey)}`, {
    headers: { Accept: "application/json" },
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof data.status_message === "string" ? data.status_message : `TMDB request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "search";
  const query = url.searchParams.get("query") || "";
  const id = url.searchParams.get("id") || "";

  const apiKey = resolveApiKey(request);
  if (!apiKey) return jsonError("missing_tmdb_key", 503);

  try {
    if (action === "search") {
      if (!query.trim()) return jsonError("A search query is required.");
      const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(query.trim())}`, apiKey);
      const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
      const items: MovieSearchResult[] = results.slice(0, 20).map((item) => ({
        externalId: String(item.id ?? ""),
        title: String(item.title ?? item.original_title ?? "Untitled"),
        originalTitle: typeof item.original_title === "string" ? item.original_title : undefined,
        year: yearFromDate(item.release_date),
        posterUrl: posterUrl(item.poster_path),
        overview: typeof item.overview === "string" ? item.overview : "",
      }));
      return NextResponse.json({ ok: true, results: items });
    }

    if (action === "detail") {
      if (!id.trim()) return jsonError("A movie id is required.");
      const data = await tmdbFetch(`/movie/${encodeURIComponent(id.trim())}?append_to_response=credits`, apiKey);
      const credits = data.credits && typeof data.credits === "object" ? (data.credits as Record<string, unknown>) : {};
      const crew = Array.isArray(credits.crew) ? (credits.crew as Record<string, unknown>[]) : [];
      const directors = crew.filter((member) => member.job === "Director").map((member) => String(member.name ?? "")).filter(Boolean);
      const detail: MovieDetail = {
        externalId: String(data.id ?? id),
        title: String(data.title ?? "Untitled"),
        originalTitle: typeof data.original_title === "string" ? data.original_title : undefined,
        year: yearFromDate(data.release_date),
        posterUrl: posterUrl(data.poster_path),
        overview: typeof data.overview === "string" ? data.overview : "",
        creator: directors.join(", "),
      };
      return NextResponse.json({ ok: true, detail });
    }

    if (action === "review") {
      if (!id.trim()) return jsonError("A movie id is required.");
      const data = await tmdbFetch(`/movie/${encodeURIComponent(id.trim())}/reviews`, apiKey);
      const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
      // Prefer the longest review as the most substantive one to cache -- a one-line review
      // gives the character almost nothing to actually ground its own opinion in.
      const best = results.reduce<Record<string, unknown> | null>((longest, current) => {
        const currentContent = typeof current.content === "string" ? current.content : "";
        const longestContent = longest && typeof longest.content === "string" ? longest.content : "";
        return currentContent.length > longestContent.length ? current : longest;
      }, null);
      if (!best) return NextResponse.json({ ok: true, review: null });
      return NextResponse.json({
        ok: true,
        review: {
          sourceLabel: "Review" as const,
          text: typeof best.content === "string" ? best.content : "",
          sourceAuthor: typeof best.author === "string" ? best.author : undefined,
          sourceUrl: typeof best.url === "string" ? best.url : undefined,
        },
      });
    }

    return jsonError(`Unknown action: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 502);
  }
}
