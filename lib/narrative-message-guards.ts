// lib/narrative-message-guards.ts
// Shared guards for "a turn-based mode can dispatch a real chat message via [Message]" -- lets
// a character send a genuine chat message from inside a narrated turn's output (story, offline)
// instead of only ever narrating in third person.
//
// Extracted out of story-engine.ts once offline mode needed the exact same protection story
// mode already earned the hard way: five separately user-reported bugs, each now a distinct
// check below (an unclosed tag, a mismatched open/close alias, the whole turn wrapped in the
// tag, the turn opened-at-top-closed-at-bottom with no XML skeleton at all, and reasoning
// wrongly counting as "the story survived"). A second mode reimplementing this from scratch
// would either skip a check it doesn't know about, or drift from this copy over time -- exactly
// the producer/consumer desync class this codebase has hit repeatedly (see CLAUDE.md's
// tool-executor / FETCH_RESULT_HEADER / prompt-sanitizer entries).
//
// Deliberately dependency-free (pure string functions only), so both story-engine.ts and
// chat-engine.ts's offline path can import it without adding an edge to either's own import
// graph.

export function escapeTagName(tag: string): string {
    return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips paired `<tag>...</tag>` blocks for each of `excludedTags` (default: `defaultExcludedTags`). */
export function stripContextExcludedTags(text: string, excludedTags: string | undefined, defaultExcludedTags: string): string {
    const tags = Array.from(new Set((excludedTags ?? defaultExcludedTags).split(",").map(t => t.trim()).filter(Boolean)));
    if (tags.length === 0) return text;
    const tagAlternation = tags.map(escapeTagName).join("|");
    const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
    return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** A closing tag in either language, at the very end of the matched block. */
const MESSAGE_ACTION_CLOSER = /\[\/\s*(?:Message|消息)\s*\]\s*$/i;
/** Any closing tag, anywhere -- used to reject a block whose open/close aliases disagree. */
const MESSAGE_ACTION_CLOSER_ANYWHERE = /\[\/\s*(?:Message|消息)\s*\]/i;

function structuralFieldRegex(tags: string[], global: boolean): RegExp {
    const escaped = Array.from(new Set(tags.map(t => t.trim()).filter(Boolean))).map(escapeTagName);
    const alternation = escaped.join("|");
    return new RegExp(`<\\/?\\s*(?:${alternation})\\s*>`, global ? "gi" : "i");
}

/**
 * A turn-based mode only fires a message from a PROPERLY CLOSED block -- deliberately stricter
 * than chat.
 *
 * parseActionTags has a documented fallback for a missing closing tag: take the content to the
 * end of the text. In chat that is the right call -- the text was going to be a message anyway,
 * so a truncated one beats a lost one. Here it is dangerous: the prose is long and the block
 * belongs after the turn's own structural fields by convention, so a stray unclosed [Message]
 * near the top turns the ENTIRE turn into a chat message, notification and all.
 *
 * Two conditions, which between them also reject a mismatched pair like [Message]…[/消息] (that
 * one "pairs" through the same fallback and leaves the stray closer inside the body):
 *   - the matched block must END with a closing tag, and
 *   - the content must not still contain one.
 *
 * `structuralFieldTags` are the turn's own structural field names (e.g. `["content","summary"]`
 * for story, `["content","summary",effectiveSummaryTag]` for offline) -- a message that
 * contains one of these is the model having wrapped the whole turn in [Message]…[/Message];
 * properly closed, so the checks above pass it, but what would arrive in chat is the entire
 * turn.
 */
export function isCompleteDispatchableMessage(
    action: { content: string; rawText?: string },
    structuralFieldTags: string[],
): boolean {
    if (!action.rawText || !MESSAGE_ACTION_CLOSER.test(action.rawText)) return false;
    if (MESSAGE_ACTION_CLOSER_ANYWHERE.test(action.content)) return false;
    if (!action.content.trim()) return false;
    if (structuralFieldRegex(structuralFieldTags, false).test(action.content)) return false;
    return true;
}

/**
 * A turn must still have real content in it once a dispatched action is stripped out.
 *
 * The other way the whole turn ends up in chat: the model opens [Message] at the very top and
 * closes it at the very end, so the narration sits inside the block. That block IS well formed,
 * so no amount of tag checking catches it -- but stripping it leaves nothing to render, and a
 * turn with no narration in it is definitionally wrong.
 *
 * Checked against the text AFTER the actions are stripped, so it can only be judged here rather
 * than inside isCompleteDispatchableMessage.
 *
 * `contextExcludedTags` is the caller's own setting (default `defaultExcludedTags`) -- the
 * blocks that are stripped before anything reaches the model, i.e. reasoning rather than
 * narration. Those must not count as the turn surviving, or `<think>…</think>` alongside a
 * [Message] holding the whole prose would pass the guard.
 *
 * FOLD tags are deliberately NOT stripped here. A fold tag is content the reader sees, merely
 * collapsed -- a user who adds `<forum>` to foldTags is writing forum posts, and a turn made
 * entirely of them is a real turn. Only the context-excluded set is discounted, so the rule
 * follows whatever the caller configured rather than a hardcoded list.
 */
export function narrativeTextSurvives(
    cleanText: string,
    contextExcludedTags: string | undefined,
    structuralFieldTags: string[],
    defaultExcludedTags: string,
): boolean {
    const withoutReasoning = stripContextExcludedTags(cleanText, contextExcludedTags, defaultExcludedTags);
    return withoutReasoning.replace(structuralFieldRegex(structuralFieldTags, true), "").trim().length > 0;
}
