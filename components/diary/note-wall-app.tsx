"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type TextareaHTMLAttributes, type TouchEvent } from "react";
import { Bot, ChevronLeft, Clock3, Flame, MessageCircle, PenLine, RotateCw, Trash2, UserRound, WandSparkles, X } from "lucide-react";
import { CardsThree, DotsThree } from "@phosphor-icons/react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { useAccount } from "@/lib/account-context";
import {
  createNoteWallComment,
  createNoteWallNote,
  deleteNoteWallComment,
  deleteNoteWallNote,
  fetchMyNoteWallComments,
  fetchNoteWall,
  fetchNoteWallComments,
  subscribeNoteWallChanges,
  updateNoteWallNote,
} from "@/lib/notewall-client";
import { generateNoteWallCharacterNote, generateNoteWallCharacterReplies } from "@/lib/notewall-engine";
import { getNoteWallLocalUserId, loadNoteWallTimerSettings, saveNoteWallTimerSettings } from "@/lib/notewall-local";
import { recordNoteWallCommentEvent, recordNoteWallNoteEvent } from "@/lib/notewall-memory";
import {
  DEFAULT_NOTE_WALL_BOARD,
  type NoteWallBoard,
  type NoteWallComment,
  type NoteWallNote,
  type NoteWallSize,
  type NoteWallTimerSettings,
} from "@/lib/notewall-types";
import { findNoteWallPlacement, sanitizeNoteWallCss } from "@/lib/notewall-utils";
import { resolveUserIdentity } from "@/lib/settings-storage";

type NoteWallAppProps = {
  onBack: () => void;
  onNotice?: (message: string) => void;
};

type NoteDraft = {
  id?: string;
  summary: string;
  body: string;
  signature: string;
  size: NoteWallSize;
  paper: string;
  tape: string;
  font: string;
  rawCss: string;
  isAnonymous: boolean;
};

const EMPTY_DRAFT: NoteDraft = {
  summary: "",
  body: "",
  signature: "",
  size: "medium",
  paper: "plain",
  tape: "none",
  font: "default",
  rawCss: "",
  isAnonymous: false,
};

const PAPER_OPTIONS = ["plain", "cream", "pink", "blue", "kraft"];
const TAPE_OPTIONS = ["none", "masking", "stripe", "flower"];
// Font IDs huangyou/shangshangqian are legacy identifiers (already written into user note data and the LLM tool protocol; renaming would break compatibility).
// The actual fonts were long ago swapped for commercially licensed ones: Ximai = "Zizhiqu Ximai Xihuan Ti" (OFL 1.1), Xiaozhitiao = "Honglei Xiaozhitiao Qingchun Ti". See NOTICE.
const FONT_OPTIONS = ["default", "huangyou", "shangshangqian", "huiwen"];
const PAPER_LABELS: Record<string, string> = {
  plain: "Natural",
  cream: "Cream",
  pink: "Pink",
  blue: "Blue",
  kraft: "Kraft",
};
const TAPE_LABELS: Record<string, string> = {
  none: "Clear",
  masking: "Washi",
  stripe: "Stripe",
  flower: "Floral",
};
const FONT_LABELS: Record<string, string> = {
  default: "Default",
  huangyou: "Ximai",
  shangshangqian: "Xiaozhitiao",
  huiwen: "Huiwen",
};
const FONT_FAMILIES: Record<string, string> = {
  huangyou: '"NoteWall Ximai", var(--app-font-family)',
  shangshangqian: '"NoteWall Xiaozhitiao", var(--app-font-family)',
  huiwen: '"NoteWall Huiwen", var(--app-font-family)',
};
const FILTERS = [
  { id: "all", label: "All" },
  { id: "latest", label: "Latest" },
  { id: "hot", label: "Hot" },
  { id: "my", label: "Mine" },
] as const;

type NoteFilter = typeof FILTERS[number]["id"];

type NoteDragState = {
  note: NoteWallNote;
  x: number;
  y: number;
  width: number;
  height: number;
  isOverTrash: boolean;
};

type NoteDragSession = {
  note: NoteWallNote;
  pointerId: number;
  target: HTMLButtonElement;
  startX: number;
  startY: number;
  width: number;
  height: number;
  timer: number | null;
  dragging: boolean;
};

function styleFromSafeStyle(style: Record<string, string>): CSSProperties {
  const result: CSSProperties = {};
  for (const [key, value] of Object.entries(style)) {
    const camel = key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()) as keyof CSSProperties;
    (result as Record<string, string>)[camel as string] = value;
  }
  return result;
}

function fontStyle(font: string): CSSProperties {
  const fontFamily = FONT_FAMILIES[font] ?? "var(--app-font-family)";
  return {
    "--nw-font-family": fontFamily,
    fontFamily,
  } as CSSProperties;
}

function selectReplyCandidateNotes(notes: NoteWallNote[]): NoteWallNote[] {
  const active = notes.filter(note => !note.deletedAt);
  const newestFirst = (a: NoteWallNote, b: NoteWallNote) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  const userNotes = active.filter(note => note.authorType === "user").sort(newestFirst);
  const userNoteIds = new Set(userNotes.map(note => note.id));
  const remaining = active.filter(note => !userNoteIds.has(note.id)).sort(newestFirst);
  return [...userNotes, ...remaining].slice(0, 30);
}

function estimateNoteCardHeight(note: NoteWallNote): number {
  const text = note.summary || note.body || "Note";
  const charsPerLine = note.font === "shangshangqian" ? 7 : 8;
  const lines = text
    .split(/\n+/)
    .reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line.trim() || " ").length / charsPerLine)), 0);
  const lineHeight = note.font === "shangshangqian" ? 24 : 22;
  return 58 + Math.min(lines, 12) * lineHeight;
}

function buildNoteColumns(notes: NoteWallNote[]): [NoteWallNote[], NoteWallNote[]] {
  const columns: [NoteWallNote[], NoteWallNote[]] = [[], []];
  const heights = [0, 0];
  for (const note of notes) {
    const target = heights[0] <= heights[1] ? 0 : 1;
    columns[target].push(note);
    heights[target] += estimateNoteCardHeight(note) + 30;
  }
  return columns;
}

