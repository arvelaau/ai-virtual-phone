// Desktop Folders (ported from momo.float.phone, full scope per user decision 2026-09-xx):
// drag one icon onto another to group them into a folder tile. This fixture drives the real
// storage layer -- lib/desktop-config.ts's FolderIconId helpers and lib/desktop-layout-storage.ts's
// normalizeDesktopFolders/loadDesktopFolders/writeDesktopFolders/normalizeDesktopIconLayout's
// folderIds exemption/appendMissingCustomAppIcons -- not the drag/collision UI in
// components/desktop-shell.tsx, which was instead verified live in the browser (merge-drag
// folder creation, opening/renaming the panel, dragging a member out with auto-dissolve, and a
// cancelled drop's clean restore, cross-checked against the ground-truth IndexedDB record).
//
//   node _fx-momo-desktop-folders.mjs

import path from "node:path";
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

const config = await jiti.import("./lib/desktop-config.ts");
const storage = await jiti.import("./lib/desktop-layout-storage.ts");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; failures.push({ name, extra }); console.log("FAIL", name, extra ?? ""); }
}

// ── A. FolderIconId helpers (desktop-config.ts) ──
{
    const id1 = config.createFolderIconId();
    const id2 = config.createFolderIconId();
    check("A1 createFolderIconId produces a folder: prefixed id", id1.startsWith("folder:"));
    check("A2 createFolderIconId ids are unique across calls", id1 !== id2);
    check("A3 isFolderIconId true for a real folder id", config.isFolderIconId(id1) === true);
    check("A4 isFolderIconId false for an ordinary icon id", config.isFolderIconId("chat") === false);
    check("A5 isFolderIconId false for an empty string", config.isFolderIconId("") === false);
}

// ── B. normalizeDesktopFolders: validation, dedup, trimming, junk-filtering ──
{
    const clean = storage.normalizeDesktopFolders({
        "folder:abc": { name: "Utilities", icons: ["chat", "diary"] },
    });
    check("B1 a well-formed folder round-trips with both members",
        clean["folder:abc"]?.icons.join(",") === "chat,diary");
    check("B2 name is preserved verbatim when valid", clean["folder:abc"]?.name === "Utilities");

    const notObject = storage.normalizeDesktopFolders("not an object");
    check("B3 a non-object input returns {}", Object.keys(notObject).length === 0);
    const arrayInput = storage.normalizeDesktopFolders(["folder:x"]);
    check("B4 an array input returns {} (Array.isArray guard)", Object.keys(arrayInput).length === 0);

    const badKey = storage.normalizeDesktopFolders({ "not-a-folder-id": { name: "X", icons: ["chat"] } });
    check("B5 a key not prefixed folder: is dropped entirely", Object.keys(badKey).length === 0);

    const nonArrayIcons = storage.normalizeDesktopFolders({ "folder:y": { name: "Y", icons: "chat" } });
    check("B6 icons must be an array -- a string value drops the whole entry", Object.keys(nonArrayIcons).length === 0);

    const nestedFolder = storage.normalizeDesktopFolders({
        "folder:z": { name: "Z", icons: ["chat", "folder:inner"] },
    });
    check("B7 a folder cannot contain another folder as a member (nesting forbidden)",
        nestedFolder["folder:z"]?.icons.join(",") === "chat");

    const unknownIcon = storage.normalizeDesktopFolders({
        "folder:w": { name: "W", icons: ["chat", "totally_made_up_icon_id"] },
    });
    check("B8 an unknown/uninstalled icon id is dropped from the member list",
        unknownIcon["folder:w"]?.icons.join(",") === "chat");

    const dupe = storage.normalizeDesktopFolders({
        "folder:v": { name: "V", icons: ["chat", "chat", "diary"] },
    });
    check("B9 duplicate ids within one folder's member list are deduped",
        dupe["folder:v"]?.icons.join(",") === "chat,diary");

    const crossFolderDupe = storage.normalizeDesktopFolders({
        "folder:a1": { name: "A1", icons: ["chat"] },
        "folder:a2": { name: "A2", icons: ["chat", "diary"] },
    });
    const totalChatCount = Object.values(crossFolderDupe).flatMap(f => f.icons).filter(id => id === "chat").length;
    check("B10 the same icon id cannot sit in two folders at once (first writer wins)", totalChatCount === 1);

    const emptyName = storage.normalizeDesktopFolders({ "folder:noname": { name: "", icons: ["chat", "diary"] } });
    check("B11 an empty name falls back to the default 'Folder'", emptyName["folder:noname"]?.name === "Folder");
    const missingName = storage.normalizeDesktopFolders({ "folder:noname2": { icons: ["chat", "diary"] } });
    check("B12 a missing name field also falls back to 'Folder'", missingName["folder:noname2"]?.name === "Folder");

    const longName = storage.normalizeDesktopFolders({
        "folder:long": { name: "X".repeat(60), icons: ["chat", "diary"] },
    });
    check("B13 a name longer than 24 chars is trimmed to 24", longName["folder:long"]?.name.length === 24);

    const whitespaceName = storage.normalizeDesktopFolders({
        "folder:ws": { name: "   Spaced Out   ", icons: ["chat", "diary"] },
    });
    check("B14 a whitespace-padded name is trimmed", whitespaceName["folder:ws"]?.name === "Spaced Out");
}

