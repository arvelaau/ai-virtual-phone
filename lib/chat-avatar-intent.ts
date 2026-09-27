import type { ChatMessage } from "./chat-storage";

// ── Avatar-recommendation control markers (canonical, shared with rich-message-parser
//    and chat-storage so all three readers can never drift apart from each other) ──
export const AVATAR_ACCEPT_RE = /[\[【]\s*(?:接受头像推荐|AcceptAvatarRecommendation)\s*[\]】]/i;
export const AVATAR_DECLINE_RE = /[\[【]\s*(?:拒绝头像推荐|DeclineAvatarRecommendation)\s*[\]】]/i;
export const AVATAR_DECISION_RE = /[\[【]\s*(?:接受头像推荐|拒绝头像推荐|AcceptAvatarRecommendation|DeclineAvatarRecommendation)\s*[\]】]/gi;

// ── Character-remark-for-user control marker ──
export const CHARACTER_REMARK_RE = /[\[【]\s*(?:给用户备注|给你备注|用户备注|RemarkForUser)\s*[：:]\s*([^\]】\n]{1,40})\s*[\]】]/i;

// User-typed avatar-change intent: matched against what the USER writes, in either
// language, so an English-speaking user's "change your avatar to this" is recognized
// exactly like the original "给你换个头像".
const AVATAR_INTENT_PATTERNS = [
    // Chinese: (换|改|设置|设成|设为|用作|当作|作为|换上) ... (头像|头图)
    /(?:换|改|设置|设成|设为|用作|当作|作为|换上).{0,8}(?:头像|头图)/i,
    // Chinese: (头像|头图) ... (换|改|设置|设成|设为|用这张|用这个|用它)
    /(?:头像|头图).{0,8}(?:换|改|设置|设成|设为|用这张|用这个|用它)/i,
    // Chinese: (给你|你|把这张|这张|这个|它) ... (当|做|换成|设为|用作|作为|换上) ... (头像|头图)
    /(?:给你|你|把这张|这张|这个|它).{0,10}(?:当|做|换成|设为|用作|作为|换上).{0,6}(?:头像|头图)/i,
    // Chinese: (这张|这个|它) ... (适合|很配) ... (你) ... (头像|头图)
    /(?:这张|这个|它).{0,8}(?:适合|很配).{0,6}(?:你).{0,6}(?:头像|头图)/i,
    // English: "change/set/use ... (your) avatar/profile pic/pfp"
    /\b(?:change|set|switch|update|use)\b.{0,20}\b(?:as\s+)?(?:your\s+)?(?:avatar|profile\s*pic(?:ture)?|pfp|profile\s*photo)\b/i,
    // English: "(this/it/that) as your avatar" / "make this your avatar"
    /\b(?:make|use|set)\b.{0,10}\b(?:this|it|that)\b.{0,15}\b(?:as\s+)?(?:your\s+)?(?:avatar|profile\s*pic(?:ture)?|pfp)\b/i,
    // English: "this suits/matches you as an avatar" (suggestive framing)
    /\b(?:this|it|that)\b.{0,15}\b(?:suits?|matches?|would\s+(?:look|be)\s+(?:good|great|nice)\s+(?:as|for))\b.{0,10}\b(?:your\s+)?(?:avatar|profile\s*pic(?:ture)?|pfp)\b/i,
];

const AVATAR_DECISION_PLACEHOLDER_PREFIX = "ai_phone_avatar_decision_";
const AVATAR_DECISION_PLACEHOLDER_SUFFIX = "_";
const AVATAR_INTENT_LOOKBACK_MESSAGES = 12;
const AVATAR_INTENT_LOOKBACK_MS = 30 * 60 * 1000;

