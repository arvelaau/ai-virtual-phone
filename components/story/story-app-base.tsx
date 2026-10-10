"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Menu, ArrowUp, Send, Square, BookOpen, Paintbrush, Plus, Smartphone, X } from "lucide-react";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryHtmlRenderer, type StoryVoiceSegment } from "@/components/ui/story-html-renderer";
import { StorySettingsPage, STORY_DEFAULT_STATUS_RENDER, STORY_DEFAULT_THEATER_RENDER } from "@/components/story/story-settings-page";
import { AppCardView } from "@/components/chat/app-card-view";
import { appCardRendersBeforeText } from "@/lib/app-card-settings";
import { toCustomAppIconId } from "@/lib/custom-app-types";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { loadBindingConfig, loadPresets, resolveBinding, resolveUserIdentity } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  createStoryGroup,
  deleteStoryGroup,
  deleteStorySessions,
  getStorySessionOwnerKey,
  hydrateStoryStorage,
  loadStoryGroups,
  loadStoryMessages,
  loadStorySessions,
  loadStorySessionsForOwner,
  loadStorySchemeRepository,
  pushStoryMessage,
  resolveActiveQuickInputScheme,
  saveStorySchemeRepository,
  STORY_DEFAULT_QUICK_INPUT_OPTIONS,
  STORY_SCHEME_REPO_EVENT,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryMessage,
  type StorySchemeRepository,
  type StorySession,
  updateStorySession,
  updateStoryGroup,
  type StoryCharacterSettings,
  type StoryGroup,
  type StoryOwnerType,
} from "@/lib/story-storage";
import { createOrGetSession, hydrateChatStorage, loadChatMessages, loadChatSessions, markChatSessionRead, pushChatMessage } from "@/lib/chat-storage";
import { flattenCompletionResult, generateChatCompletion } from "@/lib/chat-engine";
import { generateGroupChatCompletion } from "@/lib/group-chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { downloadFile } from "@/lib/download-utils";
import {
  playAudioBlobViaMediaElement,
  resolveVoiceConfig,
  synthesizeSpeech,
  unlockAudioPlayback,
} from "@/lib/tts-service";

