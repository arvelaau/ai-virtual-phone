// Fixture for the House Special sandbox safety layers:
//   lib/mixology/mechanism-protocol.ts  -- validating what a mechanism hands back
//   lib/mixology/css-scope.ts           -- caging shareable garnish CSS
//   lib/mixology/frame-height.ts        -- the viewport-unit height feedback loop
//
// All three fail SILENTLY when they are wrong: a bad hook result quietly corrupts somebody
// else's session, an uncaged garnish quietly blanks the app, and a height loop quietly pins
// a canvas at its ceiling. None of them throws, so none is noticeable without a test.
//
//   node _fx-mixology-sandbox.mjs

import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root } });

const M = await jiti.import("./lib/mixology/mechanism-protocol.ts");
const C = await jiti.import("./lib/mixology/css-scope.ts");
const F = await jiti.import("./lib/mixology/frame-height.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 300));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

// ── A. hook result validation ──
eq("A1 a non-object result collapses to {}", JSON.stringify(M.normalizeHookResult("nope")), "{}");
eq("A2 an array result collapses to {}", JSON.stringify(M.normalizeHookResult([1, 2])), "{}");
eq("A3 null collapses to {}", JSON.stringify(M.normalizeHookResult(null)), "{}");
check("A4 unknown fields are dropped",
    M.normalizeHookResult({ text: "ok", evil: "x" }).evil === undefined);
eq("A5 text passes through", M.normalizeHookResult({ text: "hi" }).text, "hi");
// The trap this project has hit five times: a clean* helper that strips real characters.
eq("A6 a multi-word English string survives cleaning",
    M.normalizeHookResult({ text: "she left the bar quietly" }).text, "she left the bar quietly");
eq("A7 NUL bytes are stripped from text",
    M.normalizeHookResult({ text: `a${String.fromCharCode(0)}b` }).text, "ab");
check("A8 an over-long text is capped", M.normalizeHookResult({ text: "x".repeat(50_000) }).text.length === 20_000);
check("A9 a blank note is dropped", M.normalizeHookResult({ note: "   " }).note === undefined);

// State: only numbers and short strings survive.
{
    const r = M.normalizeHookResult({ state: { a: 5, b: "wary", c: { nested: 1 }, d: [1], e: null, f: NaN } });
    eq("A10 numeric state kept", r.state?.a, 5);
    eq("A11 string state kept", r.state?.b, "wary");
    check("A12 object/array/null/NaN state values are all dropped",
        r.state?.c === undefined && r.state?.d === undefined && r.state?.e === undefined && r.state?.f === undefined, r.state);
}
check("A13 state key count is capped",
    Object.keys(M.normalizeHookResult({ state: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) }).state).length === 50);

// Store: values are always coerced to strings.
{
    const store = M.normalizeMechanismStore({ a: "x", b: 5, c: { deep: true } });
    check("A14 store values are all strings", Object.values(store).every(v => typeof v === "string"), store);
    eq("A15 a non-string store value is JSON-encoded", store.b, "5");
}
eq("A16 a non-object store collapses to {}", JSON.stringify(M.normalizeMechanismStore("nope")), "{}");
check("A17 store key count is capped",
    Object.keys(M.normalizeMechanismStore(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, "v"])))).length <= 100);

// mergeHookState: a mechanism sets keys, it never deletes anyone else's.
{
    const merged = M.mergeHookState({ a: 1, b: 2 }, { b: 9, c: 3 });
    check("A18 merge overwrites and adds without deleting",
        merged.a === 1 && merged.b === 9 && merged.c === 3, merged);
    check("A19 an empty patch returns the original", M.mergeHookState({ a: 1 }, undefined).a === 1);
}

// ── B. garnish CSS caging ──
//
// NOTE on how these are written. scopeMixCss always APPENDS the root survival rule, which
// itself contains the scope string -- so `output.includes(scope)` is true no matter what and
// proves nothing. Found by running the control: with scoping removed entirely, assertions
// written that way still passed. Each check below therefore looks at the RULE'S OWN
// selector, i.e. the text before the first {.
const scoped = (css) => C.scopeMixCss(css);
const firstSelector = (css) => scoped(css).split("{")[0];
{
    // The exact attack the module exists for: one line that blanks the whole app.
    const out = scoped("body { display: none }");
    check("B1 body{} is folded onto the scope root, not left global",
        firstSelector("body { display: none }") === C.MIX_GARNISH_SCOPE, firstSelector("body { display: none }"));
    check("B2 the root survival rule pins display back",
        out.includes("display: flex !important"), out);
}
check("B3 an ordinary selector is scoped, not emitted bare",
    firstSelector(".card { color: red }").startsWith(C.MIX_GARNISH_SCOPE)
    && firstSelector(".card { color: red }").includes(".card"),
    firstSelector(".card { color: red }"));
