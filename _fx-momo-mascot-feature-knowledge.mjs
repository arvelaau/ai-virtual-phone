// Mascot Feature Knowledge (ported from momo.float.phone: feat commit 7882569 /
// 66634b4 introduced lib/mascot-feature-knowledge.ts; wired into lib/mascot-engine.ts by
// commit c359a59, right after getMascotPersonaPrompt() in both the native and text
// protocol system-prompt assembly). The ENTRIES were rewritten for this fork rather than
// translated -- momo's list describes momo's own feature set and navigation paths, many
// of which don't apply here (some features aren't ported, some are reached differently).
// See the file's own header comment and the batch commit message for the full audit.
//
// This fixture drives the real lib/mascot-feature-knowledge.ts against a small but
// complete fake IndexedDB (open/onupgradeneeded/transaction/objectStore.get+put), since
// the revision-refresh mechanism is the one part of this port with real logic to break.
//
//   node _fx-momo-mascot-feature-knowledge.mjs

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; console.log("FAIL", name, extra ?? ""); }
}

// ── A minimal, real IndexedDB fake: one named database, one object store, keyPath "key" ──
class FakeIDBRequest {
    constructor() {
        this.onupgradeneeded = null;
        this.onsuccess = null;
        this.onerror = null;
        this.result = undefined;
        this.error = undefined;
    }
    _succeed(result) {
        this.result = result;
        queueMicrotask(() => this.onsuccess?.());
    }
    _fail(error) {
        this.error = error;
        queueMicrotask(() => this.onerror?.());
    }
}

class FakeObjectStore {
    constructor(map) { this._map = map; }
    get(key) {
        const req = new FakeIDBRequest();
        req._succeed(this._map.get(key));
        return req;
    }
    put(value) {
        const req = new FakeIDBRequest();
        this._map.set(value.key, value);
        req._succeed(value.key);
        return req;
    }
}

class FakeTransaction {
    constructor(store) {
        this._store = store;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        queueMicrotask(() => this.oncomplete?.());
    }
    objectStore() { return this._store; }
}

class FakeObjectStoreNames {
    constructor(names) { this._names = names; }
    contains(name) { return this._names.has(name); }
}

