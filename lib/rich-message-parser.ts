/**
 * Shared rich-media message parser.
 *
 * Parse order:
 *   1. parseStateValues() → extract [好感度:72] etc.
 *   2. Extract [状态栏]...[/状态栏] display-only status panel
 *   3. Extract [内心]...[/内心] inner monologue
 *   4. split(/\n\n+/) → split by double newlines
 *   5. Parse each segment for rich-media markers (direct matching, no placeholders)
 */

import type { ChatMessage } from "./chat-storage";
import type { StateValue } from "./chat-storage";
import { parseStateValues, mergeStateValues } from "./state-value-parser";
import { stripActionShells } from "./action-parser";
import { stripTextToolDirectives } from "./text-tool-protocol";
import {
    DEFAULT_GIFT_MERCHANT_LABEL,
    DEFAULT_GIFT_PRICE_LABEL,
    DEFAULT_PAYMENT_REQUEST_LABEL,
    DEFAULT_RED_PACKET_BLESSING,
    DEFAULT_TRANSFER_NOTE,
} from "./rich-tag-builders";
import {
    formatCustomAppDirectiveSummary,
    getCustomAppDirectiveSyntaxHead,
    loadCustomAppChatDirectives,
    splitCustomAppDirectiveArgs,
    type RegisteredCustomAppChatDirective,
} from "./custom-app-chat-directives";

// ── Types ──────────────────────────────────────────────

export interface ParsedMessagePart {
    content: string;
    mediaType?: ChatMessage["mediaType"];
    mediaData?: ChatMessage["mediaData"];
}

export interface ParsedAIResponse {
    parts: ParsedMessagePart[];
    /** 与历史合并后的完整状态快照（用于状态链传递与下一轮提示词） */
    stateValues: StateValue[];
    /** 本轮回复实际输出的状态值（未合并历史；漏输出时为空，内心卡片按此渲染） */
    freshStateValues: StateValue[];
    statusPanel: string;
    innerMonologue: string;
}

// Ported from upstream (2026-08-04, "修复：媒体消息后的零宽字符被存成空气泡").
// Zero-width spaces, BOMs and friends are not \s, so trim() cannot remove them. When a
// model trails one of these after a media marker, the text gets split into a segment
// that is non-empty but renders as nothing — an empty bubble.
// They must NOT simply be deleted from the content: U+200D is the joiner in composite
// emoji and U+200C carries meaning in some scripts. So they only count as blank when
// deciding whether a segment is empty.
const INVISIBLE_OR_WHITESPACE_ONLY_RE = new RegExp(
    "^[\\s\\u00AD\\u034F\\u180E\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]*$",
);

/** True when the text has no visible characters (empty, whitespace, zero-width/BOM, or any mix). */
export function isInvisibleOrWhitespaceOnly(text: string): boolean {
    return INVISIBLE_OR_WHITESPACE_ONLY_RE.test(text);
}

// ── Rich-media patterns (non-global, for single match with index) ──

const C = "\\s*[：:]\\s*"; // half-width or full-width colon, allowing surrounding spaces

// ── Dual-recognition tag aliases ────────────────────────
// Every tag accepts a LEGACY Chinese token and a going-forward English token.
// The Chinese forms must keep matching FOREVER: they are baked into every chat
// history saved before the migration, and lib/llm-prompt-assembler.ts
// re-serializes stored messages back into these tags to feed the AI as context.
// This layer is purely additive — never remove a legacy form.
// See PROTOCOL-MIGRATION-PLAN.md.
const alt = (...names: string[]) => `(?:${names.join("|")})`;

const T_RED_PACKET = alt("红包", "RedPacket");
const T_TRANSFER = alt("转账", "Transfer");
const T_PAYMENT_REQUEST = alt("代付请求", "PaymentRequest");
const T_GIFT = alt("礼物", "Gift");
const T_CONTACT_CARD = alt("名片", "ContactCard");
const T_PHOTO = alt("照片", "Photo");
const T_LOCATION = alt("位置", "Location");
const T_STICKER = alt("表情包", "Sticker");
const T_QUOTE = alt("引用", "Quote");
const T_MUSIC = alt("音乐", "Music");
const T_MUSIC_SHARE = alt("音乐分享", "MusicShare");
const T_VOICE_NOTE = alt("语音条", "VoiceNote");

