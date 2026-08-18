import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { normalizeRecipeParts as normalizeParts, validateMechanismPayload, type RecipePartRef } from "@/lib/mixology/hall-parts";

// House Special -- the materials/blends API. Materials (mixology_items) and blends
// (mixology_recipes) share one route, told apart by type=material|recipe. Everything reaches
// Supabase REST through the service key; anon has no direct read.
//
// A blend row's `materials` column stores only an array of SLOT REFERENCES,
// [{id,kind,name,builtin?,when?}]: builtin points at a factory material (resolved locally by
// the client), any other id points at a mixology_items entry, and `when` is that one's
// condition. The same kind may appear several times (a slot stacking several materials), and
// the array order IS the stacking order.
// The detail endpoint joins those references out into full material content, marking anything
// unpublished as gone.

const MATERIAL_KINDS = ["character", "persona", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore", "filter", "mechanism"] as const;

const ITEM_SUMMARY_COLUMNS = "id,kind,name,hook,cover,tags,author_id,author_name,author_avatar,like_count,save_count,view_count,comment_count,created_at,updated_at";
const ITEM_COLUMNS = `${ITEM_SUMMARY_COLUMNS},payload`;
const RECIPE_SUMMARY_COLUMNS = "id,name,intro,cover,char_name,part_names,author_id,author_name,author_avatar,like_count,save_count,view_count,comment_count,created_at,updated_at";
const RECIPE_COLUMNS = `${RECIPE_SUMMARY_COLUMNS},materials`;

const MAX_MATERIAL_PAYLOAD = 900_000;
// A blend stores references only rather than embedding material content, so its size ceiling
// is correspondingly tighter
const MAX_RECIPE_PARTS_PAYLOAD = 20_000;

type HallType = "material" | "recipe";

const TABLES: Record<HallType, string> = {
  material: "mixology_items",
  recipe: "mixology_recipes",
};

/**
 * CDN cache headers for listings other than "my publications". A listing carries no
 * per-user fields (likedByMe/savedByMe appear only in the detail response), so the response is
 * identical for everyone and Netlify's edge can absorb repeat traffic -- listings carry cover
 * images as base64, which is the bulk of this feature's Supabase egress.
 */
const CDN_LIST_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
  // The cache key MUST be told to include the query string: Netlify ignores query parameters
  // on function responses by default, and without this line the first cached response would
  // stand in for every type/kind/mine/id combination
  "Netlify-Vary": "query",
} as const;

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

function supabaseHeaders(config: { key: string }): HeadersInit {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampCount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.round(amount));
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
  return [];
}

function encodeFilter(value: string): string {
  return encodeURIComponent(value);
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatSupabaseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause ?? "") : "";
  const details = `${message} ${cause}`;
  if (/getaddrinfo|EAI_AGAIN|ENOTFOUND/i.test(details)) return "Could not resolve the Supabase hostname. Check the network/DNS of the environment Next is running in.";
  if (/fetch failed/i.test(message)) return "Could not reach Supabase. Check whether the environment Next is running in can access it.";
  return message;
}

function isMissingTableError(message: string): boolean {
  return /mixology_items|mixology_recipes|mixology_likes|mixology_saves|mixology_comments/i.test(message)
    && /schema cache|Could not find the table|Could not find.*column|PGRST204|PGRST205|does not exist/i.test(message);
}

async function supabaseFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  const config = getSupabaseConfig();
  if (!config) return { ok: false, error: "missing_supabase_env", status: 503 };
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...supabaseHeaders(config),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message?: unknown }).message)
      : text || response.statusText;
    if (isMissingTableError(message)) {
      return {
        ok: false,
        error: "The House Special sharing tables have not been created yet. Run docs/mixology-supabase.sql in the Supabase SQL editor first.",
        status: response.status,
      };
    }
    return { ok: false, error: message, status: response.status };
  }
  return { ok: true, data: data as T, status: response.status };
}

function parseType(value: unknown): HallType | null {
  return value === "material" || value === "recipe" ? value : null;
}

/** Validate a blend's slot references. The implementation lives in lib/mixology/hall-parts.ts,
 *  where it can be unit-tested away from the route. */
