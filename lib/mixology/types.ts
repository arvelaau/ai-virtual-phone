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

/**
 * Where a mechanism docks. This was the first way of placing a panel -- four hardcoded spots,
 * and the creator could only pick one of them. It survives for exactly two reasons: recognising
 * older materials, and offering a few handy starting points for free placement.
 * New materials use MixPanelLayout below.
 */
export type MixDock = "left" | "right" | "bottom" | "float";

export const MIX_DOCK_LABELS: Record<MixDock, string> = {
    left: "Left rail",
    right: "Right rail",
    bottom: "Bottom bar",
    float: "Floating button",
};

/**
 * Placement of a persistent panel. Position and size are both a PERCENTAGE of the session
 * screen, not pixels -- the same mechanism has to land in the same relative spot on an iPhone
 * SE and on an iPad, and hardcoded pixels cannot do that.
 *
 * Only two boundaries remain, and both exist to stop a panel locking the session up, not to
 * constrain layout:
 *   1. at least MIX_PANEL_KEEP_IN of the panel stays on screen, so it cannot be dragged away;
 *   2. it sits below the app's own dialogs.
 * Everything else -- where it is drawn, how big, whether it can be dragged, whether the app
 * draws any shell at all -- is the creator's call.
 */
export type MixPanelLayout = {
    /** Top-left corner, as a percentage of the session screen's width/height */
    x: number;
    y: number;
    /** Width and height, likewise percentages */
    w: number;
    h: number;
    /** Height follows the content and h degrades to a cap: for panels that stretch, like a
     *  small capsule */
    autoHeight?: boolean;
    /** Whether the player can drag it around (a dragged position is remembered for this
     *  session only, and never written back to the material) */
    drag?: boolean;
    /** Whether the player can resize it */
    resize?: boolean;
    /** Whether the app draws the handle bar carrying the name and the collapse arrow;
     *  none = the shell is entirely the creator's to draw */
    chrome?: "bar" | "none";
    /** Whether the app draws the backing plate (rounded dark fill, border, shadow). Turn it
     *  off when the panel draws its own background. */
    plate?: boolean;
    /**
     * The width to lay out against, in pixels. Set it and everything inside the panel is laid
     * out at that width, then the app scales the whole thing to the panel's real size --
     * required when drawing something like a 390-wide phone or a card, because otherwise the
     * same CSS crams together in a small panel and stretches thin in a large one, and the
     * preview never matches the real thing. Leave it unset and the panel lays out against its
     * own actual pixel size.
     */
    designWidth?: number;
    /** Ordering when several panels overlap on one screen, 0-9 */
    z?: number;
    /** Start the session collapsed (only meaningful when chrome is "bar") */
    collapsed?: boolean;
};

/** Drag it off the edge and you can never get it back, so this much always stays on screen
 *  (percentage) no matter how it is dragged */
export const MIX_PANEL_KEEP_IN = 8;
/** Minimum panel size: any smaller and it cannot be hit */
export const MIX_PANEL_MIN_W = 8;
export const MIX_PANEL_MIN_H = 4;
/** Ceiling on ordering: higher than this would cover the app's own dialogs */
export const MIX_PANEL_MAX_Z = 9;

/** The placement each of the four legacy docks maps to, which doubles as the set of starting
 *  points offered in the editor */
export const MIX_DOCK_PRESETS: Record<MixDock, MixPanelLayout> = {
    left: { x: 2, y: 12, w: 38, h: 52, drag: true, chrome: "bar", plate: true },
    right: { x: 60, y: 12, w: 38, h: 52, drag: true, chrome: "bar", plate: true },
    bottom: { x: 3, y: 58, w: 94, h: 34, drag: true, chrome: "bar", plate: true },
    float: { x: 55, y: 66, w: 45, h: 26, drag: true, chrome: "bar", plate: true, collapsed: true },
};

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num * 100) / 100));
}

/**
 * Normalise a placement. Imported JSON, records fetched from the cloud, and requests the panel
 * itself postMessages up all pass through here -- out-of-range values are clamped back in,
 * unrecognised fields are dropped.
 */
