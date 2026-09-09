import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OPEN_LIBRARY_BASE_URL = "https://openlibrary.org";
const OPEN_LIBRARY_COVER_URL = "https://covers.openlibrary.org/b/id";
const GOOGLE_BOOKS_BASE_URL = "https://www.googleapis.com/books/v1/volumes";

type BookProvider = "open_library" | "google_books";

type BookSearchResult = {
  provider: BookProvider;
  externalId: string;
  title: string;
  creator: string; // author(s), joined
  year?: string;
  coverUrl?: string;
};

type BookDetail = BookSearchResult & {
  overview: string;
  // Google Books has no separate reviews endpoint -- its description is a publisher synopsis,
  // not a real review, so it's surfaced honestly labeled "Description" rather than "Review".
  // Open Library has neither reviews nor a reliable description field for most works.
  grounding: { sourceLabel: "Description"; text: string } | null;
};

function jsonError(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

function normalizeProvider(value: string | null): BookProvider {
  return value === "open_library" ? "open_library" : "google_books";
}

// Optional -- Google Books' keyless/anonymous quota is shared across whoever else is calling it
// from the same IP pool and can 429 quickly on shared hosting infra. A key (free from Google
// Cloud Console) raises the ceiling substantially, but search still works without one.
function resolveGoogleBooksApiKey(request: Request): string {
  const envKey = process.env.GOOGLE_BOOKS_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const url = new URL(request.url);
  return (url.searchParams.get("apiKey") || "").trim();
}

function asDescriptionText(description: unknown): string {
  if (typeof description === "string") return description;
  if (description && typeof description === "object" && "value" in description) {
    const value = (description as { value?: unknown }).value;
    return typeof value === "string" ? value : "";
  }
  return "";
}

async function searchOpenLibrary(query: string): Promise<BookSearchResult[]> {
  const response = await fetch(`${OPEN_LIBRARY_BASE_URL}/search.json?q=${encodeURIComponent(query)}&limit=20`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Open Library request failed (${response.status})`);
  const data = (await response.json()) as { docs?: Record<string, unknown>[] };
  const docs = Array.isArray(data.docs) ? data.docs : [];
  return docs.map((doc) => {
    const key = typeof doc.key === "string" ? doc.key.replace(/^\/works\//, "") : "";
    const authors = Array.isArray(doc.author_name) ? (doc.author_name as string[]) : [];
    const coverId = typeof doc.cover_i === "number" ? doc.cover_i : undefined;
    return {
      provider: "open_library" as const,
      externalId: key,
      title: String(doc.title ?? "Untitled"),
      creator: authors.join(", "),
      year: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
      coverUrl: coverId ? `${OPEN_LIBRARY_COVER_URL}/${coverId}-M.jpg` : undefined,
    };
  });
}

async function detailOpenLibrary(id: string): Promise<BookDetail> {
  const response = await fetch(`${OPEN_LIBRARY_BASE_URL}/works/${encodeURIComponent(id)}.json`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Open Library request failed (${response.status})`);
  const data = (await response.json()) as Record<string, unknown>;
  const overview = asDescriptionText(data.description);
  const covers = Array.isArray(data.covers) ? (data.covers as number[]) : [];
  const authorRefs = Array.isArray(data.authors) ? (data.authors as Record<string, unknown>[]) : [];
  const authorNames = await Promise.all(
    authorRefs.slice(0, 3).map(async (ref) => {
      const authorEntry = ref.author && typeof ref.author === "object" ? (ref.author as Record<string, unknown>) : ref;
      const authorKey = typeof authorEntry.key === "string" ? authorEntry.key : "";
      if (!authorKey) return "";
      try {
        const authorResponse = await fetch(`${OPEN_LIBRARY_BASE_URL}${authorKey}.json`, { headers: { Accept: "application/json" } });
        if (!authorResponse.ok) return "";
        const authorData = (await authorResponse.json()) as Record<string, unknown>;
        return typeof authorData.name === "string" ? authorData.name : "";
      } catch {
        return "";
      }
    }),
  );
  return {
    provider: "open_library",
    externalId: id,
    title: String(data.title ?? "Untitled"),
    creator: authorNames.filter(Boolean).join(", "),
    coverUrl: covers[0] ? `${OPEN_LIBRARY_COVER_URL}/${covers[0]}-M.jpg` : undefined,
    overview,
    // Open Library rarely has a real description; no separate grounding source exists for it.
    grounding: null,
  };
}

async function searchGoogleBooks(query: string, apiKey: string): Promise<BookSearchResult[]> {
  const keyParam = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
  const response = await fetch(`${GOOGLE_BOOKS_BASE_URL}?q=${encodeURIComponent(query)}&maxResults=20${keyParam}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Google Books request failed (${response.status})`);
  const data = (await response.json()) as { items?: Record<string, unknown>[] };
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item) => {
    const volumeInfo = (item.volumeInfo && typeof item.volumeInfo === "object" ? item.volumeInfo : {}) as Record<string, unknown>;
    const authors = Array.isArray(volumeInfo.authors) ? (volumeInfo.authors as string[]) : [];
    const imageLinks = (volumeInfo.imageLinks && typeof volumeInfo.imageLinks === "object" ? volumeInfo.imageLinks : {}) as Record<string, unknown>;
    return {
      provider: "google_books" as const,
      externalId: String(item.id ?? ""),
      title: String(volumeInfo.title ?? "Untitled"),
      creator: authors.join(", "),
      year: typeof volumeInfo.publishedDate === "string" ? volumeInfo.publishedDate.slice(0, 4) : undefined,
      coverUrl: typeof imageLinks.thumbnail === "string" ? imageLinks.thumbnail.replace(/^http:/, "https:") : undefined,
    };
  });
}