function normalizeRecipeParts(value: unknown): { parts: RecipePartRef[] } | { error: string } {
  return normalizeParts(value, { materialKinds: MATERIAL_KINDS, maxPayload: MAX_RECIPE_PARTS_PAYLOAD });
}

/** Before sharing or updating a blend, confirm every materials entry it references is still
 *  published */
async function verifyPartsOnShelf(parts: RecipePartRef[]): Promise<string | null> {
  // A stacked slot can reference the same id more than once, so dedupe rather than padding
  // out the query string for nothing
  const cloudIds = [...new Set(parts.filter(p => !p.builtin).map(p => p.id))];
  if (cloudIds.length === 0) return null;
  const result = await supabaseFetch<Array<{ id?: string }>>(
    `mixology_items?id=in.(${cloudIds.map(encodeFilter).join(",")})&deleted_at=is.null&select=id`,
  );
  if (!result.ok) return result.error;
  const found = new Set(result.data.map(item => cleanText(item.id, 160)));
  const missing = parts.filter(p => !p.builtin && !found.has(p.id)).map(p => p.name);
  if (missing.length > 0) return `These materials are not on the materials page (never published, or taken down): ${missing.join(", ")}`;
  return null;
}

function normalizeEntry(type: HallType, value: unknown, options: { withPayload?: boolean } = {}): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const name = cleanText(record.name, 80);
  if (!id || !name) return null;
  const base = {
    id,
    name,
    authorId: cleanText(record.author_id, 160) || "anonymous",
    authorName: cleanText(record.author_name, 80) || "Anonymous bartender",
    authorAvatar: cleanText(record.author_avatar, 300_000),
    cover: cleanText(record.cover, 2_000_000),
    likeCount: clampCount(record.like_count),
    saveCount: clampCount(record.save_count),
    viewCount: clampCount(record.view_count),
    commentCount: clampCount(record.comment_count),
    createdAt: cleanText(record.created_at, 80),
    updatedAt: cleanText(record.updated_at, 80),
  };
  if (type === "material") {
    const kind = cleanText(record.kind, 20);
    if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) return null;
    return {
      ...base,
      kind,
      hook: cleanText(record.hook, 200),
      tags: normalizeTags(record.tags),
      ...(options.withPayload ? { payload: record.payload ?? null } : {}),
    };
  }
  const rawParts = options.withPayload && Array.isArray(record.materials)
    ? record.materials.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(item => ({
        id: cleanText(item.id, 160),
        kind: cleanText(item.kind, 20),
        name: cleanText(item.name, 80),
        ...(item.builtin === true ? { builtin: true } : {}),
      }))
      .filter(part => part.id && part.name && (MATERIAL_KINDS as readonly string[]).includes(part.kind))
    : undefined;
  return {
    ...base,
    intro: cleanText(record.intro, 400),
    charName: cleanText(record.char_name, 80),
    partNames: normalizeTags(record.part_names),
    ...(rawParts ? { parts: rawParts } : {}),
  };
}

/** The blend detail join: swap each cloud reference for the entry's full material content,
 *  marking anything taken down as gone */
async function hydrateRecipeParts(entry: Record<string, unknown>): Promise<void> {
  const parts = Array.isArray(entry.parts) ? entry.parts as Array<Record<string, unknown>> : [];
  const cloudIds = [...new Set(parts.filter(p => p.builtin !== true).map(p => String(p.id)))];
  if (cloudIds.length === 0) return;
  const result = await supabaseFetch<unknown[]>(
    `mixology_items?id=in.(${cloudIds.map(encodeFilter).join(",")})&deleted_at=is.null&select=${ITEM_COLUMNS}`,
  );
  const found = new Map<string, Record<string, unknown>>();
  if (result.ok) {
    for (const item of result.data) {
      const normalized = normalizeEntry("material", item, { withPayload: true });
      if (normalized) found.set(normalized.id as string, normalized);
    }
  }
  entry.parts = parts.map(part => {
    if (part.builtin === true) return part;
    const item = found.get(String(part.id));
    const payload = item?.payload;
    if (!item || !payload || typeof payload !== "object") return { ...part, gone: true };
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      authorName: item.authorName,
      authorAvatar: item.authorAvatar,
      material: { ...(payload as Record<string, unknown>), id: item.id, kind: item.kind, name: item.name },
    };
  });
}

