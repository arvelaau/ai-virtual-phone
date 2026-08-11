import { countGiftsExchanged, loadGiftHistory, type GiftProvenanceRecord } from "./gift-provenance";
import { loadCoupleSpaceState, computeUpcomingAnniversaries, todayYmd } from "./couple-space-storage";
import { formatAnniversaryDateLabel } from "./couple-space-memory";
import type { UpcomingAnniversary, WishlistItem } from "./couple-space-types";

// Standing-state half of the Couple Space memory wiring.
//
// The projection module covers what HAPPENED. This covers what IS TRUE RIGHT NOW -- the
// anniversary dates, the wishlist as it currently stands, the running gift tally -- which
// the model has to know on every turn, not only on the turn it changed.
//
// This module composes storage + gift-provenance so that `couple-space-storage.ts` can stay
// a leaf (see the cycle note in CLAUDE.md). It is passed INTO the assembler by the caller,
// exactly like `currentSchedule`, so `llm-prompt-assembler.ts` gains no new import.

const MAX_ANNIVERSARIES = 4;
const MAX_WISHES_PER_SIDE = 5;
const UPCOMING_WINDOW_DAYS = 400; // Effectively "the next occurrence", recurring or not.

export type CoupleSpacePromptData = {
    characterName: string;
    upcoming: UpcomingAnniversary[];
    wishlist: WishlistItem[];
    gifts: { given: number; received: number };
    latestGift?: GiftProvenanceRecord;
};

function describeDaysUntil(daysUntil: number): string {
    if (daysUntil === 0) return "today";
    if (daysUntil === 1) return "tomorrow";
    if (daysUntil < 0) return `${Math.abs(daysUntil)} days ago`;
    return `in ${daysUntil} days`;
}

function describeAnniversary(entry: UpcomingAnniversary): string {
    const when = formatAnniversaryDateLabel(entry.nextDate);
    const parts = [describeDaysUntil(entry.daysUntil)];
    if (typeof entry.yearsSince === "number" && entry.yearsSince > 0) {
        parts.push(`marking ${entry.yearsSince} ${entry.yearsSince === 1 ? "year" : "years"}`);
    }
    return `"${entry.anniversary.title}" on ${when} (${parts.join(", ")})`;
}

function describeWish(item: WishlistItem): string {
    return item.priceLabel ? `${item.title} (${item.priceLabel})` : item.title;
}

/**
 * Pure formatter. Split from the loader so the wording is testable without standing up
 * kv storage -- same seam as `formatMascotUserIdentityRule`.
 *
 * Returns "" when there is nothing worth saying, which lets the macro resolve to the TRIM
 * sentinel and drop the preset entry entirely.
 */
export function formatCoupleSpaceBlock(data: CoupleSpacePromptData): string {
    const name = data.characterName?.trim() || "them";
    const lines: string[] = [];

    const upcoming = data.upcoming.slice(0, MAX_ANNIVERSARIES);
    if (upcoming.length > 0) {
        lines.push(`Anniversaries: ${upcoming.map(describeAnniversary).join("; ")}.`);
    }

    const wanted = data.wishlist.filter(item => item.status === "wanted");
    const theirs = wanted.filter(item => item.wantedBy === "character").slice(0, MAX_WISHES_PER_SIDE);
    const mine = wanted.filter(item => item.wantedBy === "user").slice(0, MAX_WISHES_PER_SIDE);
    if (theirs.length > 0) {
        lines.push(`On ${name}'s wishlist: ${theirs.map(describeWish).join("; ")}.`);
    }
    if (mine.length > 0) {
        lines.push(`On the user's own wishlist: ${mine.map(describeWish).join("; ")}.`);
    }

    const { given, received } = data.gifts;
    if (given > 0 || received > 0) {
        const tally = `Gifts so far: ${given} given to ${name}, ${received} received from ${name}.`;
        const latest = data.latestGift
            ? ` Most recent: "${data.latestGift.productName}", ${
                data.latestGift.direction === "user_to_character" ? "given by the user" : `given by ${name}`
            }.`
            : "";
        lines.push(`${tally}${latest}`);
    }

    if (lines.length === 0) return "";
    return [`[Couple Space with ${name}]`, ...lines].join("\n");
}

/** Gather the current Couple Space state for one character and format it for the prompt. */
export function buildCoupleSpacePromptBlock(input: {
    characterId: string;
    characterName?: string;
    today?: string;
}): string {
    if (!input.characterId || typeof window === "undefined") return "";

    const state = loadCoupleSpaceState(input.characterId);
    const upcoming = computeUpcomingAnniversaries(state.anniversaries, {
        today: input.today ?? todayYmd(),
        withinDays: UPCOMING_WINDOW_DAYS,
    });
    const history = loadGiftHistory({ characterId: input.characterId, excludeGroup: true, limit: 1 });

    return formatCoupleSpaceBlock({
        characterName: input.characterName ?? "",
        upcoming,
        wishlist: state.wishlist,
        gifts: countGiftsExchanged(input.characterId),
        latestGift: history[0],
    });
}
