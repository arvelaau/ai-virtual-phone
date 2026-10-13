// lib/server/tiktok-lookup.ts
// Turns a TikTok link into what can be read without watching it: creator, caption, hashtags
// and the cover frame. Server-side because TikTok's endpoints and CDN do not allow the
// browser to read them cross-origin.
//
// Safety: this is NOT an open proxy. Only TikTok hosts are fetched, redirects are followed by
// hand and every hop is re-checked against the allowlist, and cover images are only fetched
// from TikTok's CDN hosts with a size cap.

import {
    canonicalizeTikTokUrl,
    extractHashtags,
    isAllowedTikTokHost,
    isAllowedTikTokImageHost,
    isShortTikTokLink,
    type TikTokInfo,
} from "../tiktok-link";

export type TikTokLookupResult =
    | { ok: true; info: TikTokInfo; thumbnailDataUrl?: string }
    | { ok: false; code: "bad_url" | "not_tiktok" | "unreadable" | "timeout"; error: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 4;
const MAX_THUMBNAIL_BYTES = 1_500_000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** Follows a vm./vt./tiktok.com/t/ short link by hand, never leaving TikTok's hosts. */
export async function resolveShortLink(startUrl: string, fetchImpl: FetchLike, timeoutMs = 6000): Promise<string> {
    let current = startUrl;
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const url = new URL(current);
        if (!isAllowedTikTokHost(url.hostname)) throw new Error("redirected away from TikTok");
        if (!isShortTikTokLink(url)) return current;
        const res = await timedFetch(fetchImpl, current, {
            method: "GET",
            redirect: "manual",
            headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
        }, timeoutMs);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
            current = new URL(location, current).toString();
            continue;
        }
        return current;
    }
    return current;
}

function metaContent(html: string, property: string): string {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, "i");
    const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, "i");
    const m = re.exec(html) || alt.exec(html);
    return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}

async function fromOEmbed(videoUrl: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Partial<TikTokInfo> | null> {
    const res = await timedFetch(fetchImpl, `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, {
        headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return null;
    const title = typeof data.title === "string" ? data.title : "";
    const author = typeof data.author_name === "string" ? data.author_name : "";
    if (!title && !author) return null;
    return {
        title,
        author,
        authorUrl: typeof data.author_url === "string" ? data.author_url : "",
        thumbnailUrl: typeof data.thumbnail_url === "string" ? data.thumbnail_url : undefined,
        source: "oembed",
    };
}

async function fromPage(videoUrl: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Partial<TikTokInfo> | null> {
    const res = await timedFetch(fetchImpl, videoUrl, {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    }, timeoutMs);
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400_000);
    const title = metaContent(html, "og:description") || metaContent(html, "og:title") || metaContent(html, "description");
    const image = metaContent(html, "og:image");
    if (!title && !image) return null;
    const authorMatch = /tiktok\.com\/@([A-Za-z0-9._]+)/.exec(videoUrl);
    return {
        title,
        author: authorMatch ? `@${authorMatch[1]}` : "",
        authorUrl: authorMatch ? `https://www.tiktok.com/@${authorMatch[1]}` : "",
        thumbnailUrl: image || undefined,
        source: "page",
    };
}

async function fetchThumbnail(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string | undefined> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" || !isAllowedTikTokImageHost(parsed.hostname)) return undefined;
    try {
        const res = await timedFetch(fetchImpl, url, { headers: { "User-Agent": BROWSER_UA, Accept: "image/*" }, redirect: "error" }, timeoutMs);
        if (!res.ok) return undefined;
        const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return undefined;
        const declared = Number(res.headers.get("content-length") || 0);
        if (declared > MAX_THUMBNAIL_BYTES) return undefined;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return undefined;
        return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
        return undefined;
    }
}

export async function lookupTikTok(
    rawUrl: string,
    options: { fetchImpl?: FetchLike; wantThumbnail?: boolean; timeoutMs?: number } = {},
): Promise<TikTokLookupResult> {
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const timeoutMs = options.timeoutMs ?? 8000;

    let parsed: URL;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return { ok: false, code: "bad_url", error: "That is not a valid link." };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, code: "bad_url", error: "Only web links are supported." };
    if (!isAllowedTikTokHost(parsed.hostname)) return { ok: false, code: "not_tiktok", error: "That is not a TikTok link." };

    try {
        let resolved = parsed.toString();
        if (isShortTikTokLink(parsed)) resolved = await resolveShortLink(resolved, fetchImpl, Math.min(timeoutMs, 6000));
        const resolvedUrl = new URL(resolved);
        if (!isAllowedTikTokHost(resolvedUrl.hostname)) return { ok: false, code: "not_tiktok", error: "The link does not lead to TikTok." };
        const canonical = canonicalizeTikTokUrl(resolved);

        let base = await fromOEmbed(canonical, fetchImpl, timeoutMs).catch(() => null);
        if (!base) base = await fromPage(canonical, fetchImpl, timeoutMs).catch(() => null);
        if (!base) return { ok: false, code: "unreadable", error: "TikTok did not return anything readable for this link (private, removed, or blocked)." };

        const title = (base.title || "").trim();
        const info: TikTokInfo = {
            url: rawUrl.trim(),
            canonicalUrl: canonical,
            title,
            author: (base.author || "").trim(),
            authorUrl: base.authorUrl || "",
            hashtags: extractHashtags(title),
            thumbnailUrl: base.thumbnailUrl,
            source: base.source ?? "oembed",
        };
        const thumbnailDataUrl = options.wantThumbnail && info.thumbnailUrl
            ? await fetchThumbnail(info.thumbnailUrl, fetchImpl, timeoutMs)
            : undefined;
        return { ok: true, info, ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}) };
    } catch (err) {
        const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
        return aborted
            ? { ok: false, code: "timeout", error: "TikTok took too long to answer." }
            : { ok: false, code: "unreadable", error: err instanceof Error ? err.message.slice(0, 160) : "lookup failed" };
    }
}
