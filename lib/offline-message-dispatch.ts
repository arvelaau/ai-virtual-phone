// lib/offline-message-dispatch.ts
// Offline mode's counterpart to two chat-only mechanisms: story mode's [Message] action (lets a
// character send a real chat message from inside a narrated turn instead of only narrating in
// third person), and custom-app chat directives (lets a character trigger a rich, clickable
// HTML card -- a boarding pass, a menu -- the same way it already can in live chat).
//
// Kept as its own leaf module rather than folded into chat-offline-storage.ts or chat-engine.ts,
// specifically to avoid closing an import cycle: chat-engine.ts already imports
// chat-offline-storage.ts (for parseOfflineResponse), and both action-parser.ts (via
// follow-up-service.ts) and rich-message-parser.ts (via action-parser.ts) lead back to
// chat-engine.ts. So either chat-engine.ts or chat-offline-storage.ts importing either of those
// two directly would close the loop. This module is only ever imported from the UI layer
// (chat-room.tsx), which nothing under lib/ imports back into, so it can safely depend on all
// of them.
//
// [Message] scope is deliberately 1:1 offline only (generateOfflineChatCompletion), not group
// offline -- group action dispatch already has a known, deliberately deferred gap (see
// CLAUDE.md's "group chat + Native Tool Calling drops action tags"), and this feature shouldn't
// compound it. The app-card extraction below has no such restriction; it doesn't touch
// dispatchActions at all.

import { parseActionTags, dispatchActions, type ActionTag } from "./action-parser";
import { isCompleteDispatchableMessage, narrativeTextSurvives } from "./narrative-message-guards";
import { parseOfflineResponse, type ParsedOfflineResponse } from "./chat-offline-storage";
import { extractCustomAppCard, type ExtractedCustomAppCard } from "./rich-message-parser";

const OFFLINE_DEFAULT_CONTEXT_EXCLUDED_TAGS = "think,thinking";

/** Offline's own structural fields: `<content>`, the generic `<summary>` fallback, and whatever custom tag this session configured. */
function offlineStructuralFields(summaryTag: string): string[] {
    return ["content", "summary", summaryTag];
}

export function isCompleteOfflineMessage(action: { content: string; rawText?: string }, summaryTag: string): boolean {
    return isCompleteDispatchableMessage(action, offlineStructuralFields(summaryTag));
}

function offlineTextSurvives(cleanText: string, summaryTag: string): boolean {
    return narrativeTextSurvives(cleanText, undefined, offlineStructuralFields(summaryTag), OFFLINE_DEFAULT_CONTEXT_EXCLUDED_TAGS);
}

export type OfflineMessageDispatchResult = {
    /** The offline response re-parsed from the action-tag-and-app-card-stripped text -- use this instead of a parse of the raw text, or a [Message] block or app-card directive inside <content> would leak into the displayed turn. */
    parsed: ParsedOfflineResponse;
    /** The [Message] actions to dispatch, already filtered to the complete/safe ones. Empty when none should fire. */
    dispatchable: ActionTag[];
    /** The custom-app card this turn triggered (a boarding-pass/menu-style directive), if any. */
    appCard: ExtractedCustomAppCard | null;
};

/**
 * Parses [Message] actions and a custom-app card directive out of an offline turn's raw output
 * the same way story mode does for [Message]: both come off the raw text BEFORE the offline
 * parser runs, and a turn that got entirely swallowed by the [Message] tag (an
 * unclosed/mismatched block, or the whole turn wrapped in it) fires nothing -- see
 * narrative-message-guards.ts for why each of those checks exists. The two extractions cannot
 * collide: a custom app's directive syntax head is validated at registration time to never
 * shadow a built-in action tag name (see CLAUDE.md's Phase A4 KNOWN_ACTION_TAGS note), so
 * running [Message] extraction first and then scanning what's left for a directive is safe.
 */
export function extractOfflineDispatchableMessages(rawText: string, summaryTag: string): OfflineMessageDispatchResult {
    const { cleanText: afterActions, actions } = parseActionTags(rawText);
    let dispatchable = actions.filter(a => a.type === "消息" && isCompleteOfflineMessage(a, summaryTag));
    if (dispatchable.length && !offlineTextSurvives(afterActions, summaryTag)) dispatchable = [];

    const appCard = extractCustomAppCard(afterActions);
    const afterAppCard = appCard
        ? (afterActions.slice(0, appCard.matchIndex) + afterActions.slice(appCard.matchIndex + appCard.matchLength)).trim()
        : afterActions;

    return { parsed: parseOfflineResponse(afterAppCard, summaryTag), dispatchable, appCard };
}

/** Dispatches the [Message] actions found by extractOfflineDispatchableMessages(). Fire-and-forget: a failed side effect must never take the offline turn down with it, exactly as chat/moments/story do. */
export function dispatchOfflineMessages(
    dispatchable: ActionTag[],
    context: { characterId: string; signal?: AbortSignal },
): void {
    if (dispatchable.length === 0) return;
    dispatchActions(dispatchable, { characterId: context.characterId, sourceEngine: "offline", signal: context.signal })
        .catch(err => console.warn("[OfflineMessageDispatch] chat message dispatch failed:", err));
}
