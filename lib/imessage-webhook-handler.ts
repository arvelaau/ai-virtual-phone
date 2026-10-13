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
import { composeModelText, planOutbound, type QuoteCandidate } from "./imessage-content";
import { buildPhotoJob, mediaJobPath } from "./imessage-media-jobs";
import { extractTikTokUrls, formatTikTokContext } from "./tiktok-link";
import type { TikTokLookupResult } from "./server/tiktok-lookup";
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
    /** Present when the user sent this as a quoted reply. */
    quote?: { id: string; preview: string };
    /** A photo the user sent (already size-checked by the caller). */
    image?: { mimeType: string; dataBase64: string };
};

export type HandlerDeps = {
    readJson<T>(path: string): Promise<T | null>;
    putJson(path: string, value: unknown): Promise<void>;
    listRecentStored(lineId: string): Promise<IMessageCloudStoredMessage[]>;
    generate(
        snapshot: IMessageCloudRuntimeSnapshot,
        text: string,
        recent: IMessageCloudStoredMessage[],
        images?: Array<{ mimeType: string; dataBase64: string }>,
    ): Promise<string | { content: string; note?: string }>;
    /** `replyToId` asks for a native reply to that message. Resolves to the sent message id. */
    send(text: string, replyToId?: string): Promise<string | undefined | void>;
    now(): number;
    /** Waits without burning the CPU. Fixtures replace it with a fake clock. */
    sleep(ms: number): Promise<void>;
    /** A fresh unguessable id (job ids and job tokens). Optional so older fixtures keep working. */
    newId?(): string;
    /**
     * Reads a TikTok link (creator, caption, cover frame). Optional: without it links are left
     * exactly as the user wrote them. The webhook cannot run the chat plugin that does this in
     * the app, so it does it itself.
     */
    readTikTok?(url: string, options: { wantThumbnail: boolean }): Promise<TikTokLookupResult>;
};

/** Links read per turn. Each is a network round trip inside the webhook's time budget. */
const MAX_TIKTOK_LINKS_PER_TURN = 2;
const MAX_TIKTOK_COVERS = 2;

/** Default quiet window, and the hard ceiling (the function has to fit wait + model + send). */
export const DEFAULT_REPLY_DELAY_SECONDS = 60;
export const MAX_REPLY_DELAY_SECONDS = 120;
const POLL_MS = 5_000;
const MAX_BATCH_IMAGES = 4;

export function replyDelayMs(line: { replyDelaySeconds?: number } | undefined): number {
    const raw = line?.replyDelaySeconds;
    const seconds = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_REPLY_DELAY_SECONDS;
    return Math.round(Math.max(0, Math.min(MAX_REPLY_DELAY_SECONDS, seconds)) * 1000);
}

