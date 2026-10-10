// lib/imessage-webhook-handler.ts
// The decision-and-orchestration part of the iMessage webhook, with every side effect
// injected. The route supplies Supabase, the LLM call and `space.send`; a fixture supplies
// fakes. Returns exactly one trace event describing what happened to the message.

import {
    buildPromptFromTemplate,
    inboundMessagePath,
    messagesAfterSnapshot,
    modelOutputToBubbles,
} from "./imessage-webhook-core";
import {
    candidateAddresses,
    findLineForCandidates,
    isOutboundDirection,
    maskAddress,
    shouldSkipDelivery,
    traceEvent,
    type DeliveryMarker,
    type TraceEvent,
} from "./imessage-webhook-trace";
import type {
    IMessageCloudRuntimeIndex,
    IMessageCloudRuntimeSnapshot,
    IMessageCloudStoredMessage,
} from "./imessage-types";

export const IMESSAGE_CLOUD_PREFIX = "imessage-cloud";
export const IMESSAGE_CLOUD_INDEX_PATH = `${IMESSAGE_CLOUD_PREFIX}/index.json`;

const safePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

export function deliveryMarkerPath(lineId: string, messageId: string): string {
    return `${IMESSAGE_CLOUD_PREFIX}/seen/${safePart(lineId)}/${safePart(messageId)}.json`;
}

export type InboundInput = {
    messageId: string;
    senderId: string;
    spaceId: string;
    direction: unknown;
    contentType: string;
    text: string;
};

export type HandlerDeps = {
    readJson<T>(path: string): Promise<T | null>;
    putJson(path: string, value: unknown): Promise<void>;
    listRecentStored(lineId: string): Promise<IMessageCloudStoredMessage[]>;
    generate(snapshot: IMessageCloudRuntimeSnapshot, text: string, recent: IMessageCloudStoredMessage[]): Promise<string>;
    send(text: string): Promise<void>;
    now(): number;
};

export async function handleInboundMessage(deps: HandlerDeps, input: InboundInput): Promise<TraceEvent> {
    const started = deps.now();
    const candidates = candidateAddresses(input.senderId, input.spaceId);
    const hint = candidates.length ? candidates.map(maskAddress).join(" / ") : maskAddress(input.senderId);
    const base = { senderHint: hint, messageType: input.contentType };
    const done = (result: Parameters<typeof traceEvent>[0], reason: string, detail?: string): TraceEvent =>
        traceEvent(result, reason, { ...base, detail, ms: deps.now() - started }, deps.now());

    if (isOutboundDirection(input.direction)) return done("ignored", "ignored_outbound");
    if (input.contentType !== "text" || !input.text.trim()) {
        return done("ignored", "ignored_non_text", `content type "${input.contentType || "unknown"}"`);
    }

    let index: IMessageCloudRuntimeIndex | null;
    try {
        index = await deps.readJson<IMessageCloudRuntimeIndex>(IMESSAGE_CLOUD_INDEX_PATH);
    } catch (err) {
        return done("error", "handler_error", `reading the index failed: ${errText(err)}`);
    }
    if (!index) return done("rejected", "no_cloud_index");

    const target = findLineForCandidates(index, candidates);
    if (!target) {
        const bound = index.lines.map((line) => maskAddress(line.phone)).join(", ") || "none";
        return done("rejected", "sender_not_bound", `got ${hint}; bound numbers: ${bound}`);
    }

    const markerPath = deliveryMarkerPath(target.lineId, input.messageId);
    let marker: DeliveryMarker | null = null;
    try {
        marker = await deps.readJson<DeliveryMarker>(markerPath);
    } catch { /* an unreadable marker must not block a reply */ }
    const skip = shouldSkipDelivery(marker, deps.now());
    if (skip.skip) return done("ignored", skip.reason!);

    let snapshot: IMessageCloudRuntimeSnapshot | null;
    try {
        snapshot = await deps.readJson<IMessageCloudRuntimeSnapshot>(target.path);
    } catch (err) {
        return done("error", "handler_error", `reading the runtime package failed: ${errText(err)}`);
    }
    if (!snapshot) return done("rejected", "no_snapshot");
    if (!snapshot.line?.enabled) return done("rejected", "line_disabled");

    try {
        await deps.putJson(markerPath, { state: "processing", at: deps.now() } satisfies DeliveryMarker);

        const recent = await deps.listRecentStored(target.lineId);
        const inbound: IMessageCloudStoredMessage = {
            format: "ai-phone-imessage-cloud-message",
            version: 1,
            direction: "inbound",
            lineId: target.lineId,
            characterId: target.characterId,
            sessionId: target.sessionId,
            externalId: input.messageId,
            createdAt: new Date(deps.now()).toISOString(),
            role: "user",
            content: input.text,
        };
        await deps.putJson(inboundMessagePath(IMESSAGE_CLOUD_PREFIX, target.lineId, input.messageId), inbound);

        let raw: string;
        try {
            raw = await deps.generate(snapshot, input.text, recent);
        } catch (err) {
            await deps.putJson(markerPath, { state: "failed", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
            return done("error", "llm_error", errText(err));
        }

        const bubbles = modelOutputToBubbles(raw);
        if (bubbles.length === 0) {
            await deps.putJson(markerPath, { state: "failed", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
            return done("error", "empty_reply");
        }

        for (let i = 0; i < bubbles.length; i += 1) {
            try {
                await deps.send(bubbles[i]);
            } catch (err) {
                await deps.putJson(markerPath, { state: "failed", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
                return done("error", "send_error", `bubble ${i + 1}/${bubbles.length}: ${errText(err)}`);
            }
            const outbound: IMessageCloudStoredMessage = {
                ...inbound,
                direction: "outbound",
                externalId: `${input.messageId}_reply_${i}`,
                createdAt: new Date(deps.now() + i).toISOString(),
                role: "assistant",
                content: bubbles[i],
            };
            await deps.putJson(
                inboundMessagePath(IMESSAGE_CLOUD_PREFIX, target.lineId, outbound.externalId),
                outbound,
            );
        }

        await deps.putJson(markerPath, { state: "done", at: deps.now() } satisfies DeliveryMarker);
        return done("replied", "replied", `${bubbles.length} bubble(s)`);
    } catch (err) {
        return done("error", "handler_error", errText(err));
    }
}

function errText(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// Re-exported so callers that already import the handler need only one module.
export { messagesAfterSnapshot, buildPromptFromTemplate };