class FakeIDBDatabase {
    constructor() {
        this._stores = new Map();
        this.objectStoreNames = new FakeObjectStoreNames(new Set());
    }
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

function makeFakeIndexedDb({ persistAcrossOpens = true, failOpen = false, dbInstance = null } = {}) {
    const shared = dbInstance ?? new FakeIDBDatabase();
    return {
        _db: shared,
        open(name, version) {
            const req = new FakeIDBRequest();
            if (failOpen) { req._fail(new Error("simulated open failure")); return req; }
            const db = persistAcrossOpens ? shared : new FakeIDBDatabase();
            const isNew = db.objectStoreNames._names.size === 0;
            // Real IndexedDB sets request.result before firing onupgradeneeded (the
            // upgrade callback reads request.result to get the database handle).
            req.result = db;
            queueMicrotask(() => {
                if (isNew) req.onupgradeneeded?.();
                req._succeed(db);
            });
            return req;
        },
    };
}

const jiti = createJiti(__dirname, { interopDefault: true, alias: { "@": __dirname } });
const knowledgeMod = await jiti.import("./lib/mascot-feature-knowledge.ts");

// ── A. No IndexedDB at all: falls back to the built-in knowledge, formatted correctly ──
{
    delete globalThis.indexedDB;
    const prompt = await knowledgeMod.loadMascotFeatureKnowledgePrompt();
    check("A1 prompt is a non-empty string", typeof prompt === "string" && prompt.length > 0);
    check("A2 includes the header banner", prompt.includes("Current build's feature knowledge"));
    check("A3 includes a real entry title", prompt.includes("[Theme Presets]"));
    check("A4 includes that entry's location line", prompt.includes("Location: Appearance → Theme Presets"));
    check("A5 entries render as bullet facts", /\n- /.test(prompt));
}

// ── B. A fresh (empty) IndexedDB: seeds itself with the built-in record on first read ──
{
    const fake = makeFakeIndexedDb();
    globalThis.indexedDB = fake;
    const prompt = await knowledgeMod.loadMascotFeatureKnowledgePrompt();
    check("B1 first read with an empty DB still returns the full knowledge", prompt.includes("[Chat notification sounds]"));

    // Read again: this time the record should already be seeded (no upgrade needed),
    // and the content must be identical.
    const prompt2 = await knowledgeMod.loadMascotFeatureKnowledgePrompt();
    check("B2 a second read returns the same content", prompt === prompt2);
    delete globalThis.indexedDB;
}

// ── C. A stale revision stored in IndexedDB gets replaced by the current built-in one ──
{
    const db = new FakeIDBDatabase();
    const store = db.createObjectStore("knowledge");
    store.put({
        key: "owner-custom-features",
        revision: "2020-01-01.0",
        updatedAt: "2020-01-01T00:00:00.000Z",
        entries: [{ id: "ancient", title: "Ancient Feature", location: "nowhere", facts: ["stale"] }],
    });
    globalThis.indexedDB = makeFakeIndexedDb({ dbInstance: db });
    const prompt = await knowledgeMod.loadMascotFeatureKnowledgePrompt();
    check("C1 a stale-revision record is replaced, not kept", !prompt.includes("Ancient Feature"));
    check("C2 ...replaced with the current built-in entries", prompt.includes("[Theme Presets]"));
    delete globalThis.indexedDB;
}

// ── D. A matching-revision record already in IndexedDB is read back as-is, not rewritten ──
{
    // Read the live module's own current revision by round-tripping through the
    // fallback formatter's known content, rather than hardcoding it here (so this
    // test doesn't silently go stale next time OWNER_FEATURES.revision is bumped).
    const fallbackPrompt = await (async () => {
        delete globalThis.indexedDB;
        return knowledgeMod.loadMascotFeatureKnowledgePrompt();
    })();

    const db = new FakeIDBDatabase();
    const store = db.createObjectStore("knowledge");
    // Extract the real current revision via a tiny reflection: save once through the
    // real DB path, then read the record back out directly.
    globalThis.indexedDB = makeFakeIndexedDb({ dbInstance: db });
    await knowledgeMod.loadMascotFeatureKnowledgePrompt(); // seeds it
    const seededRecord = db._stores.get("knowledge").get("owner-custom-features");
    check("D0 setup: the seeded record is readable directly from the fake store", !!seededRecord);

    let putCallCount = 0;
    const originalPut = FakeObjectStore.prototype.put;
    FakeObjectStore.prototype.put = function (value) { putCallCount++; return originalPut.call(this, value); };
    const promptAgain = await knowledgeMod.loadMascotFeatureKnowledgePrompt();
    check("D1 a matching-revision record does not trigger another write", putCallCount === 0);
    check("D2 the content is unchanged", promptAgain === fallbackPrompt);
    FakeObjectStore.prototype.put = originalPut;
    delete globalThis.indexedDB;
}

// ── E. indexedDB.open itself failing falls back to the built-in knowledge, not a throw ──
{
    globalThis.indexedDB = makeFakeIndexedDb({ failOpen: true });
    let threw = false;
    let prompt = null;
    try { prompt = await knowledgeMod.loadMascotFeatureKnowledgePrompt(); }
    catch { threw = true; }
    check("E1 a failing indexedDB.open does not throw", !threw);
    check("E2 ...and still returns usable built-in knowledge", prompt?.includes("Theme Presets"));
    delete globalThis.indexedDB;
}

// ── F. Content hygiene: no leftover CJK anywhere in the entries or the formatter output ──
{
    delete globalThis.indexedDB;
    const prompt = await knowledgeMod.loadMascotFeatureKnowledgePrompt();
    const cjk = /[一-鿿]/;
    check("F1 the formatted prompt is entirely CJK-free", !cjk.test(prompt), prompt.match(cjk)?.[0]);

    const src = fs.readFileSync(path.join(__dirname, "lib/mascot-feature-knowledge.ts"), "utf8");
    // Only check inside the OWNER_FEATURES literal, not doc comments about the source file.
    const start = src.indexOf("const OWNER_FEATURES");
    const end = src.indexOf("\n};", start);
    const literal = src.slice(start, end);
    check("F2 the OWNER_FEATURES literal itself is CJK-free", !cjk.test(literal), literal.match(cjk)?.[0]);
}

// ── G. Wiring: mascot-engine.ts calls this right after getMascotPersonaPrompt() in both paths ──
{
    const engineSrc = fs.readFileSync(path.join(__dirname, "lib/mascot-engine.ts"), "utf8");
    check("G1 imports loadMascotFeatureKnowledgePrompt", engineSrc.includes('import { loadMascotFeatureKnowledgePrompt } from "./mascot-feature-knowledge"'));
    const occurrences = [...engineSrc.matchAll(/getMascotPersonaPrompt\(\),\s*\n\s*await loadMascotFeatureKnowledgePrompt\(\),/g)];
    check("G2 called immediately after getMascotPersonaPrompt() in both system-prompt assemblies", occurrences.length === 2);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
