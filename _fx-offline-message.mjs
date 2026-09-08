// Offline mode can send a real chat message -- the offline counterpart to story mode's
// [Message] rollout, built from the exact same template (_fx-story-message.mjs) since every
// check there encodes a real, separately user-reported bug that offline needs the same
// protection against from day one.
//
// The dispatcher itself writes to chat storage and cannot be driven under Node, so this covers
// the two halves that CAN be: what extractOfflineDispatchableMessages() extracts/strips, and
// (once wired) that the offline surface teaches exactly the shape the parser accepts.
//
//   node _fx-offline-message.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });

const { extractOfflineDispatchableMessages, isCompleteOfflineMessage } = jiti(path.join(root, "lib/offline-message-dispatch.ts"));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 200)}`}`); } };
const eq = (n, g, w) => ok(n, Object.is(g, w), { got: g, want: w });

const TAG = "summary"; // the session's configured <summaryTag> -- "summary" is also the built-in fallback
const OFFLINE = (extra) => `<content>
She checked her phone twice while you were away.
</content>
<summary>
She thought about texting you.
</summary>${extra ? "\n" + extra : ""}`;

// ── A. the happy path ─────────────────────────────────────────────────────────
{
    const raw = OFFLINE("[Message]\nhey\n[/Message]");
    const { parsed, dispatchable } = extractOfflineDispatchableMessages(raw, TAG);
    eq("A1 one message dispatched", dispatchable.length, 1);
    eq("A2 canonical type is the Chinese name", dispatchable[0].type, "消息");
    eq("A3 content is what arrives", dispatchable[0]?.content.trim(), "hey");
    ok("A4 the tag is stripped from the parsed content", !/\[\/?Message\]/i.test(parsed.content), parsed.content);
    ok("A5 the narration survives in parsed.content", parsed.content.includes("She checked her phone"));
    ok("A6 the summary field still extracts", parsed.summary.includes("She thought about texting you"));
    ok("A7 the message body is NOT left in the parsed content", !parsed.content.includes("hey"), parsed.content);
}

// ── B. shapes the model will actually produce ────────────────────────────────
{
    const multi = extractOfflineDispatchableMessages(OFFLINE("[Message]\nhey\nyou up?\n[/Message]"), TAG);
    eq("B1 several lines stay one action", multi.dispatchable.length, 1);
    ok("B2 both lines carried", multi.dispatchable[0]?.content.includes("hey") && multi.dispatchable[0]?.content.includes("you up?"));

    const legacy = extractOfflineDispatchableMessages(OFFLINE("[消息]\n在吗\n[/消息]"), TAG);
    eq("B3 legacy alias parses", legacy.dispatchable.length, 1);
    eq("B4 and normalises to the same type", legacy.dispatchable[0]?.type, "消息");

    const two = extractOfflineDispatchableMessages(OFFLINE("[Message]\nfirst\n[/Message]\n[Message]\nsecond\n[/Message]"), TAG);
    eq("B5 two blocks give two actions", two.dispatchable.length, 2);
}

// ── G. the completeness guard ─────────────────────────────────────────────────
{
    const fires = (raw) => extractOfflineDispatchableMessages(raw, TAG).dispatchable;

    const good = OFFLINE("[Message]\nhey\n[/Message]");
    eq("G1 a properly closed block fires", fires(good).length, 1);
    eq("G2 with the right content", fires(good)[0]?.content.trim(), "hey");

    const unclosed = OFFLINE("[Message]\nhey");
    eq("G4 an unclosed block does not fire", fires(unclosed).length, 0);

    const swallowed = "[Message]\nShe checked her phone.\nA long stretch of narration follows.\nAnd more.";
    eq("G6 an opener with no closer at all does not fire", fires(swallowed).length, 0);

    const mismatched = OFFLINE("[Message]\nhey\n[/消息]");
    eq("G8 a mismatched alias pair does not fire", fires(mismatched).length, 0);

    eq("G9 a matched legacy pair fires", fires(OFFLINE("[消息]\n在吗\n[/消息]")).length, 1);
    eq("G10 an empty block does not fire", fires(OFFLINE("[Message]\n\n[/Message]")).length, 0);
}

