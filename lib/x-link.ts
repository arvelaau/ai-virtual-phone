// lib/x-link.ts
// Pure helpers for "the character can see the X (Twitter) post you pasted".
//
// What is available without logging in: the post text, who wrote it, when, the first photo (or a
// video's poster frame), a quoted post and the like count, via the public syndication endpoint
// that X's own embeds use. NOT available: replies, the thread, video content, or anything from
// a private account. The context text built here says so, so the character does not invent them.
//
// Dependency-free so the server lookup, the webhook and tests can all share it.

const STATUS_HOSTS = new Set([
    "x.com", "twitter.com", "mobile.twitter.com",
    // the "fixup" front-ends people paste because they embed nicely in chat apps
    "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com", "fixupx.com",
]);

/** Finds post links inside free text. The id is captured, so the host is checked separately. */
const X_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/(?:#!\/)?(?:[A-Za-z0-9_]{1,30}|i\/web|i)\/status(?:es)?\/\d{1,25}[^\s<>"']*/gi;

const TRAILING_PUNCTUATION_RE = /[)\]}>.,;:!?。，！？]+$/;

export type XStatusRef = { id: string; handle: string; canonicalUrl: string };

function normalHost(host: string): string {
    return host.toLowerCase().replace(/^(www|mobile|m)\./, "");
}

/** Parses a post link; null when it is not one (or the host is not on the allowlist). */
export function parseXStatusUrl(raw: string): XStatusRef | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!STATUS_HOSTS.has(normalHost(url.hostname))) return null;
    const m = /^\/(?:#!\/)?([A-Za-z0-9_]{1,30}|i\/web|i)\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(url.pathname);
    if (!m) return null;
    const handle = /^i(\/web)?$/.test(m[1]) ? "i" : m[1];
    return { id: m[2], handle, canonicalUrl: `https://x.com/${handle}/status/${m[2]}` };
}

export function extractXStatusUrls(text: string, max = 3): string[] {
    if (!text) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    X_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = X_URL_RE.exec(text)) !== null) {
        const cleaned = m[0].replace(TRAILING_PUNCTUATION_RE, "");
        const ref = parseXStatusUrl(cleaned);
        if (!ref || seen.has(ref.id)) continue;
        seen.add(ref.id);
        out.push(cleaned);
        if (out.length >= max) break;
    }
    return out;
}

/** The token X's own embed script sends with the id. Not a secret; it is derived from the id. */
export function syndicationToken(id: string): string {
    return ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, "");
}

/** Hosts a post's picture may be fetched from. Anything else is never contacted. */
export function isAllowedXImageHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === "pbs.twimg.com" || h.endsWith(".twimg.com");
}

export type XPostInfo = {
    id: string;
    url: string;
    author: string;
    handle: string;
    text: string;
    createdAt: string;
    likes?: number;
    replies?: number;
    photoUrls: string[];
    media: "none" | "photo" | "video" | "gif";
    posterUrl?: string;
    quoted?: { author: string; handle: string; text: string };
};

function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

type SyndicationEntityUrl = { url?: string; expanded_url?: string };
type SyndicationPost = {
    text?: unknown;
    display_text_range?: unknown;
    entities?: { urls?: SyndicationEntityUrl[]; media?: SyndicationEntityUrl[] };
    user?: { name?: unknown; screen_name?: unknown };
    created_at?: unknown;
    favorite_count?: unknown;
    conversation_count?: unknown;
    photos?: Array<{ url?: unknown }>;
    mediaDetails?: Array<{ type?: unknown; media_url_https?: unknown }>;
    video?: { poster?: unknown };
    quoted_tweet?: SyndicationPost;
};

