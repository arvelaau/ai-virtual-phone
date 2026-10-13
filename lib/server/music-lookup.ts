// lib/server/music-lookup.ts
// Reads a public Spotify / Apple Music link, and turns a song title into a REAL link.
//
// Sources, all keyless:
//   Spotify      open.spotify.com/oembed (title, cover) + the embed page (artist, album, tracks)
//   Apple Music  itunes.apple.com/lookup and /search (the public iTunes catalog API), and the
//                page's og tags for playlists
// Spotify search needs credentials, so it is used only when SPOTIFY_CLIENT_ID and
// SPOTIFY_CLIENT_SECRET are set; otherwise a song is linked on Apple Music.
//
// Safety: every request goes to a fixed host, a cover is only fetched from the services' own
// image hosts (https, capped size, no redirects), and nothing here is an open proxy.

import {
    formatMusicContext,
    isAllowedMusicImageHost,
    parseMusicUrl,
    parseSpotifyEmbedHtml,
    type MusicInfo,
    type MusicRef,
} from "../music-link";

export type MusicLookupResult =
    | { ok: true; info: MusicInfo; imageDataUrl?: string }
    | { ok: false; code: "bad_url" | "not_music" | "unreadable" | "timeout"; error: string; ref?: MusicRef };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_IMAGE_BYTES = 1_500_000;
const MAX_PAGE_BYTES = 900_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function readText(res: Response, maxBytes: number): Promise<string> {
    const buf = new Uint8Array(await res.arrayBuffer());
    return new TextDecoder("utf-8").decode(buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf);
}

/** Apple serves the same cover at many sizes; 300px is plenty for the model and light to move. */
function sizedCover(url: string): string {
    return url.replace(/\/(\d+)x(\d+)(bb|SC\.[A-Z0-9-]+)?\.(jpg|png|webp)(\?.*)?$/i, (_m, _w, _h, tag, ext, query) => `/300x300${tag || "bb"}.${ext}${query || ""}`);
}

async function fetchCover(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string | undefined> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" || !isAllowedMusicImageHost(parsed.hostname)) return undefined;
    try {
        const res = await timedFetch(fetchImpl, sizedCover(url), { headers: { "User-Agent": UA, Accept: "image/*" }, redirect: "error" }, timeoutMs);
        if (!res.ok) return undefined;
        const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return undefined;
        if (Number(res.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return undefined;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
        return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
        return undefined;
    }
}

function strOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function yearOf(value: unknown): string {
    const m = /^(\d{4})/.exec(strOf(value));
    return m ? m[1] : "";
}

// ---- Spotify ---------------------------------------------------------------------------------

async function lookupSpotify(ref: MusicRef, fetchImpl: FetchLike, timeoutMs: number): Promise<{ info: MusicInfo; imageUrl?: string } | { error: string }> {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(ref.canonicalUrl)}`;
    const embedUrl = `https://open.spotify.com/embed/${ref.kind}/${ref.id}`;
    const [oembed, embed] = await Promise.all([
        timedFetch(fetchImpl, oembedUrl, { headers: { "User-Agent": UA, Accept: "application/json" } }, timeoutMs)
            .then(async (res) => ({ status: res.status, data: res.ok ? await res.json().catch(() => null) as { title?: unknown; thumbnail_url?: unknown } | null : null }))
            .catch(() => ({ status: 0, data: null })),
        timedFetch(fetchImpl, embedUrl, { headers: { "User-Agent": UA, Accept: "text/html" } }, timeoutMs)
            .then(async (res) => (res.ok ? parseSpotifyEmbedHtml(await readText(res, MAX_PAGE_BYTES)) : null))
            .catch(() => null),
    ]);

    const title = strOf(embed?.title) || strOf(oembed.data?.title);
    if (!title) {
        return { error: oembed.status === 404 ? "That Spotify link was not found (removed, private, or a wrong id)." : `Spotify did not return anything (${oembed.status || "no answer"}).` };
    }
    const info: MusicInfo = {
        service: "spotify",
        kind: ref.kind,
        url: ref.canonicalUrl,
        title,
        ...(embed?.by ? { by: embed.by } : {}),
        ...(embed?.year ? { year: embed.year } : {}),
        ...(embed?.tracks?.length && ref.kind !== "track" ? { tracks: embed.tracks, trackCount: embed.trackCount } : {}),
    };
    const imageUrl = strOf(oembed.data?.thumbnail_url) || undefined;
    return { info, imageUrl };
}

// ---- Apple Music -----------------------------------------------------------------------------

type ItunesRow = Record<string, unknown>;

async function itunesLookup(id: string, country: string, extra: string, fetchImpl: FetchLike, timeoutMs: number): Promise<ItunesRow[]> {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}${extra}`;
    const res = await timedFetch(fetchImpl, url, { headers: { "User-Agent": UA, Accept: "application/json" } }, timeoutMs);
    if (!res.ok) throw new Error(`Apple answered ${res.status}.`);
    const data = await res.json().catch(() => null) as { results?: ItunesRow[] } | null;
    return Array.isArray(data?.results) ? data!.results! : [];
}

async function lookupApplePlaylistPage(ref: MusicRef, fetchImpl: FetchLike, timeoutMs: number): Promise<{ info: MusicInfo; imageUrl?: string } | { error: string }> {
    const url = `https://music.apple.com/${ref.country}/playlist/_/${ref.id}`;
    const res = await timedFetch(fetchImpl, url, { headers: { "User-Agent": UA, Accept: "text/html" } }, timeoutMs);
    if (!res.ok) return { error: res.status === 404 ? "That Apple Music playlist was not found." : `Apple Music answered ${res.status}.` };
    const html = await readText(res, MAX_PAGE_BYTES);
    const meta = (prop: string): string => {
        const m = new RegExp(`<meta[^>]*property="og:${prop}"[^>]*content="([^"]*)"`, "i").exec(html);
        return m ? m[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"") : "";
    };
    const title = meta("title").replace(/\s+on Apple Music$/i, "").trim();
    if (!title) return { error: "The playlist page had no title." };
    const count = /(\d+)\s+Songs?/i.exec(meta("description"));
    return {
        info: { service: "apple_music", kind: "playlist", url: ref.canonicalUrl, title, ...(count ? { trackCount: Number(count[1]) } : {}) },
        imageUrl: meta("image") || undefined,
    };
}