function isAvatarChangeIntent(text: string): boolean {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return false;
    const collapsed = normalized.replace(/\s+/g, "");
    // "I just changed my avatar" is describing the USER's own change, not asking the
    // character to change theirs — must not be mistaken for a request.
    const describesOwnAvatar = /^(?:我|用户).{0,8}(?:刚|已经|又)?(?:换|改|设置).{0,5}(?:头像|头图)/i.test(collapsed)
        || /^(?:i|i've|i have|i just|i already)\b.{0,20}\b(?:changed|updated|set|switched)\b.{0,10}\b(?:my\s+)?(?:avatar|profile\s*pic(?:ture)?|pfp)\b/i.test(normalized);
    const directsOtherToChange = /(?:给你|帮你|让你|你也|你要不要|你该|你应该|对方|TA|char).{0,10}(?:换|改|设置|用|当).{0,6}(?:头像|头图)/i.test(collapsed)
        || /(?:把这张|这张|这个|它).{0,10}(?:换成|设为|用作|作为|当作).{0,6}(?:头像|头图)/i.test(collapsed)
        || /\byou(?:r|'ll|\s+should|\s+could)?\b.{0,15}\b(?:change|set|use|switch)\b.{0,10}\b(?:your\s+)?(?:avatar|profile\s*pic(?:ture)?|pfp)\b/i.test(normalized)
        || /\b(?:make|use|set)\b.{0,10}\b(?:this|it|that)\b.{0,15}\b(?:as\s+)?(?:your\s+)?(?:avatar|profile\s*pic(?:ture)?|pfp)\b/i.test(normalized);
    if (describesOwnAvatar && !directsOtherToChange) return false;
    return AVATAR_INTENT_PATTERNS.some(pattern => pattern.test(collapsed) || pattern.test(normalized));
}

function isUserImage(message: ChatMessage): boolean {
    return message.role === "user"
        && Boolean(message.mediaUrl)
        && (message.mediaType === "image"
            || (message.mediaType === "media_file" && message.mediaData?.fileType === "image"));
}

function unresolvedImageForCharacter(message: ChatMessage, characterId?: string): boolean {
    if (!isUserImage(message)) return false;
    if (message.mediaData?.avatarRecommendationForCharacterId
        && message.mediaData.avatarRecommendationForCharacterId !== characterId) return false;
    return message.mediaData?.avatarRecommendationStatus !== "accepted"
        && message.mediaData?.avatarRecommendationStatus !== "declined";
}

function isRecentEnough(image: ChatMessage, reference: ChatMessage): boolean {
    const imageTime = Date.parse(image.createdAt);
    const referenceTime = Date.parse(reference.createdAt);
    if (!Number.isFinite(imageTime) || !Number.isFinite(referenceTime)) return true;
    return referenceTime - imageTime <= AVATAR_INTENT_LOOKBACK_MS;
}

/**
 * Detects the user's most recent avatar-change intent and pairs it with the most
 * recent real album image.
 *
 * When the prompt is built the history ends on a user message; once the character's
 * reply is stored, history ends on an assistant message instead. This first skips the
 * latest run of assistant bubbles, then reads the user turn just before them. If a
 * reply already auto-fired after the image was sent and the user only then adds
 * "make that one my avatar", this also looks back across one reply batch for the
 * image — but never further than 12 messages or 30 minutes, so an old image can't be
 * mistaken for the intended one.
 */
export function findUserAvatarChangeIntent(
    history: ChatMessage[],
    sessionId: string,
    characterId?: string,
): { image: ChatMessage; intentText: string } | null {
    const sessionMessages = history.filter(message => message.sessionId === sessionId);
    if (sessionMessages.length === 0) return null;

    // resolvePendingAvatarRecommendation is called after the character's reply is already
    // cached. Skip the trailing bubbles from that same reply batch, so the user input that
    // actually triggered this reply is visible again.
    let endExclusive = sessionMessages.length;
    const trailing = sessionMessages[endExclusive - 1];
    if (trailing?.role === "assistant") {
        const trailingBatchId = trailing.responseBatchId;
        const trailingRaw = trailing.rawResponseText;
        while (endExclusive > 0) {
            const message = sessionMessages[endExclusive - 1];
            if (message.role !== "assistant") break;
            if (trailingBatchId && message.responseBatchId && message.responseBatchId !== trailingBatchId) break;
            if (!trailingBatchId && trailingRaw && message.rawResponseText && message.rawResponseText !== trailingRaw) break;
            endExclusive -= 1;
        }
    }

    const currentTurn: ChatMessage[] = [];
    let currentTurnStart = endExclusive;
    for (let index = endExclusive - 1; index >= 0; index -= 1) {
        const message = sessionMessages[index];
        if (message.role === "assistant") break;
        currentTurnStart = index;
        if (message.role === "user") currentTurn.unshift(message);
    }
    if (currentTurn.length === 0) return null;

    const intentText = currentTurn
        .flatMap(message => [message.content, message.mediaData?.label])
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n");
    if (!isAvatarChangeIntent(intentText)) return null;

    let image = [...currentTurn].reverse().find(message => unresolvedImageForCharacter(message, characterId));
    if (!image) {
        const reference = currentTurn[currentTurn.length - 1];
        const lookbackStart = Math.max(0, currentTurnStart - AVATAR_INTENT_LOOKBACK_MESSAGES);
        for (let index = currentTurnStart - 1; index >= lookbackStart; index -= 1) {
            const candidate = sessionMessages[index];
            if (!unresolvedImageForCharacter(candidate, characterId)) continue;
            if (!isRecentEnough(candidate, reference)) break;
            image = candidate;
            break;
        }
    }
    if (!image) return null;

    return { image, intentText };
}

/** A user regex can strip bracket tags; placeholder the avatar-decision markers first and restore them after the regex runs. */
export function applyWithProtectedAvatarDecisionMarkers(
    text: string,
    transform: (protectedText: string) => string,
): string {
    const markers: string[] = [];
    const protectedText = text.replace(AVATAR_DECISION_RE, marker => {
        const index = markers.push(marker) - 1;
        return `${AVATAR_DECISION_PLACEHOLDER_PREFIX}${index}${AVATAR_DECISION_PLACEHOLDER_SUFFIX}`;
    });
    const transformed = transform(protectedText);
    if (markers.length === 0) return transformed;
    const placeholderRe = new RegExp(`${AVATAR_DECISION_PLACEHOLDER_PREFIX}(\\d+)${AVATAR_DECISION_PLACEHOLDER_SUFFIX}`, "g");
    return transformed.replace(placeholderRe, (_placeholder, rawIndex: string) => markers[Number(rawIndex)] || "");
}

/** Conservative fallback for when the model occasionally forgets the control marker; a decline word always wins. */
export function inferAvatarDecisionFromReply(text: string): "accepted" | "declined" | null {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    const collapsed = normalized.replace(/\s+/g, "");
    if (AVATAR_DECLINE_RE.test(normalized)) return "declined";
    if (AVATAR_ACCEPT_RE.test(normalized)) return "accepted";
    if (/(?:不想|不愿|不要|不用|别|不换|算了|拒绝|还是算了).{0,10}(?:头像|这张|照片|图片|它)?/.test(collapsed)
        || /(?:头像|这张|照片|图片|它).{0,10}(?:不想|不愿|不要|不用|不换|算了|拒绝)/.test(collapsed)
        || /\b(?:no|nah)\b|\b(?:don'?t|won'?t)\s+want\b|\bnot\s+(?:interested|really)\b|\b(?:i'?ll|i\s+will)\s+(?:pass|skip|stick\s+with|keep)\b|\bmaybe\s+not\b/i.test(normalized)) {
        return "declined";
    }
    if (/(?:就用|换上|换成|设成|设为|当作头像|用作头像|收下|采用).{0,10}(?:这张|照片|图片|它|头像)?/.test(collapsed)
        || /(?:这张|照片|图片|它).{0,12}(?:就用|换上|换成|设成|设为|当头像|收下|采用)/.test(collapsed)
        || /\b(?:yes|yeah|yep|sure|okay|ok)\b.{0,15}\b(?:use|switch|change)\b|\b(?:i'?ll|i\s+will)\s+use\s+(?:this|that|it)\b|\blet'?s\s+use\s+(?:this|that|it)\b/i.test(normalized)) {
        return "accepted";
    }
    return null;
}
