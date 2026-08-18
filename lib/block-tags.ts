// Block-level protocol tag names, bilingual.
//
// This module deliberately has NO imports. Both the read side
// (rich-message-parser) and the write-back side (prompt-sanitizer) need these
// names, and prompt-sanitizer is imported by chat-engine — importing them from
// rich-message-parser instead would close a cycle
// (prompt-sanitizer -> rich-message-parser -> action-parser -> follow-up-service
// -> chat-engine -> prompt-sanitizer) and leave these arrays `undefined` at
// module-init time.
//
// First entry is the legacy Chinese name, still present in saved history and in
// the group-chat preset; second is the going-forward English name.
export const BLOCK_TAG_STATUS_PANEL = ["状态栏", "StatusPanel"];
export const BLOCK_TAG_INNER = ["内心", "InnerThoughts"];

// Some reasoning models (MiniMax M2 among them) write <think>…</think> as literal
// text inside the content string rather than only exposing it through the separate
// reasoning_content API field. Nothing downstream expects that: message-bubble
// renders content through ReactMarkdown with rehypeRaw, so a literal <think> reaches
// the DOM and React warns "The tag <think> is unrecognized in this browser".
//
// Group chat never showed this because parseGroupChatResponse discards any line
// before the first [Name]: prefix — an incidental filter, not a deliberate one. The
// 1:1 path has no such gate, so it has to be stripped explicitly.
const REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// An opener with no closer means the reasoning ran to the end of the text (a cut-off
// stream, or a model that simply never closed it): drop from the opener onwards.
const REASONING_OPEN_RE = /<(?:think|thinking)\b[^>]*>[\s\S]*$/i;

/** Removes literal <think>/<thinking> reasoning that a model wrote into its content. */
export function stripReasoningTags(text: string): string {
    if (!text) return "";
    let out = text.replace(REASONING_BLOCK_RE, "");
    if (/<(?:think|thinking)\b/i.test(out)) out = out.replace(REASONING_OPEN_RE, "");
    // A stray closer can survive when the opener arrived in an earlier stream chunk.
    out = out.replace(/<\/(?:think|thinking)\s*>/gi, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
}

function aliasAlternation(tags: readonly string[]): string {
    return tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/**
 * A well-formed block, e.g. [InnerThoughts]…[/InnerThoughts].
 *
 * Open and close may use DIFFERENT aliases of the SAME block ([InnerThoughts]…[/内心]).
 * An earlier version pinned them together with a backreference; during this bilingual
 * window that just leaked, because the preset teaches English while saved history still
 * shows Chinese and models mix the two. Cross-BLOCK matching stays impossible regardless,
 * since every regex is built from one block's own alias list.
 */
export function closedBlockRegex(tags: readonly string[]): RegExp {
    const alias = aliasAlternation(tags);
    return new RegExp(`\\[(?:${alias})\\]([\\s\\S]*?)\\[\\/(?:${alias})\\]`, "g");
}

/**
 * An UNTERMINATED block: an opening tag whose closer never arrived.
 *
 * This is the same defect class stripReasoningTags already handles for <think>, and it
 * is what leaked "[InnerThoughts]Easiest request ever…" into a raw group-chat bubble:
 * both the display parser and the prompt-replay stripper only ever matched closed pairs,
 * so an unclosed opener fell through as ordinary visible text. Native tool calling makes
 * it far more likely, because the assistant turn is cut short by the tool call.
 *
 * Consumes to the end of that LINE, not to the end of the text: the taught format keeps
 * the block on a single line with the message body on the next (builtin-preset.ts:439
 * and :1034), so stopping at the newline removes the leak without ever swallowing a real
 * message. A genuinely multi-line unclosed block still leaks its 2nd line onward — that
 * is deliberate, since guessing a longer span risks deleting a real reply.
 */
export function unclosedBlockRegex(tags: readonly string[]): RegExp {
    return new RegExp(`\\[(?:${aliasAlternation(tags)})\\]([^\\n]*)`, "g");
}

/** A closer with no opener — the mirror case, seen when the opener is split across chunks. */
export function orphanCloserRegex(tags: readonly string[]): RegExp {
    return new RegExp(`\\[\\/(?:${aliasAlternation(tags)})\\]`, "g");
}

/**
 * Regex SOURCE (not a RegExp) matching the closing tag of any of the given blocks,
 * e.g. `\[\/(?:内心|InnerThoughts|状态栏|StatusPanel)\]`.
 *
 * Exists so a caller that needs a block closer as one branch of a larger pattern — the
 * `<style>` HTML-protection lookahead in rich-message-parser — derives it from the same
 * alias arrays as everything else, instead of hardcoding one language's spelling.
 */
export function blockCloserAlternationSource(...tagLists: readonly (readonly string[])[]): string {
    return `\\[\\/(?:${aliasAlternation(tagLists.flat())})\\]`;
}