/** Block tags (paired [tag]...[/tag]); legacy Chinese + going-forward English.
 *  Declared in ./block-tags (a leaf module) so prompt-sanitizer can share them
 *  without closing an import cycle. Re-exported here for existing callers. */
export { BLOCK_TAG_STATUS_PANEL, BLOCK_TAG_INNER } from "./block-tags";
import {
    BLOCK_TAG_STATUS_PANEL,
    BLOCK_TAG_INNER,
    blockCloserAlternationSource,
    closedBlockRegex,
    orphanCloserRegex,
    stripReasoningTags,
    unclosedBlockRegex,
} from "./block-tags";

/**
 * `<style>…</style>` plus the HTML that follows it, protected from the rest of the
 * parser as one placeholder.
 *
 * The lookahead lists every way that run is allowed to END. The block-closer branch is
 * NOT optional: when the model follows the contract and writes raw HTML inside
 * [StatusPanel], there is usually only a single newline between the HTML and the closing
 * tag — no blank line to stop at — so without it the protection runs all the way to `$`
 * and swallows `[/StatusPanel]` along with the chat reply after it. The closer is then
 * gone before extractBracketBlock runs, no pair matches, and the whole thing (literal
 * tags included) leaks into the bubble. "It only works if I leave a blank line" was
 * exactly this. Same defect for [InnerThoughts].
 *
 * Derived from the alias arrays rather than written out, because this fork teaches the
 * English tags while saved history still holds the Chinese ones — a Chinese-only stop
 * condition (upstream's) would fix nothing here.
 *
 * Rebuilt per call: it carries `g`, and a shared instance is a lastIndex hazard.
 */
function htmlProtectionRegex(): RegExp {
    const closer = blockCloserAlternationSource(BLOCK_TAG_STATUS_PANEL, BLOCK_TAG_INNER);
    return new RegExp(`<style[\\s\\S]*?<\\/style>[\\s\\S]*?(?=\\n\\n[^<\\x00]|\\s*${closer}|$)`, "gi");
}

function parseMuteMinutes(num?: string, unit?: string): number {
    const n = parseInt(num || "", 10);
    if (!Number.isFinite(n) || n <= 0) return 10;
    const u = (unit || "").toLowerCase();
    if (unit === "天" || u.startsWith("day")) return n * 1440;
    if (unit === "小时" || u.startsWith("hour")) return n * 60;
    return n;
}

