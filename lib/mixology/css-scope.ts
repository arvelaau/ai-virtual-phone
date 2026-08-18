// lib/mixology/css-scope.ts
// House Special -- scoping garnish CSS.
//
// A garnish is a material people share with each other, but its content is CSS, and CSS
// injected into the page applies globally: a single body { display: none } blanks the whole
// app. Receipts and encores run inside sandboxed iframes and have no such problem -- the
// garnish is the ONLY kind of shareable code that goes straight into the main document, so
// it has to be caged first.
//
// The approach: prefix every rule's selector with the session screen's scope selector, so a
// garnish can reach nothing beyond the session screen. The body / html / :root that creators
// habitually write are rewritten to the scope root itself, because what they meant was
// "this whole screen".
//
// This is a hand-written scanner rather than a regex: CSS contains comments, strings, nested
// braces and grouped at-rules, none of which a regex handles cleanly -- and handling them
// uncleanly means somebody else's garnish gets mangled, or escapes the cage.

/** The scope class on the session screen's root node */
export const MIX_GARNISH_SCOPE = ".mix-garnish-scope";

/** Size ceiling for the whole stylesheet; anything past it is cut, so an enormous garnish
 *  cannot drag rendering down */
const MAX_CSS_LENGTH = 200_000;

/** at-rules dropped outright: they pull in external stylesheets, which is both a privacy
 *  problem and an availability one */
const DROPPED_AT_RULES = new Set(["import", "charset", "namespace"]);

/** at-rules whose bodies contain no selectors: keep the block verbatim and do not touch the
 *  0% / from / to inside */
const OPAQUE_AT_RULES = new Set(["keyframes", "font-face", "counter-style", "property", "page", "font-feature-values"]);

/** Grouped at-rules whose bodies are ordinary rules: keep the prelude, recurse into the body */
const NESTED_AT_RULES = new Set(["media", "supports", "layer", "container", "scope", "document"]);

/** Writing any of these means "this whole screen", so rewrite them to the scope root itself */
const ROOT_SELECTORS = new Set([":root", "html", "body", "*", ":scope", "html body"]);

type Cursor = { text: string; pos: number };

function skipWhitespaceAndComments(cur: Cursor): void {
    for (;;) {
        while (cur.pos < cur.text.length && /\s/.test(cur.text[cur.pos])) cur.pos += 1;
        if (cur.text.startsWith("/*", cur.pos)) {
            const end = cur.text.indexOf("*/", cur.pos + 2);
            cur.pos = end < 0 ? cur.text.length : end + 2;
            continue;
        }
        return;
    }
}

/** Read from here to this level's { or ; (skipping strings and comments), returning the text
 *  and which terminator stopped it */
function readPrelude(cur: Cursor): { text: string; terminator: "{" | ";" | "" } {
    const start = cur.pos;
    let depth = 0;
    while (cur.pos < cur.text.length) {
        const ch = cur.text[cur.pos];
        if (ch === "/" && cur.text.startsWith("/*", cur.pos)) {
            const end = cur.text.indexOf("*/", cur.pos + 2);
            cur.pos = end < 0 ? cur.text.length : end + 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            cur.pos = skipString(cur.text, cur.pos);
            continue;
        }
        if (ch === "(" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
        else if (depth === 0 && (ch === "{" || ch === ";")) {
            const text = cur.text.slice(start, cur.pos);
            cur.pos += 1;
            return { text, terminator: ch };
        }
        cur.pos += 1;
    }
    return { text: cur.text.slice(start, cur.pos), terminator: "" };
}

function skipString(text: string, pos: number): number {
    const quote = text[pos];
    let i = pos + 1;
    while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) return i + 1;
        i += 1;
    }
    return text.length;
}

/** Read from after a { to its matching }, returning the body text without either brace */
function readBlock(cur: Cursor): string {
    const start = cur.pos;
    let depth = 1;
    while (cur.pos < cur.text.length) {
        const ch = cur.text[cur.pos];
        if (ch === "/" && cur.text.startsWith("/*", cur.pos)) {
            const end = cur.text.indexOf("*/", cur.pos + 2);
            cur.pos = end < 0 ? cur.text.length : end + 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            cur.pos = skipString(cur.text, cur.pos);
            continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                const text = cur.text.slice(start, cur.pos);
                cur.pos += 1;
                return text;
            }
        }
        cur.pos += 1;
    }
    return cur.text.slice(start, cur.pos);
}

/** Split a selector list on top-level commas (commas inside parens, brackets or strings do
 *  not count) */
