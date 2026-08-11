// Couple Space: a per-character relationship space holding anniversaries, a shared
// wishlist, and (read-only, via lib/gift-provenance.ts) the gift history.
//
// Anniversaries live here rather than in the calendar on purpose. `CalendarWeekPlan` is
// week-scoped -- items are pinned to a literal YYYY-MM-DD and there is no recurrence field
// anywhere in calendar-types.ts -- so an annual anniversary is inexpressible in that model.
// Couple Space owns the data; the calendar can only ever display a projected occurrence.

export type CoupleSpaceScope = "user" | "character";

export type Anniversary = {
    id: string;
    characterId: string;
    title: string;
    /** The original date, YYYY-MM-DD. For recurring entries this is the first occurrence. */
    date: string;
    /** Annual repeat. False means a one-off date that stops mattering once it passes. */
    recurring: boolean;
    note?: string;
    createdAt: string;
    updatedAt: string;
};

export type WishlistStatus = "wanted" | "fulfilled";

export type WishlistItem = {
    id: string;
    characterId: string;
    title: string;
    note?: string;
    /** Whose wish this is. */
    wantedBy: CoupleSpaceScope;
    status: WishlistStatus;
    priceLabel?: string;
    /** `GiftProvenanceRecord.id` once a gift fulfils this wish. */
    linkedGiftId?: string;
    createdAt: string;
    updatedAt: string;
    fulfilledAt?: string;
};

/**
 * Who wrote a reflection.
 *
 * `character` is deliberately part of the type from the start even though nothing
 * generates AI-authored reflections yet: the LLM decision for this feature was left open,
 * and carrying the field now means turning it on later is additive rather than a data
 * migration over everything already written.
 */
export type ReflectionAuthor = "user" | "character";

/**
 * A relationship reflection. Distinct from `DiaryEntry` (lib/diary-entry-types.ts) on
 * purpose: that one is AI-authored and produced unprompted by diary-entry-timer-service,
 * whereas these are written deliberately and scoped to one relationship. Sharing the type
 * would mean the timer service could start emitting reflections nobody asked for.
 */
export type ReflectionEntry = {
    id: string;
    characterId: string;
    author: ReflectionAuthor;
    title?: string;
    body: string;
    /** Optional link to whatever prompted the reflection. */
    relatedAnniversaryId?: string;
    relatedWishId?: string;
    /** A `GiftProvenanceRecord.id`. */
    relatedGiftId?: string;
    createdAt: string;
    updatedAt: string;
};

export type CoupleSpaceState = {
    version: 1;
    anniversaries: Anniversary[];
    wishlist: WishlistItem[];
    reflections: ReflectionEntry[];
};

export type UpcomingAnniversary = {
    anniversary: Anniversary;
    /** Next occurrence as YYYY-MM-DD. Equals `anniversary.date` for non-recurring entries. */
    nextDate: string;
    /** Whole days from today. 0 means today, negative means a passed one-off. */
    daysUntil: number;
    /** How many years this occurrence marks. 0 for the first, undefined when non-recurring. */
    yearsSince?: number;
};

export function createEmptyCoupleSpaceState(): CoupleSpaceState {
    return { version: 1, anniversaries: [], wishlist: [], reflections: [] };
}