const RICH_PATTERNS: {
    regex: RegExp;
    build: (m: RegExpMatchArray) => ParsedMessagePart;
}[] = [
    {
        // 3-arg form: [红包:金额:个数:留言] / [RedPacket:amount:count:message]
        regex: new RegExp(`\\[${T_RED_PACKET}${C}(\\d+(?:\\.\\d+)?)${C}(\\d+)${C}([^\\]]*)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "red_packet",
            mediaData: { amount: parseFloat(m[1]), count: parseInt(m[2], 10), label: m[3] || DEFAULT_RED_PACKET_BLESSING, status: "pending" },
        }),
    },
    {
        // 2-arg form (backward compatible): [红包:金额:留言] / [RedPacket:amount:message]
        regex: new RegExp(`\\[${T_RED_PACKET}${C}(\\d+(?:\\.\\d+)?)${C}([^\\]]*)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "red_packet",
            mediaData: { amount: parseFloat(m[1]), count: 1, label: m[2] || DEFAULT_RED_PACKET_BLESSING, status: "pending" },
        }),
    },
    {
        // Two forms: [转账:金额:留言] (1:1) and [转账:金额:留言:转账人:收款人] (group)
        // English: [Transfer:amount:message] / [Transfer:amount:message:sender:recipient]
        regex: new RegExp(`\\[${T_TRANSFER}[：:](\\d+(?:\\.\\d+)?)[：:]([^\\]：:]*?)(?:[：:]([^\\]：:]*?)[：:]([^\\]]*?))?\\]`),
        build: (m) => ({
            content: "",
            mediaType: "transfer",
            mediaData: {
                amount: parseFloat(m[1]),
                label: m[2]?.trim() || DEFAULT_TRANSFER_NOTE,
                status: "pending" as const,
                senderName: m[3]?.trim() || "",
                recipientName: m[4]?.trim() || "",
            },
        }),
    },
    {
        // [代付请求:总金额:商品名/详情/价格/数量; ...] / [PaymentRequest:total:item/detail/price/qty; ...]
        regex: new RegExp(`\\[${T_PAYMENT_REQUEST}[：:](\\d+(?:\\.\\d+)?)[：:]([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "payment_request" as const,
            mediaData: {
                amount: parseFloat(m[1]),
                paymentRequestAmountLabel: m[1],
                paymentRequestItemsText: m[2].trim(),
                label: DEFAULT_PAYMENT_REQUEST_LABEL,
                status: "pending" as const,
                paymentRequestedAt: new Date().toISOString(),
            },
        }),
    },
    {
        // Group gift: [礼物:商品名:收礼人] / [Gift:item:recipient]
        // (legacy variant also allows the "送给"/"to " prefix before the recipient)
        regex: new RegExp(`\\[${T_GIFT}${C}([^\\]：:]+)${C}(?:送给|to )?([^\\]]+)\\]`),
        build: (m) => {
            const giftName = m[1].trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName,
                    label: giftName,
                    recipientName: m[2].trim(),
                    giftMerchantLabel: DEFAULT_GIFT_MERCHANT_LABEL,
                    giftPriceLabel: DEFAULT_GIFT_PRICE_LABEL,
                    giftSentAt: new Date().toISOString(),
                },
            };
        },
    },
    {
        // 1:1 gift: [礼物:商品名] / [Gift:item]
        regex: new RegExp(`\\[${T_GIFT}${C}([^\\]]+)\\]`),
        build: (m) => {
            const giftName = m[1].trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName,
                    label: giftName,
                    giftMerchantLabel: DEFAULT_GIFT_MERCHANT_LABEL,
                    giftPriceLabel: DEFAULT_GIFT_PRICE_LABEL,
                    giftSentAt: new Date().toISOString(),
                },
            };
        },
    },
    {
        // Recommended contact card: [名片:角色名] / [ContactCard:name].
        // The name is resolved live at render time against the recommender's world;
        // an unknown name still renders as a card — tapping it can generate that
        // character's profile on the spot (turning a hallucination into a record).
        regex: new RegExp(`\\[${T_CONTACT_CARD}${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "contact_card" as const,
            mediaData: { contactCardName: m[1].trim(), label: m[1].trim() },
        }),
    },
    {
        // [照片:使用参考图|不使用参考图:描述] / [Photo:WithRef|NoRef:description]
        regex: new RegExp(`\\[${T_PHOTO}${C}(使用参考图|不使用参考图|WithRef|NoRef)${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "image",
            mediaData: {
                label: m[2].trim(),
                useReferenceImage: m[1] === "使用参考图" || m[1].toLowerCase() === "withref",
            },
        }),
    },
    {
        regex: new RegExp(`\\[${T_PHOTO}${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "image",
            mediaData: { label: m[1].trim(), useReferenceImage: false },
        }),
    },
    {
        regex: new RegExp(`\\[${T_LOCATION}${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "location",
            mediaData: { label: m[1] },
        }),
    },
    {
        // [A拍了拍B] / [A poked B]
        regex: /\[([^\]]+)(?:拍了拍| poked )([^\]]+)\]/,
        build: (m) => ({
            content: "",
            mediaType: "poke" as const,
            mediaData: { pokeSender: m[1]?.trim() || "", pokeTarget: m[2]?.trim() || "" },
        }),
    },
    {
        regex: new RegExp(`\\[${T_STICKER}${C}([^\\]]+)\\]`),
        build: (m) => {
            const name = m[1].trim();
            return {
                content: "",
                mediaType: "sticker" as const,
                mediaData: { label: name },
            };
        },
    },
    {
        regex: new RegExp(`\\[${T_QUOTE}${C}([^\\]]+)\\](.+)`),
        build: (m) => ({
            content: m[2].trim(),
            mediaType: "quote" as const,
            mediaData: { quotePreview: m[1].trim() },
        }),
    },
    {
        // [音乐:歌名-歌手] / [Music:title-artist] (artist optional)
        regex: new RegExp(`\\[${T_MUSIC}${C}([^\\]]+)\\]`),
        build: (m) => {
            const raw = m[1].trim();
            const sep = raw.indexOf("-");
            const title = sep > 0 ? raw.slice(0, sep).trim() : raw;
            const artist = sep > 0 ? raw.slice(sep + 1).trim() : "";
            return {
                content: "",
                mediaType: "music" as const,
                mediaData: { musicTitle: title, musicArtist: artist, label: raw },
            };
        },
    },
    {
        // [音乐分享:歌名] / [MusicShare:title] — AI shares a song as a card
        regex: new RegExp(`\\[${T_MUSIC_SHARE}${C}([^\\]]+)\\]`),
        build: (m) => {
            const title = m[1].trim();
            return {
                content: "",
                mediaType: "music_share" as const,
                mediaData: { musicTitle: title, label: title },
            };
        },
    },
    {
        // [语音条:文字内容] / [VoiceNote:text] — voice message
        regex: new RegExp(`\\[${T_VOICE_NOTE}${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "audio" as const,
            mediaData: { label: m[1].trim() },
        }),
    },
    {
        // [我向X发起了语音通话] / [I started a voice call with X]
        regex: /\[(?:我向[^\]]+发起了语音通话|I started a voice call with [^\]]+)\]/,
        build: () => ({ content: "", mediaType: "voice_call" as const }),
    },
    {
        // [我向X发起了视频通话] / [I started a video call with X]
        regex: /\[(?:我向[^\]]+发起了视频通话|I started a video call with [^\]]+)\]/,
        build: () => ({ content: "", mediaType: "video_call" as const }),
    },
    // Group forms carrying subject + object (matched before the bare 1:1 forms).
    // English keeps the same capture order: m[1] = actor/claimer, m[2] = owner.
    {
        // [A领取了B的红包] / [A claimed the red envelope from B]
        regex: /\[([^\]]+)(?:领取了([^\]]+)的红包|claimed the red envelope from ([^\]]+))\]/,
        build: (m) => ({ content: "", mediaType: "accept_red_packet" as const, mediaData: { claimer: m[1]?.trim(), owner: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A退回了B的红包] / [A returned the red envelope from B]
        regex: /\[([^\]]+)(?:退回了([^\]]+)的红包|returned the red envelope from ([^\]]+))\]/,
        build: (m) => ({ content: "", mediaType: "decline_red_packet" as const, mediaData: { claimer: m[1]?.trim(), owner: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A接受/领取了B的转账] / [A accepted|claimed the transfer from B]
        regex: /\[([^\]]+)(?:(?:接受|领取)了([^\]]+)的转账|(?:accepted|claimed) the transfer from ([^\]]+))\]/,
        build: (m) => ({ content: "", mediaType: "accept_transfer" as const, mediaData: { claimer: m[1]?.trim(), owner: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A拒收/退回了B的转账] / [A declined|returned the transfer from B]
        regex: /\[([^\]]+)(?:(?:拒收|退回)了([^\]]+)的转账|(?:declined|returned) the transfer from ([^\]]+))\]/,
        build: (m) => ({ content: "", mediaType: "decline_transfer" as const, mediaData: { claimer: m[1]?.trim(), owner: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A接受/同意/支付/代付了B的代付] / [A accepted|approved|paid|covered the payment request from B]
        regex: /\[([^\]]+)(?:(?:接受|同意|支付|代付)了([^\]]+)的代付|(?:accepted|approved|paid|covered) the payment request from ([^\]]+))\]/,
        build: (m) => ({ content: "", mediaType: "accept_payment_request" as const, mediaData: { claimer: m[1]?.trim(), owner: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A拒绝/拒收/退回了B的代付] / [A rejected|declined|returned the payment request from B]
        regex: /\[([^\]]+)(?:(?:拒绝|拒收|退回)了([^\]]+)的代付|(?:rejected|declined|returned) the payment request from ([^\]]+))\]/,
        build: (m) => ({ content: "", mediaType: "decline_payment_request" as const, mediaData: { claimer: m[1]?.trim(), owner: (m[2] || m[3])?.trim() } }),
    },
    // Group-admin actions (permissions are validated in processGroupParts;
    // tags from an unauthorized actor are dropped there).
    // English forms keep the same capture order: m[1] = actor, then target.
    {
        // [A将群主转让给了B] / [A transferred group ownership to B]
        regex: /\[([^\]]+?)(?:将群主转让给了?([^\]]+?)|transferred group ownership to ([^\]]+?))\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "transfer_owner" as const, adminActorName: m[1]?.trim(), adminTargetName: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A将B设为了管理员] / [A made B an admin]
        regex: /\[([^\]]+?)(?:将([^\]]+?)设为了?管理员|made ([^\]]+?) an admin)\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "set_admin" as const, adminActorName: m[1]?.trim(), adminTargetName: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A取消了B的管理员] / [A removed admin from B]
        regex: /\[([^\]]+?)(?:取消了([^\]]+?)的管理员|removed admin from ([^\]]+?))\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "unset_admin" as const, adminActorName: m[1]?.trim(), adminTargetName: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A将B移出了群聊] / [A removed B from the group]
        regex: /\[([^\]]+?)(?:将([^\]]+?)移出了?群聊|removed ([^\]]+?) from the group)\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "kick" as const, adminActorName: m[1]?.trim(), adminTargetName: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A邀请B加入了群聊] / [A invited B to the group]
        regex: /\[([^\]]+?)(?:邀请([^\]]+?)加入了?群聊|invited ([^\]]+?) to the group)\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "invite" as const, adminActorName: m[1]?.trim(), adminTargetName: (m[2] || m[3])?.trim() } }),
    },
    {
        // [A将B禁言30分钟] (must precede the looser form below, otherwise
        // "A将B禁言了1天" would be split incorrectly)
        regex: /\[([^\]：:]+?)将([^\]：:]+?)禁言(?:了)?\s*(\d+)?\s*(分钟|小时|天)?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        // [A muted B for 30 minutes] / [A muted B] (defaults to 10 minutes).
        // Kept as its own entry rather than merged into the Chinese pattern so the
        // number/unit capture arity stays identical on both sides.
        regex: /\[([^\]：:]+?) muted ([^\]：:]+?)(?: for)?\s*(\d+)?\s*(minutes?|hours?|days?)?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        // [A禁言了B:30分钟] / [A禁言了B]（默认10分钟）
        regex: /\[([^\]：:]+?)禁言了([^\]：:]+?)(?:[：:]\s*(\d+)\s*(分钟|小时|天))?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        // [A muted B: 30 minutes] — colon form (the name captures exclude colons,
        // so this cannot collide with the "muted … for …" entry above).
        regex: /\[([^\]：:]+?) muted ([^\]：:]+?)(?:[：:]\s*(\d+)\s*(minutes?|hours?|days?))?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        // [A解除了B的禁言] / [A unmuted B]
        regex: /\[([^\]]+?)(?:解除了([^\]]+?)的禁言|unmuted ([^\]]+?))\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "unmute" as const, adminActorName: m[1]?.trim(), adminTargetName: (m[2] || m[3])?.trim() } }),
    },
    // Bare 1:1 forms (no subject/object)
    {
        regex: /\[(?:领取红包|ClaimRedPacket)\]/,
        build: () => ({ content: "", mediaType: "accept_red_packet" as const }),
    },
    {
        regex: /\[(?:拒收红包|DeclineRedPacket)\]/,
        build: () => ({ content: "", mediaType: "decline_red_packet" as const }),
    },
    {
        regex: /\[(?:(?:接受|领取)转账|AcceptTransfer|ClaimTransfer)\]/,
        build: () => ({ content: "", mediaType: "accept_transfer" as const }),
    },
    {
        regex: /\[(?:拒收转账|DeclineTransfer)\]/,
        build: () => ({ content: "", mediaType: "decline_transfer" as const }),
    },
    {
        regex: /\[(?:接受代付|AcceptPaymentRequest)\]/,
        build: () => ({ content: "", mediaType: "accept_payment_request" as const }),
    },
    {
        regex: /\[(?:拒绝代付|DeclinePaymentRequest)\]/,
        build: () => ({ content: "", mediaType: "decline_payment_request" as const }),
    },
];

