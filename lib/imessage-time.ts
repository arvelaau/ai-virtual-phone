// lib/imessage-time.ts
// The iMessage reply prompt is assembled ONCE, in the browser, when the user presses "Sync to
// cloud", and replayed by the server for every message after that. Anything in it that depends on
// "now" would stay frozen at the moment of the sync: the current time, the weekday, the
// time-zone block, and the timestamps the app puts in front of each chat turn.
//
// The fix: the snapshot is assembled with placeholder tokens where "now" goes, and the server
// swaps them for the real values on every reply. Pure (no storage, no network), so a fixture can
// drive it, and the server never needs the user's browser to know what time it is for them.

import {
    buildCharacterTimeContext,
    formatZonedPromptTimestamp,
    getZonedWeekday,
} from "./character-time";

export const TIME_TOKEN_BLOCK = "__AIPHONE_TIME_CONTEXT__";
export const TIME_TOKEN_NOW = "__AIPHONE_NOW__";
export const TIME_TOKEN_WEEKDAY = "__AIPHONE_WEEKDAY__";
export const TIME_TOKEN_CHARACTER_TIME = "__AIPHONE_CHARACTER_TIME__";
export const TIME_TOKEN_CHARACTER_WEEKDAY = "__AIPHONE_CHARACTER_WEEKDAY__";

/** What the snapshot records so the server can recompute the time-dependent parts. */
export type IMessageTimeSettings = {
    /** Whether chat turns carry a "(2026-10-12 21:05)" stamp, as in the app. */
    timeAware: boolean;
    /** The USER's time zone (the browser's). The server's own zone is meaningless here. */
    systemTimeZone: string;
    /** The character's zone, when one is set. */
    characterTimeZone?: string;
    /** Whether stamps spell the zone out (true when the two clocks differ, like in the app). */
    includeTimeZone: boolean;
};

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/** "2 March 2026 15:40" in `timeZone`: the shape the {{time}} macro uses. */
export function formatMacroNow(date: Date, timeZone: string): string {
    const parts: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date)) {
        parts[part.type] = part.value;
    }
    const month = MONTHS[Math.max(0, Math.min(11, Number(parts.month) - 1))];
    return `${Number(parts.day)} ${month} ${parts.year} ${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
}

type Replacements = Array<[string, string]>;

/** The tokens and what they stand for at `now`. */
export function freshTimeReplacements(settings: IMessageTimeSettings, now: Date): Replacements {
    const ctx = buildCharacterTimeContext(settings.characterTimeZone, now, settings.systemTimeZone);
    return [
        [TIME_TOKEN_BLOCK, ctx.timeContext],
        [TIME_TOKEN_NOW, formatMacroNow(now, settings.systemTimeZone)],
        [TIME_TOKEN_WEEKDAY, getZonedWeekday(now, settings.systemTimeZone)],
        [TIME_TOKEN_CHARACTER_TIME, ctx.characterTime],
        [TIME_TOKEN_CHARACTER_WEEKDAY, ctx.characterWeekday],
    ];
}

function replaceAllTokens(text: string, replacements: Replacements): string {
    let next = text;
    for (const [token, value] of replacements) {
        if (next.includes(token)) next = next.split(token).join(value);
    }
    return next;
}

type MessageLike = { role: string; content: string | Array<{ type: string; text?: string; [k: string]: unknown }>; [k: string]: unknown };

/** A copy of `messages` with every time token replaced. Does not mutate its input. */
export function applyFreshTime<T extends MessageLike>(messages: T[], settings: IMessageTimeSettings | undefined, now: Date): T[] {
    if (!settings) return messages;
    const replacements = freshTimeReplacements(settings, now);
    return messages.map((message) => {
        if (typeof message.content === "string") {
            const content = replaceAllTokens(message.content, replacements);
            return content === message.content ? message : { ...message, content };
        }
        if (!Array.isArray(message.content)) return message;
        return {
            ...message,
            content: message.content.map((part) => (
                part.type === "text" && typeof part.text === "string"
                    ? { ...part, text: replaceAllTokens(part.text, replacements) }
                    : part
            )),
        };
    });
}

/** "(2026-10-12 21:05)" or "(2026-10-12 21:05 Asia/Jakarta)": the stamp the app puts before a turn. */
export function formatTurnStamp(iso: string | number | Date, settings: IMessageTimeSettings): string {
    const date = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return `(${formatZonedPromptTimestamp(date, settings.systemTimeZone, settings.includeTimeZone)})`;
}

/**
 * Puts the app's stamp in front of each turn, skipping a repeat of the same stamp from the same
 * role (the app does the same). No-op unless the snapshot says the chat is time-aware.
 */
export function stampTurns<T extends { role: string; content: string }>(
    turns: Array<T & { at: string | number | Date }>,
    settings: IMessageTimeSettings | undefined,
): Array<{ role: string; content: string }> {
    if (!settings || !settings.timeAware) return turns.map(({ role, content }) => ({ role, content }));
    let prevStamp = "";
    let prevRole = "";
    return turns.map(({ role, content, at }) => {
        const stamp = formatTurnStamp(at, settings);
        const show = Boolean(stamp) && !(stamp === prevStamp && role === prevRole);
        prevStamp = stamp;
        prevRole = role;
        return { role, content: show ? `${stamp}\n${content}` : content };
    });
}
