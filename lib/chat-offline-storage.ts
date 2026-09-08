import { loadChatSessions } from "./chat-storage";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import { kvGet, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";

const CHAT_OFFLINE_TURNS_PREFIX = "ai_phone_chat_offline_turns:";
registerDynamicPrefix(CHAT_OFFLINE_TURNS_PREFIX);

const CHAT_OFFLINE_SESSIONS_PREFIX = "ai_phone_chat_offline_sessions:";
registerDynamicPrefix(CHAT_OFFLINE_SESSIONS_PREFIX);

export type ChatOfflineTurn = {
    id: string;
    sessionId: string;
    userContent: string;
    assistantContent: string;
    summary: string;
    summaryTag: string;
    rawText?: string;
    reasoningText?: string; // 模型思维链（reasoning/CoT）内容
    createdAt: string;
    /** A custom-app chat directive triggered this turn (e.g. a boarding-pass/menu card) -- see extractCustomAppCard() in rich-message-parser.ts. Mirrors the subset of ChatMessage.mediaData that AppCardBubble actually reads. */
    appId?: string;
    appName?: string;
    appCardLayout?: Record<string, unknown>;
    /** Which offline "visit" (ChatOfflineSession) this turn belongs to -- undefined for turns
     *  saved before the enter/exit session-boundary feature existed, or for group chats, which
     *  are deliberately out of scope for the whole session-boundary feature (see
     *  ChatOfflineSession's own doc comment). Those turns simply never group into anything. */
    offlineSessionId?: string;
};

/**
 * One "visit" to offline mode: the span between an explicit enter and an explicit exit, as
 * opposed to the individual per-turn exchanges that happen inside it. Deliberately 1:1 only --
 * group chat's offline mode stays the bare boolean flip it always was (see
 * chat-room.tsx's toggleOfflineMode vs. handleEnterOfflineMode/handleExitOfflineMode), matching
 * this project's repeated "1:1 only, group has a known deferred gap" precedent for
 * message-dispatch-adjacent features.
 *
 * `endedAt`/brief-ness are set SYNCHRONOUSLY the moment the user exits (no LLM call needed for
 * those), so a session is never left dangling "active" just because a background summary call
 * is slow or fails. `fullSummary`/`calendarTitle` are patched in ASYNCHRONOUSLY afterward, once
 * generateOfflineSessionSummary() (lib/chat-engine.ts) returns -- see
 * loadChatOfflineSessionProjectionEntries()'s fallback for what the character sees in the
 * window before that patch lands.
 */
export type ChatOfflineSession = {
    id: string;
    sessionId: string;
    startedAt: string;
    endedAt?: string;
    /** True when the visit was very short (few turns / short wall-clock span) -- see
     *  isBriefOfflineSession(). Computed once, at exit, and never recomputed afterward. */
    brief?: boolean;
    /** LLM-generated first-person recap of the whole visit, filled in after exit. */
    fullSummary?: string;
    /** LLM-generated short label for the matching calendar entry (see calendar-utils.ts's
     *  deriveOfflineSessionScheduleWindow()), filled in after exit alongside fullSummary. */
    calendarTitle?: string;
};

export type ChatOfflineProjectionEntry = {
    id: string;
    sessionId: string;
    groupSessionId?: string;
    timestamp: string;
    content: string;
};

export type ParsedOfflineResponse = {
    rawText: string;
    content: string;
    summary: string;
    summaryTag: string;
};

function storageKey(sessionId: string): string {
    return `${CHAT_OFFLINE_TURNS_PREFIX}${sessionId}`;
}

function createTurnId(): string {
    return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeTurn(value: unknown): ChatOfflineTurn | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<ChatOfflineTurn>;
    if (typeof item.id !== "string" || typeof item.sessionId !== "string") return null;
    if (typeof item.userContent !== "string" || typeof item.assistantContent !== "string") return null;
    if (typeof item.createdAt !== "string") return null;
    return {
        id: item.id,
        sessionId: item.sessionId,
        userContent: item.userContent,
        assistantContent: item.assistantContent,
        summary: typeof item.summary === "string" ? item.summary : "",
        summaryTag: typeof item.summaryTag === "string" && item.summaryTag.trim() ? item.summaryTag.trim() : "summary",
        rawText: typeof item.rawText === "string" ? item.rawText : undefined,
        reasoningText: typeof item.reasoningText === "string" ? item.reasoningText : undefined,
        createdAt: item.createdAt,
        appId: typeof item.appId === "string" ? item.appId : undefined,
        appName: typeof item.appName === "string" ? item.appName : undefined,
        appCardLayout: item.appCardLayout && typeof item.appCardLayout === "object" ? item.appCardLayout : undefined,
        offlineSessionId: typeof item.offlineSessionId === "string" ? item.offlineSessionId : undefined,
    };
}

export function loadChatOfflineTurns(sessionId: string): ChatOfflineTurn[] {
    try {
        const raw = kvGet(storageKey(sessionId));
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeTurn)
            .filter((turn): turn is ChatOfflineTurn => Boolean(turn))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
        return [];
    }
}

