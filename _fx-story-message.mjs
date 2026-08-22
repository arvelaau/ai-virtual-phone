// Story mode can send a real chat message.
//
// The dispatcher itself writes to chat storage and cannot be driven under Node, so this covers
// the two halves that CAN be: what the parser extracts and strips, and that the story surface
// teaches exactly the shape the parser accepts. The wiring between them is asserted at source,
// scoped to the function it lives in.
//
//   node _fx-story-message.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });

const AP = jiti(path.join(root, "lib/action-parser.ts"));
const { parseActionTags } = AP;
const { isCompleteStoryMessage } = jiti(path.join(root, "lib/story-engine.ts"));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 200)}`}`); } };
const eq = (n, g, w) => ok(n, Object.is(g, w), { got: g, want: w });

const STORY = (extra) => `<content>
She reached for her phone without looking up.
</content>
<summary>
She messaged him.
</summary>${extra ? "\n" + extra : ""}`;

// ── A. the happy path ─────────────────────────────────────────────────────────
{
    const raw = STORY("[Message]\nhey\n[/Message]");
    const { cleanText, actions } = parseActionTags(raw);
    eq("A1 one action found", actions.length, 1);
    eq("A2 canonical type is the Chinese name", actions[0].type, "消息");
    eq("A3 content is what arrives", actions[0].content.trim(), "hey");
    ok("A4 the tag is stripped from the story text", !/\[\/?Message\]/i.test(cleanText), cleanText);
    ok("A5 the prose survives", cleanText.includes("She reached for her phone"));
    ok("A6 the XML fields survive", cleanText.includes("<content>") && cleanText.includes("<summary>"));
    ok("A7 the message body is NOT left in the story text", !cleanText.includes("hey"), cleanText);
}

// ── B. shapes the model will actually produce ────────────────────────────────
{
    const multi = parseActionTags(STORY("[Message]\nhey\nyou up?\n[/Message]"));
    eq("B1 several lines stay one action", multi.actions.length, 1);
    ok("B2 both lines carried", multi.actions[0].content.includes("hey") && multi.actions[0].content.includes("you up?"));

    // legacy Chinese alias must still parse -- a Chinese-leaning model may write it
    const legacy = parseActionTags(STORY("[消息]\n在吗\n[/消息]"));
    eq("B3 legacy alias parses", legacy.actions.length, 1);
    eq("B4 and normalises to the same type", legacy.actions[0].type, "消息");

    // two separate blocks in one turn
    const two = parseActionTags(STORY("[Message]\nfirst\n[/Message]\n[Message]\nsecond\n[/Message]"));
    eq("B5 two blocks give two actions", two.actions.length, 2);
}

// ── G. the completeness guard — story is stricter than chat ──────────────────
//
// parseActionTags has a documented fallback for a missing closing tag: take the content to the
// end of the text. Correct for chat, dangerous here. Measured before this guard existed: an
// unclosed [Message] at the top of a turn produced content equal to the WHOLE story prose,
// which with notifications on would fire a banner carrying the entire scene.
{
    const only = (raw) => parseActionTags(raw).actions.filter((a) => a.type === "消息");
    const fires = (raw) => only(raw).filter(isCompleteStoryMessage);

    const good = STORY("[Message]\nhey\n[/Message]");
    eq("G1 a properly closed block fires", fires(good).length, 1);
    eq("G2 with the right content", fires(good)[0].content.trim(), "hey");

    // unclosed: the parser still yields an action, the guard refuses it
    const unclosed = STORY("[Message]\nhey");
    eq("G3 the parser still produces an action", only(unclosed).length, 1);
    eq("G4 but the guard refuses to fire it", fires(unclosed).length, 0);

    // the dangerous one: opened at the very top, never closed
    const swallowed = "[Message]\nShe reached for her phone.\nA long stretch of prose follows.\nAnd more.";
    ok("G5 the parser would have swallowed the whole story",
        only(swallowed)[0].content.includes("A long stretch of prose"), only(swallowed)[0]?.content);
    eq("G6 the guard stops it", fires(swallowed).length, 0);

    // mismatched aliases pair through the same fallback and leave the stray closer in the body
    const mismatched = STORY("[Message]\nhey\n[/消息]");
    ok("G7 a mismatched pair leaves the closer inside the content",
        only(mismatched)[0].content.includes("[/消息]"), only(mismatched)[0]?.content);
    eq("G8 the guard refuses that too", fires(mismatched).length, 0);

    // legacy-on-both-sides is a proper pair and must still work
    eq("G9 a matched legacy pair fires", fires(STORY("[消息]\n在吗\n[/消息]")).length, 1);

    // an empty block is not a message
    eq("G10 an empty block does not fire", fires(STORY("[Message]\n\n[/Message]")).length, 0);
}

// ── C. what must NOT happen ──────────────────────────────────────────────────
{
    const plain = parseActionTags(STORY(""));
    eq("C1 an ordinary turn fires nothing", plain.actions.length, 0);
    eq("C2 and its text is untouched", plain.cleanText.trim(), STORY("").trim());

    // prose that merely talks about messaging is not a directive
    const narrated = parseActionTags(`<content>
She typed "hey" and hit send, then stared at the ceiling.
</content>`);
    eq("C3 narration about a message fires nothing", narrated.actions.length, 0);

    // (the unclosed-tag case lives in group G, where the guard that handles it is tested)
}

