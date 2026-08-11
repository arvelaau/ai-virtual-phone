// lib/macro-engine.ts
// Macro expansion engine.
// Uses regex-based iterative innermost-first expansion.

import { buildCharacterTimeContext, getSystemTimeZone } from "./character-time";

const TRIM_SENTINEL = "\x00TRIM\x00";

// Used by the {{time}} and {{weekday}} macros, which expand into prompt text only.
const MACRO_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MACRO_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

export class MacroEngine {
    localVars: Map<string, string> = new Map();
    globalVars: Map<string, string> = new Map();
    charName: string;
    userName: string;
    lastUserMessage: string = "";
    lastCharMessage: string = "";
    lastMessage: string = "";
    currentInput: string = "";
    // Character card fields
    description: string = "";
    personality: string = "";
    persona: string = "";
    group: string = "";
    // App-specific fields
    stateStr: string = "";
    followUpCount: number = 0;
    followUpDelay: number = 0;
    timedWakeElapsedMinutes: string = "";
    timedWakeIntent: string = "";
    periodCareContext: string = "";
    timeContext: string = "";
    systemTimeZone: string = "";
    characterTime: string = "";
    characterTimeZone: string = "";
    characterWeekday: string = "";
    customStickerNames: string = "";
    customStickerExample: string = "";
    musicLocal: string = "";
    musicCloud: string = "";
    musicOnlineHint: string = "";
    currentSchedule: string = "";
    coupleSpace: string = "";
    vnScenes: string = "";
    vnSprites: string = "";
    vnBeats: string = "";
    vnCurrentBeat: string = "";
    affinity: string = "";
    // Tool definitions
    tools: string = "";
    cocreateWriteActions: string = "";
    cocreateReadActions: string = "";
    groupTools: string = "";
    groupRoster: string = "";
    customAppRichMediaDirectives: string = "";
    chatBilingualInstruction: string = "";
    offlineBilingualInstruction: string = "";
    offlineSummaryTag: string = "summary";
    checkPhoneBilingualInstruction: string = "";
    xiaohongshuBilingualInstruction: string = "";
    phoneAppId: string = "";
    phoneAppLabel: string = "";
    phoneSnapshotSummary: string = "";
    phoneLastRefreshAt: string = "";
    // Dwelling fields
    dwellingRoom: string = "";
    dwellingFurniture: string = "";
    dwellingItem: string = "";
    dwellingItemPreview: string = "";
    bookTitle: string = "";
    chapterTitle: string = "";
    chapterContent: string = "";
    annotationHistory: string = "";
    noteWallContext: string = "";
    diaryEntryContext: string = "";
    xiaohongshuFeedContext: string = "";
    xiaohongshuUserPostContext: string = "";
    xiaohongshuCommentContext: string = "";
    xiaohongshuMentionContext: string = "";
    interviewTheme: string = "";
    interviewHostName: string = "";
    interviewGuests: string = "";
    interviewGuestCount: string = "";
    interviewCurrentGuest: string = "";
    interviewOtherGuests: string = "";
    interviewQuestion: string = "";
    interviewTranscript: string = "";
    interviewPhase: string = "";
    interviewRound: string = "";
    interviewUserAnswer: string = "";
    interviewCharacterAnswerHistory: string = "";
    cocreateProjectContext: string = "";
    cocreateCurrentMode: string = "";
    cocreateCurrentChapter: string = "";
    cocreateChapterIndex: string = "";
    cocreateArchivedChapterContext: string = "";
    cocreateWriterNotebook: string = "";

    constructor(charName: string, userName: string) {
        this.charName = charName;
        this.userName = userName;
    }

