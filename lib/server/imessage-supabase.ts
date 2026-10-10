/**
 * Server-side access to the user's own Supabase Storage for the iMessage bridge.
 *
 * The browser keeps its Supabase URL + service_role key in local storage only, so the
 * webhook (which runs on the server, with no browser) needs them as environment
 * variables instead:
 *
 *   IMESSAGE_SUPABASE_URL
 *   IMESSAGE_SUPABASE_SERVICE_ROLE_KEY
 *
 * They must point at the SAME project the browser's cloud backup uses, because the
 * runtime snapshot is uploaded by the browser (lib/imessage-cloud-sync.ts) into the
 * `ai-phone-backup` bucket and read back here.
 *
 * This deliberately does not import lib/cloud-backup/*: that module pulls in kv-db
 * (Dexie / IndexedDB), which has no business being loaded in a route handler.
 */

const BUCKET = "ai-phone-backup"; // keep in sync with CLOUD_BACKUP_BUCKET

export type IMessageSupabaseConfig = { url: string; key: string };

export function getIMessageSupabaseConfig(): IMessageSupabaseConfig | null {
  const url = (process.env.IMESSAGE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.IMESSAGE_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) return null;
  return { url: /^https?:\/\//i.test(url) ? url : `https://${url}`, key };
}

function headers(config: IMessageSupabaseConfig): Record<string, string> {
  return { apikey: config.key, Authorization: `Bearer ${config.key}` };
}

function objectUrl(config: IMessageSupabaseConfig, path: string): string {
  return `${config.url}/storage/v1/object/${BUCKET}/${path.replace(/^\/+/, "")}`;
}

/** Returns the object's text, or null when it does not exist. */
export async function getObjectText(config: IMessageSupabaseConfig, path: string): Promise<string | null> {
  const res = await fetch(objectUrl(config, path), { headers: headers(config), cache: "no-store" });
  if (res.status === 404 || res.status === 400) return null; // Supabase answers 400 for a missing object
  if (!res.ok) throw new Error(`Supabase GET ${path} failed (${res.status}).`);
  return res.text();
}

export async function putObjectText(config: IMessageSupabaseConfig, path: string, body: string): Promise<void> {
  const res = await fetch(objectUrl(config, path), {
    method: "POST",
    headers: { ...headers(config), "Content-Type": "application/json", "x-upsert": "true" },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase PUT ${path} failed (${res.status}).`);
}

export type ListedObject = { name: string; updatedAt?: string };

/** Newest first, by Supabase's own `updated_at`. */
export async function listRecentObjects(
  config: IMessageSupabaseConfig,
  prefix: string,
  limit: number,
): Promise<ListedObject[]> {
  const res = await fetch(`${config.url}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...headers(config), "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit, offset: 0, sortBy: { column: "updated_at", order: "desc" } }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase LIST ${prefix} failed (${res.status}).`);
  const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: String(row.name ?? ""),
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
    }))
    .filter((item) => item.name && !item.name.endsWith("/"));
}
