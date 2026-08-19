// lib/mixology/hall-parts.ts
// House Special -- server-side validation of a blend's slot references.
//
// What a shared blend actually carries is references, their order, and their conditions; the
// materials themselves are separate entries on the materials page.
// The input here is written by somebody else AND is handed verbatim to every downloader, so
// every field is rebuilt against a whitelist rather than passed through: anything the wrong
// shape, too long, or out of range is dropped.
// It is a separate module so it can be unit-tested away from the route -- a mistake in here
// does not raise an error, it just quietly deforms everybody's blends.

/** How many materials one slot may stack (matches MIX_SLOT_MAX on the app side) */
export const MAX_PARTS_PER_KIND = 3;
/** Slots that hold exactly one: stacking them means nothing, so treat it as invalid rather
 *  than leaving a downloader puzzled */
export const SINGLE_PART_KINDS: readonly string[] = ["character", "persona"];
/** Ceiling on the whole reference array: one per single-item slot, three per stacking slot */
export const MAX_RECIPE_PARTS = 30;

const COMPARE_OPS: readonly string[] = [">", ">=", "<", "<=", "=", "!="];

export type PartCondition =
    | { type: "turn"; after: number }
    | { type: "var"; name: string; op: string; value: string }
    | { type: "keyword"; words: string[]; within?: number }
    | { type: "chance"; percent: number };

export type RecipePartRef = {
    id: string;
    kind: string;
    name: string;
    builtin?: boolean;
    when?: PartCondition;
};

function cleanText(value: unknown, maxLength: number): string {
    return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

/**
 * Conditions, rebuilt against a whitelist. Anything invalid returns undefined -- better that
 * this material becomes "always applies" than that a structure of unknown provenance reaches
 * somebody else's blend.
 */
export function normalizePartCondition(value: unknown): PartCondition | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const type = cleanText(record.type, 12);
    if (type === "turn") {
        const after = Math.floor(Number(record.after));
        if (!Number.isFinite(after) || after < 0 || after > 9999) return undefined;
        return { type: "turn", after };
    }
    if (type === "var") {
        const name = cleanText(record.name, 40);
        const op = cleanText(record.op, 2);
        const varValue = cleanText(record.value, 80);
        if (!name || !varValue || !COMPARE_OPS.includes(op)) return undefined;
        return { type: "var", name, op, value: varValue };
    }
    if (type === "keyword") {
        if (!Array.isArray(record.words)) return undefined;
        const words = record.words.map((word) => cleanText(word, 40)).filter(Boolean).slice(0, 12);
        if (!words.length) return undefined;
        const within = Math.floor(Number(record.within));
        const scope = Number.isFinite(within) && within > 1 ? Math.min(within, 50) : undefined;
        return scope ? { type: "keyword", words, within: scope } : { type: "keyword", words };
    }
    if (type === "chance") {
        const percent = Math.floor(Number(record.percent));
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
        return { type: "chance", percent };
    }
    return undefined;
}

/**
 * A mechanism is the only material that, once downloaded, RUNS EVERY TURN ON SOMEBODY ELSE'S
 * DEVICE AND CAN REWRITE THE CONVERSATION. So on top of the general payload ceiling it gets
 * its own: the code cannot be arbitrarily long, and the panel placement has to be something
 * recognisable. Keeping it tight also makes it harder to smuggle a large obfuscated blob
 * through.
 */
const MAX_MECHANISM_SCRIPT = 40_000;
const MAX_MECHANISM_PANEL = 200_000;
const MECHANISM_DOCKS: readonly string[] = ["left", "right", "bottom", "float"];

/**
 * Panel placement: shape only, no clamping. Out-of-range numbers are the downloader's
 * `normalizeMixPanelLayout` to clamp -- this module deliberately imports nothing app-side so it
 * stays unit-testable away from the runtime.
 */
function isPanelLayout(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    for (const key of ["x", "y", "w", "h"]) {
        if (!Number.isFinite(Number(record[key]))) return false;
    }
    if (record.chrome !== undefined && record.chrome !== "bar" && record.chrome !== "none") return false;
    if (record.z !== undefined && !Number.isFinite(Number(record.z))) return false;
    return true;
}

export function validateMechanismPayload(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return "missing_payload";
    const record = payload as Record<string, unknown>;
    const script = typeof record.script === "string" ? record.script : "";
    const panel = typeof record.panelHtml === "string" ? record.panelHtml : "";
    if (script.length > MAX_MECHANISM_SCRIPT) return "The mechanism's logic code is too long.";
    if (panel.length > MAX_MECHANISM_PANEL) return "The mechanism's panel code is too long.";
    if (!script.trim() && !panel.trim()) return "This mechanism is empty: it needs at least logic or a panel.";
    if (record.dock !== undefined && record.dock !== null && !MECHANISM_DOCKS.includes(String(record.dock))) {
        return "invalid_dock";
    }
    // Placement is pure data (percentage coordinates and a few switches), and the downloader
    // clamps it again on arrival; all this blocks is something that is not a placement at all.
    if (record.layout !== undefined && record.layout !== null && !isPanelLayout(record.layout)) {
        return "invalid_layout";
    }
    // A panel has to say where it is drawn: new materials write `layout`, old ones `dock`.
    // With neither there is nothing to place it by.
    if (panel.trim() && !record.dock && !record.layout) {
        return "A mechanism with a panel needs to say where it is drawn.";
    }
    return null;
}

/** Validate and clean a blend's slot references; returns an error when invalid */
export function normalizeRecipeParts(
    value: unknown,
    options: { materialKinds: readonly string[]; maxPayload: number },
): { parts: RecipePartRef[] } | { error: string } {
    if (!Array.isArray(value) || value.length === 0) return { error: "missing_parts" };
    if (value.length > MAX_RECIPE_PARTS) return { error: "too_many_parts" };
    const parts: RecipePartRef[] = [];
    // A slot can stack several, so this counts how many that slot has taken rather than just
    // whether it has appeared
    const kindCount = new Map<string, number>();
    for (const item of value) {
        if (!item || typeof item !== "object") return { error: "invalid_part" };
        const record = item as Record<string, unknown>;
        const id = cleanText(record.id, 160);
        const kind = cleanText(record.kind, 20);
        const name = cleanText(record.name, 80);
        const builtin = record.builtin === true;
        if (!id || !name || !options.materialKinds.includes(kind)) return { error: "invalid_part" };
        if (builtin && !id.startsWith("mix_builtin_")) return { error: "invalid_builtin_part" };
        const used = kindCount.get(kind) ?? 0;
        const limit = SINGLE_PART_KINDS.includes(kind) ? 1 : MAX_PARTS_PER_KIND;
        if (used >= limit) return { error: "too_many_parts_in_kind" };
        kindCount.set(kind, used + 1);
        // The character card and the mask take no condition. Everything else is rebuilt against
        // the whitelist, and anything invalid counts as having no condition.
        const when = SINGLE_PART_KINDS.includes(kind) ? undefined : normalizePartCondition(record.when);
        const base: RecipePartRef = builtin ? { id, kind, name, builtin: true } : { id, kind, name };
        parts.push(when ? { ...base, when } : base);
    }
    if (!kindCount.has("character")) return { error: "This blend has no character card, so it cannot be shared." };
    if (JSON.stringify(parts).length > options.maxPayload) return { error: "The blend's reference data is too large." };
    return { parts };
}
