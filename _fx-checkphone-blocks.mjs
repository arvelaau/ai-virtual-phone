// Checkphone Step 1b — bilingual BLOCK HEADINGS, verification.
// Run from the repo root: node _fx-checkphone-blocks.mjs
//
// Step 1 made field reads bilingual. The taught format has a second protocol layer that
// Step 1 missed: the block headings (#历史记录, ##记录1). Until those accept English too,
// flipping the teaching makes block extraction stop matching SILENTLY.
//
// Like Step 1, this must be invisible to the user: no teaching has changed.
//
// Non-vacuity control (verified 2026-08-07): dropping the English alias from just two
// headings ("推荐" and "购物车") takes this from 39/39 to 33/39, and the six failures are
// exactly the English-path ones — including the end-to-end parseShoppingBlockPayload run.
// Note "all N headings match in English" does NOT fail in that scenario, because with the
// alias gone the "English" name IS the Chinese one; "English heading names carry no CJK"
// is what catches it. Both assertions are needed.
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

const E = await jiti.import("./lib/checkphone-engine.ts");
const src = fs.readFileSync(path.join(ROOT, "lib/checkphone-engine.ts"), "utf8");

const { CHECKPHONE_BLOCK_ALIASES, blockLabelPattern, canonicalBlockLabel, parseShoppingBlockPayload } = E;

ok("blockLabelPattern is exported", typeof blockLabelPattern === "function");
ok("canonicalBlockLabel is exported", typeof canonicalBlockLabel === "function");
ok("the block alias table is exported", !!CHECKPHONE_BLOCK_ALIASES);

const labels = Object.keys(CHECKPHONE_BLOCK_ALIASES ?? {});
ok(`block alias table covers 60+ headings (found ${labels.length})`, labels.length >= 60, String(labels.length));

// ── 1. Every heading resolves in BOTH languages, and normalises back ───────
{
    const bad = [];
    for (const legacy of labels) {
        const english = CHECKPHONE_BLOCK_ALIASES[legacy][0];

        // the alternation must actually match both spellings
        const re = new RegExp(`^#\\s*(?:${blockLabelPattern(legacy)})\\s*$`);
        if (!re.test(`#${legacy}`)) bad.push(`legacy no-match: ${legacy}`);
        if (!re.test(`#${english}`)) bad.push(`english no-match: ${legacy} -> ${english}`);

        // and both must normalise back to the canonical Chinese
        if (canonicalBlockLabel(legacy) !== legacy) bad.push(`legacy no-canon: ${legacy}`);
        if (canonicalBlockLabel(english) !== legacy) bad.push(`english no-canon: ${english} -> ${legacy}`);
        if (canonicalBlockLabel(english.toLowerCase()) !== legacy) bad.push(`ci no-canon: ${english}`);
    }
    ok(`all ${labels.length} headings match in Chinese`, !bad.some(b => b.startsWith("legacy no-match")), bad.filter(b => b.startsWith("legacy no-match")).slice(0, 4).join("\n"));
    ok(`all ${labels.length} headings match in English`, !bad.some(b => b.startsWith("english no-match")), bad.filter(b => b.startsWith("english no-match")).slice(0, 4).join("\n"));
    ok("every spelling normalises back to the canonical Chinese", !bad.some(b => b.includes("no-canon")), bad.filter(b => b.includes("no-canon")).slice(0, 4).join("\n"));
}

// ── 2. English names unique; legacy always kept ───────────────────────────
{
    const english = labels.map(l => CHECKPHONE_BLOCK_ALIASES[l][0]);
    const dupes = english.filter((v, i) => english.indexOf(v) !== i);
    ok("English heading names are unique", dupes.length === 0, [...new Set(dupes)].join(", "));
    ok("English heading names carry no CJK", !english.some(e => /[一-鿿]/.test(e)), english.filter(e => /[一-鿿]/.test(e)).join(", "));
    const missing = labels.filter(l => !CHECKPHONE_BLOCK_ALIASES[l].includes(l));
    ok("every heading still accepts its own legacy spelling", missing.length === 0, missing.join(", "));
}

// ── 3. Longest-first ordering — the shadowing trap ────────────────────────
// 精选 is a prefix of 精选动态, and Featured/Highlights coexist. Without longest-first
// the shorter alias wins and the longer heading is read as the shorter one plus junk.
{
    const p = blockLabelPattern("精选动态");
    const re = new RegExp(`^##\\s*(?:${blockLabelPattern("精选动态")}|${blockLabelPattern("精选")})(\\d+)\\s*$`);
    ok("精选动态 is not shadowed by 精选", re.test("##精选动态1"), p);
    ok("精选 still matches on its own", re.test("##精选1"));
    const m = "##精选动态1".match(re);
    ok("精选动态 captures the number, not a stray suffix", m && m[1] === "1", JSON.stringify(m?.slice(0, 2)));
    // and in general: within one label, aliases are emitted longest-first
    const order = blockLabelPattern("赞过的视频").split("|");
    ok("aliases within a label are longest-first", order.every((v, i) => i === 0 || order[i - 1].length >= v.length), order.join("|"));
}

