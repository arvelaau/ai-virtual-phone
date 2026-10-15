// lib/imessage-webhook-core.ts
// Pure decision logic for the iMessage webhook (app/api/imessage/webhook). Kept free of
// network and storage so it can be driven directly by a fixture.

import { stripReasoningTags } from "./block-tags";
import { stripStateAndInnerForPrompt } from "./prompt-sanitizer";
import type { LLMMessage } from "./llm-prompt-assembler";
import { applyFreshTime, stampTurns, type IMessageTimeSettings } from "./imessage-time";
import type {
    IMessageCloudPromptTemplate,
    IMessageCloudRuntimeIndex,
    IMessageCloudRuntimeIndexItem,
    IMessageCloudStoredMessage,
} from "./imessage-types";

/** Phones compare by digits only ("+1 (555) 123-4567" == "15551234567"); emails by lowercase. */
export function normalizeIMessageAddress(value: string): string {
    const trimmed = (value || "").trim();
    if (!trimmed) return "";
    if (trimmed.includes("@")) return trimmed.toLowerCase();
    return trimmed.replace(/[^0-9]/g, "");
}

/** Finds the bound line for the human who texted in. Disabled lines never match. */
export function findLineForSender(
    index: IMessageCloudRuntimeIndex,
    senderId: string,
): IMessageCloudRuntimeIndexItem | null {
    const wanted = normalizeIMessageAddress(senderId);
    if (!wanted) return null;
    return index.lines.find((line) => normalizeIMessageAddress(line.phone) === wanted) ?? null;
}

const MAX_REPLY_BUBBLES = 5;
const MAX_BUBBLE_CHARS = 1500;

/**
 * Turns the model's raw output into the plain-text bubbles that go out over iMessage.
 * Reasoning and the state / inner-thoughts blocks never leave the server. Blank-line
 * separated paragraphs become separate bubbles, as in the Chat app.
 */
export function modelOutputToBubbles(raw: string): string[] {
    const cleaned = stripStateAndInnerForPrompt(stripReasoningTags(raw || "")).trim();
    if (!cleaned) return [];
    const bubbles = cleaned
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (part.length > MAX_BUBBLE_CHARS ? `${part.slice(0, MAX_BUBBLE_CHARS - 1)}…` : part));
    return bubbles.slice(0, MAX_REPLY_BUBBLES);
}

/**
 * Cloud records written after the snapshot was built. Earlier ones are already baked
 * into the template's history, so including them again would double every turn.
 */
export function messagesAfterSnapshot(
    stored: IMessageCloudStoredMessage[],
    snapshotCreatedAt: string,
    limit: number,
): IMessageCloudStoredMessage[] {
    return stored
        .filter((item) => item.createdAt > snapshotCreatedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit);
}

/** before + (history since the snapshot) + the new inbound message + after. */
export function buildPromptFromTemplate(
    template: IMessageCloudPromptTemplate,
    recent: IMessageCloudStoredMessage[],
    inboundText: string,
    images?: Array<{ mimeType: string; dataBase64: string }>,
    /** From the snapshot. Without it the template is used exactly as stored (older snapshots). */
    time?: { settings?: IMessageTimeSettings; now: Date },
): LLMMessage[] {
    // Turns carry the same "(2026-10-12 21:05)" stamp the app puts in front of each one.
    const stamped = stampTurns(
        [
            ...recent.map((item) => ({ role: item.role as string, content: item.content, at: item.createdAt })),
            { role: "user", content: inboundText || (images && images.length > 0 ? "[Image]" : ""), at: time?.now ?? new Date() },
        ],
        time?.settings,
    );
    const turns: LLMMessage[] = stamped.slice(0, -1).map((turn) => ({ role: turn.role as LLMMessage["role"], content: turn.content }));
    const last = stamped[stamped.length - 1];
    turns.push(
        images && images.length > 0
            ? {
                  role: "user",
                  content: [
                      { type: "text", text: last.content },
                      ...images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } })),
                  ],
              }
            : { role: "user", content: last.content },
    );
    const built = [...template.beforeMessages, ...turns, ...template.afterMessages];
    return time ? applyFreshTime(built, time.settings, time.now) : built;
}

export function inboundMessagePath(prefix: string, lineId: string, externalId: string): string {
    const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${prefix}/messages/${safe(lineId)}/${safe(externalId)}.json`;
}
