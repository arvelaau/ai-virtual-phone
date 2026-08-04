// lib/call-tag-patterns.ts
//
// Single source of truth for reading the call system-message tags.
//
// The tags are written into a message's `content` field and therefore live in
// every chat history saved before the protocol migration. Two places read them
// back — `getChatMessagePreview` in lib/chat-storage.ts (session-list preview)
// and `formatSysMsgForUI` in components/chat/chat-room.tsx (chat bubble) — and
// they must agree, so the patterns live here rather than being duplicated.
//
// Dual-recognition: both the legacy Chinese tags and the going-forward English
// tags are accepted. Whichever language matched, the returned `callType` is
// ALWAYS the canonical Chinese label (语音通话 / 群视频通话 / …). That keeps the
// existing display templates working untouched and, crucially, stops English
// input from producing mixed-language output like "你向X发起了voice call".
// Translating the display strings is a separate, independent step.
//
// See PROTOCOL-MIGRATION-PLAN.md (family 2).

export type CallKind = "voice" | "video";

/** Canonical Chinese call-type label — the value every matcher reports. */
export function canonicalCallType(kind: CallKind, isGroup: boolean): string {
    return `${isGroup ? "群" : ""}${kind === "voice" ? "语音" : "视频"}通话`;
}

/** The Chinese sentinel used as the target of a group call. */
export const GROUP_CALL_TARGET = "群聊";

function kindFromChinese(text: string): CallKind {
    return text.includes("视频") ? "video" : "voice";
}

function kindFromEnglish(text: string): CallKind {
    return text.toLowerCase().includes("video") ? "video" : "voice";
}

/** Detects any call system message, in either language. */
export const CALL_SYS_RE =
    /\[(?:我(?:向.+)?(?:发起了|挂断了|拒绝了|取消了)群?(?:语音|视频)通话|I (?:started|ended|declined|cancelled|canceled) (?:a|the) (?:group )?(?:voice|video) call)/;

export function isCallSystemContent(content: string | undefined | null): boolean {
    return !!content && CALL_SYS_RE.test(content);
}

export type CallInitiateMatch = { raw: string; target: string; callType: string };

/**
 * [我向X发起了语音通话] / [I started a voice call with X]
 *
 * NOTE the asymmetry in the original protocol: for *initiate*, group-ness is
 * carried by the TARGET (target === 群聊) and the call type has NO 群 prefix
 * (legacy: `[我向群聊发起了语音通话]`). Hangup/reject/cancel do the opposite and
 * put 群 on the call type. So here the call type is always built ungrouped and
 * group-ness is normalised into the target, matching the legacy producer
 * exactly. `buildCallInitiateGroupTag` preserves the same shape in English.
 * (Caught by the Phase B fixture.)
 */
export function matchCallInitiate(text: string): CallInitiateMatch | null {
    const zh = text.match(/\[我向(.+?)发起了(群?(?:语音|视频)通话)\]/);
    if (zh) return { raw: zh[0], target: zh[1], callType: zh[2] };

    const en = text.match(/\[I started (?:a|the) (?:group )?(voice|video) call with (.+?)\]/i);
    if (en) {
        const target = en[2].trim();
        const isGroup = /\bgroup\b/i.test(en[0]) || target.toLowerCase() === "the group" || target === GROUP_CALL_TARGET;
        return {
            raw: en[0],
            target: isGroup ? GROUP_CALL_TARGET : target,
            callType: canonicalCallType(kindFromEnglish(en[1]), false),
        };
    }
    return null;
}

export type CallTypeMatch = { raw: string; callType: string };

/** [我发起了语音通话] / [I started a voice call] — no explicit target (follow-up AI). */
export function matchCallInitiateNoTarget(text: string): CallTypeMatch | null {
    const zh = text.match(/\[我发起了((?:语音|视频)通话)\]/);
    if (zh) return { raw: zh[0], callType: zh[1] };

    const en = text.match(/\[I started (?:a|the) (voice|video) call\]/i);
    if (en) return { raw: en[0], callType: canonicalCallType(kindFromEnglish(en[1]), false) };
    return null;
}

export type CallHangupMatch = { raw: string; callType: string; duration?: string };

/** [我挂断了语音通话](时长 05:23) / [I ended the voice call](duration 05:23) */
export function matchCallHangup(text: string): CallHangupMatch | null {
    const zh = text.match(/\[我挂断了(群?(?:语音|视频)通话)\](?:\(时长\s*([^)]+?)\))?/);
    if (zh) return { raw: zh[0], callType: zh[1], duration: zh[2] };

    const en = text.match(/\[I ended (?:a|the) (group )?(voice|video) call\](?:\((?:duration|time)\s*([^)]+?)\))?/i);
    if (en) {
        return {
            raw: en[0],
            callType: canonicalCallType(kindFromEnglish(en[2]), !!en[1]),
            duration: en[3],
        };
    }
    return null;
}

