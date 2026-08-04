"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Eye,
  FilePlus,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import {
  createCoCreateMessage,
  createDefaultCoCreateSettings,
  createCoCreateSession,
  createDefaultCoCreateSession,
  createNextCoCreateChapter,
  reindexCoCreateChapters,
  deleteCoCreateSession,
  ensureActiveCoCreateChapter,
  getActiveCoCreateChapter,
  loadCoCreateLibrary,
  saveCoCreateLibrary,
  saveCoCreateSession,
  setActiveCoCreateSession,
} from "@/lib/cocreate-storage";
import { generateCoCreateChapterAutoArchive, generateCoCreateReply, generateCoCreateSessionMemory } from "@/lib/cocreate-engine";
import {
  deleteCoCreateLongTermMemoriesBySession,
  deleteCoCreateProjectionEntriesBySession,
  recordCoCreateProjectionEvent,
} from "@/lib/cocreate-memory";
import {
  COCREATE_APP_ID,
  type CoCreateBackendLog,
  type CoCreateChapter,
  type CoCreateCastMember,
  type CoCreateLibrary,
  type CoCreateMessage,
  type CoCreateMode,
  type CoCreatePendingMutation,
  type CoCreateSession,
  type CoCreateSettings,
} from "@/lib/cocreate-types";
import {
  COCREATE_TOOL_DEFINITIONS,
  applyCoCreatePendingMutation,
  discardCoCreatePendingMutation,
  rollbackCoCreateRevision,
} from "@/lib/cocreate-tools";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { incrementEventCounter } from "@/lib/memory-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";

type CoCreateAppProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

type ViewMode = "library" | "write" | "characters" | "chapters" | "chapterReader";
type ChapterReaderEditTarget = "title" | "titleEn" | "content" | "summary";
type ChapterReaderExitTarget = "chapters" | "library";

type CastFormState = {
  name: string;
  role: string;
  color: string;
  major: string;
  label: string;
  desc: string;
  secret: string;
  secretHidden: boolean;
};

const CAST_COLOR_SWATCHES = ["#d4c5a0", "#94b89d", "#c87a7a", "#8fa6c9", "#b69ac7", "#888888"];
const WORK_DECORATIVE_SUBTITLE = "A COLLABORATIVE NOVEL DOSSIER";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Co-creation generation failed.";
}

function modeLabel(mode: CoCreateMode): string {
  return mode === "write" ? "WRITE" : "TALK";
}

function countTextWords(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function normalizeEditableText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function setEditableText(element: HTMLElement | null, text: string): void {
  if (!element) return;
  element.innerText = text;
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusEditableAtPoint(element: HTMLElement, point?: { x: number; y: number }): void {
  element.focus({ preventScroll: true });
  if (!point) {
    placeCaretAtEnd(element);
    return;
  }

  const docWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = document.createRange();
  const position = docWithCaret.caretPositionFromPoint?.(point.x, point.y);
  if (position && element.contains(position.offsetNode)) {
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
  } else {
    const pointRange = docWithCaret.caretRangeFromPoint?.(point.x, point.y);
    if (pointRange && element.contains(pointRange.commonAncestorContainer)) {
      range.setStart(pointRange.startContainer, pointRange.startOffset);
      range.collapse(true);
    } else {
      placeCaretAtEnd(element);
      return;
    }
  }

  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

const COCREATE_MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }: any) => <a target="_blank" rel="noreferrer" {...props} />,
  table: ({ node, ...props }: any) => (
    <div className="cocreate-markdown-table">
      <table {...props} />
    </div>
  ),
} as any;

function CoCreateMarkdown({ content, className }: { content: string; className?: string }) {
  const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return null;
  return (
    <div className={`cocreate-markdown ${className ?? ""}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COCREATE_MARKDOWN_COMPONENTS}>
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "00:00";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function buildExportText(session: CoCreateSession): string {
  const manuscript = session.chapters
    .filter((chapter) => chapter.content?.trim())
    .map((chapter) => [`## ${chapter.num}. ${chapter.title}`, chapter.content].join("\n\n"))
    .join("\n\n");
  return [`# ${session.title}`, "", manuscript].join("\n");
}

function chapterStatusLabel(chapter: CoCreateChapter): string {
  if (chapter.archivedAt) return chapter.memoryEntries && chapter.memoryEntries.length > 1 ? `DONE×${chapter.memoryEntries.length}` : "DONE";
  return "LIVE";
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function hasExportableContent(session: CoCreateSession): boolean {
  return session.chapters.some((chapter) => chapter.content?.trim());
}

function safeExportFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return cleaned || "cocreate_story";
}

function formatBackendLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return [
    `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`,
  ].join(" ");
}

function appendBackendLog(session: CoCreateSession, log: Omit<CoCreateBackendLog, "id" | "createdAt">): CoCreateSession {
  const nextLog: CoCreateBackendLog = {
    ...log,
    id: createClientId("cocreate_backend"),
    createdAt: new Date().toISOString(),
  };
  return {
    ...session,
    backendLogs: [...(session.backendLogs || []), nextLog].slice(-60),
    updatedAt: new Date().toISOString(),
  };
}

type ClearCoCreateToolHistoryResult = {
  session: CoCreateSession;
  deletedMessages: number;
  cleanedMessages: number;
};

function isCoCreateToolHistoryMessage(message: CoCreateMessage): boolean {
  return message.role === "tool"
    || message.kind === "tool"
    || message.authorName === "TOOL"
    || !!message.nativeToolResult;
}

function hasCoCreateNativeToolReplayMetadata(message: CoCreateMessage): boolean {
  return message.nativeToolCalls !== undefined
    || message.nativeToolReasoning !== undefined
    || message.nativeToolOpenRouterReasoningDetails !== undefined;
}

function hasVisibleCoCreatePayload(message: CoCreateMessage): boolean {
  return !!message.content.trim();
}

function clearCoCreateToolHistory(session: CoCreateSession): ClearCoCreateToolHistoryResult {
  let deletedMessages = 0;
  let cleanedMessages = 0;
  const messages: CoCreateMessage[] = [];

  for (const message of session.messages) {
    if (isCoCreateToolHistoryMessage(message)) {
      deletedMessages += 1;
      continue;
    }

    if (!hasCoCreateNativeToolReplayMetadata(message)) {
      messages.push(message);
      continue;
    }

    const cleaned: CoCreateMessage = { ...message };
    delete cleaned.nativeToolCalls;
    delete cleaned.nativeToolReasoning;
    delete cleaned.nativeToolOpenRouterReasoningDetails;

    if (message.role === "assistant" && !hasVisibleCoCreatePayload(cleaned)) {
      deletedMessages += 1;
      continue;
    }

    cleanedMessages += 1;
    messages.push(cleaned);
  }

  return {
    session: {
      ...session,
      messages,
      updatedAt: deletedMessages || cleanedMessages ? new Date().toISOString() : session.updatedAt,
    },
    deletedMessages,
    cleanedMessages,
  };
}

function backendLogKindLabel(kind: CoCreateBackendLog["kind"]): string {
  return kind === "archive" ? "End Chapter" : "Generate Reply";
}

function copyTextToClipboard(text: string, onNotice?: (message: string) => void): void {
  if (!text) return;
  navigator.clipboard?.writeText(text)
    .then(() => onNotice?.("Copied."))
    .catch(() => onNotice?.("Copy failed. Please long-press the text to copy manually."));
}

function waitForLiveStep(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 80));
}

function waitForStreamPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function scrollPanelToBottom(panel: HTMLDivElement | null): void {
  if (!panel) return;
  window.requestAnimationFrame(() => {
    panel.scrollTop = panel.scrollHeight;
  });
}

function isCoCreateSystemStep(message: CoCreateSession["messages"][number]): boolean {
  return message.kind === "reasoning"
    || message.role === "system"
    || message.content.startsWith("动作结果返回：")
    || message.content.startsWith("正在执行：");
}

function fallbackInitial(name: string): string {
  return name.trim().slice(0, 1) || "C";
}

function pendingMutationTargetLabel(mutation: CoCreatePendingMutation): string {
  if (mutation.chapterNum || mutation.chapterTitle) {
    return `CHAPTER.${mutation.chapterNum || "--"} // ${mutation.chapterTitle || "Untitled Chapter"}`;
  }
  const op = mutation.operation;
  if (op.type === "create_cast") return `CAST FILE // ${op.member.name}`;
  if (op.type === "set_cast") return `CAST FILE // ${op.nextMember.name}`;
  if (op.type === "delete_cast") return "CAST FILE";
  if (op.type === "set_dossier") return "DOSSIER // Character Relationship Dossier";
  if (op.type === "set_notebook") return "NOTEBOOK // Work Notebook";
  if (op.type === "create_chapter") return `CHAPTER.${op.chapter.num} // ${op.chapter.title}`;
  return "";
}

function createClientId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultCastForm(): CastFormState {
  return {
    name: "",
    role: "",
    color: CAST_COLOR_SWATCHES[0],
    major: "",
    label: "",
    desc: "",
    secret: "",
    secretHidden: true,
  };
}

function castToForm(member: CoCreateCastMember): CastFormState {
  return {
    name: member.name,
    role: member.role,
    color: member.color,
    major: member.major,
    label: member.label,
    desc: member.desc,
    secret: member.secret || "",
    secretHidden: member.secretHidden ?? true,
  };
}

function createAutoCastCode(name: string, existing?: CoCreateCastMember): string {
  const trimmed = name.trim();
  if (existing?.name === trimmed && existing.nameEn.trim()) return existing.nameEn;
  const ascii = trimmed.match(/[A-Za-z0-9]+/g)?.join(" ").trim();
  if (ascii) return ascii.toUpperCase().slice(0, 32);
  let hash = 0;
  for (const char of trimmed || "CAST") {
    hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  }
  return `CAST-${hash.toString(36).toUpperCase().padStart(4, "0").slice(0, 4)}`;
}

function buildCastMember(form: CastFormState, existing?: CoCreateCastMember): CoCreateCastMember {
  const name = form.name.trim();
  return {
    id: existing?.id || createClientId("cocreate_cast"),
    name,
    nameEn: createAutoCastCode(name, existing),
    role: form.role.trim() || "Identity not set",
    color: form.color || CAST_COLOR_SWATCHES[0],
    major: form.major.trim() || "—",
    label: form.label.trim() || "Untitled Tag",
    desc: form.desc.trim() || "No public profile yet.",
    secret: form.secret.trim() || null,
    secretHidden: form.secret.trim() ? form.secretHidden : false,
    tags: [],
  };
}