function formatCharacterTimerStatus(settings: NoteWallTimerSettings, characterId: string): string {
  const stamp = settings.lastRunAtByCharacter[characterId];
  return stamp ? `Last ${formatTime(stamp)}` : "Not run yet";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatCardDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatLetterTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function NoteWallApp({ onBack, onNotice }: NoteWallAppProps) {
  const [board, setBoard] = useState<NoteWallBoard>(DEFAULT_NOTE_WALL_BOARD);
  const [notes, setNotes] = useState<NoteWallNote[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [timerSettings, setTimerSettings] = useState<NoteWallTimerSettings>(() => loadNoteWallTimerSettings());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [submittingDraft, setSubmittingDraft] = useState(false);
  const [activeNote, setActiveNote] = useState<NoteWallNote | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generatingCharacterIds, setGeneratingCharacterIds] = useState<string[]>([]);
  const [replyingCharacterIds, setReplyingCharacterIds] = useState<string[]>([]);
  const [noteFilter, setNoteFilter] = useState<NoteFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [noteDrag, setNoteDrag] = useState<NoteDragState | null>(null);
  const [deleteCandidateNote, setDeleteCandidateNote] = useState<NoteWallNote | null>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [mySection, setMySection] = useState<"notes" | "comments">("notes");
  const [myComments, setMyComments] = useState<NoteWallComment[]>([]);
  const [myCommentsLoading, setMyCommentsLoading] = useState(false);
  const [deleteCandidateComment, setDeleteCandidateComment] = useState<NoteWallComment | null>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const timerRunningRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const refreshingRef = useRef(false);
  const pullStartYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const noteStageRef = useRef<HTMLElement | null>(null);
  const noteDragRef = useRef<NoteDragSession | null>(null);
  const noteDragScrollLockRef = useRef<{
    bodyOverflow: string;
    bodyTouchAction: string;
    htmlOverscrollBehavior: string;
    htmlTouchAction: string;
    stage: HTMLElement | null;
    stageOverflow: string;
    stageTouchAction: string;
    stageScrollTop: number;
  } | null>(null);
  const noteDragTouchMoveBlockerRef = useRef<((event: globalThis.TouchEvent) => void) | null>(null);
  const noteTrashRef = useRef<HTMLDivElement>(null);
  const noteDragClickSuppressedRef = useRef(false);

  const actorId = useMemo(() => getNoteWallLocalUserId(), []);
  const { account } = useAccount();
  const accountId = account.id;
  const userIdentity = useMemo(() => resolveUserIdentity(undefined, "diary"), []);
  const userName = userIdentity?.name || "You";
  const ownedCharacterIds = useMemo(() => new Set(characters.map(character => character.id)), [characters]);
  const activeNotes = useMemo(
    () => notes
      .filter(note => !note.deletedAt)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [notes],
  );
  const visibleNotes = useMemo(() => {
    const list = noteFilter === "my"
      ? activeNotes.filter(note => {
        if (note.authorType === "user") return note.authorId === actorId || note.authorId === accountId || note.createdBy === actorId || note.createdBy === accountId;
        return ownedCharacterIds.has(note.authorId) || note.createdBy === actorId || note.createdBy === accountId;
      })
      : [...activeNotes];
    if (noteFilter === "hot") {
      return list.sort((a, b) => {
        const commentDelta = b.commentCount - a.commentCount;
        if (commentDelta !== 0) return commentDelta;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [accountId, activeNotes, actorId, noteFilter, ownedCharacterIds]);
  const noteColumns = useMemo(() => buildNoteColumns(visibleNotes), [visibleNotes]);
  const showMyComments = noteFilter === "my" && mySection === "comments";
  const activeNoteMap = useMemo(() => new Map(activeNotes.map(note => [note.id, note])), [activeNotes]);
  const myCommentGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; comments: NoteWallComment[] }>();
    for (const comment of myComments) {
      if (comment.deletedAt) continue;
      if (!activeNoteMap.has(comment.noteId)) continue;
      const key = ownedCharacterIds.has(comment.authorId) ? comment.authorId : "me";
      const label = key === "me"
        ? userName
        : characters.find(character => character.id === comment.authorId)?.name ?? comment.authorName;
      const group = groups.get(key) ?? { key, label, comments: [] };
      group.comments.push(comment);
      groups.set(key, group);
    }
    const ordered: Array<{ key: string; label: string; comments: NoteWallComment[] }> = [];
    const mine = groups.get("me");
    if (mine) ordered.push(mine);
    for (const character of characters) {
      const group = groups.get(character.id);
      if (group) ordered.push(group);
    }
    return ordered;
  }, [activeNoteMap, characters, myComments, ownedCharacterIds, userName]);

  const refresh = useCallback(async (showIndicator = false) => {
    if (showIndicator) {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshing(true);
      pullDistanceRef.current = 54;
      setPullDistance(54);
    }
    try {
      const data = await fetchNoteWall();
      setBoard(data.board);
      setNotes(data.notes);
      setError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      if (!hasLoadedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
      if (showIndicator) {
        refreshingRef.current = false;
        setRefreshing(false);
        pullDistanceRef.current = 0;
        setPullDistance(0);
      }
    }
  }, []);

  const handleStageTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    if (noteDragRef.current?.dragging) return;
    if (event.currentTarget.scrollTop > 0 || refreshingRef.current) return;
    pullStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleStageTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    if (noteDragRef.current?.dragging) return;
    if (pullStartYRef.current === null) return;
    if (event.currentTarget.scrollTop > 0) {
      pullStartYRef.current = null;
      pullDistanceRef.current = 0;
      setPullDistance(0);
      return;
    }
    const currentY = event.touches[0]?.clientY ?? pullStartYRef.current;
    const delta = currentY - pullStartYRef.current;
    const nextDistance = delta > 0 ? Math.min(72, Math.round(delta * 0.45)) : 0;
    pullDistanceRef.current = nextDistance;
    setPullDistance(nextDistance);
  }, []);

  const loadMyComments = useCallback(async (showIndicator = false) => {
    if (showIndicator) setMyCommentsLoading(true);
    try {
      const list = await fetchMyNoteWallComments();
      setMyComments(list);
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : "Failed to load comments.");
    } finally {
      if (showIndicator) setMyCommentsLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    if (showMyComments) void loadMyComments(true);
  }, [loadMyComments, showMyComments]);

  const handleStageTouchEnd = useCallback(() => {
    if (noteDragRef.current?.dragging) return;
    const shouldRefresh = pullDistanceRef.current >= 48;
    pullStartYRef.current = null;
    if (shouldRefresh) {
      void refresh(true);
      if (showMyComments) void loadMyComments();
      return;
    }
    pullDistanceRef.current = 0;
    setPullDistance(0);
  }, [loadMyComments, refresh, showMyComments]);

  useEffect(() => {
    setCharacters(loadCharacters());
    refresh();
    const unsubscribe = subscribeNoteWallChanges(() => {
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(refresh, 250);
    });
    const poll = window.setInterval(refresh, 30000);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    saveNoteWallTimerSettings(timerSettings);
  }, [timerSettings]);

  useEffect(() => {
    return () => {
      if (noteDragRef.current?.timer) window.clearTimeout(noteDragRef.current.timer);
    };
  }, []);

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  const handleOpenComposer = () => {
    setDraft(EMPTY_DRAFT);
    setComposerOpen(true);
  };

  const handleSubmitDraft = async () => {
    if (submittingDraft) return;
    if (!draft.summary.trim() && !draft.body.trim()) {
      notify("The note needs a summary or body text.");
      return;
    }
    setSubmittingDraft(true);
    if (draft.id) {
      try {
        const updated = await updateNoteWallNote({ ...draft, id: draft.id, size: "medium", actorId });
        setNotes(prev => prev.map(note => note.id === updated.id ? updated : note));
        setActiveNote(updated);
        setComposerOpen(false);
        notify("Note updated.");
      } catch (err) {
        notify(err instanceof Error ? err.message : "Update failed.");
      } finally {
        setSubmittingDraft(false);
      }
      return;
    }
    try {
      const placement = findNoteWallPlacement(notes, board, "medium");
      const signature = draft.signature.trim();
      const created = await createNoteWallNote({
        authorType: "user",
        authorId: actorId,
        authorName: signature || userName,
        summary: draft.summary,
        body: draft.body,
        size: "medium",
        paper: draft.paper,
        tape: draft.tape,
        font: draft.font,
        rawCss: draft.rawCss,
        isAnonymous: draft.isAnonymous,
        x: placement.x,
        y: placement.y,
        actorId,
      });
      setNotes(prev => [...prev, created]);
      setComposerOpen(false);
      refresh();
      notify("Note posted.");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to create note.");
    } finally {
      setSubmittingDraft(false);
    }
  };

  const handleDeleteNote = async (note: NoteWallNote) => {
    if (deletingNoteId) return;
    setDeletingNoteId(note.id);
    try {
      await deleteNoteWallNote(note.id, actorId);
      setNotes(prev => prev.filter(item => item.id !== note.id));
      setActiveNote(null);
      setDeleteCandidateNote(null);
      notify("Note deleted.");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingNoteId(null);
    }
  };

  const handleDeleteComment = async (comment: NoteWallComment) => {
    if (deletingCommentId) return;
    setDeletingCommentId(comment.id);
    try {
      await deleteNoteWallComment(comment.id, actorId);
      setMyComments(prev => prev.filter(item => item.id !== comment.id));
      setDeleteCandidateComment(null);
      notify("Comment deleted.");
      void refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingCommentId(null);
    }
  };

  const clearNoteDragTimer = useCallback(() => {
    if (noteDragRef.current?.timer) {
      window.clearTimeout(noteDragRef.current.timer);
      noteDragRef.current.timer = null;
    }
  }, []);

  const lockNoteDragScroll = useCallback(() => {
    if (noteDragScrollLockRef.current || typeof document === "undefined") return;
    const stage = noteStageRef.current;
    noteDragScrollLockRef.current = {
      bodyOverflow: document.body.style.overflow,
      bodyTouchAction: document.body.style.touchAction,
      htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
      htmlTouchAction: document.documentElement.style.touchAction,
      stage,
      stageOverflow: stage?.style.overflow ?? "",
      stageTouchAction: stage?.style.touchAction ?? "",
      stageScrollTop: stage?.scrollTop ?? 0,
    };
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overscrollBehavior = "none";
    document.documentElement.style.touchAction = "none";
    if (!noteDragTouchMoveBlockerRef.current) {
      noteDragTouchMoveBlockerRef.current = (event: globalThis.TouchEvent) => {
        event.preventDefault();
      };
      document.addEventListener("touchmove", noteDragTouchMoveBlockerRef.current, { capture: true, passive: false });
    }
    if (stage) {
      stage.style.overflow = "hidden";
      stage.style.touchAction = "none";
    }
  }, []);

  const unlockNoteDragScroll = useCallback(() => {
    const lock = noteDragScrollLockRef.current;
    if (!lock || typeof document === "undefined") return;
    document.body.style.overflow = lock.bodyOverflow;
    document.body.style.touchAction = lock.bodyTouchAction;
    document.documentElement.style.overscrollBehavior = lock.htmlOverscrollBehavior;
    document.documentElement.style.touchAction = lock.htmlTouchAction;
    if (noteDragTouchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", noteDragTouchMoveBlockerRef.current, { capture: true });
      noteDragTouchMoveBlockerRef.current = null;
    }
    if (lock.stage) {
      lock.stage.style.overflow = lock.stageOverflow;
      lock.stage.style.touchAction = lock.stageTouchAction;
      lock.stage.scrollTop = lock.stageScrollTop;
    }
    noteDragScrollLockRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      unlockNoteDragScroll();
    };
  }, [unlockNoteDragScroll]);

  const isNoteOverTrash = useCallback((clientX: number, clientY: number, width: number, height: number) => {
    const trashRect = noteTrashRef.current?.getBoundingClientRect();
    if (!trashRect) return false;
    const noteRect = {
      left: clientX - width / 2,
      right: clientX + width / 2,
      top: clientY - height / 2,
      bottom: clientY + height / 2,
    };
    return noteRect.left < trashRect.right
      && noteRect.right > trashRect.left
      && noteRect.top < trashRect.bottom
      && noteRect.bottom > trashRect.top;
  }, []);

  const resetNoteDrag = useCallback(() => {
    clearNoteDragTimer();
    const session = noteDragRef.current;
    if (session?.dragging) {
      noteDragClickSuppressedRef.current = true;
      window.setTimeout(() => {
        noteDragClickSuppressedRef.current = false;
      }, 120);
    }
    if (session) {
      try {
        session.target.releasePointerCapture(session.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    noteDragRef.current = null;
    setNoteDrag(null);
    unlockNoteDragScroll();
  }, [clearNoteDragTimer, unlockNoteDragScroll]);

  const updateNoteDragPosition = useCallback((clientX: number, clientY: number) => {
    const session = noteDragRef.current;
    if (!session?.dragging) return;
    const lock = noteDragScrollLockRef.current;
    if (lock?.stage) lock.stage.scrollTop = lock.stageScrollTop;
    const isOverTrash = isNoteOverTrash(clientX, clientY, session.width, session.height);
    setNoteDrag({
      note: session.note,
      x: clientX,
      y: clientY,
      width: session.width,
      height: session.height,
      isOverTrash,
    });
  }, [isNoteOverTrash]);

  const finishNoteDrag = useCallback((clientX: number, clientY: number) => {
    const session = noteDragRef.current;
    if (!session) return;
    const shouldDelete = noteFilter === "my" && session.dragging && isNoteOverTrash(clientX, clientY, session.width, session.height);
    const note = session.note;
    resetNoteDrag();
    if (shouldDelete) {
      setDeleteCandidateNote(note);
    }
  }, [isNoteOverTrash, noteFilter, resetNoteDrag]);

  useEffect(() => {
    if (!noteDrag) return;
    const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
      const session = noteDragRef.current;
      if (!session?.dragging || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateNoteDragPosition(event.clientX, event.clientY);
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent) => {
      const session = noteDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      finishNoteDrag(event.clientX, event.clientY);
    };
    const handleWindowPointerCancel = (event: globalThis.PointerEvent) => {
      const session = noteDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      resetNoteDrag();
    };
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [finishNoteDrag, noteDrag, resetNoteDrag, updateNoteDragPosition]);

  const handleNotePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, note: NoteWallNote) => {
    if (noteFilter !== "my") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearNoteDragTimer();
    const rect = event.currentTarget.getBoundingClientRect();
    const target = event.currentTarget;
    noteDragRef.current = {
      note,
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      timer: window.setTimeout(() => {
        const session = noteDragRef.current;
        if (!session || session.pointerId !== event.pointerId || session.dragging) return;
        session.dragging = true;
        session.timer = null;
        pullStartYRef.current = null;
        pullDistanceRef.current = 0;
        setPullDistance(0);
        lockNoteDragScroll();
        try {
          session.target.setPointerCapture(session.pointerId);
        } catch {
          // Some touch browsers release capture during native gestures.
        }
        setNoteDrag({
          note: session.note,
          x: event.clientX,
          y: event.clientY,
          width: session.width,
          height: session.height,
          isOverTrash: isNoteOverTrash(event.clientX, event.clientY, session.width, session.height),
        });
      }, 430),
      dragging: false,
    };
  }, [clearNoteDragTimer, isNoteOverTrash, lockNoteDragScroll, noteFilter]);

  const handleNotePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = noteDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragging) {
      if (Math.hypot(dx, dy) > 8) {
        clearNoteDragTimer();
        noteDragRef.current = null;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateNoteDragPosition(event.clientX, event.clientY);
  }, [clearNoteDragTimer, updateNoteDragPosition]);

  const handleNotePointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = noteDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishNoteDrag(event.clientX, event.clientY);
  }, [finishNoteDrag]);

  const handleNotePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = noteDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resetNoteDrag();
  }, [resetNoteDrag]);

  const handleNotePointerLeave = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = noteDragRef.current;
    if (!session || session.pointerId !== event.pointerId || session.dragging) return;
    clearNoteDragTimer();
    noteDragRef.current = null;
  }, [clearNoteDragTimer]);

  const updateTimer = (next: NoteWallTimerSettings) => {
    setTimerSettings(next);
  };

  const handleGenerateForCharacters = useCallback(async (characterIds: string[], trigger: "manual" | "timer" = "manual") => {
    const uniqueIds = Array.from(new Set(characterIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const storedCharacters = loadCharacters();
    const targets = uniqueIds
      .map(characterId => characters.find(item => item.id === characterId) ?? storedCharacters.find(item => item.id === characterId))
      .filter(Boolean) as Character[];
    if (targets.length === 0) {
      notify("Character not found.");
      return;
    }
    const targetIds = targets.map(character => character.id);
    setGeneratingCharacterIds(prev => Array.from(new Set([...prev, ...targetIds])));
    try {
      const latest = await fetchNoteWall().catch(() => ({ board, notes }));
      const generatedResults = await Promise.all(targets.map(async character => {
        try {
          return {
            status: "fulfilled" as const,
            character,
            generated: await generateNoteWallCharacterNote(character.id, latest.notes, trigger),
          };
        } catch {
          return { status: "rejected" as const, character };
        }
      }));
      const placementNotes = [...latest.notes];
      const createdNotes: NoteWallNote[] = [];
      const failedNames: string[] = [];

      for (const result of generatedResults) {
        if (result.status === "rejected") {
          failedNames.push(result.character.name);
          continue;
        }
        const { character, generated } = result;
        try {
          const placement = findNoteWallPlacement(placementNotes, latest.board, generated.size);
          const created = await createNoteWallNote({
            authorType: "character",
            authorId: character.id,
            authorName: generated.authorName || character.name,
            summary: generated.summary,
            body: generated.body,
            size: generated.size,
            paper: generated.paper,
            tape: generated.tape,
            font: generated.font,
            rawCss: generated.rawCss,
            isAnonymous: generated.isAnonymous,
            x: placement.x,
            y: placement.y,
            actorId,
          });
          recordNoteWallNoteEvent({
            characterId: character.id,
            characterName: character.name,
            note: created,
          });
          placementNotes.push(created);
          createdNotes.push(created);
        } catch {
          failedNames.push(character.name);
        }
      }

      if (createdNotes.length > 0) {
        setNotes(prev => {
          const existing = new Set(prev.map(note => note.id));
          return [...prev, ...createdNotes.filter(note => !existing.has(note.id))];
        });
        await refresh();
      }

      if (createdNotes.length === 1 && failedNames.length === 0) {
        const characterName = targets.find(character => character.id === createdNotes[0]?.authorId)?.name ?? createdNotes[0]?.authorName ?? "Character";
        notify(`${characterName} posted a note.`);
      } else if (createdNotes.length > 0) {
        notify(`${createdNotes.length} character(s) posted notes${failedNames.length ? `, ${failedNames.length} failed` : ""}.`);
      } else {
        notify(failedNames.length ? `Failed to generate character notes: ${failedNames.join(", ")}` : "Failed to generate character notes.");
      }
    } finally {
      setGeneratingCharacterIds(prev => prev.filter(id => !targetIds.includes(id)));
    }
  }, [actorId, board, characters, notes, notify, refresh]);

  const handleGenerateForCharacter = useCallback(async (characterId: string, trigger: "manual" | "timer" = "manual") => {
    await handleGenerateForCharacters([characterId], trigger);
  }, [handleGenerateForCharacters]);

  const handleReplyForCharacters = useCallback(async (characterIds: string[]) => {
    const uniqueIds = Array.from(new Set(characterIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const storedCharacters = loadCharacters();
    const targets = uniqueIds
      .map(characterId => characters.find(item => item.id === characterId) ?? storedCharacters.find(item => item.id === characterId))
      .filter(Boolean) as Character[];
    if (targets.length === 0) {
      notify("Character not found.");
      return;
    }
    const targetIds = targets.map(character => character.id);
    setReplyingCharacterIds(prev => Array.from(new Set([...prev, ...targetIds])));
    try {
      const latest = await fetchNoteWall().catch(() => ({ board, notes }));
      const candidateNotes = selectReplyCandidateNotes(latest.notes);
      if (candidateNotes.length === 0) {
        notify("No notes available to reply to right now.");
        return;
      }
      const candidates = await Promise.all(candidateNotes.map(async note => ({
        note,
        comments: await fetchNoteWallComments(note.id).catch(() => []),
      })));
      const replyResults = await Promise.all(targets.map(async character => {
        try {
          return {
            status: "fulfilled" as const,
            character,
            replies: await generateNoteWallCharacterReplies(character.id, candidates),
          };
        } catch {
          return { status: "rejected" as const, character };
        }
      }));

      let repliedCharacterCount = 0;
      let createdCommentCount = 0;
      const failedNames: string[] = [];

      for (const result of replyResults) {
        if (result.status === "rejected") {
          failedNames.push(result.character.name);
          continue;
        }
        if (result.replies.length === 0) continue;
        const createdResults = await Promise.allSettled(result.replies.map(reply => createNoteWallComment({
          noteId: reply.noteId,
          authorType: "character",
          authorId: result.character.id,
          authorName: reply.authorName || result.character.name,
          body: reply.body,
          isAnonymous: reply.isAnonymous,
          actorId,
        })));
        const createdCount = createdResults.filter(item => item.status === "fulfilled").length;
        for (const createdResult of createdResults) {
          if (createdResult.status !== "fulfilled") continue;
          recordNoteWallCommentEvent({
            characterId: result.character.id,
            characterName: result.character.name,
            comment: createdResult.value,
          });
        }
        if (createdCount > 0) {
          repliedCharacterCount += 1;
          createdCommentCount += createdCount;
        } else {
          failedNames.push(result.character.name);
        }
      }

      if (createdCommentCount > 0) await refresh();

      if (targets.length === 1 && createdCommentCount > 0 && failedNames.length === 0) {
        notify(`${targets[0].name} replied to ${createdCommentCount} note(s).`);
      } else if (createdCommentCount > 0) {
        notify(`${repliedCharacterCount} character(s) replied to ${createdCommentCount} note(s)${failedNames.length ? `, ${failedNames.length} failed` : ""}.`);
      } else if (failedNames.length > 0) {
        notify(`Failed to generate character replies: ${failedNames.join(", ")}`);
      } else {
        notify("No comments were generated this time.");
      }
    } finally {
      setReplyingCharacterIds(prev => prev.filter(id => !targetIds.includes(id)));
    }
  }, [actorId, board, characters, notes, notify, refresh]);

  const handleReplyForCharacter = useCallback(async (characterId: string) => {
    await handleReplyForCharacters([characterId]);
  }, [handleReplyForCharacters]);

  const checkDueTimers = useCallback(async () => {
    const scheduledCharacters = characters.length > 0 ? characters : loadCharacters();
    const characterIds = scheduledCharacters.map(character => character.id).filter(Boolean);
    if (timerRunningRef.current || characterIds.length === 0) return;
    if (!timerSettings.enabled) return;
    timerRunningRef.current = true;
    try {
      const now = Date.now();
      for (const characterId of characterIds) {
        const last = timerSettings.lastRunAtByCharacter[characterId];
        const lastTime = last ? new Date(last).getTime() : 0;
        const due = !lastTime || now - lastTime >= timerSettings.intervalMinutes * 60 * 1000;
        if (due) {
          await handleGenerateForCharacter(characterId, "timer");
          await handleReplyForCharacter(characterId);
          const stamp = new Date().toISOString();
          setTimerSettings(prev => ({
            ...prev,
            lastRunAtByCharacter: { ...prev.lastRunAtByCharacter, [characterId]: stamp },
          }));
        }
      }
    } finally {
      timerRunningRef.current = false;
    }
  }, [characters, handleGenerateForCharacter, handleReplyForCharacter, timerSettings]);

  useEffect(() => {
    const timer = window.setInterval(checkDueTimers, 60000);
    if (!loading) checkDueTimers();
    return () => window.clearInterval(timer);
  }, [checkDueTimers, loading]);

  return (
    <section className={`note-wall-app ${noteDrag ? "is-note-dragging" : ""}`}>
      <header className="note-wall-header">
        <button type="button" className="page-back-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={24} strokeWidth={1.5} />
        </button>
        <div className="note-wall-title">
          <h1>Note Wall</h1>
        </div>
        <div className="note-wall-actions">
          <button type="button" className="note-wall-menu-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <DotsThree size={28} weight="bold" />
          </button>
        </div>
      </header>

      {error ? (
        <div className="note-wall-error">
          <strong>Note Wall is currently unavailable</strong>
          <p>{error === "missing_supabase_env" ? "Supabase environment variables need to be configured and the setup SQL run." : error}</p>
        </div>
      ) : null}

      <main
        ref={noteStageRef}
        className="note-card-stage"
        style={{ "--pull-distance": `${pullDistance}px` } as CSSProperties}
        onTouchStart={handleStageTouchStart}
        onTouchMove={handleStageTouchMove}
        onTouchEnd={handleStageTouchEnd}
        onTouchCancel={handleStageTouchEnd}
      >
        <div
          className={`note-wall-refresh-indicator ${pullDistance > 0 || refreshing ? "is-visible" : ""} ${refreshing ? "is-refreshing" : ""}`}
          aria-hidden={pullDistance <= 0 && !refreshing}
        >
          <span><RotateCw size={18} strokeWidth={1.8} /></span>
        </div>
        {noteFilter === "my" ? (
          <div className="note-wall-my-toggle" role="tablist" aria-label="My content" data-active-index={mySection === "comments" ? 1 : 0}>
            <button
              type="button"
              role="tab"
              aria-selected={mySection === "notes"}
              className={mySection === "notes" ? "is-active" : ""}
              onClick={() => setMySection("notes")}
            >
              Notes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mySection === "comments"}
              className={mySection === "comments" ? "is-active" : ""}
              onClick={() => setMySection("comments")}
            >
              Comments
            </button>
          </div>
        ) : null}
        {showMyComments ? (
          <>
            {myCommentsLoading ? (
              <div className="note-card-loading" role="status" aria-live="polite">
                <span className="note-card-loading-spinner" aria-hidden="true" />
                <span>Loading comments</span>
              </div>
            ) : null}
            {!myCommentsLoading && myCommentGroups.length === 0 ? <div className="note-card-empty">No comments yet</div> : null}
            <div className="nw-my-comments" aria-live="polite">
              {myCommentGroups.map(group => (
                <section className="nw-my-comment-group" key={group.key}>
                  <header>
                    <strong>{group.label}</strong>
                    <span>{group.comments.length}</span>
                  </header>
                  <div className="nw-my-comment-list">
                    {group.comments.map(comment => {
                      const sourceNote = activeNoteMap.get(comment.noteId);
                      if (!sourceNote) return null;
                      return (
                        <article key={comment.id} className="nw-my-comment-item">
                          <button
                            type="button"
                            className="nw-my-comment-main"
                            onClick={() => setActiveNote(sourceNote)}
                          >
                            <p>{comment.body}</p>
                            <span className="nw-my-comment-source">From note: {sourceNote.summary || sourceNote.body || "Note"}</span>
                            <span className="nw-my-comment-meta">
                              {comment.isAnonymous ? <em>Anonymous</em> : null}
                              <time>{formatTime(comment.createdAt)}</time>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="nw-my-comment-delete"
                            aria-label="Delete comment"
                            onClick={() => setDeleteCandidateComment(comment)}
                          >
                            <Trash2 size={16} strokeWidth={1.8} />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </>
        ) : (
          <>
            {loading ? (
              <div className="note-card-loading" role="status" aria-live="polite">
                <span className="note-card-loading-spinner" aria-hidden="true" />
                <span>Loading note wall</span>
                <span className="note-card-loading-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : null}
            {!loading && visibleNotes.length === 0 ? <div className="note-card-empty">{noteFilter === "my" ? "You have no notes yet" : "No notes yet"}</div> : null}
            <div className="note-card-grid" aria-live="polite">
              {noteColumns.map((column, columnIndex) => (
                <div className="note-card-column" key={columnIndex}>
                  {column.map(note => (
                    <button
                      key={note.id}
                      type="button"
                      className={`note-card ${noteDrag?.note.id === note.id ? "is-drag-source" : ""}`}
                      data-paper={note.paper}
                      data-tape={note.tape}
                      data-font={note.font}
                      style={fontStyle(note.font)}
                      onPointerDown={(event) => handleNotePointerDown(event, note)}
                      onPointerMove={handleNotePointerMove}
                      onPointerUp={handleNotePointerUp}
                      onPointerCancel={handleNotePointerCancel}
                      onPointerLeave={handleNotePointerLeave}
                      onContextMenu={event => {
                        if (noteFilter === "my") event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (noteDragClickSuppressedRef.current) {
                          event.preventDefault();
                          return;
                        }
                        setActiveNote(note);
                      }}
                    >
                      <NoteCardContent note={note} />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      <div
        ref={noteTrashRef}
        className={`note-wall-trash-bin ${noteDrag ? "is-visible" : ""} ${noteDrag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!noteDrag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {noteDrag ? (
        <div
          className="note-card note-card-drag-ghost"
          data-paper={noteDrag.note.paper}
          data-tape={noteDrag.note.tape}
          data-font={noteDrag.note.font}
          style={{
            ...fontStyle(noteDrag.note.font),
            left: noteDrag.x,
            top: noteDrag.y,
            width: noteDrag.width,
            minHeight: noteDrag.height,
          }}
        >
          <NoteCardContent note={noteDrag.note} />
        </div>
      ) : null}

      <button type="button" className="note-wall-compose-fab" onClick={handleOpenComposer} aria-label="Write note">
        <PenLine size={22} strokeWidth={1.8} />
      </button>

      <nav
        className="note-wall-tabbar"
        aria-label="Note filter"
        data-active-index={Math.max(0, FILTERS.findIndex(item => item.id === noteFilter))}
      >
        {FILTERS.map(item => (
          <button
            key={item.id}
            type="button"
            className={noteFilter === item.id ? "is-active" : ""}
            aria-pressed={noteFilter === item.id}
            onClick={() => setNoteFilter(item.id)}
          >
            <span className="note-wall-tabbar-icon">
              {item.id === "all" ? <CardsThree size={22} weight="regular" /> : null}
              {item.id === "latest" ? <Clock3 size={22} strokeWidth={1.8} /> : null}
              {item.id === "hot" ? <Flame size={22} strokeWidth={1.8} /> : null}
              {item.id === "my" ? <UserRound size={22} strokeWidth={1.8} /> : null}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {composerOpen ? (
        <NoteComposer
          draft={draft}
          userName={userName}
          submitting={submittingDraft}
          onChange={setDraft}
          onClose={() => setComposerOpen(false)}
          onSubmit={handleSubmitDraft}
        />
      ) : null}

      {activeNote ? (
        <NoteDetail
          note={activeNote}
          actorId={actorId}
          userName={userName}
          onNotice={notify}
          onClose={() => setActiveNote(null)}
        />
      ) : null}

      {deleteCandidateNote ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deletingNoteId) setDeleteCandidateNote(null);
          }}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2>Delete Note</h2>
            <p>This note will be removed from the note wall.</p>
            <div>
              <button type="button" className="nw-secondary-btn" disabled={!!deletingNoteId} onClick={() => setDeleteCandidateNote(null)}>Cancel</button>
              <button
                type="button"
                className={`nw-danger-btn ${deletingNoteId === deleteCandidateNote.id ? "is-loading" : ""}`}
                disabled={!!deletingNoteId}
                aria-busy={deletingNoteId === deleteCandidateNote.id}
                onClick={() => handleDeleteNote(deleteCandidateNote)}
              >
                <span className="note-wall-primary-content">
                  {deletingNoteId === deleteCandidateNote.id ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
                  <span>{deletingNoteId === deleteCandidateNote.id ? "Deleting" : "Delete"}</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteCandidateComment ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deletingCommentId) setDeleteCandidateComment(null);
          }}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2>Delete Comment</h2>
            <p>This comment will be removed from the note.</p>
            <div>
              <button type="button" className="nw-secondary-btn" disabled={!!deletingCommentId} onClick={() => setDeleteCandidateComment(null)}>Cancel</button>
              <button
                type="button"
                className={`nw-danger-btn ${deletingCommentId === deleteCandidateComment.id ? "is-loading" : ""}`}
                disabled={!!deletingCommentId}
                aria-busy={deletingCommentId === deleteCandidateComment.id}
                onClick={() => handleDeleteComment(deleteCandidateComment)}
              >
                <span className="note-wall-primary-content">
                  {deletingCommentId === deleteCandidateComment.id ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
                  <span>{deletingCommentId === deleteCandidateComment.id ? "Deleting" : "Delete"}</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <TimerSettingsPanel
          characters={characters}
          settings={timerSettings}
          generatingCharacterIds={generatingCharacterIds}
          replyingCharacterIds={replyingCharacterIds}
          onChange={updateTimer}
          onGenerateMany={handleGenerateForCharacters}
          onReplyMany={handleReplyForCharacters}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </section>
  );
}

function NoteCardContent({ note }: { note: NoteWallNote }) {
  return (
    <>
      <span className="note-card-pin" />
      <span className="note-card-copy" style={{ ...styleFromSafeStyle(note.safeStyle), ...fontStyle(note.font) }}>
        <strong>{note.summary}</strong>
        {note.body ? <span>{note.body}</span> : null}
      </span>
      <span className="note-card-meta">
        <span>{note.authorName}</span>
        <time>{formatCardDate(note.createdAt)}</time>
      </span>
    </>
  );
}

function SegmentedOptions({ label, value, options, labels, onChange }: {
  label: string;
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="nw-field">
      <span>{label}</span>
      <div className="nw-segments">
        {options.map(option => (
          <button
            key={option}
            type="button"
            className={value === option ? "is-active" : ""}
            onClick={() => onChange(option)}
          >
            {labels?.[option] ?? option}
          </button>
        ))}
      </div>
    </label>
  );
}

type AutoResizeTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  value: string;
  minHeight?: number;
  emptyMinHeight?: number;
};

function AutoResizeTextarea({ className, emptyMinHeight, minHeight = 44, onChange, style, value, ...props }: AutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const effectiveMinHeight = value ? minHeight : emptyMinHeight ?? minHeight;

  const resize = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    const baseHeight = node.value ? minHeight : emptyMinHeight ?? minHeight;
    node.style.height = "auto";
    node.style.height = `${Math.max(baseHeight, node.scrollHeight)}px`;
  }, [emptyMinHeight, minHeight]);

  useEffect(() => {
    resize(textareaRef.current);
  }, [resize, value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      className={`nw-auto-textarea${className ? ` ${className}` : ""}`}
      value={value}
      onChange={event => {
        onChange?.(event);
        resize(event.currentTarget);
      }}
      style={{ ...style, minHeight: effectiveMinHeight }}
    />
  );
}

function NoteComposer({ draft, userName, submitting, onChange, onClose, onSubmit }: {
  draft: NoteDraft;
  userName: string;
  submitting: boolean;
  onChange: (draft: NoteDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const previewStyle = styleFromSafeStyle(sanitizeNoteWallCss(draft.rawCss));
  const previewAuthorName = draft.isAnonymous ? "Anonymous" : draft.signature.trim() || userName;
  const previewDate = formatCardDate(new Date().toISOString());

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true">
      <section className="nw-composer">
        <header>
          <h2>{draft.id ? "Edit Note" : "Write New Note"}</h2>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="nw-composer-body">
          <div className="nw-form">
            <label className="nw-field nw-text-field">
              <span>Title</span>
              <AutoResizeTextarea
                className="nw-summary-input"
                value={draft.summary}
                maxLength={80}
                minHeight={28}
                rows={1}
                onChange={event => onChange({ ...draft, summary: event.target.value })}
              />
            </label>
            <label className="nw-field nw-text-field">
              <span>Body</span>
              <AutoResizeTextarea
                className="nw-body-input"
                value={draft.body}
                maxLength={5000}
                minHeight={28}
                rows={1}
                onChange={event => onChange({ ...draft, body: event.target.value })}
              />
            </label>
            {!draft.id ? (
              <div className="nw-field nw-signature-field">
                <label className="nw-signature-input">
                  <span>Signature</span>
                  <input
                    value={draft.signature}
                    maxLength={40}
                    placeholder={userName}
                    disabled={draft.isAnonymous}
                    onChange={event => onChange({ ...draft, signature: event.target.value })}
                  />
                </label>
                <label className="nw-switch-row nw-signature-switch">
                  <span>Post anonymously</span>
                  <input
                    type="checkbox"
                    checked={draft.isAnonymous}
                    onChange={event => onChange({ ...draft, isAnonymous: event.target.checked })}
                  />
                  <span className="nw-switch-track" aria-hidden="true">
                    <span className="nw-switch-thumb" />
                  </span>
                </label>
              </div>
            ) : null}
            <SegmentedOptions label="Paper" value={draft.paper} options={PAPER_OPTIONS} labels={PAPER_LABELS} onChange={value => onChange({ ...draft, paper: value })} />
            <SegmentedOptions label="Tape" value={draft.tape} options={TAPE_OPTIONS} labels={TAPE_LABELS} onChange={value => onChange({ ...draft, tape: value })} />
            <SegmentedOptions label="Font" value={draft.font} options={FONT_OPTIONS} labels={FONT_LABELS} onChange={value => onChange({ ...draft, font: value })} />
            <label className="nw-field nw-text-field">
              <span>Custom CSS</span>
              <AutoResizeTextarea
                className="nw-css-input"
                value={draft.rawCss}
                emptyMinHeight={42}
                minHeight={28}
                rows={1}
                placeholder={"font-size: calc(16px*var(--app-text-scale,1)); color: #3f342b;\nbackground-color: #fff8d7;"}
                onChange={event => onChange({ ...draft, rawCss: event.target.value })}
              />
            </label>
          </div>
          <aside className="nw-preview">
            <div
              className="note-card note-card-preview"
              data-paper={draft.paper}
              data-tape={draft.tape}
              data-font={draft.font}
              style={fontStyle(draft.font)}
            >
              <span className="note-card-pin" />
              <span className="note-card-copy" style={{ ...previewStyle, ...fontStyle(draft.font) }}>
                <strong>{draft.summary || "Title"}</strong>
                <span>{draft.body || "Body"}</span>
              </span>
              <span className="note-card-meta">
                <span>{previewAuthorName}</span>
                <time>{previewDate}</time>
              </span>
            </div>
          </aside>
        </div>
        <footer>
          <button type="button" className="nw-secondary-btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            type="button"
            className={`note-wall-primary-btn ${submitting ? "is-loading" : ""}`}
            onClick={onSubmit}
            disabled={submitting}
            aria-busy={submitting}
          >
            <span className="note-wall-primary-content">
              {submitting ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
              <span>{submitting ? "Posting" : draft.id ? "Save" : "Post to Note Wall"}</span>
            </span>
          </button>
        </footer>
      </section>
    </div>
  );
}

function NoteDetail({ note, actorId, userName, onNotice, onClose }: {
  note: NoteWallNote;
  actorId: string;
  userName: string;
  onNotice: (message: string) => void;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<NoteWallComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [commentAnonymous, setCommentAnonymous] = useState(false);
  const [submittingComment, setSubmittingComment] = useState(false);
  const commentRefreshRef = useRef<number | null>(null);

  const loadComments = useCallback(async () => {
    try {
      const nextComments = await fetchNoteWallComments(note.id);
      setComments(nextComments);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Failed to load comments.");
    }
  }, [note.id, onNotice]);

  useEffect(() => {
    setComments([]);
    setCommentBody("");
    setCommentAnonymous(false);
    loadComments();
    const unsubscribe = subscribeNoteWallChanges(() => {
      if (commentRefreshRef.current) window.clearTimeout(commentRefreshRef.current);
      commentRefreshRef.current = window.setTimeout(loadComments, 250);
    });
    return () => {
      unsubscribe();
      if (commentRefreshRef.current) window.clearTimeout(commentRefreshRef.current);
    };
  }, [loadComments]);

  const handleSubmitComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = commentBody.trim();
    if (!body || submittingComment) return;
    setSubmittingComment(true);
    try {
      const created = await createNoteWallComment({
        noteId: note.id,
        authorType: "user",
        authorId: actorId,
        authorName: userName,
        body,
        isAnonymous: commentAnonymous,
        actorId,
      });
      setComments(prev => prev.some(comment => comment.id === created.id) ? prev : [...prev, created]);
      setCommentBody("");
      onNotice("Comment posted.");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Failed to post comment.");
    } finally {
      setSubmittingComment(false);
    }
  };
  const hasComments = comments.length > 0;

  return (
    <div className="nw-modal-backdrop nw-detail-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <article className="nw-detail" data-font={note.font} style={fontStyle(note.font)} onClick={event => event.stopPropagation()}>
        <header>
          <span>{note.authorType === "character" ? "Character Note" : "User Note"}</span>
          <button type="button" className="nw-detail-close-btn" onClick={onClose}>Close</button>
        </header>
        <div className="nw-detail-content">
          <section className="nw-letter-paper" style={fontStyle(note.font)}>
            <h3>{note.summary}</h3>
            <p className="nw-letter-body" style={fontStyle(note.font)}>
              {note.body || note.summary}
            </p>
            <footer className="nw-letter-signoff">
              <span>{note.authorName}</span>
              <time>{formatLetterTime(note.createdAt)}</time>
            </footer>
          </section>

          <section className={`nw-comments ${hasComments ? "has-comments" : "is-empty"}`} aria-label="Comments">
            {hasComments ? (
              <>
                <div className="nw-comments-header">
                  <strong>Comments</strong>
                  <span>{comments.length}</span>
                </div>
                <div className="nw-comment-list">
                  {comments.map(comment => (
                    <article key={comment.id} className="nw-comment-item">
                      <div>
                        <strong>{comment.authorName}</strong>
                        <time>{formatTime(comment.createdAt)}</time>
                      </div>
                      <p>{comment.body}</p>
                    </article>
                  ))}
                </div>
              </>
            ) : null}
            <form className="nw-comment-form" onSubmit={handleSubmitComment}>
              <input
                value={commentBody}
                maxLength={500}
                placeholder="Write a comment"
                onChange={event => setCommentBody(event.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={commentAnonymous}
                  onChange={event => setCommentAnonymous(event.target.checked)}
                />
                Anonymous
              </label>
              <button type="submit" disabled={submittingComment || !commentBody.trim()}>
                {submittingComment ? "Sending" : "Send"}
              </button>
            </form>
          </section>
        </div>
      </article>
    </div>
  );
}

function TimerSettingsPanel({ characters, settings, generatingCharacterIds, replyingCharacterIds, onChange, onGenerateMany, onReplyMany, onClose }: {
  characters: Character[];
  settings: NoteWallTimerSettings;
  generatingCharacterIds: string[];
  replyingCharacterIds: string[];
  onChange: (settings: NoteWallTimerSettings) => void;
  onGenerateMany: (characterIds: string[], trigger?: "manual" | "timer") => Promise<void> | void;
  onReplyMany: (characterIds: string[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const [openAction, setOpenAction] = useState<"post" | "comment" | null>(null);
  const [selectedPostCharacterIds, setSelectedPostCharacterIds] = useState<string[]>([]);
  const [selectedCommentCharacterIds, setSelectedCommentCharacterIds] = useState<string[]>([]);
  const [confirmingPosts, setConfirmingPosts] = useState(false);
  const [confirmingComments, setConfirmingComments] = useState(false);
  const busy = Boolean(generatingCharacterIds.length || replyingCharacterIds.length || confirmingPosts || confirmingComments);

  useEffect(() => {
    if (openAction !== "post") setSelectedPostCharacterIds([]);
    if (openAction !== "comment") setSelectedCommentCharacterIds([]);
  }, [openAction]);

  const togglePostCharacter = (characterId: string) => {
    setSelectedPostCharacterIds(prev => (
      prev.includes(characterId)
        ? prev.filter(id => id !== characterId)
        : [...prev, characterId]
    ));
  };

  const toggleCommentCharacter = (characterId: string) => {
    setSelectedCommentCharacterIds(prev => (
      prev.includes(characterId)
        ? prev.filter(id => id !== characterId)
        : [...prev, characterId]
    ));
  };

  const handleConfirmPosts = async () => {
    if (busy || selectedPostCharacterIds.length === 0) return;
    setConfirmingPosts(true);
    try {
      await onGenerateMany(selectedPostCharacterIds, "manual");
      setSelectedPostCharacterIds([]);
    } finally {
      setConfirmingPosts(false);
    }
  };

  const handleConfirmComments = async () => {
    if (busy || selectedCommentCharacterIds.length === 0) return;
    setConfirmingComments(true);
    try {
      await onReplyMany(selectedCommentCharacterIds);
      setSelectedCommentCharacterIds([]);
    } finally {
      setConfirmingComments(false);
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="nw-timer-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>Character Note Settings</h2>
            <p>When enabled, characters will write and reply to notes on the same interval.</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="nw-timer-controls">
          <div className="nw-timer-schedule-row">
            <label className="nw-toggle-row">
              <span>
                <Clock3 size={17} />
                Auto-generate
              </span>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={event => onChange({ ...settings, enabled: event.target.checked })}
              />
            </label>
            <label className="nw-field nw-interval-field">
              <span>Interval (minutes)</span>
              <input
                type="number"
                min={5}
                max={10080}
                value={settings.intervalMinutes}
                onChange={event => onChange({ ...settings, intervalMinutes: Math.max(5, Math.min(10080, Number(event.target.value) || 360)) })}
              />
            </label>
          </div>
          <p className="nw-timer-hint">When triggered, notes are written first, then candidate notes are reviewed and up to 5 replies are chosen.</p>
        </div>
        <div className="nw-character-action-panel">
          <div className="nw-character-action-buttons">
            <button
              type="button"
              className={openAction === "post" ? "is-active" : ""}
              onClick={() => setOpenAction(openAction === "post" ? null : "post")}
            >
              <WandSparkles size={17} />
              Have Them Post
            </button>
            <button
              type="button"
              className={openAction === "comment" ? "is-active" : ""}
              onClick={() => setOpenAction(openAction === "comment" ? null : "comment")}
            >
              <MessageCircle size={17} />
              Have Them Comment
            </button>
          </div>
          {openAction ? (
            <div className="nw-character-picker">
              {characters.length === 0 ? <p className="nw-empty">No characters yet.</p> : null}
              {characters.map(character => {
                const isGenerating = generatingCharacterIds.includes(character.id);
                const isReplying = replyingCharacterIds.includes(character.id);
                const selectedForPost = openAction === "post" && selectedPostCharacterIds.includes(character.id);
                const selectedForComment = openAction === "comment" && selectedCommentCharacterIds.includes(character.id);
                return (
                  <button
                    key={character.id}
                    type="button"
                    className={`nw-character-main nw-character-pick-item ${selectedForPost || selectedForComment ? "is-selected" : ""}`}
                    disabled={busy}
                    aria-pressed={openAction === "post" ? selectedForPost : selectedForComment}
                    onClick={() => {
                      if (openAction === "post") {
                        togglePostCharacter(character.id);
                      } else {
                        toggleCommentCharacter(character.id);
                      }
                    }}
                  >
                    <span className="nw-character-avatar">
                      {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
                    </span>
                    <span>
                      <strong>{character.name}</strong>
                      {isGenerating || isReplying ? <em>{isGenerating ? "Posting" : "Commenting"}</em> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {openAction === "post" && selectedPostCharacterIds.length > 0 ? (
            <button
              type="button"
              className="nw-character-confirm-btn"
              disabled={busy}
              onClick={handleConfirmPosts}
            >
              {confirmingPosts ? "Posting" : `Confirm: have ${selectedPostCharacterIds.length} character(s) post`}
            </button>
          ) : null}
          {openAction === "comment" && selectedCommentCharacterIds.length > 0 ? (
            <button
              type="button"
              className="nw-character-confirm-btn"
              disabled={busy}
              onClick={handleConfirmComments}
            >
              {confirmingComments ? "Commenting" : `Confirm: have ${selectedCommentCharacterIds.length} character(s) comment`}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
