// lib/mixology/mechanism-protocol.ts
// House Special — the data contract for mechanism hooks.
//
// A hook is deliberately shaped as a PURE FUNCTION CALL: the app hands a payload into the
// sandbox and the sandbox hands a processed one back. There is no two-way command channel,
// because the moment you open one, every capability it exposes has to be vetted
// individually and every one of them is a hole somebody can abuse. With a pure function
// there is exactly one thing to validate — what comes back.
//
// So this file holds only two things: the shape of the payload going in, and how to
// validate what comes out. Both are pure functions and can be unit-tested outside a
// browser — which matters, because a mistake in here does not raise an error, it just lets
// a mechanism quietly corrupt somebody else's session.

import type { MixState, MixStateValue } from "./types";

/** The four points on the pipeline where a hook can run. (A fifth, "on serve", belongs to
 *  the persistent panel and does not go through this channel.) */
export type MixHook = "sessionStart" | "beforeSend" | "afterReply" | "sessionEnd";

export const MIX_HOOK_LABELS: Record<MixHook, string> = {
    sessionStart: "Opening",
    beforeSend: "Before pour",
    afterReply: "After pour",
    sessionEnd: "Closing",
};

/** A mechanism's own storage bucket: one per mechanism per session, still there after
 *  leaving and coming back */
export type MixMechanismStore = Record<string, string>;

/** The payload handed into the sandbox */
export type MixHookPayload = {
    hook: MixHook;
    /** How many turns have happened */
    turnCount: number;
    /** The currently remembered values (a read-only snapshot) */
    state: MixState;
    /** This mechanism's own storage */
    store: MixMechanismStore;
    /** The character's name and the name the player stepped into */
    charName: string;
    userName: string;
    /** Before pour: the player's line. After pour: the model's prose. */
    text?: string;
    /** After pour: this turn's raw status-panel and skit text */
    ticketRaw?: string;
    encoreRaw?: string;
};

/** What the sandbox hands back */
export type MixHookResult = {
    /** Rewrite text (before pour, the player's line; after pour, the model's prose) */
    text?: string;
    /** Append a hint that applies to this turn only */
    note?: string;
    /** Remembered values to write onto the session */
    state?: MixState;
    /** Replace this mechanism's own storage */
    store?: MixMechanismStore;
};

/** Per-text ceiling: stops a mechanism pouring a wall of text into the prose and blowing
 *  out the context */
const MAX_TEXT = 20_000;
const MAX_NOTE = 2_000;
/** Storage bucket ceilings: key count and total bytes */
const MAX_STORE_KEYS = 100;
const MAX_STORE_BYTES = 100_000;
/** How many remembered values one call may write */
const MAX_STATE_KEYS = 50;
const MAX_STATE_VALUE = 200;

function cleanText(value: unknown, max: number): string {
    return String(value ?? "").replace(/\u0000/g, "").slice(0, max);
}

/** Remembered values accept only numbers and short text; anything else — objects, arrays,
 *  the remains of a function — is dropped */
function normalizeStateValue(value: unknown): MixStateValue | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
        const text = cleanText(value, MAX_STATE_VALUE).trim();
        return text || undefined;
    }
    return undefined;
}

export function normalizeMechanismStore(value: unknown): MixMechanismStore {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: MixMechanismStore = {};
    let bytes = 0;
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        if (Object.keys(out).length >= MAX_STORE_KEYS) break;
        const key = cleanText(rawKey, 80).trim();
        if (!key) continue;
        // Values are always stored as strings: a mechanism that wants structure can
        // JSON.stringify it itself, which saves guessing at types on the boundary
        const text = typeof rawValue === "string" ? cleanText(rawValue, MAX_STORE_BYTES) : cleanText(JSON.stringify(rawValue ?? null), MAX_STORE_BYTES);
        bytes += key.length + text.length;
        if (bytes > MAX_STORE_BYTES) break;
        out[key] = text;
    }
    return out;
}

/**
 * Validate what the sandbox handed back. Each field is picked out and rebuilt individually
 * and anything unrecognized is dropped; if the whole thing is invalid the result is an
 * empty object — a mechanism with a bug must never make the turn's generation fail.
 */
export function normalizeHookResult(value: unknown): MixHookResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const out: MixHookResult = {};

    if (typeof record.text === "string") out.text = cleanText(record.text, MAX_TEXT);
    if (typeof record.note === "string") {
        const note = cleanText(record.note, MAX_NOTE).trim();
        if (note) out.note = note;
    }
    if (record.state && typeof record.state === "object" && !Array.isArray(record.state)) {
        const state: MixState = {};
        for (const [rawKey, rawValue] of Object.entries(record.state as Record<string, unknown>)) {
            if (Object.keys(state).length >= MAX_STATE_KEYS) break;
            const key = cleanText(rawKey, 40).trim();
            if (!key) continue;
            const normalized = normalizeStateValue(rawValue);
            if (normalized !== undefined) state[key] = normalized;
        }
        if (Object.keys(state).length) out.state = state;
    }
    if (record.store !== undefined) out.store = normalizeMechanismStore(record.store);
    return out;
}

/** Merge one result into the existing state (a mechanism can only set the keys it declares;
 *  it cannot delete anybody else's) */
export function mergeHookState(current: MixState, patch: MixState | undefined): MixState {
    if (!patch || !Object.keys(patch).length) return current;
    return { ...current, ...patch };
}
