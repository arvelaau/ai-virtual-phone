// The "Message-Count Memory Summary" plugin finds the app's long-term summary pipeline by
// what that function's own source says. The app's strings were translated to English, so the
// original plugin's Chinese fingerprints stopped matching. This drives the plugin against the
// REAL runSummarizationPipeline (and the real core-memory step as a decoy) behind a fake
// webpack cache.
//
//   node _fx-count-summarizer.mjs

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

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

const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") } });
const summarizer = await jiti.import("./lib/memory-summarizer.ts");
const core = await jiti.import("./lib/core-memory-builder.ts");

const PLUGIN_EN = process.env.PLUGIN_EN || path.join(root, "..", "App", "translated", "count-memory-summarizer-EN.js");
const PLUGIN_OLD = process.env.OLD_PLUGIN || path.join(process.env.USERPROFILE || "", "Downloads", "count-memory-summarizer-v1.0.11.js");
if (!fs.existsSync(PLUGIN_EN)) { console.log("plugin file not found, skipping:", PLUGIN_EN); process.exit(0); }

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  FAIL ${name}${extra === undefined ? "" : ` -- ${extra}`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installFakeWebpack(modules) {
    for (const k of Object.getOwnPropertyNames(globalThis)) if (k.startsWith("webpackChunk")) delete globalThis[k];
    const cache = {};
    modules.forEach((exp, i) => { cache[i] = { exports: exp }; });
    const req = { c: cache };
    const chunk = [];
    chunk.push = (entry) => { if (entry && typeof entry[2] === "function") entry[2](req); return 1; };
    globalThis.webpackChunk_fake = chunk;
}

async function runPlugin(file, { interval = 4, feed = 4 } = {}) {
    const mod = await import(pathToFileURL(file).href + "?t=" + Math.random());
    const plugin = mod.default;
    const store = new Map();
    const settings = { interval, includeGroup: false, toast: false };
    const handlers = {};
    const logs = [];
    const ctx = {
        system: {
            storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))) },
            settings: { get: (k) => settings[k] },
            bus: { emit() {}, on() { return () => {}; } },
            log: (...a) => logs.push(a.join(" ")),
        },
        hooks: { on: (name, fn) => { handlers[name] = fn; } },
        ui: { toast() { return { close() {} }; }, injectCSS() {}, slot() {}, messageAction() {} },
        data: {
            sessions: { get: (id) => (id === "s1" ? { id: "s1", contactId: "c1", isGroup: false } : null) },
            characters: { get: (id) => (id === "c1" ? { id: "c1", name: "Mira" } : null) },
        },
    };
    plugin.setup(ctx);
    for (let i = 0; i < feed; i++) {
        handlers["message.persisted"]({ message: { id: "m" + i, sessionId: "s1", role: i % 2 ? "assistant" : "user", content: "hello " + i, createdAt: new Date(Date.now() - (10 - i) * 1000).toISOString() } });
    }
    await sleep(150);
    const state = store.get("v1");
    return { manifest: plugin.manifest, state, slot: state?.characters?.c1, logs };
}

// A. the translated plugin finds the real long-term pipeline (not the core-memory step)
installFakeWebpack([{ somethingElse: () => 1 }, core, summarizer]);
const en = await runPlugin(PLUGIN_EN);
ok("A1 the plugin reached the pipeline", Boolean(en.slot) && (en.slot.lastError || en.slot.lastSummaryAt), JSON.stringify(en.slot));
ok("A2 it ran the long-term pipeline (its own error came back)", /No memory-summary API configured/.test(en.slot?.lastError || ""), en.slot?.lastError);
ok("A3 it did NOT run the core-memory step", !/未配置记忆总结 API/.test(en.slot?.lastError || ""), en.slot?.lastError);
ok("A4 the pending messages are kept after a failed run", (en.slot?.pending || []).length === 4, en.slot?.pending?.length);

// B. order in the cache must not matter (decoy first / last)
installFakeWebpack([summarizer, core]);
const en2 = await runPlugin(PLUGIN_EN);
ok("B1 same result with the real pipeline first", /No memory-summary API configured/.test(en2.slot?.lastError || ""), en2.slot?.lastError);

// C. only the decoy available -> an honest "not found", never the core step
installFakeWebpack([core]);
const en3 = await runPlugin(PLUGIN_EN);
ok("C1 with only the core-memory step present it reports not found", /Could not find the app's memory summary pipeline/.test(en3.slot?.lastError || ""), en3.slot?.lastError);

// D. the threshold cannot go below what the pipeline accepts
installFakeWebpack([summarizer, core]);
const en4 = await runPlugin(PLUGIN_EN, { interval: 2, feed: 3 });
ok("D1 interval 2 behaves as 4: three messages trigger nothing", !en4.slot?.lastError && (en4.slot?.pending || []).length === 3, JSON.stringify(en4.slot));

// E. manifest sanity
ok("E1 id kept so it replaces the original", en.manifest.id === "count-memory-summarizer");
const src = fs.readFileSync(PLUGIN_EN, "utf8");
ok("E2 no CJK left outside the legacy fingerprints", (() => {
    const lines = src.split(/\r?\n/).filter((l) => /[一-鿿]/.test(l));
    return lines.every((l) => /"没有|"事件不足|"核心记忆|"没有新的|"没有可用于|\/\/.*(Chinese|original)/.test(l));
})(), src.split(/\r?\n/).filter((l) => /[一-鿿]/.test(l)).join(" | ").slice(0, 200));

// F. the original plugin: it still resolves, but ONLY through the "[MemorySummarizer]" console tag,
// because every other Chinese fingerprint stopped matching when the app was translated.
if (fs.existsSync(PLUGIN_OLD)) {
    installFakeWebpack([summarizer, core]);
    const old = await runPlugin(PLUGIN_OLD);
    ok("F1 the original still reaches the pipeline (via the one English tag left)", /No memory-summary API configured/.test(old.slot?.lastError || ""), old.slot?.lastError);
    const oldSrc = fs.readFileSync(PLUGIN_OLD, "utf8");
    const fp = oldSrc.slice(oldSrc.indexOf("const PIPE_YES"), oldSrc.indexOf("const PIPE_NO"));
    const stillMatch = ["没有可总结的事件", "事件不足 4 条"].filter((s2) => String(summarizer.runSummarizationPipeline).includes(s2));
    ok("F2 the original's Chinese fingerprints no longer occur in the pipeline", stillMatch.length === 0 && fp.includes("[MemorySummarizer]"), stillMatch.join(","));
} else {
    console.log("  (control skipped: original plugin not found)");
}

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
