// D2 batch 9 — mascot-tools.ts, full verification.
// Run from the repo root: node _fx-mascot-tools.mjs
//
// Replaces an earlier inline `node -e` check that had two bugs of its own:
//   * it stripped tool names in declaration order, so "读取预设" chopped
//     "读取预设条目" down to a bare "条目" and reported a false positive;
//   * its shell escaping mangled the [^\w一-鿿] assertion, so the character
//     classes were never actually checked.
// Both are fixed here, and the file is kept so it can be re-run.
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

const T = await jiti.import("./lib/mascot-tools.ts");
const P = await jiti.import("./lib/mascot-prompts.ts");
const src = fs.readFileSync(path.join(ROOT, "lib/mascot-tools.ts"), "utf8");
const CJK = /[一-鿿]/;

const TOOL_NAMES = T.MASCOT_TOOL_PACKAGES.flatMap(p => p.subTools.map(t => t.name)).concat(["导航"]);
// State value names and the legacy block tags are quoted inside REGEX_PROMPT on
// purpose (see D2 batch 8); they are not untranslated prose.
const STATE_AND_TAGS = ["好感度", "占有欲", "焦虑值", "状态栏", "内心"];
// The ◇ marker names are fixed system identifiers quoted inside PRESET_PROMPT; they
// must stay Chinese (preset-manager.tsx matches them), so they are not untranslated prose.
const MARKER_NAMES = [
    "◇ 用户人设", "◇ 世界书（角色前）", "◇ 角色描述", "◇ 角色性格", "◇ 角色关系",
    "◇ 世界书（角色后）", "◇ 日程", "◇ 核心记忆", "◇ 长期记忆", "◇ [短期记忆]",
    // GENERAL_PRESET_PROMPT describes several of them in the combined shorthand the
    // original used ("◇ 世界书（角色前/后）", "◇ 核心记忆 / 长期记忆 / [短期记忆]"),
    // so the bare tails have to be allowed too.
    "◇ 世界书（角色前/后）", "长期记忆", "[短期记忆]",
];
// LONGEST FIRST — otherwise a shorter tool name eats a prefix of a longer one and
// leaves a fragment that looks like untranslated text.
const ALLOWED = [...new Set([...TOOL_NAMES, ...STATE_AND_TAGS, ...MARKER_NAMES])].sort((a, b) => b.length - a.length);
const strip = s => ALLOWED.reduce((acc, n) => acc.split(n).join(""), s);

// Guard the stripper itself: it must not be broad enough to hide real prose.
ok("stripper leaves ordinary Chinese prose visible", CJK.test(strip("这是一段没有翻译的说明文字")));
ok("stripper does not fragment the longest tool name",
    strip("读取预设条目") === "", JSON.stringify(strip("读取预设条目")));

// ── 1. The deliberate keeps are INTACT ─────────────────────────────────────
// These are the whole reason the file still contains CJK; if any vanished, the
// translation went too far.
{
    const MARKERS = [
        "◇ 用户人设", "◇ 世界书（角色前）", "◇ 角色描述", "◇ 角色性格", "◇ 角色关系",
        "◇ 世界书（角色后）", "◇ 日程", "◇ 核心记忆", "◇ 长期记忆", "◇ [短期记忆]",
    ];
    MARKERS.forEach(m => ok(`marker "${m}" still in the map`, src.includes(`"${m}":`), m));

    // preset-manager.tsx matches these names; the map is what turns them into
    // identifiers when the mascot creates a marker entry.
    const pm = fs.readFileSync(path.join(ROOT, "components/settings/preset-manager.tsx"), "utf8");
    ok("preset-manager still matches the ◇ marker family", MARKERS.some(m => pm.includes(m)));

    // Two character classes that PERMIT CJK in generated identifiers. Written with a
    // plain string search so no shell or regex escaping can corrupt the check.
    const charClassCount = src.split("[^\\w一-鿿]").length - 1;
    ok("both [^\\w一-鿿] character classes survive", charClassCount === 2, `found ${charClassCount}`);

    // resolveRegexTags accepts Chinese input typed by the user.
    ["群聊", "剧情", "故事", "线下"].forEach(w => {
        ok(`tag resolver still accepts "${w}"`, src.includes(`has("${w}")`), w);
    });

    ok("all 7 packs kept a legacyLabel", T.MASCOT_TOOL_PACKAGES.every(p => !!p.legacyLabel),
        T.MASCOT_TOOL_PACKAGES.filter(p => !p.legacyLabel).map(p => p.id).join(","));
}

// ── 2. Every tool still reaches the dispatcher ─────────────────────────────
{
    const names = T.MASCOT_TOOL_PACKAGES.flatMap(p => p.subTools.map(t => t.name));
    ok(`${names.length} tools declared`, names.length >= 40, String(names.length));
    names.forEach(n => ok(`"${n}" has a dispatcher case`, src.includes(`case "${n}":`), n));
    names.forEach(n => ok(`"${n}" has a native id`, new RegExp(`"${n}":\\s*"mascot_`).test(src), n));
}

