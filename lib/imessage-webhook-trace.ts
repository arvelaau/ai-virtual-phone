// lib/imessage-webhook-trace.ts
// Pure helpers for the iMessage webhook's diagnostics and delivery bookkeeping.
//
// Why this exists: the webhook has half a dozen ways to end without sending a reply
// (unbound sender, never synced, disabled line, SDK dropped the event ...) and on a
// serverless host none of them is visible. Every outcome is therefore recorded as a small
// trace event the Settings page can read back.

import { findLineForSender, normalizeIMessageAddress } from "./imessage-webhook-core";
import type { IMessageCloudRuntimeIndex, IMessageCloudRuntimeIndexItem } from "./imessage-types";

export type TraceResult = "replied" | "ignored" | "rejected" | "error";

export type TraceEvent = {
    at: string;
    result: TraceResult;
    /** Stable machine-readable code, see REASON_TEXT. */
    reason: string;
    /** Extra human-readable context (never a secret, addresses are masked). */
    detail?: string;
    senderHint?: string;
    messageType?: string;
    ms?: number;
};

export const REASON_TEXT: Record<string, string> = {
    replied: "Reply sent.",
    signature_rejected: "Photon's signature did not verify. PHOTON_WEBHOOK_SECRET probably does not match this webhook.",
    malformed_payload: "The request body was not a valid Spectrum webhook payload.",
    no_message: "The webhook carried no message (a non-message event).",
    sdk_never_delivered: "The Spectrum SDK accepted the webhook but never handed over a message. The event type may be unsupported, or the iMessage provider was not configured.",
    ignored_outbound: "Ignored a message that this project sent itself.",
    ignored_non_text: "Ignored a message that is not plain text (image, reaction, voice, ...).",
    no_cloud_index: "No runtime index found in Supabase. Press 'Sync to cloud', and make sure IMESSAGE_SUPABASE_URL points at the same project as Cloud Backup.",
    sender_not_bound: "The sender is not one of the numbers bound in Settings.",
    line_disabled: "The line for this number is switched off.",
    no_snapshot: "The runtime package for this line is missing in Supabase. Press 'Sync to cloud' again.",
    already_handled: "A retry of a message that was already answered.",
    still_processing: "A retry arrived while the first attempt was still working.",
    batched: "Waiting for a pause in the conversation: a newer message arrived, so that one answers both.",
    empty_reply: "The model returned nothing that could be sent.",
    llm_error: "The model call failed.",
    send_error: "Sending the reply over iMessage failed.",
    handler_error: "The handler crashed.",
};

/** "+15551234567" -> "+15…567", "a@b.com" -> "a***@b.com". Enough to tell numbers apart. */
export function maskAddress(value: string): string {
    const v = (value || "").trim();
    if (!v) return "(empty)";
    if (v.includes("@")) {
        const [local, domain] = v.split("@");
        return `${local.slice(0, 1)}***@${domain}`;
    }
    const digits = v.replace(/[^0-9]/g, "");
    if (digits.length <= 6) return "***";
    return `${v.startsWith("+") ? "+" : ""}${digits.slice(0, 2)}…${digits.slice(-3)}`;
}

/** Only an explicit "outbound" is skipped; a missing direction is treated as inbound. */
export function isOutboundDirection(direction: unknown): boolean {
    return typeof direction === "string" && direction.trim().toLowerCase() === "outbound";
}

/**
 * iMessage space ids look like "iMessage;-;+15551234567" (service;-;address). The address
 * is the last segment and is the fallback when the message carries no usable sender.
 */
export function addressFromSpaceId(spaceId: unknown): string {
    const raw = typeof spaceId === "string" ? spaceId.trim() : "";
    if (!raw) return "";
    const last = raw.includes(";") ? raw.slice(raw.lastIndexOf(";") + 1).trim() : raw;
    return /^\+?[0-9][0-9 ()\-]{5,}$/.test(last) || last.includes("@") ? last : "";
}

export function candidateAddresses(senderId: unknown, spaceId: unknown): string[] {
    const out: string[] = [];
    for (const v of [typeof senderId === "string" ? senderId : "", addressFromSpaceId(spaceId)]) {
        const norm = normalizeIMessageAddress(v);
        if (norm && !out.some((existing) => normalizeIMessageAddress(existing) === norm)) out.push(v);
    }
    return out;
}

export function findLineForCandidates(
    index: IMessageCloudRuntimeIndex,
    candidates: string[],
): IMessageCloudRuntimeIndexItem | null {
    for (const candidate of candidates) {
        const hit = findLineForSender(index, candidate);
        if (hit) return hit;
    }
    return null;
}

/** Newest first, capped. Never mutates the input. */
export function pushTrace(existing: TraceEvent[], event: TraceEvent, max = 15): TraceEvent[] {
    return [event, ...existing].slice(0, Math.max(1, max));
}

export type DeliveryMarker = { state: "processing" | "done" | "failed"; at: number };

/** How long a "processing" marker is trusted before a retry may take over. */
export const PROCESSING_STALE_MS = 3 * 60 * 1000;

/**
 * Decides whether a redelivery of a message should be skipped.
 *  - done:       skip, it was answered.
 *  - processing: skip while fresh. If the function was killed mid-way (timeout) the marker
 *                goes stale and the retry may take over, so a crash cannot silence a message
 *                forever.
 *  - failed / none: process.
 */
export function shouldSkipDelivery(
    marker: DeliveryMarker | null,
    nowMs: number,
    staleMs = PROCESSING_STALE_MS,
): { skip: boolean; reason?: "already_handled" | "still_processing" } {
    if (!marker) return { skip: false };
    if (marker.state === "done") return { skip: true, reason: "already_handled" };
    if (marker.state === "processing" && nowMs - marker.at < staleMs) {
        return { skip: true, reason: "still_processing" };
    }
    return { skip: false };
}

export function traceEvent(
    result: TraceResult,
    reason: string,
    extra: Partial<Omit<TraceEvent, "at" | "result" | "reason">> = {},
    nowMs: number = Date.now(),
): TraceEvent {
    return { at: new Date(nowMs).toISOString(), result, reason, ...extra };
}