async function lookupApple(ref: MusicRef, fetchImpl: FetchLike, timeoutMs: number): Promise<{ info: MusicInfo; imageUrl?: string } | { error: string }> {
    if (ref.kind === "playlist") return lookupApplePlaylistPage(ref, fetchImpl, timeoutMs);

    const wantId = ref.kind === "track" ? (ref.trackId || ref.id) : ref.id;
    const extra = ref.kind === "album" ? "&entity=song&limit=7" : ref.kind === "artist" ? "&entity=album&limit=5" : "";
    let rows = await itunesLookup(wantId, ref.country, extra, fetchImpl, timeoutMs);
    if (rows.length === 0 && ref.country !== "us") rows = await itunesLookup(wantId, "us", extra, fetchImpl, timeoutMs);
    if (rows.length === 0) return { error: "That Apple Music link was not found (removed, or not in a public storefront)." };

    const head = rows[0];
    const imageUrl = strOf(head.artworkUrl100) || strOf(head.artworkUrl60) || undefined;
    if (ref.kind === "track") {
        const title = strOf(head.trackName);
        if (!title) return { error: "That link did not resolve to a song." };
        return {
            info: {
                service: "apple_music", kind: "track", url: ref.canonicalUrl, title,
                ...(strOf(head.artistName) ? { by: strOf(head.artistName) } : {}),
                ...(strOf(head.collectionName) ? { album: strOf(head.collectionName) } : {}),
                ...(yearOf(head.releaseDate) ? { year: yearOf(head.releaseDate) } : {}),
            },
            imageUrl,
        };
    }
    if (ref.kind === "album") {
        const title = strOf(head.collectionName);
        if (!title) return { error: "That link did not resolve to an album." };
        const tracks = rows.slice(1).map((r) => strOf(r.trackName)).filter(Boolean).slice(0, 5);
        const trackCount = typeof head.trackCount === "number" ? head.trackCount : undefined;
        return {
            info: {
                service: "apple_music", kind: "album", url: ref.canonicalUrl, title,
                ...(strOf(head.artistName) ? { by: strOf(head.artistName) } : {}),
                ...(yearOf(head.releaseDate) ? { year: yearOf(head.releaseDate) } : {}),
                ...(tracks.length ? { tracks } : {}),
                ...(trackCount ? { trackCount } : {}),
            },
            imageUrl,
        };
    }
    // artist
    const title = strOf(head.artistName);
    if (!title) return { error: "That link did not resolve to an artist." };
    const albums = rows.slice(1).map((r) => strOf(r.collectionName)).filter(Boolean).slice(0, 4);
    return {
        info: { service: "apple_music", kind: "artist", url: ref.canonicalUrl, title, ...(albums.length ? { tracks: albums } : {}) },
        imageUrl: undefined,
    };
}

// ---- public entry points ---------------------------------------------------------------------

export async function lookupMusicLink(
    rawUrl: string,
    options: { fetchImpl?: FetchLike; wantImage?: boolean; timeoutMs?: number } = {},
): Promise<MusicLookupResult> {
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const timeoutMs = options.timeoutMs ?? 8000;

    let probe: URL;
    try {
        probe = new URL(rawUrl.trim());
    } catch {
        return { ok: false, code: "bad_url", error: "That is not a valid link." };
    }
    if (probe.protocol !== "https:" && probe.protocol !== "http:") return { ok: false, code: "bad_url", error: "Only web links are supported." };
    const ref = parseMusicUrl(rawUrl);
    if (!ref) return { ok: false, code: "not_music", error: "That is not a link to a Spotify or Apple Music item." };

    try {
        const found = ref.service === "spotify"
            ? await lookupSpotify(ref, fetchImpl, timeoutMs)
            : await lookupApple(ref, fetchImpl, timeoutMs);
        if ("error" in found) return { ok: false, code: "unreadable", error: found.error, ref };
        const imageDataUrl = options.wantImage && found.imageUrl ? await fetchCover(found.imageUrl, fetchImpl, timeoutMs) : undefined;
        return { ok: true, info: found.info, ...(imageDataUrl ? { imageDataUrl } : {}) };
    } catch (err) {
        const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
        return aborted
            ? { ok: false, code: "timeout", error: "The music service took too long to answer.", ref }
            : { ok: false, code: "unreadable", error: err instanceof Error ? err.message.slice(0, 160) : "lookup failed", ref };
    }
}

