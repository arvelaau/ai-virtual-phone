/**
 * The Supabase connection used by House Special, and only by House Special.
 *
 * Its data — the five tables mixology_items / mixology_recipes / mixology_likes /
 * mixology_saves / mixology_comments — lives in its own Supabase project, reached through
 * exactly two environment variables:
 *
 *   MIXOLOGY_SUPABASE_URL
 *   MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY
 *
 * There is deliberately NO fallback here. With those two unset, the feature behaves as
 * "the House Special database is not connected" (setupRequired / 503); it never falls back
 * to the main SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. The main database is now only the
 * account and session line (getCurrentAccount, via lib/server/supabase-rest.ts) — and a
 * fallback would silently land House Special reads and writes in that database instead,
 * where they would not match the real one.
 */
import { encodeSupabaseFilter, formatSupabaseRestError } from "./supabase-rest";

type MixologySupabaseConfig = {
  url: string;
  key: string;
};

export type MixologyRestResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number };

export function getMixologySupabaseConfig(): MixologySupabaseConfig | null {
  const url = (process.env.MIXOLOGY_SUPABASE_URL ?? "").trim();
  const key = (process.env.MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export function mixologySupabaseHeaders(config: { key: string }): HeadersInit {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
}

export async function mixologyRestFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<MixologyRestResult<T>> {
  const config = getMixologySupabaseConfig();
  // Prefixed with mixology_, but the missing_supabase_env SUBSTRING is preserved on purpose:
  // components/mixology/mixology-hall.tsx matches /missing_supabase_env/ to tell "this is a
  // local deployment with no cloud backend" apart from a transient network error.
  if (!config) return { ok: false, error: "mixology_missing_supabase_env", status: 503 };

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...mixologySupabaseHeaders(config),
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
    return { ok: false, error: message, status: response.status };
  }

  return { ok: true, data: data as T, status: response.status };
}

// Pure string handling, unrelated to which database is connected, so the main-database
// implementations are reused directly. Re-exported here so everything under
// app/api/mixology/** imports this ONE module -- which is what makes a stray main-database
// reference greppable.
export { encodeSupabaseFilter as encodeMixologyFilter, formatSupabaseRestError as formatMixologyError };