// ── D. scope: story dispatches Message ONLY ──────────────────────────────────
//
// parseActionTags recognises five other actions. They are stripped from the story text but
// must not be acted on, or a story beat could silently post to Moments.
{
    const raw = STORY("[Moments]\na post\n[/Moments]\n[Message]\nhey\n[/Message]");
    const { cleanText, actions } = parseActionTags(raw);
    eq("D1 both are parsed", actions.length, 2);
    const dispatchable = actions.filter((a) => a.type === "消息");
    eq("D2 only one is dispatchable from story", dispatchable.length, 1);
    eq("D3 and it is the message", dispatchable[0].content.trim(), "hey");
    ok("D4 the non-dispatched tag is still stripped from the story",
        !/\[\/?Moments\]/i.test(cleanText), cleanText);
    ok("D5 its body does not leak into the story either", !cleanText.includes("a post"), cleanText);
}

// ── E. wiring, scoped to the function it lives in ────────────────────────────
{
    const eng = fs.readFileSync(path.join(root, "lib/story-engine.ts"), "utf8");
    const start = eng.indexOf("export async function generateStoryCompletion");
    const end = eng.indexOf("\n}", start);
    ok("E0 generateStoryCompletion was located", start >= 0 && end > start, { start, end });
    const body = start >= 0 && end > start ? eng.slice(start, end) : "";

    ok("E1 the story engine parses action tags", body.includes("parseActionTags(rawOutput)"));
    ok("E2 it dispatches them", body.includes("dispatchActions("));
    ok("E3 it filters to the one allowed action", body.includes("STORY_DISPATCHABLE_ACTION"));
    // Group G drives isCompleteStoryMessage directly, which proves the FUNCTION but says
    // nothing about the engine using it -- deleting the call from the filter left G passing.
    ok("E3b the filter actually applies the completeness guard",
        body.includes("isCompleteStoryMessage(action)"), body.slice(body.indexOf("chatMessages"), body.indexOf("chatMessages") + 200));
    ok("E4 the source engine is story", body.includes('sourceEngine: "story"'));
    // the display text must be the CLEANED text, or the tag renders as visible story prose
    ok("E5 parseStoryResponse is fed cleanText, not rawOutput",
        body.includes("parseStoryResponse(cleanText,") && !body.includes("parseStoryResponse(rawOutput,"));
    // parse order: actions come off the raw output BEFORE the user's regexes run
    const atParse = body.indexOf("parseActionTags(rawOutput)");
    const atStory = body.indexOf("parseStoryResponse(");
    ok("E6 actions are parsed before the story parser runs",
        atParse >= 0 && atStory >= 0 && atParse < atStory, { atParse, atStory });
    ok("E7 the canonical Chinese type is what is compared",
        eng.includes('const STORY_DISPATCHABLE_ACTION = "消息"'));
    ok("E8 dispatch failure cannot take the turn down", body.includes(".catch("));

    ok("E9 story is an accepted sourceEngine",
        fs.readFileSync(path.join(root, "lib/action-parser.ts"), "utf8").includes('| "story"'));
}

// ── P. the teaching matches the parser ───────────────────────────────────────
{
    const preset = fs.readFileSync(path.join(root, "lib/builtin-preset.ts"), "utf8");
    // locate the ENTRY, not the prompt_order toggle line -- the toggle list shadows every
    // identifier in this file, and slicing from it makes these assertions vacuous
    const start = preset.indexOf('identifier: "story_output_format",\n                name:');
    ok("P0 the story entry was located structurally", start >= 0, start);
    const end = preset.indexOf('].join("\\n")', start);
    const entry = start >= 0 && end > start ? preset.slice(start, end) : "";
    ok("P0b the entry has a sane size", entry.length > 500 && entry.length < 20000, entry.length);

    ok("P1 the entry teaches the tag", entry.includes("[Message]") && entry.includes("[/Message]"));
    ok("P2 it says the message is real", /arrives in their chat app/i.test(entry));
    ok("P3 it places the block outside the XML fields", /AFTER <\/summary>/.test(entry));
    ok("P4 it forbids repeating the text in the prose", /Do not write the message text out again/i.test(entry));
    ok("P5 it carves itself out of the forbidden list", /ONLY chat directive story mode may use/i.test(entry));
    ok("P6 it tells the model to omit it when not messaging", /Leave it out entirely/i.test(entry));
    ok("P7 the entry still targets the story surface", /tags: \["story"\]/.test(preset.slice(start, start + entry.length + 400)));

    // the taught block, lifted out of the teaching, must parse through the real parser
    const taught = entry.slice(entry.indexOf('"  [Message]"'));
    ok("P8 the taught template is present", taught.startsWith('"  [Message]"'), taught.slice(0, 60));
    const rebuilt = "[Message]\nwhat actually arrives on their phone\n[/Message]";
    const { actions } = parseActionTags(STORY(rebuilt));
    eq("P9 the taught shape parses", actions.length, 1);
    eq("P10 as a dispatchable message", actions[0].type, "消息");

    // a preset edit without a version bump is dead code -- loadPresets only refreshes on it
    const v = preset.match(/BUILTIN_PRESET_VERSION = (\d+)/);
    ok("P11 the version was bumped past 279", v && Number(v[1]) >= 280, v && v[1]);
}

const EXPECTED = 54;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
