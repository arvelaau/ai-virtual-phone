// lib/card-studio-storage.ts
// Storage for Studio -- a standalone home-screen app that lets the user author AI-triggerable
// directive cards (a boarding pass, a café menu) once, so they reach chat, story AND offline
// mode instead of needing a full custom-app manifest install per mode. See
// PROACTIVE-MESSAGE-2.0-PLAN.md's HTML-trigger-cards plan for the design decision behind this:
// a Studio card is deliberately NEVER written into the shared installed-apps store
// (`ai_phone_custom_apps_v1`, lib/custom-app-storage.ts) -- at least 6 other UI surfaces
// (App Market's Uninstall/Update list, desktop icons, the icon-skin picker, Binding Manager,
// Preset/Regex Manager, Toolbox Settings) enumerate that store unfiltered, so a synthetic entry
// there would show up, wrongly, in all of them. Instead Studio cards live in their own storage
// and are merged into the directive list at READ time only, by
// lib/custom-app-chat-directives.ts's loadCustomAppChatDirectives().

import { kvGet, kvSet } from "./kv-db";
import type { CustomAppCardScopeMode } from "./custom-app-types";

const VALID_SCOPE_MODES: readonly CustomAppCardScopeMode[] = ["chat", "story", "offline"];

const STORAGE_KEY = "ai_phone_card_studio_v1";

/** The fixed stub "app" identity Studio cards register their directive under. */
export const STUDIO_APP_ID = "studio";
export const STUDIO_APP_NAME = "Studio";

export const CARD_STUDIO_UPDATED_EVENT = "card-studio-updated";

export type StudioCard = {
    id: string;
    /** Becomes the directive's label (the taught "### <name>" heading) -- keep it short. */
    name: string;
    /** e.g. "[BoardingPass]" -- what the AI must write to trigger this card. */
    syntax: string;
    /** The instruction taught to the AI verbatim: when/why to use this card. */
    description: string;
    /** Raw HTML rendered inside the sandboxed card iframe. */
    html: string;
    tone?: string;
    accentColor?: string;
    /** Card iframe height in px. */
    height?: number;
    /** Which surfaces this card is allowed to trigger on -- undefined/empty = all three
     *  (unrestricted). Authored per-card here, not as a global app-wide setting. */
    scope?: CustomAppCardScopeMode[];
    createdAt: string;
    updatedAt: string;
};

export type StudioCardInput = {
    name: string;
    syntax?: string;
    description: string;
    html: string;
    tone?: string;
    accentColor?: string;
    height?: number;
    scope?: CustomAppCardScopeMode[];
};

/** Dedupes + drops unrecognized values. An empty/all-three result is stored as `undefined` --
 *  "unrestricted" is the canonical form, so a card saved with every box checked reads identically
 *  to one that never had a scope opinion at all. */
function normalizeScope(value: unknown): CustomAppCardScopeMode[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<CustomAppCardScopeMode>();
    for (const raw of value) {
        if (typeof raw === "string" && (VALID_SCOPE_MODES as readonly string[]).includes(raw)) {
            seen.add(raw as CustomAppCardScopeMode);
        }
    }
    if (seen.size === 0 || seen.size === VALID_SCOPE_MODES.length) return undefined;
    return VALID_SCOPE_MODES.filter(mode => seen.has(mode));
}

function cleanText(value: unknown, maxLength: number): string {
    return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** HTML/CSS is whitespace-sensitive -- only strip NUL bytes and cap length, never collapse. */
function cleanHtml(value: unknown, maxLength: number): string {
    return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function createId(): string {
    return `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * The syntax fallback when the author leaves the trigger-tag field blank -- must match the
 * editor UI's own placeholder computation (studio-app.tsx), or a card saved with the field
 * empty would silently get a different tag than the one the editor showed as a hint.
 */
function defaultSyntaxFor(name: string): string {
    const token = name.replace(/[^A-Za-z0-9]/g, "");
    return `[${token || "Card"}]`;
}

function normalizeCard(value: unknown): StudioCard | null {
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<StudioCard>;
    const name = cleanText(entry.name, 60);
    const html = cleanHtml(entry.html, 20000);
    if (!entry.id || !name || !html) return null;
    return {
        id: String(entry.id),
        name,
        syntax: cleanText(entry.syntax, 160) || defaultSyntaxFor(name),
        description: cleanText(entry.description, 500),
        html,
        tone: cleanText(entry.tone, 40) || undefined,
        accentColor: cleanText(entry.accentColor, 40) || undefined,
        height: typeof entry.height === "number" && Number.isFinite(entry.height)
            ? Math.max(96, Math.min(520, Math.round(entry.height)))
            : undefined,
        scope: normalizeScope(entry.scope),
        createdAt: String(entry.createdAt ?? nowIso()),
        updatedAt: String(entry.updatedAt ?? entry.createdAt ?? nowIso()),
    };
}

export function loadStudioCards(): StudioCard[] {
    try {
        const raw = kvGet(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeCard).filter((entry): entry is StudioCard => entry !== null);
    } catch {
        return [];
    }
}

function persist(cards: StudioCard[]): void {
    kvSet(STORAGE_KEY, JSON.stringify(cards));
    try {
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(CARD_STUDIO_UPDATED_EVENT));
        }
    } catch {
        // A missing CustomEvent (non-browser host) must not break the write above.
    }
}

/** Creates a new card, or updates an existing one when `id` is given. */
export function saveStudioCard(input: StudioCardInput, id?: string): StudioCard | null {
    const name = cleanText(input.name, 60);
    const html = cleanHtml(input.html, 20000);
    if (!name || !html) return null;
    const cards = loadStudioCards();
    const timestamp = nowIso();
    if (id) {
        const existing = cards.find(card => card.id === id);
        if (!existing) return null;
        const updated: StudioCard = {
            ...existing,
            name,
            syntax: cleanText(input.syntax, 160) || existing.syntax,
            description: cleanText(input.description, 500),
            html,
            tone: cleanText(input.tone, 40) || undefined,
            accentColor: cleanText(input.accentColor, 40) || undefined,
            height: typeof input.height === "number" && Number.isFinite(input.height)
                ? Math.max(96, Math.min(520, Math.round(input.height)))
                : existing.height,
            scope: normalizeScope(input.scope),
            updatedAt: timestamp,
        };
        persist(cards.map(card => (card.id === id ? updated : card)));
        return updated;
    }
    const created: StudioCard = {
        id: createId(),
        name,
        syntax: cleanText(input.syntax, 160) || defaultSyntaxFor(name),
        description: cleanText(input.description, 500),
        html,
        tone: cleanText(input.tone, 40) || undefined,
        accentColor: cleanText(input.accentColor, 40) || undefined,
        height: typeof input.height === "number" && Number.isFinite(input.height)
            ? Math.max(96, Math.min(520, Math.round(input.height)))
            : undefined,
        scope: normalizeScope(input.scope),
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    persist([...cards, created]);
    return created;
}

export function deleteStudioCard(id: string): boolean {
    const cards = loadStudioCards();
    const next = cards.filter(card => card.id !== id);
    if (next.length === cards.length) return false;
    persist(next);
    return true;
}
