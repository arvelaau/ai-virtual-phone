// lib/mixology/builtin.ts
// House Special — the factory materials: the default base spirit and glassware.
// These two are the "even a plain glass tastes good" floor: a player who installs no
// materials at all and brings only a character card can still start a session.
//
// ⚠️ The upstream comment here said to bump MIX_BUILTIN_VERSION when the copy changes,
// because storage would then refresh the official items from the factory content. That is
// no longer true and was verified before translating: listMixBuiltins() builds both
// materials FRESH on every call and never persists them, so edits take effect immediately
// with no version gate. MIX_BUILTIN_VERSION is exported with zero consumers, and
// storage.ts's BUILTIN_VERSION_KEY is declared and registered for kv migration but never
// read or written. Both are kept (the kv key still participates in backup/restore) but
// neither gates anything.
//
// This is the exact inverse of the BUILTIN_PRESET_VERSION trap documented in CLAUDE.md:
// there a bump was required and assumed unnecessary; here a comment claims one is required
// and it is not. Same lesson either way — trace the mechanism, do not trust the comment.

import type { MixTextMaterial } from "./types";

export const MIX_BUILTIN_VERSION = 2;

export const MIX_BUILTIN_BASE_ID = "mix_builtin_base";
export const MIX_BUILTIN_GLASS_ID = "mix_builtin_glass";

const now = () => Date.now();

/** Official base spirit: the overall roleplay charter */
export function createBuiltinBase(): MixTextMaterial {
    return {
        id: MIX_BUILTIN_BASE_ID,
        kind: "base",
        name: "Official · Standard Roleplay",
        hook: "The factory roleplay charter — steady, never breaks character",
        author: "House Special",
        content: [
            "You are to become {{char}} completely, living inside the story in the first person, in an immersive roleplay with {{user}}.",
            "- Always act with {{char}}'s identity, personality and manner of speech. Never step out of character, and never refer to yourself as an AI or an assistant.",
            "- Play only {{char}}, the narration and the supporting cast. Never speak, act or decide on {{user}}'s behalf.",
            "- Move the story along using the character info and what has already happened. Drive the plot forward rather than circling in place, and do not repeat what has already been said.",
            "- Details the character info leaves out may be filled in sensibly, but never in a way that contradicts what is already established.",
            "- Conflict, refusal and negative feeling are all allowed; the character is not a machine for pleasing people. Staying true to the persona matters more than pleasing {{user}}.",
        ].join("\n"),
        tags: ["Official"],
        createdAt: now(),
        updatedAt: now(),
    };
}

/** Official glassware: the output format (including how to write the prose protocol) */
export function createBuiltinGlass(): MixTextMaterial {
    return {
        id: MIX_BUILTIN_GLASS_ID,
        kind: "glass",
        name: "Official · Prose & Dialogue",
        hook: "The factory output format — flowing prose with clearly marked dialogue",
        author: "House Special",
        content: [
            "Write as novel prose in the third person, two to four paragraphs per turn, with a blank line between paragraphs.",
            "- Thread action, expression and setting detail through the narration so the scene can be pictured; do not write a bare list of events.",
            "- End each turn somewhere with a little resonance left, leaving {{user}} room to answer. Do not summarise {{user}}'s feelings for them.",
        ].join("\n"),
        tags: ["Official"],
        createdAt: now(),
        updatedAt: now(),
    };
}
