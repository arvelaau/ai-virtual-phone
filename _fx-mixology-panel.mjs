// Mixology -- mechanism panel placement.
//
// The rework hands panel geometry to the material itself, so the host's clamping is the only
// thing standing between a downloaded mechanism and a panel that papers over the session
// screen. That clamping, the placement resolution (including back-compat with the four legacy
// docks), and the publish-time validation are what this covers.
//
// The drag math in mechanism-panel.tsx needs a real DOM and is deliberately NOT covered here;
// it is the part that still needs a human to try.
//
//   node _fx-mixology-panel.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });

const T = jiti(path.join(root, "lib/mixology/types.ts"));
const HP = jiti(path.join(root, "lib/mixology/hall-parts.ts"));

const {
    normalizeMixPanelLayout, mixPanelLayoutOf, mixPanelLayoutSummary, mixNearestDock,
    MIX_PANEL_KEEP_IN, MIX_PANEL_MIN_W, MIX_PANEL_MIN_H, MIX_PANEL_MAX_Z,
    MIX_DOCK_PRESETS, MIX_PANEL_DEFAULT_LAYOUT,
} = T;
const { validateMechanismPayload } = HP;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  FAIL ${name}${extra === undefined ? "" : ` -- ${extra}`}`);
};
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── A. the two floors: nothing may be dragged or declared off screen ────────────
{
    // A panel is allowed to hang off the edge -- that is legitimate layout -- but a
    // KEEP_IN-sized piece must survive, or it can never be recovered.
    const far = normalizeMixPanelLayout({ x: 9999, y: 9999, w: 40, h: 30 });
    ok("A1 x clamped to leave KEEP_IN on screen", far.x <= 100 - MIX_PANEL_KEEP_IN, far.x);
    ok("A2 y clamped to leave KEEP_IN on screen", far.y <= 100 - MIX_PANEL_KEEP_IN, far.y);

    const negative = normalizeMixPanelLayout({ x: -9999, y: -9999, w: 40, h: 30 });
    ok("A3 negative x still leaves KEEP_IN visible", negative.x >= MIX_PANEL_KEEP_IN - 40, negative.x);
    ok("A4 negative y still leaves KEEP_IN visible", negative.y >= MIX_PANEL_KEEP_IN - 30, negative.y);

    // Partly off screen IS allowed -- this is the assertion that stops a future "tidy-up"
    // turning the clamp into "must be fully on screen"
    const hanging = normalizeMixPanelLayout({ x: -10, y: 50, w: 40, h: 30 });
    ok("A5 a panel may hang off the left edge", hanging.x === -10, hanging.x);

    const tiny = normalizeMixPanelLayout({ x: 10, y: 10, w: 0, h: 0 });
    eq("A6 width floored at the minimum", tiny.w, MIX_PANEL_MIN_W);
    eq("A7 height floored at the minimum", tiny.h, MIX_PANEL_MIN_H);

    const huge = normalizeMixPanelLayout({ x: 0, y: 0, w: 5000, h: 5000 });
    eq("A8 width capped at 100", huge.w, 100);
    eq("A9 height capped at 100", huge.h, 100);

    // The other floor: a panel may never be ordered above the app's own dialogs
    eq("A10 z capped", normalizeMixPanelLayout({ x: 5, y: 5, w: 40, h: 30, z: 9999 }).z, MIX_PANEL_MAX_Z);
    eq("A11 negative z dropped to 0 (absent)", normalizeMixPanelLayout({ x: 5, y: 5, w: 40, h: 30, z: -5 }).z, undefined);
}

// ── B. everything else the normaliser vets ─────────────────────────────────────
{
    const base = { x: 5, y: 5, w: 40, h: 30 };
    ok("B1 non-object rejected", normalizeMixPanelLayout("nope") === undefined);
    ok("B2 null rejected", normalizeMixPanelLayout(null) === undefined);
    ok("B3 array rejected", normalizeMixPanelLayout([1, 2, 3]) === undefined);

    // A missing coordinate falls back rather than becoming NaN -- a NaN would reach a CSS
    // percentage and the panel would vanish with no error
    const partial = normalizeMixPanelLayout({ w: 40, h: 30 });
    ok("B4 missing x gets a finite fallback", Number.isFinite(partial.x), partial.x);
    ok("B5 missing y gets a finite fallback", Number.isFinite(partial.y), partial.y);
    const junk = normalizeMixPanelLayout({ x: "abc", y: {}, w: 40, h: 30 });
    ok("B6 non-numeric coordinates never produce NaN", Number.isFinite(junk.x) && Number.isFinite(junk.y));

    eq("B7 chrome defaults to bar", normalizeMixPanelLayout(base).chrome, "bar");
    eq("B8 chrome none honoured", normalizeMixPanelLayout({ ...base, chrome: "none" }).chrome, "none");
    eq("B9 an invented chrome falls back to bar", normalizeMixPanelLayout({ ...base, chrome: "evil" }).chrome, "bar");
    eq("B10 plate defaults on", normalizeMixPanelLayout(base).plate, true);
    eq("B11 plate false honoured", normalizeMixPanelLayout({ ...base, plate: false }).plate, false);
    eq("B12 drag defaults on", normalizeMixPanelLayout(base).drag, true);
    eq("B13 drag false honoured", normalizeMixPanelLayout({ ...base, drag: false }).drag, undefined);
    eq("B14 resize defaults off", normalizeMixPanelLayout(base).resize, undefined);
    eq("B15 resize true honoured", normalizeMixPanelLayout({ ...base, resize: true }).resize, true);

    eq("B16 designWidth clamped low", normalizeMixPanelLayout({ ...base, designWidth: 1 }).designWidth, 120);
    eq("B17 designWidth clamped high", normalizeMixPanelLayout({ ...base, designWidth: 99999 }).designWidth, 1600);
    eq("B18 designWidth absent when unset", normalizeMixPanelLayout(base).designWidth, undefined);

    // Unrecognised fields are dropped, so a payload cannot smuggle extra keys into the object
    // the host then spreads into a style
    const smuggled = normalizeMixPanelLayout({ ...base, position: "fixed", onclick: "alert(1)", zIndex: 99999 });
    ok("B19 unknown fields dropped", !("position" in smuggled) && !("onclick" in smuggled) && !("zIndex" in smuggled),
        Object.keys(smuggled).join(","));
}

// ── C. resolving which placement a mechanism is drawn with ─────────────────────
{
    const own = { x: 11, y: 22, w: 33, h: 44 };
    eq("C1 its own layout wins", mixPanelLayoutOf({ layout: own, dock: "left", panelHtml: "<b/>" }).x, 11);

    // Back-compat: a material saved before the rework has only a dock, and must still be placed
    for (const dock of ["left", "right", "bottom", "float"]) {
        const got = mixPanelLayoutOf({ dock, panelHtml: "<b/>" });
        ok(`C2.${dock} legacy dock still resolves`, got && got.w === MIX_DOCK_PRESETS[dock].w, JSON.stringify(got));
    }
    ok("C3 the float preset still starts collapsed", MIX_DOCK_PRESETS.float.collapsed === true);

    // Interface code with no placement means there IS an interface -- it lands on the neutral
    // default and moves itself from there
    const neutral = mixPanelLayoutOf({ panelHtml: "<div>hi</div>" });
    eq("C4 interface code alone yields the default", neutral.x, MIX_PANEL_DEFAULT_LAYOUT.x);
    eq("C5 the default draws no shell", neutral.chrome, "none");
    eq("C6 the default draws no plate", neutral.plate, false);

    // No interface code and no placement means no panel at all
    ok("C7 nothing at all yields no panel", mixPanelLayoutOf({}) === undefined);
    ok("C8 whitespace-only interface code yields no panel", mixPanelLayoutOf({ panelHtml: "   \n " }) === undefined);
    ok("C9 hooks without a panel yield no panel", mixPanelLayoutOf({ script: "function onBeforeSend(){}" }) === undefined);

    // A layout that fails the shape check falls through to the dock rather than throwing
    eq("C10 a broken layout falls back to the dock", mixPanelLayoutOf({ layout: "junk", dock: "bottom", panelHtml: "<b/>" }).w,
        MIX_DOCK_PRESETS.bottom.w);
}

// ── D. the session override the player drags ───────────────────────────────────
{
    // mixology-game merges as { ...base, ...moved }: the dragged box wins on the four
    // geometry keys and every switch the material declared survives
    const base = mixPanelLayoutOf({ panelHtml: "<b/>", layout: { x: 5, y: 5, w: 40, h: 30, chrome: "none", plate: false, resize: true } });
    const moved = { x: 60, y: 70, w: 25, h: 20 };
    const merged = { ...base, ...moved };
    eq("D1 dragged x wins", merged.x, 60);
    eq("D2 dragged size wins", merged.w, 25);
    eq("D3 the material's chrome survives a drag", merged.chrome, "none");
    eq("D4 the material's plate survives a drag", merged.plate, false);
    eq("D5 the material's resize survives a drag", merged.resize, true);
}

// ── E. publish-time validation ─────────────────────────────────────────────────
{
    const panel = { panelHtml: "<div>x</div>" };
    ok("E1 a panel with neither dock nor layout is rejected",
        typeof validateMechanismPayload(panel) === "string" && validateMechanismPayload(panel) !== null);
    eq("E2 a panel with a layout is accepted",
        validateMechanismPayload({ ...panel, layout: { x: 1, y: 2, w: 3, h: 4 } }), null);
    eq("E3 a panel with a legacy dock is still accepted",
        validateMechanismPayload({ ...panel, dock: "left" }), null);
    eq("E4 an invented dock is rejected",
        validateMechanismPayload({ ...panel, dock: "ceiling" }), "invalid_dock");
    eq("E5 a non-placement layout is rejected",
        validateMechanismPayload({ ...panel, layout: { nope: 1 } }), "invalid_layout");
    eq("E6 an array layout is rejected",
        validateMechanismPayload({ ...panel, layout: [1, 2, 3, 4] }), "invalid_layout");
    eq("E7 a non-numeric coordinate is rejected",
        validateMechanismPayload({ ...panel, layout: { x: "a", y: 2, w: 3, h: 4 } }), "invalid_layout");
    eq("E8 an invented chrome is rejected",
        validateMechanismPayload({ ...panel, layout: { x: 1, y: 2, w: 3, h: 4, chrome: "evil" } }), "invalid_layout");

    // Shape only: the validator deliberately does NOT clamp, because the downloader clamps
    // again on arrival. Rejecting here would block a legitimate half-off-screen panel.
    eq("E9 out-of-range numbers pass validation (clamped downstream)",
        validateMechanismPayload({ ...panel, layout: { x: -9999, y: 9999, w: 400, h: -3 } }), null);

    // and the downloader really does clamp what the validator let through
    const arrived = normalizeMixPanelLayout({ x: -9999, y: 9999, w: 400, h: -3 });
    ok("E10 what validation passed is clamped on arrival",
        arrived.w <= 100 && arrived.h >= MIX_PANEL_MIN_H && arrived.y <= 100 - MIX_PANEL_KEEP_IN,
        JSON.stringify(arrived));

    ok("E11 a mechanism with only hooks needs no placement",
        validateMechanismPayload({ script: "function onBeforeSend(){}" }) === null);
    ok("E12 an empty mechanism is still rejected", typeof validateMechanismPayload({}) === "string");
}

// ── F. the legacy-dock conversion written alongside on publish ─────────────────
{
    eq("F1 a wide panel maps to bottom", mixNearestDock({ x: 3, y: 58, w: 94, h: 34 }), "bottom");
    eq("F2 a small low panel maps to float", mixNearestDock({ x: 55, y: 66, w: 45, h: 26 }), "float");
    eq("F3 a left-of-centre panel maps to left", mixNearestDock({ x: 2, y: 12, w: 38, h: 52 }), "left");
    eq("F4 a right-of-centre panel maps to right", mixNearestDock({ x: 60, y: 12, w: 38, h: 52 }), "right");
    // every preset must survive a round trip, or an older client would place them wrongly
    for (const dock of ["left", "right", "bottom", "float"]) {
        eq(`F5.${dock} preset round-trips`, mixNearestDock(MIX_DOCK_PRESETS[dock]), dock);
    }
}

// ── G. source-level rules the port has to keep ─────────────────────────────────
{
    const panelSrc = fs.readFileSync(path.join(root, "components/mixology/mechanism-panel.tsx"), "utf8");
    const cssSrc = fs.readFileSync(path.join(root, "styles/mixology.css"), "utf8");
    const gameSrc = fs.readFileSync(path.join(root, "components/mixology/mixology-game.tsx"), "utf8");

    // The whitelist is the security surface. Every action the bridge offers must have a case
    // handling it, and nothing may be handled that is not offered.
    const offered = [...panelSrc.matchAll(/send\("([a-zA-Z]+)"/g)].map((m) => m[1]);
    const handled = [...panelSrc.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]);
    const uniq = (a) => [...new Set(a)].sort();
    ok("G1 every offered action is handled",
        uniq(offered).every((a) => handled.includes(a)), `offered ${uniq(offered)} handled ${uniq(handled)}`);
    ok("G2 nothing is handled that is not offered",
        uniq(handled).every((a) => offered.includes(a)), `handled ${uniq(handled)} offered ${uniq(offered)}`);
    ok("G3 the whitelist is exactly the ten known actions",
        uniq(handled).join(",") === "box,design,dragEnd,drag,fit,flag,grab,say,setOpen,setState,setStore"
            .split(",").sort().join(","), uniq(handled).join(","));

    // The sandbox must not have been loosened while rearranging geometry.
    // Read the DIRECTIVE, not the file: the comment above it contains the words "connect-src"
    // and a whole-file match therefore passes on the prose rather than the policy.
    const csp = (panelSrc.match(/Content-Security-Policy" content="([^"]+)"/) ?? [])[1] ?? "";
    ok("G4a a CSP is present at all", csp.length > 20, JSON.stringify(csp));
    ok("G4b no connect-src in the CSP directive", !/connect-src/.test(csp), csp);
    ok("G5 default-src stays none", /default-src 'none'/.test(csp));
    ok("G6 the iframe stays scripts-only", /sandbox="allow-scripts"/.test(panelSrc) && !/allow-same-origin/.test(panelSrc));

    // The runaway-height breaker, and the ceiling on it
    ok("G7 fit is capped", /Math\.min\(4000,/.test(panelSrc));
    // The say ceiling survives
    ok("G8 say is length-capped", /MAX_SAY_LENGTH/.test(panelSrc) && /2_000/.test(panelSrc));

    // The escape hatch is the answer to "a panel covered the whole screen"
    ok("G9 panels can be hidden in-session", /panelsHidden/.test(gameSrc));
    ok("G10 dragged positions can be reset", /resetPanelBoxes/.test(gameSrc));
    ok("G11 a dragged box is stored on the session, not the material",
        /panelBox/.test(gameSrc) && !/saveMixMaterial/.test(gameSrc));

    // The docked layout is gone on both sides, or the CSS would fight the inline styles
    ok("G12 no data-dock rules remain in CSS", !/data-dock=/.test(cssSrc));
    ok("G13 the panel no longer takes a dock prop", !/dock:\s*MixDock/.test(panelSrc));

    // Dragging must disable the transition, or the panel trails the pointer
    ok("G14 the transition is off while dragging", /\[data-grabbing\][\s\S]{0,120}transition:\s*none/.test(cssSrc));

    // Every class the component renders has to exist
    for (const cls of ["mix-panel-bar", "mix-panel-fold", "mix-panel-stage", "mix-panel-grip", "mix-panel-catch"]) {
        ok(`G15.${cls} styled`, cssSrc.includes(`.${cls}`));
    }

    // No control characters -- the U+0001 incident
    for (const [name, src] of [["panel", panelSrc], ["css", cssSrc], ["game", gameSrc]]) {
        ok(`G16.${name} no control characters`,
            ![...src].some((c) => { const n = c.charCodeAt(0); return (n < 9 || (n > 13 && n < 32) || n === 127); }));
    }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