// ── W. the whole turn must never end up in chat ──────────────────────────────
{
    const NARRATION = "She checked her phone twice while you were away.\nThe apartment was quiet.";
    const run = (raw) => extractOfflineDispatchableMessages(raw, TAG);
    const leaks = (r) => r.dispatchable.some((a) => a.content.includes("She checked her phone"));

    // E: the model wrapped the whole turn in the tag
    const wrapped = run(`[Message]\n<content>\n${NARRATION}\n</content>\n<summary>\ns\n</summary>\n[/Message]`);
    eq("W1 a block containing the XML fields does not fire", wrapped.dispatchable.length, 0);
    ok("W2 so the narration cannot reach chat", !leaks(wrapped));

    // The case that ISOLATES the XML-field guard from the swallowed-turn guard: the turn
    // survives (so the swallowed-turn guard never fires), but the model has repeated a chunk of
    // the turn's own structural fields inside the [Message] block. Only the structural-field
    // check in isCompleteOfflineMessage stops that reaching chat -- mirrors story's W0a/W0b,
    // which is what caught this same check being silently removed.
    const duplicated = run(
        `<content>\n${NARRATION}\n</content>\n<summary>\ns\n</summary>\n[Message]\nhey\n<content>\n${NARRATION}\n</content>\n[/Message]`);
    eq("W0a a block repeating the XML fields does not fire", duplicated.dispatchable.length, 0);

    // F: opened at the top, closed at the very end, no XML at all
    const topToBottom = run(`[Message]\n${NARRATION}\nhey\n[/Message]`);
    eq("W3 a block that swallows the turn does not fire", topToBottom.dispatchable.length, 0);
    ok("W4 so the narration cannot reach chat", !leaks(topToBottom));

    // the legitimate shapes must be untouched
    const taught = run(`<content>\n${NARRATION}\n</content>\n<summary>\ns\n</summary>\n[Message]\nhey\n[/Message]`);
    eq("W6 the taught shape still fires", taught.dispatchable.length, 1);
    eq("W7 with only the message", taught.dispatchable[0]?.content.trim(), "hey");
    const inside = run(`<content>\n${NARRATION}\n[Message]\nhey\n[/Message]\n</content>\n<summary>\ns\n</summary>`);
    eq("W8 a block inside <content> still fires", inside.dispatchable.length, 1);
    const before = run(`[Message]\nhey\n[/Message]\n<content>\n${NARRATION}\n</content>`);
    eq("W9 a block before the turn still fires", before.dispatchable.length, 1);
    const noXml = run(`${NARRATION}\n[Message]\nhey\n[/Message]`);
    eq("W10 narration with no XML still fires", noXml.dispatchable.length, 1);
    ok("W11 and none of those leak the narration",
        !leaks(taught) && !leaks(inside) && !leaks(before) && !leaks(noXml));

    // a custom session summaryTag must be honored as a structural field too
    const customTag = "diary";
    const customRun = extractOfflineDispatchableMessages(
        `<content>\n${NARRATION}\n</content>\n<${customTag}>\ns\n</${customTag}>\n[Message]\nhey\n[/Message]`, customTag);
    eq("W23 the custom summary tag is recognised as structural", customRun.dispatchable.length, 1);
    const customSwallowed = extractOfflineDispatchableMessages(
        `[Message]\n<content>\n${NARRATION}\n</content>\n<${customTag}>\ns\n</${customTag}>\n[/Message]`, customTag);
    eq("W24 a block wrapping the custom tag also does not fire", customSwallowed.dispatchable.length, 0);

    // reasoning must not rescue a turn-swallowing block
    const reasoningOnly = extractOfflineDispatchableMessages(
        `<think>\nShe should text him.\n</think>\n[Message]\n${NARRATION}\nhey\n[/Message]`, TAG);
    eq("W19 reasoning does not rescue a turn-swallowing block", reasoningOnly.dispatchable.length, 0);

    // a turn that is content-tag-free (offline's own lenient shape) with a real message still fires
    const noContentTag = extractOfflineDispatchableMessages(`${NARRATION}\n[Message]\nhey\n[/Message]`, TAG);
    eq("W25 a content-tag-free offline turn still fires its message", noContentTag.dispatchable.length, 1);
}

