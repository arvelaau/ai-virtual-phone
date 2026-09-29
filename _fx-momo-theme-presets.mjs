// Theme Presets (ported from momo.float.phone, momo/codex/theme-presets @ dd174c6): save,
// switch to, and delete a local snapshot of theme color + wallpaper + icons + desktop layout
// + widgets + dock + folders. Drives the real lib/theme-preset-storage.ts (aliasing `dexie` to
// the shared in-memory stub so kv-db.ts's kvGet/kvSet are the real functions), plus a
// behavioral check that lib/theme-storage.ts's deleteThemeAsset consults
// themePresetUsesAsset() BEFORE ever touching IndexedDB.
//
//   node _fx-momo-theme-presets.mjs

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

const presetStorage = await jiti.import("./lib/theme-preset-storage.ts");
const themeTypes = await jiti.import("./lib/theme-types.ts");
const desktopStorage = await jiti.import("./lib/desktop-layout-storage.ts");
const desktopConfig = await jiti.import("./lib/desktop-config.ts");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; failures.push({ name, extra }); console.log("FAIL", name, extra ?? ""); }
}

function freshThemeProfile(overrides = {}) {
    return themeTypes.normalizeThemeProfile({ ...themeTypes.DEFAULT_THEME_PROFILE, ...overrides });
}

function emptyLayout() {
    return { page1: [], page2: [] };
}

// ── A. Default profile name is translated (feeds openThemePresets' pre-fill skip) ──
{
    check("A1 DEFAULT_THEME_PROFILE.name is English, not the legacy Chinese literal",
        themeTypes.DEFAULT_THEME_PROFILE.name === "Default Theme");
    check("A2 createDefaultIconScheme().name is English too (found alongside A1, same class of miss)",
        themeTypes.createDefaultIconScheme().name === "Default Icon Scheme");
}

// ── B. saveThemePreset / readThemePresets / deleteThemePreset round trip ──
{
    presetStorage.deleteThemePreset("nonexistent"); // no-op, must not throw on an empty store
    check("B1 starting from an empty store", presetStorage.readThemePresets().length === 0);

    const saved = presetStorage.saveThemePreset("My Look", {
        themeProfile: freshThemeProfile({ wallpaperAssetId: "wp_1" }),
        iconLayout: emptyLayout(),
        widgets: [],
    });
    check("B2 saveThemePreset returns the normalized preset", saved.name === "My Look" && saved.id.startsWith("theme_preset_"));
    check("B3 it round-trips through readThemePresets", presetStorage.readThemePresets().some(p => p.id === saved.id));

    const reloaded = presetStorage.readThemePresets().find(p => p.id === saved.id);
    check("B4 the theme profile's own name is overwritten to match the preset name",
        reloaded.themeProfile.name === "My Look");
    check("B5 the wallpaper library is trimmed to just the one selected wallpaper (not inherited from the live draft)",
        reloaded.themeProfile.wallpaperLibrary.length === 1 && reloaded.themeProfile.wallpaperLibrary[0] === "wp_1");

    presetStorage.deleteThemePreset(saved.id);
    check("B6 deleteThemePreset removes it", presetStorage.readThemePresets().length === 0);
}

// ── C. Saving under an existing name (case-insensitive) updates in place, not a duplicate ──
{
    const first = presetStorage.saveThemePreset("Night Mode", {
        themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [],
    });
    const second = presetStorage.saveThemePreset("NIGHT MODE", {
        themeProfile: freshThemeProfile({ wallpaperAssetId: "wp_2" }), iconLayout: emptyLayout(), widgets: [],
    });
    check("C1 same id reused on a case-insensitive name match", first.id === second.id);
    check("C2 exactly one preset exists, not two", presetStorage.readThemePresets().length === 1);
    check("C3 the stored content was updated (new wallpaper)", presetStorage.readThemePresets()[0].themeProfile.wallpaperAssetId === "wp_2");
    presetStorage.deleteThemePreset(first.id);
}

// ── D. Name validation ──
{
    let threw = false;
    try { presetStorage.saveThemePreset("   ", { themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [] }); }
    catch { threw = true; }
    check("D1 an empty/whitespace-only name throws rather than saving", threw);
    check("D2 ...and nothing was saved", presetStorage.readThemePresets().length === 0);

    const long = presetStorage.saveThemePreset("X".repeat(60), { themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [] });
    check("D3 a name longer than 24 chars is trimmed to 24", long.name.length === 24);
    presetStorage.deleteThemePreset(long.id);
}