type StoryAppProps = {
  onClose: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();
const storyVoiceCache = new Map<string, Blob>();
const STORY_VOICE_CACHE_LIMIT = 24;
const STORY_ACTIVE_CHARACTER_KEY = "story-last-active-character-id";
const STORY_ACTIVE_TARGET_KEY = "story-last-active-target-v1";
const STORY_ACTIVE_PAGE_MAP_KEY = "story-active-page-map-v1";
const DEFAULT_AUTO_READING_SPEED = 36;

registerKvMigration(STORY_ACTIVE_CHARACTER_KEY);
registerKvMigration(STORY_ACTIVE_TARGET_KEY);
registerKvMigration(STORY_ACTIVE_PAGE_MAP_KEY);

type StoryActiveTarget = { ownerType: StoryOwnerType; ownerId: string };

function loadStoryActivePageMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(kvGet(STORY_ACTIVE_PAGE_MAP_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function saveStoryActivePage(ownerKey: string, sessionId: string): void {
  kvSet(STORY_ACTIVE_PAGE_MAP_KEY, JSON.stringify({ ...loadStoryActivePageMap(), [ownerKey]: sessionId }));
}

function loadStoryActiveTarget(): StoryActiveTarget | null {
  try {
    const parsed = JSON.parse(kvGet(STORY_ACTIVE_TARGET_KEY) || "null") as StoryActiveTarget | null;
    if (!parsed || (parsed.ownerType !== "single" && parsed.ownerType !== "group") || !parsed.ownerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cacheStoryVoice(key: string, blob: Blob) {
  if (storyVoiceCache.has(key)) storyVoiceCache.delete(key);
  storyVoiceCache.set(key, blob);
  while (storyVoiceCache.size > STORY_VOICE_CACHE_LIMIT) {
    const oldest = storyVoiceCache.keys().next().value;
    if (!oldest) break;
    storyVoiceCache.delete(oldest);
  }
}

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "Paper" },
  { id: "warm", color: "#b89870", name: "Journal" },
  { id: "night", color: "#3a4560", name: "Night Read" },
  { id: "ink", color: "#1a1a1a", name: "Ink Wash" },
  { id: "rose", color: "#d4889a", name: "Rose" },
  { id: "sage", color: "#7a9a6a", name: "Moss" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "Start a new story from here.";
  const source = last.renderedContent || last.rawContent || "";
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "Continue from the last scene.";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["Organizing scene", "Continuing story", "Polishing dialogue", "Writing story"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
  hideAvatar,
  hideTimestamp,
  hideBubble,
}: {
  characterName: string;
  avatar?: string;
  hideAvatar: boolean;
  hideTimestamp: boolean;
  hideBubble: boolean;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant" data-hide-bubble={hideBubble ? "true" : undefined}>
      {(!hideAvatar || !hideTimestamp) ? (
        <div className="story-msg-head">
          {!hideAvatar ? (
            <div className="story-avatar-wrap">
              <Avatar src={avatar || undefined} name={characterName} size="md" />
            </div>
          ) : null}
          <div className="story-msg-meta">
            {!hideAvatar ? <span className="story-msg-name">{characterName}</span> : null}
            {!hideTimestamp ? <span className="story-msg-time story-generating-head">{status}</span> : null}
          </div>
        </div>
      ) : null}
      <div className="story-bubble-wrap">
        <div className="story-bubble story-generating-bubble" aria-label="Generating story">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  isGenerating,
  appendRequest,
  voiceEnabled,
  voicePlaying,
  voiceProgress,
  onSend,
  onContinue,
  autoReadingEnabled,
  autoReading,
  currentReadExpanded,
  canAutoRead,
  onToggleAutoReading,
  onCurrentReadControl,
  onStop,
  onPlayNext,
  quickInputEnabled,
  quickInputOptions,
  quickInputCursor,
}: {
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  voiceEnabled: boolean;
  voicePlaying: boolean;
  voiceProgress: { current: number; total: number };
  onSend: (text: string) => void;
  onContinue: () => void;
  autoReadingEnabled: boolean;
  autoReading: boolean;
  currentReadExpanded: boolean;
  canAutoRead: boolean;
  onToggleAutoReading: () => void;
  onCurrentReadControl: () => void;
  onStop: () => void;
  onPlayNext: () => void;
  quickInputEnabled: boolean;
  quickInputOptions: string[];
  quickInputCursor: "left" | "middle" | "right";
}) {
  const [draft, setDraft] = useState("");
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);
  // Remembers the input box's most recent selection/caret: clicking a quick-input option steals
  // focus from the textarea, so selectionStart is no longer reliable by then -- this ref is the
  // fallback.
  const lastSelectionRef = useRef<{ start: number; end: number } | null>(null);

  const rememberSelection = (el: HTMLTextAreaElement) => {
    lastSelectionRef.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const insertQuickOption = (option: string) => {
    const sel = lastSelectionRef.current;
    const start = Math.min(sel ? sel.start : draft.length, draft.length);
    const end = Math.max(start, Math.min(sel ? sel.end : draft.length, draft.length));
    const nextDraft = draft.slice(0, start) + option + draft.slice(end);
    // Caret landing spot: left = before the inserted content; middle = dead center of a paired
    // symbol (a single character counts as the end); right = after the inserted content.
    const caretOffset = quickInputCursor === "left"
      ? 0
      : quickInputCursor === "right"
        ? option.length
        : Math.ceil(option.length / 2);
    const caret = start + caretOffset;
    setDraft(nextDraft);
    lastSelectionRef.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer" data-quick-input={quickInputEnabled ? "true" : undefined}>
      {quickInputEnabled && quickPanelOpen && quickInputOptions.length > 0 ? (
        <div className="story-quick-panel" role="toolbar" aria-label="Quick-input panel">
          {quickInputOptions.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              className="story-quick-chip"
              onClick={() => insertQuickOption(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="story-sequence-play"
        data-enabled={voiceEnabled ? "true" : undefined}
        data-playing={voicePlaying ? "true" : undefined}
        onClick={onPlayNext}
        disabled={voicePlaying}
        aria-label="Play the next line of character dialogue"
        title="Play next line"
      >
        <span aria-hidden="true">{voicePlaying ? "…" : "▶"}</span>
        {voiceProgress.total > 0 ? (
          <small>{voiceProgress.current}/{voiceProgress.total}</small>
        ) : null}
      </button>
      <button
        type="button"
        className="story-continue-btn"
        onClick={onContinue}
        disabled={isGenerating}
      >
        Continue
      </button>
      {quickInputEnabled ? (
        <button
          type="button"
          className="story-quick-input-btn"
          data-open={quickPanelOpen ? "true" : undefined}
          onClick={() => setQuickPanelOpen((open) => !open)}
          aria-expanded={quickPanelOpen}
          aria-label={quickPanelOpen ? "Collapse the quick-input panel" : "Expand the quick-input panel"}
        >
          Input
        </button>
      ) : null}
      {autoReadingEnabled ? (
        <>
          <button
            type="button"
            className="story-auto-read-btn"
            data-reading={autoReading ? "true" : undefined}
            onClick={onToggleAutoReading}
            disabled={!autoReading && !canAutoRead}
            aria-label={autoReading ? "Stop auto-reading" : "Start auto-reading from the newest character message"}
          >
            {autoReading ? "Stop" : "Auto"}
          </button>
          <button
            type="button"
            className="story-current-read-btn"
            data-expanded={currentReadExpanded ? "true" : undefined}
            onClick={onCurrentReadControl}
            disabled={!canAutoRead}
            aria-label={currentReadExpanded ? "Start auto-reading from the current position" : "Expand the current-position read button"}
            title="Read from current position"
          >
            <BookOpen width={14} height={14} aria-hidden="true" />
            {currentReadExpanded ? <span>Read from current position</span> : null}
          </button>
        </>
      ) : null}
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => { resizeStoryComposerTextarea(event.currentTarget); rememberSelection(event.currentTarget); }}
        onSelect={(event) => rememberSelection(event.currentTarget)}
        onKeyUp={(event) => rememberSelection(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          rememberSelection(event.currentTarget);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="How will you respond?"
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "Stop story generation" : "Send story input"}
        title={isGenerating ? "Stop story generation" : "Send story input"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <Square size={17} /> : <ArrowUp className="story-send-icon" size={18} />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  // Shared scheme repository version: bumped when the repository's contents change (saved from
  // the settings page, or written by the mascot's own tools) so scheme-dependent UI refreshes.
  const [schemeRepoVersion, setSchemeRepoVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [floatingPhoneOpen, setFloatingPhoneOpen] = useState(false);
  const [floatingGroupSessionId, setFloatingGroupSessionId] = useState("");
  const [floatingChatDraft, setFloatingChatDraft] = useState("");
  const [floatingChatGenerating, setFloatingChatGenerating] = useState(false);
  const [floatingChatVersion, setFloatingChatVersion] = useState(0);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  // Generation state is tracked per session, so generating in session A doesn't also show
  // "generating" after switching to session B.
  const [generatingSessionIds, setGeneratingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // The drawer-swipe gesture uses a ref rather than state: touchmove fires every frame while a
  // finger is held down, and a per-frame setState would re-render the whole story page at event
  // frequency (on iOS, holding at the top/bottom edge while pulling shows up as continuous
  // reflow/flicker).
  const dragStartXRef = useRef<number | null>(null);
  const dragDeltaXRef = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const [quickStoryOpen, setQuickStoryOpen] = useState(false);
  const [quickStoryIndependent, setQuickStoryIndependent] = useState(false);
  const [playingVoiceSegmentId, setPlayingVoiceSegmentId] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [voiceSequenceProgress, setVoiceSequenceProgress] = useState({ current: 0, total: 0 });
  const [autoReading, setAutoReading] = useState(false);
  const [currentReadExpanded, setCurrentReadExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // ── Scroll-position restore on the round trip to/from the settings page ──
  // The settings page unmounts .story-stage entirely (it early-returns the settings page instead),
  // so returning mounts a fresh DOM node -- scrollTop resets to zero, which shows up as "open
  // settings, come back, and you're back at the top". This keeps recording the position on every
  // onScroll and writes it back on return; if the character or message count changed while
  // settings was open, the restore is abandoned in favor of sticking to the bottom instead.
  const stageScrollMemoRef = useRef(0);
  const settingsOpenSnapshotRef = useRef<{ sessionId: string; messageCount: number } | null>(null);
  const messagesLengthRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const voicePlaybackRef = useRef<{ abort: () => void } | null>(null);
  const voiceRequestIdRef = useRef(0);
  const voiceNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceSequenceIndexRef = useRef(0);
  const miniPhoneScrollRef = useRef<HTMLDivElement | null>(null);
  const autoStartedSessionIdsRef = useRef(new Set<string>());

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const storyGroups: StoryGroup[] = loadStoryGroups();
  const activeGroup = storyGroups.find((group) => group.id === activeGroupId) || null;
  const activeOwnerType: StoryOwnerType = activeGroup ? "group" : "single";
  const activeOwnerId = activeGroup?.id || activeCharacterId;
  const ownerSessions = activeOwnerId ? loadStorySessionsForOwner(activeOwnerType, activeOwnerId) : [];
  const ownerMainSession = ownerSessions.find((session) => (session.branchId || "main") === "main") || ownerSessions[0] || null;
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const storyDisplayName = activeGroup?.name || currentCharacter?.name || "Story";
  const storyAvatar = ownerMainSession?.storyAvatar || currentCharacter?.avatar || "";
  const uiPrefs = currentSession?.uiPrefs || {};
  const customFontSource = uiPrefs.customFontDataUrl || uiPrefs.customFontUrl || "";
  const storyShellStyle = customFontSource
    ? ({ "--story-font": '"StoryCustomFont", "Noto Serif SC", "Songti SC", serif' } as CSSProperties)
    : undefined;
  const customFontFace = customFontSource
    ? `@font-face{font-family:"StoryCustomFont";src:url(${JSON.stringify(customFontSource)});font-display:swap;}`
    : "";
  const storySettings: StoryCharacterSettings = currentSession?.settings || {};
  // Scheme definitions come from the shared repository (every character shares them); a
  // character's own settings only carry which one is enabled.
  const schemeRepo: StorySchemeRepository = useMemo(
    () => loadStorySchemeRepository(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schemeRepoVersion, ready],
  );
  const activeStatusScheme = schemeRepo.statusSchemes.find((item) => item.id === storySettings.activeStatusSchemeId)
    ?? storySettings.statusSchemes?.find((item) => item.id === storySettings.activeStatusSchemeId);
  const activeTheaterScheme = schemeRepo.theaterSchemes.find((item) => item.id === storySettings.activeTheaterSchemeId)
    ?? storySettings.theaterSchemes?.find((item) => item.id === storySettings.activeTheaterSchemeId);
  const activeStatusRenderHtml = activeStatusScheme?.renderHtml
    ?? (["status-default", "status-html"].includes(activeStatusScheme?.id || "") ? STORY_DEFAULT_STATUS_RENDER : "");
  const activeTheaterRenderHtml = activeTheaterScheme?.renderHtml
    ?? (["theater-default", "theater-furry"].includes(activeTheaterScheme?.id || "") ? STORY_DEFAULT_THEATER_RENDER : "");
  const boundPreset = useMemo(() => {
    if (!activeCharacterId) return null;
    const slot = resolveBinding(loadBindingConfig(), activeCharacterId, "story");
    return (slot.presetId ? loadPresets().find((item) => item.id === slot.presetId) : null)
      || loadPresets().find((item) => item.builtIn)
      || null;
  }, [activeCharacterId]);
  const floatingGroupChatCandidates = useMemo(() => activeGroup
    ? loadChatSessions().filter((item) => item.isGroup)
    : [], [activeGroup, floatingChatVersion]);
  const floatingChatSession = useMemo(() => {
    if (!activeCharacterId) return null;
    if (activeGroup) {
      const selected = floatingGroupChatCandidates.find((item) => item.id === floatingGroupSessionId);
      if (selected) return selected;
      return floatingGroupChatCandidates.find((item) => activeGroup.characterIds.every((id) => item.participantIds?.includes(id))) || floatingGroupChatCandidates[0] || null;
    }
    return loadChatSessions().find((item) => item.contactId === activeCharacterId && !item.isGroup) || null;
  }, [activeCharacterId, activeGroup, floatingChatVersion, floatingGroupChatCandidates, floatingGroupSessionId]);
  const floatingChatMessages = useMemo(() => floatingChatSession
    ? loadChatMessages(floatingChatSession.id).filter((item) => item.role === "user" || item.role === "assistant").slice(-30)
    : [], [floatingChatSession, floatingChatVersion]);
  const floatingChatContext = useMemo(() => floatingChatMessages.map((message) => {
    const name = message.role === "user" ? (userIdentity?.name || "User") : (currentCharacter?.name || "Character");
    const text = message.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return `${new Date(message.createdAt).toLocaleString()} ${name}: ${text}`;
  }).join("\n"), [currentCharacter?.name, floatingChatMessages, userIdentity?.name]);
  const isGenerating = Boolean(activeSessionId) && generatingSessionIds.has(activeSessionId);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id || "",
    [messages],
  );

  const markGenerating = useCallback((sessionId: string, on: boolean) => {
    setGeneratingSessionIds((prev) => {
      if (on === prev.has(sessionId)) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeGroup) {
      setFloatingGroupSessionId("");
      return;
    }
    if (floatingGroupSessionId && floatingGroupChatCandidates.some((item) => item.id === floatingGroupSessionId)) return;
    const matching = floatingGroupChatCandidates.find((item) => activeGroup.characterIds.every((id) => item.participantIds?.includes(id)));
    setFloatingGroupSessionId(matching?.id || floatingGroupChatCandidates[0]?.id || "");
  }, [activeGroup?.id, floatingGroupChatCandidates, floatingGroupSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      voiceRequestIdRef.current += 1;
      voicePlaybackRef.current?.abort();
      if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    voiceSequenceIndexRef.current = 0;
    setVoiceSequenceProgress({ current: 0, total: 0 });
    voiceRequestIdRef.current += 1;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setPlayingVoiceSegmentId(null);
  }, [activeSessionId, latestAssistantMessageId]);

  useLayoutEffect(() => {
    if (!floatingPhoneOpen) return;
    const node = miniPhoneScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [floatingChatGenerating, floatingChatVersion, floatingPhoneOpen]);

  function activateStorySession(session: StorySession) {
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id;
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setCustomCssDraft(session.customCSS || "");
    setFoldTagsDraft(session.foldTags ?? "think,thinking,story_status,story_theater");
    setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking,story_theater");
    const ownerKey = getStorySessionOwnerKey(session);
    saveStoryActivePage(ownerKey, session.id);
    kvSet(STORY_ACTIVE_TARGET_KEY, JSON.stringify({ ownerType: session.ownerType || "single", ownerId: session.ownerId || session.characterId }));
    kvSet(STORY_ACTIVE_CHARACTER_KEY, session.characterId);
    setStorageVersion((value) => value + 1);
  }

  function resolveOwnerSession(ownerType: StoryOwnerType, ownerId: string, primaryCharacterId: string, participantIds?: string[]): StorySession {
    const main = createOrGetStorySession(primaryCharacterId, { ownerType, ownerId, participantIds, branchId: "main" });
    const rememberedId = loadStoryActivePageMap()[`${ownerType}:${ownerId}`];
    return loadStorySessionsForOwner(ownerType, ownerId).find((session) => session.id === rememberedId) || main;
  }

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      const availableCharacters = loadCharacters();
      const groups = loadStoryGroups();
      const rememberedTarget = loadStoryActiveTarget();
      const rememberedCharacterId = kvGet(STORY_ACTIVE_CHARACTER_KEY) || "";
      const recentCharacterId = loadStorySessions()[0]?.characterId || "";
      const initialChar = availableCharacters.some((item) => item.id === rememberedCharacterId)
        ? rememberedCharacterId
        : availableCharacters.some((item) => item.id === recentCharacterId)
          ? recentCharacterId
          : availableCharacters[0]?.id || "";
      const rememberedGroup = rememberedTarget?.ownerType === "group"
        ? groups.find((group) => group.id === rememberedTarget.ownerId)
        : null;
      const groupPrimary = rememberedGroup?.characterIds.find((id) => availableCharacters.some((character) => character.id === id));
      if (rememberedGroup && groupPrimary) {
        setActiveGroupId(rememberedGroup.id);
        setActiveCharacterId(groupPrimary);
        activateStorySession(resolveOwnerSession("group", rememberedGroup.id, groupPrimary, rememberedGroup.characterIds));
      } else if (initialChar) {
        setActiveGroupId("");
        setActiveCharacterId(initialChar);
        activateStorySession(resolveOwnerSession("single", initialChar, initialChar, [initialChar]));
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    setAutoReading(false);
    setCurrentReadExpanded(false);
  }, [activeSessionId]);

  // Listen for live CSS updates from the assistant
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  // Listen for story tail scheme updates written by the mascot's own tools
  useEffect(() => {
    const onSettingsUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId && detail.sessionId === activeSessionIdRef.current) {
        setStorageVersion((value) => value + 1);
      }
    };
    window.addEventListener("story-session-settings-updated", onSettingsUpdate);
    return () => window.removeEventListener("story-session-settings-updated", onSettingsUpdate);
  }, []);

  // Refresh scheme-dependent UI when the shared repository changes (saved from the settings
  // page, written by the mascot's own tools, or migrated).
  useEffect(() => {
    const onRepoUpdate = () => {
      setSchemeRepoVersion((value) => value + 1);
      setStorageVersion((value) => value + 1);
    };
    window.addEventListener(STORY_SCHEME_REPO_EVENT, onRepoUpdate);
    return () => window.removeEventListener(STORY_SCHEME_REPO_EVENT, onRepoUpdate);
  }, []);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // During paragraph editing: the bottom-lock must be turned off, otherwise the auto-resizing edit box would get
  // dragged to the bottom by the ResizeObserver on every height change (this shows up as "scrolls to bottom on every keystroke")
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // Edit draft is kept in a ref, textarea is uncontrolled: setState on every keystroke would make React write back
  // value, causing cursor misplacement with Chinese IME on iOS; changing style.height on every keystroke also
  // triggers iOS auto-scroll. Height auto-sizing is instead handled by a pure CSS mirror (.story-grow-wrap::after),
  // with zero JS intervention while typing.
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // No path may auto-stick to bottom during paragraph editing
    const node = scrollRef.current;
    if (!node) return;
    // Already at the bottom (or iOS rubber-band bounced past it): don't force-write scrollTop --
    // otherwise ResizeObserver -> stick-to-bottom -> scroll event -> stick-to-bottom again forms
    // a per-frame loop that fights iOS's own bounce animation.
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // Don't auto-stick to bottom while editing
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom, settingsOpen]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId, settingsOpen]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const startAutoReading = useCallback((from: "latest" | "current") => {
    const node = scrollRef.current;
    if (!node || messages.length === 0) return;
    autoBottomLockRef.current = false;

    if (from === "latest" && latestAssistantMessageId) {
      const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(latestAssistantMessageId)
        : latestAssistantMessageId.replace(/["\\]/g, "\\$&");
      const latest = node.querySelector<HTMLElement>(`[data-story-message-id="${escapedId}"]`);
      if (latest) {
        const nodeRect = node.getBoundingClientRect();
        const latestRect = latest.getBoundingClientRect();
        const target = node.scrollTop + latestRect.top - nodeRect.top - node.clientHeight / 2;
        node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, Math.round(target)));
      }
    }

    setCurrentReadExpanded(false);
    requestAnimationFrame(() => setAutoReading(true));
  }, [latestAssistantMessageId, messages.length]);

  useEffect(() => {
    if (!autoReading) return;
    const node = scrollRef.current;
    if (!node) {
      setAutoReading(false);
      return;
    }

    const speed = Math.max(12, Math.min(120, uiPrefs.autoReadingSpeed ?? DEFAULT_AUTO_READING_SPEED));
    const previousScrollBehavior = node.style.getPropertyValue("scroll-behavior");
    const previousScrollBehaviorPriority = node.style.getPropertyPriority("scroll-behavior");
    // On iOS PWA, CSS smooth scrolling and per-frame scrollTop writes fight over control.
    node.style.setProperty("scroll-behavior", "auto", "important");
    let frame = 0;
    let previousTime = performance.now();
    // Safari rounds any scrollTop write under 1px, so sub-pixel speeds (about 0.6px/frame by
    // default) would never move -- accumulating the target position separately and writing an
    // integer keeps slow speeds advancing steadily.
    let desiredScrollTop = node.scrollTop;
    const tick = (time: number) => {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      if (desiredScrollTop >= maxScrollTop - 1) {
        node.scrollTop = maxScrollTop;
        setAutoReading(false);
        return;
      }
      const elapsed = Math.min(64, time - previousTime);
      previousTime = time;
      desiredScrollTop = Math.min(maxScrollTop, desiredScrollTop + (speed * elapsed) / 1000);
      node.scrollTop = Math.floor(desiredScrollTop);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (previousScrollBehavior) {
        node.style.setProperty("scroll-behavior", previousScrollBehavior, previousScrollBehaviorPriority);
      } else {
        node.style.removeProperty("scroll-behavior");
      }
    };
  }, [autoReading, uiPrefs.autoReadingSpeed]);

  useEffect(() => {
    if (!uiPrefs.autoReadingEnabled && autoReading) setAutoReading(false);
  }, [autoReading, uiPrefs.autoReadingEnabled]);

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  useEffect(() => {
    messagesLengthRef.current = messages.length;
  }, [messages.length]);

  // Returning from the story settings page: restore the scroll position to wherever it was
  // before settings was opened.
  useLayoutEffect(() => {
    if (settingsOpen) {
      settingsOpenSnapshotRef.current = {
        sessionId: activeSessionIdRef.current,
        messageCount: messagesLengthRef.current,
      };
      return;
    }
    const snapshot = settingsOpenSnapshotRef.current;
    settingsOpenSnapshotRef.current = null;
    const node = scrollRef.current;
    if (!node || !snapshot) return;
    const contentChanged = snapshot.sessionId !== activeSessionIdRef.current
      || snapshot.messageCount !== messagesLengthRef.current;
    if (contentChanged) {
      // The character was switched, or new messages arrived, while settings was open: stick to
      // the bottom to show the latest content (the stick-to-bottom effect ran idle on its old
      // dependencies the whole time settings was open, and won't re-fire on return, so it needs
      // a manual nudge here).
      autoBottomLockRef.current = true;
      scrollStoryToBottom();
      const stickTimers = [80, 300, 800].map((delay) => window.setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay));
      return () => stickTimers.forEach((id) => window.clearTimeout(id));
    }
    const target = stageScrollMemoRef.current;
    if (target <= 0) return;
    autoBottomLockRef.current = false; // Don't let the stick-to-bottom logic fight the restore
    // .story-stage's CSS scroll-behavior:smooth would turn a scrollTop assignment into a smooth
    // scroll animation (showing up as "the page visibly slides down from the top on return",
    // which is disorienting). Force instant positioning with an inline style during the restore,
    // and hand control back to the CSS once every correction pass is done.
    node.style.scrollBehavior = "auto";
    let done = false;
    let cancelled = false;
    const timers: number[] = [];
    const restoreBehavior = () => {
      if (done) return;
      done = true;
      if (node.style.scrollBehavior === "auto") node.style.scrollBehavior = "";
    };
    const apply = () => {
      if (cancelled) return;
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(target, max);
    };
    apply();
    // On iOS, a same-frame scrollTop write right after mount occasionally doesn't take; the rAF
    // callback still runs before the first paint, so writing it again there guarantees the very
    // first frame the user sees is the target position.
    requestAnimationFrame(apply);
    // The status-bar/mini-theater iframe's height resolves asynchronously, so content height
    // shifts shortly after -- a few more correction passes cover that; positioning stays instant
    // throughout, and smooth scrolling is only restored after the final pass.
    [80, 300, 800].forEach((delay, index) => timers.push(window.setTimeout(() => {
      if (cancelled) return;
      apply();
      if (index === 2) restoreBehavior();
    }, delay)));
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      restoreBehavior();
    };
    // Stop correcting the moment the user touches the page (touch/wheel), so it doesn't fight a
    // manual scroll.
    node.addEventListener("pointerdown", cancel, { capture: true, once: true });
    node.addEventListener("wheel", cancel, { capture: true, once: true, passive: true });
    return () => {
      cancel();
      node.removeEventListener("pointerdown", cancel, { capture: true });
      node.removeEventListener("wheel", cancel, { capture: true });
    };
  }, [settingsOpen, scrollStoryToBottom]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    // Config resolution can throw (e.g. the bound API config was deleted); this runs inside a
    // render effect, so letting it throw would white-screen the whole story page -- skip the
    // cache refresh on failure instead and leave the error to surface when the user sends.
    let signature: { regexSignature: string; parserVersion: number };
    try {
      signature = getStoryRenderSignature(activeCharacterId);
    } catch {
      return;
    }
    const { regexSignature, parserVersion } = signature;
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      let rebuilt: StoryMessage[];
      try {
        rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
      } catch {
        if (cacheRefreshKeyRef.current === refreshKey) cacheRefreshKeyRef.current = null;
        return;
      }
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
    // Depends on the raw id/foldTags values rather than the session object: cache normalization
    // swaps out object references, and depending on the object would re-run this effect on
    // unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeCharacterId, currentSession?.id, currentSession?.foldTags, messages, isGenerating]);

  function applySessionUpdates(updates: Partial<StorySession>) {
    if (!currentSession) return;
    const next = updateStorySession(currentSession.id, updates);
    if (!next) return;
    setCustomCssDraft(next.customCSS || "");
    setFoldTagsDraft(next.foldTags ?? "think,thinking,story_status,story_theater");
    setContextExcludedTagsDraft(next.contextExcludedTags ?? "think,thinking,story_theater");
    setStorageVersion((value) => value + 1);
  }

  function handleStoryCharacterChange(characterId: string) {
    if (!characters.some((character) => character.id === characterId)) return;
    setActiveGroupId("");
    setActiveCharacterId(characterId);
    activateStorySession(resolveOwnerSession("single", characterId, characterId, [characterId]));
  }

  function handleStoryGroupSelect(groupId: string) {
    const group = loadStoryGroups().find((item) => item.id === groupId);
    if (!group) return;
    const primaryId = group.characterIds.find((id) => characters.some((character) => character.id === id));
    if (!primaryId) return;
    setActiveGroupId(group.id);
    setActiveCharacterId(primaryId);
    activateStorySession(resolveOwnerSession("group", group.id, primaryId, group.characterIds));
  }

  function handleStoryGroupCreate(characterIds: string[], name: string) {
    const validIds = Array.from(new Set(characterIds.filter((id) => characters.some((character) => character.id === id))));
    if (validIds.length < 2) return;
    const group = createStoryGroup(validIds, name);
    const primaryId = validIds[0];
    const baseSession = loadStorySessionsForOwner("single", primaryId).find((session) => (session.branchId || "main") === "main");
    const session = createOrGetStorySession(primaryId, {
      ownerType: "group",
      ownerId: group.id,
      participantIds: validIds,
      branchId: "main",
      baseSession,
    });
    setActiveGroupId(group.id);
    setActiveCharacterId(primaryId);
    activateStorySession(session);
  }

  function handleStoryGroupDelete(groupId: string) {
    const deletingActive = activeGroupId === groupId;
    deleteStoryGroup(groupId);
    if (deletingActive && activeCharacterId) {
      setActiveGroupId("");
      activateStorySession(resolveOwnerSession("single", activeCharacterId, activeCharacterId, [activeCharacterId]));
    } else {
      setStorageVersion((value) => value + 1);
    }
  }

  function handleStorySessionSelect(sessionId: string) {
    const session = loadStorySessions().find((item) => item.id === sessionId);
    if (!session) return;
    activateStorySession(session);
  }

  function handleStoryBranchCreate(input: { name: string; inheritRecentMemory: boolean; independentStory: boolean }) {
    if (!activeOwnerId || !activeCharacterId) return;
    const mainSession = loadStorySessionsForOwner(activeOwnerType, activeOwnerId).find((session) => (session.branchId || "main") === "main") || currentSession || undefined;
    const session = createOrGetStorySession(activeCharacterId, {
      ownerType: activeOwnerType,
      ownerId: activeOwnerId,
      participantIds: activeGroup?.characterIds || [activeCharacterId],
      branchId: `branch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      branchName: input.name,
      inheritRecentMemory: input.inheritRecentMemory,
      independentStory: input.independentStory,
      baseSession: mainSession,
    });
    activateStorySession(session);
  }

  function handleStoryBranchDelete(sessionIds: string[]) {
    const deletingActive = sessionIds.includes(activeSessionId);
    deleteStorySessions(sessionIds);
    if (deletingActive) {
      const main = loadStorySessionsForOwner(activeOwnerType, activeOwnerId).find((session) => (session.branchId || "main") === "main");
      if (main) activateStorySession(main);
    } else {
      setStorageVersion((value) => value + 1);
    }
  }

  function handleStorySessionUpdate(sessionId: string, updates: Partial<StorySession>) {
    const next = updateStorySession(sessionId, updates);
    if (!next) return;
    if (next.id === activeSessionId) {
      setCustomCssDraft(next.customCSS || "");
      setFoldTagsDraft(next.foldTags ?? "think,thinking,story_status,story_theater");
      setContextExcludedTagsDraft(next.contextExcludedTags ?? "think,thinking,story_theater");
    }
    setStorageVersion((value) => value + 1);
  }

  function cleanStoryTextForExport(text: string): string {
    return text
      .replace(/<(?:think|thinking|story_status|story_theater|summary)[^>]*>[\s\S]*?<\/(?:think|thinking|story_status|story_theater|summary)>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function storyChapterTitle(session: StorySession, branchIndex: number): string {
    if ((session.branchId || "main") === "main") return "Main Story";
    return `Branch ${branchIndex} "${session.branchName || `Story Branch ${branchIndex}`}"`;
  }

  function buildStoryTxt(session: StorySession, chapterTitle: string, includeBookTitle = true): string {
    const rows = loadStoryMessages(session.id)
      .map((message) => {
        const content = cleanStoryTextForExport(message.renderedContent || message.rawContent);
        if (!content) return "";
        const speaker = message.role === "assistant" ? storyDisplayName : message.role === "user" ? (userIdentity?.name || "Me") : "Narrator";
        return `${speaker}\n${content}`;
      })
      .filter(Boolean);
    return [includeBookTitle ? `\u300a${storyDisplayName}\u300b` : "", chapterTitle, "", ...rows].filter((item, index) => index !== 0 || Boolean(item)).join("\n\n");
  }

  function safeStoryFilename(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60) || "Story";
  }

  function handleExportStorySession(sessionId: string) {
    const session = loadStorySessions().find((item) => item.id === sessionId);
    if (!session) return;
    const ownerSessions = loadStorySessionsForOwner(session.ownerType || "single", session.ownerId || session.characterId);
    const branchIndex = Math.max(1, ownerSessions.filter((item) => (item.branchId || "main") !== "main").findIndex((item) => item.id === session.id) + 1);
    const chapterTitle = storyChapterTitle(session, branchIndex);
    const blob = new Blob([buildStoryTxt(session, chapterTitle)], { type: "text/plain;charset=utf-8" });
    void downloadFile(blob, `${safeStoryFilename(storyDisplayName)}-${safeStoryFilename(chapterTitle)}.txt`)
      .catch((error) => alert(error instanceof Error ? error.message : "Export failed"));
  }

  function handleExportAllStories() {
    const sessions = loadStorySessionsForOwner(activeOwnerType, activeOwnerId);
    let branchIndex = 0;
    const chapters = sessions.map((session) => {
      if ((session.branchId || "main") !== "main") branchIndex += 1;
      return { session, title: storyChapterTitle(session, Math.max(1, branchIndex)) };
    });
    const directory = ["Table of Contents", ...chapters.map((chapter) => chapter.title)].join("\n");
    const sections = chapters.map((chapter) => buildStoryTxt(chapter.session, chapter.title, false));
    const text = [`\u300a${storyDisplayName}\u300b`, directory, ...sections].join("\n\n\n====================\n\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    void downloadFile(blob, `${safeStoryFilename(storyDisplayName)}-All Stories.txt`)
      .catch((error) => alert(error instanceof Error ? error.message : "Export failed"));
  }

  function handleQuickStoryCreate() {
    if (!activeOwnerId || !activeCharacterId) return;
    const now = new Date();
    const branchName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const baseSession = ownerMainSession || currentSession || undefined;
    if (currentSession) updateStorySession(currentSession.id, { endedAt: now.toISOString() });
    const session = createOrGetStorySession(activeCharacterId, {
      ownerType: activeOwnerType,
      ownerId: activeOwnerId,
      participantIds: activeGroup?.characterIds || [activeCharacterId],
      branchId: `quick_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      branchName,
      inheritRecentMemory: !quickStoryIndependent,
      independentStory: quickStoryIndependent,
      baseSession,
    });
    const prompt = quickStoryIndependent
      ? `This is a new, independent story that does not inherit the main storyline's context. Let ${storyDisplayName} naturally open a brand-new meeting scene.`
      : `The current story has ended. Drawing on recent context, let ${storyDisplayName} naturally open a new meeting scene.`;
    const next = updateStorySession(session.id, { autoStartPrompt: prompt, autoStartRequestedAt: now.toISOString() }) || session;
    setQuickStoryOpen(false);
    setQuickStoryIndependent(false);
    activateStorySession(next);
  }

  const showVoiceNotice = useCallback((message: string) => {
    setVoiceNotice(message);
    if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
    voiceNoticeTimerRef.current = setTimeout(() => setVoiceNotice(null), 2600);
  }, []);

  const playStoryVoice = useCallback(async (segment: StoryVoiceSegment): Promise<boolean> => {
    if (!activeCharacterId || !segment.text.trim()) return false;

    if (!uiPrefs.voiceEnabled) {
      showVoiceNotice("Please turn on voice under Voice & Playback settings first");
      return false;
    }

    if (playingVoiceSegmentId === segment.id) {
      voiceRequestIdRef.current += 1;
      voicePlaybackRef.current?.abort();
      voicePlaybackRef.current = null;
      setPlayingVoiceSegmentId(null);
      return false;
    }

    const voiceConfig = resolveVoiceConfig(activeCharacterId, "story");
    if (!voiceConfig || !voiceConfig.enableTTS) {
      showVoiceNotice("Please bind a usable voice scheme for Story under Binding Manager first");
      return false;
    }

    unlockAudioPlayback();
    voiceRequestIdRef.current += 1;
    const requestId = voiceRequestIdRef.current;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setPlayingVoiceSegmentId(segment.id);

    try {
      const cacheKey = `${voiceConfig.id}:${voiceConfig.speechSpeed ?? 1}:${segment.text}`;
      let blob = storyVoiceCache.get(cacheKey) || null;
      if (!blob) {
        blob = await synthesizeSpeech(segment.text, voiceConfig);
        if (blob) cacheStoryVoice(cacheKey, blob);
      }
      if (requestId !== voiceRequestIdRef.current) return false;
      if (!blob) throw new Error("The voice service returned no audio");

      const playback = playAudioBlobViaMediaElement(blob);
      voicePlaybackRef.current = playback;
      await playback.promise;
      return requestId === voiceRequestIdRef.current;
    } catch (error) {
      if (requestId === voiceRequestIdRef.current) {
        showVoiceNotice(error instanceof Error ? error.message : "Voice playback failed, please check your voice configuration");
      }
      return false;
    } finally {
      if (requestId === voiceRequestIdRef.current) {
        voicePlaybackRef.current = null;
        setPlayingVoiceSegmentId(null);
      }
    }
  }, [activeCharacterId, playingVoiceSegmentId, showVoiceNotice, uiPrefs.voiceEnabled]);

  const handleStoryVoicePlay = useCallback((segment: StoryVoiceSegment) => {
    void playStoryVoice(segment);
  }, [playStoryVoice]);

  const collectStoryVoiceSegments = useCallback((): StoryVoiceSegment[] => {
    const stage = scrollRef.current;
    if (!stage) return [];
    const assistantRows = Array.from(stage.querySelectorAll<HTMLElement>('.story-row[data-role="assistant"]'));
    const latestRowWithDialogue = assistantRows.reverse().find((row) => row.querySelector("[data-story-voice-segment]"));
    if (!latestRowWithDialogue) return [];
    return Array.from(latestRowWithDialogue.querySelectorAll<HTMLElement>("[data-story-voice-segment]")).flatMap((element) => {
      const id = element.dataset.storyVoiceSegment;
      const encodedText = element.dataset.storyVoiceText;
      if (!id || !encodedText) return [];
      return [{
        id,
        text: decodeURIComponent(encodedText),
        speaker: element.dataset.storyVoiceSpeaker
          ? decodeURIComponent(element.dataset.storyVoiceSpeaker)
          : undefined,
      }];
    });
  }, []);

  const handlePlayNextStoryVoice = useCallback(async () => {
    if (!uiPrefs.voiceEnabled) {
      showVoiceNotice("Please turn on voice under Voice & Playback settings first");
      return;
    }
    if (playingVoiceSegmentId) return;
    const segments = collectStoryVoiceSegments();
    if (segments.length === 0) {
      showVoiceNotice("There's no character dialogue to play on this page yet");
      return;
    }

    let index = voiceSequenceIndexRef.current;
    if (index >= segments.length) {
      const restart = window.confirm("Playback finished -- start over from the beginning?");
      if (!restart) return;
      index = 0;
      voiceSequenceIndexRef.current = 0;
    }
    setVoiceSequenceProgress({ current: index + 1, total: segments.length });
    const completed = await playStoryVoice(segments[index]);
    if (!completed) return;

    const nextIndex = index + 1;
    if (nextIndex < segments.length) {
      voiceSequenceIndexRef.current = nextIndex;
      return;
    }

    voiceSequenceIndexRef.current = segments.length;
  }, [collectStoryVoiceSegments, playStoryVoice, playingVoiceSegmentId, showVoiceNotice, uiPrefs.voiceEnabled]);

  async function handleSend(userTextInput: string) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        settings: currentSession?.settings,
        floatingChatContext,
        participantIds: currentSession?.participantIds || [characterId],
        storyMemory: {
          independent: currentSession?.independentStory,
          inheritRecentMemory: currentSession?.inheritRecentMemory ?? true,
          startedAt: currentSession?.createdAt,
        },
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
        appId: result.appId,
        appName: result.appName,
        appCardLayout: result.appCardLayout,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId)); // Re-read from storage by session, so messages can't bleed across sessions
      }
      setStorageVersion((value) => value + 1);

      const memoryCharacterIds = currentSession?.participantIds?.length ? currentSession.participantIds : [characterId];
      const storyCharacters = memoryCharacterIds
        .map((id) => characters.find((character) => character.id === id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (storyCharacters.length && !currentSession?.independentStory) {
        void (async () => {
          try {
            for (const storyCharacter of storyCharacters) {
              incrementEventCounter(storyCharacter.id);
              incrementEventCounter(storyCharacter.id);
              await maybeRunSummarization(storyCharacter.id, storyCharacter.name);
            }
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "Story generation failed, please try again later.";
      pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId));
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  // Entering via a direct-chat invite/quick-new-branch: let the character open the scene
  // directly. The prompt only participates in this one generation, and never renders as a
  // user bubble.
  useEffect(() => {
    const session = currentSession;
    const prompt = session?.autoStartPrompt?.trim();
    if (!ready || !session || !prompt || !activeCharacterId || isGenerating) return;
    if (autoStartedSessionIdsRef.current.has(session.id)) return;
    autoStartedSessionIdsRef.current.add(session.id);
    updateStorySession(session.id, { autoStartPrompt: undefined, autoStartRequestedAt: undefined });

    const sessionId = session.id;
    const characterId = activeCharacterId;
    const virtualMessage: StoryMessage = {
      id: `story_auto_${Date.now()}`,
      sessionId,
      role: "user",
      rawContent: prompt,
      renderedContent: prompt,
      createdAt: session.autoStartRequestedAt || new Date().toISOString(),
    };
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    void generateStoryCompletion(characterId, [...loadStoryMessages(sessionId), virtualMessage], {
      sessionFoldTags: session.foldTags,
      sessionContextExcludedTags: session.contextExcludedTags,
      settings: session.settings,
      floatingChatContext,
      participantIds: session.participantIds || [characterId],
      storyMemory: {
        independent: session.independentStory,
        inheritRecentMemory: session.inheritRecentMemory ?? true,
        startedAt: session.createdAt,
      },
      signal: generationRun.controller.signal,
    }).then((result) => {
      if (!isCurrentGeneration()) return;
      pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
        appId: result.appId,
        appName: result.appName,
        appCardLayout: result.appCardLayout,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion((value) => value + 1);

      if (!session.independentStory) {
        for (const id of session.participantIds?.length ? session.participantIds : [characterId]) {
          const item = characters.find((candidate) => candidate.id === id);
          if (!item) continue;
          incrementEventCounter(item.id);
          void maybeRunSummarization(item.id, item.name).catch(() => undefined);
        }
      }
    }).catch((error) => {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const text = error instanceof Error ? error.message : "Story auto-start failed, tap Continue to retry.";
      pushStoryMessage({ sessionId, role: "system", rawContent: text, renderedContent: text });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion((value) => value + 1);
    }).finally(() => {
      if (finishStoryGenerationRun(sessionId, generationRunId)) markGenerating(sessionId, false);
    });
  }, [activeCharacterId, activeSessionId, currentSession?.autoStartPrompt, ready]);

  async function handleFloatingChatSend() {
    const text = floatingChatDraft.trim();
    if (!text || !activeCharacterId || floatingChatGenerating) return;
    const storySessionId = activeSessionId;
    const characterId = activeCharacterId;
    const characterName = currentCharacter?.name || "Character";
    const userName = userIdentity?.name || "User";
    setFloatingChatDraft("");
    setFloatingChatGenerating(true);
    try {
      await hydrateChatStorage();
      const chatSession = activeGroup ? floatingChatSession : createOrGetSession(characterId);
      if (!chatSession) throw new Error("If there's no group chat yet, create one first");
      pushChatMessage({ sessionId: chatSession.id, role: "user", content: text, origin: "story_floating_phone" });
      setFloatingChatVersion((value) => value + 1);

      const history = loadChatMessages(chatSession.id);
      const replyLines: string[] = [];
      if (activeGroup) {
        const results = await generateGroupChatCompletion(chatSession, history, undefined, { appTags: ["group_chat", "text"] });
        if (!results.length) throw new Error("The group chat returned no displayable content");
        results.forEach((result) => {
          const parsed = parseAIResponse(result.responseText, []);
          const parts = parsed.parts.length ? parsed.parts : [{ content: result.responseText }];
          parts.forEach((part, index) => {
            pushChatMessage({
              sessionId: chatSession.id, role: "assistant", content: part.content,
              mediaType: part.mediaType, mediaData: part.mediaData,
              senderCharacterId: result.characterId, senderName: result.characterName,
              origin: "story_floating_phone",
              statusPanel: index === 0 ? (parsed.statusPanel || undefined) : undefined,
              innerMonologue: index === 0 ? (parsed.innerMonologue || undefined) : undefined,
              stateValues: index === 0 && parsed.stateValues.length ? parsed.stateValues : undefined,
              freshStateValues: index === 0 && parsed.freshStateValues.length ? parsed.freshStateValues : undefined,
            });
            const visible = part.content.trim() || part.mediaData?.label || (part.mediaType ? `[${part.mediaType}]` : "");
            if (visible) replyLines.push(`${result.characterName}: ${visible}`);
          });
        });
      } else {
        const completion = await generateChatCompletion(chatSession, history, { appTags: ["chat", "text"], appId: "chat" });
        const rawReply = flattenCompletionResult(completion).trim();
        if (!rawReply) throw new Error("The character returned no displayable content");
        const previousState = [...history].reverse().find((item) => item.stateValues?.length)?.stateValues || [];
        const parsed = parseAIResponse(rawReply, previousState);
        const parts = parsed.parts.length ? parsed.parts : [{ content: rawReply }];
        parts.forEach((part, index) => {
          pushChatMessage({
            sessionId: chatSession.id, role: "assistant", content: part.content,
            mediaType: part.mediaType, mediaData: part.mediaData,
            senderCharacterId: characterId, senderName: characterName, origin: "story_floating_phone",
            statusPanel: index === 0 ? (parsed.statusPanel || undefined) : undefined,
            innerMonologue: index === 0 ? (parsed.innerMonologue || undefined) : undefined,
            stateValues: index === 0 && parsed.stateValues.length ? parsed.stateValues : undefined,
            freshStateValues: index === 0 && parsed.freshStateValues.length ? parsed.freshStateValues : undefined,
          });
          const visible = part.content.trim() || part.mediaData?.label || (part.mediaType ? `[${part.mediaType}]` : "");
          if (visible) replyLines.push(`${characterName}: ${visible}`);
        });
      }

      const stamp = new Date().toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const transcript = [
        `[Live chat \u00b7 ${stamp}]`,
        `${userName}: ${text}`,
        ...replyLines,
      ].join("\n");
      if (storySessionId) {
        pushStoryMessage({ sessionId: storySessionId, role: "system", rawContent: transcript, renderedContent: transcript });
        if (activeSessionIdRef.current === storySessionId) setMessages(loadStoryMessages(storySessionId));
      }
      // This round of chat happened right here in the floating phone, and the user already saw
      // it -- don't leave an unread badge outside the Story app for it.
      markChatSessionRead(chatSession.id);
      setFloatingChatVersion((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Floating chat send failed";
      const chatSession = floatingChatSession || loadChatSessions().find((item) => item.contactId === characterId && !item.isGroup);
      if (chatSession) pushChatMessage({ sessionId: chatSession.id, role: "system", content: `⚠️ ${message}` });
      setFloatingChatVersion((value) => value + 1);
      showVoiceNotice(message);
    } finally {
      setFloatingChatGenerating(false);
    }
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    markGenerating(activeSessionId, false);
  }

  function handleTouchStart(clientX: number) {
    dragStartXRef.current = clientX;
    dragDeltaXRef.current = 0;
  }

  function handleTouchMove(clientX: number) {
    if (dragStartXRef.current == null) return;
    dragDeltaXRef.current = clientX - dragStartXRef.current;
  }

  function handleTouchEnd() {
    const dragStartX = dragStartXRef.current;
    const dragDeltaX = dragDeltaXRef.current;
    if (dragStartX == null) return;
    // Swipe left from the right edge to enter the full story settings page
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (dragStartX > screenW - 32 && dragDeltaX < -54) {
      setSettingsOpen(true);
    }
    dragStartXRef.current = null;
    dragDeltaXRef.current = 0;
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button,a,input,textarea,select,summary,iframe,[data-action],[data-story-interactive]")) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // Only used as the initial value for the uncontrolled textarea
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "User");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    // A retry cuts off a long message, and when the content gets shorter the browser
    // clamps the scroll position to the new bottom — which reads as the page jumping
    // upwards. Stick to the bottom deliberately so the eye lands on the typing indicator.
    autoBottomLockRef.current = true;
    requestAnimationFrame(() => scrollStoryToBottom());
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        settings: currentSession?.settings,
        floatingChatContext,
        participantIds: currentSession?.participantIds || [characterId],
        storyMemory: {
          independent: currentSession?.independentStory,
          inheritRecentMemory: currentSession?.inheritRecentMemory ?? true,
          startedAt: currentSession?.createdAt,
        },
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
        appId: result.appId, appName: result.appName, appCardLayout: result.appCardLayout,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "Retry failed, please try again later.";
      pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  // Quick-input panel: options and cursor position come from the current character's chosen
  // scheme in the shared repository; when the options are all blank, fall back to the default symbols.
  const activeQuickInputScheme = resolveActiveQuickInputScheme(uiPrefs, schemeRepo);
  const quickInputOptionsRaw = activeQuickInputScheme.options.filter((item) => item.trim());
  const quickInputOptions = quickInputOptionsRaw.length > 0 ? quickInputOptionsRaw : STORY_DEFAULT_QUICK_INPUT_OPTIONS;
  const quickInputCursor = activeQuickInputScheme.cursor ?? "middle";

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="Close story mode">
                  <ArrowLeft size={16} />
                </button>
              </div>
              <div className="story-header-center" />
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <BookOpen size={30} opacity={0.45} />
                <div>
                  <div className="story-empty-title">No character cards yet</div>
                  <div className="story-empty-desc">Please create or import a character card first, then enter the Story app to begin.</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  Back
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  const sessionScope = `.story-session-${currentSession.id}`;

  if (settingsOpen) {
    return (
      <div className={`story-app-shell story-session-${currentSession.id}`} data-story-theme={uiPrefs.theme || "paper"} style={storyShellStyle}>
        {customFontFace ? <style>{customFontFace}</style> : null}
        <StorySettingsPage
          characters={characters}
          activeCharacterId={activeCharacterId}
          activeGroupId={activeGroupId}
          groups={storyGroups}
          ownerSessions={ownerSessions}
          activeSessionId={activeSessionId}
          userName={userIdentity?.name || "User"}
          uiPrefs={uiPrefs}
          settings={storySettings}
          schemeRepo={schemeRepo}
          boundPreset={boundPreset}
          foldTags={foldTagsDraft}
          contextExcludedTags={contextExcludedTagsDraft}
          onClose={() => setSettingsOpen(false)}
          onCharacterChange={handleStoryCharacterChange}
          onGroupSelect={handleStoryGroupSelect}
          onGroupCreate={handleStoryGroupCreate}
          onGroupRename={(groupId, name) => {
            updateStoryGroup(groupId, { name });
            setStorageVersion((value) => value + 1);
          }}
          onGroupDelete={handleStoryGroupDelete}
          onSessionSelect={handleStorySessionSelect}
          onBranchCreate={handleStoryBranchCreate}
          onBranchDelete={handleStoryBranchDelete}
          onSessionUpdate={handleStorySessionUpdate}
          onExportSession={handleExportStorySession}
          onExportAll={handleExportAllStories}
          onUiPrefsChange={(next) => applySessionUpdates({ uiPrefs: next })}
          onSettingsChange={(next) => applySessionUpdates({ settings: next })}
          onSchemeRepoChange={saveStorySchemeRepository}
          onTagsChange={(foldTags, contextExcludedTags) => {
            setFoldTagsDraft(foldTags);
            setContextExcludedTagsDraft(contextExcludedTags);
            applySessionUpdates({ foldTags: foldTags.trim() || undefined, contextExcludedTags: contextExcludedTags.trim() || undefined });
          }}
          onOpenCss={() => {
            setSettingsOpen(false);
            setCssModalOpen(true);
          }}
          onRebuildCache={() => {
            try {
              const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
              setMessages(rebuilt);
              setStorageVersion((value) => value + 1);
              alert(`Cache rebuild complete, ${rebuilt.length} messages updated`);
            } catch (error) {
              alert(error instanceof Error ? error.message : "Cache rebuild failed -- please check your API binding configuration");
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      style={storyShellStyle}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartXRef.current != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {customFontFace ? <style>{customFontFace}</style> : null}
      {uiPrefs.wallpaper ? <div className="story-wallpaper-layer" style={{ backgroundImage: `url(${uiPrefs.wallpaper})` }} /> : null}
      {currentSession.customCSS ? (
        <SessionCustomCSS css={currentSession.customCSS} scope={sessionScope} />
      ) : null}

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== Fixed top header bar ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="Close story mode">
                <ArrowLeft size={16} />
              </button>
              <div className="story-header-person">
                <Avatar src={storyAvatar || undefined} name={storyDisplayName} size="sm" />
                <span>{storyDisplayName}</span>
              </div>
            </div>
            <div className="story-header-center" />
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setQuickStoryOpen(true)} aria-label="Quick new story">
                <Plus size={16} />
              </button>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="Page style">
                <Paintbrush size={16} />
              </button>
              <button className="story-top-btn" onClick={() => setSettingsOpen(true)} aria-label="Open story settings">
                <Menu size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            stageScrollMemoRef.current = node.scrollTop; // Kept up to date continuously, for restore on return from settings
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">

            {/* ====== Top reading info card ====== */}
            <div className="story-meta">
              <div className="story-meta-layout">
                <div className="story-meta-cover">
                  {storyAvatar ? (
                    <img src={storyAvatar} alt="cover" />
                  ) : (
                    <div className="story-meta-cover-fallback" aria-hidden="true">
                      <span className="story-meta-cover-char">{storyDisplayName.trim().charAt(0) || "\u{1F4D6}"}</span>
                      <span className="story-meta-cover-line" />
                      <span className="story-meta-cover-sub">STORY</span>
                    </div>
                  )}
                </div>
                <div className="story-meta-body">
                  <div className="story-meta-title">Reading now: 《 {storyDisplayName} 》</div>
                  <div className="story-meta-tags">
                    {userIdentity?.name || "Me"} x {storyDisplayName}
                  </div>
                  <div className="story-meta-desc">
                    {/* Character type might not have description, so we use a stylized default text */}
                    "Some stories already have their ending written before they even begin."
                  </div>
                </div>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="story-empty">
                <BookOpen size={28} opacity={0.45} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">The story starts here</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">Enter a prompt at the bottom to continue the story.</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>View more messages</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "Me")
                    : message.role === "assistant"
                      ? storyDisplayName
                      : "System";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  const hasAppCard = message.role === "assistant" && Boolean(message.appCardLayout);
                  const appCardBeforeText = hasAppCard && appCardRendersBeforeText();
                  const appCardNode = hasAppCard ? (
                    <AppCardView
                      appCardLayout={message.appCardLayout}
                      appName={message.appName || "APP"}
                      appId={message.appId}
                      onOpen={() => {
                        if (!message.appId || typeof window === "undefined") return;
                        window.dispatchEvent(new CustomEvent("open-app", {
                          detail: {
                            appId: toCustomAppIconId(message.appId),
                            launchContext: {
                              source: "story_directive",
                              messageId: message.id,
                              sessionId: message.sessionId,
                              characterId: currentCharacter.id,
                              characterName: currentCharacter.name,
                              appId: message.appId,
                              appName: message.appName,
                              summary: message.storySummary || message.renderedContent || message.rawContent,
                            },
                          },
                        }));
                      }}
                      pinContext={{
                        sourceMode: "story",
                        characterId: currentCharacter.id,
                        characterName: currentCharacter.name,
                        summary: message.storySummary || message.renderedContent || message.rawContent,
                        cardAppId: message.appId,
                        cardAppName: message.appName,
                        messageId: message.id,
                        sessionId: message.sessionId,
                      }}
                    />
                  ) : null;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      data-story-message-id={message.id}
                      data-hide-bubble={uiPrefs.hideBubble ? "true" : undefined}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {message.role !== "system" && (!uiPrefs.hideAvatar || !uiPrefs.hideTimestamp) ? (
                        <div className="story-msg-head">
                          {!uiPrefs.hideAvatar ? (
                            <div className="story-avatar-wrap">
                              <Avatar src={avatarUrl} name={speakerName} size="md" />
                            </div>
                          ) : null}
                          <div className="story-msg-meta">
                            {!uiPrefs.hideAvatar ? <span className="story-msg-name">{speakerName}</span> : null}
                            {!uiPrefs.hideTimestamp ? <span className="story-msg-time">{formatStoryTime(message.createdAt)}</span> : null}
                          </div>
                        </div>
                      ) : null}
                      {appCardBeforeText ? appCardNode : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">Cancel</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">Save</button>
                              </div>
                            </div>
                          ) : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                              onVoicePlay={message.role === "assistant" ? handleStoryVoicePlay : undefined}
                              playingVoiceSegmentId={playingVoiceSegmentId}
                              statusRenderHtml={activeStatusRenderHtml}
                              theaterRenderHtml={activeTheaterRenderHtml}
                              serifIframeFallback
                            />
                          )}
                        </div>
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">Copy</button>
                                <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">Edit</button>
                                {(message.role === "assistant" || message.role === "user") && (
                                  <button onClick={() => { void handleStoryRetry(message.id); }} className="story-ctx-btn story-ctx-btn-danger">Retry</button>
                                )}
                              </div>
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">Delete</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">Delete Below</button>
                              </div>
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                      {appCardBeforeText ? null : appCardNode}
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={storyDisplayName}
                avatar={currentCharacter.avatar || undefined}
                hideAvatar={Boolean(uiPrefs.hideAvatar)}
                hideTimestamp={Boolean(uiPrefs.hideTimestamp)}
                hideBubble={Boolean(uiPrefs.hideBubble)}
              />
            ) : null}
          </div>
        </div>
      </div>

      {voiceNotice ? (
        <div className="story-voice-notice" role="status">{voiceNotice}</div>
      ) : null}

      <StoryComposer
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        voiceEnabled={Boolean(uiPrefs.voiceEnabled)}
        voicePlaying={Boolean(playingVoiceSegmentId)}
        voiceProgress={voiceSequenceProgress}
        onSend={(text) => { void handleSend(text); }}
        onContinue={() => { void handleSend("Continue"); }}
        autoReadingEnabled={Boolean(uiPrefs.autoReadingEnabled)}
        autoReading={autoReading}
        currentReadExpanded={currentReadExpanded}
        canAutoRead={messages.length > 0}
        onToggleAutoReading={() => {
          if (autoReading) setAutoReading(false);
          else startAutoReading("latest");
        }}
        onCurrentReadControl={() => {
          if (!currentReadExpanded) setCurrentReadExpanded(true);
          else startAutoReading("current");
        }}
        onStop={handleStopGeneration}
        onPlayNext={() => { void handlePlayNextStoryVoice(); }}
        quickInputEnabled={Boolean(uiPrefs.quickInputEnabled)}
        quickInputOptions={quickInputOptions}
        quickInputCursor={quickInputCursor}
      />

      {storySettings.floatingPhoneEnabled ? (
        <button className="story-floating-phone-ball" type="button" onClick={() => { setFloatingChatVersion((value) => value + 1); setFloatingPhoneOpen(true); }} aria-label="Open the floating phone"><Smartphone size={18} /></button>
      ) : null}
      {floatingPhoneOpen ? (
        <div className="story-mini-phone-overlay" onClick={() => setFloatingPhoneOpen(false)}>
          <section className="story-mini-phone" onClick={(event) => event.stopPropagation()}>
            <header><button type="button" onClick={() => setFloatingPhoneOpen(false)}><X width={15} /></button><div><Avatar src={storyAvatar || undefined} name={storyDisplayName} size="sm" /><strong>{activeGroup ? (floatingChatSession?.groupName || "Choose a group chat") : currentCharacter.name}</strong></div><span /></header>
            {activeGroup ? (
              floatingGroupChatCandidates.length ? (
                <label className="story-mini-phone-group-select"><span>Floating-phone group chat</span><select value={floatingChatSession?.id || ""} onChange={(event) => setFloatingGroupSessionId(event.target.value)}>{floatingGroupChatCandidates.map((item) => <option key={item.id} value={item.id}>{item.groupName || "Unnamed group chat"}</option>)}</select></label>
              ) : <p className="story-mini-phone-group-empty">If there's no group chat yet, create one first</p>
            ) : null}
            <div className="story-mini-phone-messages" ref={miniPhoneScrollRef}>
              {floatingChatMessages.length ? floatingChatMessages.map((message) => (
                <div key={message.id} data-role={message.role}>
                  <small>{message.role === "user" ? (userIdentity?.name || "Me") : (message.senderName || currentCharacter.name)} · {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                  <p>{message.content || message.mediaData?.label || (message.mediaType ? `[${message.mediaType}]` : "")}</p>
                </div>
              )) : <p className="story-mini-phone-empty">{activeGroup && !floatingChatSession ? "If there's no group chat yet, create one first" : "No live chat history yet"}</p>}
              {floatingChatGenerating ? <div className="story-mini-phone-typing"><i /><i /><i /></div> : null}
            </div>
            <div className="story-mini-phone-composer">
              <textarea
                rows={1}
                value={floatingChatDraft}
                onChange={(event) => setFloatingChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleFloatingChatSend();
                  }
                }}
                placeholder={activeGroup && !floatingChatSession ? "If there's no group chat yet, create one first" : "Send a message…"}
                disabled={floatingChatGenerating || Boolean(activeGroup && !floatingChatSession)}
              />
              <button type="button" onClick={() => { void handleFloatingChatSend(); }} disabled={!floatingChatDraft.trim() || floatingChatGenerating || Boolean(activeGroup && !floatingChatSession)} aria-label="Send message">
                {floatingChatGenerating ? <span>···</span> : <Send width={14} />}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {quickStoryOpen ? (
        <div className="story-dialog-backdrop story-quick-story-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setQuickStoryOpen(false);
        }}>
          <section className="story-dialog story-quick-story-dialog" role="dialog" aria-modal="true" aria-label="Quick new story">
            <header><strong>Quick new story</strong><button type="button" onClick={() => setQuickStoryOpen(false)}><X width={16} /></button></header>
            <p className="story-quick-story-question">End the current story and quick-start a new one?</p>
            <p className="story-settings-note">The new branch is named automatically by the current time; you can rename it later in the story catalog.</p>
            <label className="story-settings-toggle-row">
              <span><strong>Independent story branch</strong></span>
              <input type="checkbox" checked={quickStoryIndependent} onChange={(event) => setQuickStoryIndependent(event.target.checked)} />
            </label>
            <footer><button type="button" onClick={() => setQuickStoryOpen(false)}>Cancel</button><button type="button" className="story-settings-primary" onClick={handleQuickStoryCreate}>End &amp; start new</button></footer>
          </section>
        </div>
      ) : null}

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              Page Style
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`Switch to ${t.name} theme`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 12,
                        border: active ? "1px solid var(--c-story-text, #3a3b3c)" : "1px solid var(--c-story-panel-border, rgba(139, 120, 94, 0.14))",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: active ? "2px solid var(--c-story-bg-top, #fdfdfd)" : "2px solid transparent",
                        boxShadow: active ? "0 0 0 2px var(--c-story-text, #3a3b3c)" : "0 2px 8px rgba(0,0,0,0.1)",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* Write session CSS for story mode here */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "1px solid var(--c-story-btn-border, rgba(0,0,0,0.08))",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 12,
                  border: "1px solid var(--c-story-btn-border, rgba(0,0,0,0.08))",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                Load Example
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 12,
                  border: "1px solid var(--c-story-btn-border, rgba(0,0,0,0.08))",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                Clear
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 12, border: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