check("B4 @import is dropped entirely", !scoped('@import url("http://evil.test/x.css");').includes("evil.test"));
check("B5 :root is folded to the scope root",
    firstSelector(":root { --x: 1px }") === C.MIX_GARNISH_SCOPE, firstSelector(":root { --x: 1px }"));
{
    const out = scoped("@media (max-width: 400px) { .card { color: red } } ");
    check("B6 @media keeps its prelude and scopes the rule inside it",
        out.includes("@media") && out.includes(`${C.MIX_GARNISH_SCOPE} .card`), out);
}
{
    const out = scoped("@keyframes spin { from { opacity: 0 } to { opacity: 1 } }");
    check("B7 @keyframes body is left verbatim (from/to not rewritten)",
        out.includes("from") && out.includes("to") && !out.includes(`${C.MIX_GARNISH_SCOPE} from`), out);
}
eq("B8 empty input yields empty output", scoped("   "), "");
check("B9 a comma-separated selector list scopes EVERY branch",
    firstSelector(".a, .b { color: red }").includes(`${C.MIX_GARNISH_SCOPE} .a`)
    && firstSelector(".a, .b { color: red }").includes(`${C.MIX_GARNISH_SCOPE} .b`),
    firstSelector(".a, .b { color: red }"));
check("B10 a comment containing a brace does not break the scanner",
    firstSelector("/* } not a real brace */ .card { color: red }").includes(`${C.MIX_GARNISH_SCOPE} .card`),
    firstSelector("/* } not a real brace */ .card { color: red }"));

// ── C. the viewport-unit height feedback loop ──
{
    // A canvas written in vh: every report is "current height + the same constant".
    const t = F.createMixFrameHeightTracker(200);
    const range = { min: 80, max: 4000 };
    const seen = [];
    let applied = 200;
    for (let i = 0; i < 8; i++) {
        const next = F.nextMixFrameHeight(t, applied + 100, range);
        seen.push(next);
        if (next !== null) applied = next;
    }
    check("C1 a constant-delta loop is detected and frozen",
        seen.includes(null), seen);
    check("C2 it does not run away to the ceiling", applied < 1000, applied);
}
{
    // Genuine growth -- an image loading, a block opening -- must never be frozen.
    const t = F.createMixFrameHeightTracker(200);
    const range = { min: 80, max: 4000 };
    const a = F.nextMixFrameHeight(t, 260, range);
    const b = F.nextMixFrameHeight(t, 900, range);
    const c = F.nextMixFrameHeight(t, 640, range);
    check("C3 irregular real growth is followed, not frozen",
        a === 260 && b === 900 && c === 640, { a, b, c });
}
{
    const t = F.createMixFrameHeightTracker(200);
    check("C4 the range floor is honoured", F.nextMixFrameHeight(t, 10, { min: 80, max: 4000 }) === 80);
}
{
    const t = F.createMixFrameHeightTracker(200);
    check("C5 the range ceiling is honoured", F.nextMixFrameHeight(t, 99999, { min: 80, max: 4000 }) === 4000);
}
{
    const t = F.createMixFrameHeightTracker(200);
    check("C6 a non-finite report is rejected", F.nextMixFrameHeight(t, NaN, { min: 80, max: 4000 }) === null);
}
{
    // Freezing is per-round: once the signature stops matching, tracking resumes.
    const t = F.createMixFrameHeightTracker(200);
    const range = { min: 80, max: 4000 };
    let applied = 200;
    for (let i = 0; i < 6; i++) {
        const n = F.nextMixFrameHeight(t, applied + 100, range);
        if (n !== null) applied = n;
    }
    const resumed = F.nextMixFrameHeight(t, applied + 777, range);
    check("C7 a different delta resumes normal tracking after a freeze", resumed !== null, resumed);
}

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity, measured:\n" +
    "  make normalizeHookResult return its input unchanged -> 27/36 (A1-A4, A7-A9, A12, A13).\n" +
    "  make scopeSelectorList return the selector unscoped -> B1, B3, B5, B6, B9, B10 fail.\n" +
    "  disable the LOOP_HITS guard in nextMixFrameHeight -> 34/36 (C1, C2).\n" +
    "\n" +
    "  Two corrections worth keeping. Emptying ROOT_SELECTORS was NOT a valid control: it\n" +
    "  gives 36/36, because `body` is still scoped as a descendant rather than folded onto\n" +
    "  the root. That set is a usability choice; the security boundary is scopeSelectorList\n" +
    "  prefixing at all.\n" +
    "  And the B checks originally asserted output.includes(scope), which is ALWAYS true --\n" +
    "  scopeMixCss appends the root survival rule, and that rule contains the scope string.\n" +
    "  They now inspect the rule's own selector instead.",
);
process.exit(fail ? 1 : 0);
