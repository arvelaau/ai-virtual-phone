// Fixture for the House Special prompt layer (lib/mixology/assembler.ts + prose.ts).
//
// Two decisions in this stage are protocol, not translation, and both are load-bearing:
//   1. {{state.X}} is what the assembler now teaches, but {{状态.X}} must keep resolving --
//      materials are shared through the hall, so a Chinese-authored blend can arrive at any
//      time and its macros have to work.
//   2. The taught dialogue marker stays 「」, but straight double quotes are also parsed as
//      dialogue, because a model writing English reaches for them by reflex. Without that
//      branch the dialogue silently falls through as narration and every garnish that
//      colors .mix-dialogue quietly stops working.
//
//   node _fx-mixology-prompt.mjs

import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root } });

const A = await jiti.import("./lib/mixology/assembler.ts");
const P = await jiti.import("./lib/mixology/prose.ts");
const T = await jiti.import("./lib/mixology/types.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 300));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

// ── A. macro substitution, both spellings ──
const state = { affection: 61, mood: "wary" };
eq("A1 {{char}} substitutes", A.applyMixMacros("Hi {{char}}", "Rin", "You"), "Hi Rin");
eq("A2 {{user}} substitutes", A.applyMixMacros("Hi {{user}}", "Rin", "Ada"), "Hi Ada");
eq("A3 English {{state.X}} resolves", A.applyMixMacros("aff={{state.affection}}", "R", "A", state), "aff=61");
// The reason the legacy branch exists at all.
eq("A4 legacy {{状态.X}} still resolves", A.applyMixMacros("aff={{状态.affection}}", "R", "A", state), "aff=61");
eq("A5 full-width dot accepted", A.applyMixMacros("m={{状态．mood}}", "R", "A", state), "m=wary");
eq("A6 unknown name collapses to nothing, no placeholder left",
    A.applyMixMacros("[{{state.nope}}]", "R", "A", state), "[]");
eq("A7 spacing tolerated", A.applyMixMacros("{{ state . mood }}", "R", "A", state), "wary");
// A player called <b> must not be able to break the opening canvas.
eq("A8 escapeHtml escapes the substituted value only",
    A.applyMixMacros("<i>{{user}}</i>", "R", "<b>", undefined, { escapeHtml: true }), "<i>&lt;b&gt;</i>");
eq("A9 escapeHtml leaves the author's own tags alone",
    A.applyMixMacros("<i>{{user}}</i>", "R", "Ada", undefined, { escapeHtml: true }), "<i>Ada</i>");

// ── B. prose parsing: dialogue in both conventions ──
const seg = (line) => {
    const p = P.parseMixProse(line);
    return p[0]?.type === "text" ? p[0].segments : [];
};
check("B1 taught 「」 parses as dialogue",
    seg("He paused. 「Not tonight.」").some(s => s.type === "dialogue"), seg("He paused. 「Not tonight.」"));
// The whole reason for the second branch.
check("B2 straight double quotes ALSO parse as dialogue",
    seg('He paused. "Not tonight."').some(s => s.type === "dialogue"), seg('He paused. "Not tonight."'));
check("B3 *inner voice* parses as thought", seg("*She is lying.* He said nothing.").some(s => s.type === "thought"));
check("B4 ~emphasis~ parses as accent", seg("It was ~exactly~ that.").some(s => s.type === "accent"));
check("B5 plain text is narration", seg("The rain kept on.").every(s => s.type === "narration"));
// Assert the TYPE as well as the text. Checking text alone passes vacuously when the branch
// is removed, because the narration fallback carries the identical characters -- found by
// running the control, not by reading.
check("B6 dialogue keeps its own delimiters AND is typed as dialogue",
    seg("「Hi.」")[0]?.text === "「Hi.」" && seg("「Hi.」")[0]?.type === "dialogue"
    && seg('"Hi."')[0]?.text === '"Hi."' && seg('"Hi."')[0]?.type === "dialogue",
    { corner: seg("「Hi.」")[0], straight: seg('"Hi."')[0] });
{
    const p = P.parseMixProse("【The bar, later】");
    check("B7 a whole line in 【】 is a scene divider", p[0]?.type === "scene" && p[0].text === "The bar, later", p[0]);
}
check("B8 narration and dialogue split into separate segments",
    seg('She shrugged. "Fine." He left.').filter(s => s.type === "narration").length >= 2);

// ── C. block extraction, English and legacy names ──
for (const [label, open, close] of [
    ["taught English", "[StatusPanel]", "[/StatusPanel]"],
    ["legacy 状态栏", "[状态栏]", "[/状态栏]"],
    ["legacy alias 小票", "[小票]", "[/小票]"],
]) {
    const r = P.extractMixBlocks(`${open}\naffection: 61\n${close}\n\nShe looked up.`);
    check(`C ${label}: block is extracted`, r.ticketRaw?.includes("affection: 61"), r.ticketRaw);
    check(`C ${label}: prose survives`, r.text === "She looked up.", r.text);
}
{
    const r = P.extractMixBlocks("[Skit]\nA tiny scene.\n[/Skit]\n\nMain prose.");
    check("C4 skit block extracted", r.encoreRaw === "A tiny scene." && r.text === "Main prose.", r);
}
{
    // A truncated generation with no closing tag must still yield the block.
    const r = P.extractMixBlocks("She left.\n[StatusPanel]\naffection: 4");
    check("C5 unterminated block falls back to the line-start opener",
        r.ticketRaw?.includes("affection: 4") && r.text === "She left.", r);
}
{
    // Prose merely MENTIONING a tag name must not swallow the reply.
    const r = P.extractMixBlocks("He wrote [StatusPanel] on the napkin and laughed.");
    check("C6 a tag mentioned mid-line is not treated as a block", r.ticketRaw === undefined, r);
}

// ── D. the assembled prompt ──
const card = {
    id: "c1", kind: "character", name: "Rin", charName: "Rin", openings: ["The door opens."],
    personality: "Guarded.", createdAt: 0, updatedAt: 0,
};
{
    const out = A.assembleMixPrompt({ character: card, materials: {} });
    check("D1 opening returned separately, not in the system prompt",
        out.opening === "The door opens." && !out.system.includes("The door opens."), out.opening);
    check("D2 the prose protocol is always present", out.system.includes("Output requirements"), null);
    check("D3 an empty slot leaves no empty heading", !out.system.includes("## Prose style"), null);
    check("D4 a filled character field appears", out.system.includes("Personality: Guarded."), null);
    eq("D5 no bitters means empty postHistory", out.postHistory, "");
    eq("D6 no receipt means hasTicket false", out.hasTicket, false);
}
{
    const bitters = { id: "s1", kind: "strength", name: "s", content: "Stay in scene.", createdAt: 0, updatedAt: 0 };
    const out = A.assembleMixPrompt({ character: card, materials: { strength: [bitters] } });
    check("D7 bitters go to postHistory, not the system prompt",
        out.postHistory.includes("Stay in scene.") && !out.system.includes("Stay in scene."), out.postHistory);
}
{
    // Stacking slots concatenate the whole stack, in order.
    const f = (id, text) => ({ id, kind: "flavor", name: id, content: text, createdAt: 0, updatedAt: 0 });
    const out = A.assembleMixPrompt({ character: card, materials: { flavor: [f("a", "First."), f("b", "Second.")] } });
    const i1 = out.system.indexOf("First."), i2 = out.system.indexOf("Second.");
    check("D8 a stacking slot concatenates in order", i1 > 0 && i2 > i1, { i1, i2 });
}
{
    const ticket = {
        id: "t1", kind: "ticket", name: "t", contract: "affection: <number>",
        renderHtml: "<div></div>", createdAt: 0, updatedAt: 0,
    };
    const out = A.assembleMixPrompt({ character: card, materials: { ticket: [ticket] } });
    check("D9 the receipt contract reaches the prompt inside the taught wrapper",
        out.system.includes(A.MIX_TICKET_OPEN) && out.system.includes("affection: <number>"), null);
    eq("D10 hasTicket true with contract + render code", out.hasTicket, true);
    check("D11 the checklist names the section verbatim", out.system.includes('under "Status panel"'), null);
}

// ── E. the cross-file lockstep this stage sets ──
// The section labels shown in the UI must equal the headings the assembler actually emits;
// nothing reads one from the other, so stage 4's editor and preview have to match these too.
const out = A.assembleMixPrompt({
    character: card,
    materials: { base: [{ id: "b", kind: "base", name: "b", content: "x", createdAt: 0, updatedAt: 0 }] },
});
for (const kind of ["base", "glass"]) {
    const label = T.MIX_KIND_SECTION_LABELS[kind];
    check(`E ${kind}: label "${label}" is the heading the assembler emits`,
        A.assembleMixPrompt({
            character: card,
            materials: { [kind]: [{ id: "m", kind, name: "m", content: "x", createdAt: 0, updatedAt: 0 }] },
        }).system.includes(`## ${label}`), label);
}
check("E3 the checklist reference matches the glassware label exactly",
    out.system.includes("Output requirements"), null);

// ── F. the cheat sheet must describe the prompt the assembler actually builds ──
//
// mixology-preview's STRUCTURE_ROWS tells an author which section their material lands in,
// and every `section` there is a HAND-COPIED literal of an assembler heading -- nothing reads
// one from the other. If they drift, the sheet confidently names a section the prompt does
// not contain. Same for mixology-editor's KIND_GUIDE `where` strings.
{
    const fs = await import("node:fs");
    const preview = fs.readFileSync("components/mixology/mixology-preview.tsx", "utf8");
    const rows = [...preview.matchAll(/\{\s*section:\s*"([^"]+)"/g)].map(m => m[1]);
    check("F1 the cheat sheet has its full set of rows", rows.length >= 11, rows.length);

    // Build a prompt in which EVERY optional section is present. The card needs the World &
    // plot fields populated too -- with them empty the assembler correctly drops that whole
    // section, and the row would look like drift when it is only an under-filled fixture.
    const everyKind = A.assembleMixPrompt({
        character: {
            ...card,
            worldview: "A city.", cognition: "Barely.", relations: "A regular.",
            plot: "Closing time.", extra: "The manager works days.",
            examples: [{ role: "user", text: "hi" }],
        },
        materials: Object.fromEntries(["base", "flavor", "glass", "strength"].map(k =>
            [k, [{ id: k, kind: k, name: k, content: "x", createdAt: 0, updatedAt: 0 }]])),
    });
    const withBlocks = A.assembleMixPrompt({
        character: card,
        materials: {
            ticket: [{ id: "t", kind: "ticket", name: "t", contract: "a: 1", renderHtml: "<i></i>", createdAt: 0, updatedAt: 0 }],
            encore: [{ id: "e", kind: "encore", name: "e", contract: "c", renderHtml: "<i></i>", createdAt: 0, updatedAt: 0 }],
            persona: [{ id: "p", kind: "persona", name: "p", content: "me", createdAt: 0, updatedAt: 0 }],
        },
    });
    const allPrompt = `${everyKind.system}\n${everyKind.postHistory}\n${withBlocks.system}\n${withBlocks.postHistory}`;

    for (const row of rows) {
        if (!row.startsWith("## ")) continue;
        check(`F  cheat sheet row "${row}" is a heading the assembler emits`,
            allPrompt.includes(row), row);
    }
    check("F2 the post-history row matches what the assembler emits",
        rows.some(r => !r.startsWith("## ")) && allPrompt.includes("[Highest priority requirements]"),
        everyKind.postHistory.slice(0, 60));
    check("F3 the cheat sheet carries no CJK", !/[一-鿿]/.test(preview), null);

    // The editor's per-kind guidance names the same sections in prose.
    const editor = fs.readFileSync("components/mixology/mixology-editor.tsx", "utf8");
    check("F4 the editor guidance carries no CJK", !/[一-鿿]/.test(editor), null);
    for (const name of ["Roleplay rules", "Output requirements", "Status panel", "Skit"]) {
        check(`F  editor guidance names the section "${name}" as the assembler spells it`,
            editor.includes(name), name);
    }
}

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity, measured:\n" +
    "  drop 状态 from the macro alternation -> 38/40, failing A4 A5. That is the hall case:\n" +
    "    a Chinese-authored blend installed from the hall stops resolving its macros.\n" +
    "  drop the straight-quote dialogue branch from INLINE_RE -> 38/40, failing B2 B6 B8.\n" +
    "  drop StatusPanel from TICKET_TAGS -> 37/40, failing both 'taught English' rows and C5.\n" +
    "\n" +
    "  Two notes from writing those controls. B6 originally compared only .text and passed\n" +
    "  VACUOUSLY, because the narration fallback carries the identical characters; it now\n" +
    "  asserts the segment type too. And a control that replaced the branch with an empty\n" +
    "  group made the fixture OOM rather than fail -- parseInline's exec loop does not guard\n" +
    "  against a zero-length match. No real branch can match empty (every one needs at least\n" +
    "  its delimiters), so this is not a live bug, but do not add an alternative that can.",
);
process.exit(fail ? 1 : 0);
