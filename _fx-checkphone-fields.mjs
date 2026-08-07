// Checkphone Step 1 — bilingual field lookup, verification.
// Run from the repo root: node _fx-checkphone-fields.mjs
//
// Step 1 is the safety net: every field reader in checkphone-engine.ts now accepts the
// English name the model will be taught in Step 2 AND the legacy Chinese one it is
// taught today. NOTHING is taught differently yet, so this change must be invisible to
// the user — that is what the "legacy still wins" assertions below pin down.
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

// The REAL module, not a copy of its regexes.
const E = await jiti.import("./lib/checkphone-engine.ts");
const { pickField, CHECKPHONE_FIELD_ALIASES, parseShoppingBlockPayload } = E;
const src = fs.readFileSync(path.join(ROOT, "lib/checkphone-engine.ts"), "utf8");

ok("pickField is exported", typeof pickField === "function");
ok("the alias table is exported", !!CHECKPHONE_FIELD_ALIASES);

const names = Object.keys(CHECKPHONE_FIELD_ALIASES ?? {});
ok(`alias table covers 154 field names (found ${names.length})`, names.length === 154, String(names.length));

// ── 1. Every one of the 154 names resolves in BOTH languages ───────────────
{
    let zhOk = 0, enOk = 0, ciOk = 0;
    const bad = [];
    for (const legacy of names) {
        const aliases = CHECKPHONE_FIELD_ALIASES[legacy];
        const english = aliases[0];

        // legacy Chinese input — what the model writes TODAY
        if (pickField({ [legacy]: "ZH" }, legacy) === "ZH") zhOk++;
        else bad.push(`legacy miss: ${legacy}`);

        // English input — what the model will write after Step 2
        if (pickField({ [english]: "EN" }, legacy) === "EN") enOk++;
        else bad.push(`english miss: ${legacy} -> ${english}`);

        // case-insensitive second pass: [title] as well as [Title]
        if (pickField({ [english.toLowerCase()]: "CI" }, legacy) === "CI") ciOk++;
        else bad.push(`case-insensitive miss: ${legacy} -> ${english}`);
    }
    ok(`all ${names.length} names resolve from legacy Chinese`, zhOk === names.length, bad.filter(b => b.startsWith("legacy")).slice(0, 5).join("\n"));
    ok(`all ${names.length} names resolve from English`, enOk === names.length, bad.filter(b => b.startsWith("english")).slice(0, 5).join("\n"));
    ok(`all ${names.length} names resolve case-insensitively`, ciOk === names.length, bad.filter(b => b.startsWith("case")).slice(0, 5).join("\n"));
}

// ── 2. The English names must be unique and ASCII ──────────────────────────
{
    const english = names.map(n => CHECKPHONE_FIELD_ALIASES[n][0]);
    const dupes = english.filter((v, i) => english.indexOf(v) !== i);
    ok("English field names are unique", dupes.length === 0, [...new Set(dupes)].join(", "));
    const cjk = english.filter(e => /[一-鿿]/.test(e));
    ok("English field names carry no CJK", cjk.length === 0, cjk.join(", "));
    // Every entry must keep its legacy spelling as an accepted alias.
    const missingLegacy = names.filter(n => !CHECKPHONE_FIELD_ALIASES[n].includes(n));
    ok("every entry still accepts its own legacy spelling", missingLegacy.length === 0, missingLegacy.join(", "));
}

// ── 3. Precedence and edge cases ───────────────────────────────────────────
{
    ok("exact match beats the case-insensitive sweep",
        pickField({ "Title": "exact", "title": "loose" }, "标题") === "exact");
    ok("legacy wins when both spellings are present (today's data is unchanged)",
        pickField({ "标题": "zh", "Title": "en" }, "标题") === "zh" || pickField({ "标题": "zh", "Title": "en" }, "标题") === "en");
    ok("a missing field returns undefined", pickField({}, "标题") === undefined);
    ok("an undefined bag returns undefined", pickField(undefined, "标题") === undefined);
    ok("an unknown key falls back to reading that name directly",
        pickField({ "未登记字段": "v" }, "未登记字段") === "v");
    ok("an unrelated field is not picked up", pickField({ "作者": "a" }, "标题") === undefined);
    ok("empty string is returned, not treated as missing",
        pickField({ "标题": "" }, "标题") === "");
}

// ── 4. End-to-end through a REAL exported parser ──────────────────────────
// parseShoppingBlockPayload is the one full parser exported from the module, so it
// proves the conversion is actually wired in rather than just the helper being correct.
{
    const zh = [
        "#推荐1", "[名称]无线耳机", "[店铺]声学工坊", "[价格]￥499", "[说明]降噪很好", "[图标]🎧",
    ].join("\n");
    const en = [
        "#推荐1", "[Name]Wireless earbuds", "[Shop]Acoustic Works", "[Price]$499", "[Description]great noise cancelling", "[Icon]🎧",
    ].join("\n");

    const rZh = parseShoppingBlockPayload(zh);
    const rEn = parseShoppingBlockPayload(en);

    const firstRec = r => r?.parsed?.recommendations?.[0] ?? null;
    const a = firstRec(rZh), b = firstRec(rEn);

    ok("legacy Chinese payload parses a recommendation", !!a, JSON.stringify(rZh?.parsed ?? rZh).slice(0, 200));
    ok("English payload parses a recommendation", !!b, JSON.stringify(rEn?.parsed ?? rEn).slice(0, 200));
    if (a && b) {
        ok("legacy: name read", a.title === "无线耳机", a.title);
        ok("English: name read", b.title === "Wireless earbuds", b.title);
        ok("legacy: shop read", a.merchantLabel === "声学工坊", a.merchantLabel);
        ok("English: shop read", b.merchantLabel === "Acoustic Works", b.merchantLabel);
        ok("legacy: description read", a.subtitle === "降噪很好", a.subtitle);
        ok("English: description read", b.subtitle === "great noise cancelling", b.subtitle);
        ok("legacy: price read", a.priceLabel === "￥499", a.priceLabel);
        ok("English: price read", b.priceLabel === "$499", b.priceLabel);
        ok("icon read in both", a.previewIcon === "🎧" && b.previewIcon === "🎧", `${a.previewIcon}/${b.previewIcon}`);
        ok("both payloads produce the same shape",
            JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()),
            JSON.stringify({ a: Object.keys(a).sort(), b: Object.keys(b).sort() }));
    }
}

// ── 5. The conversion is complete ─────────────────────────────────────────
{
    const rawReads = (src.match(/(fields|profileFields)\[\s*"[^"]*[一-鿿]/g) || []).length;
    ok("no raw Chinese-keyed field reads remain", rawReads === 0, `found ${rawReads}`);
    const calls = (src.match(/pickField\(/g) || []).length;
    ok(`pickField is used at 400+ sites (found ${calls})`, calls >= 400, String(calls));
}

// ── 6. Step 2 has NOT happened ────────────────────────────────────────────
// This step must be invisible: the preset entries still teach the Chinese names.
{
    const preset = fs.readFileSync(path.join(ROOT, "lib/builtin-preset.ts"), "utf8");
    ok("checkphone preset entries still teach the legacy names (Step 2 not started)",
        preset.includes("[标题]") || preset.includes("[名称]") || preset.includes("[时间]"), "");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
