// lib/server/x-lookup.ts
// Reads a public X (Twitter) post from its link, server-side.
//
// Uses the syndication endpoint that X's own embedded-post widget uses; no login and no API
// key. It is an UNDOCUMENTED endpoint, so it is treated as best-effort: every failure becomes
// an honest "could not read" instead of an error.
//
// Safety: only the status-link hosts in lib/x-link.ts are accepted, the request goes to one
// fixed host, and a picture is only fetched from X's own image hosts (https, capped size).

import {
    isAllowedXImageHost,
    parseSyndicationPost,
    parseXStatusUrl,
    syndicationToken,
    type XPostInfo,
} from "../x-link";

export type XLookupResult =
    | { ok: true; info: XPostInfo; imageDataUrl?: string }
    | { ok: false; code: "bad_url" | "not_x" | "unreadable" | "timeout"; error: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_IMAGE_BYTES = 1_500_000;
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

/** `name=small` keeps the download light; X serves the same picture at several sizes. */
function sizedImageUrl(url: string): string {
    try {
        const u = new URL(url);
        if (u.hostname === "pbs.twimg.com" && !u.searchParams.has("name")) u.searchParams.set("name", "medium");
        return u.toString();
    } catch {
        return url;
    }
}

async function fetchImage(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string | undefined> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" || !isAllowedXImageHost(parsed.hostname)) return undefined;
    try {
        const res = await timedFetch(fetchImpl, sizedImageUrl(url), { headers: { "User-Agent": UA, Accept: "image/*" }, redirect: "error" }, timeoutMs);
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

export async function lookupXPost(
    rawUrl: string,
    options: { fetchImpl?: FetchLike; wantImage?: boolean; timeoutMs?: number } = {},
): Promise<XLookupResult> {
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const timeoutMs = options.timeoutMs ?? 8000;

    let probe: URL;
    try {
        probe = new URL(rawUrl.trim());
    } catch {
        return { ok: false, code: "bad_url", error: "That is not a valid link." };
    }
    if (probe.protocol !== "https:" && probe.protocol !== "http:") return { ok: false, code: "bad_url", error: "Only web links are supported." };
    const ref = parseXStatusUrl(rawUrl);
    if (!ref) return { ok: false, code: "not_x", error: "That is not a link to an X post." };

    try {
        const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${ref.id}&token=${syndicationToken(ref.id)}&lang=en`;
        const res = await timedFetch(fetchImpl, endpoint, { headers: { "User-Agent": UA, Accept: "application/json" } }, timeoutMs);
        if (!res.ok) {
            return { ok: false, code: "unreadable", error: res.status === 404 ? "The post was not found (deleted, private, or the account is protected)." : `X answered ${res.status}.` };
        }
        const data = await res.json().catch(() => null);
        const info = parseSyndicationPost(data, ref);
        if (!info) return { ok: false, code: "unreadable", error: "The post is not available (deleted, age-restricted, or from a private account)." };

        const imageUrl = info.photoUrls[0] || info.posterUrl;
        const imageDataUrl = options.wantImage && imageUrl ? await fetchImage(imageUrl, fetchImpl, timeoutMs) : undefined;
        return { ok: true, info, ...(imageDataUrl ? { imageDataUrl } : {}) };
    } catch (err) {
        const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
        return aborted
            ? { ok: false, code: "timeout", error: "X took too long to answer." }
            : { ok: false, code: "unreadable", error: err instanceof Error ? err.message.slice(0, 160) : "lookup failed" };
    }
}