// ── E. THEME_PRESET_LIMIT enforcement ──
{
    for (let i = 0; i < presetStorage.THEME_PRESET_LIMIT; i++) {
        presetStorage.saveThemePreset(`Preset ${i}`, { themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [] });
    }
    check("E1 exactly THEME_PRESET_LIMIT presets saved", presetStorage.readThemePresets().length === presetStorage.THEME_PRESET_LIMIT);

    let threwAtLimit = false;
    try { presetStorage.saveThemePreset("One Too Many", { themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [] }); }
    catch { threwAtLimit = true; }
    check("E2 saving a NEW-named preset past the limit throws", threwAtLimit);
    check("E3 ...and the count did not grow", presetStorage.readThemePresets().length === presetStorage.THEME_PRESET_LIMIT);

    // Updating an EXISTING preset at the limit must still be allowed (not a new slot).
    let updateThrew = false;
    try { presetStorage.saveThemePreset("Preset 0", { themeProfile: freshThemeProfile({ wallpaperAssetId: "wp_updated" }), iconLayout: emptyLayout(), widgets: [] }); }
    catch { updateThrew = true; }
    check("E4 updating an existing preset at the limit does NOT throw", !updateThrew);

    for (const p of presetStorage.readThemePresets()) presetStorage.deleteThemePreset(p.id);
    check("E5 cleaned up back to empty", presetStorage.readThemePresets().length === 0);
}

// ── F. normalizePresetWidgets, via a save/read round trip ──
{
    const validWidget = { id: "w1", type: "clock", size: "1x1", page: 1, row: 1, col: 1 };
    const missingField = { id: "w2", type: "clock", size: "1x1", page: 1, row: 1 }; // no col
    const badSize = { id: "w3", type: "clock", size: "not-a-real-size", page: 1, row: 1, col: 1 };
    const outOfBounds = { id: "w4", type: "clock", size: "1x1", page: 1, row: 999, col: 1 };
    const notObject = "just a string";

    const saved = presetStorage.saveThemePreset("Widget Test", {
        themeProfile: freshThemeProfile(),
        iconLayout: emptyLayout(),
        widgets: [validWidget, missingField, badSize, outOfBounds, notObject],
    });
    check("F1 only the one well-formed widget survives", saved.widgets.length === 1 && saved.widgets[0].id === "w1");

    const withConfig = presetStorage.saveThemePreset("Widget Test 2", {
        themeProfile: freshThemeProfile(),
        iconLayout: emptyLayout(),
        widgets: [{ ...validWidget, id: "w5", config: { label: "hi" } }],
    });
    check("F2 a widget's config object is preserved", withConfig.widgets[0].config?.label === "hi");

    presetStorage.deleteThemePreset(saved.id);
    presetStorage.deleteThemePreset(withConfig.id);
}

// ── G. Folders + iconLayout round-trip through a preset (the Desktop Folders integration) ──
{
    const folderId = desktopConfig.createFolderIconId();
    const folders = { [folderId]: { name: "Bundle", icons: ["chat", "diary"] } };
    const layout = { page1: [{ id: folderId, row: 1, col: 1 }], page2: [] };

    const saved = presetStorage.saveThemePreset("With Folder", {
        themeProfile: freshThemeProfile(),
        iconLayout: layout,
        widgets: [],
    });
    // saveThemePreset itself reads the folder table from storage (loadDesktopFolders), not
    // from the snapshot argument -- write it there first via the real storage function, then
    // re-save so the preset captures it.
    desktopStorage.writeDesktopFolders(folders);
    const savedWithFolder = presetStorage.saveThemePreset("With Folder", {
        themeProfile: freshThemeProfile(),
        iconLayout: layout,
        widgets: [],
    });
    check("G1 the folder table is captured from live storage at save time",
        Object.keys(savedWithFolder.folders).includes(folderId));
    check("G2 the folder tile survives layout normalization (folderIds exemption applied)",
        savedWithFolder.iconLayout.page1.some(ic => ic.id === folderId));
    check("G3 the folder's own member list is intact", savedWithFolder.folders[folderId].icons.join(",") === "chat,diary");

    presetStorage.deleteThemePreset(saved.id);
    presetStorage.deleteThemePreset(savedWithFolder.id);
    desktopStorage.writeDesktopFolders({});
}

// ── H. Sort order: most-recently-updated first ──
{
    const older = presetStorage.saveThemePreset("Older", { themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [] });
    await new Promise(r => setTimeout(r, 5));
    const newer = presetStorage.saveThemePreset("Newer", { themeProfile: freshThemeProfile(), iconLayout: emptyLayout(), widgets: [] });
    const list = presetStorage.readThemePresets();
    check("H1 the most recently saved preset sorts first", list[0]?.id === newer.id);
    presetStorage.deleteThemePreset(older.id);
    presetStorage.deleteThemePreset(newer.id);
}