async function annotateMine(type: HallType, entries: Record<string, unknown>[], userId: string): Promise<void> {
  if (!userId || entries.length === 0) return;
  const [likes, saves] = await Promise.all([
    supabaseFetch<Array<{ target_id?: string }>>(
      `mixology_likes?target_type=eq.${type}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
    ),
    supabaseFetch<Array<{ target_id?: string }>>(
      `mixology_saves?target_type=eq.${type}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
    ),
  ]);
  const likedIds = new Set(likes.ok ? likes.data.map(item => item.target_id).filter(Boolean) : []);
  const savedIds = new Set(saves.ok ? saves.data.map(item => item.target_id).filter(Boolean) : []);
  for (const entry of entries) {
    entry.likedByMe = likedIds.has(entry.id as string);
    entry.savedByMe = savedIds.has(entry.id as string);
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = parseType(url.searchParams.get("type"));
    if (!type) return NextResponse.json({ ok: false, error: "missing_type", entries: [] }, { status: 400 });
    const account = await getCurrentAccount(request);
    const userId = account?.id || "";
    const table = TABLES[type];
    const requestedId = cleanText(url.searchParams.get("id"), 160);

    if (requestedId) {
      // The full payload goes to signed-in users only: a creator's complete card source is not
      // served anonymously
      if (!account) return NextResponse.json({ ok: false, error: "Sign in to view the details." }, { status: 401 });
      const columns = type === "material" ? ITEM_COLUMNS : RECIPE_COLUMNS;
      const result = await supabaseFetch<unknown[]>(
        `${table}?id=eq.${encodeFilter(requestedId)}&deleted_at=is.null&select=${columns}&limit=1`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
      const entry = normalizeEntry(type, result.data[0], { withPayload: true });
      if (!entry) return NextResponse.json({ ok: false, error: "That content could not be found." }, { status: 404 });
      if (type === "recipe") await hydrateRecipeParts(entry);
      await annotateMine(type, [entry], userId);
      // Bump the view count, best-effort and never blocking the response
      void supabaseFetch<unknown[]>(
        `${table}?id=eq.${encodeFilter(requestedId)}&deleted_at=is.null&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ view_count: clampCount(entry.viewCount) + 1 }),
        },
      );
      return NextResponse.json({ ok: true, entry });
    }

    const columns = type === "material" ? ITEM_SUMMARY_COLUMNS : RECIPE_SUMMARY_COLUMNS;
    const filters = [`deleted_at=is.null`, `select=${columns}`, "order=updated_at.desc", "limit=100"];
    if (type === "material") {
      const kind = cleanText(url.searchParams.get("kind"), 20);
      if ((MATERIAL_KINDS as readonly string[]).includes(kind)) filters.unshift(`kind=eq.${kind}`);
    }
    const isMine = url.searchParams.get("mine") === "1";
    if (isMine) {
      if (!account) return NextResponse.json({ ok: true, entries: [] });
      filters.unshift(`author_id=eq.${encodeFilter(userId)}`);
    }
    const result = await supabaseFetch<unknown[]>(`${table}?${filters.join("&")}`);
    if (!result.ok) {
      if (/mixology-supabase\.sql/.test(result.error)) {
        return NextResponse.json({ ok: true, entries: [], setupRequired: true, error: result.error });
      }
      return NextResponse.json({ ok: false, error: result.error, entries: [] }, { status: result.status });
    }
    const entries = result.data
      .map(item => normalizeEntry(type, item))
      .filter(Boolean) as Record<string, unknown>[];
    // Listings carry no per-user annotation (likedByMe/savedByMe are only needed in the detail
    // response), so the response is identical for everyone and a public listing can go into the
    // CDN wholesale. "My publications" filters by account and is not cached.
    return NextResponse.json({ ok: true, entries }, isMine ? undefined : { headers: CDN_LIST_CACHE_HEADERS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err), entries: [] }, { status: getSupabaseConfig() ? 500 : 503 });
  }
}

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    if (!type) return NextResponse.json({ ok: false, error: "missing_type" }, { status: 400 });
    const name = cleanText(record.name, 80);
    if (!name) return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });
    const now = new Date().toISOString();

    if (type === "material") {
      const kind = cleanText(record.kind, 20);
      if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json({ ok: false, error: "unknown_material_kind" }, { status: 400 });
      }
      const payload = record.payload;
      if (!payload || typeof payload !== "object") {
        return NextResponse.json({ ok: false, error: "missing_payload" }, { status: 400 });
      }
      if (JSON.stringify(payload).length > MAX_MATERIAL_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "That material is too large. Try a smaller cover image." }, { status: 413 });
      }
      if (kind === "mechanism") {
        const invalid = validateMechanismPayload(payload);
        if (invalid) return NextResponse.json({ ok: false, error: invalid }, { status: 400 });
      }
      const insert = await supabaseFetch<unknown[]>(
        `mixology_items?select=${ITEM_COLUMNS}`,
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            id: createId("mxi"),
            kind,
            name,
            hook: cleanText(record.hook, 200),
            cover: cleanText(record.cover, 2_000_000),
            tags: normalizeTags(record.tags),
            payload,
            author_id: account.id,
            author_name: cleanText(record.authorName, 80) || account.displayName,
            author_avatar: cleanText(record.authorAvatar, 300_000),
            created_at: now,
            updated_at: now,
          }),
        },
      );
      if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: insert.status });
      return NextResponse.json({ ok: true, entry: normalizeEntry("material", insert.data[0], { withPayload: true }) });
    }

    const normalized = normalizeRecipeParts(record.parts);
    if ("error" in normalized) {
      return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
    }
    const shelfError = await verifyPartsOnShelf(normalized.parts);
    if (shelfError) return NextResponse.json({ ok: false, error: shelfError }, { status: 409 });
    const insert = await supabaseFetch<unknown[]>(
      `mixology_recipes?select=${RECIPE_COLUMNS}`,
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: createId("mxr"),
          name,
          intro: cleanText(record.intro, 400),
          cover: cleanText(record.cover, 2_000_000),
          char_name: cleanText(record.charName, 80),
          part_names: normalizeTags(record.partNames),
          materials: normalized.parts,
          author_id: account.id,
          author_name: cleanText(record.authorName, 80) || account.displayName,
          author_avatar: cleanText(record.authorAvatar, 300_000),
          created_at: now,
          updated_at: now,
        }),
      },
    );
    if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: insert.status });
    return NextResponse.json({ ok: true, entry: normalizeEntry("recipe", insert.data[0], { withPayload: true }) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const name = cleanText(record.name, 80);
    if (!name) return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });

    // Update the content only, never the like/save/view/comment counts or created_at -- an
    // update should not reset a listing's social history
    let payload: Record<string, unknown>;
    if (type === "material") {
      const kind = cleanText(record.kind, 20);
      if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json({ ok: false, error: "unknown_material_kind" }, { status: 400 });
      }
      const materialPayload = record.payload;
      if (!materialPayload || typeof materialPayload !== "object") {
        return NextResponse.json({ ok: false, error: "missing_payload" }, { status: 400 });
      }
      if (JSON.stringify(materialPayload).length > MAX_MATERIAL_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "That material is too large. Try a smaller cover image." }, { status: 413 });
      }
      if (kind === "mechanism") {
        const invalid = validateMechanismPayload(materialPayload);
        if (invalid) return NextResponse.json({ ok: false, error: invalid }, { status: 400 });
      }
      payload = {
        kind,
        name,
        hook: cleanText(record.hook, 200),
        cover: cleanText(record.cover, 2_000_000),
        tags: normalizeTags(record.tags),
        payload: materialPayload,
        // Refresh the credit and avatar on update too: the published identity follows whatever
        // the creator profile currently says
        author_name: cleanText(record.authorName, 80) || account.displayName,
        author_avatar: cleanText(record.authorAvatar, 300_000),
        updated_at: new Date().toISOString(),
      };
    } else {
      const normalized = normalizeRecipeParts(record.parts);
      if ("error" in normalized) {
        return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
      }
      const shelfError = await verifyPartsOnShelf(normalized.parts);
      if (shelfError) return NextResponse.json({ ok: false, error: shelfError }, { status: 409 });
      payload = {
        name,
        intro: cleanText(record.intro, 400),
        cover: cleanText(record.cover, 2_000_000),
        char_name: cleanText(record.charName, 80),
        part_names: normalizeTags(record.partNames),
        materials: normalized.parts,
        author_name: cleanText(record.authorName, 80) || account.displayName,
        author_avatar: cleanText(record.authorAvatar, 300_000),
        updated_at: new Date().toISOString(),
      };
    }

    const columns = type === "material" ? ITEM_COLUMNS : RECIPE_COLUMNS;
    const result = await supabaseFetch<unknown[]>(
      `${TABLES[type]}?id=eq.${encodeFilter(id)}&author_id=eq.${encodeFilter(account.id)}&deleted_at=is.null&select=${columns}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      // Either taken down by its own author, or never theirs. Let the client clear its local
      // publish link and fall back to publishing afresh.
      return NextResponse.json({ ok: false, error: "No published content found to update; it may have been taken down.", gone: true }, { status: 404 });
    }
    return NextResponse.json({ ok: true, entry: normalizeEntry(type, result.data[0], { withPayload: true }) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    const action = cleanText(record.action, 40);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const table = TABLES[type];
    const userId = account.id;

    const currentResult = await supabaseFetch<unknown[]>(
      `${table}?id=eq.${encodeFilter(id)}&deleted_at=is.null&select=id,like_count,save_count`,
    );
    if (!currentResult.ok) return NextResponse.json({ ok: false, error: currentResult.error }, { status: currentResult.status });
    const current = currentResult.data[0] as Record<string, unknown> | undefined;
    if (!current) return NextResponse.json({ ok: false, error: "That content could not be found." }, { status: 404 });

    let liked = false;
    let saved = false;
    let likeCount = clampCount(current.like_count);
    let saveCount = clampCount(current.save_count);

    if (action === "toggle_like") {
      const existing = await supabaseFetch<unknown[]>(
        `mixology_likes?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
      );
      if (!existing.ok) return NextResponse.json({ ok: false, error: existing.error }, { status: existing.status });
      if (existing.data.length > 0) {
        const removed = await supabaseFetch<unknown[]>(
          `mixology_likes?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}`,
          { method: "DELETE" },
        );
        if (!removed.ok) return NextResponse.json({ ok: false, error: removed.error }, { status: removed.status });
        likeCount = Math.max(0, likeCount - 1);
        liked = false;
      } else {
        const added = await supabaseFetch<unknown[]>(
          "mixology_likes",
          {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ target_type: type, target_id: id, user_id: userId }),
          },
        );
        if (!added.ok) return NextResponse.json({ ok: false, error: added.error }, { status: added.status });
        likeCount += 1;
        liked = true;
      }
    } else if (action === "save") {
      const existing = await supabaseFetch<unknown[]>(
        `mixology_saves?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
      );
      if (!existing.ok) return NextResponse.json({ ok: false, error: existing.error }, { status: existing.status });
      if (existing.data.length === 0) {
        const added = await supabaseFetch<unknown[]>(
          "mixology_saves",
          {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ target_type: type, target_id: id, user_id: userId }),
          },
        );
        if (!added.ok) return NextResponse.json({ ok: false, error: added.error }, { status: added.status });
        saveCount += 1;
      }
      saved = true;
    } else {
      return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
    }

    const update = await supabaseFetch<unknown[]>(
      `${table}?id=eq.${encodeFilter(id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ like_count: likeCount, save_count: saveCount }),
      },
    );
    if (!update.ok) return NextResponse.json({ ok: false, error: update.error }, { status: update.status });
    return NextResponse.json({ ok: true, liked, saved, likeCount, saveCount });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const result = await supabaseFetch<unknown[]>(
      `${TABLES[type]}?id=eq.${encodeFilter(id)}&author_id=eq.${encodeFilter(account.id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      return NextResponse.json({ ok: false, error: "No content found to take down." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getSupabaseConfig() ? 400 : 503 });
  }
}