/** The post text as a person reads it: leading mentions trimmed per display range, t.co expanded. */
export function cleanPostText(post: SyndicationPost): string {
    let text = typeof post.text === "string" ? post.text : "";
    const chars = Array.from(text);
    const range = Array.isArray(post.display_text_range) ? post.display_text_range : null;
    // The range trims the leading reply handles and the trailing media link
    if (range && typeof range[0] === "number" && typeof range[1] === "number" && range[1] > range[0] && range[1] <= chars.length) {
        text = chars.slice(range[0], range[1]).join("");
    }
    for (const media of post.entities?.media ?? []) {
        if (media.url) text = text.split(media.url).join("");
    }
    for (const link of post.entities?.urls ?? []) {
        if (link.url && link.expanded_url) text = text.split(link.url).join(link.expanded_url);
    }
    return decodeEntities(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Turns a syndication payload into the fields the character needs; null when it holds no post. */
export function parseSyndicationPost(data: unknown, ref: XStatusRef): XPostInfo | null {
    if (!data || typeof data !== "object") return null;
    const post = data as SyndicationPost & { __typename?: unknown };
    if (post.__typename === "TweetTombstone") return null;
    const text = cleanPostText(post);
    const handle = str(post.user?.screen_name) || ref.handle;
    const author = str(post.user?.name) || handle;
    if (!text && !str(post.user?.screen_name)) return null;

    const photoUrls = (post.photos ?? []).map((p) => str(p.url)).filter(Boolean);
    const details = post.mediaDetails ?? [];
    const hasVideo = details.some((d) => d.type === "video") || Boolean(post.video);
    const hasGif = details.some((d) => d.type === "animated_gif");
    for (const d of details) {
        const u = str(d.media_url_https);
        if (u && d.type === "photo" && !photoUrls.includes(u)) photoUrls.push(u);
    }
    const posterUrl = str(post.video?.poster) || (hasVideo || hasGif ? str(details.find((d) => d.type !== "photo")?.media_url_https) : "") || undefined;

    const quotedRaw = post.quoted_tweet;
    const quoted = quotedRaw && (str(quotedRaw.text) || str(quotedRaw.user?.screen_name))
        ? {
            author: str(quotedRaw.user?.name) || str(quotedRaw.user?.screen_name),
            handle: str(quotedRaw.user?.screen_name),
            text: cleanPostText(quotedRaw),
        }
        : undefined;

    return {
        id: ref.id,
        url: ref.canonicalUrl,
        author,
        handle,
        text,
        createdAt: str(post.created_at),
        likes: num(post.favorite_count),
        replies: num(post.conversation_count),
        photoUrls: photoUrls.slice(0, 4),
        media: hasVideo ? "video" : hasGif ? "gif" : photoUrls.length ? "photo" : "none",
        ...(posterUrl ? { posterUrl } : {}),
        ...(quoted ? { quoted } : {}),
    };
}

function clip(value: string, max: number): string {
    const t = value.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function dayOf(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The block that goes next to the link in the prompt: what is known, and just as importantly
 * what is not.
 */
export function formatXContext(info: XPostInfo | null, failure?: string): string {
    if (!info) {
        return `(X post context, for you only, never quote it: the user shared a link to an X post but it could not be read${failure ? ` (${clip(failure, 120)})` : ""}. It may be deleted, from a private account, or blocked. Say so honestly if it comes up, and do not guess what it says.)`;
    }
    const when = dayOf(info.createdAt);
    const parts = [
        `X post context, for you only, never quote it: ${info.author}${info.handle ? ` (@${info.handle})` : ""} posted${when ? ` on ${when}` : ""}: "${clip(info.text, 700) || "(no text)"}"`,
    ];
    if (info.media === "photo") parts.push(`It has ${info.photoUrls.length} photo${info.photoUrls.length === 1 ? "" : "s"}`);
    else if (info.media === "video") parts.push("It has a video");
    else if (info.media === "gif") parts.push("It has an animated GIF");
    if (info.quoted) parts.push(`It quotes ${info.quoted.author}${info.quoted.handle ? ` (@${info.quoted.handle})` : ""}: "${clip(info.quoted.text, 300)}"`);
    if (typeof info.likes === "number") parts.push(`${info.likes.toLocaleString("en-US")} likes`);
    const seen = info.media === "photo" || info.posterUrl ? "the post text and its first picture" : "only the post text";
    return `(${parts.join(". ")}. You can see ${seen}; you have not seen the replies, the rest of the thread, or any video, so do not invent them. React the way you naturally would to a friend sending you this.)`;
}
