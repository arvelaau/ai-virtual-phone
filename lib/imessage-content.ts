// lib/imessage-content.ts
// What crosses the iMessage boundary, in both directions. Pure, so every shape can be driven
// from a fixture.
//
//   inbound  — Spectrum hands the webhook handler a `content` object. Plain text is easy; a
//              message the user sent as a QUOTED reply arrives as { type: "reply", content,
//              target } and used to be dropped as "not text". It is now read, and rendered to
//              the model the same way the Chat app renders a user's quote: [Quote:preview]text.
//
//   outbound — the model writes the app's own rich tags ([Quote:…], [Photo:…], [VoiceNote:…],
//              [Sticker:…] …). iMessage is plain text plus native features, so a quote becomes
//              a native reply to the right message, and the tags that have no iMessage
//              equivalent yet are turned into readable text instead of leaking as raw brackets.

import { modelOutputToBubbles } from "./imessage-webhook-core";
import { buildQuoteTag } from "./rich-tag-builders";
import { MAX_PHOTOS_PER_REPLY, MAX_VOICES_PER_REPLY, MAX_VOICE_TEXT_CHARS } from "./imessage-media-jobs";

// ---- inbound ---------------------------------------------------------------------------------

export type InboundContent =
    | { kind: "text"; text: string; quote?: { id: string; preview: string } }
    | { kind: "image"; mimeType: string; name: string; size?: number; read: () => Promise<Uint8Array> }
    | { kind: "unsupported"; type: string };

type AnyContent = { type?: unknown; text?: unknown; markdown?: unknown; content?: unknown; target?: unknown };

function readPlain(content: AnyContent): string | null {
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (content.type === "markdown" && typeof content.markdown === "string") return content.markdown;
    return null;
}

export function readInboundContent(content: unknown): InboundContent {
    if (!content || typeof content !== "object") return { kind: "unsupported", type: "" };
    const c = content as AnyContent;
    const plain = readPlain(c);
    if (plain !== null) return { kind: "text", text: plain };

    if (c.type === "reply" && c.content && typeof c.content === "object") {
        const inner = readPlain(c.content as AnyContent);
        if (inner === null) {
            const innerType = typeof (c.content as AnyContent).type === "string" ? String((c.content as AnyContent).type) : "";
            return { kind: "unsupported", type: `reply to ${innerType || "unknown"}` };
        }
        const target = (c.target && typeof c.target === "object" ? c.target : {}) as {
            id?: unknown;
            content?: { text?: unknown };
        };
        const preview = typeof target.content?.text === "string" ? target.content.text.trim() : "";
        const id = typeof target.id === "string" ? target.id : "";
        return { kind: "text", text: inner, quote: preview || id ? { id, preview } : undefined };
    }

    if (c.type === "attachment") {
        const a = c as AnyContent & { mimeType?: unknown; name?: unknown; size?: unknown; read?: unknown };
        const mimeType = typeof a.mimeType === "string" ? a.mimeType : "";
        if (/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mimeType) && typeof a.read === "function") {
            return {
                kind: "image",
                mimeType: mimeType.toLowerCase(),
                name: typeof a.name === "string" ? a.name : "",
                size: typeof a.size === "number" ? a.size : undefined,
                read: a.read as () => Promise<Uint8Array>,
            };
        }
        return { kind: "unsupported", type: `attachment${mimeType ? ` (${mimeType})` : ""}` };
    }

    return { kind: "unsupported", type: typeof c.type === "string" ? c.type : "" };
}

/** Largest photo the webhook will pull into a model request (bytes). */
export const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;

/** Providers only accept these inline; HEIC/HEIF has to be refused rather than mislabelled. */
export function isModelReadableImage(mimeType: string): boolean {
    return /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType);
}

/** The text the model sees: a quote is rendered exactly like an in-app quote. */
export function composeModelText(text: string, quote?: { preview: string }): string {
    const preview = quote?.preview?.replace(/\s+/g, " ").trim();
    return preview ? `${buildQuoteTag(preview)}${text}` : text;
}

// ---- outbound --------------------------------------------------------------------------------

export type QuoteCandidate = { id: string; text: string };

export type OutboundBubble = {
    text: string;
    /** Platform message id to answer natively; absent = a normal message. */
    replyToId?: string;
};

/** A [Photo:...] the character wants to send as a real picture, delivered later by the browser. */
export type OutboundPhoto = { description: string; withRef: boolean };

/** A [MusicShare:...] the character sent; the webhook may turn it into a real link bubble after `bubbleIndex`. */
export type OutboundMusicShare = { query: string; bubbleIndex: number };