// ── 3. Pack labels are English and resolve both ways ───────────────────────
T.MASCOT_TOOL_PACKAGES.forEach(p => {
    ok(`${p.id} label is English`, !CJK.test(p.label), p.label);
    ok(`${p.id} resolves by English label`, T.findPackageByLabel(p.label)?.id === p.id);
    ok(`${p.id} resolves by legacy label`, T.findPackageByLabel(p.legacyLabel)?.id === p.id, p.legacyLabel);
    ok(`${p.id} description is English`, !CJK.test(strip(p.description)), strip(p.description));
    p.subTools.forEach(t => {
        ok(`${p.id}/${t.name} description is English`, !CJK.test(strip(t.description)), strip(t.description));
    });
});

// ── 4. Expanded pack schemas ───────────────────────────────────────────────
// The expanded schema appends the pack's usageGuide, which for css_pack and
// worldbook_pack comes from mascot-prompts.ts — still unfinished. So the assertion
// is scoped to what mascot-tools.ts itself renders, and the two guides are asserted
// separately as KNOWN outstanding, so this fixture starts failing the moment
// mascot-prompts.ts is done and someone forgets to update it.
// Strip the pack's OWN usageGuide field rather than a hand-maintained list — that
// also covers preset_pack, whose guide is composed from two constants at once.
T.MASCOT_TOOL_PACKAGES.forEach(p => {
    const full = T.buildMascotPackageSchemaPrompt(p.label);
    const own = p.usageGuide ? full.split(p.usageGuide).join("") : full;
    ok(`${p.id} schema rendered by mascot-tools is English`, !CJK.test(strip(own)),
        strip(own).split("\n").filter(l => CJK.test(l))[0]);
});

// The guides live in mascot-prompts.ts. Pinning their CURRENT state means this
// fixture starts failing the moment that file is finished and nobody updates it —
// which is the point: it should not silently keep passing on a stale assumption.
const GUIDE_STATE = [
    ["CHARACTER_CARD_PROMPT", P.CHARACTER_CARD_PROMPT, false],
    ["REGEX_PROMPT", P.REGEX_PROMPT, false],
    ["WIDGET_PROMPT", P.WIDGET_PROMPT, false],
    ["WORLDBOOK_PROMPT", P.WORLDBOOK_PROMPT, false],
    ["PRESET_PROMPT", P.PRESET_PROMPT, false],
    ["GENERAL_PRESET_PROMPT", P.GENERAL_PRESET_PROMPT, false],
    ["CSS_PROMPT", P.CSS_PROMPT, false],
];
// PRESET_PROMPT keeps the 10 ◇ marker names and 5 tool names by design, so it is
// checked against the same allow-list as everything else rather than a bare CJK test.
GUIDE_STATE.forEach(([name, text, expectChinese]) => {
    // REGEX_PROMPT legitimately quotes state names and legacy tags.
    const body = strip(String(text));
    ok(expectChinese ? `KNOWN OUTSTANDING: ${name} still Chinese` : `done: ${name} is English`,
        CJK.test(body) === expectChinese,
        body.split("\n").filter(l => CJK.test(l))[0]);
});

// ── 5. The compact tool list ───────────────────────────────────────────────
{
    const list = T.buildMascotToolsListPrompt();
    ok("tool list is English apart from tool names", !CJK.test(strip(list)),
        strip(list).split("\n").filter(l => CJK.test(l))[0]);
    ok("tool list teaches [FetchTool:", list.includes("[FetchTool:"));
    ok("tool list teaches [CallTool:", list.includes("[CallTool:"));
    T.MASCOT_TOOL_PACKAGES.forEach(p => {
        ok(`tool list advertises "${p.label}"`, list.includes(`【${p.label}】`), p.label);
    });

    // The taught call syntax must survive the real execution parser.
    const { parseToolCalls } = await jiti.import("./lib/tool-executor.ts");
    const example = (list.match(/\[CallTool:导航\(\{[^\]]*\}\)\]/) || [])[0];
    ok("navigate example present", !!example);
    if (example) {
        const { toolCalls } = parseToolCalls(example);
        ok("navigate example parses", toolCalls.length === 1 && toolCalls[0].name === "导航", JSON.stringify(toolCalls));
    }
}

// ── 6. Expanded-pack call syntax matches the tool list ─────────────────────
{
    const sch = T.buildMascotPackageSchemaPrompt("Regex Pack");
    ok("expanded schema teaches [CallTool:", sch.includes("[CallTool:"), sch.slice(0, 120));
    ok("expanded schema no longer teaches the legacy directive", !sch.includes("[执行动作:"));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
