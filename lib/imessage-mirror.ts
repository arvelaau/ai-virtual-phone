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

/** What the user is told when a message did or did not go out. */
export function describeMirrorOutcome(reason: string): string {
    switch (reason) {
        case "proactive": return "Sent (the character started the conversation)";
        case "all": return "Sent";
        case "off": return "Not sent: mirroring is switched off for this line";
        case "not_assistant": return "Not sent: only the character's own messages are mirrored";
        case "group": return "Not sent: group chats are not mirrored";
        case "imported": return "Not sent: it came from iMessage in the first place";
        case "not_delivered": return "Not sent: the message was rejected in the app";
        case "not_text": return "Not sent: only plain text is mirrored (pictures, stickers and cards stay in the app)";
        case "empty": return "Not sent: the message was empty";
        case "reply_to_local_user":
            return "Not sent: it answered something you typed in the app. Your setting is \"Send the ones the character starts\"; choose \"Send everything the character writes in the app\" to send replies too";
        case "rate_limited": return `Not sent: more than ${MAX_MIRRORED_PER_HOUR} an hour`;
        case "already_mirrored": return "Skipped: already sent";
        case "no_cloud_backup": return "Not sent: Cloud Backup (Supabase) is not set up";
        case "no_bound_line": return "Not sent: no enabled iMessage line for this chat";
        case "missing_photon_env": return "Not sent: PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET are missing on the server";
        case "missing_supabase_env": return "Not sent: the iMessage Supabase variables are missing on the server";
        case "line_not_found": return "Not sent: the server does not know this line. Press Sync to cloud";
        case "bad_token": return "Not sent: the server refused the delivery token";
        case "send_error": return "Not sent: Photon could not deliver it (it will be retried while the app is open)";
        case "storage_error": return "Not sent: the server could not read Supabase";
        case "expired": return "Not sent: it waited too long and was dropped";
        case "network_error": return "Not sent: the app could not reach the server";
        default:
            return reason.startsWith("http_")
                ? `Not sent: the server answered ${reason.slice(5)}`
                : `Not sent: ${reason}`;
    }
}

/** Deterministic job id, so the same local message can never become two jobs. */
export function mirrorJobId(localMessageId: string): string {
    return `mirror_${localMessageId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}
