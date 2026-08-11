// Fixture for Couple Space stage 2b (AI wiring):
//   {{coupleSpace}} macro -> couple_space_context preset entry -> assemblePromptPayload.
//
//   node _fx-couple-space-prompt.mjs
//
// The load-bearing assertions are the end-to-end ones: a preset edit without a
// BUILTIN_PRESET_VERSION bump is dead code, and a macro the assembler never populates is
// invisible. Both are checked against the real assembler, not by reading source.

import path from "node:path";
import { createJiti } from "jiti";

globalThis.window = globalThis;
globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init?.detail; }
    };
}

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const P = await jiti.import("./lib/couple-space-prompt.ts");
const preset = await jiti.import("./lib/builtin-preset.ts");
const asm = await jiti.import("./lib/llm-prompt-assembler.ts");
const macro = await jiti.import("./lib/macro-engine.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

// ─────────────────────── A. the pure formatter ───────────────────────
const upcoming = (over = {}) => ({
    anniversary: { id: "a1", characterId: "c1", title: "First Date", date: "2024-03-03", recurring: true, createdAt: "", updatedAt: "" },
    nextDate: "2026-03-03", daysUntil: 12, yearsSince: 2, ...over,
});
const wish = (over = {}) => ({
    id: "w1", characterId: "c1", title: "Linen Scarf", wantedBy: "character",
    status: "wanted", createdAt: "", updatedAt: "", ...over,
});

const full = P.formatCoupleSpaceBlock({
    characterName: "Luna",
    upcoming: [upcoming()],
    wishlist: [wish(), wish({ id: "w2", title: "New Headphones", wantedBy: "user" })],
    gifts: { given: 3, received: 1 },
    latestGift: { id: "g1", direction: "user_to_character", productName: "Blue Ceramic Mug", sentAt: "", messageId: "", sessionId: "", counterpartId: "c1", counterpartName: "Luna", isGroup: false },
});
check("A1 block is headed with the character name", full.startsWith("[Couple Space with Luna]"), full);
check("A2 anniversary title present", full.includes('"First Date"'), full);
check("A3 date rendered in words", full.includes("3 March"), full);
check("A4 countdown present", full.includes("in 12 days"), full);
check("A5 years marked", full.includes("marking 2 years"), full);
check("A6 character wishlist labelled", full.includes("On Luna's wishlist:"), full);
check("A7 user wishlist labelled separately", full.includes("On the user's own wishlist:"), full);
check("A8 product spacing preserved", full.includes("Linen Scarf"), full);
check("A9 gift tally present", full.includes("3 given to Luna, 1 received"), full);
check("A10 latest gift named", full.includes("Blue Ceramic Mug"), full);

eq("A11 empty state yields empty string",
    P.formatCoupleSpaceBlock({ characterName: "Luna", upcoming: [], wishlist: [], gifts: { given: 0, received: 0 } }), "");
check("A12 today reads as today",
    P.formatCoupleSpaceBlock({ characterName: "L", upcoming: [upcoming({ daysUntil: 0 })], wishlist: [], gifts: { given: 0, received: 0 } }).includes("(today"), "");
check("A13 tomorrow reads as tomorrow",
    P.formatCoupleSpaceBlock({ characterName: "L", upcoming: [upcoming({ daysUntil: 1 })], wishlist: [], gifts: { given: 0, received: 0 } }).includes("(tomorrow"), "");
check("A14 one-off omits the years clause",
    !P.formatCoupleSpaceBlock({ characterName: "L", upcoming: [upcoming({ yearsSince: undefined })], wishlist: [], gifts: { given: 0, received: 0 } }).includes("marking"), "");
check("A15 fulfilled wishes are not advertised",
    !P.formatCoupleSpaceBlock({ characterName: "L", upcoming: [], wishlist: [wish({ status: "fulfilled" })], gifts: { given: 0, received: 0 } }).includes("Linen Scarf"), "");

// ─────────────────────── B. the macro ───────────────────────
const engine = new macro.MacroEngine("Luna", "Zara");
engine.coupleSpace = "[Couple Space with Luna]\nAnniversaries: x.";
check("B1 macro expands when populated",
    engine.expand("{{coupleSpace}}").includes("[Couple Space with Luna]"), engine.expand("{{coupleSpace}}"));

// expand() emits the raw TRIM sentinel; postProcessTrim is what removes it (and the
// surrounding newlines). The assembler runs both -- `postProcessTrim(content).trim()` --
// so the contract worth asserting is the pair, not expand() alone.
const emptyEngine = new macro.MacroEngine("Luna", "Zara");
const rawExpanded = emptyEngine.expand("{{coupleSpace}}");
check("B2 unpopulated macro yields the TRIM sentinel", rawExpanded.includes("TRIM"), rawExpanded);
eq("B3 postProcessTrim strips it to empty", macro.postProcessTrim(rawExpanded).trim(), "");
// A populated block must survive that same pass untouched.
check("B4 populated block survives postProcessTrim",
    macro.postProcessTrim(engine.expand("{{coupleSpace}}")).includes("[Couple Space with Luna]"), null);

// ─────────────────────── C. the preset entry + version gate ───────────────────────
const built = preset.createBuiltinPreset();
const entry = built.prompts.find(p => p.identifier === "couple_space_context");
const order = built.prompt_order.find(p => p.identifier === "couple_space_context");

check("C1 entry exists", Boolean(entry), built.prompts.map(p => p.identifier).slice(0, 5));
check("C2 entry is registered in prompt_order", Boolean(order), null);
eq("C3 entry is enabled in prompt_order", order?.enabled, true);
eq("C4 body is the bare macro", entry?.content, "{{coupleSpace}}");
// Untagged is what makes one entry cover every surface: the assembler only filters
// entries that HAVE tags.
check("C5 entry is deliberately untagged", entry?.tags === undefined || entry?.tags === null, entry?.tags);
check("C6 entry carries no CJK", !/[一-鿿]/.test(JSON.stringify(entry)), null);

// A preset change without a version bump never reaches a user who has opened the app.
check("C7 BUILTIN_PRESET_VERSION was bumped past 278", preset.BUILTIN_PRESET_VERSION > 278, preset.BUILTIN_PRESET_VERSION);
eq("C8 stored builtInVersion tracks the constant", built.builtInVersion, preset.BUILTIN_PRESET_VERSION);

// ─────────────────────── D. end to end through the real assembler ───────────────────────
const character = { id: "char_luna", name: "Luna", persona: "warm", personality: "", description: "" };
const baseInput = {
    character,
    history: [{ id: "m1", sessionId: "s1", role: "user", content: "hello", status: "sent", createdAt: "2026-05-01T10:00:00.000Z" }],
    preset: built,
    worldBooks: [],
    regexes: [],
    userIdentity: { name: "Zara" },
    appId: "chat",
    appTags: ["chat", "text"],
};

const BLOCK = "[Couple Space with Luna]\nAnniversaries: \"First Date\" on 3 March (in 12 days).";
const withBlock = JSON.stringify(asm.assemblePromptPayload({ ...baseInput, coupleSpace: BLOCK }));
const withoutBlock = JSON.stringify(asm.assemblePromptPayload({ ...baseInput }));

check("D1 the block reaches the assembled 1:1 payload", withBlock.includes("[Couple Space with Luna]"), null);
check("D2 the anniversary text reaches it", withBlock.includes("First Date"), null);
check("D3 it is absent when the caller supplies nothing", !withoutBlock.includes("Couple Space"), null);
// The TRIM path must remove the entry, not leave an empty system message behind.
const emptyMessages = asm.assemblePromptPayload({ ...baseInput }).filter(m => !String(m.content ?? "").trim());
eq("D4 no empty message is emitted when it TRIMs away", emptyMessages.length, 0);
// Regression guard: adding this entry must not displace what was already there.
check("D5 output_language_rule still present", withBlock.includes("Output language"), null);
check("D6 persona_style_authority still present", withBlock.includes("outranks your own past messages"), null);
check("D7 history still present", withBlock.includes("hello"), null);

// It is untagged, so it must reach non-chat surfaces too.
const moments = JSON.stringify(asm.assemblePromptPayload({
    ...baseInput, appId: "moments", appTags: ["moments"], coupleSpace: BLOCK,
}));
check("D8 untagged entry reaches the Moments surface", moments.includes("[Couple Space with Luna]"), null);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: delete the `coupleSpace` assignment in llm-prompt-assembler and D1/D2/D8\n" +
    "fail; revert BUILTIN_PRESET_VERSION to 278 and C7 fails.",
);
process.exit(fail ? 1 : 0);
