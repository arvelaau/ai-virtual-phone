import {
    BLOCK_TAG_INNER,
    BLOCK_TAG_STATUS_PANEL,
    closedBlockRegex,
    orphanCloserRegex,
    stripReasoningTags,
    unclosedBlockRegex,
} from "./block-tags";
import { parseStateValues } from "./state-value-parser";

// These blocks are stripped before a message is fed BACK into a prompt. The tag
// names are bilingual (the preset now teaches [InnerThoughts]/[StatusPanel]; saved
// history still holds [内心]/[状态栏]), so this must strip every accepted alias —
// exactly the set rich-message-parser recognizes on the read side, which is why both
// sides now build their regexes from the same helpers in block-tags.
//
// Getting this wrong is silent and ugly: an unstripped block is replayed to the
// model as if the character had said it out loud, so the model starts echoing its
// own inner monologue into visible messages.
const BLOCKS = [BLOCK_TAG_STATUS_PANEL, BLOCK_TAG_INNER];
const STRIPPERS = BLOCKS.flatMap((tags) => [
    // Order matters: take well-formed pairs out first, so the unclosed-opener sweep
    // only ever sees genuinely unterminated tags.
    closedBlockRegex(tags),
    unclosedBlockRegex(tags),
    orphanCloserRegex(tags),
]);

export function stripStateAndInnerForPrompt(text: string): string {
    if (!text) return "";
    // Strip leaked <think> blocks too: replaying a model its own reasoning as if it
    // had been said out loud is exactly what makes it echo the monologue.
    const withoutState = parseStateValues(stripReasoningTags(text)).cleanText;
    return STRIPPERS
        .reduce((out, re) => out.replace(re, ""), withoutState)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