// ── I. themePresetUsesAsset: every field it is documented to check ──
{
    const cases = [
        ["wallpaperAssetId", freshThemeProfile({ wallpaperAssetId: "asset_wp" })],
        ["fontAssetId", freshThemeProfile({ fontAssetId: "asset_font" })],
        ["dockSkinAssetId", freshThemeProfile({ dockSkinAssetId: "asset_dock" })],
    ];
    for (const [label, profile] of cases) {
        const assetId = profile[label];
        const saved = presetStorage.saveThemePreset(`Uses ${label}`, { themeProfile: profile, iconLayout: emptyLayout(), widgets: [] });
        check(`I-${label} themePresetUsesAsset finds an asset referenced via ${label}`,
            presetStorage.themePresetUsesAsset(assetId) === true);
        presetStorage.deleteThemePreset(saved.id);
        check(`I-${label}-after-delete no longer finds it once the preset is deleted`,
            presetStorage.themePresetUsesAsset(assetId) === false);
    }

    // iconSchemes is the real storage shape (normalizeThemeProfile derives the legacy
    // top-level `iconSkins` field FROM the active scheme, not the other way around, so the
    // override has to go through a real scheme object, not a bare iconSkins map).
    const scheme = themeTypes.createDefaultIconScheme();
    const withIconSkin = freshThemeProfile({
        iconSchemes: [{ ...scheme, iconSkins: { chat: "asset_icon_skin" } }],
        activeIconSchemeId: scheme.id,
    });
    check("I-setup the override actually reached the active scheme (sanity check on the fixture itself)",
        withIconSkin.iconSkins.chat === "asset_icon_skin");
    const savedSkin = presetStorage.saveThemePreset("Icon Skin", { themeProfile: withIconSkin, iconLayout: emptyLayout(), widgets: [] });
    check("I-iconSkins finds an asset referenced via a per-icon skin",
        presetStorage.themePresetUsesAsset("asset_icon_skin") === true);
    presetStorage.deleteThemePreset(savedSkin.id);

    check("I-unused returns false for an asset id nothing references", presetStorage.themePresetUsesAsset("totally_unused_asset") === false);
    check("I-empty returns false for an empty string id", presetStorage.themePresetUsesAsset("") === false);
}

// ── J. deleteThemeAsset (theme-storage.ts): the guard runs BEFORE any IndexedDB access ──
{
    let openCallCount = 0;
    globalThis.indexedDB = {
        open() {
            openCallCount++;
            const req = {};
            queueMicrotask(() => { if (req.onerror) req.onerror(); });
            Object.defineProperty(req, "error", { get: () => new Error("stub: no real IndexedDB in this fixture") });
            return req;
        },
    };

    const themeStorage = await jiti.import("./lib/theme-storage.ts");
    const profile = freshThemeProfile({ wallpaperAssetId: "guarded_asset" });
    const saved = presetStorage.saveThemePreset("Guard Test", { themeProfile: profile, iconLayout: emptyLayout(), widgets: [] });

    await themeStorage.deleteThemeAsset("guarded_asset");
    check("J1 deleting a preset-referenced asset never touches indexedDB.open at all", openCallCount === 0);

    await themeStorage.deleteThemeAsset("not_referenced_by_anything");
    check("J2 deleting an asset nothing references DOES proceed to indexedDB.open", openCallCount === 1);

    presetStorage.deleteThemePreset(saved.id);
    await themeStorage.deleteThemeAsset("guarded_asset");
    check("J3 once the referencing preset is gone, the same asset id is no longer guarded", openCallCount === 2);

    delete globalThis.indexedDB;
}

// ── K. Source-level check: the guard is a real early return, not decorative ──
{
    const src = fs.readFileSync(path.join(__dirname, "lib/theme-storage.ts"), "utf8");
    const start = src.indexOf("export async function deleteThemeAsset");
    check("K0 deleteThemeAsset located in source", start !== -1);
    const end = src.indexOf("\n}\n", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    const guardIdx = body.indexOf("themePresetUsesAsset(id)");
    const openIdx = body.indexOf("openThemeDb()");
    check("K1 the themePresetUsesAsset check appears in the function body", guardIdx !== -1);
    check("K2 ...and appears BEFORE the openThemeDb() call, not after", guardIdx !== -1 && openIdx !== -1 && guardIdx < openIdx);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
