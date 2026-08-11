import { kvGet, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";
import {
    createEmptyCoupleSpaceState,
    type Anniversary,
    type CoupleSpaceScope,
    type CoupleSpaceState,
    type UpcomingAnniversary,
    type ReflectionAuthor,
    type ReflectionEntry,
    type WishlistItem,
} from "./couple-space-types";

const COUPLE_SPACE_PREFIX = "ai_phone_couple_space_";
export const COUPLE_SPACE_UPDATED_EVENT = "couple-space-updated";

registerDynamicPrefix(COUPLE_SPACE_PREFIX);

function storageKey(characterId: string): string {
    return `${COUPLE_SPACE_PREFIX}${characterId}`;
}

function cleanText(value: unknown, maxLength: number): string {
    return String(value ?? "")
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

/**
 * Whitespace cleaner for prose bodies. Unlike `cleanText` this keeps line breaks, because
 * a reflection is multi-paragraph writing and collapsing `\s+` would flatten it into one
 * run-on block. Runs of blank lines are capped at one, and trailing spaces per line go.
 */
function cleanMultiline(value: unknown, maxLength: number): string {
    return String(value ?? "")
        .replace(/\u0000/g, "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map(line => line.replace(/[ \t]+/g, " ").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, maxLength);
}

function createId(): string {
    return `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

// ── Date helpers ────────────────────────────────────────────────────────────────────────
// All arithmetic runs on UTC midnights built from the Y/M/D parts, never on a parsed local
// Date: `new Date("2026-03-01")` is UTC midnight but `new Date(2026, 2, 1)` is local, and
// mixing them shifts "days until" by one either side of the date line.

type Ymd = { year: number; month: number; day: number };

export function parseYmd(value: string): Ymd | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
}

export function formatYmd(part: Ymd): string {
    const month = String(part.month).padStart(2, "0");
    const day = String(part.day).padStart(2, "0");
    return `${part.year}-${month}-${day}`;
}

function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function utcMs(part: Ymd): number {
    return Date.UTC(part.year, part.month - 1, part.day);
}

function daysBetween(from: Ymd, to: Ymd): number {
    return Math.round((utcMs(to) - utcMs(from)) / 86400000);
}

/** Today as YYYY-MM-DD in the viewer's own timezone. */
export function todayYmd(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * Next occurrence of an anniversary relative to `today`.
 *
 * Recurring 29 February falls back to 28 February in common years -- the alternative
 * (1 March) moves the date into a different month, which reads wrong on a calendar.
 * Pure and exported so the rollover cases are testable without storage.
 */
export function computeUpcomingAnniversary(anniversary: Anniversary, today: string): UpcomingAnniversary | null {
    const origin = parseYmd(anniversary.date);
    const current = parseYmd(today);
    if (!origin || !current) return null;

    if (!anniversary.recurring) {
        return {
            anniversary,
            nextDate: anniversary.date,
            daysUntil: daysBetween(current, origin),
        };
    }

    const occurrenceFor = (year: number): Ymd => {
        if (origin.month === 2 && origin.day === 29 && !isLeapYear(year)) {
            return { year, month: 2, day: 28 };
        }
        return { year, month: origin.month, day: origin.day };
    };

    let occurrence = occurrenceFor(current.year);
    if (daysBetween(current, occurrence) < 0) {
        occurrence = occurrenceFor(current.year + 1);
    }

    return {
        anniversary,
        nextDate: formatYmd(occurrence),
        daysUntil: daysBetween(current, occurrence),
        yearsSince: occurrence.year - origin.year,
    };
}

export type UpcomingOptions = {
    /** Only entries falling within this many days. Omit for all. */
    withinDays?: number;
    /** Drop one-off anniversaries whose date has passed. Defaults to true. */
    hidePassedOneOffs?: boolean;
    today?: string;
    limit?: number;
};

export function computeUpcomingAnniversaries(
    anniversaries: Anniversary[],
    options: UpcomingOptions = {},
): UpcomingAnniversary[] {
    const today = options.today ?? todayYmd();
    const hidePassed = options.hidePassedOneOffs !== false;

    const upcoming = anniversaries
        .map(entry => computeUpcomingAnniversary(entry, today))
        .filter((entry): entry is UpcomingAnniversary => entry !== null)
        .filter(entry => !(hidePassed && entry.daysUntil < 0))
        .filter(entry => typeof options.withinDays !== "number" || entry.daysUntil <= options.withinDays)
        .sort((a, b) => a.daysUntil - b.daysUntil || a.anniversary.title.localeCompare(b.anniversary.title));

    return typeof options.limit === "number" ? upcoming.slice(0, Math.max(0, options.limit)) : upcoming;
}

// ── State ───────────────────────────────────────────────────────────────────────────────

function normalizeAnniversary(value: unknown, characterId: string): Anniversary | null {
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<Anniversary>;
    const title = cleanText(entry.title, 120);
    if (!entry.id || !title || !parseYmd(String(entry.date ?? ""))) return null;
    return {
        id: String(entry.id),
        characterId,
        title,
        date: String(entry.date),
        recurring: entry.recurring !== false,
        note: cleanText(entry.note, 500) || undefined,
        createdAt: String(entry.createdAt ?? nowIso()),
        updatedAt: String(entry.updatedAt ?? entry.createdAt ?? nowIso()),
    };
}

function normalizeWishlistItem(value: unknown, characterId: string): WishlistItem | null {
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<WishlistItem>;
    const title = cleanText(entry.title, 160);
    if (!entry.id || !title) return null;
    return {
        id: String(entry.id),
        characterId,
        title,
        note: cleanText(entry.note, 500) || undefined,
        wantedBy: entry.wantedBy === "character" ? "character" : "user",
        status: entry.status === "fulfilled" ? "fulfilled" : "wanted",
        priceLabel: cleanText(entry.priceLabel, 80) || undefined,
        linkedGiftId: cleanText(entry.linkedGiftId, 200) || undefined,
        createdAt: String(entry.createdAt ?? nowIso()),
        updatedAt: String(entry.updatedAt ?? entry.createdAt ?? nowIso()),
        fulfilledAt: entry.fulfilledAt ? String(entry.fulfilledAt) : undefined,
    };
}

function normalizeReflection(value: unknown, characterId: string): ReflectionEntry | null {
    if (!value || typeof value !== "object") return null;
    const entry = value as Partial<ReflectionEntry>;
    const body = cleanMultiline(entry.body, 4000);
    if (!entry.id || !body) return null;
    return {
        id: String(entry.id),
        characterId,
        author: entry.author === "character" ? "character" : "user",
        title: cleanText(entry.title, 120) || undefined,
        body,
        relatedAnniversaryId: cleanText(entry.relatedAnniversaryId, 120) || undefined,
        relatedWishId: cleanText(entry.relatedWishId, 120) || undefined,
        relatedGiftId: cleanText(entry.relatedGiftId, 200) || undefined,
        createdAt: String(entry.createdAt ?? nowIso()),
        updatedAt: String(entry.updatedAt ?? entry.createdAt ?? nowIso()),
    };
}

export function loadCoupleSpaceState(characterId: string): CoupleSpaceState {
    if (!characterId || typeof window === "undefined") return createEmptyCoupleSpaceState();
    try {
        const raw = kvGet(storageKey(characterId));
        if (!raw) return createEmptyCoupleSpaceState();
        const parsed = JSON.parse(raw) as Partial<CoupleSpaceState>;
        return {
            version: 1,
            anniversaries: Array.isArray(parsed.anniversaries)
                ? parsed.anniversaries
                    .map(entry => normalizeAnniversary(entry, characterId))
                    .filter((entry): entry is Anniversary => entry !== null)
                : [],
            wishlist: Array.isArray(parsed.wishlist)
                ? parsed.wishlist
                    .map(entry => normalizeWishlistItem(entry, characterId))
                    .filter((entry): entry is WishlistItem => entry !== null)
                : [],
            // Absent in states saved before stage 3 -- default rather than reject.
            reflections: Array.isArray(parsed.reflections)
                ? parsed.reflections
                    .map(entry => normalizeReflection(entry, characterId))
                    .filter((entry): entry is ReflectionEntry => entry !== null)
                : [],
        };
    } catch {
        return createEmptyCoupleSpaceState();
    }
}

export function saveCoupleSpaceState(characterId: string, state: CoupleSpaceState): void {
    if (!characterId || typeof window === "undefined") return;
    // Spread first so the version literal actually wins, rather than being overwritten by
    // whatever `state` happens to carry.
    kvSet(storageKey(characterId), JSON.stringify({ ...state, version: 1 }));
    try {
        window.dispatchEvent(new CustomEvent(COUPLE_SPACE_UPDATED_EVENT, { detail: { characterId } }));
    } catch {
        // A missing CustomEvent (non-browser host) must not break the write above.
    }
}

export function clearCoupleSpace(characterId: string): void {
    if (!characterId || typeof window === "undefined") return;
    kvRemove(storageKey(characterId));
}

// ── Anniversaries ───────────────────────────────────────────────────────────────────────

export type AnniversaryInput = {
    title: string;
    date: string;
    recurring?: boolean;
    note?: string;
};

export function addAnniversary(characterId: string, input: AnniversaryInput): Anniversary | null {
    const title = cleanText(input.title, 120);
    if (!title || !parseYmd(input.date)) return null;
    const timestamp = nowIso();
    const anniversary: Anniversary = {
        id: createId(),
        characterId,
        title,
        date: input.date,
        recurring: input.recurring !== false,
        note: cleanText(input.note, 500) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const state = loadCoupleSpaceState(characterId);
    state.anniversaries = [...state.anniversaries, anniversary];
    saveCoupleSpaceState(characterId, state);
    return anniversary;
}

export function updateAnniversary(
    characterId: string,
    id: string,
    patch: Partial<AnniversaryInput>,
): Anniversary | null {
    const state = loadCoupleSpaceState(characterId);
    const existing = state.anniversaries.find(entry => entry.id === id);
    if (!existing) return null;
    if (patch.date !== undefined && !parseYmd(patch.date)) return null;
    const nextTitle = patch.title !== undefined ? cleanText(patch.title, 120) : existing.title;
    if (!nextTitle) return null;

    const updated: Anniversary = {
        ...existing,
        title: nextTitle,
        date: patch.date ?? existing.date,
        recurring: patch.recurring ?? existing.recurring,
        note: patch.note !== undefined ? (cleanText(patch.note, 500) || undefined) : existing.note,
        updatedAt: nowIso(),
    };
    state.anniversaries = state.anniversaries.map(entry => (entry.id === id ? updated : entry));
    saveCoupleSpaceState(characterId, state);
    return updated;
}

export function deleteAnniversary(characterId: string, id: string): boolean {
    const state = loadCoupleSpaceState(characterId);
    const next = state.anniversaries.filter(entry => entry.id !== id);
    if (next.length === state.anniversaries.length) return false;
    state.anniversaries = next;
    saveCoupleSpaceState(characterId, state);
    return true;
}

export function loadUpcomingAnniversaries(
    characterId: string,
    options: UpcomingOptions = {},
): UpcomingAnniversary[] {
    return computeUpcomingAnniversaries(loadCoupleSpaceState(characterId).anniversaries, options);
}

// ── Wishlist ────────────────────────────────────────────────────────────────────────────

export type WishlistInput = {
    title: string;
    note?: string;
    wantedBy?: CoupleSpaceScope;
    priceLabel?: string;
};

export function addWishlistItem(characterId: string, input: WishlistInput): WishlistItem | null {
    const title = cleanText(input.title, 160);
    if (!title) return null;
    const timestamp = nowIso();
    const item: WishlistItem = {
        id: createId(),
        characterId,
        title,
        note: cleanText(input.note, 500) || undefined,
        wantedBy: input.wantedBy === "character" ? "character" : "user",
        status: "wanted",
        priceLabel: cleanText(input.priceLabel, 80) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const state = loadCoupleSpaceState(characterId);
    state.wishlist = [...state.wishlist, item];
    saveCoupleSpaceState(characterId, state);
    return item;
}

export function updateWishlistItem(
    characterId: string,
    id: string,
    patch: Partial<WishlistInput>,
): WishlistItem | null {
    const state = loadCoupleSpaceState(characterId);
    const existing = state.wishlist.find(entry => entry.id === id);
    if (!existing) return null;
    const nextTitle = patch.title !== undefined ? cleanText(patch.title, 160) : existing.title;
    if (!nextTitle) return null;

    const updated: WishlistItem = {
        ...existing,
        title: nextTitle,
        note: patch.note !== undefined ? (cleanText(patch.note, 500) || undefined) : existing.note,
        wantedBy: patch.wantedBy ?? existing.wantedBy,
        priceLabel: patch.priceLabel !== undefined
            ? (cleanText(patch.priceLabel, 80) || undefined)
            : existing.priceLabel,
        updatedAt: nowIso(),
    };
    state.wishlist = state.wishlist.map(entry => (entry.id === id ? updated : entry));
    saveCoupleSpaceState(characterId, state);
    return updated;
}

/** Mark a wish fulfilled, optionally pointing at the gift-provenance record that did it. */
export function fulfillWishlistItem(
    characterId: string,
    id: string,
    linkedGiftId?: string,
): WishlistItem | null {
    const state = loadCoupleSpaceState(characterId);
    const existing = state.wishlist.find(entry => entry.id === id);
    if (!existing) return null;
    const timestamp = nowIso();
    const updated: WishlistItem = {
        ...existing,
        status: "fulfilled",
        linkedGiftId: cleanText(linkedGiftId, 200) || existing.linkedGiftId,
        fulfilledAt: timestamp,
        updatedAt: timestamp,
    };
    state.wishlist = state.wishlist.map(entry => (entry.id === id ? updated : entry));
    saveCoupleSpaceState(characterId, state);
    return updated;
}

export function deleteWishlistItem(characterId: string, id: string): boolean {
    const state = loadCoupleSpaceState(characterId);
    const next = state.wishlist.filter(entry => entry.id !== id);
    if (next.length === state.wishlist.length) return false;
    state.wishlist = next;
    saveCoupleSpaceState(characterId, state);
    return true;
}

export function loadWishlist(
    characterId: string,
    options: { status?: WishlistItem["status"]; wantedBy?: CoupleSpaceScope } = {},
): WishlistItem[] {
    let items = loadCoupleSpaceState(characterId).wishlist;
    if (options.status) items = items.filter(entry => entry.status === options.status);
    if (options.wantedBy) items = items.filter(entry => entry.wantedBy === options.wantedBy);
    return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Reflections ─────────────────────────────────────────────────────────────────────────

export type ReflectionInput = {
    body: string;
    title?: string;
    author?: ReflectionAuthor;
    relatedAnniversaryId?: string;
    relatedWishId?: string;
    relatedGiftId?: string;
};

export function addReflection(characterId: string, input: ReflectionInput): ReflectionEntry | null {
    const body = cleanMultiline(input.body, 4000);
    if (!characterId || !body) return null;
    const timestamp = nowIso();
    const reflection: ReflectionEntry = {
        id: createId(),
        characterId,
        author: input.author === "character" ? "character" : "user",
        title: cleanText(input.title, 120) || undefined,
        body,
        relatedAnniversaryId: cleanText(input.relatedAnniversaryId, 120) || undefined,
        relatedWishId: cleanText(input.relatedWishId, 120) || undefined,
        relatedGiftId: cleanText(input.relatedGiftId, 200) || undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const state = loadCoupleSpaceState(characterId);
    state.reflections = [...state.reflections, reflection];
    saveCoupleSpaceState(characterId, state);
    return reflection;
}

export function updateReflection(
    characterId: string,
    id: string,
    patch: Partial<ReflectionInput>,
): ReflectionEntry | null {
    const state = loadCoupleSpaceState(characterId);
    const existing = state.reflections.find(entry => entry.id === id);
    if (!existing) return null;
    const nextBody = patch.body !== undefined ? cleanMultiline(patch.body, 4000) : existing.body;
    if (!nextBody) return null;

    const updated: ReflectionEntry = {
        ...existing,
        body: nextBody,
        title: patch.title !== undefined ? (cleanText(patch.title, 120) || undefined) : existing.title,
        updatedAt: nowIso(),
    };
    state.reflections = state.reflections.map(entry => (entry.id === id ? updated : entry));
    saveCoupleSpaceState(characterId, state);
    return updated;
}

export function deleteReflection(characterId: string, id: string): boolean {
    const state = loadCoupleSpaceState(characterId);
    const next = state.reflections.filter(entry => entry.id !== id);
    if (next.length === state.reflections.length) return false;
    state.reflections = next;
    saveCoupleSpaceState(characterId, state);
    return true;
}

/** Reflections, newest first. */
export function loadReflections(
    characterId: string,
    options: { author?: ReflectionAuthor; limit?: number } = {},
): ReflectionEntry[] {
    let entries = loadCoupleSpaceState(characterId).reflections;
    if (options.author) entries = entries.filter(entry => entry.author === options.author);
    entries = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return typeof options.limit === "number" ? entries.slice(0, Math.max(0, options.limit)) : entries;
}
