// Fixture for the <style> HTML-protection stop condition (lib/rich-message-parser.ts,
// htmlProtectionRegex + lib/block-tags.ts blockCloserAlternationSource).
//
// The bug: when the model follows the contract and writes raw HTML inside [StatusPanel],
// there is normally only a single newline before the closing tag. The protection run had
// exactly two stop conditions -- a blank line followed by a non-`<` character, or end of
// text -- so it ran to `$` and swallowed [/StatusPanel] together with the chat reply
// after it. The closer was gone before extractBracketBlock ran, no pair matched, and the
// literal tags plus the HTML leaked into the bubble as one blob.
//
// Upstream fixed this Chinese-only. This fork teaches the ENGLISH tags, so the stop
// condition has to come from the bilingual alias arrays or it fixes nothing here.
//
//   node _fx-html-protect.mjs

import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root } });

const { parseAIResponse, BLOCK_TAG_STATUS_PANEL, BLOCK_TAG_INNER } =
    await jiti.import("./lib/rich-message-parser.ts");
const { blockCloserAlternationSource } = await jiti.import("./lib/block-tags.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};

// What the user actually sees in the bubble -- assert on that, not on regex internals.
const visible = (raw) =>
    parseAIResponse(raw, []).parts.map(p => p.content ?? "").join("\n").trim();
const parse = (raw) => parseAIResponse(raw, []);

const HTML = `<style>.p{color:red}</style>\n<div class="p">Mood: calm</div>`;

// ── A. the reported defect, in BOTH languages ──
for (const [lang, open, close] of [
    ["English", "[StatusPanel]", "[/StatusPanel]"],
    ["legacy Chinese", "[状态栏]", "[/状态栏]"],
    ["mixed aliases", "[StatusPanel]", "[/状态栏]"],
]) {
    // Single newline before the closer -- the shape that leaked.
    const raw = `${open}\n${HTML}\n${close}\n\nHey, how did it go?`;
    const r = parse(raw);
    check(`A ${lang}: status panel is extracted`, r.statusPanel.includes("Mood: calm"), r.statusPanel);
    check(`A ${lang}: the reply survives`, visible(raw).includes("Hey, how did it go?"), visible(raw));
    check(`A ${lang}: no literal tag leaks into the bubble`,
        !visible(raw).includes(open) && !visible(raw).includes(close.replace("[/", "[/")),
        visible(raw));
}

// ── B. [InnerThoughts] has the identical defect ──
for (const [lang, open, close] of [
    ["English", "[InnerThoughts]", "[/InnerThoughts]"],
    ["legacy Chinese", "[内心]", "[/内心]"],
]) {
    const raw = `${open}\n${HTML}\n${close}\n\nI'm fine, really.`;
    const r = parse(raw);
    check(`B ${lang}: inner monologue is extracted`, r.innerMonologue.includes("Mood: calm"), r.innerMonologue);
    check(`B ${lang}: the reply survives`, visible(raw).includes("I'm fine, really."), visible(raw));
    check(`B ${lang}: no literal tag leaks`, !visible(raw).includes(open), visible(raw));
}

// ── C. the three other shapes the same root cause broke ──
// Closer immediately after the HTML with no newline at all.
{
    const raw = `[StatusPanel]${HTML}[/StatusPanel]\n\nAll good.`;
    check("C1 closer on the same line as the HTML",
        parse(raw).statusPanel.includes("Mood: calm") && visible(raw).includes("All good."), visible(raw));
}
// Whole block on one line.
{
    const raw = `[StatusPanel]<style>.p{color:red}</style><div class="p">x</div>[/StatusPanel]\n\nDone.`;
    check("C2 entire block on a single line",
        parse(raw).statusPanel.includes("<div") && visible(raw).includes("Done."), visible(raw));
}
// A blank line after the closer (the workaround the user found) must STILL work.
{
    const raw = `[StatusPanel]\n${HTML}\n\n[/StatusPanel]\n\nStill fine.`;
    check("C3 blank line before the closer still works (the old workaround)",
        parse(raw).statusPanel.includes("Mood: calm") && visible(raw).includes("Still fine."), visible(raw));
}

// ── D. regressions: protection must still protect ──
{
    // A genuine styled card in ordinary content, blank line, then prose.
    const raw = `${HTML}\n\nHere is the card above.`;
    const r = parse(raw);
    check("D1 a plain <style> card is still preserved intact",
        r.parts.some(p => (p.content ?? "").includes("<style>")), r.parts.map(p => p.content));
    check("D2 prose after the blank line is still its own segment",
        visible(raw).includes("Here is the card above."), visible(raw));
}
{
    // <style> running to end of text, no closer anywhere -- the `$` branch.
    const raw = `Look:\n\n${HTML}`;
    check("D3 <style> at end of text is still protected to $",
        visible(raw).includes("<style>"), visible(raw));
}
{
    // A closer belonging to NO open block must not truncate protection early in a way
    // that damages the HTML: the panel content is what matters.
    const raw = `[StatusPanel]\n<style>.a{}</style>\n<b>x</b>\n[/StatusPanel]`;
    check("D4 no trailing reply is required", parse(raw).statusPanel.includes("<b>x</b>"),
        parse(raw).statusPanel);
}
{
    // Ordinary text mentioning a bracket word must not be touched.
    const raw = "I finished [The Hobbit] last night.";
    check("D5 an unrelated bracket phrase is untouched", visible(raw) === "I finished [The Hobbit] last night.", visible(raw));
}

// ── E. the stop condition is built from the alias arrays, not hardcoded ──
{
    const src = blockCloserAlternationSource(BLOCK_TAG_STATUS_PANEL, BLOCK_TAG_INNER);
    for (const tag of [...BLOCK_TAG_STATUS_PANEL, ...BLOCK_TAG_INNER]) {
        check(`E ${tag} appears in the generated stop condition`, src.includes(tag), src);
    }
    check("E the source is a closer pattern, not an opener", src.startsWith("\\[\\/"), src);
}
// Guard the escaping trap this repo has shipped before: a `new RegExp(`...`)` written
// with single backslashes compiles fine and silently stops matching.
{
    const fs = await import("node:fs");
    const text = fs.readFileSync("lib/rich-message-parser.ts", "utf8");
    const line = text.split("\n").find(l => l.includes("<style[") && l.includes("new RegExp"));
    check("E regex template literal doubles its backslashes",
        Boolean(line) && line.includes("\\\\s\\\\S") && !/[^\\]\\s\\S/.test(line), line);
}

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity, measured:\n" +
    "  drop the closer branch (pre-fix) -> 20/29: every 'is extracted' and 'no literal\n" +
    "    tag leaks' assertion fails, plus D4.\n" +
    "  upstream's fix verbatim, closer hardcoded to (?:状态栏|内心) -> 25/29: ONLY the\n" +
    "    English cases fail. That is the empirical reason this had to be a port rather\n" +
    "    than a copy -- this fork teaches [StatusPanel]/[InnerThoughts].\n" +
    "  Note the 'reply survives' assertions do NOT fail: when the block leaks, the reply\n" +
    "    text is still present, just glued into the same bubble behind literal tags. The\n" +
    "    leak assertions are the ones that discriminate, so both are kept.",
);
process.exit(fail ? 1 : 0);
