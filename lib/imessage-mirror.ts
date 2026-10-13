// lib/imessage-mirror.ts
// Should a message the character just sent IN THE APP also go out over real iMessage?
//
// The character can write first in the app: built-in follow-ups and timed wake-ups, and chat
// plugins that push a message every few minutes or hours. Those all land in the local chat
// through one function (pushChatMessage), but nothing carried them to the phone's iMessage.
// This is the decision half of that bridge. Pure, so every rule is driven from a fixture; the
// browser-side runner that acts on it lives in lib/imessage-cloud-sync.ts.

export type MirrorMode = "off" | "proactive" | "all";

export const DEFAULT_MIRROR_MODE: MirrorMode = "proactive";

/**
 * A reply to something the user typed in the app arrives within this long of it. Anything the
 * character says later than that, on its own, counts as it starting the conversation.
 */
export const LOCAL_REPLY_WINDOW_MS = 5 * 60_000;

/** A ceiling so a misbehaving plugin cannot flood the user's phone (or the Photon quota). */
export const MAX_MIRRORED_PER_HOUR = 20;

export type MirrorCandidate = {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    createdAt: string;
    mediaType?: string;
    status?: string;
    /** Set by the built-in follow-up service: this message is a follow-up round. */
    followUpIndex?: number;
    /** Set on messages imported from another channel (weixin, proactive worker, iMessage). */
    cloudSync?: unknown;
};

export type MirrorDecision =
    | { send: true; reason: "proactive" | "all" }
    | { send: false; reason:
          | "off" | "group" | "not_assistant" | "imported" | "not_delivered" | "not_text"
          | "empty" | "reply_to_local_user" | "rate_limited" };

export function normalizeMirrorMode(value: unknown): MirrorMode {
    return value === "off" || value === "all" || value === "proactive" ? value : DEFAULT_MIRROR_MODE;
}

/** The last thing the user typed IN THE APP before `at`, in epoch ms (imported iMessage turns do not count). */
export function lastLocalUserMessageAt(
    messages: Array<{ id: string; role: string; createdAt: string; cloudSync?: unknown }>,
    at: number,
): number | undefined {
    let best: number | undefined;
    for (const m of messages) {
        if (m.role !== "user" || m.id.startsWith("imsg_cloud_") || m.cloudSync) continue;
        const t = Date.parse(m.createdAt);
        if (!Number.isFinite(t) || t > at) continue;
        if (best === undefined || t > best) best = t;
    }
    return best;
}

export function decideMirror(args: {
    mode: MirrorMode;
    message: MirrorCandidate;
    isGroup: boolean;
    /** From lastLocalUserMessageAt: undefined = the user has never typed here. */
    lastLocalUserAt?: number;
    /** Epoch ms of earlier mirrored sends for this line, for the hourly ceiling. */
    recentMirrorTimes?: number[];
    now: number;
}): MirrorDecision {
    const { mode, message } = args;
    if (mode === "off") return { send: false, reason: "off" };
    if (args.isGroup) return { send: false, reason: "group" };
    if (message.role !== "assistant") return { send: false, reason: "not_assistant" };
    if (message.id.startsWith("imsg_cloud_") || message.cloudSync) return { send: false, reason: "imported" };
    if (message.status === "rejected" || message.status === "failed") return { send: false, reason: "not_delivered" };
    if (message.mediaType) return { send: false, reason: "not_text" };
    if (!message.content || !message.content.trim()) return { send: false, reason: "empty" };

    if (mode === "proactive") {
        const created = Date.parse(message.createdAt);
        const at = Number.isFinite(created) ? created : args.now;
        const isFollowUp = typeof message.followUpIndex === "number";
        const answersTheUser = !isFollowUp
            && args.lastLocalUserAt !== undefined
            && at - args.lastLocalUserAt >= 0
            && at - args.lastLocalUserAt < LOCAL_REPLY_WINDOW_MS;
        if (answersTheUser) return { send: false, reason: "reply_to_local_user" };
    }

    const cutoff = args.now - 3600_000;
    const sentThisHour = (args.recentMirrorTimes ?? []).filter((t) => t > cutoff).length;
    if (sentThisHour >= MAX_MIRRORED_PER_HOUR) return { send: false, reason: "rate_limited" };

    return { send: true, reason: mode === "all" ? "all" : "proactive" };
}

/** Deterministic job id, so the same local message can never become two jobs. */
export function mirrorJobId(localMessageId: string): string {
    return `mirror_${localMessageId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}