type RichPatternCandidate = {
    index: number;
    matchText: string;
    build: () => ParsedMessagePart;
};

function syntaxArgLabels(syntax: string | undefined): string[] {
    const text = String(syntax ?? "").trim();
    const body = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
    const parts = body.split(/[：:]/).map(item => item.trim()).filter(Boolean);
    return parts.slice(1).map((item, index) => (
        item
            .replace(/[<>{}\[\]【】]/g, "")
            .replace(/^(参数|内容|arg|param|value)$/i, `arg${index + 1}`)
            .slice(0, 24)
            || `arg${index + 1}`
    ));
}

type DirectiveCardInterpolationContext = {
    args: string[];
    argLabels: string[];
    raw: string;
    summary: string;
    directive: RegisteredCustomAppChatDirective;
};

function buildDirectiveCardTokenMap(ctx: DirectiveCardInterpolationContext): Map<string, string> {
    const tokens = new Map<string, string>();
    tokens.set("raw", ctx.raw);
    tokens.set("summary", ctx.summary);
    tokens.set("directive", ctx.directive.label);
    tokens.set("label", ctx.directive.label);
    tokens.set("app", ctx.directive.appName);
    tokens.set("appName", ctx.directive.appName);
    ctx.args.forEach((arg, index) => {
        const oneBased = String(index + 1);
        tokens.set(`arg${oneBased}`, arg);
        // LEGACY alias: installed custom apps may still use {{参数1}} in their
        // card templates. Keep registering it forever — never remove.
        tokens.set(`参数${oneBased}`, arg);
        tokens.set(oneBased, arg);
        const label = ctx.argLabels[index];
        if (label) tokens.set(label, arg);
    });
    return tokens;
}

