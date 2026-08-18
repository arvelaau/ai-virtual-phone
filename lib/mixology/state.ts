// lib/mixology/state.ts
// House Special — remembered values, and the conditions that gate a material.
//
// Two jobs:
// 1. Items on the receipt ticked "remember" are pulled out of the receipt's raw text each
//    turn and stored on the session. If one cannot be found, the previous turn's value
//    stands — better stale than jumping. A number suddenly dropping to zero wrecks the
//    player's sense of continuity far more than a turn where it failed to move.
// 2. Each material may carry one condition, tested just before assembly; a material whose
//    condition fails counts as absent for that turn. Conditions are pure data comparisons
//    with no expression evaluation, so sharing a material can never ship executable code.

import type {
    MixCompareOp,
    MixCondition,
    MixMaterial,
    MixMaterialKind,
    MixSession,
    MixSlotEntry,
    MixState,
    MixStateValue,
    MixTicketMaterial,
    MixTurn,
} from "./types";
import { MIX_SLOT_ORDER, MIX_SLOT_STACK, mixKindAllowsCondition } from "./types";

/**
 * A key followed by a colon or equals sign, running to the next separator.
 *
 * Only newlines and semicolons/pipes count as separators — commas deliberately do not,
 * because a value like "Location: the bar, corner stool" contains one, and treating it as a
 * separator would cut the value in half. The full-width variants are kept alongside the
 * ASCII ones: this parses text the MODEL wrote, and a model may reach for either.
 */
const VAR_SEPARATORS = "\\n\\r;；|｜";