// ── 4. Labels living in BOTH protocol layers share one alias ──────────────
// 订单/收藏/帖子/视频/喜欢/动态 are reached through a parameterised extractor AND an
// inline regex. If the two disagreed, one path would accept English and the other not.
{
    ["订单", "收藏", "帖子", "视频", "喜欢", "动态"].forEach(l => {
        ok(`shared label "${l}" is in the table once`, !!CHECKPHONE_BLOCK_ALIASES[l], l);
        ok(`shared label "${l}" resolves both ways`,
            canonicalBlockLabel(CHECKPHONE_BLOCK_ALIASES[l][0]) === l && canonicalBlockLabel(l) === l, l);
    });
}

// ── 5. End-to-end through a REAL exported parser, both languages ──────────
{
    const zh = ["#推荐1", "[名称]无线耳机", "[价格]￥499", "#购物车1", "[名称]保温杯", "[数量]× 2"].join("\n");
    const en = ["#Recommendations1", "[Name]Wireless earbuds", "[Price]$499", "#Cart1", "[Name]Thermal flask", "[Quantity]× 2"].join("\n");

    const rZh = parseShoppingBlockPayload(zh);
    const rEn = parseShoppingBlockPayload(en);

    ok("legacy Chinese headings parse", (rZh?.parsed?.recommendations?.length ?? 0) === 1, JSON.stringify(rZh?.parsed ?? rZh).slice(0, 160));
    ok("English headings parse", (rEn?.parsed?.recommendations?.length ?? 0) === 1, JSON.stringify(rEn?.parsed ?? rEn).slice(0, 160));
    ok("legacy: cart block found", (rZh?.parsed?.cartItems?.length ?? 0) === 1, String(rZh?.parsed?.cartItems?.length));
    ok("English: cart block found", (rEn?.parsed?.cartItems?.length ?? 0) === 1, String(rEn?.parsed?.cartItems?.length));
    ok("legacy: field inside the block read", rZh?.parsed?.recommendations?.[0]?.title === "无线耳机", rZh?.parsed?.recommendations?.[0]?.title);
    ok("English: field inside the block read", rEn?.parsed?.recommendations?.[0]?.title === "Wireless earbuds", rEn?.parsed?.recommendations?.[0]?.title);
    ok("both languages yield the same shape",
        JSON.stringify(Object.keys(rZh?.parsed ?? {}).sort()) === JSON.stringify(Object.keys(rEn?.parsed ?? {}).sort()));

    // Mixed: an English heading with legacy fields, which is what a half-migrated model writes.
    const mixed = ["#Recommendations1", "[名称]混合", "[价格]￥1"].join("\n");
    ok("a mixed English-heading / Chinese-field payload still parses",
        parseShoppingBlockPayload(mixed)?.parsed?.recommendations?.[0]?.title === "混合",
        JSON.stringify(parseShoppingBlockPayload(mixed)?.parsed?.recommendations?.[0]));
}

// ── 6. The conversion is complete ─────────────────────────────────────────
{
    const inlineLeft = (src.match(/matchAll\(\/\^#[^/]*[一-鿿]/g) || []).length;
    ok("no inline block regex still bakes in a Chinese heading", inlineLeft === 0, `found ${inlineLeft}`);
    const rawLabel = (src.match(/RegExp\(`\^#{1,2}\\\\s\*\$\{label\}/g) || []).length;
    ok("no parameterised extractor interpolates the raw label", rawLabel === 0, `found ${rawLabel}`);
    ok("all five parameterised extractors use blockLabelPattern (3 top-level + 2 sub-block)",
        (src.match(/blockLabelPattern\(label\)/g) || []).length === 5,
        String((src.match(/blockLabelPattern\(label\)/g) || []).length));
    // The two that never escaped the label now do, via the helper.
    ok("blockLabelPattern escapes regex metacharacters",
        blockLabelPattern("a+b(c)") === "a\\+b\\(c\\)", blockLabelPattern("a+b(c)"));
}

// ── 7. Step 2 has NOT happened ────────────────────────────────────────────
{
    const preset = fs.readFileSync(path.join(ROOT, "lib/builtin-preset.ts"), "utf8");
    ok("checkphone preset entries still teach the legacy headings (Step 2 not finished)",
        preset.includes("#历史记录") || preset.includes("#收藏夹") || preset.includes("[标题]"), "");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