function interpolateDirectiveCardValue(value: unknown, tokens: Map<string, string>): unknown {
    if (typeof value === "string") {
        return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, token: string) => {
            const key = token.trim();
            return tokens.has(key) ? tokens.get(key)! : match;
        });
    }
    if (Array.isArray(value)) {
        return value.map(item => interpolateDirectiveCardValue(item, tokens));
    }
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = interpolateDirectiveCardValue(item, tokens);
        }
        return result;
    }
    return value;
}

function interpolateDirectiveCardLayout(
    card: unknown,
    ctx: DirectiveCardInterpolationContext,
): Record<string, unknown> | null {
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    return interpolateDirectiveCardValue(card, buildDirectiveCardTokenMap(ctx)) as Record<string, unknown>;
}

function buildCustomAppDirectivePart(
    directive: RegisteredCustomAppChatDirective,
    args: string[],
    raw: string,
): ParsedMessagePart {
    const summary = formatCustomAppDirectiveSummary(directive, args);
    const title = directive.title || directive.label;
    const argLabels = syntaxArgLabels(directive.syntax);
    const defaultLayout = {
        appLabel: directive.appLabel || directive.appName,
        title,
        subtitle: "",
        body: "",
        status: directive.status || "Pending",
        accentColor: directive.accentColor || "",
        sections: args.length > 0 ? [{
            rows: args.map((arg, index) => ({
                label: argLabels[index] || `arg${index + 1}`,
                value: arg,
            })),
        }] : [],
        actions: directive.actions && directive.actions.length > 0
            ? directive.actions
            : [{ label: "View", style: "default" }],
    };
    const customLayout = interpolateDirectiveCardLayout(directive.card, {
        args,
        argLabels,
        raw,
        summary,
        directive,
    });
    return {
        content: summary,
        mediaType: "app_card",
        mediaData: {
            appId: directive.appId,
            appName: directive.appName,
            appCardTitle: title,
            appCardBody: "",
            appCardSummary: summary,
            appCardTone: directive.tone,
            appDirectiveId: directive.id,
            appDirectiveLabel: directive.label,
            appDirectiveArgs: args,
            appDirectiveRaw: raw,
            appSceneId: directive.sceneId,
            appSceneTag: directive.sceneTag,
            appTags: directive.tags,
            appHistoryText: summary,
            appCardLayout: customLayout
                ? { ...defaultLayout, ...customLayout }
                : defaultLayout,
        },
    };
}