/** A [VoiceNote:...] the character wants to send as a real voice message, synthesized later by the browser. */
export type OutboundVoice = { text: string };

export type OutboundPlan = {
    bubbles: OutboundBubble[];
    photos: OutboundPhoto[];
    voices: OutboundVoice[];
    notes: string[];
    musicShares: OutboundMusicShare[];
};

const VOICE_TAG_NAMES = new Set(["voicenote", "语音条"]);

const MUSIC_TAG_NAMES = new Set(["music", "musicshare", "音乐", "音乐分享"]);

/**
 * [Quote:text] and the variants models actually produce for it ("[Reply to: text]",
 * "[Replying to text]", "[回复：text]"). The preview may be empty, which means "the message
 * you were just sent".
 */
const QUOTE_RE = /^\s*\[(?:(?:Quote|引用)\s*[:：]|(?:Reply(?:ing)?\s+to|回复)\s*[:：]?)\s*([^\]]*)\]\s*/i;

// Paired action blocks the browser would dispatch ([Moments]…[/Moments] etc.). There is nothing
// to dispatch them to over iMessage, and they must not be sent as text.
const ACTION_BLOCK_RE =
    /\[(Moments|朋友圈|Comment|评论|Reply|回复|Message|消息|GroupMessage|群消息|DirectMessage|私信|AddFriend)\b[^\]]*\][\s\S]*?\[\/\1\]/gi;

type Fallback = { emoji: string; mode: "text" | "emoji" | "drop"; note: string };

const FALLBACKS: Array<{ names: string[]; fb: Fallback }> = [
    { names: ["VoiceNote", "语音条"], fb: { emoji: "", mode: "text", note: "voice note sent as text" } },
    { names: ["Photo", "照片"], fb: { emoji: "📷", mode: "emoji", note: "photo sent as a description" } },
    { names: ["Sticker", "表情包"], fb: { emoji: "", mode: "drop", note: "sticker dropped" } },
    { names: ["Location", "位置"], fb: { emoji: "📍", mode: "emoji", note: "location sent as text" } },
    { names: ["Music", "MusicShare", "音乐", "音乐分享"], fb: { emoji: "🎵", mode: "emoji", note: "music sent as text" } },
    { names: ["Gift", "礼物"], fb: { emoji: "🎁", mode: "emoji", note: "gift sent as text" } },
    { names: ["RedPacket", "红包"], fb: { emoji: "🧧", mode: "emoji", note: "red packet sent as text" } },
    { names: ["Transfer", "转账"], fb: { emoji: "💸", mode: "emoji", note: "transfer sent as text" } },
    { names: ["PaymentRequest", "代付请求"], fb: { emoji: "💳", mode: "emoji", note: "payment request sent as text" } },
    { names: ["ContactCard", "名片"], fb: { emoji: "👤", mode: "emoji", note: "contact card sent as text" } },
];

const FALLBACK_BY_NAME = new Map<string, Fallback>();
for (const entry of FALLBACKS) for (const name of entry.names) FALLBACK_BY_NAME.set(name.toLowerCase(), entry.fb);

/** Every tag name the fallback layer knows, for the drift guard in the fixture. */
export const KNOWN_RICH_TAG_NAMES = Array.from(FALLBACK_BY_NAME.keys());

const RICH_TAG_RE = new RegExp(
    `\\[(${KNOWN_RICH_TAG_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*[:：]\\s*([^\\]]*)\\]`,
    "gi",
);

