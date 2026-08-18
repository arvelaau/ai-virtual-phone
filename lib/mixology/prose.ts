// lib/mixology/prose.ts
// House Special — the prose semantic protocol: the app's own parser, so a creator never
// has to write a regex.
//
// Five markers (the official glassware teaches the AI to write them; garnish CSS only
// colors them in):
//   「dialogue」 -> dialogue      *inner voice* -> thought (the whole clause in italics)
//   【scene】    -> scene (on its own line, rendered as a — scene — divider)
//   ~emphasis~   -> accent        everything else -> narration
// The status-panel block [StatusPanel]...[/StatusPanel] is stripped before the prose is
// parsed, and handed to a sandboxed iframe to render.

import type { MixFilterRule } from "./types";

export type MixProseSegmentType = "dialogue" | "thought" | "accent" | "narration";

/**
 * Clean the prose with the strainer rules. Only ever called AFTER the status-panel and skit
 * blocks have been pulled out, so the rules cannot reach block data:
 * - mode="context": cleaned once before the reply is stored (called by the engine)
 * - mode="display": cleaned before rendering (called by the interface; storage untouched)
 * A rule whose regex fails to compile is skipped — one bad rule must never block a turn.
 */
export function applyMixFilterRules(
    text: string,
    rules: MixFilterRule[] | undefined,
    mode: MixFilterRule["mode"],
): string {
    if (!text || !rules?.length) return text;
    let out = text;
    for (const rule of rules) {
        if (rule.mode !== mode || !rule.find) continue;
        try {
            out = out.replace(new RegExp(rule.find, "g"), rule.replace ?? "");
        } catch {
            // Malformed regex: drop this rule, keep the rest
        }
    }
    return out;
}

export type MixProseSegment = {
    type: MixProseSegmentType;
    text: string;
};

export type MixProseParagraph =
    | { type: "scene"; text: string }
    | { type: "text"; segments: MixProseSegment[] };

// Accepts the English tag name this fork teaches, plus the legacy Chinese names and the
// older aliases upstream already tolerated ([小票]/[尾调]), full-width brackets, and spaces
// inside the tag — model output is never that tidy.
type TagFamily = { open: RegExp; close: RegExp; openLine: RegExp };

function makeFamily(names: string): TagFamily {
    return {
        open: new RegExp(`[\\[【]\\s*(?:${names})\\s*[\\]】]`, "gi"),
        close: new RegExp(`[\\[【]\\s*\\/\\s*(?:${names})\\s*[\\]】]`, "gi"),
        // The truncation fallback only accepts an opening tag at the START of a line, so
        // prose that merely mentions a tag by name is not mistaken for one
        openLine: new RegExp(`(?:^|\\n)\\s*[\\[【]\\s*(?:${names})\\s*[\\]】]`, "gi"),
    };
}

const TICKET_TAGS = makeFamily("StatusPanel|状态栏|小票");
const ENCORE_TAGS = makeFamily("Skit|小剧场|尾调");

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
    re.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) last = m;
    return last;
}

/** Pairing strategy is "the last closing tag, and the nearest opening tag before it", so
 *  prose that mentions a tag by name cannot swallow the reply */
function pullFamily(text: string, tags: TagFamily): { text: string; raw?: string } {
    let raw: string | undefined;
    for (;;) {
        const close = lastMatch(tags.close, text);
        if (!close) break;
        const open = lastMatch(tags.open, text.slice(0, close.index));
        if (!open) break;
        const inner = text.slice(open.index + open[0].length, close.index).trim();
        if (!raw && inner) raw = inner;
        text = (text.slice(0, open.index) + text.slice(close.index + close[0].length)).trim();
    }
    return { text, raw };
}

/** Strip the status-panel and skit blocks out of the AI's raw reply. If the closing tag is
 *  missing (a truncated generation), fall back to an opening tag at the start of a line. */
export function extractMixBlocks(rawInput: string): { text: string; ticketRaw?: string; encoreRaw?: string } {
    const afterEncore = pullFamily(rawInput, ENCORE_TAGS);
    const afterTicket = pullFamily(afterEncore.text, TICKET_TAGS);
    let text = afterTicket.text;
    let ticketRaw = afterTicket.raw;
    let encoreRaw = afterEncore.raw;
    if (!ticketRaw || !encoreRaw) {
        const tOpen = ticketRaw ? null : lastMatch(TICKET_TAGS.openLine, text);
        const eOpen = encoreRaw ? null : lastMatch(ENCORE_TAGS.openLine, text);
        const pick = tOpen && eOpen ? (tOpen.index > eOpen.index ? "t" : "e") : tOpen ? "t" : eOpen ? "e" : null;
        if (pick) {
            const m = (pick === "t" ? tOpen : eOpen) as RegExpExecArray;
            const inner = text.slice(m.index + m[0].length).trim();
            if (inner) {
                if (pick === "t") ticketRaw = inner;
                else encoreRaw = inner;
                text = text.slice(0, m.index).trim();
            }
        }
    }
    return { text, ticketRaw, encoreRaw };
}

/** Back-compat entry point: only the status panel matters */
export function extractMixTicket(raw: string): { text: string; ticketRaw?: string } {
    const result = extractMixBlocks(raw);
    return { text: result.text, ticketRaw: result.ticketRaw };
}

/**
 * The taught dialogue marker is 「」, and it stays that way — it is a structural token like
 * a bracket tag, and being rare in prose is exactly what makes it unambiguous.
 *
 * Straight double quotes are ALSO accepted, because a model writing English reaches for
 * them by reflex no matter what the contract says. Without this branch the dialogue would
 * silently fall through as narration and every garnish that colors `.mix-dialogue` would
 * quietly stop working — a failure that looks like a broken stylesheet rather than a
 * parsing miss. The cost is that a scare-quoted phrase is occasionally styled as speech,
 * which is cosmetic.
 */
const INLINE_RE = /「([^」]*)」|"([^"\n]+)"|\*([^*\n]+)\*|~([^~\n]+)~/g;

function parseInline(line: string): MixProseSegment[] {
    const segments: MixProseSegment[] = [];
    let cursor = 0;
    INLINE_RE.lastIndex = 0;
    for (let match = INLINE_RE.exec(line); match; match = INLINE_RE.exec(line)) {
        if (match.index > cursor) {
            segments.push({ type: "narration", text: line.slice(cursor, match.index) });
        }
        if (match[1] !== undefined) segments.push({ type: "dialogue", text: `「${match[1]}」` });
        else if (match[2] !== undefined) segments.push({ type: "dialogue", text: `"${match[2]}"` });
        else if (match[3] !== undefined) segments.push({ type: "thought", text: match[3] });
        else segments.push({ type: "accent", text: match[4] });
        cursor = match.index + match[0].length;
    }
    if (cursor < line.length) {
        segments.push({ type: "narration", text: line.slice(cursor) });
    }
    return segments;
}

/**
 * Parse the AI's prose into a sequence of paragraphs.
 * Paragraphs split on blank lines / newlines; a line wholly wrapped in 【】 is a scene
 * divider, and everything else goes through inline parsing.
 */
export function parseMixProse(text: string): MixProseParagraph[] {
    const paragraphs: MixProseParagraph[] = [];
    for (const rawLine of text.split(/\n+/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const scene = line.match(/^【(.+)】$/);
        if (scene) {
            paragraphs.push({ type: "scene", text: scene[1].trim() });
            continue;
        }
        const segments = parseInline(line);
        if (segments.length) paragraphs.push({ type: "text", segments });
    }
    return paragraphs;
}
