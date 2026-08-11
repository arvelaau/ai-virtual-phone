// Fixture for optional per-character scoping of REST tools.
//
// The two requirements worth proving: filtering is OPT-IN (a tool without
// restrictedToCharacterIds resolves for every character, exactly as before), and a tool
// WITH it set resolves only for the listed character ids.
//
//   node _fx-tool-scope.mjs

import path from "node:path";
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
if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init?.detail; }
    };
}

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const T = await jiti.import("./lib/tool-storage.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 300));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

const A = "char_a";
const B = "char_b";

// ── A. the predicate in isolation ──
const global = {};
const legacy = { restrictedToCharacterIds: undefined };
const empty = { restrictedToCharacterIds: [] };
const scoped = { restrictedToCharacterIds: [A] };
const multi = { restrictedToCharacterIds: [A, B] };

check("A1 unset field is available to everyone", T.isRestToolAvailableToCharacter(global, A));
check("A2 unset field is available with no character context at all",
    T.isRestToolAvailableToCharacter(global, undefined));
check("A3 explicit undefined behaves the same", T.isRestToolAvailableToCharacter(legacy, B));
// Empty array must mean "unrestricted", not "restricted to nobody".
check("A4 empty array is unrestricted", T.isRestToolAvailableToCharacter(empty, B));
check("A5 empty array is unrestricted with no context", T.isRestToolAvailableToCharacter(empty, undefined));

check("A6 scoped tool resolves for the listed character", T.isRestToolAvailableToCharacter(scoped, A));
check("A7 scoped tool is hidden from another character", !T.isRestToolAvailableToCharacter(scoped, B));
// A restriction is explicit intent, so an unknown caller is treated as not-permitted.
check("A8 scoped tool is hidden when there is no character context",
    !T.isRestToolAvailableToCharacter(scoped, undefined));
check("A9 multi-scope allows both listed characters",
    T.isRestToolAvailableToCharacter(multi, A) && T.isRestToolAvailableToCharacter(multi, B));
check("A10 multi-scope still excludes an unlisted character",
    !T.isRestToolAvailableToCharacter(multi, "char_c"));

// ── B. end to end through getEnabledTools ──
const now = Date.now();
const mk = (id, name, extra = {}) => ({
    id, name, description: `${name} desc`, endpoint: "https://example.test/x",
    method: "POST", parameterSchema: "{}", enabled: true, createdAt: now, updatedAt: now, ...extra,
});

T.saveRestTools([
    mk("t_global", "send_mail_global"),
    mk("t_scoped", "send_mail_scoped", { restrictedToCharacterIds: [A] }),
    mk("t_multi", "send_mail_multi", { restrictedToCharacterIds: [A, B] }),
    mk("t_disabled", "send_mail_off", { enabled: false, restrictedToCharacterIds: [A] }),
]);

const namesFor = (characterId) =>
    T.getEnabledTools(undefined, characterId).filter(t => t.source === "rest").map(t => t.name).sort();

const forA = namesFor(A);
const forB = namesFor(B);
const forNone = namesFor(undefined);

check("B1 the global tool resolves for character A", forA.includes("send_mail_global"), forA);
check("B2 the global tool resolves for character B", forB.includes("send_mail_global"), forB);
// This is the "no behaviour change for existing tools" guarantee.
check("B3 the global tool STILL resolves with no character context (unchanged behaviour)",
    forNone.includes("send_mail_global"), forNone);

check("B4 the scoped tool resolves for its character", forA.includes("send_mail_scoped"), forA);
check("B5 the scoped tool is hidden from another character", !forB.includes("send_mail_scoped"), forB);
check("B6 the scoped tool is hidden with no character context", !forNone.includes("send_mail_scoped"), forNone);

check("B7 multi-scope resolves for both", forA.includes("send_mail_multi") && forB.includes("send_mail_multi"), { forA, forB });
check("B8 a disabled tool never resolves regardless of scope", !forA.includes("send_mail_off"), forA);

// ── C. findEnabledToolForSchema honours the same scope ──
check("C1 lookup finds the global tool for any character",
    Boolean(T.findEnabledToolForSchema("send_mail_global", undefined, undefined, B)), null);
check("C2 lookup finds the scoped tool for its character",
    Boolean(T.findEnabledToolForSchema("send_mail_scoped", undefined, undefined, A)), null);
check("C3 lookup does NOT find the scoped tool for another character",
    T.findEnabledToolForSchema("send_mail_scoped", undefined, undefined, B) === undefined, null);
// Back-compat: the old 3-arg call shape still works for unrestricted tools.
check("C4 legacy 3-arg call still resolves an unrestricted tool",
    Boolean(T.findEnabledToolForSchema("send_mail_global")), null);

// ── D. package children are scoped too ──
T.saveRestToolPackages([
    { id: "pkg1", name: "mail_pack", description: "", enabled: true, createdAt: now, updatedAt: now },
]);
T.saveRestTools([
    mk("p_global", "pkg_global", { packageId: "pkg1" }),
    mk("p_scoped", "pkg_scoped", { packageId: "pkg1", restrictedToCharacterIds: [A] }),
]);

const packFor = (characterId) => {
    const pkg = T.getEnabledTools(undefined, characterId).find(t => t.source === "rest_package");
    return (pkg?.restTools ?? []).map(t => t.name).sort();
};
const packA = packFor(A);
const packB = packFor(B);
check("D1 package exposes the global child to A", packA.includes("pkg_global"), packA);
check("D2 package exposes the global child to B", packB.includes("pkg_global"), packB);
check("D3 package exposes the scoped child only to A", packA.includes("pkg_scoped"), packA);
check("D4 package hides the scoped child from B", !packB.includes("pkg_scoped"), packB);
// The package-child branch of findEnabledToolForSchema is a separate code path.
check("D5 lookup resolves a scoped package child for its character",
    Boolean(T.findEnabledToolForSchema("pkg_scoped", undefined, undefined, A)), null);
check("D6 lookup hides a scoped package child from another character",
    T.findEnabledToolForSchema("pkg_scoped", undefined, undefined, B) === undefined, null);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: make isRestToolAvailableToCharacter always return true and A7/A8/A10,\n" +
    "B5/B6, C3, D4/D6 fail; make it return false for an empty list and A4/A5/B3 fail\n" +
    "(that second one is the opt-in guarantee).",
);
process.exit(fail ? 1 : 0);