export async function handleInboundMessage(deps: HandlerDeps, input: InboundInput): Promise<TraceEvent> {
    const started = deps.now();
    const candidates = candidateAddresses(input.senderId, input.spaceId);
    const hint = candidates.length ? candidates.map(maskAddress).join(" / ") : maskAddress(input.senderId);
    const base = { senderHint: hint, messageType: input.contentType };
    const done = (result: Parameters<typeof traceEvent>[0], reason: string, detail?: string): TraceEvent =>
        traceEvent(result, reason, { ...base, detail, ms: deps.now() - started }, deps.now());

    if (isOutboundDirection(input.direction)) return done("ignored", "ignored_outbound");
    if (!input.image && (input.contentType !== "text" || !input.text.trim())) {
        // (a quoted reply arrives as text with a quote; see readInboundContent)
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

        let recent = await deps.listRecentStored(target.lineId);
        const modelText = composeModelText(input.text, input.quote);
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
            content: modelText || (input.image ? "[Image]" : ""),
        };
        if (input.image) {
            const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, "_");
            const mediaPath = `${IMESSAGE_CLOUD_PREFIX}/media/${safe(target.lineId)}/${safe(input.messageId)}.json`;
            await deps.putJson(mediaPath, { mimeType: input.image.mimeType, dataBase64: input.image.dataBase64 });
            inbound.image = { path: mediaPath, mimeType: input.image.mimeType };
        }
        await deps.putJson(inboundMessagePath(IMESSAGE_CLOUD_PREFIX, target.lineId, input.messageId), inbound);

        // Wait for a pause so a burst of bubbles is answered once. Every message writes the
        // pointer; whoever is still the latest after the quiet window is the one that answers,
        // and the older invocations step aside.
        let historyForModel = recent;
        let textForModel = modelText;
        let imagesForModel = input.image ? [input.image] : [];
        let batchedCount = 1;
        const waitMs = replyDelayMs(snapshot.line);
        if (waitMs > 0) {
            const safeLine = target.lineId.replace(/[^a-zA-Z0-9_-]/g, "_");
            const pointerPath = `${IMESSAGE_CLOUD_PREFIX}/pending/${safeLine}.json`;
            await deps.putJson(pointerPath, { latestId: input.messageId, at: deps.now() });
            const until = deps.now() + waitMs;
            while (deps.now() < until) {
                await deps.sleep(Math.min(POLL_MS, until - deps.now()));
                const pointer = await deps.readJson<{ latestId?: string }>(pointerPath).catch(() => null);
                if (pointer?.latestId && pointer.latestId !== input.messageId) {
                    await deps.putJson(markerPath, { state: "done", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
                    return done("ignored", "batched", `waiting ${Math.round(waitMs / 1000)}s of quiet; a newer message will answer this one too`);
                }
            }

            // Everything the user said since the character last spoke is one turn.
            const all = await deps.listRecentStored(target.lineId);
            if (!all.some((m) => m.direction === "inbound" && m.externalId === input.messageId)) all.push(inbound);
            const lastOutbound = all.filter((m) => m.direction === "outbound").map((m) => m.createdAt).sort().pop() ?? "";
            const pending = all
                .filter((m) => m.direction === "inbound" && m.createdAt > lastOutbound)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const pendingIds = new Set(pending.map((m) => m.externalId));
            recent = all;
            historyForModel = all.filter((m) => !pendingIds.has(m.externalId));
            textForModel = pending.map((m) => m.content).filter(Boolean).join("\n");
            batchedCount = Math.max(1, pending.length);
            const found: Array<{ mimeType: string; dataBase64: string }> = [];
            for (const m of pending.slice(-MAX_BATCH_IMAGES * 2)) {
                if (!m.image) continue;
                if (m.externalId === input.messageId && input.image) { found.push(input.image); continue; }
                const media = await deps.readJson<{ mimeType?: string; dataBase64?: string }>(m.image.path).catch(() => null);
                if (media?.dataBase64) found.push({ mimeType: media.mimeType || m.image.mimeType, dataBase64: media.dataBase64 });
            }
            imagesForModel = found.slice(-MAX_BATCH_IMAGES);
        }

        // A TikTok link in what the user said: read it so the character knows what it is. The
        // stored record keeps the user's words untouched; only this turn's model input grows.
        let linkNote = "";
        if (deps.readTikTok) {
            const links = extractTikTokUrls(textForModel, MAX_TIKTOK_LINKS_PER_TURN);
            if (links.length > 0) {
                const wantCover = snapshot.apiConfig?.enableImageRecognition === true;
                const results = await Promise.all(links.map((url) =>
                    deps.readTikTok!(url, { wantThumbnail: wantCover }).catch((): null => null),
                ));
                const blocks: string[] = [];
                const covers: Array<{ mimeType: string; dataBase64: string }> = [];
                let readable = 0;
                for (const result of results) {
                    if (result && result.ok) {
                        readable += 1;
                        blocks.push(formatTikTokContext(result.info));
                        const parsed = result.thumbnailDataUrl ? /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(result.thumbnailDataUrl) : null;
                        if (parsed && covers.length < MAX_TIKTOK_COVERS) covers.push({ mimeType: parsed[1].toLowerCase(), dataBase64: parsed[2] });
                    } else {
                        blocks.push(formatTikTokContext(null, result && !result.ok ? result.error : "lookup failed"));
                    }
                }
                textForModel = `${textForModel}\n\n${blocks.join("\n")}`;
                imagesForModel = [...imagesForModel, ...covers];
                linkNote = `read ${readable}/${links.length} TikTok link(s)${covers.length ? " with cover" : ""}`;
            }
        }

        let raw: string;
        let modelNote = "";
        try {
            const generated = await deps.generate(snapshot, textForModel, historyForModel, imagesForModel.length ? imagesForModel : undefined);
            raw = typeof generated === "string" ? generated : generated.content;
            modelNote = typeof generated === "string" ? "" : (generated.note ?? "");
            if (imagesForModel.length > 0 && snapshot.apiConfig?.enableImageRecognition !== true) {
                modelNote = `${modelNote ? `${modelNote}, ` : ""}photo received but image recognition is off in this API config, so the model saw only a placeholder`;
            }
        } catch (err) {
            await deps.putJson(markerPath, { state: "failed", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
            return done("error", "llm_error", errText(err));
        }

        const known: QuoteCandidate[] = recent
            .map((m) => ({ id: m.platformMessageId ?? (m.direction === "inbound" ? m.externalId : ""), text: m.content }))
            .filter((c) => c.id);
        // the message the user just quoted is a valid thing for the character to quote back
        if (input.quote?.id && input.quote.preview) known.push({ id: input.quote.id, text: input.quote.preview });
        const plan = planOutbound(raw, {
            currentId: input.messageId,
            currentText: input.text,
            known,
            photos: snapshot.capabilities?.photos === true && deps.newId ? "queue" : "text",
        });
        if (batchedCount > 1) plan.notes.unshift(`answered ${batchedCount} messages together`);
        if (linkNote) plan.notes.unshift(linkNote);
        const bubbles = plan.bubbles;
        if (bubbles.length === 0 && plan.photos.length === 0) {
            await deps.putJson(markerPath, { state: "failed", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
            return done("error", "empty_reply");
        }

        for (let i = 0; i < bubbles.length; i += 1) {
            let platformId: string | undefined;
            try {
                const sent = await deps.send(bubbles[i].text, bubbles[i].replyToId);
                platformId = typeof sent === "string" ? sent : undefined;
            } catch (err) {
                await deps.putJson(markerPath, { state: "failed", at: deps.now() } satisfies DeliveryMarker).catch(() => undefined);
                return done("error", "send_error", `bubble ${i + 1}/${bubbles.length}: ${errText(err)}`);
            }
            const { image: _inboundImage, ...inboundBase } = inbound;
            void _inboundImage;
            const outbound: IMessageCloudStoredMessage = {
                ...inboundBase,
                direction: "outbound",
                externalId: `${input.messageId}_reply_${i}`,
                createdAt: new Date(deps.now() + i).toISOString(),
                role: "assistant",
                content: bubbles[i].text,
                ...(platformId ? { platformMessageId: platformId } : {}),
            };
            await deps.putJson(
                inboundMessagePath(IMESSAGE_CLOUD_PREFIX, target.lineId, outbound.externalId),
                outbound,
            );
        }

        // Photos are delivered later by the browser; the job is what carries them there.
        for (const photo of plan.photos) {
            const jobId = `${input.messageId}_photo_${deps.newId!()}`.replace(/[^a-zA-Z0-9_-]/g, "_");
            const job = buildPhotoJob({
                id: jobId,
                token: deps.newId!() + deps.newId!(),
                lineId: target.lineId,
                characterId: target.characterId,
                sessionId: target.sessionId,
                description: photo.description,
                withRef: photo.withRef,
                now: deps.now(),
            });
            await deps.putJson(mediaJobPath(IMESSAGE_CLOUD_PREFIX, target.lineId, jobId), job);
        }

        await deps.putJson(markerPath, { state: "done", at: deps.now() } satisfies DeliveryMarker);
        const noteText = plan.notes.length ? `; ${plan.notes.join(", ")}` : "";
        const photoText = plan.photos.length ? ` + ${plan.photos.length} photo(s) queued` : "";
        return done("replied", "replied", `${bubbles.length} bubble(s)${photoText}${modelNote ? `, ${modelNote}` : ""}${noteText}`);
    } catch (err) {
        return done("error", "handler_error", errText(err));
    }
}

function errText(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 400);
}

// Re-exported so callers that already import the handler need only one module.
export { messagesAfterSnapshot, buildPromptFromTemplate };
