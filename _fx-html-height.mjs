// Fixture for the inline HTML card height ratchet
// (buildChatHtmlDocument in components/chat/message-bubble.tsx).
//
// The bug: the injected height bridge measured
//   Math.max(body.scrollHeight, documentElement.scrollHeight, 80)
// but documentElement.scrollHeight is at least the iframe viewport, and that viewport is
// the height the PARENT set from our own previous report. So the measurement includes
// itself: the reported height can grow and can never shrink, leaving a band of blank
// space under the card once the content gets shorter.
//
// The measurement is injected script text that runs inside an iframe, so this fixture
// pulls the script back out of the generated document and executes it against a fake DOM
// that models the self-reference explicitly.
//
//   node _fx-html-height.mjs

import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, jsx: true, alias: { "@": root } });

const { buildChatHtmlDocument } = await jiti.import("./components/chat/message-bubble.tsx");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 300));
};

// ── a fake iframe ────────────────────────────────────────────────────────────
// The important part is `frameHeight`: documentElement.scrollHeight reports it, exactly
// as a real browser does, which is what makes the old formula self-referential.
function makeFrame({ contentHeight, frameHeight = 0, innerWidth = 320 }) {
    const posted = [];
    const listeners = { window: {}, document: {} };
    const state = { contentHeight, frameHeight };

    const body = {
        get scrollHeight() { return state.contentHeight; },
        getBoundingClientRect() { return { height: state.contentHeight, top: 0 }; },
        children: [],
        addEventListener() {},
    };
    const documentElement = {
        // A real browser floors this at the viewport height.
        get scrollHeight() { return Math.max(state.contentHeight, state.frameHeight); },
    };
    const doc = {
        body, documentElement,
        addEventListener(type, fn) { (listeners.document[type] ||= []).push(fn); },
    };
    const win = {
        get innerWidth() { return innerWidth; },
        document: doc,
        addEventListener(type, fn) { (listeners.window[type] ||= []).push(fn); },
        parent: { postMessage: (msg) => posted.push(msg) },
        ResizeObserver: undefined,
        setTimeout: () => 0,
    };

    const src = buildChatHtmlDocument("<div>card</div>", true);
    const script = src.match(/<script>([\s\S]*?)<\\?\/script>/)?.[1];
    if (!script) throw new Error("could not extract the injected script");

    // eslint-disable-next-line no-new-func
    new Function("window", "document", "setTimeout", `${script}`)(win, doc, () => 0);

    return {
        posted,
        state,
        // The parent does this on every report: size the iframe to what was reported.
        fireLoad() {
            for (const fn of listeners.window.load ?? []) fn();
            const last = posted[posted.length - 1];
            if (last && typeof last.h === "number") state.frameHeight = last.h;
        },
        lastHeight() {
            const h = posted.filter(m => m.type === "_chat_inline_html_resize");
            return h.length ? h[h.length - 1].h : null;
        },
    };
}

// ── A. it still reports a normal height ──
{
    const f = makeFrame({ contentHeight: 320 });
    f.fireLoad();
    check("A1 reports the content height", f.lastHeight() === 320, f.lastHeight());
    check("A2 the parent then sizes the frame to it", f.state.frameHeight === 320, f.state.frameHeight);
}
{
    const f = makeFrame({ contentHeight: 10 });
    f.fireLoad();
    check("A3 the 80px floor still applies", f.lastHeight() === 80, f.lastHeight());
}

// ── B. THE BUG: content shrinks after the frame was already grown ──
{
    const f = makeFrame({ contentHeight: 320 });
    f.fireLoad();                    // -> 320, frame is now 320 tall
    f.state.contentHeight = 120;     // a <details> closed
    f.fireLoad();                    // measure again
    check("B1 a shrunken card reports its new, smaller height",
        f.lastHeight() === 120, f.lastHeight());
    check("B2 the frame actually shrinks back", f.state.frameHeight === 120, f.state.frameHeight);
}
{
    // Repeated shrink must keep tracking, not stick at the first value.
    const f = makeFrame({ contentHeight: 600 });
    f.fireLoad();
    for (const h of [400, 250, 130]) { f.state.contentHeight = h; f.fireLoad(); }
    check("B3 tracks a stepwise shrink all the way down", f.lastHeight() === 130, f.lastHeight());
}
{
    // Growing must still work -- the fix must not trade one direction for the other.
    const f = makeFrame({ contentHeight: 120 });
    f.fireLoad();
    f.state.contentHeight = 500;
    f.fireLoad();
    check("B4 growth still works", f.lastHeight() === 500, f.lastHeight());
}

// ── C. zero-width frame reports nothing rather than garbage ──
{
    const f = makeFrame({ contentHeight: 300, innerWidth: 0 });
    f.fireLoad();
    check("C1 a not-yet-laid-out frame posts no height at all",
        f.lastHeight() === null, f.posted);
}
{
    // ...and does not burn the send budget, so it can still report once laid out.
    const f = makeFrame({ contentHeight: 300, innerWidth: 0 });
    for (let i = 0; i < 20; i++) f.fireLoad();
    check("C2 a hidden frame does not exhaust the 12-send budget", f.lastHeight() === null, f.lastHeight());
}

// ── D. source-level: documentElement must be gone from the inline measurement ──
{
    const inlineDoc = buildChatHtmlDocument("<p>x</p>", true);
    // Deliberately matches `documentElement` ANYWHERE in the bridge, not the literal
    // string "documentElement.scrollHeight": the old code spelled it across two
    // statements (`var d=document.documentElement` ... `d.scrollHeight`), so the narrow
    // check passed vacuously against the very code it was meant to catch.
    // Math.max(0, ...) is load-bearing: the marker sits at index ~599, so a bare
    // `idx - 600` goes negative and String.slice reads that as "the last N characters",
    // leaving a one-character haystack that passes no matter what the code says.
    const bridge = inlineDoc.slice(Math.max(0, inlineDoc.indexOf("_chat_inline_html_resize") - 600));
    check("D1 the inline bridge does not touch documentElement at all",
        !bridge.includes("documentElement"), bridge.slice(0, 200));
    check("D2 the inline bridge measures body", inlineDoc.includes("getBoundingClientRect"), null);
    // Non-inline documents must not get a resize bridge at all.
    const plainDoc = buildChatHtmlDocument("<p>x</p>", false);
    check("D3 non-inline documents get no resize bridge",
        !plainDoc.includes("_chat_inline_html_resize"), null);
    check("D4 the click/action bridge survives in both",
        inlineDoc.includes("_chat_action") && plainDoc.includes("_chat_action"), null);
}

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity, measured:\n" +
    "  restore the pre-fix measurement (documentElement in the max) -> 6/13, failing\n" +
    "    B1 B2 B3 (it reports 320 forever) plus C1 C2 D1 D2.\n" +
    "  upstream's fix verbatim, without the zero-width bail -> 11/13, failing C1 C2.\n" +
    "  D1 took TWO fixes to stop being vacuous, both found by running the control:\n" +
    "    it first matched the literal \"documentElement.scrollHeight\", which the old code\n" +
    "    never spelled that way; then its slice index went negative, so String.slice read\n" +
    "    it as 'last N chars' and it asserted on a one-character string.",
);
process.exit(fail ? 1 : 0);
