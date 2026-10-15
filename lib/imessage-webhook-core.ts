// lib/imessage-webhook-core.ts
// Pure decision logic for the iMessage webhook (app/api/imessage/webhook). Kept free of
// network and storage so it can be driven directly by a fixture.

import { stripReasoningTags } from "./block-tags";
import { stripStateAndInnerForPrompt } from "./prompt-sanitizer";
import { RICH_MEDIA_NAMES } from "./state-value-parser";
import { MacroEngine } from "./macro-engine";
import { applyPlainTextOutputRegex } from "./regex-engine";
import type { RegexConfig } from "./settings-types";
import type { LLMMessage } from "./llm-prompt-assembler";
import { applyFreshTime, stampTurns, type IMessageTimeSettings } from "./imessage-time";
import type {
    IMessageCloudPromptTemplate,
    IMessageCloudRuntimeIndex,
    IMessageCloudRuntimeIndexItem,
    IMessageCloudStoredMessage,
} from "./imessage-types";

/** Phones compare by digits only ("+1 (555) 123-4567" == "15551234567"); emails by lowercase. */
export function normalizeIMessageAddress(value: string): string {
    const trimmed = (value || "").trim();
    if (!trimmed) return "";
    if (trimmed.includes("@")) return trimmed.toLowerCase();
    return trimmed.replace(/[^0-9]/g, "");
}

/** Finds the bound line for the human who texted in. Disabled lines never match. */
export function findLineForSender(
    index: IMessageCloudRuntimeIndex,
    senderId: string,
): IMessageCloudRuntimeIndexItem | null {
    const wanted = normalizeIMessageAddress(senderId);
    if (!wanted) return null;
    return index.lines.find((line) => normalizeIMessageAddress(line.phone) === wanted) ?? null;
}

/**
 * A guard against a runaway reply (every bubble is a paid, separate send inside one function
 * run), NOT a style limit: the character may send as many bubbles as it likes up to this.
 */
export const MAX_REPLY_BUBBLES = 40;
/** One iMessage can be long, but a wall of text reads badly; a longer paragraph is SPLIT, never cut off. */
export const MAX_BUBBLE_CHARS = 1500;

/** Splits `text` into pieces of at most `limit` characters at the nicest boundary available. */
export function splitLongText(text: string, limit = MAX_BUBBLE_CHARS): string[] {
    const out: string[] = [];
    let rest = text.trim();
    while (rest.length > limit) {
        const window = rest.slice(0, limit);
        // newline > sentence end > space > hard cut; never so early that the piece is tiny
        const floor = Math.floor(limit * 0.5);
        let cut = window.lastIndexOf("\n");
        if (cut < floor) {
            const sentence = Math.max(
                window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "),
                window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"),
            );
            cut = sentence >= floor ? sentence + 1 : -1;
        }
        if (cut < floor) cut = window.lastIndexOf(" ");
        if (cut < floor) cut = limit;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
}

const NOT_A_STATE_NAME = new Set(Array.from(RICH_MEDIA_NAMES, (n) => n.toLowerCase()));

/**
 * State values the model wrote with a little extra decoration: `[Anxiety: 30]`, `[焦虑值：30%]`,
 * `[Affection:72/100]`. The app's own parser (state-value-parser) only knows the bare `[Name:30]`, so
 * these slipped past it and reached the phone. Rich-media tags that carry a number (`[Sticker:11]`)
 * and plain numbers like `[20:33]` are left alone, exactly as the app's parser leaves them.
 */
export function stripLooseStateTags(text: string): string {
    if (!text) return "";
    return text
        .replace(/\[\s*([^\[\]\n:：]{1,30}?)\s*[:：]\s*\d{1,3}(?:\.\d+)?\s*(?:%|\/\s*100)?\s*\]/g, (whole, rawName: string) => {
            const name = rawName.trim();
            if (!name || /^\d+$/.test(name) || NOT_A_STATE_NAME.has(name.toLowerCase())) return whole;
            return "";
        })
        .replace(/[ \t]+\n/g, "\n");
}

/**
 * The user's own regex rules, as the app runs them on a reply, adapted for plain text. In the app
 * these are what hide the state values and the inner-thought block; a webhook that skips them sends
 * whatever they were hiding to the phone.
 */
export function applyReplyRegexes(
    raw: string,
    ctx: { regexes?: RegexConfig[]; characterName?: string; userName?: string; activeTags?: string[] },
): string {
    if (!raw || !ctx.regexes || ctx.regexes.length === 0) return raw;
    try {
        const macroEngine = new MacroEngine(ctx.characterName ?? "", ctx.userName ?? "User");
        return applyPlainTextOutputRegex(raw, ctx.regexes, { macroEngine, activeTags: ctx.activeTags ?? ["chat", "text"] });
    } catch {
        // a broken rule must never stop a reply
        return raw;
    }
}

/**
 * Turns the model's raw output into the plain-text bubbles that go out over iMessage.
 * Reasoning and the state / inner-thoughts blocks never leave the server. Blank-line
 * separated paragraphs become separate bubbles, as in the Chat app.
 */
export function modelOutputToBubbles(raw: string): string[] {
    const cleaned = stripLooseStateTags(stripStateAndInnerForPrompt(stripReasoningTags(raw || ""))).trim();
    if (!cleaned) return [];
    const bubbles = cleaned
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .flatMap((part) => splitLongText(part));
    return bubbles.slice(0, MAX_REPLY_BUBBLES);
}

/**
 * Cloud records written after the snapshot was built. Earlier ones are already baked
 * into the template's history, so including them again would double every turn.
 */
export function messagesAfterSnapshot(
    stored: IMessageCloudStoredMessage[],
    snapshotCreatedAt: string,
    limit: number,
): IMessageCloudStoredMessage[] {
    return stored
        .filter((item) => item.createdAt > snapshotCreatedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit);
}

/** before + (history since the snapshot) + the new inbound message + after. */
export function buildPromptFromTemplate(
    template: IMessageCloudPromptTemplate,
    recent: IMessageCloudStoredMessage[],
    inboundText: string,
    images?: Array<{ mimeType: string; dataBase64: string }>,
    /** From the snapshot. Without it the template is used exactly as stored (older snapshots). */
    time?: { settings?: IMessageTimeSettings; now: Date },
): LLMMessage[] {
    // Turns carry the same "(2026-10-12 21:05)" stamp the app puts in front of each one.
    const stamped = stampTurns(
        [
            ...recent.map((item) => ({ role: item.role as string, content: item.content, at: item.createdAt })),
            { role: "user", content: inboundText || (images && images.length > 0 ? "[Image]" : ""), at: time?.now ?? new Date() },
        ],
        time?.settings,
    );
    const turns: LLMMessage[] = stamped.slice(0, -1).map((turn) => ({ role: turn.role as LLMMessage["role"], content: turn.content }));
    const last = stamped[stamped.length - 1];
    turns.push(
        images && images.length > 0
            ? {
                  role: "user",
                  content: [
                      { type: "text", text: last.content },
                      ...images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } })),
                  ],
              }
            : { role: "user", content: last.content },
    );
    const built = [...template.beforeMessages, ...turns, ...template.afterMessages];
    return time ? applyFreshTime(built, time.settings, time.now) : built;
}

export function inboundMessagePath(prefix: string, lineId: string, externalId: string): string {
    const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${prefix}/messages/${safe(lineId)}/${safe(externalId)}.json`;
}