function splitSelectorList(selector: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < selector.length; i += 1) {
        const ch = selector[i];
        if (ch === '"' || ch === "'") { i = skipString(selector, i) - 1; continue; }
        if (ch === "(" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) {
            parts.push(selector.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(selector.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
}

/** Attach the scope to one selector */
function scopeOne(selector: string, scope: string): string[] {
    const trimmed = selector.trim();
    if (!trimmed) return [];
    // Leave & in native nesting for the browser to resolve against its parent rule; the outer
    // level has already been constrained
    if (trimmed.startsWith("&")) return [trimmed];
    const normalized = trimmed.replace(/\s+/g, " ");
    if (ROOT_SELECTORS.has(normalized)) return [scope];
    // html xxx / body xxx / :root xxx: swap that leading piece for the scope root
    const rootPrefix = /^(?::root|html|body)\s+(.*)$/.exec(normalized);
    if (rootPrefix) return [`${scope} ${rootPrefix[1]}`];
    // It may be a descendant of the scope root, or the root itself (a creator writing
    // .mix-game directly). The second form can only be spelled legally when the selector
    // starts with a class, id, attribute or pseudo-class.
    const results = [`${scope} ${trimmed}`];
    if (/^[.#[:]/.test(trimmed)) results.push(`${scope}${trimmed}`);
    return results;
}

function scopeSelectorList(selector: string, scope: string): string {
    const scoped = splitSelectorList(selector).flatMap((part) => scopeOne(part, scope));
    return scoped.join(", ");
}

function transform(css: string, scope: string, depth: number): string {
    // Grouped at-rules nested this deep are almost certainly constructed, so stop descending
    if (depth > 8) return "";
    const cur: Cursor = { text: css, pos: 0 };
    const out: string[] = [];
    for (;;) {
        skipWhitespaceAndComments(cur);
        if (cur.pos >= cur.text.length) break;
        // A stray closing brace: skip it rather than let it derail everything after it
        if (cur.text[cur.pos] === "}") { cur.pos += 1; continue; }
        const { text: prelude, terminator } = readPrelude(cur);
        const head = prelude.trim();
        if (head.startsWith("@")) {
            const name = (/^@([\w-]+)/.exec(head)?.[1] ?? "").toLowerCase();
            if (terminator === "{") {
                const block = readBlock(cur);
                if (DROPPED_AT_RULES.has(name)) continue;
                if (OPAQUE_AT_RULES.has(name)) { out.push(`${head}{${block}}`); continue; }
                if (NESTED_AT_RULES.has(name)) { out.push(`${head}{${transform(block, scope, depth + 1)}}`); continue; }
                // An unrecognized grouped at-rule: treat its body as ordinary rules rather than
                // letting unknown semantics through
                out.push(`${head}{${transform(block, scope, depth + 1)}}`);
                continue;
            }
            // A single-line at-rule such as @import: drop the ones that must go, keep the rest
            if (!DROPPED_AT_RULES.has(name) && head) out.push(`${head};`);
            continue;
        }
        if (terminator !== "{") continue; // bare text with no block: drop it
        const block = readBlock(cur);
        const scoped = scopeSelectorList(head, scope);
        if (!scoped) continue;
        out.push(`${scoped}{${block}}`);
    }
    return out.join("\n");
}

/**
 * The root survival rule. A garnish that writes body { display: none } gets folded onto the
 * scope root, which would hide the session screen together with its back button -- leaving
 * the player looking at a blank screen with no way out.
 * These few properties are pinned back on AFTER the fold, with one more level of specificity
 * than a garnish's own selector so they still win when both are !important. Everything else
 * -- color, fonts, spacing -- is left entirely alone, so creators keep their freedom.
 */
function rootGuard(scope: string): string {
    const props = [
        "display: flex !important",
        "visibility: visible !important",
        "opacity: 1 !important",
        "pointer-events: auto !important",
    ];
    return `${scope}${scope}{${props.join(";")}}`;
}

/**
 * Confine garnish CSS to the session screen.
 * Returns text that can go straight into a <style> tag, or an empty string when the input is
 * empty or consists entirely of dropped rules.
 */
export function scopeMixCss(css: string, scope: string = MIX_GARNISH_SCOPE): string {
    const source = (css ?? "").slice(0, MAX_CSS_LENGTH);
    if (!source.trim()) return "";
    let scoped: string;
    try {
        scoped = transform(source, scope, 0);
    } catch {
        // If it cannot be parsed, drop the whole thing: better that this garnish does nothing
        // than that half-processed CSS reaches the page
        return "";
    }
    if (!scoped.trim()) return "";
    return `${scoped}\n${rootGuard(scope)}`;
}