export function saveChatOfflineTurns(sessionId: string, turns: ChatOfflineTurn[]): void {
    const normalized = turns
        .map(normalizeTurn)
        .filter((turn): turn is ChatOfflineTurn => Boolean(turn))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    kvSet(storageKey(sessionId), JSON.stringify(normalized));
}

export function clearChatOfflineTurns(sessionId: string): void {
    kvRemove(storageKey(sessionId));
}

export function appendChatOfflineTurn(input: {
    sessionId: string;
    userContent: string;
    assistantContent: string;
    summary: string;
    summaryTag: string;
    rawText?: string;
    reasoningText?: string;
    appId?: string;
    appName?: string;
    appCardLayout?: Record<string, unknown>;
    offlineSessionId?: string;
}): ChatOfflineTurn {
    const turn: ChatOfflineTurn = {
        id: createTurnId(),
        sessionId: input.sessionId,
        userContent: input.userContent,
        assistantContent: input.assistantContent,
        summary: input.summary,
        summaryTag: input.summaryTag.trim() || "summary",
        rawText: input.rawText,
        reasoningText: input.reasoningText,
        appId: input.appId,
        appName: input.appName,
        appCardLayout: input.appCardLayout,
        offlineSessionId: input.offlineSessionId,
        createdAt: new Date().toISOString(),
    };
    saveChatOfflineTurns(input.sessionId, [...loadChatOfflineTurns(input.sessionId), turn]);
    return turn;
}

/** All turns belonging to one offline "visit" -- used both to build the summary-generation
 *  prompt and to compute turnCount/duration for the brief-visit heuristic at exit time. */
export function getChatOfflineSessionTurns(sessionId: string, offlineSessionId: string): ChatOfflineTurn[] {
    return loadChatOfflineTurns(sessionId).filter(turn => turn.offlineSessionId === offlineSessionId);
}

export function updateChatOfflineTurn(
    sessionId: string,
    turnId: string,
    patch: Partial<Pick<ChatOfflineTurn, "userContent" | "assistantContent" | "summary" | "summaryTag" | "rawText" | "reasoningText">>,
): ChatOfflineTurn | null {
    let updated: ChatOfflineTurn | null = null;
    const turns = loadChatOfflineTurns(sessionId).map((turn) => {
        if (turn.id !== turnId) return turn;
        updated = {
            ...turn,
            ...patch,
            summaryTag: patch.summaryTag?.trim() || turn.summaryTag || "summary",
        };
        return updated;
    });
    if (updated) saveChatOfflineTurns(sessionId, turns);
    return updated;
}

export function deleteChatOfflineTurn(sessionId: string, turnId: string): ChatOfflineTurn[] {
    const next = loadChatOfflineTurns(sessionId).filter((turn) => turn.id !== turnId);
    saveChatOfflineTurns(sessionId, next);
    return next;
}

export function deleteChatOfflineTurnsFrom(sessionId: string, turnId: string): ChatOfflineTurn[] {
    const turns = loadChatOfflineTurns(sessionId);
    const idx = turns.findIndex((turn) => turn.id === turnId);
    if (idx < 0) return turns;
    const next = turns.slice(0, idx);
    saveChatOfflineTurns(sessionId, next);
    return next;
}

// ── Offline session boundary (enter/exit "visits", 1:1 only) ─────────────────

function sessionsStorageKey(sessionId: string): string {
    return `${CHAT_OFFLINE_SESSIONS_PREFIX}${sessionId}`;
}