export function normalizeMixPanelLayout(value: unknown): MixPanelLayout | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const w = clampNum(record.w, MIX_PANEL_MIN_W, 100, 40);
    const h = clampNum(record.h, MIX_PANEL_MIN_H, 100, 30);
    // Negatives and values past 100 are allowed: part of a panel may sit off screen, as long as
    // a KEEP_IN-sized piece of it stays visible
    const x = clampNum(record.x, MIX_PANEL_KEEP_IN - w, 100 - MIX_PANEL_KEEP_IN, 4);
    const y = clampNum(record.y, MIX_PANEL_KEEP_IN - h, 100 - MIX_PANEL_KEEP_IN, 12);
    const layout: MixPanelLayout = { x, y, w, h };
    if (record.autoHeight === true) layout.autoHeight = true;
    if (record.drag !== false) layout.drag = true;
    if (record.resize === true) layout.resize = true;
    layout.chrome = record.chrome === "none" ? "none" : "bar";
    layout.plate = record.plate !== false;
    const design = clampNum(record.designWidth, 120, 1600, 0);
    if (design) layout.designWidth = Math.round(design);
    const z = clampNum(record.z, 0, MIX_PANEL_MAX_Z, 0);
    if (z) layout.z = z;
    if (record.collapsed === true) layout.collapsed = true;
    return layout;
}

/**
 * The starting values used when interface code was written but no placement was.
 * Placement is something the interface sets for itself in code, via mix.move / mix.size /
 * mix.chrome and friends; this is only where it stands for the frame before that code has run.
 * The app draws nothing, and the box is deliberately neutral.
 */
export const MIX_PANEL_DEFAULT_LAYOUT: MixPanelLayout = {
    x: 6, y: 14, w: 88, h: 44, drag: true, chrome: "none", plate: false,
};

/**
 * Which placement a mechanism is finally drawn with.
 * Its own if it has one; a converted legacy dock if that is all there is; and failing both, if
 * it has interface code at all, the neutral starting values, leaving the interface code to move
 * itself -- interface code means there is an interface, with nothing extra to declare.
 */
export function mixPanelLayoutOf(material: { layout?: MixPanelLayout; dock?: MixDock; panelHtml?: string }): MixPanelLayout | undefined {
    const own = normalizeMixPanelLayout(material.layout);
    if (own) return own;
    if (material.dock) return { ...MIX_DOCK_PRESETS[material.dock] };
    return material.panelHtml?.trim() ? { ...MIX_PANEL_DEFAULT_LAYOUT } : undefined;
}

/** One line describing a placement, for the detail page */
export function mixPanelLayoutSummary(layout: MixPanelLayout): string {
    const parts = [
        `${layout.x}% from left / ${layout.y}% from top`,
        `${layout.w}% x ${layout.autoHeight ? "auto" : `${layout.h}%`}`,
    ];
    if (layout.designWidth) parts.push(`laid out at ${layout.designWidth}px wide`);
    const flags: string[] = [];
    if (layout.drag !== false) flags.push("draggable");
    if (layout.resize) flags.push("resizable");
    if ((layout.chrome ?? "bar") === "none") flags.push("no shell");
    if (layout.plate === false) flags.push("no plate");
    if (flags.length) parts.push(flags.join(", "));
    return parts.join(" · ");
}

/**
 * Convert a free placement back to the nearest legacy dock. It is written alongside on publish,
 * so an older client receiving this mechanism can still hang it somewhere roughly right rather
 * than not showing it at all.
 */
export function mixNearestDock(layout: MixPanelLayout): MixDock {
    if (layout.w >= 70) return "bottom";
    if (layout.h <= 34 && layout.y >= 50) return "float";
    return layout.x + layout.w / 2 < 50 ? "left" : "right";
}

/**
 * Mechanism: two halves, either of which may be empty.
 * - Hooks: called at a few fixed points in the pipeline, handed a payload and handing one
 *   back. They run in a sandbox with no network and no reach into the host page, behind a
 *   timeout breaker.
 * - Persistent panel: a piece of HTML pinned at coordinates and a size of its own choosing,
 *   alive across turns, with its own storage.
 * Both halves share one storage bucket, so they can see each other for free.
 */
export type MixMechanismMaterial = MixMaterialMeta & {
    kind: "mechanism";
    /** Hook code, defining onSessionStart / onBeforeSend / onAfterReply / onSessionEnd */
    script?: string;
    /** @deprecated The first version's four docks, kept only to recognise older materials.
     *  New materials write `layout`. */
    dock?: MixDock;
    /** Where the persistent panel is drawn, how big, and whether it can be dragged. Without
     *  this and without a dock, this mechanism has no interface. */
    layout?: MixPanelLayout;
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
    /**
     * Panel positions the player has dragged or resized themselves (materialId -> placement),
     * good for this session only.
     * Never written back to the material: the material is its author's work, and a player
     * nudging something on their own screen should not edit somebody else's work.
     */
    panelBox?: Record<string, MixPanelLayout>;
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