function findBuiltInRichCandidate(segment: string): RichPatternCandidate | null {
    let best: { index: number; m: RegExpMatchArray; build: (m: RegExpMatchArray) => ParsedMessagePart } | null = null;
    for (const { regex, build } of RICH_PATTERNS) {
        const m = segment.match(regex);
        if (m && m.index !== undefined && (best === null || m.index < best.index)) {
            best = { index: m.index, m, build };
        }
    }
    if (!best) return null;
    const candidate = best;
    return {
        index: best.index,
        matchText: best.m[0],
        build: () => candidate.build(candidate.m),
    };
}

function findCustomAppRichCandidate(segment: string): RichPatternCandidate | null {
    const directives = loadCustomAppChatDirectives();
    if (directives.length === 0) return null;
    const bySyntaxHead = new Map(directives.map(item => [getCustomAppDirectiveSyntaxHead(item.syntax), item]));
    const bracketPattern = /\[([^\]\n：:]{1,24})([：:][^\]\n]*)?\]/g;
    let match: RegExpExecArray | null;
    while ((match = bracketPattern.exec(segment)) !== null) {
        const directive = bySyntaxHead.get(match[1].trim());
        if (!directive) continue;
        const args = splitCustomAppDirectiveArgs(match[2] || "");
        const raw = match[0];
        return {
            index: match.index,
            matchText: raw,
            build: () => buildCustomAppDirectivePart(directive, args, raw),
        };
    }
    return null;
}