    /** Main entry: iteratively expand all macros (innermost first). */
    expand(text: string): string {
        const MAX_ITERATIONS = 50;
        let result = text;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const next = this.expandInnermost(result);
            if (next === result) break; // no more macros
            result = next;
        }
        return result;
    }

    /** Single pass: find and replace all innermost {{...}} (no nested braces inside). */
    private expandInnermost(text: string): string {
        return text.replace(/\{\{([^{}]*?)\}\}/gs, (_match, body: string) => {
            return this.resolve(body);
        });
    }

    /** Resolve a single macro body (content between {{ and }}). */
    private resolve(body: string): string {
        // Comment: {{//...}}
        if (body.startsWith("//")) {
            return "";
        }

        // trim
        if (body === "trim") {
            return TRIM_SENTINEL;
        }

        // char / user
        if (body === "char") return this.charName;
        if (body === "user") return this.userName;

        // lastUserMessage / lastCharMessage / lastMessage
        if (body === "lastUserMessage") return this.lastUserMessage;
        if (body === "lastCharMessage") return this.lastCharMessage;
        if (body === "lastMessage") return this.lastMessage;

        // input
        if (body === "input") return this.currentInput;

        // Character card fields
        if (body === "description") return this.description;
        if (body === "personality") return this.personality;
        if (body === "persona") return this.persona;
        if (body === "group") return this.group;

        // App-specific fields
        if (body === "affinity") return this.affinity;
        if (body === "state") return this.stateStr;
        if (body === "count") return String(this.followUpCount);
        if (body === "delay") return String(this.followUpDelay);
        if (body === "timedWakeElapsedMinutes" || body === "timedWakeMinutes") return this.timedWakeElapsedMinutes || "0";
        if (body === "timedWakeIntent") return this.timedWakeIntent || "\x00TRIM\x00";
        if (body === "periodCareContext") return this.periodCareContext || "\x00TRIM\x00";
        if (body === "timeContext") return this.timeContext || buildCharacterTimeContext().timeContext;
        if (body === "systemTimeZone") return this.systemTimeZone || getSystemTimeZone();
        if (body === "characterTime") return this.characterTime || "\x00TRIM\x00";
        if (body === "characterTimeZone") return this.characterTimeZone || "\x00TRIM\x00";
        if (body === "characterWeekday") return this.characterWeekday || "\x00TRIM\x00";
        if (body === "customStickers") return this.customStickerNames || "\x00TRIM\x00";
        if (body === "stickerExample") return this.customStickerExample || "\x00TRIM\x00";
        if (body === "musicLocal") return this.musicLocal || "none";
        if (body === "musicCloud") return this.musicCloud || "none";
        if (body === "musicOnlineHint") return this.musicOnlineHint;
        // "当前日程" stays as a macro ALIAS forever: user-saved presets written before the
        // migration may still contain {{当前日程}}. The fallback moved to "none", which is
        // what calendar-storage already returns and what group-chat-engine's NO_SCHEDULE
        // sentinel is — both consumers accept "none" and the legacy "无".
        if (body === "currentSchedule" || body === "当前日程") return this.currentSchedule || "none";
        // Couple Space standing state (anniversaries / wishlist / gift tally). TRIMs away
        // when the character has no Couple Space, so the preset entry disappears entirely
        // rather than emitting an empty heading.
        if (body === "coupleSpace") return this.coupleSpace || "\x00TRIM\x00";
        // Prompt-facing fallbacks, compared nowhere (verified repo-wide). These went first,
        // alongside vn_output_format; the rest of the family further down followed later.
        if (body === "vnScenes") return this.vnScenes || "none yet";
        if (body === "vnSprites") return this.vnSprites || "none yet";
        if (body === "vnBeats") return this.vnBeats || "\x00TRIM\x00";
        if (body === "vnCurrentBeat") return this.vnCurrentBeat || "\x00TRIM\x00";

        // Tool definitions
        if (body === "tools") return this.tools || "\x00TRIM\x00";
        if (body === "cocreateWriteActions") return this.cocreateWriteActions || "\x00TRIM\x00";
        if (body === "cocreateReadActions") return this.cocreateReadActions || "\x00TRIM\x00";
        if (body === "groupTools") return this.groupTools || "\x00TRIM\x00";
        if (body === "groupRoster") return this.groupRoster || "\x00TRIM\x00";
        if (body === "customAppRichMediaDirectives" || body === "customAppChatCapabilities") return this.customAppRichMediaDirectives || "\x00TRIM\x00";
        if (body === "chatBilingualInstruction") return this.chatBilingualInstruction || "\x00TRIM\x00";
        if (body === "offlineBilingualInstruction") return this.offlineBilingualInstruction || "\x00TRIM\x00";
        if (body === "offlineSummaryTag") return this.offlineSummaryTag || "summary";
        if (body === "checkPhoneBilingualInstruction") return this.checkPhoneBilingualInstruction || "\x00TRIM\x00";
        if (body === "xiaohongshuBilingualInstruction") return this.xiaohongshuBilingualInstruction || "\x00TRIM\x00";
        if (body === "phoneAppId") return this.phoneAppId || "\x00TRIM\x00";
        if (body === "phoneAppLabel") return this.phoneAppLabel || "\x00TRIM\x00";
        if (body === "phoneSnapshotSummary") return this.phoneSnapshotSummary || "\x00TRIM\x00";
        if (body === "phoneLastRefreshAt") return this.phoneLastRefreshAt || "\x00TRIM\x00";

        // Dwelling fields
        if (body === "dwellingRoom") return this.dwellingRoom || "\x00TRIM\x00";
        if (body === "dwellingFurniture") return this.dwellingFurniture || "\x00TRIM\x00";
        if (body === "dwellingItem") return this.dwellingItem || "\x00TRIM\x00";
        if (body === "dwellingItemPreview") return this.dwellingItemPreview || "\x00TRIM\x00";
        if (body === "bookTitle") return this.bookTitle || "\x00TRIM\x00";
        if (body === "chapterTitle") return this.chapterTitle || "\x00TRIM\x00";
        if (body === "chapterContent") return this.chapterContent || "\x00TRIM\x00";
        if (body === "annotationHistory") return this.annotationHistory || "\x00TRIM\x00";
        if (body === "noteWallContext") return this.noteWallContext || "no notes yet";
        if (body === "diaryEntryContext") return this.diaryEntryContext || "no diary entries yet";
        if (body === "xiaohongshuFeedContext") return this.xiaohongshuFeedContext || "no Xiaohongshu notes yet";
        if (body === "xiaohongshuUserPostContext") return this.xiaohongshuUserPostContext || "no Xiaohongshu notes from the user yet";
        if (body === "xiaohongshuCommentContext") return this.xiaohongshuCommentContext || "no Xiaohongshu comment context yet";
        if (body === "xiaohongshuMentionContext") return this.xiaohongshuMentionContext || "no Xiaohongshu @ mention context yet";
        if (body === "interviewTheme") return this.interviewTheme || "\x00TRIM\x00";
        if (body === "interviewHostName") return this.interviewHostName || "the host";
        if (body === "interviewGuests") return this.interviewGuests || this.charName || "\x00TRIM\x00";
        if (body === "interviewGuestCount") return this.interviewGuestCount || "1";
        if (body === "interviewCurrentGuest") return this.interviewCurrentGuest || this.charName || "\x00TRIM\x00";
        if (body === "interviewOtherGuests") return this.interviewOtherGuests || "none";
        if (body === "interviewQuestion") return this.interviewQuestion || "\x00TRIM\x00";
        if (body === "interviewTranscript") return this.interviewTranscript || "(no interview transcript yet)";
        if (body === "interviewPhase") return this.interviewPhase || "\x00TRIM\x00";
        if (body === "interviewRound") return this.interviewRound || "1";
        if (body === "interviewUserAnswer") return this.interviewUserAnswer || "\x00TRIM\x00";
        if (body === "interviewCharacterAnswerHistory") return this.interviewCharacterAnswerHistory || "(none yet)";
        if (body === "cocreateProjectContext") return this.cocreateProjectContext || "\x00TRIM\x00";
        if (body === "cocreateCurrentMode") return this.cocreateCurrentMode || "\x00TRIM\x00";
        if (body === "cocreateCurrentChapter") return this.cocreateCurrentChapter || "\x00TRIM\x00";
        if (body === "cocreateChapterIndex") return this.cocreateChapterIndex || "No chapter index yet.";
        if (body === "cocreateArchivedChapterContext") return this.cocreateArchivedChapterContext || "No finished chapters yet.";
        if (body === "cocreateWriterNotebook") return this.cocreateWriterNotebook || "No notes yet.";

        // realCharacterList — the other characters the user has created (excluding the current one),
        // used by Moments and similar surfaces to decide what counts as a "real character"
        if (body === "realCharacterList") {
            try {
                // Lazy require: avoids touching storage during module init, and a potential import cycle
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { loadCharacters } = require("./character-storage") as typeof import("./character-storage");
                const names = loadCharacters()
                    .map(c => (c.name || "").trim())
                    .filter(n => n && n !== this.charName);
                return names.length ? names.join(", ") : "(none)";
            } catch {
                return "(none)";
            }
        }

        // time — shortcut for the current datetime, e.g. "2 March 2026 15:40".
        // Verified nothing parses this back: it is expanded into prompt text only.
        if (body === "time") {
            const now = new Date();
            const month = MACRO_MONTH_NAMES[now.getMonth()];
            return `${now.getDate()} ${month} ${now.getFullYear()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        }

        if (body === "weekday") {
            return MACRO_WEEKDAY_NAMES[new Date().getDay()];
        }

        // uuid
        if (body === "uuid") {
            if (typeof crypto !== "undefined" && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            // Fallback
            return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                const r = (Math.random() * 16) | 0;
                return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
            });
        }

        // setvar::name::value
        if (body.startsWith("setvar::")) {
            const parts = body.substring(8).split("::");
            if (parts.length >= 2) {
                const name = parts[0];
                const value = parts.slice(1).join("::");
                this.localVars.set(name, value);
            }
            return "";
        }

        // getvar::name
        if (body.startsWith("getvar::")) {
            const name = body.substring(8);
            return this.localVars.get(name) ?? "";
        }

        // setglobalvar::name::value
        if (body.startsWith("setglobalvar::")) {
            const parts = body.substring(14).split("::");
            if (parts.length >= 2) {
                const name = parts[0];
                const value = parts.slice(1).join("::");
                this.globalVars.set(name, value);
            }
            return "";
        }

        // getglobalvar::name
        if (body.startsWith("getglobalvar::")) {
            const name = body.substring(14);
            return this.globalVars.get(name) ?? "";
        }

        // random::a::b::c  (:: separated)
        if (body.startsWith("random::")) {
            const items = body.substring(8).split("::").filter(Boolean);
            if (items.length > 0) {
                return items[Math.floor(Math.random() * items.length)];
            }
            return "";
        }

        // random:a,b,c  (comma or newline separated, single colon)
        if (body.startsWith("random:") && !body.startsWith("random::")) {
            const rest = body.substring(7);
            // Split by comma or newline
            const items = rest.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
            if (items.length > 0) {
                return items[Math.floor(Math.random() * items.length)];
            }
            return "";
        }

        // timestamp:FORMAT
        if (body.startsWith("timestamp:")) {
            const format = body.substring(10).trim();
            return formatTimestamp(format);
        }
        if (body === "timestamp") {
            return new Date().toISOString();
        }

        // Unrecognized macro — leave as-is (return with braces so it doesn't loop)
        return `{{${body}}}`;
    }
}

/** Post-process: remove {{trim}} sentinels and surrounding newlines. */
export function postProcessTrim(text: string): string {
    // Remove trim sentinels along with any surrounding newlines
    return text.replace(/\n*\x00TRIM\x00\n*/g, "");
}

/** Simple timestamp formatter. Supports common tokens: YYYY, MM, DD, HH, mm, ss, etc. */
function formatTimestamp(format: string): string {
    const now = new Date();
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");

    return format
        .replace(/YYYY/g, String(now.getFullYear()))
        .replace(/YY/g, String(now.getFullYear()).slice(-2))
        .replace(/MM/g, pad(now.getMonth() + 1))
        .replace(/DD/g, pad(now.getDate()))
        .replace(/HH/g, pad(now.getHours()))
        .replace(/hh/g, pad(now.getHours() % 12 || 12))
        .replace(/mm/g, pad(now.getMinutes()))
        .replace(/ss/g, pad(now.getSeconds()))
        .replace(/A/g, now.getHours() >= 12 ? "PM" : "AM")
        .replace(/a/g, now.getHours() >= 12 ? "pm" : "am");
}