export function CoCreateApp({ onClose, onNotice }: CoCreateAppProps) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [library, setLibrary] = useState<CoCreateLibrary>({ activeSessionId: "", sessions: [], settings: createDefaultCoCreateSettings() });
  const [session, setSession] = useState<CoCreateSession>(() => createDefaultCoCreateSession());
  const [view, setView] = useState<ViewMode>("library");
  const [mode, setMode] = useState<CoCreateMode>("write");
  const [input, setInput] = useState("");
  const [writerNotebookDraft, setWriterNotebookDraft] = useState("");
  const [writerNotebookDirty, setWriterNotebookDirty] = useState(false);
  const [editingUserMessageId, setEditingUserMessageId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeletingWork, setIsDeletingWork] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolHistoryClearConfirmOpen, setToolHistoryClearConfirmOpen] = useState(false);
  const [backendLogOpen, setBackendLogOpen] = useState(false);
  const [newWorkOpen, setNewWorkOpen] = useState(false);
  const [newWorkTitle, setNewWorkTitle] = useState("");
  const [editingWorkId, setEditingWorkId] = useState<string | null>(null);
  const [editingWorkTitle, setEditingWorkTitle] = useState("");
  const [workDeleteTargetId, setWorkDeleteTargetId] = useState<string | null>(null);
  const [chapterDeleteTargetId, setChapterDeleteTargetId] = useState<string | null>(null);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editingChapterTitle, setEditingChapterTitle] = useState("");
  const [editingChapterTitleEn, setEditingChapterTitleEn] = useState("");
  const [editingChapterContent, setEditingChapterContent] = useState("");
  const [editingChapterSummary, setEditingChapterSummary] = useState("");
  const [chapterReaderEditing, setChapterReaderEditing] = useState(false);
  const [chapterExitConfirmOpen, setChapterExitConfirmOpen] = useState(false);
  const [chapterExitTarget, setChapterExitTarget] = useState<ChapterReaderExitTarget>("chapters");
  const [activeArchiveNoteChapterId, setActiveArchiveNoteChapterId] = useState<string | null>(null);
  const [dismissedArchiveNoteChapterId, setDismissedArchiveNoteChapterId] = useState<string | null>(null);
  const [castEditorOpen, setCastEditorOpen] = useState(false);
  const [editingCastId, setEditingCastId] = useState<string | null>(null);
  const [castDeleteTargetId, setCastDeleteTargetId] = useState<string | null>(null);
  const [castForm, setCastForm] = useState<CastFormState>(() => createDefaultCastForm());
  const [statusState, setStatusState] = useState<{ text: string; prominent?: boolean } | null>(null);
  const status = statusState?.text || null;
  const statusProminent = Boolean(statusState?.prominent);
  const setStatus = useCallback((text: string | null, opts?: { prominent?: boolean }) => {
    setStatusState(text ? { text, prominent: opts?.prominent } : null);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const previousActiveChapterIdRef = useRef<string>("");
  const autoArchivingChaptersRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef(session);
  const generationAbortRef = useRef<AbortController | null>(null);
  const resolvedPendingMutationIdsRef = useRef<Set<string>>(new Set());
  const readerSummaryRef = useRef<HTMLDivElement | null>(null);
  const readerTitleRef = useRef<HTMLHeadingElement | null>(null);
  const readerTitleEnRef = useRef<HTMLParagraphElement | null>(null);
  const readerBodyRef = useRef<HTMLElement | null>(null);
  const pendingReaderFocusRef = useRef<{ target: ChapterReaderEditTarget; point?: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const loadedCharacters = loadCharacters();
    const fallbackPartnerId = loadedCharacters[0]?.id || "";
    const loadedLibrary = loadCoCreateLibrary(fallbackPartnerId);
    const shouldPatchPartner = Boolean(fallbackPartnerId) && loadedLibrary.sessions.some((item) => !item.partnerCharacterId);
    const normalizedSessions = loadedLibrary.sessions.map((item) => (
      !item.partnerCharacterId && fallbackPartnerId ? { ...item, partnerCharacterId: fallbackPartnerId } : item
    ));
    const normalizedLibrary = shouldPatchPartner
      ? saveCoCreateLibrary({
        activeSessionId: loadedLibrary.activeSessionId,
        sessions: normalizedSessions,
        settings: loadedLibrary.settings,
      })
      : loadedLibrary;
    const activeSession = normalizedLibrary.sessions.find((item) => item.id === normalizedLibrary.activeSessionId)
      || normalizedLibrary.sessions[0]
      || createDefaultCoCreateSession(fallbackPartnerId);
    setCharacters(loadedCharacters);
    setLibrary(normalizedLibrary);
    setSession(activeSession);
  }, []);

  useEffect(() => {
    if (!scrollRef.current || view !== "write") return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    stickToBottomRef.current = true;
  }, [session.activeChapterId, view]);

  useEffect(() => {
    if (!scrollRef.current || view !== "write") return;
    if (!stickToBottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [session.messages.length, isGenerating, isArchiving, view]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 32;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [view]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), statusProminent ? 2600 : 3200);
    return () => window.clearTimeout(timer);
  }, [status, statusProminent, setStatus]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    resolvedPendingMutationIdsRef.current.clear();
  }, [session.id]);

  useEffect(() => {
    const previousId = previousActiveChapterIdRef.current;
    const currentId = session.activeChapterId;
    previousActiveChapterIdRef.current = currentId;
    if (!previousId || previousId === currentId) return;
    const previousChapter = session.chapters.find((chapter) => chapter.id === previousId);
    if (!previousChapter) return;
    if (!previousChapter.content?.trim()) return;
    if (previousChapter.archivedAt
      && previousChapter.updatedAt
      && previousChapter.updatedAt <= previousChapter.archivedAt) return;
    void runChapterAutoArchive(previousChapter.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.activeChapterId]);

  useEffect(() => {
    setWriterNotebookDraft(session.writerNotebook || "");
    setWriterNotebookDirty(false);
  }, [session.id, session.writerNotebook]);

  useEffect(() => {
    if (!chapterReaderEditing) return;
    setEditableText(readerTitleRef.current, editingChapterTitle);
    setEditableText(readerTitleEnRef.current, editingChapterTitleEn);
    setEditableText(readerBodyRef.current, editingChapterContent);
    setEditableText(readerSummaryRef.current, editingChapterSummary);

    window.requestAnimationFrame(() => {
      const pending = pendingReaderFocusRef.current;
      pendingReaderFocusRef.current = null;
      const target = pending?.target === "title"
        ? readerTitleRef.current
        : pending?.target === "titleEn"
          ? readerTitleEnRef.current
          : pending?.target === "summary"
            ? readerSummaryRef.current
            : readerBodyRef.current;
      if (target) focusEditableAtPoint(target, pending?.point);
    });
  }, [chapterReaderEditing, editingChapterId]);

  const partner = useMemo(
    () => characters.find((character) => character.id === session.partnerCharacterId) || null,
    [characters, session.partnerCharacterId],
  );

  const userName = useMemo(() => {
    if (!partner) return "User";
    return resolveUserIdentity(partner.id, COCREATE_APP_ID)?.name?.trim() || "User";
  }, [partner]);

  const activeChapter = useMemo(
    () => getActiveCoCreateChapter(session),
    [session],
  );
  const activeChapterIndex = activeChapter
    ? session.chapters.findIndex((chapter) => chapter.id === activeChapter.id)
    : -1;
  const visibleMessages = useMemo(
    () => session.messages.filter((message) => !message.promptHidden),
    [session.messages],
  );
  const firstAssistantMessageIds = useMemo(() => {
    const ids = new Set<string>();
    let waitingForAssistant = false;
    for (const message of visibleMessages) {
      if (message.role === "user") {
        waitingForAssistant = true;
        continue;
      }
      if (message.role === "assistant" && waitingForAssistant) {
        ids.add(message.id);
        waitingForAssistant = false;
      }
    }
    return ids;
  }, [visibleMessages]);
  const chapterWords = useMemo(
    () => session.chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    [session.chapters],
  );
  const previousArchiveNote = !activeChapter?.archivedAt && activeChapterIndex > 0 && !activeChapter?.content?.trim()
    ? session.chapters[activeChapterIndex - 1]?.archiveNote || ""
    : "";
  const previousArchiveNoteChapterId = activeChapterIndex > 0 ? session.chapters[activeChapterIndex - 1]?.id || "" : "";
  const seenArchiveNoteChapterIds = session.seenArchiveNoteChapterIds || [];
  const hasSeenPreviousArchiveNote = previousArchiveNoteChapterId
    ? seenArchiveNoteChapterIds.includes(previousArchiveNoteChapterId)
    : false;
  const showArchiveNote = view === "write"
    && Boolean(previousArchiveNote)
    && Boolean(previousArchiveNoteChapterId)
    && previousArchiveNoteChapterId !== dismissedArchiveNoteChapterId
    && (!hasSeenPreviousArchiveNote || activeArchiveNoteChapterId === previousArchiveNoteChapterId);
  const hasWriteContent = Boolean(activeChapter?.content) || visibleMessages.length > 0 || showArchiveNote;
  const sessionMessagesSinceLastSummary = useMemo(() => {
    const since = session.lastMemorySummarizedAt;
    return session.messages.filter((message) => (
      message.role !== "system"
      && message.role !== "tool"
      && !message.promptHidden
      && (!since || message.createdAt > since)
    )).length;
  }, [session.messages, session.lastMemorySummarizedAt]);
  const canSummarizeMemory = sessionMessagesSinceLastSummary >= 2 && !isGenerating && !isArchiving;
  const sessionTitle = session.title.trim() || "Untitled Co-Creation";
  const pendingMutations = [...session.pendingMutations].reverse();
  const recentRevisions = [...session.revisions].slice(-6).reverse();
  const editingCast = editingCastId ? session.cast.find((member) => member.id === editingCastId) || null : null;
  const castDeleteTarget = castDeleteTargetId ? session.cast.find((member) => member.id === castDeleteTargetId) || null : null;
  const editingWork = editingWorkId ? library.sessions.find((item) => item.id === editingWorkId) || null : null;
  const workDeleteTarget = workDeleteTargetId ? library.sessions.find((item) => item.id === workDeleteTargetId) || null : null;
  const chapterDeleteTarget = chapterDeleteTargetId ? session.chapters.find((chapter) => chapter.id === chapterDeleteTargetId) || null : null;
  const editingChapter = editingChapterId ? session.chapters.find((chapter) => chapter.id === editingChapterId) || null : null;
  const sharedSettings = library.settings || session.settings;
  const disabledToolNames = sharedSettings.disabledToolNames || [];
  const disabledToolSet = useMemo(() => new Set(disabledToolNames), [disabledToolNames]);
  const enabledToolCount = COCREATE_TOOL_DEFINITIONS.filter((tool) => !disabledToolSet.has(tool.name)).length;
  const hiddenSecretCount = session.cast.filter((member) => member.secret && member.secretHidden).length;
  const revealedSecretCount = session.cast.filter((member) => member.secret && !member.secretHidden).length;
  const hasCurrentWorkToolHistory = useMemo(() => (
    session.messages.some((message) => isCoCreateToolHistoryMessage(message) || hasCoCreateNativeToolReplayMetadata(message))
  ), [session.messages]);

  function persistSession(next: CoCreateSession): CoCreateSession {
    const saved = saveCoCreateSession(next);
    sessionRef.current = saved;
    setSession(saved);
    setLibrary(loadCoCreateLibrary(saved.partnerCharacterId || characters[0]?.id || ""));
    return saved;
  }

  useEffect(() => {
    if (view !== "write" || !previousArchiveNote || !previousArchiveNoteChapterId) {
      setActiveArchiveNoteChapterId(null);
      return;
    }
    if (hasSeenPreviousArchiveNote) {
      setActiveArchiveNoteChapterId((current) => (current === previousArchiveNoteChapterId ? current : null));
      return;
    }
    setActiveArchiveNoteChapterId(previousArchiveNoteChapterId);
    persistSession({
      ...session,
      seenArchiveNoteChapterIds: Array.from(new Set([...seenArchiveNoteChapterIds, previousArchiveNoteChapterId])),
      updatedAt: new Date().toISOString(),
    });
  }, [
    hasSeenPreviousArchiveNote,
    previousArchiveNote,
    previousArchiveNoteChapterId,
    seenArchiveNoteChapterIds,
    session,
    view,
  ]);

  function persistSharedSettings(nextSettings: CoCreateSettings): void {
    const nextLibrary = saveCoCreateLibrary({
      ...library,
      sessions: library.sessions,
      settings: nextSettings,
    });
    const activeSession = nextLibrary.sessions.find((item) => item.id === session.id)
      || nextLibrary.sessions.find((item) => item.id === nextLibrary.activeSessionId)
      || nextLibrary.sessions[0]
      || { ...session, settings: nextLibrary.settings };
    setLibrary(nextLibrary);
    sessionRef.current = activeSession;
    setSession(activeSession);
  }

  function clearCurrentWorkToolHistory(): void {
    if (isGenerating || isArchiving) {
      setStatus("Co-creation is running. Please clean up after it finishes.");
      return;
    }
    const result = clearCoCreateToolHistory(session);
    setToolHistoryClearConfirmOpen(false);

    if (result.deletedMessages === 0 && result.cleanedMessages === 0) {
      setStatus("This work has no tool-call history to clean up.");
      return;
    }

    persistSession(result.session);
    setStatus(`Cleaned up ${result.deletedMessages} tool record(s) and tidied ${result.cleanedMessages} message(s).`);
  }

  function saveWriterNotebook(): void {
    persistSession({
      ...session,
      writerNotebook: writerNotebookDraft.replace(/\r\n/g, "\n").trim(),
    });
    setWriterNotebookDirty(false);
    setStatus("Writing notebook saved.");
  }

  function openLibrary(): void {
    setError(null);
    setStatus(null);
    setView("library");
  }

  function readChapterReaderDraft(): { title: string; titleEn: string; content: string; summary: string } {
    return {
      title: normalizeEditableText(readerTitleRef.current?.innerText || editingChapterTitle),
      titleEn: normalizeEditableText(readerTitleEnRef.current?.innerText || editingChapterTitleEn),
      content: normalizeEditableText(readerBodyRef.current?.innerText || editingChapterContent),
      summary: normalizeEditableText(readerSummaryRef.current?.innerText || editingChapterSummary),
    };
  }

  function hasUnsavedChapterReaderChanges(): boolean {
    if (!editingChapter || !chapterReaderEditing) return false;
    const draft = readChapterReaderDraft();
    return (draft.title || "Untitled Chapter") !== editingChapter.title
      || (draft.titleEn || `CHAPTER ${editingChapter.num}`) !== editingChapter.titleEn
      || draft.content !== normalizeEditableText(editingChapter.content || "")
      || draft.summary !== normalizeEditableText(editingChapter.summary || "");
  }

  function leaveChapterReader(target: ChapterReaderExitTarget): void {
    setChapterExitConfirmOpen(false);
    setChapterReaderEditing(false);
    setEditingChapterId(null);
    if (target === "library") {
      openLibrary();
    } else {
      setView("chapters");
    }
  }

  function requestChapterReaderExit(target: ChapterReaderExitTarget): void {
    if (chapterReaderEditing && hasUnsavedChapterReaderChanges()) {
      setChapterExitTarget(target);
      setChapterExitConfirmOpen(true);
      return;
    }
    leaveChapterReader(target);
  }

  function handleBack(): void {
    if (view === "library") {
      onClose();
      return;
    }
    if (view === "chapterReader") {
      requestChapterReaderExit("chapters");
      return;
    }
    openLibrary();
  }

  function openNewWorkDialog(): void {
    setNewWorkTitle("");
    setNewWorkOpen(true);
    setError(null);
  }

  function openEditWorkDialog(work: CoCreateSession): void {
    setEditingWorkId(work.id);
    setEditingWorkTitle(work.title);
    setError(null);
  }

  function createWork(): void {
    const title = newWorkTitle.trim() || `Untitled Co-Creation ${String(library.sessions.length + 1).padStart(2, "0")}`;
    const created = createCoCreateSession(title, session.partnerCharacterId || characters[0]?.id || "");
    setSession(created);
    setLibrary(loadCoCreateLibrary(created.partnerCharacterId));
    setNewWorkOpen(false);
    setNewWorkTitle("");
    setView("write");
    setStatus(`Work created: ${created.title}`);
  }

  function enterWork(sessionId: string): void {
    const selected = setActiveCoCreateSession(sessionId, characters[0]?.id || "");
    if (!selected) {
      setError("This work could not be found.");
      return;
    }
    setSession(selected);
    setLibrary(loadCoCreateLibrary(selected.partnerCharacterId || characters[0]?.id || ""));
    setError(null);
    setStatus(null);
    setView("write");
  }

  function saveWorkEdit(): void {
    if (!editingWork) return;
    const updated = {
      ...editingWork,
      title: editingWorkTitle.trim() || "Untitled Co-Creation",
      updatedAt: new Date().toISOString(),
    };
    const nextLibrary = saveCoCreateLibrary({
      ...library,
      sessions: library.sessions.map((item) => (item.id === updated.id ? updated : item)),
      settings: library.settings,
    });
    setLibrary(nextLibrary);
    if (session.id === updated.id) setSession(updated);
    setEditingWorkId(null);
    setEditingWorkTitle("");
    setStatus(`Work updated: ${updated.title}`);
  }

  async function deleteWork(): Promise<void> {
    if (!workDeleteTarget || isDeletingWork) return;
    setIsDeletingWork(true);
    setError(null);
    try {
      const cleanupCharacterIds = Array.from(new Set([
        workDeleteTarget.partnerCharacterId,
        ...characters.map((character) => character.id),
      ].filter(Boolean)));
      let removedShortTerm = 0;
      let removedLongTerm = 0;
      for (const characterId of cleanupCharacterIds) {
        removedShortTerm += deleteCoCreateProjectionEntriesBySession(characterId, workDeleteTarget.id);
        removedLongTerm += await deleteCoCreateLongTermMemoriesBySession(characterId, workDeleteTarget.id);
      }
      const nextLibrary = deleteCoCreateSession(workDeleteTarget.id, workDeleteTarget.partnerCharacterId || characters[0]?.id || "");
      const nextSession = nextLibrary.sessions.find((item) => item.id === nextLibrary.activeSessionId)
        || nextLibrary.sessions[0]
        || createDefaultCoCreateSession(characters[0]?.id || "");
      setLibrary(nextLibrary);
      setSession(nextSession);
      setWorkDeleteTargetId(null);
      setView("library");
      setStatus(`Deleted "${workDeleteTarget.title}" and cleaned up ${removedShortTerm + removedLongTerm} related memories.`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setIsDeletingWork(false);
    }
  }

  function choosePartner(characterId: string): void {
    setError(null);
    persistSession({ ...session, partnerCharacterId: characterId });
  }

  function revealSecret(memberId: string): void {
    persistSession({
      ...session,
      cast: session.cast.map((member) => (
        member.id === memberId ? { ...member, secretHidden: false } : member
      )),
    });
  }

  function openNewCastEditor(): void {
    setEditingCastId(null);
    setCastForm(createDefaultCastForm());
    setCastEditorOpen(true);
    setError(null);
  }

  function openEditCastEditor(member: CoCreateCastMember): void {
    setEditingCastId(member.id);
    setCastForm(castToForm(member));
    setCastEditorOpen(true);
    setError(null);
  }

  function updateCastFormField<K extends keyof CastFormState>(key: K, value: CastFormState[K]): void {
    setCastForm((current) => ({ ...current, [key]: value }));
  }

  function saveCastForm(): void {
    if (!castForm.name.trim()) {
      setError("Please enter a character name first.");
      return;
    }
    const existing = editingCastId ? session.cast.find((member) => member.id === editingCastId) : undefined;
    const nextMember = buildCastMember(castForm, existing);
    const nextCast = existing
      ? session.cast.map((member) => (member.id === existing.id ? nextMember : member))
      : [...session.cast, nextMember];
    persistSession({ ...session, cast: nextCast });
    setCastEditorOpen(false);
    setEditingCastId(null);
    setError(null);
    setStatus(existing ? `Character profile updated: ${nextMember.name}` : `Character profile added: ${nextMember.name}`);
  }

  function deleteCastMember(): void {
    if (!castDeleteTarget) return;
    persistSession({
      ...session,
      cast: session.cast.filter((member) => member.id !== castDeleteTarget.id),
    });
    setCastDeleteTargetId(null);
    setStatus(`Character profile deleted: ${castDeleteTarget.name}`);
  }

  function openChapterReader(chapter: CoCreateChapter): void {
    setEditingChapterId(chapter.id);
    setEditingChapterTitle(chapter.title);
    setEditingChapterTitleEn(chapter.titleEn);
    setEditingChapterContent(chapter.content || "");
    setEditingChapterSummary(chapter.summary || "");
    setChapterReaderEditing(false);
    setChapterExitConfirmOpen(false);
    setView("chapterReader");
    setError(null);
  }

  function startChapterReaderEdit(
    target: ChapterReaderEditTarget = "content",
    event?: ReactPointerEvent<HTMLElement>,
  ): void {
    if (!editingChapter) return;
    if (chapterReaderEditing) return;
    pendingReaderFocusRef.current = {
      target,
      point: event ? { x: event.clientX, y: event.clientY } : undefined,
    };
    setEditingChapterTitle(editingChapter.title);
    setEditingChapterTitleEn(editingChapter.titleEn);
    setEditingChapterContent(editingChapter.content || "");
    setEditingChapterSummary(editingChapter.summary || "");
    setChapterReaderEditing(true);
    setError(null);
  }

  function discardChapterReaderEdit(): void {
    if (editingChapter) {
      setEditingChapterTitle(editingChapter.title);
      setEditingChapterTitleEn(editingChapter.titleEn);
      setEditingChapterContent(editingChapter.content || "");
      setEditingChapterSummary(editingChapter.summary || "");
    }
    setChapterExitConfirmOpen(false);
    setChapterReaderEditing(false);
  }

  function saveChapterEdit(): void {
    if (!editingChapter) return;
    const draft = readChapterReaderDraft();
    const nextTitle = draft.title || "Untitled Chapter";
    const nextTitleEn = draft.titleEn || `CHAPTER ${editingChapter.num}`;
    const nextContent = draft.content;
    const previousContent = normalizeEditableText(editingChapter.content || "");
    const nextSummary = draft.summary;
    const previousSummary = normalizeEditableText(editingChapter.summary || "");
    const titleChanged = nextTitle !== editingChapter.title || nextTitleEn !== editingChapter.titleEn;
    const contentChanged = nextContent !== previousContent;
    const summaryChanged = nextSummary !== previousSummary;
    if (!titleChanged && !contentChanged && !summaryChanged) {
      setChapterReaderEditing(false);
      return;
    }
    const now = new Date().toISOString();
    const changedParts: string[] = [];
    if (titleChanged) changedParts.push("title");
    if (contentChanged) changedParts.push("content");
    if (summaryChanged) changedParts.push("summary");
    const revisionSummary = `Manually edited chapter ${editingChapter.num} ${changedParts.join(", ")}.`;
    const nextChapter = {
      ...editingChapter,
      title: nextTitle,
      titleEn: nextTitleEn,
      content: nextContent || undefined,
      words: nextContent ? countTextWords(nextContent) : 0,
      summary: nextSummary || undefined,
      updatedAt: now,
    };
    persistSession({
      ...session,
      chapters: session.chapters.map((chapter) => (
        chapter.id === editingChapter.id ? nextChapter : chapter
      )),
      revisions: [
        ...session.revisions,
        {
          id: createClientId("cocreate_revision"),
          chapterId: editingChapter.id,
          toolName: "Manual chapter edit",
          beforeTitle: editingChapter.title,
          beforeTitleEn: editingChapter.titleEn,
          afterTitle: nextTitle,
          afterTitleEn: nextTitleEn,
          beforeContent: contentChanged ? previousContent : undefined,
          afterContent: contentChanged ? nextContent : undefined,
          summary: revisionSummary,
          createdAt: now,
        },
      ].slice(-80),
      updatedAt: now,
    });
    setEditingChapterTitle(nextTitle);
    setEditingChapterTitleEn(nextTitleEn);
    setEditingChapterContent(nextContent);
    setChapterReaderEditing(false);
    setStatus(`Chapter ${editingChapter.num} updated.`);
  }

  function updateRecentFullTextChapters(value: number): void {
    const recentFullTextChapters = Math.max(0, Math.min(10, Math.round(value)));
    persistSharedSettings({
      ...sharedSettings,
      recentFullTextChapters,
    });
  }

  function setStreamingEnabled(enabled: boolean): void {
    persistSharedSettings({
      ...sharedSettings,
      streamingEnabled: enabled,
    });
  }

  function setAutoAccept(enabled: boolean): void {
    persistSharedSettings({
      ...sharedSettings,
      autoAccept: enabled,
    });
  }

  function updateMemorySummaryInterval(value: number): void {
    const memorySummaryInterval = Math.max(5, Math.min(100, Math.round(value)));
    persistSharedSettings({
      ...sharedSettings,
      memorySummaryInterval,
    });
  }

  function setToolEnabled(toolName: string, enabled: boolean): void {
    const nextDisabled = new Set(sharedSettings.disabledToolNames || []);
    if (enabled) {
      nextDisabled.delete(toolName);
    } else {
      nextDisabled.add(toolName);
    }
    persistSharedSettings({
      ...sharedSettings,
      disabledToolNames: Array.from(nextDisabled),
    });
  }

  function setAllToolsEnabled(enabled: boolean): void {
    persistSharedSettings({
      ...sharedSettings,
      disabledToolNames: enabled ? [] : COCREATE_TOOL_DEFINITIONS.map((tool) => tool.name),
    });
  }

  function confirmPendingMutation(id: string): void {
    const snapshot = sessionRef.current;
    if (snapshot.pendingMutations.some((mutation) => mutation.id === id)) {
      resolvedPendingMutationIdsRef.current.add(id);
    }
    const result = applyCoCreatePendingMutation(snapshot, id);
    persistSession(result.session);
    if (result.success) {
      setError(null);
      setStatus(result.notice);
    } else {
      setError(result.error || result.notice);
    }
  }

  function rejectPendingMutation(id: string): void {
    const snapshot = sessionRef.current;
    if (snapshot.pendingMutations.some((mutation) => mutation.id === id)) {
      resolvedPendingMutationIdsRef.current.add(id);
    }
    persistSession(discardCoCreatePendingMutation(snapshot, id));
    setStatus("This pending change has been discarded.");
  }

  function rollbackRevision(id: string): void {
    const result = rollbackCoCreateRevision(session, id);
    persistSession(result.session);
    if (result.success) {
      setError(null);
      setStatus(result.notice);
    } else {
      setError(result.error || result.notice);
    }
  }

  function deleteChapter(chapter: CoCreateChapter): void {
    const targetIndex = session.chapters.findIndex((item) => item.id === chapter.id);
    if (targetIndex < 0) return;
    const remainingChapters = reindexCoCreateChapters(session.chapters.filter((item) => item.id !== chapter.id));
    const nextActiveChapter = remainingChapters[targetIndex] || remainingChapters[targetIndex - 1] || remainingChapters[0] || null;
    persistSession({
      ...session,
      activeChapterId: nextActiveChapter?.id || "",
      chapters: remainingChapters,
      revisions: session.revisions.filter((revision) => revision.chapterId !== chapter.id),
      pendingMutations: session.pendingMutations.filter((mutation) => mutation.chapterId !== chapter.id),
      toolArtifacts: session.toolArtifacts.filter((artifact) => artifact.chapterId !== chapter.id),
      rollingSummary: [...remainingChapters].reverse()
        .map((item) => item.memoryEntries?.[item.memoryEntries.length - 1]?.text?.trim())
        .find((text): text is string => Boolean(text)),
    });
    setChapterDeleteTargetId(null);
    setStatus(`Chapter ${chapter.num} deleted; chapter numbers have been re-sequenced.`);
  }

  function createManualChapter(): void {
    const nextChapter = createNextCoCreateChapter(session.chapters);
    const saved = persistSession({
      ...session,
      activeChapterId: nextChapter.id,
      chapters: [...session.chapters, nextChapter],
    });
    const created = saved.chapters.find((chapter) => chapter.id === nextChapter.id) || nextChapter;
    setStatus(`Chapter ${created.num} added.`);
    openChapterReader(created);
  }

  function getMessageChapterId(message: CoCreateSession["messages"][number]): string {
    return message.chapterId || session.activeChapterId || "";
  }

  function beginEditUserMessage(message: CoCreateSession["messages"][number]): void {
    if (message.role !== "user" || isGenerating || isArchiving) return;
    setEditingUserMessageId(message.id);
    setMode(message.mode === "discuss" ? "discuss" : "write");
    setInput(message.content);
    setStatus("Sending this edit will discard replies after it and regenerate.");
  }

  async function runCoCreateGeneration(
    draft: CoCreateSession,
    generationMode: CoCreateMode,
    chapterId: string,
    logInput: string,
  ): Promise<void> {
    if (!partner) {
      setError("Please choose a co-creation partner character first.");
      return;
    }
    const logChapter = draft.chapters.find((chapter) => chapter.id === chapterId)
      || draft.chapters.find((chapter) => chapter.id === draft.activeChapterId)
      || null;

    const liveMessages: CoCreateSession["messages"] = [];
    let assistantEmitted = false;
    let streamedAssistantContent = "";
    let activeAssistantMessageId = "";
    let lastAssistantMessageId = "";
    let reasoningMessageId = "";
    let latestWorkingSession = draft;
    const toolCardByCallId = new Map<string, string>();
    let lastStreamPaintAt = 0;
    let lastStreamPaintLength = 0;
    const autoScrollIfStuck = () => {
      if (stickToBottomRef.current) scrollPanelToBottom(scrollRef.current);
    };
    const updateSessionState = (updater: (current: CoCreateSession) => CoCreateSession) => {
      setSession((current) => {
        const next = updater(current);
        sessionRef.current = next;
        return next;
      });
    };
    const mergeCurrentWithWorkingSession = (current: CoCreateSession, nextSession: CoCreateSession): CoCreateSession => {
      if (current.id !== nextSession.id) return current;
      if (sharedSettings.autoAccept !== false) {
        return { ...nextSession, messages: current.messages };
      }

      const resolvedPendingIds = resolvedPendingMutationIdsRef.current;
      const currentPendingIds = new Set(current.pendingMutations.map((mutation) => mutation.id));
      const pendingMutations = [
        ...current.pendingMutations,
        ...nextSession.pendingMutations.filter((mutation) => (
          !resolvedPendingIds.has(mutation.id) && !currentPendingIds.has(mutation.id)
        )),
      ];
      const currentArtifactIds = new Set(current.toolArtifacts.map((artifact) => artifact.id));
      const toolArtifacts = [
        ...current.toolArtifacts,
        ...nextSession.toolArtifacts.filter((artifact) => !currentArtifactIds.has(artifact.id)),
      ].slice(-20);
      const nextActiveChapterId = current.chapters.some((chapter) => chapter.id === nextSession.activeChapterId)
        ? nextSession.activeChapterId
        : current.activeChapterId;

      return {
        ...nextSession,
        activeChapterId: nextActiveChapterId,
        cast: current.cast,
        chapters: current.chapters,
        relationshipDossier: current.relationshipDossier,
        writerNotebook: current.writerNotebook,
        revisions: current.revisions,
        pendingMutations,
        toolArtifacts,
        messages: current.messages,
      };
    };
    const mergeLiveMessagesIntoSession = (
      baseSession: CoCreateSession,
      messagesToMerge: CoCreateSession["messages"],
    ): CoCreateSession => {
      const liveById = new Map(messagesToMerge.map((message) => [message.id, message]));
      const mergedIds = new Set<string>();
      const messages = baseSession.messages.map((message) => {
        const live = liveById.get(message.id);
        if (!live) return message;
        mergedIds.add(message.id);
        return { ...message, ...live };
      });
      const existingIds = new Set(messages.map((message) => message.id));
      for (const message of messagesToMerge) {
        if (mergedIds.has(message.id) || existingIds.has(message.id)) continue;
        messages.push(message);
        existingIds.add(message.id);
      }
      return { ...baseSession, messages };
    };
    const appendLiveMessage = (message: CoCreateSession["messages"][number]) => {
      liveMessages.push(message);
      updateSessionState((current) => ({
        ...current,
        messages: [...current.messages, message],
      }));
      autoScrollIfStuck();
    };
    const updateLiveMessage = (id: string, content: string) => {
      const index = liveMessages.findIndex((message) => message.id === id);
      if (index >= 0) {
        liveMessages[index] = { ...liveMessages[index], content };
      }
      updateSessionState((current) => ({
        ...current,
        messages: current.messages.map((message) => (
          message.id === id ? { ...message, content } : message
        )),
      }));
      autoScrollIfStuck();
    };
    const updateLiveMessagePatch = (id: string, patch: Partial<CoCreateSession["messages"][number]>) => {
      const index = liveMessages.findIndex((message) => message.id === id);
      if (index >= 0) {
        liveMessages[index] = { ...liveMessages[index], ...patch };
      }
      updateSessionState((current) => ({
        ...current,
        messages: current.messages.map((message) => (
          message.id === id ? { ...message, ...patch } : message
        )),
      }));
      autoScrollIfStuck();
    };

    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    try {
      const generationDraft = { ...draft, settings: sharedSettings };
      const result = await generateCoCreateReply(generationDraft, generationMode, {
        async onAssistantStep(stepContent) {
          const normalized = stepContent.trim();
          if (!normalized) return;
          assistantEmitted = true;
          activeAssistantMessageId = "";
          const message = createCoCreateMessage("assistant", generationMode, normalized, partner.name, chapterId);
          lastAssistantMessageId = message.id;
          appendLiveMessage(message);
          await waitForLiveStep();
        },
        async onAssistantDelta(deltaContent) {
          if (!deltaContent) return;
          assistantEmitted = true;
          streamedAssistantContent += deltaContent;
          if (!activeAssistantMessageId) {
            const message = createCoCreateMessage("assistant", generationMode, deltaContent, partner.name, chapterId);
            activeAssistantMessageId = message.id;
            lastAssistantMessageId = message.id;
            appendLiveMessage(message);
          } else {
            const current = liveMessages.find((message) => message.id === activeAssistantMessageId)?.content || "";
            const nextContent = `${current}${deltaContent}`;
            lastAssistantMessageId = activeAssistantMessageId;
            updateLiveMessage(activeAssistantMessageId, nextContent);
          }
          const now = Date.now();
          if (streamedAssistantContent.length - lastStreamPaintLength >= 24 || now - lastStreamPaintAt >= 80) {
            lastStreamPaintAt = now;
            lastStreamPaintLength = streamedAssistantContent.length;
            await waitForStreamPaint();
          }
        },
        async onReasoningDelta(deltaContent) {
          if (!deltaContent) return;
          if (!reasoningMessageId) {
            const message = createCoCreateMessage(
              "system",
              generationMode,
              deltaContent,
              "正在创作剧本...",
              chapterId,
              "reasoning",
            );
            reasoningMessageId = message.id;
            appendLiveMessage(message);
          } else {
            const current = liveMessages.find((message) => message.id === reasoningMessageId)?.content || "";
            updateLiveMessage(reasoningMessageId, `${current}${deltaContent}`);
          }
          await waitForStreamPaint();
        },
        async onWorkingSessionUpdate(nextSession) {
          latestWorkingSession = nextSession;
          updateSessionState((current) => mergeCurrentWithWorkingSession(current, nextSession));
          await waitForLiveStep();
        },
        async onToolCallStart({ id, name }) {
          activeAssistantMessageId = "";
          const content = `正在调用 ${name}…`;
          const message = createCoCreateMessage("system", generationMode, content, "TOOL", chapterId);
          toolCardByCallId.set(id, message.id);
          appendLiveMessage(message);
          await waitForLiveStep();
        },
        async onToolCallResult({ id, name, notice, content: resultContent }) {
          const visible = notice?.trim() || resultContent?.trim() || `${name} completed`;
          if (name === "切换" && /切换到第/.test(visible)) {
            setStatus(visible, { prominent: true });
          }
          const messageId = toolCardByCallId.get(id);
          if (messageId) {
            updateLiveMessage(messageId, visible);
            toolCardByCallId.delete(id);
          } else {
            appendLiveMessage(createCoCreateMessage("system", generationMode, visible, "TOOL", chapterId));
          }
          lastAssistantMessageId = "";
          await waitForLiveStep();
        },
        async onToolStart() {
          activeAssistantMessageId = "";
        },
        async onToolResult() {
          lastAssistantMessageId = "";
        },
        async onNativeToolAssistantTurn({ content, rawContent, reasoning, openRouterReasoningDetails, toolCalls }) {
          const targetId = activeAssistantMessageId || lastAssistantMessageId;
          if (targetId) {
            updateLiveMessagePatch(targetId, {
              rawResponseText: rawContent,
              nativeToolCalls: toolCalls,
              nativeToolReasoning: reasoning,
              nativeToolOpenRouterReasoningDetails: openRouterReasoningDetails,
            });
            return;
          }
          const message = createCoCreateMessage("assistant", generationMode, content.trim(), partner.name, chapterId);
          message.promptHidden = true;
          message.rawResponseText = rawContent;
          message.nativeToolCalls = toolCalls;
          message.nativeToolReasoning = reasoning;
          message.nativeToolOpenRouterReasoningDetails = openRouterReasoningDetails;
          liveMessages.push(message);
        },
        async onNativeToolResult({ toolCallId, name, content }) {
          const message = createCoCreateMessage("tool", generationMode, "", "TOOL", chapterId, "tool");
          message.promptHidden = true;
          message.nativeToolResult = { toolCallId, name, content };
          liveMessages.push(message);
        },
        async onStreamFallback(reason) {
          setStatus(`Streaming unavailable, switched to standard generation: ${reason}`);
        },
      }, { signal: abortController.signal });
      const workingSession = result.updatedSession || latestWorkingSession;
      if (reasoningMessageId) {
        updateLiveMessagePatch(reasoningMessageId, { authorName: "Creative Process" });
      }
      const normalizedResult = result.content.trim();
      if (normalizedResult && !assistantEmitted) {
        liveMessages.push(createCoCreateMessage("assistant", generationMode, normalizedResult, partner.name, workingSession.activeChapterId || chapterId));
      }
      const baseSession = mergeCurrentWithWorkingSession(sessionRef.current, workingSession);
      persistSession(appendBackendLog({
        ...mergeLiveMessagesIntoSession(baseSession, liveMessages),
        turnsSinceSummary: 0,
      }, {
        kind: "reply",
        status: "success",
        title: `${modeLabel(generationMode)} generation succeeded`,
        mode: generationMode,
        chapterNum: logChapter?.num,
        chapterTitle: logChapter?.title,
        model: result.model,
        presetName: result.presetName,
        input: logInput,
        output: result.content,
        rawOutputs: result.rawOutputs,
        toolNotices: result.toolNotices,
        toolDebugs: result.toolDebugs,
      }));
      if (result.toolNotices?.length) {
        setStatus(result.toolNotices.join("; "));
      }
    } catch (generateError) {
      const isAbort = abortController.signal.aborted
        || (generateError instanceof DOMException && generateError.name === "AbortError");
      if (isAbort) {
        for (const messageId of toolCardByCallId.values()) {
          const card = liveMessages.find((message) => message.id === messageId);
          const name = card?.content?.match(/正在调用\s*([^\s…]+)/)?.[1];
          updateLiveMessage(messageId, name ? `Cancelled call to ${name}` : "Call cancelled");
        }
        toolCardByCallId.clear();
        const workingSession = latestWorkingSession || draft;
        const baseSession = mergeCurrentWithWorkingSession(sessionRef.current, workingSession);
        persistSession(appendBackendLog(mergeLiveMessagesIntoSession(baseSession, liveMessages), {
          kind: "reply",
          status: "success",
          title: `${modeLabel(generationMode)} stopped`,
          mode: generationMode,
          chapterNum: logChapter?.num,
          chapterTitle: logChapter?.title,
          input: logInput,
          output: "(User stopped generation)",
        }));
      } else {
        const message = errorMessage(generateError);
        const workingSession = latestWorkingSession || draft;
        const baseSession = mergeCurrentWithWorkingSession(sessionRef.current, workingSession);
        persistSession(appendBackendLog(mergeLiveMessagesIntoSession(baseSession, liveMessages), {
          kind: "reply",
          status: "error",
          title: `${modeLabel(generationMode)} generation failed`,
          mode: generationMode,
          chapterNum: logChapter?.num,
          chapterTitle: logChapter?.title,
          input: logInput,
          error: message,
        }));
        setError(message);
      }
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  }

  async function handleSend(): Promise<void> {
    const content = input.trim();
    if (!content || isGenerating || isArchiving) return;
    if (!partner) {
      setError("Please choose a co-creation partner character first.");
      return;
    }

    stickToBottomRef.current = true;
    setInput("");
    setError(null);
    setStatus(null);
    setIsGenerating(true);

    const editingId = editingUserMessageId;
    setEditingUserMessageId(null);
    try {
      if (editingId) {
        const targetIndex = session.messages.findIndex((message) => message.id === editingId && message.role === "user");
        const targetMessage = targetIndex >= 0 ? session.messages[targetIndex] : null;
        if (!targetMessage) throw new Error("Could not find the user message to edit.");
        const chapterId = getMessageChapterId(targetMessage);
        const nextMessage = {
          ...targetMessage,
          mode: targetMessage.mode === "discuss" ? "discuss" as const : "write" as const,
          content,
          authorName: userName,
        };
        const nextMessages = session.messages.flatMap((message, index) => {
          if (index < targetIndex) return [message];
          if (index === targetIndex) return [nextMessage];
          return [];
        });
        const draft = persistSession({
          ...session,
          activeChapterId: chapterId || session.activeChapterId,
          messages: nextMessages,
        });
        await runCoCreateGeneration(draft, nextMessage.mode as CoCreateMode, chapterId || draft.activeChapterId, content);
      } else {
        const prepared = ensureActiveCoCreateChapter(session);
        const chapterId = prepared.activeChapterId;
        const userMessage = createCoCreateMessage("user", mode, content, userName, chapterId);
        const draft = persistSession({
          ...prepared,
          messages: [...prepared.messages, userMessage],
        });
        await runCoCreateGeneration(draft, mode, chapterId, content);
      }
      maybeAutoSummarizeSessionMemory();
    } finally {
      setIsGenerating(false);
    }
  }

  function maybeAutoSummarizeSessionMemory(): void {
    if (isArchiving) return;
    const snapshot = sessionRef.current;
    const interval = snapshot.settings?.memorySummaryInterval ?? sharedSettings.memorySummaryInterval ?? 20;
    if (!Number.isFinite(interval) || interval <= 0) return;
    const since = snapshot.lastMemorySummarizedAt;
    const newCount = snapshot.messages.filter((message) => (
      message.role !== "system"
      && message.role !== "tool"
      && !message.promptHidden
      && (!since || message.createdAt > since)
    )).length;
    if (newCount < interval) return;
    void handleSummarizeSessionMemory();
  }

  async function retryFromAssistantMessage(message: CoCreateSession["messages"][number]): Promise<void> {
    if (message.role !== "assistant" || isGenerating || isArchiving) return;
    const targetIndex = session.messages.findIndex((item) => item.id === message.id);
    if (targetIndex < 0) return;
    const chapterId = getMessageChapterId(message);
    const previousUser = [...session.messages.slice(0, targetIndex)]
      .reverse()
      .find((item) => item.role === "user");
    if (!previousUser) {
      setError("Could not find a user input to retry from.");
      return;
    }

    stickToBottomRef.current = true;
    setError(null);
    setStatus(null);
    setIsGenerating(true);
    try {
      const draft = persistSession({
        ...session,
        activeChapterId: chapterId || session.activeChapterId,
        messages: session.messages.filter((_, index) => index < targetIndex),
      });
      const generationMode = previousUser.mode === "discuss" ? "discuss" : "write";
      setMode(generationMode);
      await runCoCreateGeneration(draft, generationMode, chapterId || draft.activeChapterId, previousUser.content);
    } finally {
      setIsGenerating(false);
    }
  }

  async function runChapterAutoArchive(chapterId: string): Promise<void> {
    if (autoArchivingChaptersRef.current.has(chapterId)) return;
    autoArchivingChaptersRef.current.add(chapterId);
    try {
      const snapshot = sessionRef.current;
      const target = snapshot.chapters.find((chapter) => chapter.id === chapterId);
      if (!target || !target.content?.trim()) return;
      const result = await generateCoCreateChapterAutoArchive(snapshot, target);
      if (!result) return;
      const archivedAt = new Date().toISOString();
      setSession((current) => {
        if (!current.chapters.some((chapter) => chapter.id === chapterId)) return current;
        const next = {
          ...current,
          chapters: current.chapters.map((chapter) => (
            chapter.id === chapterId
              ? { ...chapter, summary: result.summary, archiveNote: result.archiveNote, archivedAt }
              : chapter
          )),
        };
        saveCoCreateSession(next);
        return next;
      });
    } catch (error) {
      console.warn("[cocreate] chapter auto-archive failed", error);
    } finally {
      autoArchivingChaptersRef.current.delete(chapterId);
    }
  }

  async function handleSummarizeSessionMemory(): Promise<void> {
    if (!partner || isArchiving || isGenerating) return;
    setArchiveConfirmOpen(false);
    setError(null);
    setStatus(null);
    setIsArchiving(true);

    try {
      const sinceTimestamp = session.lastMemorySummarizedAt;
      const result = await generateCoCreateSessionMemory(session, { sinceTimestamp });
      if (!result) {
        setStatus("Not enough recent new conversation to summarize.");
        return;
      }
      const summarizedAt = new Date().toISOString();
      const targetChapterId = sessionRef.current.activeChapterId;
      setSession((current) => {
        const chapters = current.chapters.map((chapter) => {
          if (chapter.id !== targetChapterId) return chapter;
          const nextEntries = [
            ...(chapter.memoryEntries || []),
            { text: result.memory, archivedAt: summarizedAt },
          ];
          return { ...chapter, memoryEntries: nextEntries };
        });
        const next: CoCreateSession = {
          ...current,
          chapters,
          rollingSummary: result.memory,
          turnsSinceSummary: 0,
          lastMemorySummarizedAt: summarizedAt,
        };
        const saved = saveCoCreateSession(next);
        const activeChapter = saved.chapters.find((chapter) => chapter.id === targetChapterId);
        const entryCount = activeChapter?.memoryEntries?.length || 1;
        recordCoCreateProjectionEvent({
          sessionId: saved.id,
          characterId: partner.id,
          title: saved.title,
          partnerName: partner.name,
          userName,
          memory: result.memory,
          chapterId: activeChapter?.id,
          chapterNum: activeChapter?.num,
          chapterTitle: activeChapter?.title,
          chapterVersion: entryCount,
        });
        return saved;
      });
      incrementEventCounter(partner.id);
      maybeRunSummarization(partner.id, partner.name).catch((summarizeError) => {
        console.warn("[cocreate] long-term memory summarization failed", summarizeError);
      });
      setStatus(`Summarized the last ${result.messageCount} messages into one memory.`);
      onNotice?.("Session memory has been summarized.");
    } catch (summaryError) {
      const message = errorMessage(summaryError);
      setError(message);
    } finally {
      setIsArchiving(false);
    }
  }

  function handleTextareaKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSend();
    }
  }

  function exportManuscriptTxt(): void {
    if (!hasExportableContent(session)) {
      setStatus("No content to export yet.");
      return;
    }
    try {
      const blob = new Blob([buildExportText(session)], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeExportFileName(session.title)}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus("TXT exported.");
    } catch {
      setError("Failed to export TXT.");
    }
  }

  return (
    <div className="cocreate-app">
      <div className="cocreate-cosmic" aria-hidden="true" />
      <div className="cocreate-stars" aria-hidden="true" />
      {status && (
        <div
          className={statusProminent ? "cocreate-toast cocreate-toast--prominent" : "cocreate-toast"}
          role="status"
          aria-live="polite"
        >
          {status}
        </div>
      )}
      <header className="cocreate-topbar">
        <div className="cocreate-head-left">
          <button
            type="button"
            className="cocreate-back-button"
            onClick={handleBack}
            aria-label={view === "library" ? "Back to desktop" : view === "chapterReader" ? "Back to chapter list" : "Back to library"}
          >
            <ChevronLeft size={22} />
          </button>
          <div className="cocreate-avatar-mark">
            <span>{fallbackInitial(view === "library" ? "Library" : partner?.name || sessionTitle)}</span>
          </div>
          <div className="cocreate-brand">
            <span>{view === "library" ? "CO·CREATE LIBRARY" : "CO·CREATE"}</span>
            <strong>
              {view === "library"
                ? `${library.sessions.length} WORKS // NOVEL DESK`
                : `${partner?.name || "No partner selected"} × ${userName} // S.1`}
            </strong>
          </div>
        </div>
        <div className="cocreate-head-actions">
          {view === "library" ? (
            <button type="button" className="cocreate-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Co-creation settings">
              <MoreHorizontal size={17} />
            </button>
          ) : view === "chapterReader" ? (
            editingChapter && !chapterReaderEditing ? (
              <button
                type="button"
                className="cocreate-icon-button"
                onClick={() => startChapterReaderEdit("content")}
                aria-label="Edit chapter"
                title="Edit chapter"
              >
                <Pencil size={15} />
              </button>
            ) : null
          ) : (
            <button type="button" className="cocreate-icon-button" onClick={() => setBackendLogOpen(true)} aria-label="Backend logs">
              <Wrench size={16} />
            </button>
          )}
          <div className="cocreate-live-pill">
            <i />
            <span>{view === "library" ? "LIB" : "LIVE"}</span>
          </div>
        </div>
      </header>

      <main className="cocreate-main">
        {view === "library" ? (
          <section className="cocreate-library-panel">
            <div className="cocreate-library-hero">
              <span>WORK DESK</span>
              <h1>Library</h1>
              <p>Each novel has its own chapters, character profiles, action records, and co-creation memory. Deleting a work also cleans up the memories it wrote.</p>
            </div>

            {error && <div className="cocreate-error cocreate-library-status">{error}</div>}

            <div className="cocreate-work-list" aria-label="Existing works">
              {library.sessions.length === 0 && (
                <div className="cocreate-work-empty">
                  <FilePlus size={22} />
                  <strong>No works yet.</strong>
                  <p>Add a novel, then enter the writing page and start writing with your co-creation partner.</p>
                </div>
              )}
              {library.sessions.map((item, index) => {
                const itemPartner = characters.find((character) => character.id === item.partnerCharacterId);
                const doneChapters = item.chapters.filter((chapter) => Boolean(chapter.archivedAt)).length;
                const words = item.chapters.reduce((sum, chapter) => sum + chapter.words, 0);
                return (
                  <article key={item.id} className="cocreate-work-card" data-active={item.id === session.id ? "1" : undefined}>
                    <button type="button" className="cocreate-work-main" onClick={() => enterWork(item.id)}>
                      <div className="cocreate-work-card-head">
                        <span>WORK {String(index + 1).padStart(2, "0")}</span>
                        <strong>{item.title || "Untitled Co-Creation"}</strong>
                      </div>
                      <div className="cocreate-work-meta">
                        <div>
                          <span>PARTNER</span>
                          <strong>{itemPartner?.name || "Not selected"}</strong>
                        </div>
                        <div>
                          <span>CHAPTER</span>
                          <strong>{doneChapters}/{item.chapters.length}</strong>
                        </div>
                        <div>
                          <span>WORDS</span>
                          <strong>{words.toLocaleString()}</strong>
                        </div>
                        <div>
                          <span>TIME</span>
                          <time>{formatShortDate(item.updatedAt || item.createdAt)}</time>
                        </div>
                      </div>
                    </button>
                    <div className="cocreate-work-actions">
                      <button type="button" onClick={() => openEditWorkDialog(item)} aria-label={`Edit work ${item.title || "Untitled Co-Creation"}`} title="Rename">
                        <Pencil size={14} />
                      </button>
                      <button type="button" onClick={() => setWorkDeleteTargetId(item.id)} aria-label={`Delete work ${item.title || "Untitled Co-Creation"}`} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : (
          <>
            {view !== "chapterReader" && (
              <>
                <section className="cocreate-hero">
                  <div className="cocreate-title-wrap">
                    <h1>{sessionTitle}</h1>
                    <mark aria-hidden="true" />
                  </div>
                  <p>{WORK_DECORATIVE_SUBTITLE}</p>
                </section>

                <nav className="cocreate-tabs" aria-label="Co-creation pages">
                  <button type="button" data-active={view === "write" ? "1" : undefined} onClick={() => setView("write")}>
                    <span>WRITE</span>
                    <small>Manuscript</small>
                  </button>
                  <button type="button" data-active={view === "characters" ? "1" : undefined} onClick={() => setView("characters")}>
                    <span>ARCHIVE</span>
                    <small>Profiles</small>
                  </button>
                  <button type="button" data-active={view === "chapters" ? "1" : undefined} onClick={() => setView("chapters")}>
                    <span>INDEX</span>
                    <small>Chapters</small>
                  </button>
                </nav>
              </>
            )}

            {error && <div className={view === "chapterReader" ? "cocreate-error cocreate-reader-error" : "cocreate-error"}>{error}</div>}

        {view === "write" && (
          <section ref={scrollRef} className="cocreate-write-panel">
            {activeChapter && (
              <button
                type="button"
                className="cocreate-write-chapter-strip"
                onClick={() => openChapterReader(activeChapter)}
                aria-label={`View chapter ${activeChapter.num}`}
                title="Click to view / edit chapter content"
              >
                <i aria-hidden="true" />
                <span>CHAPTER.{activeChapter.num}</span>
                <strong>{activeChapter.title}</strong>
                <em>{activeChapter.words.toLocaleString()} words</em>
              </button>
            )}

            {!hasWriteContent && (
              <div className="cocreate-empty-state">
                <span>[ BLANK PAGE ]</span>
                <strong>No content yet.</strong>
                <p>Choose a co-creation partner first, then create a chapter and start writing with your AI character~</p>
              </div>
            )}

            {showArchiveNote && (
              <aside className="cocreate-archive-note-popover" aria-label="Previous chapter closing note">
                <button
                  type="button"
                  onClick={() => setDismissedArchiveNoteChapterId(previousArchiveNoteChapterId)}
                  aria-label="Close previous chapter closing note"
                >
                  <X size={14} />
                </button>
                <span>ARCHIVE NOTE</span>
                <strong>Previous Chapter Closing Note</strong>
                <CoCreateMarkdown content={previousArchiveNote} />
              </aside>
            )}

            {visibleMessages.map((message) => {
              if (message.mode === "chapter") {
                return (
                  <article key={message.id} className="cocreate-chapter-card">
                    <CoCreateMarkdown content={message.content} />
                  </article>
                );
              }

              const isWrite = message.mode === "write";
              const isUser = message.role === "user";
              const canRetryFromHere = !isUser && message.role === "assistant" && firstAssistantMessageIds.has(message.id);
              const systemStepsBeforeAssistant = !isUser && message.role === "assistant"
                ? (() => {
                  const index = visibleMessages.findIndex((item) => item.id === message.id);
                  const steps: CoCreateSession["messages"] = [];
                  for (let i = index - 1; i >= 0; i -= 1) {
                    const previous = visibleMessages[i];
                    if (!previous || !isCoCreateSystemStep(previous)) break;
                    steps.unshift(previous);
                  }
                  return steps;
                })()
                : [];
              if (isCoCreateSystemStep(message)) {
                const index = visibleMessages.findIndex((item) => item.id === message.id);
                const nextNonSystem = visibleMessages.slice(index + 1).find((item) => !isCoCreateSystemStep(item));
                if (nextNonSystem?.role === "assistant") return null;
              }
              if (message.kind === "reasoning") {
                const isRunningReasoning = message.authorName?.includes("正在") && isGenerating;
                return (
                  <article key={message.id} className="cocreate-write-block">
                    <div className="cocreate-block-meta">
                      <span>// AI</span>
                      <strong>{partner?.name || "AI"}</strong>
                      <i />
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    <details
                      className="cocreate-reasoning-fold cocreate-reasoning-fold-inline"
                      data-running={isRunningReasoning ? "1" : undefined}
                    >
                      <summary>
                        <span>
                          {isRunningReasoning ? <Loader2 size={13} /> : <ChevronDown size={13} />}
                          {message.authorName || "Creative Process"}
                        </span>
                        {isRunningReasoning && (
                          <span className="cocreate-action-dots" aria-hidden="true">
                            <b />
                            <b />
                            <b />
                          </span>
                        )}
                        <time>{formatDate(message.createdAt)}</time>
                      </summary>
                      <CoCreateMarkdown content={message.content} />
                    </details>
                  </article>
                );
              }
              const isActionMessage = isCoCreateSystemStep(message);
              if (isActionMessage) {
                const isRunningTool = /^正在(调用|执行)/.test(message.content);
                return (
                  <article key={message.id} className="cocreate-tool-step" data-running={isRunningTool ? "1" : undefined}>
                    <div className="cocreate-tool-step-head">
                      <strong>// AI {partner?.name || "AI"}</strong>
                      {isRunningTool ? <Loader2 size={14} /> : <Check size={14} />}
                      <span>{isRunningTool ? "ACTION RUNNING" : "ACTION RESULT"}</span>
                      {isRunningTool && (
                        <span className="cocreate-action-dots" aria-hidden="true">
                          <b />
                          <b />
                          <b />
                        </span>
                      )}
                      <i />
                      <time>{formatDate(message.createdAt)}</time>
                    </div>
                    <CoCreateMarkdown content={message.content} />
                  </article>
                );
              }
              if (isWrite) {
                return (
                  <article key={message.id} className={isUser ? "cocreate-write-block cocreate-write-user" : "cocreate-write-block"}>
                    <div className="cocreate-block-meta">
                      <span>{isUser ? "// USER" : "// AI"}</span>
                      <strong>{message.authorName || (isUser ? userName : partner?.name || "AI")}</strong>
                      <i />
                      <span className="cocreate-message-actions" aria-label="Message actions">
                        <button
                          type="button"
                          onClick={() => copyTextToClipboard(message.content, onNotice)}
                          aria-label="Copy original text"
                          title="Copy"
                        >
                          <Copy size={12} />
                        </button>
                        {isUser ? (
                          <button
                            type="button"
                            onClick={() => beginEditUserMessage(message)}
                            disabled={isGenerating || isArchiving}
                            aria-label="Edit and resend"
                            title="Edit"
                          >
                            <Pencil size={12} />
                          </button>
                        ) : canRetryFromHere ? (
                          <button
                            type="button"
                            onClick={() => void retryFromAssistantMessage(message)}
                            disabled={isGenerating || isArchiving}
                            aria-label="Retry from here"
                            title="Retry from here"
                          >
                            <RotateCcw size={12} />
                          </button>
                        ) : null}
                      </span>
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    {systemStepsBeforeAssistant.map((step) => {
                      if (step.kind === "reasoning") {
                        const isRunningReasoning = step.authorName?.includes("正在") && isGenerating;
                        return (
                          <details
                            key={step.id}
                            className="cocreate-reasoning-fold cocreate-reasoning-fold-inline"
                            data-running={isRunningReasoning ? "1" : undefined}
                          >
                            <summary>
                              <span>
                                {isRunningReasoning ? <Loader2 size={13} /> : <ChevronDown size={13} />}
                                {step.authorName || "Creative Process"}
                              </span>
                              {isRunningReasoning && (
                                <span className="cocreate-action-dots" aria-hidden="true">
                                  <b />
                                  <b />
                                  <b />
                                </span>
                              )}
                              <time>{formatDate(step.createdAt)}</time>
                            </summary>
                            <CoCreateMarkdown content={step.content} />
                          </details>
                        );
                      }
                      const isRunningTool = step.content.includes("正在执行");
                      return (
                        <article key={step.id} className="cocreate-tool-step cocreate-tool-step-inline" data-running={isRunningTool ? "1" : undefined}>
                          <div className="cocreate-tool-step-head">
                            {isRunningTool ? <Loader2 size={14} /> : <Check size={14} />}
                            <span>{isRunningTool ? "ACTION RUNNING" : "ACTION RESULT"}</span>
                            {isRunningTool && (
                              <span className="cocreate-action-dots" aria-hidden="true">
                                <b />
                                <b />
                                <b />
                              </span>
                            )}
                            <i />
                            <time>{formatDate(step.createdAt)}</time>
                          </div>
                          <CoCreateMarkdown content={step.content} />
                        </article>
                      );
                    })}
                    <CoCreateMarkdown content={message.content} />
                  </article>
                );
              }

              return (
                <article
                  key={message.id}
                  className={isUser ? "cocreate-message cocreate-message-user" : "cocreate-message"}
                >
                  <div className="cocreate-block-meta">
                    <span>{message.authorName || (isUser ? userName : partner?.name || "AI")}</span>
                    <i />
                    <span className="cocreate-message-actions" aria-label="Message actions">
                      <button
                        type="button"
                        onClick={() => copyTextToClipboard(message.content, onNotice)}
                        aria-label="Copy original text"
                        title="Copy"
                      >
                        <Copy size={12} />
                      </button>
                      {isUser ? (
                        <button
                          type="button"
                          onClick={() => beginEditUserMessage(message)}
                          disabled={isGenerating || isArchiving}
                          aria-label="Edit and resend"
                          title="Edit"
                        >
                          <Pencil size={12} />
                        </button>
                      ) : canRetryFromHere ? (
                        <button
                          type="button"
                          onClick={() => void retryFromAssistantMessage(message)}
                          disabled={isGenerating || isArchiving}
                          aria-label="Retry from here"
                          title="Retry from here"
                        >
                          <RotateCcw size={12} />
                        </button>
                      ) : null}
                    </span>
                    <span>{modeLabel(message.mode as CoCreateMode)} · {formatDate(message.createdAt)}</span>
                  </div>
                  {systemStepsBeforeAssistant.map((step) => {
                    if (step.kind === "reasoning") {
                      const isRunningReasoning = step.authorName?.includes("正在") && isGenerating;
                      return (
                        <details
                          key={step.id}
                          className="cocreate-reasoning-fold cocreate-reasoning-fold-inline"
                          data-running={isRunningReasoning ? "1" : undefined}
                        >
                          <summary>
                            <span>
                              {isRunningReasoning ? <Loader2 size={13} /> : <ChevronDown size={13} />}
                              {step.authorName || "Creative Process"}
                            </span>
                            {isRunningReasoning && (
                              <span className="cocreate-action-dots" aria-hidden="true">
                                <b />
                                <b />
                                <b />
                              </span>
                            )}
                            <time>{formatDate(step.createdAt)}</time>
                          </summary>
                          <CoCreateMarkdown content={step.content} />
                        </details>
                      );
                    }
                    const isRunningTool = step.content.includes("正在执行");
                    return (
                      <article key={step.id} className="cocreate-tool-step cocreate-tool-step-inline" data-running={isRunningTool ? "1" : undefined}>
                        <div className="cocreate-tool-step-head">
                          {isRunningTool ? <Loader2 size={14} /> : <Check size={14} />}
                          <span>{isRunningTool ? "ACTION RUNNING" : "ACTION RESULT"}</span>
                          {isRunningTool && (
                            <span className="cocreate-action-dots" aria-hidden="true">
                              <b />
                              <b />
                              <b />
                            </span>
                          )}
                          <i />
                          <time>{formatDate(step.createdAt)}</time>
                        </div>
                        <CoCreateMarkdown content={step.content} />
                      </article>
                    );
                  })}
                  <CoCreateMarkdown content={message.content} />
                </article>
              );
            })}

            {isGenerating && !sharedSettings.streamingEnabled && (
              <div className="cocreate-thinking">
                <Loader2 size={18} />
                <span>{mode === "write" ? "Writing content" : "Organizing discussion"}</span>
              </div>
            )}
            {isArchiving && (
              <div className="cocreate-thinking">
                <Loader2 size={18} />
                <span>Summarizing session memory</span>
              </div>
            )}
          </section>
        )}

        {view === "characters" && (
          <section className="cocreate-character-panel">
            <div className="cocreate-intel-note">
              <span>[ PARTNER ]</span>
              <p>The co-creation partner uses this character's linked API, presets, world book, user persona, and history memory configured under "Co-Creation".</p>
            </div>
            <div className="cocreate-partner-grid">
              {characters.map((character) => (
                <button
                  type="button"
                  key={character.id}
                  className="cocreate-partner-card"
                  data-active={character.id === session.partnerCharacterId ? "1" : undefined}
                  onClick={() => choosePartner(character.id)}
                >
                  {character.avatar ? <img src={character.avatar} alt="" /> : <span>{character.name.slice(0, 1)}</span>}
                  <strong>{character.name}</strong>
                  <small>{character.tags?.slice(0, 3).join(" / ") || "Untagged"}</small>
                </button>
              ))}
              {characters.length === 0 && (
                <div className="cocreate-empty">No character cards yet. Please create a character in the Characters app first.</div>
              )}
            </div>

            <div className="cocreate-section-title cocreate-section-title-action">
              <div>
                <span>CAST</span>
                <strong>Current Novel Cast</strong>
              </div>
              <button type="button" className="cocreate-mini-action" onClick={openNewCastEditor}>
                <Plus size={13} />
                Add
              </button>
            </div>
            <div className="cocreate-cast-list">
              {session.cast.length === 0 && (
                <div className="cocreate-empty cocreate-empty-cast">This novel has no registered cast yet. Tap "Add" to create a session cast profile; these profiles are passed to the co-creation partner along with chapter context.</div>
              )}
              {session.cast.map((member) => (
                <article key={member.id} className="cocreate-cast-card" style={{ "--cc-accent": member.color } as CSSProperties}>
                  <div className="cocreate-cast-head">
                    <span>{member.nameEn}</span>
                    <strong>{member.name}</strong>
                  </div>
                  <div className="cocreate-cast-meta">
                    <div>
                      <span>ROLE</span>
                      <strong>{member.role}</strong>
                    </div>
                    <div>
                      <span>LABEL</span>
                      <strong>{member.label}</strong>
                    </div>
                    <div>
                      <span>MAJOR</span>
                      <strong>{member.major}</strong>
                    </div>
                  </div>
                  <p>{member.desc}</p>
                  {member.secret ? (
                    member.secretHidden ? (
                      <button type="button" className="cocreate-secret-button" onClick={() => revealSecret(member.id)}>
                        <Lock size={15} />
                        Reveal Hidden Thread
                      </button>
                    ) : (
                      <div className="cocreate-secret">
                        <Eye size={15} />
                        {member.secret}
                      </div>
                    )
                  ) : null}
                  <div className="cocreate-cast-actions">
                    <button type="button" onClick={() => openEditCastEditor(member)}>
                      <Pencil size={14} />
                      Edit
                    </button>
                    <button type="button" onClick={() => setCastDeleteTargetId(member.id)}>
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="cocreate-section-title">
              <span>DOSSIER</span>
              <strong>Character Relationship Dossier</strong>
            </div>
            <div className="cocreate-dossier-links" aria-label="Character and relationship status">
              <div>
                <span>{session.cast.length}</span>
                <strong>Cast Profiles</strong>
              </div>
              <div>
                <span>{session.relationshipDossier?.trim() ? "ON" : "EMPTY"}</span>
                <strong>Relationship Dossier</strong>
              </div>
              <div>
                <span>{hiddenSecretCount}/{hiddenSecretCount + revealedSecretCount}</span>
                <strong>Hidden Threads</strong>
              </div>
            </div>
            <article className="cocreate-memory-card cocreate-dossier-card">
              <span>RELATIONSHIP DOSSIER</span>
              <p>{session.relationshipDossier?.trim() || "There is no character relationship dossier yet. Characters can organize and submit updates via executable actions; once confirmed, they'll be saved here."}</p>
            </article>

            <div className="cocreate-section-title cocreate-section-title-action cocreate-notebook-title">
              <div>
                <span>WRITER NOTEBOOK</span>
                <strong>Writer's Notebook</strong>
              </div>
              <button
                type="button"
                className="cocreate-mini-action"
                onClick={saveWriterNotebook}
                disabled={!writerNotebookDirty}
              >
                <Check size={13} />
                Save
              </button>
            </div>
            <article className="cocreate-memory-card cocreate-notebook-card">
              <span>Injected Every Turn</span>
              <p>AI maintains this work notebook on its own and injects it into every co-creation turn; you can also edit it manually.</p>
              <textarea
                value={writerNotebookDraft}
                onChange={(event) => {
                  setWriterNotebookDraft(event.target.value);
                  setWriterNotebookDirty(true);
                }}
                placeholder="No notes yet. The AI will maintain this here when it needs a stable story outline, foreshadowing, character continuity, core settings, and future plans."
                rows={8}
              />
            </article>
          </section>
        )}

        {view === "chapters" && (
          <section className="cocreate-index-panel">
            <div className="cocreate-section-title cocreate-section-title-action cocreate-chapter-index-title">
              <div>
                <span>CHAPTER INDEX</span>
                <strong>Chapter Index</strong>
              </div>
              <button type="button" className="cocreate-mini-action" onClick={createManualChapter}>
                <Plus size={13} />
                Add Chapter
              </button>
            </div>
            <div className="cocreate-stat-row">
              <div>
                <span>// WORDS</span>
                <strong>{chapterWords.toLocaleString()}</strong>
                <small>Total Words</small>
              </div>
              <div>
                <span>// CHAPTERS</span>
                <strong>{session.chapters.filter((chapter) => Boolean(chapter.archivedAt)).length}/{session.chapters.length}</strong>
                <small>Chapters Done</small>
              </div>
              <div>
                <span>// MEMORY</span>
                <strong>{session.rollingSummary ? "ON" : "READY"}</strong>
                <small>Shared Memory</small>
              </div>
            </div>

            <div className="cocreate-chapter-list">
              {session.chapters.length === 0 && (
                <div className="cocreate-empty">No chapter index yet. Create a chapter first, then start writing~</div>
              )}
              {session.chapters.map((chapter) => (
                <article
                  key={chapter.id}
                  className="cocreate-chapter-row"
                  data-active={chapter.id === session.activeChapterId ? "1" : undefined}
                  onClick={() => persistSession({ ...session, activeChapterId: chapter.id })}
                  role="button"
                  tabIndex={0}
                  aria-current={chapter.id === session.activeChapterId ? "true" : undefined}
                  aria-label={`Set as current chapter: Chapter ${chapter.num}`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      persistSession({ ...session, activeChapterId: chapter.id });
                    }
                  }}
                >
                  <button
                    type="button"
                    className="cocreate-chapter-main"
                    onClick={(event) => {
                      event.stopPropagation();
                      persistSession({ ...session, activeChapterId: chapter.id });
                    }}
                  >
                    <span>{chapter.num}</span>
                    <strong>{chapter.title}</strong>
                    <small>{chapter.titleEn}</small>
                    <em>{chapterStatusLabel(chapter)}</em>
                  </button>
                  <button
                    type="button"
                    className="cocreate-chapter-edit"
                    onClick={(event) => {
                      event.stopPropagation();
                      openChapterReader(chapter);
                    }}
                    aria-label={`Open chapter ${chapter.num}`}
                    title="Read chapter"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="cocreate-chapter-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      setChapterDeleteTargetId(chapter.id);
                    }}
                    aria-label={`Delete chapter ${chapter.num}`}
                    title="Delete chapter"
                  >
                    <Trash2 size={14} />
                  </button>
                </article>
              ))}
            </div>

            {recentRevisions.length > 0 && (
              <section className="cocreate-revision-panel">
                <div className="cocreate-section-title">
                  <span>REVISIONS</span>
                  <strong>Recent Revisions</strong>
                </div>
                <div className="cocreate-revision-list">
                  {recentRevisions.map((revision) => (
                    <article key={revision.id}>
                      <div>
                        <span>{formatShortDate(revision.createdAt)}</span>
                        <strong>{revision.summary}</strong>
                      </div>
                      <button type="button" onClick={() => rollbackRevision(revision.id)} aria-label="Roll back this revision">
                        <RotateCcw size={14} />
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}
            <button type="button" className="cocreate-export-button" onClick={exportManuscriptTxt}>
              <Copy size={14} />
              EXPORT TXT // Export Full Story
            </button>
          </section>
        )}

        {view === "chapterReader" && editingChapter && (
          <section className="cocreate-reader-panel">
            <div
              className="cocreate-reader-masthead"
              data-editing={chapterReaderEditing ? "1" : undefined}
            >
              <span>CHAPTER.{editingChapter.num}</span>
              <h1
                ref={readerTitleRef}
                contentEditable={chapterReaderEditing}
                suppressContentEditableWarning
                data-placeholder="Untitled Chapter"
              >
                {chapterReaderEditing ? null : editingChapter.title}
              </h1>
              <p
                ref={readerTitleEnRef}
                contentEditable={chapterReaderEditing}
                suppressContentEditableWarning
                data-placeholder={`CHAPTER ${editingChapter.num}`}
              >
                {chapterReaderEditing ? null : editingChapter.titleEn}
              </p>
              <i aria-hidden="true" />
            </div>

            {(editingChapter.summary?.trim() || chapterReaderEditing) && (
              <aside
                ref={readerSummaryRef}
                className="cocreate-reader-sticky cocreate-reader-sticky-summary"
                data-editing={chapterReaderEditing ? "1" : undefined}
                data-placeholder="Chapter summary (auto-archive will overwrite)"
                contentEditable={chapterReaderEditing}
                suppressContentEditableWarning
                aria-multiline={chapterReaderEditing ? true : undefined}
                aria-label="Chapter summary"
              >
                {chapterReaderEditing
                  ? null
                  : editingChapter.summary?.trim() ? (
                    <>
                      <span className="cocreate-sticky-label">CHAPTER SUMMARY</span>
                      <CoCreateMarkdown content={editingChapter.summary} />
                    </>
                  ) : null}
              </aside>
            )}

            <article
              ref={readerBodyRef}
              className="cocreate-reader-body"
              data-editing={chapterReaderEditing ? "1" : undefined}
              data-placeholder="This chapter has no content yet. Click the edit button in the top right to start writing."
              contentEditable={chapterReaderEditing}
              suppressContentEditableWarning
              aria-multiline={chapterReaderEditing ? true : undefined}
              aria-label={chapterReaderEditing ? `Editing chapter ${editingChapter.num} content` : `Chapter ${editingChapter.num} content`}
            >
              {chapterReaderEditing
                ? null
                : editingChapter.content?.trim() ? (
                  <CoCreateMarkdown content={editingChapter.content} />
                ) : (
                  <div className="cocreate-reader-empty">
                    <span>EMPTY PAGE</span>
                    <p>This chapter has no content yet. Click the page to start editing.</p>
                  </div>
                )}
            </article>

            {chapterReaderEditing && (
              <div className="cocreate-reader-actions" aria-label="Chapter editing actions">
                <button type="button" onClick={discardChapterReaderEdit} aria-label="Discard changes" title="Discard changes">
                  <X size={18} />
                </button>
                <button type="button" onClick={saveChapterEdit} aria-label="Save changes" title="Save changes">
                  <Check size={18} />
                </button>
              </div>
            )}

            {editingChapter.archiveNote?.trim() && !chapterReaderEditing && (
              <aside className="cocreate-reader-sticky cocreate-reader-sticky-note">
                <span className="cocreate-sticky-label">ARCHIVE NOTE</span>
                <CoCreateMarkdown content={editingChapter.archiveNote} />
              </aside>
            )}
          </section>
        )}
          </>
        )}
      </main>

      {view === "library" && (
        <button
          type="button"
          className="cocreate-floating-new-work"
          onClick={openNewWorkDialog}
          aria-label="Add work"
        >
          <Plus size={19} />
        </button>
      )}

      {view === "write" && (
        <footer className="cocreate-composer">
          <div className="cocreate-mode-toggle" role="group" aria-label="Co-creation mode">
            <button type="button" data-active={mode === "write" ? "1" : undefined} onClick={() => setMode("write")}>
              Manuscript
            </button>
            <button type="button" data-active={mode === "discuss" ? "1" : undefined} onClick={() => setMode("discuss")}>
              Discuss
            </button>
          </div>
          <div className="cocreate-mode-indicator">{mode === "write" ? "// WRITE" : "// CHAT"}</div>
          <div className="cocreate-input-row">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder={mode === "write" ? "Write content, continue, or suggest changes..." : `Chat with ${partner?.name || "your partner"}...`}
              rows={1}
            />
            <button
              type="button"
              className="cocreate-archive-button"
              onClick={() => setArchiveConfirmOpen(true)}
              disabled={!canSummarizeMemory}
              aria-label="Summarize session memory"
              title={`Summarize memory (${sessionMessagesSinceLastSummary} messages since last time)`}
            >
              {isArchiving ? <Loader2 size={16} /> : <Archive size={16} />}
            </button>
            <button
              type="button"
              className={isGenerating ? "cocreate-stop-button" : undefined}
              onClick={() => {
                if (isGenerating) {
                  generationAbortRef.current?.abort();
                } else {
                  void handleSend();
                }
              }}
              disabled={isGenerating ? !generationAbortRef.current : (!input.trim() || isArchiving)}
              aria-label={isGenerating ? "Stop generating" : "Send"}
              title={isGenerating ? "Stop generating" : undefined}
            >
              {isGenerating ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
            </button>
          </div>
        </footer>
      )}

      {view !== "library" && pendingMutations.length > 0 && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-pending-panel" role="dialog" aria-modal="true" aria-labelledby="cocreate-pending-title">
            <div className="cocreate-pending-head">
              <span>PENDING PATCH</span>
              <strong id="cocreate-pending-title">{pendingMutations.length} pending</strong>
            </div>
            <div className="cocreate-pending-list">
              {pendingMutations.map((mutation) => (
                <article key={mutation.id}>
                  <div className="cocreate-pending-item-head">
                    <span>{mutation.toolName}</span>
                    <time>{formatShortDate(mutation.createdAt)}</time>
                  </div>
                  {pendingMutationTargetLabel(mutation) && (
                    <div className="cocreate-pending-target">
                      {pendingMutationTargetLabel(mutation)}
                    </div>
                  )}
                  <p>{mutation.summary}</p>
                  {(mutation.beforePreview || mutation.afterPreview) && (
                    <div className="cocreate-pending-diff">
                      {mutation.beforePreview && (
                        <div className="cocreate-diff-before">
                          <span>BEFORE</span>
                          <p>{mutation.beforePreview}</p>
                        </div>
                      )}
                      {mutation.afterPreview && (
                        <div className="cocreate-diff-after">
                          <span>AFTER</span>
                          <p>{mutation.afterPreview}</p>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="cocreate-pending-actions">
                    <button type="button" onClick={() => rejectPendingMutation(mutation.id)} disabled={isArchiving}>
                      <X size={14} />
                      Cancel
                    </button>
                    <button type="button" onClick={() => confirmPendingMutation(mutation.id)} disabled={isArchiving}>
                      <Check size={14} />
                      Apply Change
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {archiveConfirmOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-archive-title">
            <span>SESSION MEMORY</span>
            <h2 id="cocreate-archive-title">Summarize the last {sessionMessagesSinceLastSummary} messages?</h2>
            <p>
              Compress the {sessionMessagesSinceLastSummary} messages accumulated since the last memory summary into one memory entry, injected into the short-term memory store for future reference.
            </p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setArchiveConfirmOpen(false)}>Cancel</button>
              <button type="button" onClick={() => void handleSummarizeSessionMemory()} disabled={isArchiving || !canSummarizeMemory}>
                {isArchiving ? "Summarizing" : "Confirm Summary"}
              </button>
            </div>
          </section>
        </div>
      )}

      {chapterExitConfirmOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-reader-exit-title">
            <span>UNSAVED EDIT</span>
            <h2 id="cocreate-reader-exit-title">Discard current changes?</h2>
            <p>
              This chapter has unsaved edits. Leaving the page will discard these changes; save first if you want to keep this edit.
            </p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setChapterExitConfirmOpen(false)}>Keep Editing</button>
              <button type="button" className="cocreate-danger-action" onClick={() => leaveChapterReader(chapterExitTarget)}>
                Discard Changes
              </button>
            </div>
          </section>
        </div>
      )}

      {toolHistoryClearConfirmOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-tool-clear-title">
            <span>TOOL HISTORY</span>
            <h2 id="cocreate-tool-clear-title">Clean up tool-call history?</h2>
            <p>This will remove tool-call records and tool-result records in the current work, and clear native tool-call metadata from assistant messages. Normal co-creation content will not be deleted.</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setToolHistoryClearConfirmOpen(false)}>Cancel</button>
              <button type="button" className="cocreate-danger-action" onClick={clearCurrentWorkToolHistory}>
                Clean Up
              </button>
            </div>
          </section>
        </div>
      )}

      {backendLogOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-backend-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-backend-title">
            <div className="cocreate-backend-head">
              <div>
                <span>BACKSTAGE LOG</span>
                <h2 id="cocreate-backend-title">Backend Logs</h2>
                <p>The last {session.backendLogs?.length || 0} generation, archive, error, and raw output entries.</p>
              </div>
              <button type="button" onClick={() => setBackendLogOpen(false)} aria-label="Close backend logs">
                <X size={15} />
              </button>
            </div>
            <button
              type="button"
              className="cocreate-backend-clear-tools"
              disabled={isGenerating || isArchiving || !hasCurrentWorkToolHistory}
              onClick={() => setToolHistoryClearConfirmOpen(true)}
            >
              <strong>Clean up native tool-call history - prevent errors</strong>
              <small>Only cleans up this work's tool calls, tool results, and native replay metadata; normal co-creation content will not be deleted.</small>
            </button>
            <div className="cocreate-backend-list">
              {(!session.backendLogs || session.backendLogs.length === 0) && (
                <div className="cocreate-backend-empty">No backend logs yet. They'll appear here after a generation, archive, or error is triggered.</div>
              )}
              {[...(session.backendLogs || [])].reverse().map((log) => (
                <article key={log.id} className="cocreate-backend-item" data-status={log.status}>
                  <div className="cocreate-backend-item-head">
                    <div>
                      <span>{backendLogKindLabel(log.kind)} · {log.status === "success" ? "SUCCESS" : "ERROR"}</span>
                      <strong>{log.title}</strong>
                    </div>
                    <time>{formatBackendLogTime(log.createdAt)}</time>
                  </div>
                  <div className="cocreate-backend-meta">
                    {log.chapterNum && <span>CH.{log.chapterNum}</span>}
                    {log.mode && <span>{log.mode}</span>}
                    {log.model && <span>{log.model}</span>}
                    {log.presetName && <span>{log.presetName}</span>}
                  </div>
                  {log.error && (
                    <div className="cocreate-backend-copy-block">
                      <button type="button" onClick={() => copyTextToClipboard(log.error || "", onNotice)} aria-label="Copy error message">
                        <Copy size={12} />
                        <span>Copy</span>
                      </button>
                      <pre className="cocreate-backend-error">{log.error}</pre>
                    </div>
                  )}
                  {log.toolNotices && log.toolNotices.length > 0 && (
                    <div className="cocreate-backend-notices">
                      {log.toolNotices.map((notice, index) => <span key={`${log.id}_notice_${index}`}>{notice}</span>)}
                    </div>
                  )}
                  {log.toolDebugs?.map((debug, index) => (
                    <details key={`${log.id}_debug_${index}`}>
                      <summary>
                        Parse Diagnostics {log.toolDebugs && log.toolDebugs.length > 1 ? index + 1 : ""}
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(debug, onNotice); }}>
                          <Copy size={12} />
                          <span>Copy</span>
                        </button>
                      </summary>
                      <pre>{debug}</pre>
                    </details>
                  ))}
                  {log.input && (
                    <details>
                      <summary>
                        User Input
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(log.input || "", onNotice); }}>
                          <Copy size={12} />
                          <span>Copy</span>
                        </button>
                      </summary>
                      <pre>{log.input}</pre>
                    </details>
                  )}
                  {log.rawOutput && (
                    <details>
                      <summary>
                        Raw Output
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(log.rawOutput || "", onNotice); }}>
                          <Copy size={12} />
                          <span>Copy</span>
                        </button>
                      </summary>
                      <pre>{log.rawOutput}</pre>
                    </details>
                  )}
                  {log.rawOutputs?.map((raw, index) => (
                    <details key={`${log.id}_raw_${index}`}>
                      <summary>
                        Raw Output {log.rawOutputs && log.rawOutputs.length > 1 ? index + 1 : ""}
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(raw, onNotice); }}>
                          <Copy size={12} />
                          <span>Copy</span>
                        </button>
                      </summary>
                      <pre>{raw}</pre>
                    </details>
                  ))}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {newWorkOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-work-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-new-work-title">
            <span>NEW WORK</span>
            <h2 id="cocreate-new-work-title">Add Work</h2>
            <p>A work has its own chapters, character profiles, and shared memory. You can rename it in settings after entering.</p>
            <label className="cocreate-text-field">
              <span>Work Name</span>
              <input
                value={newWorkTitle}
                onChange={(event) => setNewWorkTitle(event.target.value)}
                placeholder="e.g. Rainy Night Files"
              />
            </label>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setNewWorkOpen(false)}>Cancel</button>
              <button type="button" onClick={createWork}>Create</button>
            </div>
          </section>
        </div>
      )}

      {editingWork && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-work-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-edit-work-title">
            <span>EDIT WORK</span>
            <h2 id="cocreate-edit-work-title">Edit Work Info</h2>
            <label className="cocreate-text-field">
              <span>Work Name</span>
              <input
                value={editingWorkTitle}
                onChange={(event) => setEditingWorkTitle(event.target.value)}
                placeholder="Work title"
              />
            </label>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setEditingWorkId(null)}>Cancel</button>
              <button type="button" onClick={saveWorkEdit}>Save</button>
            </div>
          </section>
        </div>
      )}

      {workDeleteTarget && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-work-delete-title">
            <span>DELETE WORK</span>
            <h2 id="cocreate-work-delete-title">Delete this work?</h2>
            <p>The chapters, character profiles, and action records of "{workDeleteTarget.title}" will be deleted; the co-creation short-term memory and related long-term memory it wrote will also be cleaned up.</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setWorkDeleteTargetId(null)} disabled={isDeletingWork}>Cancel</button>
              <button type="button" className="cocreate-danger-action" onClick={() => void deleteWork()} disabled={isDeletingWork}>
                {isDeletingWork ? "Deleting" : "Confirm Delete"}
              </button>
            </div>
          </section>
        </div>
      )}

      {chapterDeleteTarget && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-chapter-delete-title">
            <span>DELETE CHAPTER</span>
            <h2 id="cocreate-chapter-delete-title">Delete this chapter?</h2>
            <p>Chapter {chapterDeleteTarget.num} "{chapterDeleteTarget.title}" will be deleted; the corresponding dialogue, revisions, pending changes, and action records will also be removed. Chapter numbers will be automatically re-sequenced afterward.</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setChapterDeleteTargetId(null)}>Cancel</button>
              <button type="button" className="cocreate-danger-action" onClick={() => deleteChapter(chapterDeleteTarget)}>
                Confirm Delete
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-settings-title">
            <div className="cocreate-settings-scroll">
              <span>SETTINGS</span>
              <h2 id="cocreate-settings-title">Co-Creation Global Settings</h2>
              <p>These settings apply to all works. The current chapter is always passed in full; among finished chapters, the most recent N chapters are passed in full text, and earlier chapters only pass title and summary.</p>
              <button
                type="button"
                className="cocreate-setting-toggle"
                data-active={sharedSettings.streamingEnabled ? "1" : undefined}
                aria-pressed={sharedSettings.streamingEnabled}
                onClick={() => setStreamingEnabled(!sharedSettings.streamingEnabled)}
              >
                <span>
                  <strong>Streaming Output</strong>
                  <small>Supported by some APIs; falls back to standard generation automatically when unsupported.</small>
                </span>
                <em>{sharedSettings.streamingEnabled ? "ON" : "OFF"}</em>
              </button>
              <button
                type="button"
                className="cocreate-setting-toggle"
                data-active={sharedSettings.autoAccept ? "1" : undefined}
                aria-pressed={sharedSettings.autoAccept}
                onClick={() => setAutoAccept(!sharedSettings.autoAccept)}
              >
                <span>
                  <strong>Auto-Accept AI Changes</strong>
                  <small>On: AI's additions / edits / deletions take effect immediately (chapter changes can be rolled back). Off: every change enters the pending confirmation queue.</small>
                </span>
                <em>{sharedSettings.autoAccept ? "ON" : "OFF"}</em>
              </button>
              <label className="cocreate-setting-field">
                <span>Pass in the last {sharedSettings.recentFullTextChapters} chapters in full text</span>
                <div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    value={sharedSettings.recentFullTextChapters}
                    onChange={(event) => updateRecentFullTextChapters(Number(event.target.value))}
                    aria-label="Number of recent full-text chapters to pass in"
                  />
                </div>
              </label>
              <label className="cocreate-setting-field">
                <span>Auto-summarize session memory every {sharedSettings.memorySummaryInterval} messages</span>
                <div className="cocreate-setting-field-row">
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={sharedSettings.memorySummaryInterval}
                    onChange={(event) => updateMemorySummaryInterval(Number(event.target.value))}
                    aria-label="Auto-summary interval (message count)"
                  />
                  <button
                    type="button"
                    className="cocreate-setting-inline-button"
                    disabled={!canSummarizeMemory}
                    onClick={() => { setSettingsOpen(false); void handleSummarizeSessionMemory(); }}
                  >
                    Summarize Now
                  </button>
                </div>
                <small className="cocreate-setting-hint">
                  {sessionMessagesSinceLastSummary} messages accumulated since the last summary; reaching the interval triggers it automatically.
                </small>
              </label>
              <div className="cocreate-tool-settings">
                <div className="cocreate-tool-settings-head">
                  <div>
                    <span>ACTIONS</span>
                    <strong>Co-Creation Actions</strong>
                  </div>
                  <em>{enabledToolCount}/{COCREATE_TOOL_DEFINITIONS.length} ON</em>
                </div>
                <div className="cocreate-tool-bulk-actions">
                  <button type="button" onClick={() => setAllToolsEnabled(true)}>Enable All</button>
                  <button type="button" onClick={() => setAllToolsEnabled(false)}>Disable All</button>
                </div>
                <div className="cocreate-tool-toggle-list">
                  {COCREATE_TOOL_DEFINITIONS.map((tool) => {
                    const enabled = !disabledToolSet.has(tool.name);
                    return (
                      <button
                        type="button"
                        key={tool.name}
                        className="cocreate-tool-toggle"
                        data-active={enabled ? "1" : undefined}
                        aria-pressed={enabled}
                        onClick={() => setToolEnabled(tool.name, !enabled)}
                      >
                        <span>
                          <strong>{tool.label}</strong>
                          <small>{tool.category === "read" ? "READ" : "PATCH"}</small>
                        </span>
                        <em>{enabled ? "ON" : "OFF"}</em>
                        <p>{tool.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setSettingsOpen(false)}>Close</button>
              <button type="button" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
          </section>
        </div>
      )}

      {castEditorOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-cast-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-cast-editor-title">
            <span>CAST FILE</span>
            <h2 id="cocreate-cast-editor-title">{editingCast ? "Edit Character Profile" : "Add Character Profile"}</h2>
            <div className="cocreate-cast-form">
              <label>
                <span>Name</span>
                <input
                  value={castForm.name}
                  onChange={(event) => updateCastFormField("name", event.target.value)}
                  placeholder="e.g. He Jinyan"
                />
              </label>
              <label>
                <span>Identity</span>
                <input
                  value={castForm.role}
                  onChange={(event) => updateCastFormField("role", event.target.value)}
                  placeholder="Second Brother // YOUNGER BROTHER"
                />
              </label>
              <label>
                <span>Color</span>
                <div className="cocreate-color-picker" role="group" aria-label="Character color">
                  {CAST_COLOR_SWATCHES.map((color) => (
                    <button
                      type="button"
                      key={color}
                      style={{ "--cc-swatch": color } as CSSProperties}
                      data-active={castForm.color === color ? "1" : undefined}
                      onClick={() => updateCastFormField("color", color)}
                      aria-label={`Select color ${color}`}
                    />
                  ))}
                </div>
              </label>
              <label>
                <span>Location / Background</span>
                <input
                  value={castForm.major}
                  onChange={(event) => updateCastFormField("major", event.target.value)}
                  placeholder="School A // 11th Grade"
                />
              </label>
              <label>
                <span>Character Tag</span>
                <input
                  value={castForm.label}
                  onChange={(event) => updateCastFormField("label", event.target.value)}
                  placeholder="Puppet Out of Control"
                />
              </label>
              <label>
                <span>Public Profile</span>
                <textarea
                  value={castForm.desc}
                  onChange={(event) => updateCastFormField("desc", event.target.value)}
                  placeholder="A character introduction visible to the AI"
                  rows={3}
                />
              </label>
              <label>
                <span>Hidden Thread</span>
                <textarea
                  value={castForm.secret}
                  onChange={(event) => updateCastFormField("secret", event.target.value)}
                  placeholder="Hidden from the AI by default; enters context once revealed"
                  rows={2}
                />
              </label>
              <label className="cocreate-checkbox-field">
                <input
                  type="checkbox"
                  checked={castForm.secretHidden}
                  onChange={(event) => updateCastFormField("secretHidden", event.target.checked)}
                />
                <span>Keep the hidden thread hidden, not passed to the AI</span>
              </label>
            </div>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setCastEditorOpen(false)}>Cancel</button>
              <button type="button" onClick={saveCastForm}>
                {editingCast ? "Save Changes" : "Add Character"}
              </button>
            </div>
          </section>
        </div>
      )}

      {castDeleteTarget && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-cast-delete-title">
            <span>DELETE FILE</span>
            <h2 id="cocreate-cast-delete-title">Delete character profile?</h2>
            <p>This will remove the novel character profile for "{castDeleteTarget.name}" from the current co-creation session, but will not delete your character card.</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setCastDeleteTargetId(null)}>Cancel</button>
              <button type="button" onClick={deleteCastMember}>Confirm Delete</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