// ── Structured hidden block extraction ───────────────────

function extractBracketBlock(text: string, tags: string | string[]): { cleaned: string; content: string } {
    const aliases = Array.isArray(tags) ? tags : [tags];
    const bodies: string[] = [];
    let cleaned = text;

    // Well-formed pairs first, then unterminated openers, then orphan closers — the
    // same order and the same regex builders prompt-sanitizer uses, so the read side
    // and the prompt-replay side can never disagree about what counts as a block.
    // Accepting an unterminated opener is what keeps a model that forgets [/InnerThoughts]
    // from rendering its monologue as a plain chat bubble.
    for (const build of [closedBlockRegex, unclosedBlockRegex]) {
        const rx = build(aliases);
        let match: RegExpExecArray | null;
        while ((match = rx.exec(cleaned)) !== null) {
            const block = match[1].trim();
            if (block) bodies.push(block);
        }
        cleaned = cleaned.replace(rx, "").trim();
    }
    cleaned = cleaned.replace(orphanCloserRegex(aliases), "").trim();

    return { cleaned, content: bodies.join("\n\n") };
}

// ── Segment parser ──────────────────────────────────────

/**
 * Parse a segment for rich-media markers.
 * If found, splits into before-text + media + recurse(after-text).
 * If not found, pushes as plain text.
 */
function parseSegment(segment: string, parts: ParsedMessagePart[]) {
    // Pick the rich marker that appears EARLIEST in the text, not the first
    // pattern that happens to match. Otherwise, when an earlier-in-text marker
    // (e.g. [表情包:x]) belongs to a pattern listed after a later-in-text marker
    // (e.g. [...拍了拍...]), the earlier marker lands in the un-parsed `before`
    // chunk and leaks as literal text. Ties keep list order (priority).
    const builtIn = findBuiltInRichCandidate(segment);
    const customApp = findCustomAppRichCandidate(segment);
    const best = customApp && (!builtIn || customApp.index < builtIn.index) ? customApp : builtIn;

    if (best) {
        const before = segment.slice(0, best.index).trim();
        const after = segment.slice(best.index + best.matchText.length).trim();

        // `before` is guaranteed marker-free (we chose the earliest marker).
        if (before) parts.push({ content: before });
        parts.push(best.build());
        if (after) parseSegment(after, parts);
        return;
    }

    // No rich media — plain text
    parts.push({ content: segment });
}