async function detailGoogleBooks(id: string, apiKey: string): Promise<BookDetail> {
  const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
  const response = await fetch(`${GOOGLE_BOOKS_BASE_URL}/${encodeURIComponent(id)}${keyParam}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Google Books request failed (${response.status})`);
  const data = (await response.json()) as Record<string, unknown>;
  const volumeInfo = (data.volumeInfo && typeof data.volumeInfo === "object" ? data.volumeInfo : {}) as Record<string, unknown>;
  const authors = Array.isArray(volumeInfo.authors) ? (volumeInfo.authors as string[]) : [];
  const imageLinks = (volumeInfo.imageLinks && typeof volumeInfo.imageLinks === "object" ? volumeInfo.imageLinks : {}) as Record<string, unknown>;
  const searchInfo = (data.searchInfo && typeof data.searchInfo === "object" ? data.searchInfo : {}) as Record<string, unknown>;
  const description = typeof volumeInfo.description === "string" ? volumeInfo.description : "";
  const snippet = typeof searchInfo.textSnippet === "string" ? searchInfo.textSnippet : "";
  const groundingText = description || snippet;
  return {
    provider: "google_books",
    externalId: id,
    title: String(volumeInfo.title ?? "Untitled"),
    creator: authors.join(", "),
    year: typeof volumeInfo.publishedDate === "string" ? volumeInfo.publishedDate.slice(0, 4) : undefined,
    coverUrl: typeof imageLinks.thumbnail === "string" ? imageLinks.thumbnail.replace(/^http:/, "https:") : undefined,
    overview: description,
    grounding: groundingText ? { sourceLabel: "Description", text: groundingText } : null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "search";
  const query = url.searchParams.get("query") || "";
  const id = url.searchParams.get("id") || "";
  const provider = normalizeProvider(url.searchParams.get("provider"));
  const googleBooksApiKey = resolveGoogleBooksApiKey(request);

  try {
    if (action === "search") {
      if (!query.trim()) return jsonError("A search query is required.");
      const results = provider === "open_library" ? await searchOpenLibrary(query.trim()) : await searchGoogleBooks(query.trim(), googleBooksApiKey);
      return NextResponse.json({ ok: true, results });
    }

    if (action === "detail") {
      if (!id.trim()) return jsonError("A book id is required.");
      const detail = provider === "open_library" ? await detailOpenLibrary(id.trim()) : await detailGoogleBooks(id.trim(), googleBooksApiKey);
      return NextResponse.json({ ok: true, detail });
    }

    return jsonError(`Unknown action: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 502);
  }
}