function buildVarPattern(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[${VAR_SEPARATORS}])\\s*${escaped}\\s*[：:=]\\s*([^${VAR_SEPARATORS}]*)`, "i");
}

/** Pull one value out of the receipt's raw text; undefined if absent (the caller then keeps
 *  the previous turn's value) */
export function extractMixVar(raw: string, name: string): MixStateValue | undefined {
    if (!raw || !name.trim()) return undefined;
    const matched = buildVarPattern(name.trim()).exec(raw);
    if (!matched) return undefined;
    const text = (matched[1] ?? "").trim();
    if (!text) return undefined;
    // Store a pure number (sign and decimals allowed) as a number, so conditions can compare
    // magnitudes rather than text
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    return text;
}

/** Starting values: the receipt items that declared an initial */
export function initialMixState(ticket: MixTicketMaterial | undefined): MixState {
    const state: MixState = {};
    for (const item of ticket?.vars ?? []) {
        const name = item.name.trim();
        if (!name) continue;
        const initial = (item.initial ?? "").trim();
        if (!initial) continue;
        state[name] = /^[+-]?\d+(?:\.\d+)?$/.test(initial) ? Number(initial) : initial;
    }
    return state;
}

/** Update the remembered values from this turn's receipt text */
export function advanceMixState(
    prev: MixState | undefined,
    ticket: MixTicketMaterial | undefined,
    ticketRaw: string | undefined,
): MixState {
    const next: MixState = { ...(prev ?? {}) };
    const declared = ticket?.vars ?? [];
    if (!declared.length || !ticketRaw) return next;
    for (const item of declared) {
        const name = item.name.trim();
        if (!name) continue;
        const value = extractMixVar(ticketRaw, name);
        if (value !== undefined) next[name] = value;
    }
    return next;
}

/** After a rewind, regenerate or edit: fall back to the last remaining turn's snapshot */
export function rollbackMixState(turns: MixTurn[], fallback: MixState): MixState {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        const snapshot = turns[i].state;
        if (snapshot) return { ...snapshot };
    }
    return { ...fallback };
}

function compare(left: MixStateValue | undefined, op: MixCompareOp, right: string): boolean {
    if (left === undefined) return false;
    const rightNum = Number(right);
    const bothNumeric = typeof left === "number" && right.trim() !== "" && Number.isFinite(rightNum);
    if (bothNumeric) {
        switch (op) {
            case ">": return left > rightNum;
            case ">=": return left >= rightNum;
            case "<": return left < rightNum;
            case "<=": return left <= rightNum;
            case "=": return left === rightNum;
            case "!=": return left !== rightNum;
        }
    }
    // Non-numeric: only equality and inequality mean anything; ordering comparisons always fail
    const leftText = String(left).trim();
    const rightText = right.trim();
    if (op === "=") return leftText === rightText;
    if (op === "!=") return leftText !== rightText;
    return false;
}

/** What a condition can see when it is tested */
export type MixConditionContext = {
    /** How many turns have happened */
    turnCount: number;
    /** The currently remembered values */
    state: MixState;
    /** The prose of the last few turns (including the player's latest line); index 0 is the
     *  most recent */
    recentTexts: string[];
    /** Random source, injected so tests can be made reproducible */
    random?: () => number;
};

/** Whether a condition holds; no condition = always holds */
export function matchMixCondition(when: MixCondition | undefined, ctx: MixConditionContext): boolean {
    if (!when) return true;
    switch (when.type) {
        case "turn":
            return ctx.turnCount >= Math.max(0, Math.floor(when.after));
        case "var":
            return compare(ctx.state[when.name], when.op, when.value);
        case "keyword": {
            const words = when.words.map((w) => w.trim().toLowerCase()).filter(Boolean);
            if (!words.length) return false;
            const within = Math.max(1, Math.floor(when.within ?? 1));
            const haystack = ctx.recentTexts.slice(0, within).join("\n").toLowerCase();
            return words.some((word) => haystack.includes(word));
        }
        case "chance": {
            const percent = Math.max(0, Math.min(100, when.percent));
            if (percent <= 0) return false;
            if (percent >= 100) return true;
            return (ctx.random ?? Math.random)() * 100 < percent;
        }
        default:
            return true;
    }
}

/** How far back a keyword condition looks: in a long session, do not concatenate the whole
 *  transcript every turn */
const MIX_KEYWORD_MAX_LOOKBACK = 10;

/** Build the test context from a session (index 0 is the most recent turn) */
export function buildMixConditionContext(session: MixSession): MixConditionContext {
    return {
        turnCount: session.turns.length,
        state: session.state ?? {},
        recentTexts: session.turns.slice(-MIX_KEYWORD_MAX_LOOKBACK).reverse().map((t) => t.text),
    };
}

/**
 * Filter down to the materials that actually take part this turn.
 * A stacking slot keeps every material whose condition holds; a pick-one slot keeps only the
 * first. The character card and the mask take no conditions and pass straight through.
 */
export function pickActiveMixMaterials(
    entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>>,
    ctx: MixConditionContext,
): Partial<Record<MixMaterialKind, MixMaterial[]>> {
    const picked: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
    for (const kind of MIX_SLOT_ORDER) {
        const list = entries[kind];
        if (!list?.length) continue;
        const hit: MixMaterial[] = [];
        for (const { entry, material } of list) {
            if (mixKindAllowsCondition(kind) && !matchMixCondition(entry.when, ctx)) continue;
            hit.push(material);
            if (MIX_SLOT_STACK[kind] === "first") break;
        }
        if (hit.length) picked[kind] = hit;
    }
    return picked;
}

/** A plain-language description of a condition, shown directly in the interface */
export function describeMixCondition(when: MixCondition | undefined): string {
    if (!when) return "Always";
    switch (when.type) {
        case "turn":
            return `After turn ${Math.max(0, Math.floor(when.after))}`;
        case "var":
            return `When "${when.name}" ${when.op} ${when.value}`;
        case "keyword": {
            const words = when.words.filter((w) => w.trim());
            const within = Math.max(1, Math.floor(when.within ?? 1));
            const scope = within > 1 ? ` in the last ${within} turns` : "";
            return `When "${words.join(", ") || "…"}" comes up${scope}`;
        }
        case "chance":
            return `On a random ${Math.max(0, Math.min(100, when.percent))}% of turns`;
        default:
            return "Always";
    }
}
