// Shared REVERSE-AUDIT for the checkphone bundle.
//
// The teaching is the specification. Rather than grepping the engine for match sites --
// which is how Step 1 and Step 1b were scoped, and how both of them ended up incomplete --
// this walks the 26 checkphone preset entries, extracts every protocol token they actually
// TEACH, and resolves each one against the engine's alias tables.
//
// It covers all three layers in one pass, which is why Step 1c did not need a fixture of
// its own: block headings, plain field names, and the INDEXED field names assembled per
// row (`[消息1正文]` / `[Message1Body]`).
//
// Consumed by _fx-checkphone-fields.mjs and _fx-checkphone-blocks.mjs. Run directly for a
// per-entry report:  node _fx-checkphone-taught.mjs [entry_id]
import fs from "node:fs";
import { createJiti } from "jiti";

const ROOT = process.cwd();
const jiti = createJiti(ROOT, { jsx: true, interopDefault: true, alias: { "@": ROOT } });
const E = await jiti.import("./lib/checkphone-engine.ts");
const { CHECKPHONE_FIELD_ALIASES, CHECKPHONE_BLOCK_ALIASES, CHECKPHONE_INDEX_PREFIX_ALIASES } = E;

export const CJK = /[一-鿿]/;

/**
 * Which entries have been flipped to English, in order.
 *
 * Grows one batch at a time. An entry NOT listed here is asserted to still teach legacy
 * Chinese, so the tracker cannot go stale by omission; an entry listed here is asserted to
 * teach only names the parsers resolve.
 */
export const STEP2_FLIPPED = new Set([
  // batch 0 — the one JSON-parsed entry, flipped ahead of Step 1b (8cf829f)
  "checkphone_manifest",
  // batch 1
  "checkphone_browser",
  "checkphone_notes",
  "checkphone_assets",
  "checkphone_user_fact_guard",
  "checkphone_bilingual_text",
]);

/**
 * Assert everything one FLIPPED entry teaches is resolvable, and that a PENDING one has
 * not been half-flipped behind the tracker's back.
 *
 * Note the rule for flipped entries: no bare `#` line may survive as a prose header. In
 * this format a line beginning with `#` IS protocol syntax, so using it for a section
 * title invites the model to imitate it and emit a block heading that parses as nothing.
 */
export function assertEntry(ok, entry, flipped) {
  const a = auditEntry(entry);
  if (flipped) {
    ok(`${entry.id}: no CJK left`, a.cjkLines.length === 0,
      a.cjkLines.slice(0, 3).map((x) => x.n + ": " + x.l.trim()).join("\n"));
    ok(`${entry.id}: every taught heading resolves`, a.badHeadings.length === 0,
      a.badHeadings.map((h) => h.level + h.name).join("  "));
    ok(`${entry.id}: every taught field token resolves`, a.badFields.length === 0,
      a.badFields.map((f) => "[" + f + "]").join(" "));
  } else {
    ok(`${entry.id}: still pending, so still teaches legacy Chinese`, a.cjkLines.length > 0, "0 CJK lines");
  }
  return a;
}

export const ALL_CHECKPHONE_ENTRIES = [
  "checkphone_manifest", "checkphone_chat", "checkphone_phone", "checkphone_shopping",
  "checkphone_assets", "checkphone_browser", "checkphone_photos", "checkphone_messages",
  "checkphone_notes", "checkphone_takeout", "checkphone_email", "checkphone_douyin",
  "checkphone_telegram", "checkphone_steam", "checkphone_reddit", "checkphone_x",
  "checkphone_youtube", "checkphone_bilibili", "checkphone_instagram", "checkphone_douban",
  "checkphone_reading", "checkphone_music", "checkphone_weibo", "checkphone_xiaohongshu",
  "checkphone_user_fact_guard", "checkphone_bilingual_text",
];

// ── Locate the entries structurally ───────────────────────────────────────────
// NOT by indexOf('identifier: "x"') -- that finds the prompt_order toggle list near the
// top of the file, which shadows every entry and makes "legacy is gone" pass vacuously.
export function readEntries() {
  const lines = fs.readFileSync("lib/builtin-preset.ts", "utf8").split(/\r?\n/);
  const marks = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s{16}identifier:\s*"([a-z_0-9]+)"/i);
    if (m) marks.push({ id: m[1], start: i });
  });
  marks.forEach((x, k) => (x.end = k + 1 < marks.length ? marks[k + 1].start : lines.length));
  const out = new Map();
  for (const m of marks) {
    if (!m.id.startsWith("checkphone")) continue;
    out.set(m.id, {
      id: m.id,
      start: m.start + 1,
      end: m.end,
      lines: lines.slice(m.start, m.end),
      text: lines.slice(m.start, m.end).join("\n"),
    });
  }
  return out;
}

// ── Extract what an entry TEACHES ─────────────────────────────────────────────
const ENGLISH_BLOCK = new Map(); // english (lower) -> legacy
const ENGLISH_FIELD = new Map();
for (const [legacy, aliases] of Object.entries(CHECKPHONE_BLOCK_ALIASES)) {
  for (const a of aliases) ENGLISH_BLOCK.set(a.toLowerCase(), legacy);
}
for (const [legacy, aliases] of Object.entries(CHECKPHONE_FIELD_ALIASES)) {
  for (const a of aliases) ENGLISH_FIELD.set(a.toLowerCase(), legacy);
}
const PREFIXES = Object.entries(CHECKPHONE_INDEX_PREFIX_ALIASES ?? {}).flatMap(([legacy, aliases]) =>
  aliases.map((a) => [a.toLowerCase(), legacy]),
);

