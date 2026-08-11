import { loadGiftProvenance, markGiftResold, type GiftProvenanceRecord } from "./gift-provenance";
import { recordGiftResoldEvent } from "./couple-space-memory";
import { creditWalletBalance } from "./wallet-storage";

// Reselling a gift.
//
// Scope is deliberately narrow: only gifts the CHARACTER gave the user can be resold.
// A gift the user sent is no longer theirs to sell, and an ungifted shopping order is just
// stock -- neither carries the relationship weight this feature exists for.
//
// The point of routing it through provenance is that the record already knows who gave it
// and when, so the event the character later reads is specific ("the mug I gave you in
// May") rather than generic. Orchestration lives here rather than in gift-provenance.ts so
// that module stays a pure data layer with no wallet or memory dependency.

/** Secondhand rate applied to the original price. Deliberately visible, not hidden. */
export const GIFT_RESALE_RATE = 0.5;

/** Pull a number out of a price label like "$24.00", "USD 24", "24.00 USD". */
export function parsePriceLabel(priceLabel: string | undefined): number | null {
    if (!priceLabel) return null;
    const match = /(\d+(?:[.,]\d+)?)/.exec(String(priceLabel).replace(/,(?=\d{3}\b)/g, ""));
    if (!match) return null;
    const value = Number(match[1].replace(",", "."));
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function estimateResaleValue(priceLabel: string | undefined): number | null {
    const original = parsePriceLabel(priceLabel);
    if (original === null) return null;
    return Math.round(original * GIFT_RESALE_RATE * 100) / 100;
}

export type GiftResellResult = {
    ok: boolean;
    error?: string;
    record?: GiftProvenanceRecord;
    amount?: number;
};

export function canResellGift(record: GiftProvenanceRecord | null | undefined): boolean {
    if (!record) return false;
    if (record.direction !== "character_to_user") return false;
    if (record.resoldAt) return false;
    return true;
}

/**
 * Resell a gift the character gave the user: mark the provenance record, credit the
 * wallet, and write the event the character will read.
 *
 * `amount` overrides the estimate when the caller wants an explicit figure.
 */
export function resellGift(input: {
    characterId: string;
    giftId: string;
    characterName: string;
    amount?: number;
}): GiftResellResult {
    if (typeof window === "undefined") return { ok: false, error: "unavailable" };

    const record = loadGiftProvenance(input.giftId);
    if (!record) return { ok: false, error: "That gift is not in the history." };
    if (record.direction !== "character_to_user") {
        return { ok: false, error: "Only a gift you were given can be resold." };
    }
    if (record.resoldAt) return { ok: false, error: "That gift has already been resold." };

    const amount = typeof input.amount === "number"
        ? Math.round(Math.max(0, input.amount) * 100) / 100
        : estimateResaleValue(record.priceLabel);
    if (amount === null || amount <= 0) {
        return { ok: false, error: "No resale value could be worked out for that gift." };
    }

    const updated = markGiftResold(input.giftId, amount);
    if (!updated) return { ok: false, error: "Could not update the gift record." };

    // Wallet failure must not leave the record marked-but-unpaid, so it is checked and the
    // caller is told; the record stays marked because the gift is gone either way.
    const credit = creditWalletBalance(
        amount,
        `Resold: ${record.productName || "a gift"}`,
        `Resold a gift from ${input.characterName || "them"}`,
        "Resale",
    );

    recordGiftResoldEvent({
        characterId: input.characterId,
        characterName: input.characterName,
        record: updated,
        amount,
    });

    return {
        ok: true,
        record: updated,
        amount,
        error: credit.ok ? undefined : credit.error,
    };
}
