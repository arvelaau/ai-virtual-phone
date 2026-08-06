// Mascot user-identity gender rule — behaviour fixture.
// Run from the repo root: node _fx-mascot-identity.mjs
//
// The mascot used to be told, in MASCOT_PERSONA, that "the user is female", with
// feminine forms of address prescribed and masculine ones forbidden. That was
// translated away behaviour-preservingly during D2 (leaving it neutral), and this
// change makes it read the gender actually configured in Settings -> User Identity.
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const jiti = createJiti(ROOT, { jsx: true, interopDefault: true, alias: { "@": ROOT } });

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) pass++;
    else { fail++; console.log("FAIL:", n, x === undefined ? "" : "\n      " + String(x).slice(0, 300)); }
};

const E = await jiti.import("./lib/mascot-engine.ts");

const ruleFor = g => E.formatMascotUserIdentityRule(g);

// ── 1. The rule exists and is wired into BOTH prompts ──────────────────────
{
    const src = fs.readFileSync(path.join(ROOT, "lib/mascot-engine.ts"), "utf8");
    ok("buildMascotUserIdentityRule is exported", typeof E.buildMascotUserIdentityRule === "function");
    const calls = src.split("buildMascotUserIdentityRule(),").length - 1;
    ok("wired into both system prompts (text + native)", calls === 2, `found ${calls}`);
    // It must sit AFTER the persona, which is what it is correcting.
    src.split("const systemPrompt = [").slice(1).forEach((block, i) => {
        const head = block.split("].join")[0];
        const personaAt = head.indexOf("getMascotPersonaPrompt()");
        const ruleAt = head.indexOf("buildMascotUserIdentityRule()");
        ok(`prompt ${i + 1}: identity rule comes after the persona`,
            personaAt >= 0 && ruleAt > personaAt, head.slice(0, 200));
    });
}

// ── 2. Undisclosed / missing / empty are all handled the same ─────────────
for (const [label, value] of [["保密 (prefer not to say)", "保密"], ["empty string", ""], ["whitespace only", "   "], ["undefined", undefined], ["null", null]]) {
    const rule = ruleFor(value);
    ok(`${label}: does not state a gender`, !/gender is set to/.test(rule), rule);
    ok(`${label}: forbids assuming one`, /Do not assume one/i.test(rule), rule);
    ok(`${label}: forbids inferring from the name`, /infer it from their name/i.test(rule), rule);
    ok(`${label}: offers they\\/them`, /they\/them/.test(rule), rule);
    ok(`${label}: rule is English`, !/[一-鿿]/.test(rule), rule);
}

// ── 3. A configured gender is stated and treated as fact ─────────────────
for (const g of ["Male", "Female", "Other"]) {
    const rule = ruleFor(g);
    ok(`${g}: gender is stated`, rule.includes(`set to "${g}"`), rule);
    ok(`${g}: told to treat it as fact`, /treat it as fact/i.test(rule), rule);
    ok(`${g}: does NOT fall into the undisclosed branch`, !/has not said what gender/.test(rule), rule);
    ok(`${g}: rule is English`, !/[一-鿿]/.test(rule), rule);
}

// ── 4. The old hardcoded assumption is really gone ───────────────────────
{
    const P = await jiti.import("./lib/mascot-prompts.ts");
    ok("MASCOT_PERSONA no longer asserts the user's gender",
        !/用户是女性/.test(P.MASCOT_PERSONA) && !/the user is female/i.test(P.MASCOT_PERSONA),
        P.MASCOT_PERSONA.slice(0, 200));
    ok("MASCOT_PERSONA no longer prescribes gendered address",
        !/宝|小姐姐/.test(P.MASCOT_PERSONA));
    // The persona keeps its warmth instruction; the gender part now lives in the rule.
    ok("MASCOT_PERSONA still says to address the user warmly", /warmly and affectionately/i.test(P.MASCOT_PERSONA));
}

// ── 5. The 保密 sentinel must stay that exact string ─────────────────────
// Only llm-prompt-assembler.ts and calendar-engine.ts compare against it (plus this
// engine now). CLAUDE.md long claimed custom-app-host-api.ts did too -- it does not,
// verified by grep; that note was stale.
{
    const engineSrc = fs.readFileSync(path.join(ROOT, "lib/mascot-engine.ts"), "utf8");
    ok("mascot-engine compares against the 保密 sentinel", engineSrc.includes('"保密"'));
    ["lib/llm-prompt-assembler.ts", "lib/calendar-engine.ts"].forEach(f => {
        ok(`${f} still uses the same sentinel`, fs.readFileSync(path.join(ROOT, f), "utf8").includes("保密"), f);
    });
    const ui = fs.readFileSync(path.join(ROOT, "components/settings/user-identity.tsx"), "utf8");
    ok("the settings dropdown still stores 保密 as the value", ui.includes('value="保密"'));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
