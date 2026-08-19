// lib/mixology/types.ts
// House Special — domain types: materials, blends, sessions.
//
// Mental model: the character card is just another material. The player collects
// materials into a cabinet, picks one per slot at the bar to mix a "blend", and a blend
// can be named, saved and shared. A session is one run of character card + blend.
// This file only defines the data shapes — assembly lives in assembler.ts, persistence
// in storage.ts.

/** The eleven material kinds (one slot each) */
export type MixMaterialKind =
    | "character" // character card
    | "persona"   // mask: the user's own persona ({{user}}'s name and description)
    | "base"      // base spirit: overall roleplay rules
    | "flavor"    // flavor: prose style
    | "glass"     // glassware: output format
    | "strength"  // bitters: tail reinforcement (closest to generation, so heaviest)
    | "ticket"    // receipt: status data card (output contract + render code)
    | "garnish"   // garnish: interface CSS
    | "encore"    // encore: an interactive HTML skit attached to the card
    | "filter"    // strainer: regex cleanup of the prose (never enters the prompt)
    | "mechanism"; // mechanism: sandboxed hook logic + a persistent panel

export const MIX_KIND_LABELS: Record<MixMaterialKind, string> = {
    character: "Character Card",
    persona: "Mask",
    base: "Base Spirit",
    flavor: "Flavor",
    glass: "Glassware",
    strength: "Bitters",
    ticket: "Receipt",
    garnish: "Garnish",
    encore: "Encore",
    filter: "Strainer",
    mechanism: "Mechanism",
};

/** Slot order at the bar (the character card is always the first slot) */
export const MIX_SLOT_ORDER: MixMaterialKind[] = [
    "character", "persona", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore", "filter", "mechanism",
];

/**
 * The small line under the big label on each tab: what this kind actually does. Kinds
 * that never reach the prompt are labelled with their real job instead.
 *
 * ⚠️ Several of these double as PROMPT SECTION HEADINGS, and the headings are written out
 * again as separate literals in assembler.ts (`## Output Requirements`), in the editor's
 * field help, and in the preview's section map. They are not read from here, so all of
 * those copies have to move together or the app describes a section the prompt does not
 * contain. See the lockstep note in CLAUDE.md.
 */
export const MIX_KIND_SECTION_LABELS: Record<MixMaterialKind, string> = {
    character: "Character info",
    persona: "User info",
    base: "Roleplay rules",
    flavor: "Prose style",
    glass: "Output requirements",
    strength: "Highest priority",
    ticket: "Status panel",
    garnish: "Interface style",
    encore: "Skit",
    filter: "Regex replace",
    mechanism: "Executable logic",
};

/** Required slots: a session cannot start without these. Every other slot may be empty. */
export const MIX_REQUIRED_KINDS: MixMaterialKind[] = ["character"];

/** How many materials one slot can stack */
export const MIX_SLOT_MAX = 3;

/**
 * Stacking semantics:
 * concat = every material in this slot whose condition holds applies, joined in order
 *          (layered prose styles, a main garnish plus a patch garnish);
 * first  = only the first one whose condition holds (there can be only one status card,
 *          and only one skit per turn).
 */
export const MIX_SLOT_STACK: Record<MixMaterialKind, "concat" | "first"> = {
    character: "first",
    persona: "first",
    base: "concat",
    flavor: "concat",
    glass: "concat",
    strength: "concat",
    ticket: "first",
    garnish: "concat",
    encore: "first",
    filter: "concat",
    mechanism: "concat",
};

/** Slots that cannot take a condition: without these two there is no session at all. */
export const MIX_NO_CONDITION_KINDS: MixMaterialKind[] = ["character", "persona"];

/**
 * Materials that RUN EVERY TURN ON THE DOWNLOADER'S DEVICE AND CAN REWRITE THE CONVERSATION.
 *
 * Receipts and encores carry JS too, but they only paint their own square inside a sandboxed
 * iframe and cannot touch the conversation. A mechanism is different: it can alter what you
 * send, alter the prose you see, and speak as you. So both publishing and installing one have
 * to say so explicitly — it must never slip through bundled in with ordinary materials.
 */
