// lib/proactive-reverse-sync.ts
// Stage 5 of Proactive Message 2.0 — pulls messages the deployed Worker
// generated while the app was closed, and merges them into local chat
// history. See PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// A push notification alone only tells the OS to show a banner; this is
// what actually makes the reply show up in the chat thread. Modeled closely
// on lib/weixin-cloud-sync.ts's importCloudAssistantMessage — same idea
// (parse the raw AI text into visible bubbles + state/status/inner-monologue
// side data, insert each via the existing dedup-safe upsert), adapted for
// cloudSync.source: "proactive-cloud" instead of "weixin-cloud".

import {
    CHAT_MESSAGE_PUSHED_EVENT,
    createOrGetSession,
    getLatestCharacterStateValues,
    hydrateChatStorage,
    loadChatMessages,
    upsertImportedChatMessage,
    type ChatMessage,
} from "./chat-storage";
import { ensureSettingsStorageHydrated } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { parseAIResponse } from "./rich-message-parser";
import { loadPushNotificationConfig } from "./push-notification-storage";
import { ackPendingMessages, pullPendingMessages, type PendingProactiveMessage } from "./proactive-worker-client";

export type ProactiveReverseSyncResult = {
    pulled: number;
    merged: number;
    sessionIds: string[];
    errors: string[];
};

const NON_VISIBLE_MEDIA_TYPES = new Set([
    "voice_call", "video_call",
    "accept_red_packet", "decline_red_packet",
    "accept_transfer", "decline_transfer",
    "accept_payment_request", "decline_payment_request",
]);

function makeImportedMessage(
    pending: PendingProactiveMessage,
    sessionId: string,
    index: number,
    patch: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">,
): ChatMessage {
    const baseTime = new Date(pending.createdAt).getTime();
    const safeTime = Number.isFinite(baseTime) ? baseTime : Date.now();
    return {
        id: `proactive_${pending.id}_${index}`,
        sessionId,
        status: "sent",
        createdAt: new Date(safeTime + index).toISOString(),
        ...patch,
        cloudSync: {
            source: "proactive-cloud",
            externalId: pending.id,
            direction: "outbound",
            syncedAt: new Date().toISOString(),
        },
    };
}

function mergeOnePendingMessage(pending: PendingProactiveMessage): { inserted: boolean; sessionId: string } {
    // The character may have been deleted locally between when the Worker
    // generated this message and now — createOrGetSession() doesn't
    // validate existence, so without this check a stale pending message
    // would silently create an orphan session for a character that's gone.
    const character = loadCharacters().find((c) => c.id === pending.characterId);
    if (!character) throw new Error("character_not_found");

    const session = createOrGetSession(pending.characterId);

    const alreadyImported = loadChatMessages(session.id).some(
        (m) => m.cloudSync?.source === "proactive-cloud" && m.cloudSync.externalId === pending.id,
    );
    if (alreadyImported) return { inserted: false, sessionId: session.id };

    const characterName = character.name || "Contact";
    const parsed = parseAIResponse(pending.content, getLatestCharacterStateValues(pending.characterId));
    const visibleParts = parsed.parts.filter((part) => !NON_VISIBLE_MEDIA_TYPES.has(part.mediaType || ""));

    const messages: ChatMessage[] = [];
    visibleParts.forEach((part, index) => {
        if (part.mediaType === "poke") {
            const pokeSender = (part.mediaData?.pokeSender === "我" ? characterName : part.mediaData?.pokeSender) || characterName;
            const pokeTarget = part.mediaData?.pokeTarget || "you";
            messages.push(makeImportedMessage(pending, session.id, index, {
                role: "system",
                content: `${pokeSender} poked ${pokeTarget}`,
                mediaType: "poke",
                mediaData: { pokeSender, pokeTarget },
            }));
            return;
        }
        messages.push(makeImportedMessage(pending, session.id, index, {
            role: "assistant",
            content: part.content,
            mediaType: part.mediaType,
            mediaData: part.mediaData,
            statusPanel: index === 0 && parsed.statusPanel ? parsed.statusPanel : undefined,
            innerMonologue: index === 0 && parsed.innerMonologue ? parsed.innerMonologue : undefined,
            stateValues: index === 0 && parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
            freshStateValues: index === 0 ? parsed.freshStateValues : undefined,
        }));
    });

    if (messages.length === 0 && (parsed.statusPanel || parsed.innerMonologue || parsed.stateValues.length > 0)) {
        messages.push(makeImportedMessage(pending, session.id, 0, {
            role: "assistant",
            content: "",
            statusPanel: parsed.statusPanel || undefined,
            innerMonologue: parsed.innerMonologue || undefined,
            stateValues: parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
            freshStateValues: parsed.freshStateValues,
        }));
    }
    if (messages.length === 0) {
        // The model said nothing that survives parsing (e.g. only an
        // unrecognized tag) — still record something rather than silently
        // dropping a message the user already got a push notification for.
        messages.push(makeImportedMessage(pending, session.id, 0, { role: "assistant", content: pending.content }));
    }

    let inserted = false;
    for (const message of messages) {
        const result = upsertImportedChatMessage(message);
        if (result.inserted) {
            inserted = true;
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent(CHAT_MESSAGE_PUSHED_EVENT, { detail: { message: result.message } }));
            }
        }
    }
    return { inserted, sessionId: session.id };
}