/** [我拒绝了语音通话] / [I declined the voice call] */
export function matchCallReject(text: string): CallTypeMatch | null {
    const zh = text.match(/\[我拒绝了(群?(?:语音|视频)通话)\]/);
    if (zh) return { raw: zh[0], callType: zh[1] };

    const en = text.match(/\[I declined (?:a|the) (group )?(voice|video) call\]/i);
    if (en) return { raw: en[0], callType: canonicalCallType(kindFromEnglish(en[2]), !!en[1]) };
    return null;
}

/** [我取消了语音通话] / [I cancelled the voice call] (also accepts "canceled") */
export function matchCallCancel(text: string): CallTypeMatch | null {
    const zh = text.match(/\[我取消了(群?(?:语音|视频)通话)\]/);
    if (zh) return { raw: zh[0], callType: zh[1] };

    const en = text.match(/\[I cancell?ed (?:a|the) (group )?(voice|video) call\]/i);
    if (en) return { raw: en[0], callType: canonicalCallType(kindFromEnglish(en[2]), !!en[1]) };
    return null;
}

// ── Builders (Phase C2: producers emit the English form) ────────────────
//
// Every call-tag producer goes through these, so the emitted wording can never
// drift from what the matchers above (and lib/rich-message-parser.ts) accept.
// Mind the protocol asymmetry documented on matchCallInitiate: for *initiate*
// group-ness rides on the TARGET, everywhere else it rides on the call type.

const en = (kind: CallKind) => (kind === "voice" ? "voice" : "video");

/** [I started a voice call with X] — 1:1. */
export function buildCallInitiateTag(kind: CallKind, target: string): string {
    return `[I started a ${en(kind)} call with ${target}]`;
}

/** [I started a voice call with the group] — mirrors [我向群聊发起了语音通话]. */
export function buildCallInitiateGroupTag(kind: CallKind): string {
    return `[I started a ${en(kind)} call with the group]`;
}

/**
 * [I started a voice call] — no explicit target.
 * Like its Chinese counterpart [我发起了语音通话] this is a system notice and
 * deliberately does NOT match the voice_call/video_call rich patterns.
 */
export function buildCallInitiateNoTargetTag(kind: CallKind): string {
    return `[I started a ${en(kind)} call]`;
}

/** [I ended the voice call](duration 05:23) */
export function buildCallHangupTag(kind: CallKind, isGroup: boolean, duration?: string): string {
    const tag = `[I ended the ${isGroup ? "group " : ""}${en(kind)} call]`;
    return duration ? `${tag}(duration ${duration})` : tag;
}

/** [I declined the voice call] */
export function buildCallRejectTag(kind: CallKind, isGroup: boolean): string {
    return `[I declined the ${isGroup ? "group " : ""}${en(kind)} call]`;
}

/** [I cancelled the voice call] */
export function buildCallCancelTag(kind: CallKind, isGroup: boolean): string {
    return `[I cancelled the ${isGroup ? "group " : ""}${en(kind)} call]`;
}

/** Replace a matched tag with display text, treating the match as a literal. */
export function replaceRaw(text: string, raw: string, replacement: string): string {
    const index = text.indexOf(raw);
    if (index < 0) return text;
    return text.slice(0, index) + replacement + text.slice(index + raw.length);
}

// `kindFromChinese` is exported for callers that need the kind of a canonical label.
export { kindFromChinese };