// ── C. loadDesktopFolders / writeDesktopFolders round-trip + fail-closed on corrupt JSON ──
{
    storage.writeDesktopFolders({});
    check("C1 nothing stored yet -> loadDesktopFolders reads back {} after an explicit clear",
        Object.keys(storage.loadDesktopFolders()).length === 0);

    const folders = { "folder:rt": { name: "Round Trip", icons: ["chat", "diary"] } };
    storage.writeDesktopFolders(folders);
    const reloaded = storage.loadDesktopFolders();
    check("C2 a written folder table round-trips through kvSet/kvGet",
        reloaded["folder:rt"]?.name === "Round Trip" && reloaded["folder:rt"]?.icons.join(",") === "chat,diary");

    // Corrupt the underlying storage directly (bypassing writeDesktopFolders) to simulate a
    // damaged/partial write, and confirm the reader fails closed instead of throwing.
    const kv = await jiti.import("./lib/kv-db.ts");
    kv.kvSet(storage.DESKTOP_FOLDERS_STORAGE_KEY, "{not valid json");
    let threw = false;
    let corruptResult = null;
    try { corruptResult = storage.loadDesktopFolders(); } catch { threw = true; }
    check("C3 corrupt JSON in storage does not throw", threw === false);
    check("C4 corrupt JSON in storage fails closed to {} rather than returning garbage",
        corruptResult !== null && Object.keys(corruptResult).length === 0);
}

// ── D. normalizeDesktopIconLayout: the folderIds exemption logic ──
{
    const rawLayout = {
        page1: [
            { id: "folder:present", row: 1, col: 1 },
            { id: "folder:absent", row: 1, col: 2 },
            { id: "chat", row: 2, col: 1 },
        ],
    };

    const withFolderIds = storage.normalizeDesktopIconLayout(rawLayout, new Set(["folder:present"]));
    const idsWith = withFolderIds.page1.map(ic => ic.id);
    check("D1 a folder tile present in the supplied folderIds set is kept",
        idsWith.includes("folder:present"));
    check("D2 a folder tile NOT in the supplied folderIds set is dropped as a ghost",
        !idsWith.includes("folder:absent"));
    check("D3 an ordinary icon in the same page is unaffected by the folderIds filter",
        idsWith.includes("chat"));

    const withNoFolderIds = storage.normalizeDesktopIconLayout(rawLayout);
    const idsWithout = withNoFolderIds.page1.map(ic => ic.id);
    check("D4 calling with no folderIds argument at all drops every folder tile (both ghost and real)",
        !idsWithout.includes("folder:present") && !idsWithout.includes("folder:absent"));
    check("D5 ...but still keeps the ordinary icon", idsWithout.includes("chat"));

    const withEmptySet = storage.normalizeDesktopIconLayout(rawLayout, new Set());
    const idsEmpty = withEmptySet.page1.map(ic => ic.id);
    check("D6 an explicit-but-empty folderIds set behaves the same as omitting it",
        !idsEmpty.includes("folder:present") && !idsEmpty.includes("folder:absent"));
}

// ── E. appendMissingCustomAppIcons: no-op when nothing is missing ──
{
    const layout = { page1: [{ id: "chat", row: 1, col: 1 }], page2: [] };
    const result = storage.appendMissingCustomAppIcons(layout, [], []);
    // No custom apps are installed in this fixture environment (loadInstalledCustomApps
    // reads from localStorage, which is empty here), so the missing-set is empty and the
    // function must return the layout unchanged (same reference, per its own early return).
    check("E1 with nothing missing, the layout is returned as-is (identity, not a rebuild)",
        result === layout);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