function createOfflineSessionId(): string {
    return `offlinesess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeOfflineSession(value: unknown): ChatOfflineSession | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<ChatOfflineSession>;
    if (typeof item.id !== "string" || typeof item.sessionId !== "string") return null;
    if (typeof item.startedAt !== "string") return null;
    return {
        id: item.id,
        sessionId: item.sessionId,
        startedAt: item.startedAt,
        endedAt: typeof item.endedAt === "string" ? item.endedAt : undefined,
        brief: item.brief === true,
        fullSummary: typeof item.fullSummary === "string" ? item.fullSummary : undefined,
        calendarTitle: typeof item.calendarTitle === "string" ? item.calendarTitle : undefined,
    };
}

export function loadChatOfflineSessions(sessionId: string): ChatOfflineSession[] {
    try {
        const raw = kvGet(sessionsStorageKey(sessionId));
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeOfflineSession)
            .filter((s): s is ChatOfflineSession => Boolean(s))
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    } catch {
        return [];
    }
}

function saveChatOfflineSessions(sessionId: string, sessions: ChatOfflineSession[]): void {
    kvSet(sessionsStorageKey(sessionId), JSON.stringify(sessions));
}

/** The session with no endedAt yet, if any -- there is at most one active session per chat
 *  session at a time (starting a new one always ends the previous one first, defensively). */
export function getActiveChatOfflineSession(sessionId: string): ChatOfflineSession | null {
    const sessions = loadChatOfflineSessions(sessionId);
    return sessions.find(s => !s.endedAt) ?? null;
}

/** Starts a new offline "visit". If one was already active (should not normally happen -- the UI
 *  always exits before re-entering -- but a stale tab or a missed exit could leave one dangling),
 *  it is closed first with no summary, so it does not silently keep absorbing new turns forever. */
export function startChatOfflineSession(sessionId: string): ChatOfflineSession {
    const existingActive = getActiveChatOfflineSession(sessionId);
    const sessions = loadChatOfflineSessions(sessionId);
    const now = new Date().toISOString();
    const withPriorClosed = existingActive
        ? sessions.map(s => (s.id === existingActive.id ? { ...s, endedAt: s.endedAt ?? now } : s))
        : sessions;
    const created: ChatOfflineSession = {
        id: createOfflineSessionId(),
        sessionId,
        startedAt: now,
    };
    saveChatOfflineSessions(sessionId, [...withPriorClosed, created]);
    return created;
}

export function patchChatOfflineSession(
    sessionId: string,
    offlineSessionId: string,
    patch: Partial<Pick<ChatOfflineSession, "endedAt" | "brief" | "fullSummary" | "calendarTitle">>,
): ChatOfflineSession | null {
    let updated: ChatOfflineSession | null = null;
    const sessions = loadChatOfflineSessions(sessionId).map(s => {
        if (s.id !== offlineSessionId) return s;
        updated = { ...s, ...patch };
        return updated;
    });
    if (updated) saveChatOfflineSessions(sessionId, sessions);
    return updated;
}

/** A session this brief still gets a reaction opportunity and a (minimum-length) calendar
 *  entry, but see deriveOfflineSessionScheduleWindow() in calendar-utils.ts for how the
 *  calendar side pads a too-short block up to something visible. */
const BRIEF_OFFLINE_SESSION_MAX_TURNS = 1;
const BRIEF_OFFLINE_SESSION_MAX_DURATION_MS = 3 * 60 * 1000;

export function isBriefOfflineSession(turnCount: number, durationMs: number): boolean {
    return turnCount <= BRIEF_OFFLINE_SESSION_MAX_TURNS || durationMs < BRIEF_OFFLINE_SESSION_MAX_DURATION_MS;
}

/**
 * Ends the active session SYNCHRONOUSLY -- endedAt and the brief-visit flag are both computed
 * from data already on disk (no LLM call), so a session is never left "active" just because the
 * follow-up summary call is slow or fails entirely. A turnCount of 0 (the user opened and closed
 * the panel without saying anything) is treated as a pure no-op: no brief flag, no summary, no
 * calendar entry -- there is nothing to react to or record.
 */
export function endChatOfflineSession(sessionId: string, offlineSessionId: string): {
    session: ChatOfflineSession;
    turnCount: number;
} | null {
    const target = loadChatOfflineSessions(sessionId).find(s => s.id === offlineSessionId);
    if (!target || target.endedAt) return null;
    const turnCount = getChatOfflineSessionTurns(sessionId, offlineSessionId).length;
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(target.startedAt).getTime();
    const brief = turnCount > 0 && isBriefOfflineSession(turnCount, durationMs);
    const updated = patchChatOfflineSession(sessionId, offlineSessionId, { endedAt, brief });
    if (!updated) return null;
    return { session: updated, turnCount };
}

const OFFLINE_SESSION_BRIEF_FALLBACK_NOTE =
    "(This offline visit ended almost as soon as it began -- barely any time passed before they came back.)";

/**
 * One projection entry per ENDED offline session (as opposed to loadChatOfflineProjectionEntries's
 * one-per-turn), read by short-term-assembler.ts alongside the per-turn entries. Prefers the
 * LLM-generated fullSummary once it has landed; a brief session that has not been summarized yet
 * (or whose summary call failed) still surfaces a short deterministic note instead of nothing --
 * that is what lets the character notice and react to a fast exit even before/without the async
 * summary call succeeding. A non-brief session with no summary yet is skipped here entirely: its
 * individual turns are already covered by the per-turn projection, so there is nothing to add
 * until the real recap lands.
 */
export function loadChatOfflineSessionProjectionEntries(
    characterId: string,
    options?: { afterTimestamp?: string; excludeSessionId?: string },
): ChatOfflineProjectionEntry[] {
    const sessions = loadChatSessions().filter((session) => {
        if (session.id === options?.excludeSessionId) return false;
        if (session.isGroup) return false; // session-boundary tracking is 1:1 only
        return session.contactId === characterId;
    });

    const entries: ChatOfflineProjectionEntry[] = [];
    for (const chatSession of sessions) {
        for (const offlineSession of loadChatOfflineSessions(chatSession.id)) {
            if (!offlineSession.endedAt) continue;
            if (options?.afterTimestamp && offlineSession.endedAt <= options.afterTimestamp) continue;
            const text = offlineSession.fullSummary
                ? compactProjectionText(offlineSession.fullSummary, 500)
                : (offlineSession.brief ? OFFLINE_SESSION_BRIEF_FALLBACK_NOTE : "");
            if (!text) continue;
            const ts = formatChatTimestamp(offlineSession.endedAt);
            entries.push({
                id: `chat_offline_session_projection_${offlineSession.id}`,
                sessionId: chatSession.id,
                timestamp: offlineSession.endedAt,
                content: `[Event ${ts}] ${text}`,
            });
        }
    }

    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function compactProjectionText(text: string, maxLen: number): string {
    const plain = text
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[#>*_`-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!plain) return "";
    return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadChatOfflineProjectionEntries(
    characterId: string,
    options?: { afterTimestamp?: string; excludeSessionId?: string },
): ChatOfflineProjectionEntry[] {
    const sessions = loadChatSessions().filter((session) => {
        if (session.id === options?.excludeSessionId) return false;
        if (session.isGroup) return session.participantIds?.includes(characterId);
        return session.contactId === characterId;
    });

    const entries: ChatOfflineProjectionEntry[] = [];
    for (const session of sessions) {
        for (const turn of loadChatOfflineTurns(session.id)) {
            if (options?.afterTimestamp && turn.createdAt <= options.afterTimestamp) continue;
            const summaryText = compactProjectionText(turn.summary, 500);
            if (!summaryText) continue;
            const ts = formatChatTimestamp(turn.createdAt);
            entries.push({
                id: `chat_offline_projection_${turn.id}`,
                sessionId: session.id,
                ...(session.isGroup ? { groupSessionId: session.id } : {}),
                timestamp: turn.createdAt,
                content: `[Event ${ts}] ${summaryText}`,
            });
        }
    }

    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function escapeTagName(tag: string): string {
    return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractXmlField(rawText: string, tags: string[]): string {
    const candidates = tags
        .map((tag) => tag.trim())
        .filter(Boolean)
        .filter((tag, index, list) => list.indexOf(tag) === index);
    for (const tag of candidates) {
        const escaped = escapeTagName(tag);
        const match = rawText.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "i"));
        const content = match?.[1]?.trim();
        if (content) return content;
    }
    return "";
}

