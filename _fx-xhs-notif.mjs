// Xiaohongshu notification texts — producer/consumer round trip.
// Run from the repo root: node _fx-xhs-notif.mjs
//
// The consumers were made bilingual BEFORE the producers were flipped, because
// notifications already stored carry the legacy Chinese wording and nothing rewrites
// them. This pins both directions.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) pass++;
    else { fail++; console.log("FAIL:", n, x === undefined ? "" : "\n      " + String(x).slice(0, 300)); }
};

const appSrc = fs.readFileSync(path.join(ROOT, "components/xiaohongshu/xiaohongshu-app.tsx"), "utf8");
const engSrc = fs.readFileSync(path.join(ROOT, "lib/xiaohongshu-engine.ts"), "utf8");

// Lift the two shared regexes out of the component so the fixture tests the real
// patterns rather than a copy that could drift.
const grab = name => {
    const m = appSrc.match(new RegExp(`const ${name} = (/[\\s\\S]*?/[gimsuy]*);`));
    if (!m) throw new Error("could not extract " + name);
    // eslint-disable-next-line no-eval
    return eval(m[1]);
};
const COUNT_RE = grab("NOTIFICATION_COUNT_RE");
const ACTOR_RE = grab("NOTIFICATION_ACTOR_RE");

const countOf = t => { const m = t.match(COUNT_RE); return m ? m[1].trim() : null; };
const actorOf = t => { const m = t.match(ACTOR_RE); return m ? m[1].trim() : null; };

// ── 1. The current English wording round-trips ────────────────────────────
{
    const t = "Ann, Bob and 12 people liked your note";
    ok("English: count extracted", countOf(t) === "12", countOf(t));
    ok("English: actor prefix extracted", actorOf(t) === "Ann, Bob", actorOf(t));

    const saved = "Ann and 3 people saved your note";
    ok("English save form: count", countOf(saved) === "3", countOf(saved));
    ok("English save form: actor", actorOf(saved) === "Ann", actorOf(saved));

    // Compact counts must still parse in the English form.
    const compact = "Ann and 12k people liked your note";
    ok("English: compact count 12k", countOf(compact) === "12k", countOf(compact));
}

// ── 2. Legacy Chinese notifications still parse ───────────────────────────
{
    const t = "小明、小红等12人赞了你的笔记";
    ok("legacy: count extracted", countOf(t) === "12", countOf(t));
    ok("legacy: actor prefix extracted", actorOf(t) === "小明、小红", actorOf(t));

    const compact = "小明等3.5万人收藏了你的笔记";
    ok("legacy: compact 万 count", countOf(compact) === "3.5万", countOf(compact));
}

// ── 3. Single-actor notifications have no count clause ────────────────────
// Those fall back to 1 and to notice.actorName, which is the pre-existing behaviour.
["Ann liked your note", "Ann saved this note", "小明 赞了你的笔记"].forEach(t => {
    ok(`single-actor "${t.slice(0, 22)}…": no count match`, countOf(t) === null, countOf(t));
    ok(`single-actor "${t.slice(0, 22)}…": no actor match`, actorOf(t) === null, actorOf(t));
});

// ── 4. Negative controls ──────────────────────────────────────────────────
ok("ordinary prose does not yield a count", countOf("Ann wrote something about people") === null,
    countOf("Ann wrote something about people"));
ok("a bare number does not yield a count", countOf("12") === null, countOf("12"));

// ── 5. The producers really did flip ──────────────────────────────────────
{
    ["赞了你的笔记", "收藏了你的笔记", "赞了这篇笔记", "收藏了这篇笔记", "等${reaction.likeCount}人"].forEach(legacy => {
        ok(`engine no longer produces "${legacy}"`, !engSrc.includes(legacy), legacy);
    });
    ["liked your note", "saved your note", "liked this note", "saved this note"].forEach(en => {
        ok(`engine produces "${en}"`, engSrc.includes(en), en);
    });
    // The number is the TOTAL in both wordings; "others" would have shifted it.
    ok("English wording says 'people', not 'others'",
        engSrc.includes("people liked your note") && !engSrc.includes("others liked your note"));
}

// ── 6. The preview stripper is bilingual AND escapes the actor name ──────
{
    ok("preview stripper accepts both languages",
        /评论了你的笔记\|回复了你\|commented on your note\|replied to you/.test(appSrc), "");
    ok("actorName is regex-escaped before interpolation",
        /actorName\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/.test(appSrc)
        || appSrc.includes('notice.actorName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")'), "");

    // Behavioural: a name with regex metacharacters must not throw or mis-strip.
    const build = (actorName, text) => {
        const actor = actorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return text.replace(new RegExp(`^${actor}\\s*(评论了你的笔记|回复了你|commented on your note|replied to you)[:：]?\\s*`, "i"), "").trim();
    };
    ok("plain name strips correctly",
        build("Ann", "Ann commented on your note: nice one") === "nice one",
        build("Ann", "Ann commented on your note: nice one"));
    ok("legacy Chinese prefix strips correctly",
        build("小明", "小明 评论了你的笔记：不错") === "不错",
        build("小明", "小明 评论了你的笔记：不错"));
    ok("a name with regex metacharacters does not throw or over-strip",
        build("A+B(1)", "A+B(1) commented on your note: hi") === "hi",
        build("A+B(1)", "A+B(1) commented on your note: hi"));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
