"use client";

import { useState, useEffect, useRef, useSyncExternalStore, useMemo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { getDebugChatState, getDebugPromptSnapshot, subscribeDebugChatState, subscribeDebugPromptSnapshot, type DebugPromptSnapshot } from "@/lib/debug-store";
import { previewPromptRequestSnapshot, ChatEngineError } from "@/lib/chat-engine";
import { previewGroupPromptRequestSnapshot } from "@/lib/group-chat-engine";
import { FileText, X } from "lucide-react";
import {
    previewMomentsPostPrompt,
    previewMomentsCommentPrompt,
    previewMomentsNPCPrompt,
    previewMomentsReplyPrompt,
    type MomentsPreviewResult,
} from "@/lib/moments-engine";
import { previewCalendarPromptPayload } from "@/lib/calendar-engine";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings, loadChatContacts, loadChatMessages, loadChatSessions, type ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { getAllPosts } from "@/lib/moments-storage";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { getWeekStartIso } from "@/lib/calendar-utils";
import { loadStorySessions, loadStoryMessages } from "@/lib/story-storage";
import { previewStoryPromptPayload } from "@/lib/story-engine";
import { loadVnSessions, loadVnMessages } from "@/lib/vn-storage";
import { previewVnPromptPayload } from "@/lib/vn-engine";
import { EXTRA_PROMPT_APPS, type ExtraPromptAppId } from "@/components/debug-prompt-registry";
import { previewCheckPhonePromptPayload } from "@/lib/checkphone-engine";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId } from "@/lib/checkphone-config";
import { hydrateReadingStorage, loadBooks, loadChapters, loadAnnotations } from "@/lib/reading-storage";
import { previewReadingAnnotationPrompt, previewReadingDiscussPrompt } from "@/lib/reading-engine";
import { previewDwellingPromptPayload, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { loadDiaryEntries } from "@/lib/diary-entry-storage";
import { previewDiaryEntryPromptPayload } from "@/lib/diary-entry-engine";
import { fetchNoteWall, fetchNoteWallComments } from "@/lib/notewall-client";
import { previewNoteWallPromptPayload, type NoteWallReplyCandidate } from "@/lib/notewall-engine";
import { loadXiaohongshuState } from "@/lib/xiaohongshu-storage";
import { previewXiaohongshuPromptPayload } from "@/lib/xiaohongshu-engine";
import { loadCoCreateSession } from "@/lib/cocreate-storage";
import { previewCoCreatePromptPayload } from "@/lib/cocreate-engine";
import { previewShoppingPromptPayload } from "@/lib/shopping-engine";
import { previewInterviewMagazinePromptPayload } from "@/lib/interview-magazine-engine";
import { hydrateMapStorage, loadMapWorlds, getLatestSave } from "@/lib/map-storage";
import { previewAdventureCompanionPromptPayload } from "@/lib/map-rpg-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { BookChapter } from "@/lib/reading-types";
import type { CoCreateMode } from "@/lib/cocreate-types";
import type { MapWorld, GameSave } from "@/lib/map-types";


type CoreDebugMode = "chat" | "moments" | "calendar" | "story" | "vn";
type DebugMode = CoreDebugMode | ExtraPromptAppId;

type UnifiedMessage = {
    role: string;
    content: string | import("@/lib/llm-prompt-assembler").LLMContentPart[];
    marker?: string;
    depth?: number;
    order?: number;
};

type PromptPreviewResult = {
    messages: LLMMessage[];
    characterName: string;
    model: string;
    presetName: string;
};

type FloatingPosition = {
    left: number;
    top: number;
};

type FloatingDragState = FloatingPosition & {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

function stringifyContent(content: UnifiedMessage["content"]): string {
    if (typeof content === "string") return content;
    return content.map(p => p.type === "text" ? p.text : "[Image]").join("\n");
}

function splitMarkerBadges(marker?: string): string[] {
    if (!marker) return [];
    return marker.split(" + ").map(part => part.trim()).filter(Boolean);
}

function isExtraPromptMode(mode: DebugMode): mode is ExtraPromptAppId {
    return EXTRA_PROMPT_APPS.some(app => app.id === mode);
}

export function DebugPromptPanel() {
    const chatState = useSyncExternalStore(subscribeDebugChatState, getDebugChatState, () => null);
    const promptSnapshot = useSyncExternalStore(subscribeDebugPromptSnapshot, getDebugPromptSnapshot, () => null);
    const [collapsed, setCollapsed] = useState(true);
    const [enabled, setEnabled] = useState(false);
    const [mode, setMode] = useState<DebugMode>("chat");
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
    const [draggingFloatingButton, setDraggingFloatingButton] = useState(false);
    const floatingDragRef = useRef<FloatingDragState | null>(null);
    const suppressFloatingClickRef = useRef(false);
    const [selectedChatSessionId, setSelectedChatSessionId] = useState("");
    const [followUpMode, setFollowUpMode] = useState(false);

    // Moments state
    const [momentsResult, setMomentsResult] = useState<MomentsPreviewResult | null>(null);
    const [momentsType, setMomentsType] = useState<"post" | "comment" | "npc" | "reply">("post");
    const [selectedCharId, setSelectedCharId] = useState<string>("");
    const [selectedPostId, setSelectedPostId] = useState<string>("");

    // Calendar state
    const [calendarResult, setCalendarResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [calendarOwnerId, setCalendarOwnerId] = useState<string>("");
    const [calendarWeekStart, setCalendarWeekStart] = useState<string>(() => getWeekStartIso(new Date()));

    // Story state
    const [storyResult, setStoryResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [storyCharacterId, setStoryCharacterId] = useState<string>("");

    // VN state
    const [vnResult, setVnResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [vnCharacterId, setVnCharacterId] = useState<string>("");

    // Extra app state
    const [extraResult, setExtraResult] = useState<PromptPreviewResult | null>(null);
    const [extraAppId, setExtraAppId] = useState<ExtraPromptAppId>("checkphone");
    const [extraCharacterId, setExtraCharacterId] = useState<string>("");
    const [checkPhoneAppId, setCheckPhoneAppId] = useState<CheckPhoneAppId | "manifest">("manifest");
    const [readingBookId, setReadingBookId] = useState<string>("");
    const [readingChapterIndex, setReadingChapterIndex] = useState<string>("");
    const [readingChapters, setReadingChapters] = useState<BookChapter[]>([]);
    const [readingStorageVersion, setReadingStorageVersion] = useState(0);
    const [readingMode, setReadingMode] = useState<"annotate" | "discuss">("annotate");
    const [dwellingMode, setDwellingMode] = useState<DwellingRefreshMode | "explore">("full");
    const [noteWallMode, setNoteWallMode] = useState<"note" | "reply">("note");
    const [xiaohongshuMode, setXiaohongshuMode] = useState<"activity" | "reaction" | "comment" | "mention">("activity");
    const [coCreateMode, setCoCreateMode] = useState<CoCreateMode>("write");
    const [shoppingMode, setShoppingMode] = useState<"catalog" | "search">("catalog");
    const [shoppingQuery, setShoppingQuery] = useState("gift");
    const [interviewMode, setInterviewMode] = useState<"opening" | "host" | "answer" | "article">("opening");
    const [interviewTheme, setInterviewTheme] = useState("An interview about being present");
    const [adventureWorldId, setAdventureWorldId] = useState<string>("");
    const [adventureStorageVersion, setAdventureStorageVersion] = useState(0);
    const [adventureInstructionMode, setAdventureInstructionMode] = useState<"turn" | "exit">("turn");

    // Shared
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
    const scrollRef = useRef<HTMLDivElement>(null);
    const chatSessionOptions = useMemo(() => {
        if (typeof window === "undefined") return [] as { session: ChatSession; label: string }[];
        const sessions = loadChatSessions();
        const chars = loadCharacters();
        const charNameById = new Map(chars.map(c => [c.id, c.name]));
        return sessions.map(session => {
            if (session.isGroup) {
                const fallbackName = (session.participantIds || [])
                    .map(id => charNameById.get(id) || id)
                    .slice(0, 3)
                    .join("、");
                return {
                    session,
                    label: `Group Chat · ${session.groupName || fallbackName || "Unnamed Group Chat"}`,
                };
            }
            return {
                session,
                label: charNameById.get(session.contactId) || session.alias || session.contactId,
            };
        });
    }, [enabled, chatState?.session?.id]);
    const activeChatSession = chatSessionOptions.find(option => option.session.id === selectedChatSessionId)?.session
        ?? chatState?.session
        ?? null;
    const activeChatSnapshot: DebugPromptSnapshot | null = (() => {
        if (!activeChatSession) return null;
        if (!promptSnapshot) return null;
        const appTags = promptSnapshot.appTags || [];
        const isChatRequest = promptSnapshot.appId === "chat"
            || promptSnapshot.appId === "group_chat"
            || appTags.includes("chat")
            || appTags.includes("group_chat");
        if (!isChatRequest) return null;
        if (promptSnapshot.sessionId !== activeChatSession.id) return null;
        return promptSnapshot;
    })();

    // Clear on mode/session change
    useEffect(() => {
        setMomentsResult(null);
        setCalendarResult(null);
        setStoryResult(null);
        setVnResult(null);
        setExtraResult(null);
        setError(null);
        setExpandedIdx(new Set());
    }, [activeChatSession?.id, mode, extraAppId, readingMode]);

    useEffect(() => {
        if (selectedChatSessionId && chatSessionOptions.some(option => option.session.id === selectedChatSessionId)) return;
        const nextSessionId = chatState?.session?.id
            ?? chatSessionOptions[0]?.session.id
            ?? "";
        if (nextSessionId !== selectedChatSessionId) setSelectedChatSessionId(nextSessionId);
    }, [chatSessionOptions, chatState?.session?.id, selectedChatSessionId]);

    useEffect(() => {
        const syncEnabled = (event?: Event) => {
            const detail = (event as CustomEvent | undefined)?.detail;
            const nextEnabled = typeof detail?.promptViewerEnabled === "boolean"
                ? detail.promptViewerEnabled
                : loadChatAppSettings().promptViewerEnabled === true;
            setEnabled(nextEnabled);
            if (!nextEnabled) setCollapsed(true);
        };
        syncEnabled();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
    }, []);

    useEffect(() => {
        if (mode !== "chat" || !activeChatSnapshot) return;
        setError(null);
        setExpandedIdx(new Set());
        requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
    }, [activeChatSnapshot?.id, mode]);

    // Get unified messages for display.
    const displayMessages: UnifiedMessage[] = (() => {
        if (mode === "chat" && activeChatSnapshot) {
            return activeChatSnapshot.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m.marker,
            }));
        }
        if (mode === "moments" && momentsResult) {
            return momentsResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "calendar" && calendarResult) {
            return calendarResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "story" && storyResult) {
            return storyResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "vn" && vnResult) {
            return vnResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (isExtraPromptMode(mode) && extraResult) {
            return extraResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        return [];
    })();

    const resultMeta = mode === "chat"
        ? activeChatSnapshot
        : mode === "moments"
            ? momentsResult
            : mode === "calendar"
                ? calendarResult
                : mode === "story"
                    ? storyResult
                    : mode === "vn"
                        ? vnResult
                        : extraResult;

    // ── Chat Preview ──
    async function handleChatPreview() {
        if (!activeChatSession) return;
        setError(null);
        setLoading(true);
        try {
            const latestMessages = loadChatMessages(activeChatSession.id);
            if (activeChatSession.isGroup) {
                await previewGroupPromptRequestSnapshot(activeChatSession, latestMessages);
            } else {
                await previewPromptRequestSnapshot(
                    activeChatSession,
                    latestMessages,
                    followUpMode
                        ? { followUpAuto: true, appTags: ["chat", "text", "followup"] }
                        : { appTags: ["chat", "text"] }
                );
            }
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof ChatEngineError ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    // ── Calendar Preview ──
    async function handleCalendarPreview() {
        setError(null);
        setLoading(true);
        try {
            const result = await previewCalendarPromptPayload("character", calendarOwnerId, calendarWeekStart);
            setCalendarResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setCalendarResult(null);
        } finally {
            setLoading(false);
        }
    }

    async function handleStoryPreview() {
        if (!storyCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            const session = loadStorySessions().find(s => s.characterId === storyCharacterId);
            const history = session ? loadStoryMessages(session.id) : [];
            const result = await previewStoryPromptPayload(storyCharacterId, history, {
                sessionContextExcludedTags: session?.contextExcludedTags,
            });
            setStoryResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStoryResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── VN Preview ──
    async function handleVnPreview() {
        if (!vnCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            const session = loadVnSessions().find(s => s.characterId === vnCharacterId);
            const history = session ? loadVnMessages(session.id) : [];
            const result = await previewVnPromptPayload(vnCharacterId, history);
            setVnResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setVnResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── Moments Preview ──
    async function handleMomentsPreview() {
        if (!selectedCharId) return;
        setError(null);
        setLoading(true);
        try {
            let result: MomentsPreviewResult | null;
            if (momentsType === "post") {
                result = await previewMomentsPostPrompt(selectedCharId);
            } else {
                if (!selectedPostId) {
                    setError("Please select a post first");
                    setLoading(false);
                    return;
                }
                if (momentsType === "comment") {
                    result = await previewMomentsCommentPrompt(selectedCharId, selectedPostId);
                } else if (momentsType === "npc") {
                    result = await previewMomentsNPCPrompt(selectedCharId, selectedPostId);
                } else {
                    result = await previewMomentsReplyPrompt(selectedCharId, selectedPostId);
                }
            }
            if (!result) {
                setError("Unable to generate preview. Please check if the character has an API and preset bound");
                setLoading(false);
                return;
            }
            setMomentsResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(String(e));
            setMomentsResult(null);
        } finally {
            setLoading(false);
        }
    }

    async function handleExtraPreview() {
        const requiresCharacter = extraAppId !== "shopping";
        if (requiresCharacter && !extraCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            let result: PromptPreviewResult;
            if (extraAppId === "checkphone") {
                result = await previewCheckPhonePromptPayload(extraCharacterId, checkPhoneAppId);
            } else if (extraAppId === "reading") {
                const book = loadBooks().find(item => item.id === readingBookId);
                const chapter = readingChapters.find(item => String(item.index) === readingChapterIndex);
                if (!book || !chapter) throw new Error("Please select a book and chapter first");
                const annotations = await loadAnnotations(book.id, chapter.index);
                if (readingMode === "discuss") {
                    const session = chatSessionOptions.find(option => !option.session.isGroup && option.session.contactId === extraCharacterId)?.session;
                    if (!session) throw new Error("No chat session found for this character, cannot preview reading dialogue");
                    result = await previewReadingDiscussPrompt(session, book, {
                        chapterTitle: chapter.title,
                        chapterContent: [
                            "Current reading focus: full chapter",
                            "Context scope this time: full chapter",
                            "",
                            chapter.paragraphs.map((paragraph, index) => `[${index + 1}] ${paragraph}`).join("\n\n"),
                        ].join("\n"),
                        annotations,
                    }, extraCharacterId);
                } else {
                    result = await previewReadingAnnotationPrompt(book, chapter, annotations, extraCharacterId);
                }
            } else if (extraAppId === "dwelling") {
                result = await previewDwellingPromptPayload(extraCharacterId, dwellingMode);
            } else if (extraAppId === "diary") {
                const entries = loadDiaryEntries().filter(entry => entry.characterId === extraCharacterId);
                result = await previewDiaryEntryPromptPayload(extraCharacterId, entries);
            } else if (extraAppId === "notewall") {
                const wall = await fetchNoteWall().catch(() => ({ notes: [] }));
                const candidates: NoteWallReplyCandidate[] = noteWallMode === "reply"
                    ? await Promise.all(wall.notes.slice(0, 5).map(async note => ({
                        note,
                        comments: await fetchNoteWallComments(note.id).catch(() => []),
                    })))
                    : [];
                result = await previewNoteWallPromptPayload(extraCharacterId, noteWallMode, wall.notes, candidates);
            } else if (extraAppId === "xiaohongshu") {
                const state = loadXiaohongshuState();
                result = await previewXiaohongshuPromptPayload(extraCharacterId, xiaohongshuMode, state.notes, state.settings);
            } else if (extraAppId === "cocreate") {
                const session = loadCoCreateSession(extraCharacterId);
                result = await previewCoCreatePromptPayload(session, coCreateMode);
            } else if (extraAppId === "shopping") {
                result = await previewShoppingPromptPayload(shoppingMode, { query: shoppingQuery });
            } else if (extraAppId === "interview") {
                result = await previewInterviewMagazinePromptPayload({
                    theme: interviewTheme,
                    characterIds: [extraCharacterId],
                    mode: interviewMode,
                    transcript: [],
                });
            } else {
                if (!selectedAdventureSave) throw new Error("Please select an adventure world with a save first");
                const agent = selectedAdventureSave.agents.find(item => item.characterId === extraCharacterId);
                const sharedUserIdentity = selectedAdventureSave.agents.length > 1 ? resolveUserIdentity(undefined, "adventure") : undefined;
                result = await previewAdventureCompanionPromptPayload(
                    extraCharacterId,
                    selectedAdventureSave.streamLog,
                    sharedUserIdentity,
                    agent?.affinity,
                    adventureInstructionMode === "exit"
                        ? { instruction: "{{user}} just decided to leave the current event and not continue. Respond in your own voice to {{user}}'s departure: what would you say, how would you react, and will you follow, try to stop them, or silently watch." }
                        : undefined,
                );
            }
            setExtraResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setExtraResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── Expand/Collapse ──
    function toggleExpand(idx: number) {
        setExpandedIdx(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
        });
    }
    function expandAll() { setExpandedIdx(new Set(displayMessages.map((_, i) => i))); }
    function collapseAll() { setExpandedIdx(new Set()); }
    const allMessagesExpanded = displayMessages.length > 0 && expandedIdx.size === displayMessages.length;

    function clampFloatingPosition(value: number, max: number): number {
        return Math.min(Math.max(value, 12), max);
    }

    function getFloatingButtonBounds(button: HTMLButtonElement) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        const rect = button.getBoundingClientRect();
        return {
            left: rect.left - parentRect.left,
            top: rect.top - parentRect.top,
            maxLeft: Math.max(12, parentRect.width - rect.width - 12),
            maxTop: Math.max(12, parentRect.height - rect.height - 12),
        };
    }

    function handleFloatingPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        event.stopPropagation();
        const button = event.currentTarget;
        const bounds = getFloatingButtonBounds(button);
        floatingDragRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            left: bounds.left,
            top: bounds.top,
            maxLeft: bounds.maxLeft,
            maxTop: bounds.maxTop,
            moved: false,
        };
        setDraggingFloatingButton(true);
        button.setPointerCapture(event.pointerId);
    }

    function handleFloatingPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
            drag.moved = true;
        }
        setFloatingPosition({
            left: clampFloatingPosition(drag.left + deltaX, drag.maxLeft),
            top: clampFloatingPosition(drag.top + deltaY, drag.maxTop),
        });
    }

    function handleFloatingPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (drag.moved) suppressFloatingClickRef.current = true;
        floatingDragRef.current = null;
        setDraggingFloatingButton(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleFloatingButtonClick(event: ReactMouseEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (suppressFloatingClickRef.current) {
            suppressFloatingClickRef.current = false;
            return;
        }
        setCollapsed(false);
    }

    function handleModeChange(nextMode: DebugMode) {
        if (isExtraPromptMode(nextMode)) {
            setExtraAppId(nextMode);
        }
        setMode(nextMode);
    }

    const totalChars = displayMessages.reduce((sum, m) => sum + stringifyContent(m.content).length, 0);
    const estimatedTokens = Math.round(totalChars / 2);

    const debugTabs: [DebugMode, string][] = [
        ["chat", activeChatSession?.isGroup ? "Group Chat" : "Chat"],
        ["moments", "Moments"],
        ["calendar", "Calendar"],
        ["story", "Story"],
        ["vn", "VN"],
        ...EXTRA_PROMPT_APPS.map(app => [app.id, app.label] as [DebugMode, string]),
    ];

    // ── Character/Post options for moments (memoized) ──
    const charOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        const contacts = loadChatContacts();
        const chars = loadCharacters();
        const map = new Map<string, string>();
        contacts.forEach(c => {
            map.set(c.characterId, chars.find(ch => ch.id === c.characterId)?.name ?? c.characterId);
        });
        chars.forEach(c => map.set(c.id, c.name));
        return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    }, []);

    const readingBookOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        return loadBooks().map(book => ({ id: book.id, title: book.title }));
    }, [enabled, extraAppId, readingStorageVersion]);

    const adventureWorldOptions = useMemo(() => {
        if (typeof window === "undefined") return [] as MapWorld[];
        return loadMapWorlds().filter(world => world.status !== "generating");
    }, [enabled, extraAppId, adventureStorageVersion]);
    const selectedAdventureWorld = adventureWorldOptions.find(world => world.id === adventureWorldId) ?? null;
    const selectedAdventureSave: GameSave | null = useMemo(
        () => selectedAdventureWorld ? getLatestSave(selectedAdventureWorld.id) : null,
        [selectedAdventureWorld, adventureStorageVersion],
    );

    const postOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        const posts = getAllPosts();
        const chars = loadCharacters();
        return posts.slice(0, 30).map(p => {
            const authorName = p.authorType === "user" ? "Me" : (chars.find(c => c.id === p.authorId)?.name ?? "?");
            return { id: p.id, label: `${authorName}: ${p.content.slice(0, 30)}...` };
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [momentsType]);

    useEffect(() => {
        if (calendarOwnerId || charOptions.length === 0) return;
        setCalendarOwnerId(charOptions[0].id);
    }, [calendarOwnerId, charOptions]);

    useEffect(() => {
        if (extraCharacterId || charOptions.length === 0) return;
        setExtraCharacterId(charOptions[0].id);
    }, [extraCharacterId, charOptions]);

    useEffect(() => {
        if (extraAppId !== "reading") return;
        let cancelled = false;
        hydrateReadingStorage().then(() => {
            if (!cancelled) setReadingStorageVersion(version => version + 1);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [extraAppId]);

    useEffect(() => {
        if (readingBookId || readingBookOptions.length === 0) return;
        setReadingBookId(readingBookOptions[0].id);
    }, [readingBookId, readingBookOptions]);

    useEffect(() => {
        let cancelled = false;
        if (!readingBookId) {
            setReadingChapters([]);
            setReadingChapterIndex("");
            return;
        }
        loadChapters(readingBookId).then(chapters => {
            if (cancelled) return;
            setReadingChapters(chapters);
            const currentExists = readingChapterIndex && chapters.some(chapter => String(chapter.index) === readingChapterIndex);
            if (!currentExists) setReadingChapterIndex(chapters[0] ? String(chapters[0].index) : "");
        }).catch(() => {
            if (cancelled) return;
            setReadingChapters([]);
            setReadingChapterIndex("");
        });
        return () => { cancelled = true; };
    }, [readingBookId, readingChapterIndex]);

    useEffect(() => {
        if (extraAppId !== "adventure") return;
        let cancelled = false;
        hydrateMapStorage().then(() => {
            if (!cancelled) setAdventureStorageVersion(version => version + 1);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [extraAppId]);

    useEffect(() => {
        if (adventureWorldId || adventureWorldOptions.length === 0) return;
        setAdventureWorldId(adventureWorldOptions[0].id);
    }, [adventureWorldId, adventureWorldOptions]);

    if (!enabled) return null;

    if (collapsed) {
        return (
            <button
                type="button"
                className="prompt-viewer-float-button"
                aria-label="Open prompt viewer"
                data-positioned={floatingPosition ? "" : undefined}
                data-dragging={draggingFloatingButton ? "" : undefined}
                onPointerDown={handleFloatingPointerDown}
                onPointerMove={handleFloatingPointerMove}
                onPointerUp={handleFloatingPointerEnd}
                onPointerCancel={handleFloatingPointerEnd}
                onClick={handleFloatingButtonClick}
                style={floatingPosition ? { left: floatingPosition.left, top: floatingPosition.top } : undefined}
            >
                <FileText size={24} strokeWidth={1.9} />
            </button>
        );
    }

    const renderCharSelect = (value: string, onChange: (v: string) => void) => (
        <select value={value} onChange={e => onChange(e.target.value)} className="pv-select">
            <option value="">Select character...</option>
            {charOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
    );

    const renderPreviewBtn = (onClick: () => void, disabled: boolean) => (
        <button onClick={onClick} disabled={disabled} className="pv-btn pv-btn-primary">
            {loading ? "Loading..." : "Preview"}
        </button>
    );

    const getExtraPreviewWarning = () => {
        if (extraAppId === "reading") {
            return "The actual context is injected based on the real reading scene, not by chapter — this is only a simulation";
        }
        if (extraAppId === "dwelling" && dwellingMode === "explore") {
            return "The actual context is injected based on the room, furniture, and item currently clicked in the dwelling — this only simulates using the first item";
        }
        if (extraAppId === "notewall" && noteWallMode === "reply") {
            return "The actual context is injected based on the notes and comments actually triggered on the note wall — this only simulates using candidate notes";
        }
        if (extraAppId === "xiaohongshu") {
            return "The actual context is injected based on the note, comment, or @mention currently triggered in Xiaohongshu — this only simulates using existing data";
        }
        if (extraAppId === "cocreate") {
            return "The actual context is injected based on the current co-creation session and the content just sent — this only simulates based on the saved session";
        }
        if (extraAppId === "interview") {
            return "The actual context is injected based on the live interview flow and existing transcript — this only simulates with an empty transcript";
        }
        if (extraAppId === "adventure") {
            return "The actual context is injected based on the current adventure event, party status, and this turn's actions — this only simulates based on the most recent save";
        }
        return null;
    };

    const renderExtraPreviewWarning = () => {
        const warning = getExtraPreviewWarning();
        return warning ? <span className="pv-context-warning">{warning}</span> : null;
    };

    const renderExtraControls = () => (
        <>
            {extraAppId !== "shopping" && renderCharSelect(extraCharacterId, setExtraCharacterId)}
            {extraAppId === "checkphone" && (
                <select value={checkPhoneAppId} onChange={e => setCheckPhoneAppId(e.target.value as CheckPhoneAppId | "manifest")} className="pv-select">
                    <option value="manifest">Home Screen Manifest</option>
                    {Object.values(CHECKPHONE_APP_SPECS).map(spec => (
                        <option key={spec.id} value={spec.id}>{spec.label}</option>
                    ))}
                </select>
            )}
            {extraAppId === "reading" && (
                <>
                    <select value={readingMode} onChange={e => setReadingMode(e.target.value as "annotate" | "discuss")} className="pv-select">
                        <option value="annotate">Annotate</option>
                        <option value="discuss">Discuss</option>
                    </select>
                    <select value={readingBookId} onChange={e => setReadingBookId(e.target.value)} className="pv-select">
                        <option value="">Select book...</option>
                        {readingBookOptions.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
                    </select>
                    <select value={readingChapterIndex} onChange={e => setReadingChapterIndex(e.target.value)} className="pv-select">
                        <option value="">Select chapter...</option>
                        {readingChapters.map(chapter => (
                            <option key={chapter.id} value={String(chapter.index)}>{chapter.title}</option>
                        ))}
                    </select>
                </>
            )}
            {extraAppId === "dwelling" && (
                <select value={dwellingMode} onChange={e => setDwellingMode(e.target.value as DwellingRefreshMode | "explore")} className="pv-select">
                    <option value="full">Full Dwelling</option>
                    <option value="items">Refresh Items</option>
                    <option value="explore">Explore Item</option>
                </select>
            )}
            {extraAppId === "notewall" && (
                <select value={noteWallMode} onChange={e => setNoteWallMode(e.target.value as "note" | "reply")} className="pv-select">
                    <option value="note">Generate Note</option>
                    <option value="reply">Reply to Note</option>
                </select>
            )}
            {extraAppId === "xiaohongshu" && (
                <select value={xiaohongshuMode} onChange={e => setXiaohongshuMode(e.target.value as "activity" | "reaction" | "comment" | "mention")} className="pv-select">
                    <option value="activity">Browse Interaction</option>
                    <option value="reaction">Respond to User Note</option>
                    <option value="comment">Reply to Comment</option>
                    <option value="mention">Reply to Mention</option>
                </select>
            )}
            {extraAppId === "cocreate" && (
                <select value={coCreateMode} onChange={e => setCoCreateMode(e.target.value as CoCreateMode)} className="pv-select">
                    <option value="write">Write</option>
                    <option value="discuss">Discuss</option>
                </select>
            )}
            {extraAppId === "shopping" && (
                <>
                    <select value={shoppingMode} onChange={e => setShoppingMode(e.target.value as "catalog" | "search")} className="pv-select">
                        <option value="catalog">Homepage Recommendations</option>
                        <option value="search">Search Results</option>
                    </select>
                    {shoppingMode === "search" && (
                        <input value={shoppingQuery} onChange={e => setShoppingQuery(e.target.value)} className="pv-select" placeholder="Search term" />
                    )}
                </>
            )}
            {extraAppId === "interview" && (
                <>
                    <select value={interviewMode} onChange={e => setInterviewMode(e.target.value as "opening" | "host" | "answer" | "article")} className="pv-select">
                        <option value="opening">Opening Question</option>
                        <option value="host">Host Follow-up</option>
                        <option value="answer">Guest Answer</option>
                        <option value="article">Column Draft</option>
                    </select>
                    <input value={interviewTheme} onChange={e => setInterviewTheme(e.target.value)} className="pv-select" placeholder="Interview theme" />
                </>
            )}
            {extraAppId === "adventure" && (
                <>
                    <select value={adventureWorldId} onChange={e => setAdventureWorldId(e.target.value)} className="pv-select">
                        <option value="">Select adventure world...</option>
                        {adventureWorldOptions.map(world => (
                            <option key={world.id} value={world.id}>{world.skeleton.world.name || "Unnamed World"}</option>
                        ))}
                    </select>
                    <select value={adventureInstructionMode} onChange={e => setAdventureInstructionMode(e.target.value as "turn" | "exit")} className="pv-select">
                        <option value="turn">Character Declaration</option>
                        <option value="exit">Departure Response</option>
                    </select>
                </>
            )}
            {renderPreviewBtn(handleExtraPreview, loading || (extraAppId !== "shopping" && !extraCharacterId))}
            {renderExtraPreviewWarning()}
        </>
    );

    return (
        <div className="pv-panel" onPointerDown={e => e.stopPropagation()}>
            {/* Header */}
            <div className="pv-header">
                <span className="pv-header-title">Prompt Viewer</span>
                {resultMeta && <span className="pv-header-meta">{resultMeta.characterName}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" className="pv-close-btn" aria-label="Close" onClick={(e) => { e.stopPropagation(); setCollapsed(true); }}>
                    <X size={18} strokeWidth={2} />
                </button>
            </div>

            {/* Tabs */}
            <div className="pv-tabs">
                {debugTabs.map(([key, label]) => (
                    <button key={key} className="pv-tab" onClick={() => handleModeChange(key)} {...(mode === key ? { "data-active": "" } : {})}>
                        {label}
                    </button>
                ))}
            </div>
            <div className="pv-divider" />

            {/* Toolbar */}
            <div className="pv-toolbar">
                {mode === "chat" && (
                    <>
                        <select
                            value={activeChatSession?.id || ""}
                            onChange={e => setSelectedChatSessionId(e.target.value)}
                            className="pv-select"
                        >
                            <option value="">Select chat...</option>
                            {chatSessionOptions.map(option => (
                                <option key={option.session.id} value={option.session.id}>{option.label}</option>
                            ))}
                        </select>
                        <button onClick={handleChatPreview} disabled={loading || !activeChatSession} className="pv-btn pv-btn-primary">
                            {loading ? "Loading..." : "Preview Prompt"}
                        </button>
                        {activeChatSession && !activeChatSession.isGroup && (
                            <button onClick={() => setFollowUpMode(f => !f)} className="pv-toggle" {...(followUpMode ? { "data-active": "" } : {})}>
                                {followUpMode ? "Follow-up ON" : "Follow-up OFF"}
                            </button>
                        )}
                    </>
                )}
                {mode === "moments" && (
                    <>
                        <select value={momentsType} onChange={e => setMomentsType(e.target.value as "post" | "comment" | "npc" | "reply")} className="pv-select">
                            <option value="post">Post</option>
                            <option value="comment">Comment</option>
                            <option value="npc">NPC Interaction</option>
                            <option value="reply">Reply</option>
                        </select>
                        {renderCharSelect(selectedCharId, setSelectedCharId)}
                        {(momentsType !== "post") && (
                            <select value={selectedPostId} onChange={e => setSelectedPostId(e.target.value)} className="pv-select">
                                <option value="">Select post...</option>
                                {postOptions.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                        )}
                        {renderPreviewBtn(handleMomentsPreview, !selectedCharId || loading)}
                    </>
                )}
                {mode === "calendar" && (
                    <>
                        {renderCharSelect(calendarOwnerId, setCalendarOwnerId)}
                        <input type="date" value={calendarWeekStart} onChange={e => setCalendarWeekStart(e.target.value || getWeekStartIso(new Date()))} className="pv-select" />
                        {renderPreviewBtn(handleCalendarPreview, loading || !calendarOwnerId)}
                    </>
                )}
                {mode === "story" && (
                    <>
                        {renderCharSelect(storyCharacterId, setStoryCharacterId)}
                        {renderPreviewBtn(handleStoryPreview, loading || !storyCharacterId)}
                    </>
                )}
                {mode === "vn" && (
                    <>
                        {renderCharSelect(vnCharacterId, setVnCharacterId)}
                        {renderPreviewBtn(handleVnPreview, loading || !vnCharacterId)}
                    </>
                )}
                {isExtraPromptMode(mode) && renderExtraControls()}
                {displayMessages.length > 0 && (
                    <button onClick={allMessagesExpanded ? collapseAll : expandAll} className="pv-btn pv-btn-ghost">
                        {allMessagesExpanded ? "Collapse All" : "Expand All"}
                    </button>
                )}
                {resultMeta && (
                    <span className="pv-toolbar-meta">{resultMeta.model} · {resultMeta.presetName}</span>
                )}
            </div>
            <div className="pv-divider" />

            {/* Body */}
            <div ref={scrollRef} className="pv-body">
                {error && <div className="pv-error">{error}</div>}

                {displayMessages.map((msg, idx) => {
                    const isExpanded = expandedIdx.has(idx);
                    const textContent = stringifyContent(msg.content);
                    const preview = textContent.slice(0, 120);
                    const needsTruncation = textContent.length > 120;
                    const markerBadges = splitMarkerBadges(msg.marker);

                    return (
                        <div key={idx} className="pv-msg">
                            <div className="pv-msg-header" onClick={() => toggleExpand(idx)}>
                                <span className="pv-msg-role" data-role={msg.role}>{msg.role}</span>
                                {markerBadges.map((badge, bi) => (
                                    <span key={`${idx}-${bi}`} className="pv-msg-badge">{badge}</span>
                                ))}
                                {msg.depth !== undefined && (
                                    <span className="pv-msg-depth">D:{msg.depth} O:{msg.order}</span>
                                )}
                                <span style={{ flex: 1 }} />
                                <span className="pv-msg-toggle">
                                    {isExpanded ? "▼" : "▶"} {textContent.length}c
                                </span>
                            </div>
                            <div className="pv-msg-body" style={{
                                maxHeight: isExpanded ? undefined : 60,
                                overflow: isExpanded ? undefined : "hidden",
                            }}>
                                {isExpanded ? textContent : (needsTruncation ? preview + "..." : preview)}
                            </div>
                        </div>
                    );
                })}

                {displayMessages.length === 0 && !error && (
                    <div className="pv-empty">
                        {mode === "chat"
                            ? (activeChatSession ? "Click 'Preview Prompt' to see the real prompt that will be sent next" : "Select a chat, then click 'Preview Prompt'")
                            : mode === "moments" ? "Select a character, then click 'Preview' to see the Moments Prompt"
                            : mode === "calendar" ? "Select a character and date, then click 'Preview'"
                            : mode === "vn" ? "Select a character, then click 'Preview' to see the VN Prompt"
                            : mode === "story" ? "Select a character, then click 'Preview' to see the Story Prompt"
                            : isExtraPromptMode(mode)
                                ? EXTRA_PROMPT_APPS.find(app => app.id === mode)?.emptyText ?? "Select an app, then click 'Preview'"
                                : "Select an app, then click 'Preview'"
                        }
                    </div>
                )}
            </div>

            {/* Footer */}
            {displayMessages.length > 0 && (
                <>
                    <div className="pv-divider" />
                    <div className="pv-footer">
                        <span>{displayMessages.length} messages</span>
                        <span>{totalChars.toLocaleString()} characters</span>
                        <span>~{estimatedTokens.toLocaleString()} tokens</span>
                    </div>
                </>
            )}
        </div>
    );
}