function norm(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveQuoteTarget(
    preview: string,
    ctx: { currentId: string; currentText: string; known: QuoteCandidate[] },
): string | undefined {
    const wanted = norm(preview);
    if (!wanted) return ctx.currentId || undefined;

    const pool: QuoteCandidate[] = [{ id: ctx.currentId, text: ctx.currentText }, ...ctx.known];
    // exact, then prefix, then containment either way (long enough to be meaningful)
    for (const rule of [
        (c: string) => c === wanted,
        (c: string) => c.startsWith(wanted) || wanted.startsWith(c),
        (c: string) => c.includes(wanted) || (c.length >= 6 && wanted.includes(c)),
    ]) {
        for (const cand of pool) {
            const c = norm(cand.text);
            if (c && cand.id && rule(c)) return cand.id;
        }
    }
    return undefined;
}

const PHOTO_FLAG_RE = /^(WithRef|NoRef|使用参考图|不使用参考图)\s*[:：]\s*/i;

function textualize(
    text: string,
    notes: string[],
    photos: OutboundPhoto[] | null,
    shares: string[] | null = null,
    voices: OutboundVoice[] | null = null,
): string {
    return text.replace(RICH_TAG_RE, (_whole, rawName: string, rawPayload: string) => {
        const fb = FALLBACK_BY_NAME.get(rawName.toLowerCase());
        if (!fb) return _whole;
        // A photo on a line that can deliver real pictures: queue it, say nothing in the text.
        if (photos && /^(photo|照片)$/i.test(rawName) && photos.length < MAX_PHOTOS_PER_REPLY) {
            const flag = PHOTO_FLAG_RE.exec(rawPayload);
            const description = rawPayload.replace(PHOTO_FLAG_RE, "").replace(/\s+/g, " ").trim();
            if (description) {
                photos.push({ description, withRef: !flag || /^(WithRef|使用参考图)$/i.test(flag[1]) });
                const note = "photo queued for delivery as a real picture";
                if (!notes.includes(note)) notes.push(note);
                return "";
            }
        }
        // A voice note on a line that can deliver real ones: queue it, the words are not also sent as text.
        if (voices && VOICE_TAG_NAMES.has(rawName.toLowerCase()) && voices.length < MAX_VOICES_PER_REPLY) {
            const spoken = rawPayload.replace(/\s+/g, " ").trim();
            if (spoken) {
                voices.push({ text: spoken.slice(0, MAX_VOICE_TEXT_CHARS) });
                const note = "voice note queued for delivery as a real voice message";
                if (!notes.includes(note)) notes.push(note);
                return "";
            }
        }
        if (!notes.includes(fb.note)) notes.push(fb.note);
        if (fb.mode === "drop") return "";
        if (shares && MUSIC_TAG_NAMES.has(rawName.toLowerCase())) {
            const query = rawPayload.replace(/[:：]/g, " ").replace(/\s+/g, " ").trim();
            if (query) shares.push(query);
        }
        // a photo's reference-image flag is protocol, not content
        const payload = rawPayload
            .replace(/^(?:WithRef|NoRef|使用参考图|不使用参考图)\s*[:：]\s*/i, "")
            .split(/[:：]/)
            .map((part) => part.trim())
            .filter(Boolean)
            .join(" · ");
        if (fb.mode === "text") return payload;
        return payload ? `${fb.emoji} ${payload}` : fb.emoji;
    });
}

export function planOutbound(
    raw: string,
    ctx: {
        currentId: string;
        currentText: string;
        known: QuoteCandidate[];
        /** "queue": photo tags become delivery jobs. "text" (default): they become a description line. */
        photos?: "queue" | "text";
        /** "queue": voice-note tags become delivery jobs. "text" (default): they become plain text. */
        voices?: "queue" | "text";
    },
): OutboundPlan {
    const notes: string[] = [];
    const photos: OutboundPhoto[] = [];
    const photoSink = ctx.photos === "queue" ? photos : null;
    const voices: OutboundVoice[] = [];
    const voiceSink = ctx.voices === "queue" ? voices : null;
    const withoutActions = raw.replace(ACTION_BLOCK_RE, () => {
        if (!notes.includes("action blocks dropped")) notes.push("action blocks dropped");
        return "";
    });

    const paragraphs = modelOutputToBubbles(withoutActions);
    const bubbles: OutboundBubble[] = [];
    const musicShares: OutboundMusicShare[] = [];
    let pending: { preview: string } | null = null;

    for (const paragraph of paragraphs) {
        let body = paragraph;
        let quote: { preview: string } | null = pending;
        pending = null;

        const match = QUOTE_RE.exec(body);
        if (match) {
            quote = { preview: match[1] ?? "" };
            body = body.slice(match[0].length);
        }

        const shares: string[] = [];
        const queuedBefore = photos.length + voices.length;
        body = textualize(body, notes, photoSink, shares, voiceSink).replace(/[ \t]+\n/g, "\n").trim();
        // a tag that was lifted out of the middle of a sentence leaves a double space behind
        if (photos.length + voices.length > queuedBefore) body = body.replace(/(\S)[ \t]{2,}(\S)/g, "$1 $2");

        if (!body) {
            // a quote tag on its own line belongs to the bubble that follows it
            if (match) pending = quote;
            continue;
        }

        let replyToId: string | undefined;
        if (quote) {
            replyToId = resolveQuoteTarget(quote.preview, ctx);
            const note = replyToId ? "quote sent as a native reply" : "quote target not found, sent as a normal message";
            if (!notes.includes(note)) notes.push(note);
        }
        for (const query of shares) musicShares.push({ query, bubbleIndex: bubbles.length });
        bubbles.push(replyToId ? { text: body, replyToId } : { text: body });
    }

    return { bubbles, photos, voices, notes, musicShares };
}