// ── C. what must NOT happen ──────────────────────────────────────────────────
{
    const plain = extractOfflineDispatchableMessages(OFFLINE(""), TAG);
    eq("C1 an ordinary turn fires nothing", plain.dispatchable.length, 0);

    const narrated = extractOfflineDispatchableMessages(`<content>
She typed "hey" and hit send, then put the phone down.
</content>`, TAG);
    eq("C3 narration about a message fires nothing", narrated.dispatchable.length, 0);
}

// ── Q. the author's punctuation must survive a [Message] turn ────────────────
{
    const CORNER_OPEN = String.fromCharCode(0x300c);
    const CORNER_CLOSE = String.fromCharCode(0x300d);
    const dialogue = CORNER_OPEN + "Are you home yet?" + CORNER_CLOSE + " she typed.";
    const scene = `<content>\nShe picked up her phone.\n${dialogue}\n</content>`;

    const withMsg = extractOfflineDispatchableMessages(scene + "\n\n[Message]\nhey\n[/Message]", TAG);
    eq("Q1 the message still parses", withMsg.dispatchable.length, 1);
    ok("Q2 corner quotes survive a [Message] turn",
        withMsg.parsed.content.includes(CORNER_OPEN + "Are you home yet?" + CORNER_CLOSE),
        withMsg.parsed.content);
}

// ── D. scope: offline dispatches Message ONLY ────────────────────────────────
{
    const raw = OFFLINE("[Moments]\na post\n[/Moments]\n[Message]\nhey\n[/Message]");
    const { dispatchable } = extractOfflineDispatchableMessages(raw, TAG);
    eq("D2 only the message is dispatchable from offline", dispatchable.length, 1);
    eq("D3 and it is the message", dispatchable[0]?.content.trim(), "hey");
}

// ── E. wiring, scoped to the function it lives in ────────────────────────────
{
    ok("E9 offline is an accepted sourceEngine",
        fs.readFileSync(path.join(root, "lib/action-parser.ts"), "utf8").includes('"offline"'));

    const mod = fs.readFileSync(path.join(root, "lib/offline-message-dispatch.ts"), "utf8");
    ok("E10 dispatchOfflineMessages routes through dispatchActions", mod.includes("dispatchActions("));
    ok("E11 sourceEngine is offline", mod.includes('sourceEngine: "offline"'));
    ok("E12 dispatch failure cannot take the turn down", mod.includes(".catch("));
}

// ── P. the teaching matches the parser ───────────────────────────────────────
{
    const preset = fs.readFileSync(path.join(root, "lib/builtin-preset.ts"), "utf8");
    const start = preset.indexOf('identifier: "chat_offline_format",\n                name:');
    ok("P0 the offline entry was located structurally", start >= 0, start);
    const end = preset.indexOf('].join("\\n")', start);
    const entry = start >= 0 && end > start ? preset.slice(start, end) : "";
    ok("P0b the entry has a sane size", entry.length > 500 && entry.length < 20000, entry.length);

    ok("P1 the entry teaches the tag", entry.includes("[Message]") && entry.includes("[/Message]"));
    ok("P2 it says the message is real", /arrives in their chat app/i.test(entry));
    ok("P3 it places the block outside the offline summary tag", /AFTER <\/\{\{offlineSummaryTag\}\}>/.test(entry));
    ok("P4 it forbids repeating the text in the prose", /Do not write the message text out again/i.test(entry));
    ok("P5 it carves itself out of the forbidden list", /ONLY chat directive offline mode may use/i.test(entry));
    ok("P6 it tells the model to omit it when not messaging", /Leave it out entirely/i.test(entry));
    ok("P7 the entry still targets the offline surface", /tags: \["chat", "offline"\]/.test(preset.slice(start, start + entry.length + 400)));

    const rebuilt = "[Message]\nwhat actually arrives on their phone\n[/Message]";
    const { dispatchable } = extractOfflineDispatchableMessages(OFFLINE(rebuilt), TAG);
    eq("P9 the taught shape parses", dispatchable.length, 1);
    eq("P10 as a dispatchable message", dispatchable[0].type, "消息");

    const v = preset.match(/BUILTIN_PRESET_VERSION = (\d+)/);
    ok("P11 the version was bumped past 280", v && Number(v[1]) >= 281, v && v[1]);
}

const EXPECTED = 56;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