// ── Main parser ──────────────────────────────────────────

export function parseAIResponse(rawText: string, previousState: StateValue[]): ParsedAIResponse {
    // 0. FIRST of all: drop literal <think>…</think> the model wrote into its content.
    // Must run before the ```html / <style> protection below, otherwise a reasoning
    // block containing markup gets captured as a "real" HTML block and preserved.
    const deThought = stripReasoningTags(rawText);

    // 0.1. Extract ```html blocks and <style>+HTML before any further processing
    const htmlBlockPlaceholders: { placeholder: string; original: string }[] = [];
    let protected_ = deThought;
    // Protect ```html...``` blocks
    protected_ = protected_.replace(/```html\s*\n[\s\S]*?```/g, (match) => {
        const placeholder = `\x00HTML_BLOCK_${htmlBlockPlaceholders.length}\x00`;
        htmlBlockPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });
    // Protect <style>...</style> and the HTML after it (see htmlProtectionRegex)
    protected_ = protected_.replace(htmlProtectionRegex(), (match) => {
        const placeholder = `\x00HTML_BLOCK_${htmlBlockPlaceholders.length}\x00`;
        htmlBlockPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });

    // Helper to restore placeholders
    const restore = (text: string) => {
        let r = text;
        for (const { placeholder, original } of htmlBlockPlaceholders) {
            r = r.split(placeholder).join(original);
        }
        return r;
    };

    // 1. Parse state values
    const parsedSV = parseStateValues(protected_);
    const stateValues = mergeStateValues(previousState, parsedSV.stateValues);

    // 1.5. Strip AI hallucination XML/bracket action shells
    const actionCleaned = stripActionShells(parsedSV.cleanText);

    // 2. Extract display-only status panel, then inner monologue
    const status = extractBracketBlock(actionCleaned, BLOCK_TAG_STATUS_PANEL);
    const mono = extractBracketBlock(status.cleaned, BLOCK_TAG_INNER);

    // 2.1. Collapse residual blank lines left by tag extraction
    const postCleaned = mono.cleaned.replace(/\n{3,}/g, "\n\n").trim();

    // 2.5. Merge [引用:...] / [Quote:...] with following reply text even if separated by newlines
    const mergedText = postCleaned.replace(
        new RegExp(`(\\[${T_QUOTE}[：:][^\\]]+\\])\\s*\\n+\\s*`, "g"),
        "$1",
    );

    // 2.6. Collapse blank lines around [表情包:...] / [Sticker:...] so stickers stay
    //      in the same segment as adjacent text
    const stickerMerged = mergedText
        .replace(new RegExp(`\\n\\n+(?=\\[${T_STICKER}[：:][^\\]]+\\])`, "g"), "\n")
        .replace(new RegExp(`(\\[${T_STICKER}[：:][^\\]]+\\])\\n\\n+`, "g"), "$1\n");

    // 3. Split by double newlines (placeholders still in place)
    const segments = stickerMerged.split(/\n\n+/).map(s => s.trim()).filter(Boolean);

    // 4. Parse each segment
    const parts: ParsedMessagePart[] = [];
    for (const seg of segments) {
        parseSegment(seg, parts);
    }

    // 5. Restore HTML block placeholders and keep unknown bracket protocols as plain text.
    //    Strip tool directives (获取指令/执行动作) from display content too: a
    //    directive-only segment would otherwise survive as a non-empty part, render
    //    as an empty bubble after the display layer strips it, and capture the inner
    //    monologue (which then has nowhere to attach). Stripping here makes such a
    //    part empty → filtered out → inner monologue lands on the first real reply.
    const cleaned = parts.map(p => {
        if (p.mediaType) return p;
        const display = stripTextToolDirectives(restore(p.content));
        return { ...p, content: display };
    }).filter(p => p.mediaType || !isInvisibleOrWhitespaceOnly(p.content));

    return {
        parts: cleaned,
        stateValues,
        freshStateValues: parsedSV.stateValues,
        statusPanel: restore(status.content),
        innerMonologue: restore(mono.content),
    };
}
