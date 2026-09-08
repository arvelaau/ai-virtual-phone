// lib/custom-app-moments-pin.ts
// "Pin to Moments" -- lets the user pin a directive-triggered card (chat, story, or offline)
// into a couple-space-capable custom app's own Moments gallery. See
// PROACTIVE-MESSAGE-2.0-PLAN.md's Phase E for the design.
//
// Deliberately does NOT go through the AI.on("...") custom-app event-bus / background-runtime
// machinery chat.message.created uses (see components/app-market/custom-app-runner.tsx +
// desktop-shell.tsx's parallel live/background dispatch paths for that one event) -- that
// machinery exists because chat.message.created needs to notify ANY subscribed app the moment
// a message is saved, from anywhere in the app, including while the target app isn't open.
// A pin is different: it is a single, host-initiated write triggered by a direct user action,
// and the host can already read/write any installed app's own data collections directly via
// readCustomAppCollection/writeCustomAppCollection -- no event delivery, no permission check,
// no background sandboxed runtime needed. The pinned app reads the row back exactly the way it
// reads anything else it wrote itself, via its own `AI.db.list("moments", …)` call.

import { loadInstalledCustomApps, readCustomAppCollection, writeCustomAppCollection } from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";

export const MOMENTS_PIN_COLLECTION = "moments";
const MAX_PINNED_PER_CHARACTER = 200;

export type AppCardPinSourceMode = "chat" | "story" | "offline";

export type AppCardPinInput = {
    characterId: string;
    characterName: string;
    sourceMode: AppCardPinSourceMode;
    /** The enclosing turn's own summary -- story's storySummary, offline's turn.summary, or
     *  (chat has no per-message summary) the message's own visible text, truncated by the caller. */
    summary: string;
    appCardLayout: Record<string, unknown>;
    /** Which app's directive produced the card -- purely informational for the gallery. */
    cardAppId?: string;
    cardAppName?: string;
    messageId?: string;
    sessionId?: string;
};

export type AppCardPinResult = {
    ok: boolean;
    /** The app the card was pinned into, when ok is true. */
    targetAppId?: string;
    targetAppName?: string;
    error?: string;
};

function cleanText(value: unknown, maxLength: number): string {
    return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function recordId(): string {
    return `pin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The installed app(s) declaring `extensions.moments.acceptsPinnedCards`. When more than one
 * is installed, the first (by install order in loadInstalledCustomApps()) is used -- a
 * deliberate simplification, not a resolved multi-target design; documented rather than
 * building a picker UI for a scenario with no real precedent yet.
 */
export function findMomentsPinTargetApps(): InstalledCustomApp[] {
    return loadInstalledCustomApps().filter(app => app.manifest.extensions?.moments?.acceptsPinnedCards === true);
}

export function findMomentsPinTargetApp(): InstalledCustomApp | null {
    return findMomentsPinTargetApps()[0] ?? null;
}

/** Whether a Pin action has anywhere to go right now -- callers use this to decide whether to
 *  even offer the action, without needing to know which app it would land in. */
export function hasMomentsPinTarget(): boolean {
    return findMomentsPinTargetApp() !== null;
}

export function pinAppCardToMoments(input: AppCardPinInput): AppCardPinResult {
    const target = findMomentsPinTargetApp();
    if (!target) return { ok: false, error: "No app is set up to receive pinned cards." };

    const characterId = cleanText(input.characterId, 120);
    if (!characterId) return { ok: false, error: "No character context." };
    if (!input.appCardLayout || typeof input.appCardLayout !== "object") {
        return { ok: false, error: "This card has nothing to pin." };
    }

    const row = {
        id: recordId(),
        characterId,
        characterName: cleanText(input.characterName, 80),
        sourceMode: input.sourceMode,
        summary: cleanText(input.summary, 1000),
        appCardLayout: input.appCardLayout,
        cardAppId: cleanText(input.cardAppId, 120) || undefined,
        cardAppName: cleanText(input.cardAppName, 80) || undefined,
        messageId: cleanText(input.messageId, 120) || undefined,
        sessionId: cleanText(input.sessionId, 120) || undefined,
        pinnedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    const existing = readCustomAppCollection(target.id, MOMENTS_PIN_COLLECTION);
    const next = [row, ...existing].slice(0, MAX_PINNED_PER_CHARACTER);
    writeCustomAppCollection(target.id, MOMENTS_PIN_COLLECTION, next);

    return { ok: true, targetAppId: target.id, targetAppName: target.name };
}
