// lib/mixology/assembler.ts
// House Special — the assembler: turns one blend (character card + slot materials) into a
// prompt.
//
// A slot may stack several materials: stacking slots (base / flavor / glassware / bitters)
// concatenate the stack in order, pick-one slots (mask / receipt / encore) use only the
// first. Conditional materials are filtered by the caller before they arrive here.
//
// The assembly order is fixed and the creator cannot change it, which is what makes any
// combination hold together:
//   preamble -> base -> character info -> world & plot -> flavor -> output requirements
//   -> status-panel contract -> sample dialogue -> [chat history] -> bitters (closest to
//   generation, so heaviest)
// The opening line is returned separately as the first assistant message and never enters
// the system prompt.
// Every material text supports the {{char}} / {{user}} macros; an empty field drops its
// whole section rather than leaving an empty heading.

import type {
    MixCharacterCard,
    MixEncoreMaterial,
    MixMaterial,
    MixMaterialKind,
    MixPersonaMaterial,
    MixState,
    MixTextMaterial,
    MixTicketMaterial,
} from "./types";
import { mixEncoreRenderHtml } from "./types";

export const MIX_DEFAULT_USER_NAME = "You";

// The wrapper is called "StatusPanel" rather than the app's cocktail word "receipt": the
// prompt is written for the model, which has no idea what a receipt is in this app but
// understands a status panel immediately.
//
// Note this is the same token the main chat protocol uses (BLOCK_TAG_STATUS_PANEL). That is
// deliberate rather than a collision — House Special has its own parser in prose.ts and its
// output never reaches parseAIResponse, and one consistent vocabulary across the app means
// a model that has learned one has learned the other.
export const MIX_TICKET_OPEN = "[StatusPanel]";
export const MIX_TICKET_CLOSE = "[/StatusPanel]";

/** Skit wrapper: when the encore has a contract, the AI's extra scene goes inside these */
export const MIX_ENCORE_OPEN = "[Skit]";
export const MIX_ENCORE_CLOSE = "[/Skit]";

export type MixAssembleInput = {
    character: MixCharacterCard;
    /**
     * The other slots' materials: each slot is a stack, already filtered by condition and
     * ordered by the caller.
     * Stacking slots (base / flavor / glassware / bitters) concatenate the whole stack;
     * pick-one slots look only at the first.
     */
    materials: Partial<Record<MixMaterialKind, MixMaterial[]>>;
    /** The user's name; empty uses the default */
    userName?: string;
    /** Which opening was chosen; out of range falls back to 0 */
    openingIndex?: number;
    /** The currently remembered values, for the {{state.X}} macro to read */
    state?: MixState;
};

export type MixAssembledPrompt = {
    /** The system prompt (everything before the chat history) */
    system: string;
    /** Bitters: injected after the history and before this turn's generation; empty string
     *  when there is no bitters material */
    postHistory: string;
    /** The opening line with macros already applied, used as the first assistant message;
     *  empty string when the card has no opening */
    opening: string;
    /** Whether this session has a receipt (the runtime uses this to decide whether to strip
     *  the status-panel block) */
    hasTicket: boolean;
    /** Whether this session's encore is an AI skit (it has both a contract and render code) */
    hasEncore: boolean;
};

function escapeForHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Substitute {{char}} / {{user}} / {{state.X}}.
 *
 * escapeHtml: turn on when the result is going to be inserted into HTML, which is what the
 * opening canvas does. It escapes only the values being substituted in, never the tags the
 * author wrote themselves. The user types their own name, but a name like "<b>" can still
 * wreck the canvas's structure, so anything going into HTML is escaped.
 */
export function applyMixMacros(
    text: string,
    charName: string,
    userName: string,
    state?: MixState,
    options?: { escapeHtml?: boolean },
): string {
    const esc = options?.escapeHtml ? escapeForHtml : (v: string) => v;
    const replaced = text
        .replace(/\{\{\s*char\s*\}\}/gi, esc(charName))
        .replace(/\{\{\s*user\s*\}\}/gi, esc(userName));
    // {{state.affection}} reads a value the receipt ticked "remember". A name with no value
    // collapses the whole macro to nothing rather than leaving a visible placeholder.
    //
    // The legacy Chinese spelling 状态 is still accepted, and deliberately so: materials are
    // shared through the hall, so a blend authored in Chinese can arrive here at any time
    // and its {{状态.X}} macros have to keep resolving. The full-width dots are upstream's
    // own tolerance for how the name gets typed.
    return replaced.replace(/\{\{\s*(?:state|状态)\s*[.．。]\s*([^}]+?)\s*\}\}/gi, (_all, name: string) => {
        const value = state?.[String(name).trim()];
        return value === undefined ? "" : esc(String(value));
    });
}

