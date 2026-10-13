// lib/tiktok-link.ts
// Pure helpers for "the character can see the TikTok link you pasted".
//
// What can honestly be known from a link without watching the video: the creator, the caption
// (with its hashtags) and the cover frame. The video itself and its sound are NOT available,
// and the text built here says so, so the character does not pretend to have watched it.
//
// Pure and dependency-free so it can be used by the server lookup, the webhook and tests alike.

/** Matches a TikTok URL inside free text. Trailing sentence punctuation is trimmed afterwards. */
const TIKTOK_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/[^\s<>"'　]+/gi;

const TRAILING_PUNCTUATION_RE = /[)\]}>.,;:!?。，！？」』]+$/;

export function isAllowedTikTokHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === "tiktok.com" || h.endsWith(".tiktok.com");
}

/** Hosts a TikTok cover image may come from. Anything else is never fetched. */
export function isAllowedTikTokImageHost(host: string): boolean {
    const h = host.toLowerCase();
    return [".tiktokcdn.com", ".tiktokcdn-us.com", ".tiktokv.com", ".tiktok.com", ".muscdn.com", ".ibytedtos.com"]
        .some((suffix) => h.endsWith(suffix));
}

/** Short links redirect to the real video URL and have to be resolved before oEmbed. */
export function isShortTikTokLink(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return true;
    return /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname);
}

export function extractTikTokUrls(text: string, max = 3): string[] {
    if (!text) return [];
    const found: string[] = [];
    const seen = new Set<string>();
    TIKTOK_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TIKTOK_URL_RE.exec(text)) !== null) {
        const cleaned = m[0].replace(TRAILING_PUNCTUATION_RE, "");
        let parsed: URL;
        try {
            parsed = new URL(cleaned);
        } catch {
            continue;
        }
        if (!isAllowedTikTokHost(parsed.hostname)) continue;
        const key = canonicalizeTikTokUrl(cleaned);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(cleaned);
        if (found.length >= max) break;
    }
    return found;
}

/** Drops tracking query parameters and the fragment: the same video pasted twice is one video. */
export function canonicalizeTikTokUrl(raw: string): string {
    try {
        const url = new URL(raw);
        url.hash = "";
        url.search = "";
        url.hostname = url.hostname.toLowerCase();
        let out = url.toString();
        if (out.endsWith("/") && url.pathname !== "/") out = out.slice(0, -1);
        return out;
    } catch {
        return raw.trim();
    }
}

export function extractHashtags(text: string, max = 12): string[] {
    const tags: string[] = [];
    const re = /#([\p{L}\p{N}_]{1,40})/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text || "")) !== null) {
        const tag = m[1];
        if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
        if (tags.length >= max) break;
    }
    return tags;
}

export type TikTokInfo = {
    url: string;
    canonicalUrl: string;
    title: string;
    author: string;
    authorUrl: string;
    hashtags: string[];
    thumbnailUrl?: string;
    source: "oembed" | "page";
};

function clip(value: string, max: number): string {
    const t = value.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The block that goes next to the link in the prompt. It states what is known and, just as
 * importantly, what is not.
 */
export function formatTikTokContext(info: TikTokInfo | null, failure?: string): string {
    if (!info) {
        return `(TikTok link context, for you only, never quote it: the user shared a TikTok link but it could not be read${failure ? ` (${clip(failure, 120)})` : ""}. Say so honestly if it comes up, and do not guess what the video shows.)`;
    }
    const parts = [
        "TikTok link context, for you only, never quote it:",
        info.author ? `creator ${info.author}` : "",
        info.title ? `caption "${clip(info.title, 400)}"` : "no caption",
        info.hashtags.length ? `hashtags ${info.hashtags.map((t) => `#${t}`).join(" ")}` : "",
    ].filter(Boolean);
    return `(${parts.join(", ")}. You only know the creator, the caption and the cover frame; you have not watched the video or heard its sound, so do not invent what happens in it. React the way you naturally would to a friend sending you this.)`;
}