export type MergeLocallyResult = {
    merged: number;
    sessionIds: string[];
    errors: string[];
    /** ids safe to ack (deleted from the Worker): merged, already-merged, or unrecoverable. */
    ackIds: string[];
};

/**
 * The local half of reverse-sync: given already-pulled pending messages,
 * merges each into local chat history via the real parseAIResponse +
 * upsertImportedChatMessage pipeline. Pulled out from
 * pullAndMergeProactiveMessages() as its own function so it can be exercised
 * directly (e.g. from a debug hook) without needing a deployed Worker to
 * pull from. Does not talk to the Worker at all — no pull, no ack.
 */
export function mergePendingMessagesLocally(pending: PendingProactiveMessage[]): MergeLocallyResult {
    const sessionIds = new Set<string>();
    const ackIds: string[] = [];
    const errors: string[] = [];
    let merged = 0;

    for (const item of pending) {
        try {
            const { inserted, sessionId } = mergeOnePendingMessage(item);
            if (inserted) merged += 1;
            sessionIds.add(sessionId);
            // Ack regardless of `inserted` — false only means it was already
            // imported (e.g. a previous ack call failed after merging), and
            // it should still be cleared from the Worker's queue.
            ackIds.push(item.id);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${item.id}:${message}`);
            // The character is gone locally and isn't coming back — retrying
            // this message forever would just fail identically on every
            // future pull. Ack it away rather than let it become a
            // permanently-stuck poison pill. Any other error is left
            // un-acked so it's retried next time (may be transient).
            if (message === "character_not_found") ackIds.push(item.id);
        }
    }

    return { merged, sessionIds: [...sessionIds], errors, ackIds };
}

/**
 * Pulls every proactive message generated since the app was last open and
 * merges them into local chat history. No-op if no Worker is deployed. Safe
 * to call repeatedly (e.g. on app open and on tab visibility change) —
 * already-imported messages are skipped by cloudSync.externalId, and
 * successfully merged ones are ack'd (deleted) on the Worker so they are
 * not offered again.
 */
export async function pullAndMergeProactiveMessages(): Promise<ProactiveReverseSyncResult> {
    const { worker } = loadPushNotificationConfig();
    if (!worker) return { pulled: 0, merged: 0, sessionIds: [], errors: [] };

    await Promise.all([hydrateChatStorage(), ensureSettingsStorageHydrated()]);

    const pending = await pullPendingMessages(worker.workerUrl, worker.accessToken);
    if (pending.length === 0) return { pulled: 0, merged: 0, sessionIds: [], errors: [] };

    const { merged, sessionIds, errors, ackIds } = mergePendingMessagesLocally(pending);

    if (ackIds.length > 0) {
        await ackPendingMessages(worker.workerUrl, worker.accessToken, ackIds).catch((err) => {
            errors.push(`ack:${err instanceof Error ? err.message : String(err)}`);
        });
    }

    return { pulled: pending.length, merged, sessionIds, errors };
}
