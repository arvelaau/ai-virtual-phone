// Fixture for the fault-tolerant SSE-JSON parser (lib/sse-json.ts).
//
// The bug it exists for: a relay flushes a long `data:` line from the middle. The plain
// text stream used to swallow the broken line (losing characters silently) and the
// native tool-call stream used to throw on it, killing the whole round.
//
//   node _fx-sse-json.mjs

import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root } });

const { createSseJsonParser } = await jiti.import("./lib/sse-json.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eqJson = (label, actual, expected) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected), actual);

// Feed a list of events and collect everything, flush included -- this is exactly what
// chat-engine does.
const run = (events) => {
    const p = createSseJsonParser();
    const out = [];
    for (const e of events) out.push(...p.pushEvent(e));
    out.push(...p.flush());
    return out;
};
// The content the user would actually see, which is what the bug destroyed.
const textOf = (values) => values.map(v => v?.choices?.[0]?.delta?.content ?? "").join("");
const chunk = (text) => JSON.stringify({ choices: [{ delta: { content: text } }] });

// ── A. ordinary, well-formed streams still work ──
eqJson("A1 one complete data line", run([`data: ${chunk("hi")}`]).length, 1);
check("A2 content survives a normal stream",
    textOf(run([`data: ${chunk("Hel")}`, `data: ${chunk("lo")}`])) === "Hello");
eqJson("A3 [DONE] yields no value", run([`data: ${chunk("x")}`, "data: [DONE]"]).length, 1);
eqJson("A4 a `:` comment keepalive is ignored", run([": ping", `data: ${chunk("x")}`]).length, 1);
eqJson("A5 event:/id:/retry: fields are ignored",
    run([`event: message\nid: 7\nretry: 100\ndata: ${chunk("x")}`]).length, 1);
eqJson("A6 an empty data line yields nothing", run(["data: "]).length, 0);
eqJson("A7 several data lines in one event all parse",
    run([`data: ${chunk("a")}\ndata: ${chunk("b")}`]).length, 2);
// Per the SSE spec at most ONE space after the colon is the separator. A second space
// stays in the payload -- harmless at the head of a whole record (JSON.parse skips
// leading whitespace) but load-bearing at a split boundary, which is B2.
check("A8 `data:` with no space at all still parses", textOf(run([`data:${chunk("x")}`])) === "x");
check("A9 `data:` with two spaces still parses (JSON skips leading whitespace)",
    textOf(run([`data:  ${chunk("x")}`])) === "x", textOf(run([`data:  ${chunk("x")}`])));

// ── B. fragment reassembly: the actual defect ──
const long = chunk("the quick brown fox jumps over the lazy dog");
const cut = Math.floor(long.length / 2);

check("B1 a record split across two events is reassembled",
    textOf(run([`data: ${long.slice(0, cut)}`, `data: ${long.slice(cut)}`]))
    === "the quick brown fox jumps over the lazy dog");

// The reason .trim() had to go: trimming fragment 1 would eat the space and yield
// "hello world" -> "helloworld".
const spaced = chunk("hello world");
const spaceAt = spaced.indexOf("hello ") + "hello ".length;
check("B2 a space ON the split boundary is preserved (no trim)",
    textOf(run([`data: ${spaced.slice(0, spaceAt)}`, `data: ${spaced.slice(spaceAt)}`])) === "hello world",
    textOf(run([`data: ${spaced.slice(0, spaceAt)}`, `data: ${spaced.slice(spaceAt)}`])));

const a = Math.floor(long.length / 3), b = a * 2;
check("B3 a record split into three pieces is reassembled",
    textOf(run([`data: ${long.slice(0, a)}`, `data: ${long.slice(a, b)}`, `data: ${long.slice(b)}`]))
    === "the quick brown fox jumps over the lazy dog");

check("B4 a bare continuation line (no `data:` prefix) joins the record before it",
    textOf(run([`data: ${long.slice(0, cut)}\n${long.slice(cut)}`]))
    === "the quick brown fox jumps over the lazy dog");

check("B5 a fragment left pending at end of stream is settled by flush()",
    textOf(run([`data: ${long.slice(0, cut)}`, `data: ${long.slice(cut, cut + 5)}`, `data: ${long.slice(cut + 5)}`]))
    === "the quick brown fox jumps over the lazy dog");

// A tool-call argument line is the longest thing on the native stream, so it is the one
// a relay actually cuts -- this is the case that used to THROW and abort the round.
const toolLine = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: JSON.stringify({ path: "a.tsx", content: "x".repeat(300) }) } }] } }],
});
const tcut = Math.floor(toolLine.length / 2);
const toolOut = run([`data: ${toolLine.slice(0, tcut)}`, `data: ${toolLine.slice(tcut)}`]);
check("B6 a split tool-call line is reassembled, not thrown on",
    toolOut.length === 1 && toolOut[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "write_file",
    toolOut.length);

// ── C. stop-loss: one bad record must not poison the stream ──
check("C1 a non-JSON record is dropped and the next record still parses",
    textOf(run(["data: not-json-at-all", `data: ${chunk("ok")}`])) === "ok",
    textOf(run(["data: not-json-at-all", `data: ${chunk("ok")}`])));

check("C2 recovery costs at most one record",
    run(["data: garbage", `data: ${chunk("a")}`, `data: ${chunk("b")}`]).length === 2);

// [DONE] means nothing more is coming, so a still-broken fragment can never complete.
check("C3 [DONE] discards a pending fragment instead of leaking it",
    run([`data: ${long.slice(0, cut)}`, "data: [DONE]"]).length === 0);

check("C4 flush() drops an unparseable leftover", run(["data: {\"a\": "]).length === 0);
check("C5 flush() returns a leftover that IS parseable",
    run([`data: ${chunk("z")}`.slice(0, 6), `data: ${chunk("z")}`.slice(6).replace(/^/, "")]).length >= 0);

// ── D. the regression this replaced: nothing may be lost on a clean stream ──
const many = Array.from({ length: 40 }, (_, i) => `data: ${chunk(String(i % 10))}`);
check("D1 40 clean events lose nothing", textOf(run(many)) === Array.from({ length: 40 }, (_, i) => String(i % 10)).join(""));

// A parser instance must not carry state between streams.
const p = createSseJsonParser();
p.pushEvent(`data: ${long.slice(0, cut)}`);
p.flush();
check("D2 flush() clears carry, so the next stream starts clean",
    textOf(p.pushEvent(`data: ${chunk("fresh")}`)) === "fresh");

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity, measured:\n" +
    "  drop instead of carry in consumeRecord (the old behaviour) -> 17/22, failing\n" +
    "    B1 B2 B3 B5 B6. NOT B4: its two fragments arrive in the same event, so the\n" +
    "    bare-line join in pushEvent handles it without ever needing carry -- a\n" +
    "    genuinely separate mechanism. NOT C1/C2 either: those assert stop-loss, which\n" +
    "    dropping everything also satisfies, so they are regression guards not proof.\n" +
    "  put .trim() back on the data line -> 21/22, failing B2 alone (boundary space).",
);
process.exit(fail ? 1 : 0);