/**
 * The body of one slot, as a single section.
 * With ONE material stacked, its text follows the # section heading directly -- that heading is
 * already the slot's name on screen. With several, each gets a ## of its own titled with the
 * material's name, which is how the stack is labelled at the bar anyway.
 */
function stackBody(materials: MixMaterial[] | undefined, apply: (text: string) => string): string {
    const items = (materials ?? [])
        .map((m) => ({
            name: m.name?.trim() ?? "",
            text: typeof (m as MixTextMaterial).content === "string" ? (m as MixTextMaterial).content.trim() : "",
        }))
        .filter((item) => item.text);
    if (!items.length) return "";
    if (items.length === 1) return apply(items[0].text);
    return items.map((item, i) => `## ${apply(item.name || `Item ${i + 1}`)}\n${apply(item.text)}`).join("\n\n");
}

/**
 * One input box = one level-two heading. The heading is the very label shown on that box in
 * the editor, so what an author sees while writing matches what the model receives.
 * An empty box drops the whole block rather than leaving a bare heading.
 */
function field(label: string, value: string | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return `## ${label}\n${trimmed}`;
}

function sectionBlock(title: string, lines: (string | null)[]): string | null {
    const kept = lines.filter((l): l is string => Boolean(l));
    if (!kept.length) return null;
    return `# ${title}\n${kept.join("\n\n")}`;
}

/**
 * The preamble. Its FIRST sentence says who you are playing -- the single most important thing
 * in the whole prompt, and far safer at the very top than buried in any one field.
 */
function preamble(charName: string): string {
    return [
        `This is an immersive roleplay. The character you are playing is ${charName}.`,
        " Below are the roleplay rules, the character information and the output requirements, in that order; follow all of them. The later a requirement appears, the higher its priority.",
        "\n(# marks a section and ## an entry within it; anything deeper comes from the creator's own structure.)",
    ].join("");
}

// The prose marker protocol is the app's own rendering protocol: built in and always
// present. It goes at the head of this section with the user's glassware content after it,
// and it does NOT disappear when materials are missing, because both the garnish CSS and
// the prose renderer depend on these four markers.
const PROSE_PROTOCOL = [
    "## Prose marker rules (built in)",
    "The interface renders by these, so follow them exactly:",
    "- Wrap anything spoken aloud in 「」. Wrap unspoken inner voice in * *.",
    "- When the scene or the time changes, mark it on its own line with 【】.",
    "- A word that needs stressing may be wrapped in ~ ~.",
    "- Use no rich-text markup beyond those four. No Markdown headings, no bold, no lists.",
].join("\n");

/** The status-panel contract: wraps the receipt material's contract in the fixed shell
 *  instruction */
function ticketSection(ticket: MixTicketMaterial, charName: string, userName: string, state?: MixState): string | null {
    const contract = ticket.contract.trim();
    if (!contract) return null;
    return [
        "# Status panel",
        `Output format: at the very start of every reply, put ${MIX_TICKET_OPEN} on the first line, then fill in this turn's actual data line by line as "Output contract" requires, close it with ${MIX_TICKET_CLOSE} alone on its own line, then leave a blank line before the prose. Never omit this section on any turn.`,
        "Output contents:",
        applyMixMacros(contract, charName, userName, state),
    ].join("\n");
}

/** The skit contract: the format note first, the content requirements after. With no
 *  contract the whole section does not exist. */
function encoreSection(encore: MixEncoreMaterial, charName: string, userName: string, state?: MixState): string | null {
    const contract = encore.contract?.trim();
    if (!contract) return null;
    return [
        "# Skit",
        `Output format: place it at the very end of the reply, after the prose, with the whole block wrapped in ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE}. Whether to output it at all is decided by the conditions in "Output contract"; when it does not apply, omit the section entirely rather than emitting an empty shell.`,
        "Output contents:",
        applyMixMacros(contract, charName, userName, state),
    ].join("\n");
}

/** The closing checklist, placed last to hold the line: it stops the model finishing the
 *  prose and forgetting a block it was required to emit. */
function checklistSection(withTicket: boolean, withEncore: boolean): string | null {
    if (!withTicket && !withEncore) return null;
    const items = ["- The prose follows \"Output requirements\"."];
    if (withTicket) {
        items.push(`- The reply opens with a ${MIX_TICKET_OPEN}...${MIX_TICKET_CLOSE} block in the format given under "Status panel" — this can never be missing on any turn.`);
    }
    if (withEncore) {
        items.push(`- If this turn meets the conditions under "Skit", it has been emitted as a ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} block.`);
    }
    return ["# Output format check", "Go through these before sending each reply:", ...items].join("\n");
}