export const MIX_ACTIVE_CODE_KINDS: MixMaterialKind[] = ["mechanism"];

export function mixKindRunsActiveCode(kind: MixMaterialKind): boolean {
    return MIX_ACTIVE_CODE_KINDS.includes(kind);
}

export function mixKindAllowsCondition(kind: MixMaterialKind): boolean {
    return !MIX_NO_CONDITION_KINDS.includes(kind);
}

/**
 * Kinds that support a cover image: the character card plus the three "see the effect"
 * visual materials (receipt / garnish / encore). Those list as a two-column poster grid;
 * the remaining text-only materials have no cover and list as a single column.
 */
export const MIX_VISUAL_KINDS: MixMaterialKind[] = ["character", "ticket", "garnish", "encore"];

export function mixKindHasCover(kind: MixMaterialKind): boolean {
    return MIX_VISUAL_KINDS.includes(kind);
}

/** Tag limits per material — must match the cloud's normalizeTags exactly. */
export const MIX_TAG_MAX = 8;
export const MIX_TAG_LEN = 24;

/**
 * Tidy up tags: trim, dedupe, cap length, cap count.
 * Local and cloud have to use the same rules — otherwise nine tags look fine locally,
 * publishing keeps eight, and the author thinks publishing ate one.
 */
export function normalizeMixTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") continue;
        const tag = item.trim().replace(/\s+/g, " ").slice(0, MIX_TAG_LEN);
        if (!tag || out.includes(tag)) continue;
        out.push(tag);
        if (out.length >= MIX_TAG_MAX) break;
    }
    return out;
}

/**
 * Split one line of editor text into tags.
 *
 * Whitespace only counts as a separator when NO explicit separator is present. The original
 * split on whitespace unconditionally, which is harmless for Chinese tags (they contain no
 * spaces) but shreds an English one: "slice of life" became three tags. Same defect and same
 * fix as parseTags in xiaohongshu-engine.ts.
 */