export type MusicSearchHit = { service: "spotify" | "apple_music"; title: string; artist: string; url: string };

type Env = Record<string, string | undefined>;

let spotifyTokenCache: { token: string; expiresAt: number; key: string } | null = null;

async function spotifyToken(env: Env, fetchImpl: FetchLike, timeoutMs: number, now: number): Promise<string | null> {
    const id = env.SPOTIFY_CLIENT_ID;
    const secret = env.SPOTIFY_CLIENT_SECRET;
    if (!id || !secret) return null;
    const key = `${id}:${secret.length}`;
    if (spotifyTokenCache && spotifyTokenCache.key === key && spotifyTokenCache.expiresAt > now + 30_000) return spotifyTokenCache.token;
    const res = await timedFetch(fetchImpl, "https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    const token = strOf(data?.access_token);
    if (!token) return null;
    const ttl = typeof data?.expires_in === "number" ? data.expires_in * 1000 : 3_000_000;
    spotifyTokenCache = { token, key, expiresAt: now + ttl };
    return token;
}

async function searchSpotify(query: string, env: Env, fetchImpl: FetchLike, timeoutMs: number, now: number): Promise<MusicSearchHit | null> {
    const token = await spotifyToken(env, fetchImpl, timeoutMs, now);
    if (!token) return null;
    const res = await timedFetch(fetchImpl, `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null) as { tracks?: { items?: Array<{ name?: unknown; artists?: Array<{ name?: unknown }>; external_urls?: { spotify?: unknown } }> } } | null;
    const item = data?.tracks?.items?.[0];
    const url = strOf(item?.external_urls?.spotify);
    if (!item || !url || !parseMusicUrl(url)) return null;
    return {
        service: "spotify",
        title: strOf(item.name),
        artist: (item.artists ?? []).map((a) => strOf(a?.name)).filter(Boolean).join(", "),
        url,
    };
}

async function searchApple(query: string, fetchImpl: FetchLike, timeoutMs: number): Promise<MusicSearchHit | null> {
    const res = await timedFetch(fetchImpl, `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1&country=us`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null) as { results?: ItunesRow[] } | null;
    const row = data?.results?.[0];
    const raw = strOf(row?.trackViewUrl);
    const ref = raw ? parseMusicUrl(raw) : null;
    if (!row || !ref) return null;
    return { service: "apple_music", title: strOf(row.trackName), artist: strOf(row.artistName), url: ref.canonicalUrl };
}

/**
 * Finds a real link for a song the character named. `prefer: "spotify"` is honoured only when
 * Spotify credentials are configured; otherwise (and when Spotify finds nothing) Apple Music.
 */
export async function searchMusicLink(
    query: string,
    options: { prefer?: "spotify" | "apple_music"; fetchImpl?: FetchLike; env?: Env; timeoutMs?: number; now?: number } = {},
): Promise<MusicSearchHit | null> {
    const q = query.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!q) return null;
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const timeoutMs = options.timeoutMs ?? 6000;
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    const now = options.now ?? Date.now();
    try {
        if (options.prefer === "spotify") {
            const hit = await searchSpotify(q, env, fetchImpl, timeoutMs, now).catch(() => null);
            if (hit) return hit;
        }
        return await searchApple(q, fetchImpl, timeoutMs);
    } catch {
        return null;
    }
}

/**
 * Is this link a real item? `true` / `false` when the service said so, `null` when it could not
 * be told (network trouble, or a kind there is no cheap check for), in which case the link is
 * left alone.
 */
export async function verifyMusicLink(
    rawUrl: string,
    options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<boolean | null> {
    const ref = parseMusicUrl(rawUrl);
    if (!ref) return null;
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const timeoutMs = options.timeoutMs ?? 5000;
    try {
        if (ref.service === "spotify") {
            const res = await timedFetch(fetchImpl, `https://open.spotify.com/oembed?url=${encodeURIComponent(ref.canonicalUrl)}`, { headers: { "User-Agent": UA, Accept: "application/json" } }, timeoutMs);
            if (res.ok) return true;
            return res.status === 404 || res.status === 400 ? false : null;
        }
        if (ref.kind === "playlist") return null;
        const rows = await itunesLookup(ref.kind === "track" ? (ref.trackId || ref.id) : ref.id, ref.country, "", fetchImpl, timeoutMs);
        if (rows.length > 0) return true;
        if (ref.country !== "us") {
            const us = await itunesLookup(ref.kind === "track" ? (ref.trackId || ref.id) : ref.id, "us", "", fetchImpl, timeoutMs);
            return us.length > 0;
        }
        return false;
    } catch {
        return null;
    }
}

export { formatMusicContext };