function exampleSection(card: MixCharacterCard, charName: string, userName: string): string | null {
    const examples = card.examples?.filter((e) => e.text.trim());
    if (!examples?.length) return null;
    const lines = examples.map((e) =>
        `${e.role === "user" ? userName : charName}: ${applyMixMacros(e.text.trim(), charName, userName)}`,
    );
    return `# Sample dialogue\nThese only demonstrate the prose style; they are not events that have happened:\n${lines.join("\n")}`;
}

export function assembleMixPrompt(input: MixAssembleInput): MixAssembledPrompt {
    const card = input.character;
    const charName = card.charName.trim() || card.name.trim() || "the character";
    const m = input.materials;
    // Pick-one slots: take the first material in the stack
    const firstOf = <T extends MixMaterial>(kind: MixMaterialKind): T | undefined => {
        const found = m[kind]?.find((item) => item.kind === kind);
        return found as T | undefined;
    };
    const persona = firstOf<MixPersonaMaterial>("persona");
    // The user's name: explicitly passed in > whatever the mask supplies > the default
    const userName = input.userName?.trim() || persona?.userName?.trim() || MIX_DEFAULT_USER_NAME;
    const ticket = firstOf<MixTicketMaterial>("ticket");
    const encore = firstOf<MixEncoreMaterial>("encore");

    const apply = (text: string) => applyMixMacros(text, charName, userName, input.state);

    // Stacking slots: everything in the stack whose condition held, joined in order
    const baseText = stackBody(m.base, apply);
    const flavorText = stackBody(m.flavor, apply);
    const glassText = stackBody(m.glass, apply);
    const strengthText = stackBody(m.strength, apply);

    const sections: (string | null)[] = [
        preamble(charName),
        baseText ? `# Roleplay rules\n${baseText}` : null,
        sectionBlock("Character info", [
            `## Character name\n${charName}`,
            field("Basics", card.baseInfo),
            field("Personality", card.personality),
            field("Appearance", card.appearance),
            field("Background", card.background),
        ].map((l) => (l ? apply(l) : l))),
        // User info: who {{user}} is. Supplied by the mask material, so the model knows what
        // to call the person opposite and how to read them.
        persona && persona.content.trim()
            ? [
                // The heading is "Name", not "Your name": inside the prompt "you" means the MODEL,
                // so the on-screen wording would point at the wrong party here. Every other
                // heading matches the interface exactly.
                persona.userName?.trim()
                    ? `# User info\n## Name\n${apply(persona.userName.trim())}`
                    : "# User info",
                `## User persona\n${apply(persona.content.trim())}`,
            ].join("\n\n")
            : null,
        sectionBlock("World & plot", [
            field("Worldview", card.worldview),
            // Word for word the label on that box in the editor; the {{user}} inside it is
            // substituted along with everything else below
            field("Initial awareness of {{user}}", card.cognition),
            field("Relationships & identity", card.relations),
            field("Current scene", card.plot),
            field("Extra setting", card.extra),
        ].map((l) => (l ? apply(l) : l))),
        flavorText ? `# Prose style\n${flavorText}` : null,
        // The built-in protocol first, the author's own output requirements after it, each its
        // own ## entry
        `# Output requirements\n${PROSE_PROTOCOL}${glassText ? `\n\n## Output requirements\n${glassText}` : ""}`,
        ticket ? ticketSection(ticket, charName, userName, input.state) : null,
        encore ? encoreSection(encore, charName, userName, input.state) : null,
        exampleSection(card, charName, userName),
        checklistSection(
            Boolean(ticket?.contract.trim()),
            Boolean(encore?.contract?.trim()),
        ),
    ];

    const openings = card.openings.filter((o) => o.trim());
    const idx = input.openingIndex ?? 0;
    const opening = openings.length
        ? apply(openings[idx >= 0 && idx < openings.length ? idx : 0].trim())
        : "";

    return {
        system: sections.filter((s): s is string => Boolean(s)).join("\n\n"),
        postHistory: strengthText
            ? `[Highest priority requirements]\n${strengthText}`
            : "",
        opening,
        hasTicket: Boolean(ticket?.contract.trim() && ticket?.renderHtml.trim()),
        hasEncore: Boolean(encore?.contract?.trim() && encore && mixEncoreRenderHtml(encore).trim()),
    };
}