function stripXmlField(rawText: string, tag: string): string {
    if (!tag.trim()) return rawText;
    const escaped = escapeTagName(tag.trim());
    return rawText.replace(new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi"), "").trim();
}

export function parseOfflineResponse(rawText: string, summaryTag: string): ParsedOfflineResponse {
    const trimmed = rawText.trim();
    const effectiveSummaryTag = summaryTag.trim() || "summary";
    const summary = extractXmlField(trimmed, [effectiveSummaryTag, "summary"]);
    const content = extractXmlField(trimmed, ["content"])
        || stripXmlField(stripXmlField(trimmed, effectiveSummaryTag), "summary");
    return {
        rawText: trimmed,
        content: content.trim(),
        summary: summary.trim(),
        summaryTag: effectiveSummaryTag,
    };
}

export type ParsedOfflineSessionSummary = {
    title: string;
    summary: string;
};

/**
 * Parses the one-off "wrap up this offline visit" trigger call's reply (see
 * generateOfflineSessionSummary() in chat-engine.ts) -- a <title>/<summary> pair, the same
 * XML-tag convention as every other structured LLM response in this app. Falls back to using
 * the whole (trimmed) reply as the summary with no title when the model does not follow the
 * requested shape, rather than discarding a usable recap just because the wrapper tags are
 * missing.
 */
export function parseOfflineSessionSummary(rawText: string): ParsedOfflineSessionSummary {
    const trimmed = rawText.trim();
    const title = extractXmlField(trimmed, ["title"]);
    const summary = extractXmlField(trimmed, ["summary"])
        || stripXmlField(trimmed, "title");
    return { title: title.trim(), summary: summary.trim() };
}
