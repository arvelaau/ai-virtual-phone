// lib/regex-engine.ts
// The user's regex rules (Settings -> Regex), as a LEAF module: no storage, no browser APIs, so the
// iMessage webhook (a Node route) can run them too. They used to live inside
// lib/llm-prompt-assembler.ts, whose import graph reaches IndexedDB-backed storage.
//
// Why the webhook needs them: in the app, every model reply goes through these rules before it is
// shown (hiding the state values and the inner-thought block, reformatting status text, ...).
// A reply sent over iMessage skipped them, so whatever the rules were hiding showed up on the phone.

import type { MacroEngine } from "./macro-engine";
import type { RegexConfig } from "./settings-types";

// ── Regex Processing ─────────────────

/** Context passed to the regex engine to control which rules fire. */
export type RegexContext = {
    isMarkdown?: boolean;    // true when rendering for display
    isPrompt?: boolean;      // true when assembling prompt
    isEdit?: boolean;        // true when user is editing a message
    depth?: number;          // message depth (0 = latest)
    activeTags?: string[];   // current app tags used for tag-scoped rule filtering
    macroEngine?: MacroEngine;  // for {{char}} etc. in findRegex & replaceString
};

/**
 * Parse a regex string like `/pattern/flags` into a RegExp.
 * Returns null if invalid. Does NOT force any flags — uses exactly what the user wrote.
 */
export function regexFromString(input: string): RegExp | null {
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!m) return null;
        if (m[3] && !/^(?!.*?(.).*?\1)[dgimsuyv]+$/.test(m[3])) {
            return new RegExp(input);
        }
        return new RegExp(m[2], m[3]);
    } catch {
        return null;
    }
}

/** Escape special regex chars in a macro value so it can be embedded in a findRegex pattern. */
export function sanitizeRegexMacro(x: string): string {
    if (!x || typeof x !== "string") return x;
    return x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (s) => {
        switch (s) {
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            case "\v": return "\\v";
            case "\f": return "\\f";
            case "\0": return "\\0";
            default:   return "\\" + s;
        }
    });
}

/**
 * Remove trimStrings from a string (applied to each capture-group match).
 * macroEngine is used to expand macros inside each trimString before removal.
 */
function filterString(raw: string, trimStrings: string[] | undefined, macroEngine?: MacroEngine): string {
    if (!trimStrings || trimStrings.length === 0) return raw;
    let result = raw;
    for (const ts of trimStrings) {
        const expanded = macroEngine ? macroEngine.expand(ts) : ts;
        result = result.replaceAll(expanded, "");
    }
    return result;
}

/**
 * Run a single regex rule against a string.
 * Supports: {{match}}, $0-$N, $<name>, trimStrings, macro expansion in result.
 */
export function runRegexRule(rule: import("./settings-types").RegexRule, text: string, macroEngine?: MacroEngine): string {
    if (!rule.findRegex || !text) return text;

    // --- optionally substitute macros inside the findRegex pattern ---
    let regexString = rule.findRegex;
    if (rule.substituteRegex && macroEngine) {
        if (rule.substituteRegex === 2) {
            // ESCAPED: expand each macro individually, then escape regex-special chars in the resolved value
            regexString = rule.findRegex.replace(/\{\{([^{}]*?)\}\}/gs, (_m, body: string) => {
                const wrapped = `{{${body}}}`;
                const resolved = macroEngine.expand(wrapped);
                if (resolved === wrapped) return resolved; // unresolved macro, leave as-is
                return sanitizeRegexMacro(resolved);
            });
        } else {
            // RAW: just expand macros directly
            regexString = macroEngine.expand(regexString);
        }
    }

    const findRegex = regexFromString(regexString);
    if (!findRegex) return text;

    // Reset lastIndex for global/sticky regexes
    if (findRegex.global || findRegex.sticky) {
        findRegex.lastIndex = 0;
    }

    const newString = text.replace(findRegex, function (...args: unknown[]) {
        // Bridge {{match}} → $0
        const replaceStr = (rule.replaceString || "").replace(/\{\{match\}\}/gi, "$0");

        // Custom group replacement: handle $0, $1...$N, $<name> with trimStrings
        const replaced = replaceStr.replace(
            /\$(\d+)|\$<([^>]+)>/g,
            (_: string, num?: string, groupName?: string) => {
                let match: string | undefined;
                if (num !== undefined) {
                    match = args[Number(num)] as string | undefined;
                } else if (groupName) {
                    // Named group: last argument is the groups object
                    const groups = args[args.length - 1] as Record<string, string> | undefined;
                    match = groups && typeof groups === "object" ? groups[groupName] : undefined;
                }
                if (!match) return "";
                return filterString(match, rule.trimStrings, macroEngine);
            },
        );

        // Final macro substitution on the whole replacement result
        return macroEngine ? macroEngine.expand(replaced) : replaced;
    });

    return newString;
}

/**
 * Determine whether a rule should fire given the current context.
 * Applies rule filtering for display, prompt, edit, depth, and tag contexts.
 */
function shouldRunRule(
    rule: import("./settings-types").RegexRule,
    placement: number,
    ctx: RegexContext,
): boolean {
    if (rule.disabled) return false;
    if (!rule.placement?.includes(placement)) return false;
    if (rule.tags && rule.tags.length > 0 && !rule.tags.every((tag) => (ctx.activeTags ?? []).includes(tag))) return false;

    // markdownOnly / promptOnly / default filtering
    const { isMarkdown = false, isPrompt = false, isEdit = false, depth } = ctx;
    const md = rule.markdownOnly === true;
    const po = rule.promptOnly === true;
    const fires =
        (md && isMarkdown) ||
        (po && isPrompt) ||
        (!md && !po && !isMarkdown && !isPrompt);
    if (!fires) return false;

    // runOnEdit gate
    if (isEdit && !rule.runOnEdit) return false;

    // depth filtering
    if (typeof depth === "number") {
        if (rule.minDepth != null && rule.minDepth >= -1 && depth < rule.minDepth) return false;
        if (rule.maxDepth != null && rule.maxDepth >= 0 && depth > rule.maxDepth) return false;
    }

    return true;
}

/** Apply regex rules that match a given placement + context. */
export function applyRegex(text: string, regexGroups: RegexConfig[], placement: number, ctx: RegexContext = {}): string {
    let result = text;
    for (const group of regexGroups) {
        for (const rule of group.rules) {
            if (!shouldRunRule(rule, placement, ctx)) continue;
            try {
                result = runRegexRule(rule, result, ctx.macroEngine);
            } catch {
                // Ignore bad regex rules safely
            }
        }
    }
    return result;
}

/**
 * Rules for a channel that can only show PLAIN TEXT (iMessage).
 *
 * - normal output rules (placement 2) run exactly as in the app;
 * - "display only" rules (markdownOnly) are rules that restyle text for the app's screen, usually
 *   into HTML, which is garbage in a text message. The exception is a display rule that REPLACES
 *   WITH NOTHING: its whole job is to hide something (a state-value tag, a status block), and that is
 *   exactly what has to happen here too, so those run as well.
 */
export function applyPlainTextOutputRegex(text: string, regexGroups: RegexConfig[], ctx: RegexContext = {}): string {
    const adapted = regexGroups.map((group) => ({
        ...group,
        rules: group.rules.map((rule) => (
            rule.markdownOnly === true && !(rule.replaceString ?? "").trim()
                ? { ...rule, markdownOnly: false }
                : rule
        )),
    }));
    return applyRegex(text, adapted, 2, ctx);
}