/** Split an indexed token into [prefix, index, suffix], or null. */
export function splitIndexed(token) {
  const lowered = token.toLowerCase();
  for (const [alias, legacy] of PREFIXES) {
    if (!lowered.startsWith(alias)) continue;
    const m = lowered.slice(alias.length).match(/^(\d+|n)(.*)$/);
    if (m) return { prefix: legacy, index: m[1], suffix: m[2] };
  }
  return null;
}

/**
 * Bracket tokens that are legitimately absent from the alias tables.
 *
 * The three reddit ones are genuine field names that were ALREADY English before this
 * migration and have no legacy Chinese form; the engine reads them directly at
 * checkphone-engine.ts:2602-2604. `吃瓜` is not a tag at all — it is the counter-example
 * in the line telling the model NOT to write emoji as a bracketed word.
 */
export const NON_ALIASED_FIELD_TOKENS = new Set([
  "Post Karma", "Comment Karma", "Cake Day",
  "吃瓜", "popcorn",
]);

/** Does the engine resolve this bracket token? */
export function resolveFieldToken(token) {
  const t = token.trim();
  if (!t) return { kind: "empty", ok: false };
  if (NON_ALIASED_FIELD_TOKENS.has(t)) return { kind: "allowed", ok: true };
  if (ENGLISH_FIELD.has(t.toLowerCase())) return { kind: "field", ok: true, legacy: ENGLISH_FIELD.get(t.toLowerCase()) };
  const idx = splitIndexed(t);
  if (idx) {
    if (!idx.suffix) return { kind: "indexed", ok: true, legacy: `${idx.prefix}N` };
    if (ENGLISH_FIELD.has(idx.suffix)) return { kind: "indexed", ok: true, legacy: `${idx.prefix}N${ENGLISH_FIELD.get(idx.suffix)}` };
    return { kind: "indexed", ok: false, reason: `unknown suffix "${idx.suffix}"` };
  }
  return { kind: "unknown", ok: false };
}

export function resolveHeading(name) {
  const t = name.trim().replace(/\d+$/, "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (ENGLISH_BLOCK.has(t.toLowerCase())) return { ok: true, legacy: ENGLISH_BLOCK.get(t.toLowerCase()) };
  return { ok: false, reason: "not in CHECKPHONE_BLOCK_ALIASES" };
}

/**
 * Everything one entry teaches.
 *
 * `headings` are lines that are ONLY a #/## heading -- prose section headers written with
 * markdown `#` are excluded by requiring the line to be nothing else, and by rejecting any
 * candidate that does not resolve AND contains sentence punctuation or spaces.
 */
export function taughtTokens(entry) {
  const headings = [];
  const fields = [];
  for (const line of entry.lines) {
    const sm = line.match(/^\s*"(.*)",?\s*$/);
    if (!sm) continue;
    const text = sm[1];

    const hm = text.match(/^(#{1,2})\s*([^\s#][^\s]*)\s*$/);
    if (hm) headings.push({ level: hm[1], name: hm[2], raw: text });

    for (const fm of text.matchAll(/\[([^\][\n]{1,24})\]/g)) fields.push(fm[1]);
  }
  return { headings, fields: [...new Set(fields)] };
}

/** Per-entry audit result. */
export function auditEntry(entry) {
  const { headings, fields } = taughtTokens(entry);
  const badHeadings = headings.filter((h) => !resolveHeading(h.name).ok);
  const badFields = fields.filter((f) => !resolveFieldToken(f).ok);
  // CJK anywhere in the entry, ignoring the `name:` display label handled separately
  const cjkLines = entry.lines
    .map((l, i) => ({ n: entry.start + i, l }))
    .filter((x) => CJK.test(x.l));
  return { id: entry.id, headings, fields, badHeadings, badFields, cjkLines };
}

// ── Report mode ───────────────────────────────────────────────────────────────
// (compare basenames — on Windows import.meta.url is file:///D:/… while argv[1] is D:\…)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const only = process.argv[2];
  const entries = readEntries();
  for (const [id, entry] of entries) {
    if (only && id !== only) continue;
    const a = auditEntry(entry);
    const flipped = STEP2_FLIPPED.has(id);
    console.log(`\n=== ${id}  [${flipped ? "FLIPPED" : "pending"}]  ${a.cjkLines.length} CJK lines`);
    if (only) {
      console.log("  headings:", a.headings.map((h) => h.level + h.name).join("  "));
      console.log("  fields  :", a.fields.map((f) => "[" + f + "]").join(" "));
    }
    if (a.badHeadings.length) console.log("  UNRESOLVED headings:", a.badHeadings.map((h) => h.level + h.name).join("  "));
    if (a.badFields.length) console.log("  UNRESOLVED fields  :", a.badFields.map((f) => "[" + f + "]").join(" "));
  }
}