export function parseMixTags(text: string): string[] {
    const explicit = /[,，、|｜#＃]/.test(text);
    return normalizeMixTags(text.split(explicit ? /[,，、|｜#＃]+/ : /\s+/));
}

/** Render tags back into that one line of editor text */
export function formatMixTags(tags: string[] | undefined): string {
    return (tags ?? []).join(", ");
}

/** Metadata shared by every material */
export type MixMaterialMeta = {
    id: string;
    kind: MixMaterialKind;
    name: string;
    /** One-line pitch (the hook shown in list views) */
    hook?: string;
    /** Creator credit (may be empty for something you made yourself) */
    author?: string;
    /** Creator avatar dataURL, carried back with a listing on install. Your own materials
     *  show your local creator profile instead and do not use this field. */
    authorAvatar?: string;
    tags?: string[];
    /** Cover image dataURL or remote address (strongly recommended for character cards) */
    cover?: string;
    /** The online id once published to the materials page — without it there is no
     *  "update the published version" to speak of. */
    publishedId?: string;
    /** Snapshot of updatedAt at the last successful push to the cloud. A local updatedAt
     *  newer than this means there are unpublished changes. */
    publishedAt?: number;
    /**
     * Somebody else's work, installed from the materials or recipes page. Same rules as the
     * app market and the game hall: you can play with it, but the app will not show its
     * source text, will not let you edit or export it, and will not let you republish it.
     */
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
};

/** Character card: every field the AI reads is optional (an empty field drops the whole
 *  section at assembly time); only the name is required. */
export type MixCharacterCard = MixMaterialMeta & {
    kind: "character";
    /** Character name (the session's {{char}}) */
    charName: string;
    /** Basics: age / height / occupation and so on, free text or key-value lines */
    baseInfo?: string;
    personality?: string;
    appearance?: string;
    background?: string;
    /** Worldview: the shared setting this character lives in */
    worldview?: string;
    /** Initial awareness of the user: what the character "knows" about them at the start */
    cognition?: string;
    /** Suggested identities and relationships: which roles the user can step into, and
     *  what the relationship looks like under each */
    relations?: string;
    /** Current scene: the situation at the moment the session opens */
    plot?: string;
    /** Opening lines (may be several — the player picks one at the start). Plain text;
     *  enters both the session and the prompt. */
    openings: string[];
    /** Opening canvas: the front page laid over the cover when the card is opened
     *  (HTML, sandboxed, never enters the prompt) */
    canvas?: string;
    /** Sample dialogue: the anchor for prose style (alternating user/char turns) */
    examples?: { role: "user" | "char"; text: string }[];
    /** Extra setting: NPCs, private glossaries, anything else */
    extra?: string;
    /** @deprecated superseded by the opening canvas; kept only to read old data */
    authorNote?: string;
};

/** Plain-text materials: base spirit / flavor / glassware / bitters */
export type MixTextMaterial = MixMaterialMeta & {
    kind: "base" | "flavor" | "glass" | "strength";
    content: string;
};

/** Mask (the user's persona): who {{user}} is — a name plus the persona text, assembled
 *  into the "User info" section. */
export type MixPersonaMaterial = MixMaterialMeta & {
    kind: "persona";
    /** The user's name, replacing {{user}}. Empty falls back to the default. */
    userName?: string;
    content: string;
};

/**
 * One item on a receipt marked "remember": pulled out of the receipt's raw text by key
 * every turn and kept across turns.
 * If it cannot be found, the previous turn's value stands — better stale than jumping.
 */
export type MixTicketVar = {
    /** Variable name, which is also the key in the receipt's raw text */
    name: string;
    /** Starting value at the top of a session */
    initial?: string;
};

/** Receipt: the output contract goes into the prompt, and the render code takes over the
 *  display inside a sandboxed iframe. */
export type MixTicketMaterial = MixMaterialMeta & {
    kind: "ticket";
    /** Tells the AI what to output inside the [Receipt] wrapper each turn */
    contract: string;
    /** Full HTML (may include JS); data is injected via window.TICKET_RAW / {{RAW}} */
    renderHtml: string;
    /** Sample data for the editor preview */
    previewRaw?: string;
    /** Which items on this receipt to remember. Remembered values can be tested by
     *  conditions and read back through {{state.X}}. */
    vars?: MixTicketVar[];
};

/** Garnish: styling for the session screen (official semantic classes plus the interface's
 *  own positioning hooks, as CSS) */
export type MixGarnishMaterial = MixMaterialMeta & {
    kind: "garnish";
    css: string;
};

/** Encore (the skit): the AI writes the extra content per the contract and the render code
 *  draws it. With no contract it is simply a static sketch. */
export type MixEncoreMaterial = MixMaterialMeta & {
    kind: "encore";
    /** Tells the AI when the skit appears and what to write. Leave empty and it never
     *  enters the prompt — the render code just shows as a static sketch. */
    contract?: string;
    /** Full HTML (may include JS); the AI's output is injected via window.ENCORE_RAW / {{RAW}} */
    renderHtml?: string;
    /** @deprecated old field (static HTML only); read as equivalent to renderHtml */
    html?: string;
    /** Sample data for the editor preview */
    previewRaw?: string;
};

/** Encore render code: one exit for both the old and new field */
export function mixEncoreRenderHtml(material: MixEncoreMaterial): string {
    return material.renderHtml ?? material.html ?? "";
}

/** One strainer rule: a regex to find, text to replace with, and where it applies */
export type MixFilterRule = {
    /** Find (a JS regex; the g flag is added automatically) */
    find: string;
    /** Replacement text (supports $1 and friends; an empty string deletes) */
    replace: string;
    /**
     * display = display only: both what is stored and what is sent to the model stay as
     *   written, and the substitution happens just before rendering — so it applies to the
     *   whole history immediately;
     * context = enters the context: the reply is cleaned once after its blocks are split
     *   out and then stored, so the history sent back to the model is the cleaned text —
     *   which means it only affects new replies.
     */
    mode: "display" | "context";
};

/** Strainer: regex cleanup of the AI's prose. Runs after the status-panel and skit blocks
 *  have been split out, never touches that block data, and never enters the prompt. */
export type MixFilterMaterial = MixMaterialMeta & {
    kind: "filter";
    rules: MixFilterRule[];
};

/** Where a mechanism docks: which edge of the session screen its panel hangs on. The app
 *  decides the exact placement; the creator only picks a side. */
export type MixDock = "left" | "right" | "bottom" | "float";

export const MIX_DOCK_LABELS: Record<MixDock, string> = {
    left: "Left rail",
    right: "Right rail",
    bottom: "Bottom bar",
    float: "Floating button",
};

/**
 * Mechanism: two halves, either of which may be empty.
 * - Hooks: called at a few fixed points in the pipeline, handed a payload and handing one
 *   back. They run in a sandbox with no network and no reach into the host page, behind a
 *   timeout breaker.
 * - Persistent panel: a piece of HTML pinned to a dock, alive across turns, with its own
 *   storage.
 * Both halves share one storage bucket, so they can see each other for free.
 */
export type MixMechanismMaterial = MixMaterialMeta & {
    kind: "mechanism";
    /** Hook code, defining onSessionStart / onBeforeSend / onAfterReply / onSessionEnd */
    script?: string;
    /** Dock for the persistent panel; without it this mechanism has no interface */
    dock?: MixDock;
    /** The panel's HTML (CSS/JS included), run inside a sandboxed iframe */
    panelHtml?: string;
};

export type MixMaterial =
    | MixCharacterCard
    | MixPersonaMaterial
    | MixTextMaterial
    | MixTicketMaterial
    | MixGarnishMaterial
    | MixEncoreMaterial
    | MixFilterMaterial
    | MixMechanismMaterial;

/** Comparison operators available to conditions */
export type MixCompareOp = ">" | ">=" | "<" | "<=" | "=" | "!=";

/**
 * When a material applies. Omitted = always.
 * Deliberately limited to four kinds that fit in one sentence — no nesting, no expression
 * evaluation. A condition is pure data, so sharing a material can never ship executable code.
 */
export type MixCondition =
    /** After turn N */
    | { type: "turn"; after: number }
    /** A remembered value satisfies a comparison (numeric if both sides are numbers,
     *  otherwise textual) */
    | { type: "var"; name: string; op: MixCompareOp; value: string }
    /** Any of these words came up within the last `within` turns (default: just the last one) */
    | { type: "keyword"; words: string[]; within?: number }
    /** Applies on a random percent% of turns */
    | { type: "chance"; percent: number };

/** One material inside a blend: the material id plus when it applies */
export type MixSlotEntry = {
    materialId: string;
    when?: MixCondition;
};

/** A remembered value: either a number (affection 61) or text (time of day: late night) */
export type MixStateValue = string | number;
export type MixState = Record<string, MixStateValue>;

/** Back-compat with early data, when a slot held exactly one material and stored its id
 *  as a bare string */
export type MixSlotsRaw = Partial<Record<MixMaterialKind, string | MixSlotEntry[]>>;

/** Read one slot's material list (accepts both the old and new shapes) */
export function mixSlotEntries(slots: MixSlotsRaw | undefined, kind: MixMaterialKind): MixSlotEntry[] {
    const raw = slots?.[kind];
    if (!raw) return [];
    if (typeof raw === "string") return [{ materialId: raw }];
    return raw.filter((entry) => entry && typeof entry.materialId === "string" && entry.materialId);
}

/** The id of the first material in a slot (for single-item slots like the card and the mask) */
export function mixSlotFirstId(slots: MixSlotsRaw | undefined, kind: MixMaterialKind): string | undefined {
    return mixSlotEntries(slots, kind)[0]?.materialId;
}

/** Normalize any slot shape to the current one (done once on read, then used throughout) */
export function normalizeMixSlots(slots: MixSlotsRaw | undefined): Partial<Record<MixMaterialKind, MixSlotEntry[]>> {
    const out: Partial<Record<MixMaterialKind, MixSlotEntry[]>> = {};
    for (const kind of MIX_SLOT_ORDER) {
        const entries = mixSlotEntries(slots, kind).slice(0, MIX_SLOT_MAX);
        if (entries.length) out[kind] = entries;
    }
    return out;
}

/** A blend: which material fills each slot (the materials themselves live in the cabinet) */
export type MixRecipe = {
    id: string;
    name: string;
    /** kind → the materials stacked in that slot (ordered, at most MIX_SLOT_MAX).
     *  The character card is always present; everything else may be missing. */
    slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>>;
    /** Author credit and avatar, carried back when installing from the recipes page.
     *  Your own blends show your local creator profile. */
    author?: string;
    authorAvatar?: string;
    /** The online id once published to the recipes page */
    publishedId?: string;
    /** Snapshot of updatedAt at the last successful push to the cloud */
    publishedAt?: number;
    /** Somebody else's blend, installed from the recipes page: cannot be republished */
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
};

/** One message in a session */
export type MixTurn = {
    id: string;
    role: "user" | "assistant";
    /** The prose (on the assistant side, with the receipt block already stripped out) */
    text: string;
    /** This turn's raw receipt text (present only when a receipt material is in play and
     *  the AI followed the contract) */
    ticketRaw?: string;
    /** This turn's raw skit text (present when the encore has a contract and the AI wrote one) */
    encoreRaw?: string;
    /**
     * The remembered values as of the end of this turn. After rewinding, regenerating or
     * editing a turn, restoring from the last remaining turn's snapshot is enough — numbers
     * never stay stuck at a future that was thrown away.
     */
    state?: MixState;
    createdAt: number;
};

/** A session: one run of "character card + blend" */
export type MixSession = {
    id: string;
    /** Snapshot of the blend taken at the start, so editing the blend later cannot change
     *  how an old session replays */
    recipe: MixRecipe;
    /** Snapshot of the character name (for list display; unaffected if the card is later
     *  deleted from the cabinet) */
    charName: string;
    /** The user's name ({{user}}); empty uses the default */
    userName?: string;
    /** Which opening was chosen */
    openingIndex: number;
    turns: MixTurn[];
    /** The currently remembered values (the receipt items ticked "remember", updated each turn) */
    state?: MixState;
    /**
     * Each mechanism's own storage bucket (materialId → key-value table), still there after
     * leaving and coming back.
     * Deliberately NOT snapshotted per turn: the bucket cap is 100KB, and keeping one copy
     * per turn would blow the session up. So after a rewind a mechanism still sees its
     * pre-rewind private memory — the payload carries turnCount, so a mechanism that cares
     * can notice the turn number went backwards and reset itself.
     */
    mechanismStore?: Record<string, Record<string, string>>;
    createdAt: number;
    updatedAt: number;
};

/**
 * Sync state against the cloud (following the app market's explicit-sync model):
 * local = never published; synced = published with no local changes; dirty = published but
 * with local changes not yet pushed.
 * Syncing is always an explicit action — saving locally never pushes to the cloud, and the
 * cloud never overwrites local.
 */
export function mixCloudState(item: { publishedId?: string; publishedAt?: number; updatedAt: number }): "local" | "synced" | "dirty" {
    if (!item.publishedId) return "local";
    if (!item.publishedAt || item.updatedAt > item.publishedAt) return "dirty";
    return "synced";
}

/** Generate a short id (used by every local entity) */
export function createMixId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
