// Fixture for bidirectional Couple Space: the character writing into the space through
// the four internal-capability tools.
//
// The load-bearing assertion is that a tool call lands in REAL storage with a REAL id and
// fires the projection recorder -- i.e. author: "character" is actually reached, rather
// than existing in the type and never being triggered.
//
//   node _fx-couple-space-tools.mjs

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

const S = await jiti.import("./lib/couple-space-storage.ts");
const M = await jiti.import("./lib/couple-space-memory.ts");
const P = await jiti.import("./lib/couple-space-prompt.ts");
const caps = await jiti.import("./lib/internal-capability-storage.ts");
const chars = await jiti.import("./lib/character-storage.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

const CHAR = "char_luna";
chars.saveCharacters([{ id: CHAR, name: "Luna" }]);
S.clearCoupleSpace(CHAR);
M.clearAllCoupleSpaceProjections();

// ── A. the capability is registered and discoverable ──
const capability = { id: caps.COUPLE_SPACE_CAPABILITY_ID, name: "Couple Space", description: "", enabled: true, mode: "auto", createdAt: 0, updatedAt: 0 };
const subTools = caps.getInternalCapabilitySubToolDefinitions(capability);
const names = subTools.map(t => t.name);

eq("A1 four sub-tools registered", subTools.length, 4);
check("A2 AddReflection present", names.includes("AddReflection"), names);
check("A3 AddWishlistItem present", names.includes("AddWishlistItem"), names);
check("A4 FulfillWish present", names.includes("FulfillWish"), names);
check("A5 AddAnniversary present", names.includes("AddAnniversary"), names);
check("A6 tool names are English (no CJK)", !/[一-鿿]/.test(names.join(" ")), names);
check("A7 single lookup resolves", Boolean(caps.getInternalCapabilitySubToolDefinition(capability, "FulfillWish")), null);
check("A8 unknown sub-tool resolves to null", caps.getInternalCapabilitySubToolDefinition(capability, "Nope") === null);

const def = caps.getInternalCapabilityToolDefinition(capability);
check("A9 usage guide teaches the tools", def?.usageGuide?.includes("AddReflection"), def?.usageGuide?.slice(0, 120));
check("A10 usage guide explains where wishIds come from", def?.usageGuide?.includes("wishId"), null);
// Every schema must parse -- a malformed one is only noticed at call time otherwise.
check("A11 all parameter schemas are valid JSON", subTools.every(t => {
    try { JSON.parse(t.parameterSchema); return true; } catch { return false; }
}), null);

// ── B. the tools actually write, through the real executor ──
const exec = await jiti.import("./lib/tool-executor.ts");
// The public entry point is the plural form; it takes an array and returns an array.
const run = async (name, args) => (await exec.executeToolCalls([{ name, args }], { characterId: CHAR }))[0];

const r1 = await run("AddReflection", { body: "I keep going back to the walk home.", title: "The walk home" });
check("B1 AddReflection succeeds", r1?.success === true, r1);
const reflections = S.loadReflections(CHAR);
eq("B2 it landed in real storage", reflections.length, 1);
// The whole point of this stage: author: "character" is genuinely reached now.
eq("B3 stored as character-authored", reflections[0]?.author, "character");
check("B4 body keeps its spaces", reflections[0]?.body?.includes("the walk home"), reflections[0]?.body);
check("B5 a real id came back", Boolean(reflections[0]?.id) && String(r1?.data ?? "").includes(reflections[0].id), r1?.data);
check("B6 projection recorded", M.loadCoupleSpaceProjectionEntries(CHAR).some(e => e.content.includes("Luna wrote a reflection")),
    M.loadCoupleSpaceProjectionEntries(CHAR).map(e => e.content));

const r2 = await run("AddWishlistItem", { title: "A proper winter coat", priceLabel: "$120" });
check("B7 AddWishlistItem succeeds", r2?.success === true, r2);
const wishes = S.loadWishlist(CHAR);
eq("B8 wish stored", wishes.length, 1);
eq("B9 wanted by the character", wishes[0]?.wantedBy, "character");
eq("B10 wish title keeps spaces", wishes[0]?.title, "A proper winter coat");

const r3 = await run("FulfillWish", { wishId: wishes[0]?.id ?? "missing" });
check("B11 FulfillWish succeeds", r3?.success === true, r3);
eq("B12 wish is now fulfilled", S.loadWishlist(CHAR, { status: "fulfilled" }).length, 1);

const r4 = await run("FulfillWish", { wishId: "cs_does_not_exist" });
check("B13 a bad wishId fails loudly rather than silently", r4?.success === false, r4);
check("B14 the failure names the id", String(r4?.error ?? "").includes("cs_does_not_exist"), r4?.error);

const r5 = await run("AddAnniversary", { title: "The night it rained", date: "2026-03-03" });
check("B15 AddAnniversary succeeds", r5?.success === true, r5);
eq("B16 anniversary stored", S.loadCoupleSpaceState(CHAR).anniversaries.length, 1);
eq("B17 recurring defaults true", S.loadCoupleSpaceState(CHAR).anniversaries[0]?.recurring, true);

const r6 = await run("AddAnniversary", { title: "Bad date", date: "03/03/2026" });
check("B18 a malformed date is rejected", r6?.success === false, r6);
const r7 = await run("AddReflection", { body: "   " });
check("B19 an empty reflection is rejected", r7?.success === false, r7);

// ── C. the macro exposes the ids the tools need ──
const block = P.buildCoupleSpacePromptBlock({ characterId: CHAR, characterName: "Luna" });
const openWish = S.addWishlistItem(CHAR, { title: "Something else", wantedBy: "user" });
const block2 = P.buildCoupleSpacePromptBlock({ characterId: CHAR, characterName: "Luna" });
check("C1 wish ids appear in the block", block2.includes(openWish.id), block2);
check("C2 anniversary ids appear in the block",
    block2.includes(S.loadCoupleSpaceState(CHAR).anniversaries[0]?.id ?? "__no_anniversary__"), block2);
check("C3 the block still reads as prose", block2.includes("[Couple Space with Luna]"), block2);
check("C4 fulfilled wishes are not offered for fulfilling", !block.includes("A proper winter coat"), block);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: drop the isCoupleSpaceToolName route in tool-executor and B1-B19 fail;\n" +
    "remove the [id: ...] from describeWish and C1 fails.",
);
process.exit(fail ? 1 : 0);
