// Backup fixes (ported from momo.float.phone: momo-reachable commit 2e2e01f/ebcae27,
// "KV layer: two data-loss-risk fixes" -- hydrateKvDb no longer fakes success on failure,
// and the local-export side no longer silently falls back to a possibly-incomplete cache;
// plus 610a411/1d777b5, "export side stops failing silently": per-module warnings surfaced
// in the export completion notice for a database that couldn't open or a critical module
// that exported 0 records). Both originated upstream and were merged into momo's own
// history; ported here as the final combined state rather than as separate historical
// steps, and extended to this fork's own buildSingleModulePayload streaming path, which
// momo doesn't have.
//
// This fixture drives the real lib/kv-db.ts (aliasing `dexie` to the shared in-memory
// stub) and lib/data-management/{idb,backup}.ts (against a small fake IndexedDB, since
// that module talks to raw IndexedDB directly, not Dexie).
//
//   node _fx-momo-backup-fixes.mjs

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

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; console.log("FAIL", name, extra ?? ""); }
}

// jiti caches a module's actual evaluation by resolved file path across EVERY
// createJiti() instance in this process (verified: re-importing the same path via a
// second jiti instance returns a different namespace wrapper but the identical
// function references inside) -- so lib/kv-db.ts's module-level hydration state
// (_hydrated/_hydratePromise/_hydrateError) is a process-wide singleton no matter
// how many jiti instances request it. Each test below that needs its OWN fresh
// hydration state copies kv-db.ts to a uniquely named file first, which jiti then
// necessarily treats as a distinct module.
const fs = await import("node:fs");
async function freshKvDbModule(dexieAliasPath) {
    const src = fs.readFileSync(path.join(__dirname, "lib/kv-db.ts"), "utf8");
    const tempPath = path.join(__dirname, `lib/_fx-temp-kv-db-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(tempPath, src);
    const freshJiti = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname, dexie: dexieAliasPath } });
    const mod = await freshJiti.import(tempPath);
    return { mod, cleanup: () => fs.unlinkSync(tempPath) };
}

const realDexiePath = path.join(__dirname, "_fx-dexie-stub.mjs");
const throwingDexiePath = path.join(__dirname, "_fx-throwing-dexie.mjs");
// entries is assigned INSIDE stores(), not the constructor: a subclass declaring
// `entries!: Dexie.Table<...>` as a class field runs its own (real ES class fields,
// not just a TS annotation) `this.entries = undefined` immediately after super()
// returns, which would silently clobber anything the base constructor set first.
// Real Dexie sidesteps this by having .stores() -- called from the SUBCLASS
// constructor body, after that zero-init already happened -- be what actually
// defines the table properties; this stub matches that same timing.
fs.writeFileSync(throwingDexiePath, [
    "export default class {",
    "  version() {",
    "    return {",
    "      stores: (schema) => {",
    "        for (const name of Object.keys(schema)) {",
    "          this[name] = {",
    "            async toArray() { throw new Error(\"simulated IndexedDB read failure\"); },",
    "            async count() { return 0; },",
    "          };",
    "        }",
    "        return { upgrade() { return this; } };",
    "      },",
    "    };",
    "  }",
    "  async open() { return this; }",
    "  close() {}",
    "  on() { return this; }",
    "}",
].join("\n"));

// ═══ Group A: lib/kv-db.ts hydration semantics ═══
{
    // A1/A2: a normal (successful) hydration sets isKvHydrated() true, no error.
    const { mod: kvDbMod, cleanup: cleanup1 } = await freshKvDbModule(realDexiePath);
    await kvDbMod.hydrateKvDb();
    check("A1 successful hydration sets isKvHydrated() true", kvDbMod.isKvHydrated() === true);
    check("A2 ...and getKvHydrationError() is null", kvDbMod.getKvHydrationError() == null);
    cleanup1();

    // A3/A4: force a real hydration failure via the throwing dexie stand-in, and
    // confirm the module does NOT fake success (the actual bug being fixed).
    const { mod: kvDbMod2, cleanup: cleanup2 } = await freshKvDbModule(throwingDexiePath);
    const resultA3 = await kvDbMod2.hydrateKvDb();
    check("A3 a failing hydration does not throw out of hydrateKvDb() itself", resultA3 === undefined);
    check("A4 ...and does NOT fake success: isKvHydrated() stays false", kvDbMod2.isKvHydrated() === false);
    check("A4b ...with the real error retrievable via getKvHydrationError()", kvDbMod2.getKvHydrationError()?.message === "simulated IndexedDB read failure");

    // A4c: after a failure, the next call is a genuine retry (a fresh promise), not
    // stuck replaying the same failed one forever.
    const retryPromise = kvDbMod2.hydrateKvDb();
    check("A4c a call after a failure starts a new attempt rather than reusing the dead one", retryPromise !== resultA3);
    await retryPromise;
    check("A4d the retry (against the same permanently-throwing store) fails again the same way, not silently", kvDbMod2.isKvHydrated() === false);
    cleanup2();

    // A5/A6: calling hydrateKvDb() twice concurrently (no await between them) returns
    // the identical in-flight promise -- dedup, not two independent hydration runs.
    const { mod: kvDbMod3, cleanup: cleanup3 } = await freshKvDbModule(realDexiePath);
    const p1 = kvDbMod3.hydrateKvDb();
    const p2 = kvDbMod3.hydrateKvDb();
    check("A5 concurrent hydrateKvDb() calls return the same in-flight promise", p1 === p2);
    await p1;
    check("A6 ...and it resolves to a hydrated state", kvDbMod3.isKvHydrated() === true);

    // A7: once hydrated, kvSet/kvGet round-trip through the real cache (sanity that
    // the refactor didn't disturb ordinary read/write).
    kvDbMod3.kvSet("test-key", "test-value");
    check("A7 kvSet/kvGet still round-trip after the hydration refactor", kvDbMod3.kvGet("test-key") === "test-value");
    cleanup3();
}

fs.unlinkSync(throwingDexiePath);

// ═══ A minimal fake IndexedDB for the data-management/idb.ts tests below ═══
class FakeIDBRequest {
    constructor() { this.onsuccess = null; this.onerror = null; this.onupgradeneeded = null; this.result = undefined; this.error = undefined; }
    _succeed(result) { this.result = result; queueMicrotask(() => this.onsuccess?.()); }
    _fail(error) { this.error = error; queueMicrotask(() => this.onerror?.()); }
}
class FakeObjectStore {
    constructor(map) { this._map = map; }
    getAll() {
        const req = new FakeIDBRequest();
        req._succeed([...this._map.values()]);
        return req;
    }
    openCursor() {
        const entries = [...this._map.entries()];
        const req = new FakeIDBRequest();
        let i = 0;
        const step = () => {
            if (i >= entries.length) { req.result = null; queueMicrotask(() => req.onsuccess?.()); return; }
            const [key, value] = entries[i];
            req.result = { primaryKey: key, value, continue: () => { i++; step(); } };
            queueMicrotask(() => req.onsuccess?.());
        };
        step();
        return req;
    }
    get indexNames() { return []; }
    get keyPath() { return null; }
    get autoIncrement() { return false; }
    get name() { return "entries"; }
}
class FakeTransaction {
    constructor(store) { this._store = store; this.oncomplete = null; this.onerror = null; this.onabort = null; queueMicrotask(() => this.oncomplete?.()); }
    objectStore() { return this._store; }
}
class FakeObjectStoreNames {
    constructor(names) { this._names = names; }
    contains(name) { return this._names.has(name); }
    [Symbol.iterator]() { return this._names[Symbol.iterator](); }
}
class FakeIDBDatabase {
    constructor() { this._stores = new Map(); this.objectStoreNames = new FakeObjectStoreNames(new Set()); }
    createObjectStore(name) {
        const map = new Map();
        this._stores.set(name, map);
        this.objectStoreNames._names.add(name);
        return new FakeObjectStore(map);
    }
    transaction(storeName) {
        const map = this._stores.get(storeName) ?? new Map();
        return new FakeTransaction(new FakeObjectStore(map));
    }
    close() {}
}
function makeFakeIndexedDb({ failOpen = false, seedEntries = null } = {}) {
    const db = new FakeIDBDatabase();
    if (seedEntries) {
        const store = db.createObjectStore("entries");
        for (const [k, v] of seedEntries) store._map.set(k, { key: k, value: v });
    }
    return {
        open() {
            const req = new FakeIDBRequest();
            if (failOpen) { req._fail(new Error("simulated open failure")); return req; }
            req.result = db;
            queueMicrotask(() => req._succeed(db));
            return req;
        },
        _db: db,
    };
}

// ═══ Group B: readKvRecords (via exportSource({type:"kv"})) ═══
{
    globalThis.indexedDB = makeFakeIndexedDb({ failOpen: true });
    const jiti4 = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
    const idbMod = await jiti4.import("./lib/data-management/idb.ts");

    let threwB1 = false;
    try { await idbMod.exportSource({ type: "kv", includeAll: true }); }
    catch { threwB1 = true; }
    check("B1 a KV export throws when the database can't be opened at all", threwB1);
    delete globalThis.indexedDB;
}
{
    globalThis.indexedDB = makeFakeIndexedDb({ seedEntries: [["a", "1"], ["b", "2"]] });
    const jiti5 = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
    const idbMod = await jiti5.import("./lib/data-management/idb.ts");

    const result = await idbMod.exportSource({ type: "kv", includeAll: true });
    check("B2 a KV export with a real, working store returns its records", result.type === "kv" && result.records.length === 2);
    check("B3 records include the seeded key/value pairs", result.records.some(r => r.key === "a" && r.value === "1"));
    delete globalThis.indexedDB;
}
{
    // B4: a brand-new device (db exists, but no "entries" table yet) is NOT an error --
    // it's legitimately empty.
    globalThis.indexedDB = makeFakeIndexedDb({}); // no seedEntries -> no "entries" store created
    const jiti6 = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
    const idbMod = await jiti6.import("./lib/data-management/idb.ts");

    let threwB4 = false;
    let resultB4 = null;
    try { resultB4 = await idbMod.exportSource({ type: "kv", includeAll: true }); }
    catch { threwB4 = true; }
    check("B4 a fresh device with no entries table does not throw", !threwB4);
    check("B4b ...and returns an empty (not missing) record list", Array.isArray(resultB4?.records) && resultB4.records.length === 0);
    delete globalThis.indexedDB;
}

// ═══ Group C: exportIndexedDbSource surfaces an error field on a failed open ═══
{
    globalThis.indexedDB = makeFakeIndexedDb({ failOpen: true });
    const jiti7 = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
    const idbMod = await jiti7.import("./lib/data-management/idb.ts");

    const result = await idbMod.exportSource({ type: "indexeddb", dbName: "AiPhoneSomeDB" });
    check("C1 a failed indexeddb open does NOT throw (unlike the kv path -- other sources still degrade gracefully)", result.type === "indexeddb");
    check("C2 ...but carries a real error string naming the database", typeof result.error === "string" && result.error.includes("AiPhoneSomeDB"));
    check("C3 stores is an empty array, not missing", Array.isArray(result.stores) && result.stores.length === 0);
    delete globalThis.indexedDB;
}

// ═══ Group D: collectModuleWarnings + wiring into buildSingleModulePayload/createBackupBlob ═══
{
    const jiti8 = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
    const backupMod = await jiti8.import("./lib/data-management/backup.ts");

    const criticalModule = { id: "chat", label: "Chat", description: "", variant: "blue", critical: true, sources: [] };
    const nonCriticalModule = { id: "social", label: "Social", description: "", variant: "blue", critical: false, sources: [] };

    const zeroRecordsPayload = { moduleId: "chat", sources: [] };
    const warningsD1 = backupMod.collectModuleWarnings(criticalModule, zeroRecordsPayload, 0);
    check("D1 a critical module with 0 records produces a warning", warningsD1.length === 1);
    check("D1b the warning names the module", warningsD1[0].includes("Chat"));

    const warningsD2 = backupMod.collectModuleWarnings(nonCriticalModule, zeroRecordsPayload, 0);
    check("D2 a NON-critical module with 0 records produces no warning", warningsD2.length === 0);

    const warningsD3 = backupMod.collectModuleWarnings(criticalModule, zeroRecordsPayload, 5);
    check("D3 a critical module with real records produces no warning", warningsD3.length === 0);

    const erroredSourcePayload = { moduleId: "chat", sources: [{ type: "indexeddb", dbName: "X", stores: [], error: "simulated failure" }] };
    const warningsD4 = backupMod.collectModuleWarnings(criticalModule, erroredSourcePayload, 3);
    check("D4 a source-level error is surfaced as a warning even with nonzero records", warningsD4.some(w => w.includes("simulated failure")));

    // D5: the wiring -- buildSingleModulePayload actually returns collectModuleWarnings'
    // output, not just the payload/records it always returned before.
    globalThis.indexedDB = makeFakeIndexedDb({ failOpen: true });
    const jiti9 = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
    const backupMod2 = await jiti9.import("./lib/data-management/backup.ts");
    const critModuleWithSource = {
        id: "desktop", label: "Desktop", description: "", variant: "blue", critical: true,
        sources: [{ type: "indexeddb", dbName: "AiPhoneDesktopDB" }],
    };
    const built = await backupMod2.buildSingleModulePayload(critModuleWithSource, {});
    check("D5 buildSingleModulePayload surfaces a warning for a critical module whose only source failed to open",
        built.warnings.length > 0 && built.warnings.some(w => w.includes("AiPhoneDesktopDB")));
    delete globalThis.indexedDB;
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
