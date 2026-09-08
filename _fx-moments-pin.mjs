// Verifies "Pin to Moments" (Phase E): a card from chat/story/offline can be pinned directly
// into an installed app's own data collection, gated on a new manifest capability flag
// (extensions.moments.acceptsPinnedCards). Drives the REAL host functions via jiti.
//   node _fx-moments-pin.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });

const { kvSet } = jiti(path.join(root, "lib/kv-db.ts"));
const { saveInstalledCustomApps, loadInstalledCustomApps, readCustomAppCollection, normalizeCustomAppManifest } =
    jiti(path.join(root, "lib/custom-app-storage.ts"));
const { findMomentsPinTargetApp, findMomentsPinTargetApps, hasMomentsPinTarget, pinAppCardToMoments, MOMENTS_PIN_COLLECTION } =
    jiti(path.join(root, "lib/custom-app-moments-pin.ts"));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), { got: g, want: w });

function clearApps() {
    kvSet("ai_phone_custom_apps_v1", JSON.stringify([]));
}

function seedApp(id, name, acceptsPinnedCards) {
    const manifestRaw = {
        id, name, version: "1.0.0", entry: "index.html",
        permissions: ["app.data.read", "app.data.write"],
        extensions: acceptsPinnedCards === undefined ? undefined : { moments: { acceptsPinnedCards } },
    };
    const app = {
        id, name, version: "1.0.0", entryHtml: "<html><body>test</body></html>",
        permissions: ["app.data.read", "app.data.write"],
        manifest: manifestRaw,
        assets: {}, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    return app;
}

// ── A. the normalizer round-trip -- the single highest-risk assumption in this design.
//      normalizeCustomAppManifest REBUILDS `extensions` from known sub-blocks (chat/ui/prompt/
//      tools/events); an unrecognized `extensions.moments` would previously have been silently
//      dropped. This is what proves the fix, not just that the new helper functions "work". ──
{
    const normalized = normalizeCustomAppManifest({
        id: "test.pintarget", name: "Pin Target", version: "1.0.0",
        extensions: { moments: { acceptsPinnedCards: true } },
    });
    ok("A1 normalizeCustomAppManifest preserves extensions.moments", normalized.extensions?.moments?.acceptsPinnedCards === true, normalized.extensions);

    const normalizedFalse = normalizeCustomAppManifest({
        id: "test.notarget", name: "Not A Target", version: "1.0.0",
        extensions: { moments: { acceptsPinnedCards: false } },
    });
    eq("A2 acceptsPinnedCards:false does not produce a moments block", normalizedFalse.extensions?.moments, undefined);

    const normalizedNone = normalizeCustomAppManifest({ id: "test.plain", name: "Plain", version: "1.0.0" });
    eq("A3 no extensions at all -> extensions is undefined, not a crash", normalizedNone.extensions, undefined);
}

// ── B. findMomentsPinTargetApp(s) / hasMomentsPinTarget ──────────────────────
{
    clearApps();
    eq("B1 no installed apps -> no target", findMomentsPinTargetApp(), null);
    eq("B2 hasMomentsPinTarget is false with nothing installed", hasMomentsPinTarget(), false);

    saveInstalledCustomApps([seedApp("test.notarget", "Not A Target", false), seedApp("test.plain", "Plain", undefined)], false);
    eq("B3 apps installed but none accept pins -> no target", findMomentsPinTargetApp(), null);

    saveInstalledCustomApps([
        seedApp("test.notarget", "Not A Target", false),
        seedApp("test.withu", "WithU", true),
        seedApp("test.plain", "Plain", undefined),
    ], false);
    const target = findMomentsPinTargetApp();
    ok("B4 the one app declaring acceptsPinnedCards is found", target?.id === "test.withu", target);
    eq("B5 hasMomentsPinTarget is true now", hasMomentsPinTarget(), true);

    saveInstalledCustomApps([
        seedApp("test.withu", "WithU", true),
        seedApp("test.second", "Second Target", true),
    ], false);
    const targets = findMomentsPinTargetApps();
    eq("B6 multiple targets are all found by findMomentsPinTargetApps", targets.map(a => a.id), ["test.withu", "test.second"]);
    // Deliberate simplification, not a resolved multi-target design (documented in the module):
    // first installed wins. Pin still succeeds -- it never silently no-ops with 2 valid targets.
    eq("B7 findMomentsPinTargetApp (singular) picks the first when more than one qualifies", findMomentsPinTargetApp()?.id, "test.withu");
}

// ── C. pinAppCardToMoments -- the actual write, and reading it back the way the target app would ──
{
    clearApps();
    saveInstalledCustomApps([seedApp("test.withu", "WithU", true)], false);
    kvSet("ai_phone_custom_app_data_v1:test.withu:moments", JSON.stringify([]));

    const layout = { title: "Boarding Pass", html: "<div>ATH-JTR</div>", height: 220, accentColor: "#ff8fb3" };
    const result = pinAppCardToMoments({
        characterId: "char1", characterName: "Luna", sourceMode: "chat",
        summary: "She handed over the tickets at the gate.",
        appCardLayout: layout,
        cardAppId: "test.travelapp", cardAppName: "Travel Companion",
        messageId: "msg1", sessionId: "sess1",
    });
    ok("C1 pin succeeds against a real target", result.ok, result);
    eq("C2 result names the target app", result.targetAppId, "test.withu");

    // Read it back EXACTLY the way the target app's own AI.db.list('moments', …) would --
    // through readCustomAppCollection, the same function db.list's handler calls.
    const rows = readCustomAppCollection("test.withu", MOMENTS_PIN_COLLECTION);
    eq("C3 exactly one row was written", rows.length, 1);
    const row = rows[0] ?? {};
    eq("C4 characterId carried through", row.characterId, "char1");
    eq("C5 sourceMode carried through", row.sourceMode, "chat");
    eq("C6 summary carried through", row.summary, "She handed over the tickets at the gate.");
    ok("C7 appCardLayout.html survived intact", row.appCardLayout?.html === "<div>ATH-JTR</div>", row.appCardLayout);
    eq("C8 appCardLayout.title survived intact", row.appCardLayout?.title, "Boarding Pass");
    ok("C9 a row id was generated", typeof row.id === "string" && row.id.startsWith("pin_"), row.id);
    ok("C10 pinnedAt is a real ISO timestamp", !Number.isNaN(new Date(row.pinnedAt ?? "").getTime()), row.pinnedAt);

    // Pin a second card -- must not clobber the first (writeCustomAppCollection replaces the
    // WHOLE array, so this proves pinAppCardToMoments reads-then-prepends rather than
    // overwriting with just the new row).
    pinAppCardToMoments({
        characterId: "char1", characterName: "Luna", sourceMode: "story",
        summary: "A second moment.", appCardLayout: { title: "Second", html: "<p>2</p>" },
    });
    const rows2 = readCustomAppCollection("test.withu", MOMENTS_PIN_COLLECTION);
    eq("C11 both rows survive after a second pin", rows2.length, 2);
    eq("C12 the newest pin is first (prepended, not appended)", rows2[0].summary, "A second moment.");
}

// ── D. failure paths -- must not crash, must not write garbage ──────────────
{
    clearApps();
    const noTarget = pinAppCardToMoments({ characterId: "char1", characterName: "Luna", sourceMode: "chat", summary: "x", appCardLayout: { html: "<p>x</p>" } });
    eq("D1 no target installed -> ok:false, not a throw", noTarget.ok, false);

    // Fresh app id, not "test.withu" -- group C already wrote rows under that id, and
    // clearApps() only clears the installed-APPS list, not each app's own data collections.
    saveInstalledCustomApps([seedApp("test.failpaths", "Fail Paths Target", true)], false);
    const before = readCustomAppCollection("test.failpaths", MOMENTS_PIN_COLLECTION).length;

    const noChar = pinAppCardToMoments({ characterId: "", characterName: "", sourceMode: "chat", summary: "x", appCardLayout: { html: "<p>x</p>" } });
    eq("D2 empty characterId -> ok:false", noChar.ok, false);

    const noLayout = pinAppCardToMoments({ characterId: "char1", characterName: "Luna", sourceMode: "chat", summary: "x", appCardLayout: null });
    eq("D3 null appCardLayout -> ok:false", noLayout.ok, false);

    // D1-D3 must not have written anything despite being called against a real target for D2/D3
    const rows = readCustomAppCollection("test.failpaths", MOMENTS_PIN_COLLECTION);
    eq("D4 none of the failure paths wrote a row", rows.length, before);
}

// ── E. cleanText hygiene -- the standing "does a multi-word English string survive" rule ──
{
    clearApps();
    saveInstalledCustomApps([seedApp("test.withu", "WithU", true)], false);
    const result = pinAppCardToMoments({
        characterId: "char1", characterName: "Blue Ceramic Person", sourceMode: "offline",
        summary: "A long summer evening on the balcony.", appCardLayout: { html: "<p>x</p>" },
    });
    ok("E1 pin with multi-word characterName succeeds", result.ok, result);
    const row = readCustomAppCollection("test.withu", MOMENTS_PIN_COLLECTION)[0];
    eq("E2 multi-word characterName survives unmangled", row.characterName, "Blue Ceramic Person");
    eq("E3 multi-word summary survives unmangled", row.summary, "A long summer evening on the balcony.");
}

clearApps();

const EXPECTED = 29;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
