"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Character } from "@/lib/character-types";
import {
  createCharacter,
  exportCharacterAsJson,
  exportCharacterAsPng,
  loadCharacters,
  parseCharacterFromJson,
  parseCharacterFromPng,
  saveCharacters,
  loadBackgroundItems,
  saveBackgroundItems,
  type CharacterImportData,

  CHAR_BLOCKED_FIELDS,
} from "@/lib/character-storage";
import { generateBriefPersonaText, isBriefPersonaStale } from "@/lib/brief-persona";
import { generateSupportingCharacters, materializeSupportingCharacter, type GeneratedSupportingCharacter } from "@/lib/npc-generator";
import {
  addCharacterWorldRelation,
  createCharacterWorldGroup,
  deleteCharacterWorldGroup,
  deleteCharacterWorldRelation,
  getCharacterWorldGroupId,
  loadCharacterWorldGroups,
  moveCharacterToWorld,
  renameCharacterWorldGroup,
  updateCharacterWorldDescription,
  CHARACTER_WORLDS_UPDATED_EVENT,
  DEFAULT_CHARACTER_WORLD_ID,
  type CharacterWorldGroup,
} from "@/lib/character-world-storage";
import { WorldTabStrip, WorldCaseSheet, NewWorldSheet } from "@/components/character/world-tabs";
import { RelationLinkDialog, RelationPairSheet } from "@/components/character/relation-dialogs";
import { loadMomentsConfig, saveMomentsConfig } from "@/lib/moments-storage";
import type { CanvasBgItem } from "@/lib/character-types";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/modal";
import { AlertCircle } from "lucide-react";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { kvGet, kvSet } from "@/lib/kv-db";
import { normalizeTimeZone } from "@/lib/character-time";

type ViewType = "list" | "detail";

// Canvas connection lines: kept in sync with worldbook relations — multiple relations between the same pair of characters merge into one line, with labels shown side by side
type CanvasRelationLine = { key: string; aId: string; bId: string; labels: string[] };

// One canvas per world: pan/zoom memory is keyed per world (the default world keeps the old key, so existing data needs zero migration)
const PAN_STORAGE_BASE_KEY = 'ai_phone_canvas_pan_v2';
const WORLD_TAB_KEY = 'ai_phone_character_app_world_v1';
function worldPanKey(worldId: string): string {
  return worldId === DEFAULT_CHARACTER_WORLD_ID ? PAN_STORAGE_BASE_KEY : `${PAN_STORAGE_BASE_KEY}_${worldId}`;
}

function loadWorldPan(worldId: string): { x: number; y: number; zoom: number } {
  if (typeof window === 'undefined') return { x: 0, y: 0, zoom: 1 };
  try {
    const raw = kvGet(worldPanKey(worldId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return { x: parsed.x ?? 0, y: parsed.y ?? 0, zoom: parsed.zoom ?? 1 };
    }
  } catch { }
  return { x: 0, y: 0, zoom: 1 };
}

type TransitionState = {
  char: Character;
  sourceRect: DOMRect;
  phase: "start" | "fly" | "flip";
  onComplete?: () => void;
  reverse?: boolean;
};

type PinchState = { dist: number; zoom: number; midX: number; midY: number };

type PhoneCharacterAppProps = {
  onClose: () => void;
  onNotice: (text: string) => void;
};

type IntlWithTimeZoneList = typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

const COMMON_CHARACTER_TIME_ZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Bangkok",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const SUPPORTED_CHARACTER_TIME_ZONES = (() => {
  try {
    const intl = Intl as IntlWithTimeZoneList;
    const values = typeof intl.supportedValuesOf === "function"
      ? intl.supportedValuesOf("timeZone")
      : [];
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
})();

function getCharacterTimeZoneOptions(currentTimeZone = ""): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  const add = (timeZone: string) => {
    if (!timeZone || seen.has(timeZone)) return;
    seen.add(timeZone);
    options.push(timeZone);
  };

  COMMON_CHARACTER_TIME_ZONES.forEach(add);
  SUPPORTED_CHARACTER_TIME_ZONES.forEach(add);
  const normalizedCurrentTimeZone = normalizeTimeZone(currentTimeZone);
  if (normalizedCurrentTimeZone) add(normalizedCurrentTimeZone);
  return options;
}

export function PhoneCharacterApp({ onClose, onNotice }: PhoneCharacterAppProps) {
  const [view, setView] = useState<{ type: ViewType; id: string | null; isEditing?: boolean }>({ type: "list", id: null, isEditing: false });
  const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
  const [bgItems, setBgItems] = useState<CanvasBgItem[]>(() => loadBackgroundItems());
  const [transition, setTransition] = useState<TransitionState | null>(null);
  const [pendingPlacementChar, setPendingPlacementChar] = useState<Character | null>(null);
  const [pendingPolaroidStyle, setPendingPolaroidStyle] = useState<number>(0);

  // ── World files: grouped data + the currently open file (persisted) ──
  const [worldGroups, setWorldGroups] = useState<CharacterWorldGroup[]>(() => loadCharacterWorldGroups());
  const [currentWorldId, setCurrentWorldId] = useState<string>(() => {
    const saved = typeof window !== "undefined" ? kvGet(WORLD_TAB_KEY) : null;
    return saved || DEFAULT_CHARACTER_WORLD_ID;
  });
  useEffect(() => {
    const reload = () => setWorldGroups(loadCharacterWorldGroups());
    window.addEventListener(CHARACTER_WORLDS_UPDATED_EVENT, reload);
    return () => window.removeEventListener(CHARACTER_WORLDS_UPDATED_EVENT, reload);
  }, []);
  // The remembered world may have been deleted → fall back to the default file
  const safeWorldId = worldGroups.some(g => g.id === currentWorldId) ? currentWorldId : DEFAULT_CHARACTER_WORLD_ID;
  function selectWorldId(worldId: string) {
    setCurrentWorldId(worldId);
    try { kvSet(WORLD_TAB_KEY, worldId); } catch { }
  }

  function updateChars(next: Character[]) {
    setCharacters(next);
    saveCharacters(next);
    // Adding/removing characters affects world membership (normalize), so refresh the groups in sync
    setWorldGroups(loadCharacterWorldGroups());
  }

  function updateBgItems(next: CanvasBgItem[]) {
    setBgItems(next);
    saveBackgroundItems(next);
  }

  // Handle clicking a polaroid
  function handleSelectChar(char: Character, e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();

    setTransition({
      char,
      sourceRect: rect,
      phase: "start",
    });

    // Animate
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTransition((p) => p ? { ...p, phase: "fly" } : null);
        setTimeout(() => {
          setTransition((p) => p ? { ...p, phase: "flip" } : null);
          setTimeout(() => {
            setView({ type: "detail", id: char.id });
            setTransition(null);
          }, 400); // Wait for flip 0.4s
        }, 400); // Wait for fly 0.4s
      });
    });
  }

  // Handle back from detail
  function handleBackFromDetail() {
    setView({ type: "list", id: null, isEditing: false });
  }

  return (
    <>
      <div className="char-app">
        {view.type === "list" && (
          <CharListView
            characters={characters}
            bgItems={bgItems}
            worldGroups={worldGroups}
            currentWorldId={safeWorldId}
            onSelectWorld={selectWorldId}
            onUpdateChars={updateChars}
            onUpdateBgItems={updateBgItems}
            onClose={onClose}
            onSelect={handleSelectChar}
            onCreate={(style: number) => { setPendingPolaroidStyle(style); setView({ type: "detail", id: null, isEditing: true }); }}
            pendingPlacementChar={pendingPlacementChar}
            onStartCharPlacement={(char: Character) => setPendingPlacementChar(char)}
            onPlacementDone={(placed: Character) => {
              setPendingPlacementChar(null);
              // Newly created/imported characters go into the currently open file (normalize drops them into the default world otherwise)
              if (safeWorldId !== DEFAULT_CHARACTER_WORLD_ID) {
                moveCharacterToWorld(placed.id, safeWorldId);
              } else {
                setWorldGroups(loadCharacterWorldGroups());
              }
            }}
            onClearPendingPlacement={() => setPendingPlacementChar(null)}
            onNotice={onNotice}
          />
        )}

        {view.type === "detail" && (
          <CharArchiveView
            char={view.id ? (characters.find((c) => c.id === view.id) ?? createCharacter({ name: "", persona: "", avatar: null })) : createCharacter({ name: "", persona: "", avatar: null })}
            isEditing={view.isEditing}
            onBack={handleBackFromDetail}
            onEdit={() => setView({ type: "detail", id: view.id, isEditing: true })}
            onCancelEdit={() => {
              if (view.id) {
                setView({ type: "detail", id: view.id, isEditing: false });
              } else {
                setView({ type: "list", id: null, isEditing: false });
              }
            }}
            onSave={(data) => {
              const existing = view.id ? characters.find((c) => c.id === view.id) : null;
              if (existing) {
                const updated: Character = {
                  ...existing,
                  ...data,
                  updatedAt: new Date().toISOString(),
                };
                updateChars(characters.map((c) => (c.id === existing.id ? updated : c)));
                setView({ type: "detail", id: existing.id, isEditing: false });
                onNotice("Archive updated");
              } else {
                const newChar = createCharacter(data);
                newChar.polaroidStyle = pendingPolaroidStyle;
                setPendingPlacementChar(newChar);
                setView({ type: "list", id: null, isEditing: false });
                onNotice("Tap the canvas to place the character");
              }
            }}
            onDelete={() => {
              if (view.id) {
                updateChars(characters.filter((c) => c.id !== view.id));
              }
              setView({ type: "list", id: null, isEditing: false });
              onNotice("Archive deleted");
            }}
            onExportJson={() => {
              const c = view.id ? characters.find(x => x.id === view.id) : null;
              if (c) exportCharacterAsJson(c);
            }}
            onExportPng={async () => {
              const c = view.id ? characters.find(x => x.id === view.id) : null;
              if (c) {
                await exportCharacterAsPng(c);
                onNotice("Export succeeded");
              }
            }}
          />
        )}
      </div>

      {/* Fly & Flip Transition Overlay */}
      {transition && (
        <FlipTransitionOverlay transit={transition} />
      )}
    </>
  );
}

// ── Transition animation layer ───────────────────────────────────────

function FlipTransitionOverlay({ transit }: { transit: TransitionState }) {
  const { char, sourceRect, phase } = transit;

  // Calculate relative bounds based on parent .phone-shell
  const [shellRect, setShellRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const shell = document.querySelector(".char-app");
    if (shell) setShellRect(shell.getBoundingClientRect());
  }, []);

  if (!shellRect) return null;

  // The final target rect inside the phone shell
  // We'll occupy the full width and height of the phone shell
  const targetWidth = shellRect.width;
  const targetHeight = shellRect.height;
  const targetTop = shellRect.top;
  const targetLeft = shellRect.left;

  // Render variables
  const isStart = phase === "start";

  const currentTop = isStart ? sourceRect.top : targetTop;
  const currentLeft = isStart ? sourceRect.left : targetLeft;
  const currentWidth = isStart ? sourceRect.width : targetWidth;
  const currentHeight = isStart ? sourceRect.height : targetHeight;

  // 3D Rotation
  const isFlipped = phase === "flip";

  const duration = isStart ? "0s" : "0.4s";

  return (
    <div
      className="char-flipper-container fixed"
      style={{
        top: currentTop,
        left: currentLeft,
        width: currentWidth,
        height: currentHeight,
        transition: `all ${duration} cubic-bezier(0.25, 1, 0.5, 1)`,
      }}
    >
      <div
        className="char-flipper-inner"
        style={{
          transition: `transform ${duration} ease-in-out`,
          transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)",
        }}
      >
        <div className="char-flipper-front" style={{ padding: isStart ? 0 : "12px" }}>
          {/* Polaroid Front */}
          <div className="char-polaroid w-full h-full border-none shadow-none" style={{
            transition: `padding ${duration} ease`
          }}>
            {isStart && <div className="char-polaroid-tape" />}
            <div className="char-polaroid-img-wrapper" style={{
              height: isStart ? "auto" : "100%",
              aspectRatio: isStart ? "1/1" : "auto",
              transition: `all ${duration} ease`
            }}>
              {char.avatar ? (
                <img src={char.avatar} className="char-polaroid-img" alt="" />
              ) : (
                <div className="w-full h-full bg-[#9b8aaa]" />
              )}
            </div>
            {isStart && <div className="char-polaroid-text">{char.name || "UNNAMED"}</div>}
          </div>
        </div>

        <div className="char-flipper-back">
          {/* Scaled down or full archive rendering so it doesn't look weird */}
          <div className="absolute top-0 left-0" style={{
            width: targetWidth, height: targetHeight,
            opacity: isFlipped ? 1 : 0.5,
            transition: `opacity ${duration} ease`
          }}>
            <CharArchiveView dummy char={char} onBack={() => { }} onEdit={() => { }} onDelete={() => { }} onExportJson={() => { }} onExportPng={async () => { }} />
          </div>
        </div>
      </div>
    </div>
  );
}


// ── List view (photo wall) ─────────────────────────────────────────

function CharListView({
  characters,
  bgItems,
  worldGroups,
  currentWorldId,
  onSelectWorld,
  onUpdateChars,
  onUpdateBgItems,
  onClose,
  onSelect,
  onCreate,
  pendingPlacementChar,
  onStartCharPlacement,
  onPlacementDone,
  onClearPendingPlacement,
  onNotice,
}: {
  characters: Character[];
  bgItems: CanvasBgItem[];
  worldGroups: CharacterWorldGroup[];
  currentWorldId: string;
  onSelectWorld: (worldId: string) => void;
  onUpdateChars: (next: Character[]) => void;
  onUpdateBgItems: (next: CanvasBgItem[]) => void;
  onClose: () => void;
  onSelect: (char: Character, e: React.MouseEvent<HTMLDivElement>) => void;
  onCreate: (polaroidStyle: number) => void;
  pendingPlacementChar: Character | null;
  onStartCharPlacement: (char: Character) => void;
  onPlacementDone: (char: Character) => void;
  onClearPendingPlacement: () => void;
  onNotice: (text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [showNpcGen, setShowNpcGen] = useState(false);
  const [activeMoveChar, setActiveMoveChar] = useState<Character | null>(null);

  // ── World files: data derived from the current world ──
  const currentGroup = worldGroups.find(g => g.id === currentWorldId)
    ?? worldGroups.find(g => g.id === DEFAULT_CHARACTER_WORLD_ID)
    ?? worldGroups[0];
  const memberSet = new Set(currentGroup?.memberIds ?? []);
  const worldCharacters = characters.filter(c => memberSet.has(c.id));
  const worldBgItems = (bgItems || []).filter(item => (item.worldId ?? DEFAULT_CHARACTER_WORLD_ID) === currentWorldId);
  const memberCounts = new Map(worldGroups.map(g => [g.id, g.memberIds.length]));
  const nameById = new Map(characters.map(c => [c.id, c.name || "Unnamed"]));
  // Connection lines stay in sync with worldbook relations: multiple relations between the same pair of characters merge into one line
  const relationLines: CanvasRelationLine[] = (() => {
    const pairs = new Map<string, CanvasRelationLine>();
    for (const relation of currentGroup?.relations ?? []) {
      const [aId, bId] = [relation.fromCharacterId, relation.toCharacterId].sort();
      const key = `${aId}__${bId}`;
      const existing = pairs.get(key);
      if (existing) {
        if (!existing.labels.includes(relation.label)) existing.labels.push(relation.label);
      } else {
        pairs.set(key, { key, aId, bId, labels: [relation.label] });
      }
    }
    return [...pairs.values()];
  })();

  // ── World files: popovers and interaction state ──
  const [showWorldEditor, setShowWorldEditor] = useState(false);
  const [showNewWorld, setShowNewWorld] = useState(false);
  const [dropTargetWorldId, setDropTargetWorldId] = useState<string | null>(null);
  // Relation linking: in edit mode, tap photo A → photo B
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  const [linkTo, setLinkTo] = useState<{ fromId: string; toId: string } | null>(null);
  const [pairSheet, setPairSheet] = useState<{ aId: string; bId: string } | null>(null);

  // Reset the linking state when switching worlds or exiting edit mode
  useEffect(() => { setLinkFromId(null); setLinkTo(null); setPairSheet(null); }, [currentWorldId]);

  /** In edit mode, tapping a polaroid starts/ends a relation line */
  function handleCharEditTap(charId: string) {
    if (linkFromId === charId) { setLinkFromId(null); return; }
    if (linkFromId) { setLinkTo({ fromId: linkFromId, toId: charId }); setLinkFromId(null); return; }
    setLinkFromId(charId);
  }

  /** While dragging a polaroid, continuously detect whether it's hovering over a world tab */
  function handleCharDragMoveAt(clientX: number, clientY: number) {
    const tabEl = typeof document !== "undefined"
      ? document.elementFromPoint(clientX, clientY)?.closest("[data-world-tab-id]")
      : null;
    const worldId = tabEl?.getAttribute("data-world-tab-id") ?? null;
    setDropTargetWorldId(worldId && worldId !== currentWorldId ? worldId : null);
  }

  /** Releasing on a world tab files the character into that world (clears old coordinates, auto-places based on the target canvas's viewport) */
  function handleCharDropAt(charId: string, clientX: number, clientY: number): boolean {
    setDropTargetWorldId(null);
    const tabEl = typeof document !== "undefined"
      ? document.elementFromPoint(clientX, clientY)?.closest("[data-world-tab-id]")
      : null;
    const worldId = tabEl?.getAttribute("data-world-tab-id");
    if (!worldId || worldId === currentWorldId) return false;
    const targetGroup = worldGroups.find(g => g.id === worldId);
    if (!targetGroup) return false;

    // Auto-place near the top-left of the target world canvas's visible area (read its saved pan)
    let targetPan = { x: 0, y: 0, zoom: 1 };
    try {
      const raw = kvGet(worldPanKey(worldId));
      if (raw) {
        const parsed = JSON.parse(raw);
        targetPan = { x: parsed.x ?? 0, y: parsed.y ?? 0, zoom: parsed.zoom ?? 1 };
      }
    } catch { }
    const dropX = (-targetPan.x + 130) / targetPan.zoom + Math.random() * 60;
    const dropY = (-targetPan.y + 160) / targetPan.zoom + Math.random() * 60;
    onUpdateChars(characters.map(c => c.id === charId
      ? { ...c, canvasX: dropX, canvasY: dropY, canvasRot: (Math.random() * 16) - 8 }
      : c
    ));
    moveCharacterToWorld(charId, worldId);
    onNotice(`Filed into "${targetGroup.name}"`);
    return true;
  }

  /** Confirming "Generate Supporting Character" persists the result (supports a batch): the persistence logic shares lib/npc-generator's materialize with the chat card creation flow */
  function handleNpcGenerated(results: GeneratedSupportingCharacter[], targetId: string, allowAutoPost: boolean) {
    const newChars = results.map((result, index) =>
      materializeSupportingCharacter(result, targetId, { allowAutoPost, placementIndex: index })
    );
    // materialize writes to storage directly; this reads it back to refresh React state (onUpdateChars will save the same data again, which is harmless)
    onUpdateChars(loadCharacters());
    setShowNpcGen(false);
    onNotice(`Generated supporting characters: ${newChars.map(c => `"${c.name}"`).join("")}`);
  }

  useEffect(() => {
    let changedChars = false;
    let newChars = [...characters];

    newChars = newChars.map((c, i) => {
      if (c.canvasX === undefined || c.canvasY === undefined) {
        changedChars = true;
        const row = Math.floor(i / 2);
        const col = i % 2;
        const hash = c.id.charCodeAt(0) + i * 17;
        const cx = col === 0 ? 5 + (hash % 20) : 55 + (hash % 20);
        const cy = 60 + row * 200 + (hash % 60 - 30);
        return {
          ...c,
          canvasX: (cx / 100) * (typeof window !== 'undefined' ? window.innerWidth : 400),
          canvasY: cy,
          canvasRot: (hash % 40) - 20,
          canvasZIndex: 100 + i
        };
      }
      return c;
    });

    if (changedChars) {
      onUpdateChars(newChars);
    }

    if (bgItems && bgItems.length === 0 && characters.length > 0) {
      const newBgItems = [];
      const numItems = Math.max(15, characters.length * 4);
      for (let i = 0; i < numItems; i++) {
        const hash = (i * 31) ^ 0x6a;
        const cx = (hash % 85);
        const totalHeight = 40 + Math.ceil(characters.length / 2) * 200 + 200;
        const cy = 20 + (hash * 17 % totalHeight);

        const typeMap = ['a4', 'yellow-note', 'blue-note', 'torn', 'grid', 'scrap'] as const;
        newBgItems.push({
          id: `bg_${Date.now()}_${i}`,
          type: typeMap[hash % 6],
          x: (cx / 100) * (typeof window !== 'undefined' ? window.innerWidth : 400),
          y: cy,
          rot: (hash % 60) - 30,
          zIndex: i
        });
      }
      onUpdateBgItems(newBgItems);
    }
  }, [characters.length]);

  const [pan, setPan] = useState(() => loadWorldPan(currentWorldId));

  /** Switch worlds: save the current canvas viewport first, then switch and load the target canvas's viewport */
  function selectWorld(worldId: string) {
    if (worldId === currentWorldId) return;
    try { kvSet(worldPanKey(currentWorldId), JSON.stringify(panRef.current)); } catch { }
    setLinkFromId(null);
    onSelectWorld(worldId);
    setPan(loadWorldPan(worldId));
  }
  const panRef = useRef(pan);
  const isDraggingCanvasRef = useRef(false);
  const canvasPointerIdRef = useRef<number | null>(null);
  const startPanRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const pinchRef = useRef<PinchState | null>(null);
  const canvasElRef = useRef<HTMLDivElement>(null);
  const [isPropsMenuOpen, setIsPropsMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  function toggleEditing() {
    if (isEditing) {
      // Exiting edit mode → persist pan + zoom position (per current world)
      try { kvSet(worldPanKey(currentWorldId), JSON.stringify(pan)); } catch { }
      setLinkFromId(null);
    }
    setIsEditing(!isEditing);
  }
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string, type: 'char' | 'bg' } | null>(null);
  const [deleteConfirmReady, setDeleteConfirmReady] = useState(false);
  const [isAnyDragging, setIsAnyDragging] = useState(false);
  const [overTrashBin, setOverTrashBin] = useState(false);
  // Clear the world-tab filing highlight when dragging ends (including cancellation)
  useEffect(() => { if (!isAnyDragging) setDropTargetWorldId(null); }, [isAnyDragging]);
  const trashBinRef = useRef<HTMLDivElement>(null);
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  panRef.current = pan;
  const [showStylePicker, setShowStylePicker] = useState(false);
  const pendingStyleRef = useRef<number>(0);
  const pendingActionRef = useRef<'import' | 'create'>('import');
  const [pendingBgType, setPendingBgType] = useState<CanvasBgItem['type'] | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number }>({ x: -9999, y: -9999 });
  const [importError, setImportError] = useState<string | null>(null);
  const placementActive = !!(pendingPlacementChar || pendingBgType);

  useEffect(() => {
    if (!deleteConfirm) {
      setDeleteConfirmReady(false);
      return;
    }
    setDeleteConfirmReady(false);
    const timer = window.setTimeout(() => setDeleteConfirmReady(true), 220);
    return () => window.clearTimeout(timer);
  }, [deleteConfirm]);

  // Escape key / right-click to cancel placement
  useEffect(() => {
    if (!placementActive) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPendingBgType(null);
        onClearPendingPlacement();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [placementActive, onClearPendingPlacement]);

  function handleCanvasPointerDown(e: React.PointerEvent) {
    if (pinchRef.current) return;
    if (placementActive) {
      const rect = canvasElRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasX = (e.clientX - rect.left - pan.x) / pan.zoom;
      const canvasY = (e.clientY - rect.top - pan.y) / pan.zoom;
      if (pendingPlacementChar) {
        const charWithCoords: Character = {
          ...pendingPlacementChar,
          canvasX,
          canvasY,
          canvasRot: (Math.random() * 20) - 10,
          canvasZIndex: 100 + characters.length,
        };
        onUpdateChars([...characters, charWithCoords]);
        onPlacementDone(charWithCoords);
        onNotice("Character placed");
      } else if (pendingBgType) {
        const newId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newItem: CanvasBgItem = {
          id: newId,
          type: pendingBgType,
          x: canvasX,
          y: canvasY,
          rot: (Math.random() * 20) - 10,
          zIndex: (bgItems || []).length,
          worldId: currentWorldId,
        };
        onUpdateBgItems([...(bgItems || []), newItem]);
        setPendingBgType(null);
        onNotice("Prop placed");
      }
      return;
    }
    if (!isEditing) return;
    if ((e.target as HTMLElement).closest('.char-polaroid-board-item') || (e.target as HTMLElement).closest('.char-bg-item')) return;
    if (linkFromId) setLinkFromId(null); // Tapping empty space cancels the relation link
    isDraggingCanvasRef.current = true;
    canvasPointerIdRef.current = e.pointerId;
    startPanRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleCanvasPointerMove(e: React.PointerEvent) {
    if (pinchRef.current) return;
    if (placementActive) {
      const rect = canvasElRef.current?.getBoundingClientRect();
      if (rect) {
        setGhostPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
      return;
    }
    if (!isDraggingCanvasRef.current) return;
    const dx = e.clientX - startPanRef.current.x;
    const dy = e.clientY - startPanRef.current.y;
    setPan(p => ({ ...p, x: startPanRef.current.panX + dx, y: startPanRef.current.panY + dy }));
  }
  function handleCanvasPointerUp(e: React.PointerEvent) {
    if (!isDraggingCanvasRef.current) return;
    isDraggingCanvasRef.current = false;
    canvasPointerIdRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  // Pinch-to-zoom uses native listeners so preventDefault is reliably non-passive.
  useEffect(() => {
    const el = canvasElRef.current;
    if (!el) return;
    const target: HTMLDivElement = el;

    function onTouchStart(e: TouchEvent) {
      if (!isEditingRef.current) return;
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        isDraggingCanvasRef.current = false;
        const pointerId = canvasPointerIdRef.current;
        if (pointerId !== null && target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        canvasPointerIdRef.current = null;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        pinchRef.current = { dist, zoom: panRef.current.zoom, midX, midY };
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (!isEditingRef.current) return;
      if (e.touches.length !== 2 || !pinchRef.current) return;
      if (e.cancelable) e.preventDefault();

      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / pinchRef.current.dist;
      const newZoom = Math.min(3, Math.max(0.2, pinchRef.current.zoom * ratio));
      const rect = target.getBoundingClientRect();
      const cx = pinchRef.current.midX - rect.left;
      const cy = pinchRef.current.midY - rect.top;

      setPan(p => {
        const scaleFactor = newZoom / p.zoom;
        const next = {
          x: cx - scaleFactor * (cx - p.x),
          y: cy - scaleFactor * (cy - p.y),
          zoom: newZoom,
        };
        panRef.current = next;
        return next;
      });
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        pinchRef.current = null;
      }
    }

    target.addEventListener("touchstart", onTouchStart, { passive: false });
    target.addEventListener("touchmove", onTouchMove, { passive: false });
    target.addEventListener("touchend", onTouchEnd);
    target.addEventListener("touchcancel", onTouchEnd);
    return () => {
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", onTouchEnd);
      target.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);


  // Wheel zoom (desktop) — use native event to allow preventDefault on non-passive listener
  useEffect(() => {
    const el = canvasElRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!isEditingRef.current) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.003;
      const rect = el!.getBoundingClientRect();
      setPan(p => {
        const newZoom = Math.min(3, Math.max(0.2, p.zoom * (1 + delta)));
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const scaleFactor = newZoom / p.zoom;
        return { x: cx - scaleFactor * (cx - p.x), y: cy - scaleFactor * (cy - p.y), zoom: newZoom };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function handleDragEndChar(id: string, newX: number, newY: number) {
    onUpdateChars(characters.map(c => c.id === id ? { ...c, canvasX: newX, canvasY: newY } : c));
  }
  function handleDragEndBg(id: string, newX: number, newY: number) {
    onUpdateBgItems((bgItems || []).map(b => b.id === id ? { ...b, x: newX, y: newY } : b));
  }

  function handleAddBgItem(type: CanvasBgItem['type']) {
    setPendingBgType(type);
    setIsPropsMenuOpen(false);
    onNotice("Tap the canvas to place the prop");
  }

  async function handleImportFile(file: File) {
    const styleIdx = pendingStyleRef.current;
    try {
      if (file.type === "application/json" || file.name.endsWith(".json")) {
        const text = await file.text();
        const data = parseCharacterFromJson(text);
        if (!data) return onNotice("Failed to parse — please check the file format");
        const c = createCharacter(data);
        c.polaroidStyle = styleIdx;
        onStartCharPlacement(c);
        onNotice("Tap the canvas to place the character");
      } else if (file.type === "image/png" || file.name.endsWith(".png")) {
        const buffer = await file.arrayBuffer();
        const data = parseCharacterFromPng(buffer);
        if (!data) return onNotice("No character data found in the PNG");
        let avatar = "";
        try {
          avatar = await fileToDataUrl(file);
        } catch (e) {
          console.error("Failed to read image file data", e);
        }
        if (!avatar && typeof data.avatar === "string" && data.avatar.trim() !== "") {
          avatar = data.avatar;
        }
        const c = createCharacter({ ...data, avatar });
        c.polaroidStyle = styleIdx;
        onStartCharPlacement(c);
        onNotice("Tap the canvas to place the character");
      } else {
        onNotice("Please select a .json or .png file");
      }
    } catch (e) {
      if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) {
        setImportError("Character cards containing an opening line, scenario, or example dialogue are not supported");
      } else {
        onNotice("Failed to parse — please check the file format");
      }
    }
  }

  function renderBgContent(item: CanvasBgItem) {
    const hash = item.id.charCodeAt(3) + item.id.charCodeAt(item.id.length - 1) * 17;
    const isBurnt = hash % 15 === 0;
    const hasCrease = hash % 7 === 0;

    let content;
    let baseClass = "";
    let extraAttrs: Record<string, string> = {};

    if (item.type === 'a4') {
      baseClass = "char-paper-a4";
      content = (
        <>
          {hasCrease && <div className="char-paper-crease" />}
          <div className="char-paper-header">
            <span>Dept of Truth</span>
            <span>REF:{hash.toString(16).toUpperCase()}</span>
          </div>
          <div className="char-barcode" />
          <div className="char-paper-paragraph">
            <strong>SUBJECT:</strong> Anomalous entity detected.
          </div>
          <div className="char-paper-paragraph relative">
            All field agents must maintain high alert.
            {hash % 4 === 0 && <div className="char-marker-circle" />}
          </div>
          {hash % 2 === 0 && <div className="char-stamp-red" style={{ top: 120, right: 10 }}>RESTRICTED</div>}
          {hash % 3 === 0 && <div className="char-handwriting red-ink" style={{ bottom: 20, right: 10 }}>* Verify ASAP *</div>}
        </>
      );
    } else if (item.type === 'yellow-note') {
      baseClass = "char-sticky-note";
      extraAttrs = { "data-color": "yellow" };
      content = (
        <>
          <div className="font-bold mb-1">REMINDER:</div>
          <ul className="char-checkbox-list">
            <li><span className="char-checkbox-box checked" /> Check logs</li>
            <li><span className="char-checkbox-box" /> Verify target</li>
          </ul>
          {hash % 5 === 0 && <div className="char-handwriting" style={{ bottom: -5, left: 10 }}>Who is this??</div>}
        </>
      );
    } else if (item.type === 'blue-note') {
      baseClass = "char-sticky-note";
      extraAttrs = { "data-color": "blue" };
      content = (
        <>
          <div className="font-bold border-b border-[#999] pb-0.5 mb-1">ROUTING SLIP</div>
          <div><strong>TO:</strong> Agent {hash % 99}</div>
          <div className="mt-2">Needs clearance.</div>
          {hash % 2 !== 0 && <div className="char-stamp-red" style={{ top: 20, right: -15, fontSize: "calc(12px*var(--app-text-scale,1))", transform: 'rotate(10deg)' }}>URGENT</div>}
        </>
      );
    } else if (item.type === 'torn') {
      baseClass = "char-paper-torn";
      content = (
        <>
          <div className="font-bold mb-1">Log Day {hash % 30}</div>
          <div className="char-paper-paragraph">
            Subject exhibited <span className="char-redacted">unusual</span> behavior.
          </div>
          {hash % 4 === 0 && <div className="char-handwriting red-ink" style={{ bottom: 5, right: -10 }}>Liar.</div>}
        </>
      );
    } else if (item.type === 'grid') {
      baseClass = "char-paper-grid";
      content = (
        <>
          {hasCrease && <div className="char-paper-crease" />}
          <div className="border-b border-[var(--c-panel-border)] mb-1"><strong>COORDINATES:</strong></div>
          <div className="ts-14 font-mono relative">
            [{hash % 90} N, {hash % 180} W]
            {hash % 3 === 0 && <div className="char-marker-circle" style={{ borderColor: '#000080' }} />}
          </div>
          <div className="char-barcode mt-2 h-4" />
        </>
      );
    } else {
      baseClass = "char-paper-scrap";
      content = (
        <>
          <strong>EVIDENCE 0X4A-{hash % 10}</strong>
          <div className="char-redacted mt-1">[EXPUNGED]</div>
        </>
      );
    }

    return (
      <div className={`char-bg-item ${baseClass} ${isBurnt ? 'char-burnt-edges' : ''}`} {...extraAttrs}>
        {content}
      </div>
    );
  }

  return (
    <>
      <PageShell
        title={<strong style={{ fontWeight: 900, fontFamily: 'Impact, "Arial Black", sans-serif', fontSize: '1.15em', letterSpacing: '0.04em' }}>TARGET ARCHIVES</strong>}
        leftAction={
          <button
            className="flex items-center justify-center w-[34px] h-[34px] rounded-full bg-black/5 text-[#666] hover:bg-black/10 transition-colors"
            onClick={onClose}
            aria-label="Back to desktop"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
        }
        className="[&_.page-body]:pb-0"
        rightAction={
          <button
            className={`flex items-center justify-center w-[34px] h-[34px] rounded-full transition-colors ${
              isEditing
                ? 'bg-[#111111] text-white shadow-md'
                : 'bg-black/5 text-[#666] hover:bg-black/10'
            }`}
            onClick={() => toggleEditing()}
            aria-label="Edit layout"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
        }
        footer={
          <div className="char-bottom-bar flex justify-center pb-8">
            <div className="wt-bottom-pill">
              <button className="wt-bottom-pill-btn" onClick={() => { pendingActionRef.current = 'import'; setShowStylePicker(true); }}>
                <IconImport />
                <span>IMPORT</span>
              </button>
              <button className="wt-bottom-pill-btn" onClick={() => { pendingActionRef.current = 'create'; setShowStylePicker(true); }}>
                <IconPlus />
                <span>CREATE</span>
              </button>
              {isEditing && (
                <button className="wt-bottom-pill-btn" onClick={() => setIsPropsMenuOpen(true)}>
                  <IconPlus /> <span>PROPS</span>
                </button>
              )}
              <button className="wt-bottom-pill-btn wt-bottom-pill-active" onClick={() => setShowNpcGen(true)}>
                <IconPlus />
                <span>NPC</span>
              </button>
              <input
                ref={fileRef} type="file" accept=".json,.png,image/png,application/json" className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) await handleImportFile(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        }
      >
      {/* World file tab strip: one case file and one canvas per world */}
      <WorldTabStrip
        groups={worldGroups}
        currentWorldId={currentWorldId}
        memberCounts={memberCounts}
        dropTargetWorldId={dropTargetWorldId}
        onSelect={selectWorld}
        onOpenEditor={() => setShowWorldEditor(true)}
        onOpenCreate={() => setShowNewWorld(true)}
      />
      <div
        ref={canvasElRef}
        className="char-infinite-canvas w-full flex-1 min-h-0 overflow-hidden relative select-none"
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        onContextMenu={(e) => {
          if (placementActive) {
            e.preventDefault();
            setPendingBgType(null);
            onClearPendingPlacement();
          }
        }}
        style={{ touchAction: 'none', WebkitUserSelect: 'none', cursor: placementActive ? 'crosshair' : undefined }}
      >
        {/* Hint banner shown while linking */}
        {linkFromId && (
          <div className="wt-link-hint">
            Linking from <strong>{nameById.get(linkFromId) ?? "?"}</strong> · tap another photo to connect a relation, tap empty space to cancel
          </div>
        )}
        {worldCharacters.length === 0 && worldBgItems.length === 0 ? (
          <div className="char-empty" style={{ zIndex: 100 }}>
            <div className="char-empty-icon">
              <IconCamera size={44} />
            </div>
            <p className="char-empty-text">This file is still empty</p>
            <p className="char-empty-sub">CREATE a character · NPC to generate a supporting character · or drag one in from another file</p>
          </div>
        ) : (
          <div className="char-infinite-container absolute w-0 h-0 origin-top-left" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.zoom})` }}>
            {/* Connection lines used to render here; now rendered below to ensure they layer above the polaroid photos */}

            {worldBgItems.map(item => (
              <DraggableNode
                key={item.id} id={item.id} x={item.x} y={item.y} rot={item.rot} zIndex={item.zIndex}
                onDragEnd={handleDragEndBg} isEditing={isEditing}
                onDeleteIntent={(id) => setDeleteConfirm({ id, type: 'bg' })}
                trashBinRef={trashBinRef}
                onDragActiveChange={setIsAnyDragging}
                onOverTrashChange={setOverTrashBin}
                zoom={pan.zoom}
                pinchRef={pinchRef}
              >
                {renderBgContent(item)}
              </DraggableNode>
            ))}

            {worldCharacters.map((char, idx) => {
              if (char.canvasX === undefined) return null;
              const hash = char.id.charCodeAt(0) + idx * 17;
              const styleIdx = char.polaroidStyle ?? (hash % 5);

              const sizeMod = (hash % 5);
              const w = 110 + sizeMod * 10;
              const ratioClassArray = ["ratio-square", "ratio-portrait", "ratio-landscape", "ratio-16-9", "ratio-9-16"];
              const ratioClass = ratioClassArray[styleIdx % ratioClassArray.length];

              const tapeStyles = ["char-polaroid-tape-white", "char-polaroid-tape-red", "char-polaroid-tape-black"];
              const tapeMod = char.polaroidStyle !== undefined ? styleIdx % tapeStyles.length : hash % 3;
              const tapeWidth = tapeMod === 2 ? 30 : 44;
              const tapeRot = (hash % 10) - 5;

              return (
                <DraggableNode
                  key={char.id} id={char.id}
                  x={char.canvasX} y={char.canvasY || 0} rot={char.canvasRot || 0} zIndex={char.canvasZIndex || 100}
                  onDragEnd={handleDragEndChar}
                  onClick={isEditing ? undefined : (e) => onSelect(char, e)}
                  className={`char-polaroid char-polaroid-board-item ${ratioClass} ${linkFromId === char.id ? "wt-link-source" : ""}`}
                  w={w}
                  isEditing={isEditing}
                  onDeleteIntent={(id) => setDeleteConfirm({ id, type: 'char' })}
                  onEditTap={handleCharEditTap}
                  onDragMoveAt={handleCharDragMoveAt}
                  onDropAt={handleCharDropAt}
                  trashBinRef={trashBinRef}
                  onDragActiveChange={setIsAnyDragging}
                  onOverTrashChange={setOverTrashBin}
                  zoom={pan.zoom}
                  pinchRef={pinchRef}
                >
                  <div className={`char-polaroid-tape-base ${tapeStyles[tapeMod]}`} style={{ top: -10, width: tapeWidth, transform: `translateX(-50%) rotate(${tapeRot}deg)` }} />
                  {hash % 3 === 0 && (
                    <div className="char-clue-label" style={{ top: -10, left: -6, transform: `rotate(${-(char.canvasRot || 0) - 5}deg)` }}>
                      0{idx + 1} ASSET
                    </div>
                  )}
                  <div className="char-polaroid-img-wrapper" style={{ boxShadow: "inset 0 0 10px rgba(0,0,0,0.1)" }}>
                    {char.avatar ? <img src={char.avatar} alt={char.name} className="char-polaroid-img" draggable={false} /> : <CharAvatarFallback name={char.name} size="100%" />}
                    <button
                      className="char-polaroid-menu-btn absolute top-1 right-1 w-6 h-6 bg-black/20 text-white rounded-full flex items-center justify-center cursor-pointer hover:bg-black/40 transition-colors z-10"
                      onClick={(e) => { e.stopPropagation(); setActiveMoveChar(char); }}
                      aria-label="Move to another world"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
                    </button>
                  </div>
                  <div className="char-polaroid-text" style={{ fontSize: 12.5 }}>{char.name || "UNNAMED"}</div>
                </DraggableNode>
              );
            })}

            {/* Render the relation lines last, after all cards, with a very high zIndex so they sit above all photos */}
            <svg className="absolute top-0 left-0 w-[10000px] h-[10000px] pointer-events-none overflow-visible" style={{ zIndex: 99999 }}>
              {relationLines.map(line => {
                const a = worldCharacters.find(c => c.id === line.aId);
                const b = worldCharacters.find(c => c.id === line.bId);
                if (!a || !b || a.canvasX === undefined || a.canvasY === undefined || b.canvasX === undefined || b.canvasY === undefined) return null;
                const x1 = a.canvasX + 60, y1 = a.canvasY + 60;
                const x2 = b.canvasX + 60, y2 = b.canvasY + 60;
                return (
                  <g key={line.key}>
                    {/* Line shadow (lighter shadow) */}
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.04)" strokeWidth="2" transform="translate(1, 1.5)" strokeDasharray="6 3" />
                    {/* Dashed line (darker color) */}
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#222222" strokeWidth="1.5" opacity={0.9} strokeDasharray="6 3" />

                    {/* Pushpins (darker main color, lighter shadow) */}
                    <g transform={`translate(${x1}, ${y1})`}>
                      <circle cx="1.5" cy="2" r="4.5" fill="rgba(0,0,0,0.12)" />
                      <circle cx="0" cy="0" r="4.5" fill="#111111" />
                      <circle cx="-1.5" cy="-1.5" r="1.5" fill="#555555" opacity="0.9" />
                    </g>
                    <g transform={`translate(${x2}, ${y2})`}>
                      <circle cx="1.5" cy="2" r="4.5" fill="rgba(0,0,0,0.12)" />
                      <circle cx="0" cy="0" r="4.5" fill="#111111" />
                      <circle cx="-1.5" cy="-1.5" r="1.5" fill="#555555" opacity="0.9" />
                    </g>
                    {/* Relation label */}
                    <foreignObject
                      x={(x1 + x2) / 2 - 100}
                      y={(y1 + y2) / 2 - 15}
                      width={200}
                      height={30}
                      className="overflow-visible pointer-events-none"
                    >
                      <div className="flex items-center justify-center w-full h-full pointer-events-none">
                        <span
                          className={`bg-[#111111] px-2 py-0.5 text-[11px] text-white border border-[#333333] rounded-[4px] font-bold ${isEditing ? 'cursor-pointer pointer-events-auto hover:bg-[#222222] transition-colors' : 'pointer-events-none'}`}
                          style={{
                            fontFamily: '"Courier New", monospace',
                            boxShadow: '1px 2px 4px rgba(0,0,0,0.06)',
                            transform: 'rotate(-2deg)',
                          }}
                          onClick={isEditing ? () => setPairSheet({ aId: line.aId, bId: line.bId }) : undefined}
                        >
                          {line.labels.join(" / ")}
                        </span>
                      </div>
                    </foreignObject>
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {/* Ghost preview following pointer during placement */}
        {placementActive && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 opacity-50 pointer-events-none"
            style={{
              left: ghostPos.x,
              top: ghostPos.y,
              zIndex: 999999,
            }}
          >
            {pendingPlacementChar ? (
              <div className="char-polaroid w-[100px]" style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>
                <div className="char-polaroid-img-wrapper">
                  {pendingPlacementChar.avatar ? (
                    <img src={pendingPlacementChar.avatar} className="char-polaroid-img" alt="" draggable={false} />
                  ) : (
                    <CharAvatarFallback name={pendingPlacementChar.name} size="100%" />
                  )}
                </div>
                <div className="char-polaroid-text ts-10">{pendingPlacementChar.name || "UNNAMED"}</div>
              </div>
            ) : pendingBgType ? (
              <div className="scale-[0.6] origin-center">
                {renderBgContent({ id: `ghost-${pendingBgType}`, type: pendingBgType, x: 0, y: 0, rot: 0, zIndex: 0 })}
              </div>
            ) : null}
          </div>
        )}

        {/* Placement mode banner */}
        {placementActive && (
          <div className="char-placement-hint" style={{ zIndex: 999999 }}>
            <span className="char-placement-hint-finger" aria-hidden="true">👆</span>
            <span>Tap the canvas to place · ESC to cancel</span>
          </div>
        )}

        {/* Trash bin: z-index between normal items and dragged item */}
        <div
          ref={trashBinRef}
          className={`char-trash-bin char-trash-bin-hitbox ${overTrashBin ? 'drag-over' : ''}`}
          style={{
            opacity: isAnyDragging ? 1 : 0,
            transform: overTrashBin ? 'translateX(-50%) translateY(-10px) scale(1.15)' : 'translateX(-50%) scale(1)',
            pointerEvents: isAnyDragging ? 'auto' : 'none',
            zIndex: 500000
          }}
        >
          <IconTrash size={32} />
        </div>

      </div>
      </PageShell>

      {deleteConfirm && (
        <div
          className="modal-overlay"
          style={{ zIndex: 8000000, backdropFilter: "blur(var(--ui-blur-light))" }}
          onClick={() => {
            if (deleteConfirmReady) setDeleteConfirm(null);
          }}
        >
          <div className="char-punched-hole-note" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm Destruction</h3>
            <p>Are you sure you want to discard this archive or item? This action cannot be undone.</p>
            <div className="char-punched-hole-btn-group">
              <button
                className="char-punched-hole-btn"
                disabled={!deleteConfirmReady}
                onClick={() => {
                  if (deleteConfirmReady) setDeleteConfirm(null);
                }}
              >Reject Request</button>
              <button className="char-punched-hole-btn danger" disabled={!deleteConfirmReady} onClick={() => {
                if (!deleteConfirmReady) return;
                if (deleteConfirm.type === 'char') {
                  onUpdateChars(characters.filter(c => c.id !== deleteConfirm.id));
                  onNotice?.("Investigation archive destroyed");
                } else {
                  onUpdateBgItems((bgItems || []).filter(b => b.id !== deleteConfirm.id));
                  onNotice?.("Scattered item destroyed");
                }
                setDeleteConfirm(null);
              }}>Approve Destruction</button>
            </div>
          </div>
        </div>
      )}

      {importError && (
        <ConfirmDialog
          title="Import Failed"
          message={importError}
          icon={AlertCircle}
          variant="danger"
          confirmLabel="Got it"
          cancelLabel=""
          onConfirm={() => setImportError(null)}
          onCancel={() => setImportError(null)}
        />
      )}

      {/* NPC generator sheet — target character is limited to the current world; generated supporting characters are placed on the current canvas */}
      {showNpcGen && (
        <NpcGeneratorSheet
          characters={worldCharacters}
          onClose={() => setShowNpcGen(false)}
          onConfirm={handleNpcGenerated}
        />
      )}

      {/* World file editor */}
      {showWorldEditor && currentGroup && (
        <WorldCaseSheet
          group={currentGroup}
          onRename={name => renameCharacterWorldGroup(currentGroup.id, name)}
          onUpdateDescription={description => updateCharacterWorldDescription(currentGroup.id, description)}
          onDelete={() => {
            deleteCharacterWorldGroup(currentGroup.id);
            setShowWorldEditor(false);
            selectWorld(DEFAULT_CHARACTER_WORLD_ID);
            onNotice("File deleted, characters moved back to the default world");
          }}
          onClose={() => setShowWorldEditor(false)}
        />
      )}

      {/* New world file */}
      {showNewWorld && (
        <NewWorldSheet
          onCreate={name => {
            const group = createCharacterWorldGroup(name);
            setShowNewWorld(false);
            selectWorld(group.id);
            onNotice(`Created file "${group.name}"`);
          }}
          onClose={() => setShowNewWorld(false)}
        />
      )}

      {/* Relation linking: label input */}
      {linkTo && currentGroup && (
        <RelationLinkDialog
          fromName={nameById.get(linkTo.fromId) ?? "?"}
          toName={nameById.get(linkTo.toId) ?? "?"}
          onConfirm={label => {
            addCharacterWorldRelation(currentGroup.id, linkTo.fromId, linkTo.toId, label);
            setLinkTo(null);
          }}
          onCancel={() => setLinkTo(null)}
        />
      )}

      {/* Relation detail: remove one at a time */}
      {pairSheet && currentGroup && (
        <RelationPairSheet
          relations={(currentGroup.relations ?? []).filter(r =>
            (r.fromCharacterId === pairSheet.aId && r.toCharacterId === pairSheet.bId)
            || (r.fromCharacterId === pairSheet.bId && r.toCharacterId === pairSheet.aId)
          )}
          nameById={nameById}
          onDelete={relationId => deleteCharacterWorldRelation(currentGroup.id, relationId)}
          onClose={() => setPairSheet(null)}
        />
      )}

      {/* Style picker popup */}
      {showStylePicker && (
        <div
          className="absolute inset-0 bg-black/50 flex flex-col items-center justify-end pb-[120px] px-4"
          style={{ zIndex: 9999999 }}
          onClick={() => setShowStylePicker(false)}
        >
          <div className="relative w-full max-w-[280px]" onClick={e => e.stopPropagation()}>
            {/* Back paper layer */}
            <div className="absolute rounded-[2px]" style={{
              top: 6, left: 4, right: -6, bottom: -4,
              background: '#ede7d9', border: '1px solid #cfc3a6',
              transform: 'rotate(2.5deg)',
              boxShadow: '3px 4px 10px rgba(0,0,0,0.18)'
            }} />
            {/* Main paper */}
            <div
              className="relative w-full rounded-[2px]"
              style={{
                background: '#f5f0e6',
                padding: '18px 12px 14px',
                boxShadow: '2px 3px 12px rgba(0,0,0,0.25), inset 0 0 30px rgba(139,119,80,0.08)',
                border: '1px solid #d4c9a8',
                fontFamily: '"Courier New", monospace',
                transform: 'rotate(-1.5deg)'
              }}
            >
              {/* tape decoration on top */}
              <div className="absolute rounded-[1px]" style={{ top: -6, left: '50%', marginLeft: -18, width: 36, height: 12, background: 'rgba(255,255,255,0.55)', transform: 'rotate(1deg)' }} />
              <div className="text-center ts-12 font-bold text-[#4a3f2f] mb-3 tracking-[1px] uppercase">Select Format</div>
              <div className="flex gap-1.5 justify-center">
                {[
                  { label: 'Square', cls: 'ratio-square' },
                  { label: 'Portrait', cls: 'ratio-portrait' },
                  { label: 'Landscape', cls: 'ratio-landscape' },
                  { label: '16:9', cls: 'ratio-16-9' },
                  { label: '9:16', cls: 'ratio-9-16' },
                ].map((style, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      pendingStyleRef.current = idx;
                      setShowStylePicker(false);
                      if (pendingActionRef.current === 'import') {
                        fileRef.current?.click();
                      } else {
                        onCreate(idx);
                      }
                    }}
                    className="bg-none border-[1.5px] border-transparent rounded-[3px] cursor-pointer p-1 flex flex-col items-center gap-[3px]"
                    style={{
                      transition: 'border-color 0.15s, background 0.15s'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#8c7a5a'; e.currentTarget.style.background = 'rgba(140,122,90,0.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'none'; }}
                  >
                    <div
                      className={`char-polaroid ${style.cls} w-9 pointer-events-none relative`}
                      style={{ padding: '2px 2px 8px', boxShadow: '0 1px 2px rgba(0,0,0,0.12)' }}
                    >
                      <div className="char-polaroid-img-wrapper bg-[#ddd]" />
                    </div>
                    <div className="ts-9 text-[#6b5d47] font-semibold" style={{ fontFamily: 'inherit' }}>{style.label}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Props picker popup */}
      {isPropsMenuOpen && (
        <div
          className="absolute inset-0 bg-black/50 flex flex-col items-center justify-end pb-[120px] px-4"
          style={{ zIndex: 9999999 }}
          onClick={() => setIsPropsMenuOpen(false)}
        >
          <div className="relative w-full max-w-[320px]" onClick={e => e.stopPropagation()}>
            {/* Back paper layer */}
            <div className="absolute rounded-[2px]" style={{
              top: 5, left: 3, right: -5, bottom: -3,
              background: '#ede7d9', border: '1px solid #cfc3a6',
              transform: 'rotate(2deg)',
              boxShadow: '3px 4px 10px rgba(0,0,0,0.18)'
            }} />
            {/* Main paper */}
            <div
              className="relative w-full rounded-[2px]"
              style={{
                background: '#f5f0e6',
                padding: '18px 10px 14px',
                boxShadow: '2px 3px 12px rgba(0,0,0,0.25), inset 0 0 30px rgba(139,119,80,0.08)',
                border: '1px solid #d4c9a8',
                fontFamily: '"Courier New", monospace',
                transform: 'rotate(-1deg)'
              }}
            >
              <div className="absolute rounded-[1px]" style={{ top: -6, left: '50%', marginLeft: -18, width: 36, height: 12, background: 'rgba(255,255,255,0.55)', transform: 'rotate(0.5deg)' }} />
              <div className="text-center ts-12 font-bold text-[#4a3f2f] mb-3 tracking-[1px] uppercase">Add Props</div>
              <div className="flex gap-1.5 justify-center flex-wrap">
                {([
                  { type: 'a4' as const, label: 'File', w: 200, h: 280, scale: 0.16 },
                  { type: 'yellow-note' as const, label: 'Sticky Note', w: 110, h: 80, scale: 0.28 },
                  { type: 'blue-note' as const, label: 'Summons', w: 120, h: 90, scale: 0.26 },
                  { type: 'torn' as const, label: 'Scrap', w: 130, h: 70, scale: 0.24 },
                  { type: 'grid' as const, label: 'Grid', w: 150, h: 100, scale: 0.21 },
                  { type: 'scrap' as const, label: 'Burnt Paper', w: 140, h: 50, scale: 0.24 },
                ]).map((item) => (
                  <button
                    key={item.type}
                    onClick={() => handleAddBgItem(item.type)}
                    className="bg-none border-[1.5px] border-transparent rounded-[3px] cursor-pointer p-1 flex flex-col items-center gap-[3px]"
                    style={{
                      transition: 'border-color 0.15s, background 0.15s'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#8c7a5a'; e.currentTarget.style.background = 'rgba(140,122,90,0.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'none'; }}
                  >
                    {/* Scaled real prop preview */}
                    <div className="overflow-hidden relative rounded-[1px]" style={{
                      width: item.w * item.scale, height: item.h * item.scale,
                    }}>
                      <div className="pointer-events-none" style={{
                        transform: `scale(${item.scale})`, transformOrigin: 'top left',
                        width: item.w, height: item.h,
                      }}>
                        <div className={`char-bg-item relative ${item.type === 'a4' ? 'char-paper-a4' :
                          (item.type === 'yellow-note' || item.type === 'blue-note') ? 'char-sticky-note' :
                              item.type === 'torn' ? 'char-paper-torn' :
                                item.type === 'grid' ? 'char-paper-grid' :
                                  'char-paper-scrap'
                          }`} {...(item.type === 'yellow-note' ? { "data-color": "yellow" } : item.type === 'blue-note' ? { "data-color": "blue" } : {})} style={{ width: item.w, height: item.h }}>
                          {renderBgContent({ id: `preview-${item.type}`, type: item.type, x: 0, y: 0, rot: 0, zIndex: 1 }).props.children}
                        </div>
                      </div>
                    </div>
                    <div className="ts-9 text-[#6b5d47] font-semibold">{item.label}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Move to another world modal */}
      {activeMoveChar && (
        <div className="modal-overlay" data-ui="modal" onPointerDown={() => setActiveMoveChar(null)}>
          <div className="modal-dialog" data-ui="modal-dialog" onPointerDown={(e) => e.stopPropagation()} style={{ padding: 0, overflow: 'hidden' }}>
            <div className="modal-header" data-ui="modal-header" style={{ padding: '20px 20px 10px' }}>
              <h3 className="modal-title" style={{ margin: 0, fontSize: '16px' }}>Move to Another File</h3>
            </div>
            <div role="listbox" style={{ maxHeight: '40dvh', padding: '10px 16px', overflowY: 'auto' }}>
              {worldGroups.filter(g => g.id !== currentWorldId).map(group => (
                <button
                  key={group.id}
                  type="button"
                  style={{ width: '100%', padding: '12px 16px', textAlign: 'left', borderRadius: '8px', background: 'rgba(0,0,0,0.03)', marginBottom: '8px', border: '1px solid rgba(0,0,0,0.05)', fontWeight: '500', fontSize: '14px', color: '#333' }}
                  onClick={() => {
                    moveCharacterToWorld(activeMoveChar.id, group.id);
                    setActiveMoveChar(null);
                  }}
                  role="option"
                >
                  {group.name}
                </button>
              ))}
              {worldGroups.filter(g => g.id !== currentWorldId).length === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>No other files to move to</div>
              )}
            </div>
            <div className="modal-footer" data-ui="modal-footer" style={{ padding: '10px 20px 20px' }}>
              <button className="ui-btn ui-btn-outline" style={{ width: '100%' }} onClick={() => setActiveMoveChar(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Draggable component wrapper ───────────────────────────────────

function DraggableNode({
  id, x, y, rot, zIndex, children, onDragEnd, onClick, className, w, isEditing, onDeleteIntent,
  trashBinRef, onDragActiveChange, onOverTrashChange, zoom = 1, pinchRef,
  onEditTap, onDragMoveAt, onDropAt
}: {
  id: string; x: number; y: number; rot: number; zIndex: number;
  children: React.ReactNode;
  onDragEnd: (id: string, newX: number, newY: number) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  className?: string; w?: number | string; isEditing?: boolean;
  onDeleteIntent?: (id: string) => void;
  trashBinRef?: React.RefObject<HTMLDivElement | null>;
  onDragActiveChange?: (active: boolean) => void;
  onOverTrashChange?: (over: boolean) => void;
  zoom?: number;
  pinchRef?: React.RefObject<PinchState | null>;
  /** A "tap" in edit mode (a tap with no movement) — used to select points for relation linking */
  onEditTap?: (id: string) => void;
  /** Reports the pointer's screen position during drag — used for world-tab hover highlighting */
  onDragMoveAt?: (clientX: number, clientY: number) => void;
  /** Handles the drop point on release; returning true means it was consumed (e.g. filed into another world), and the position springs back */
  onDropAt?: (id: string, clientX: number, clientY: number) => boolean;
}) {
  const [pos, setPos] = useState({ x, y });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ cx: 0, cy: 0, startX: 0, startY: 0, moved: false });

  useEffect(() => { setPos({ x, y }); }, [x, y]);

  function handlePointerDown(e: React.PointerEvent) {
    if (pinchRef?.current) return;
    if (!isEditing && onClick) {
      // Non-edit mode: let click through for card open
      return;
    }
    if (!isEditing) return;
    if ((e.target as HTMLElement).tagName.toLowerCase() === 'button') return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { cx: e.clientX, cy: e.clientY, startX: pos.x, startY: pos.y, moved: false };
    setIsDragging(true);
    onDragActiveChange?.(true);
  }
  function isPointerOverTrash(cx: number, cy: number): boolean {
    if (!trashBinRef?.current) return false;
    const rect = trashBinRef.current.getBoundingClientRect();
    return cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (pinchRef?.current) {
      if (isDragging) {
        setIsDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        onDragActiveChange?.(false);
        onOverTrashChange?.(false);
        (e.currentTarget as HTMLElement).classList.remove('drag-over-trash');
      }
      return;
    }
    if (!isDragging) return;
    const dx = (e.clientX - dragStart.current.cx) / zoom;
    const dy = (e.clientY - dragStart.current.cy) / zoom;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragStart.current.moved = true;
    }
    setPos({ x: dragStart.current.startX + dx, y: dragStart.current.startY + dy });
    onDragMoveAt?.(e.clientX, e.clientY);
    if (typeof document !== 'undefined') {
      const overTrash = isPointerOverTrash(e.clientX, e.clientY);
      onOverTrashChange?.(overTrash);
      // Visual feedback on the dragged item itself
      if (overTrash) {
        (e.currentTarget as HTMLElement).classList.add('drag-over-trash');
      } else {
        (e.currentTarget as HTMLElement).classList.remove('drag-over-trash');
      }
    }
  }
  function handlePointerUp(e: React.PointerEvent) {
    if (!isDragging) return;
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (typeof document !== 'undefined') {
      onDragActiveChange?.(false);
      onOverTrashChange?.(false);
      (e.currentTarget as HTMLElement).classList.remove('drag-over-trash');

      if (isPointerOverTrash(e.clientX, e.clientY) && onDeleteIntent) {
        onDeleteIntent(id);
        setPos({ x: dragStart.current.startX, y: dragStart.current.startY });
        return;
      }
      // The drop point was consumed externally (e.g. dropped on a world tab to file it) → position springs back, no coordinates saved
      if (dragStart.current.moved && onDropAt?.(id, e.clientX, e.clientY)) {
        setPos({ x: dragStart.current.startX, y: dragStart.current.startY });
        return;
      }
    }
    onDragEnd(id, pos.x, pos.y);
  }
  function handlePointerCancel(e: React.PointerEvent) {
    if (!isDragging) return;
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (typeof document !== 'undefined') {
      onDragActiveChange?.(false);
      onOverTrashChange?.(false);
    }
    onDragEnd(id, pos.x, pos.y);
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (dragStart.current.moved) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if ((e.target as HTMLElement).closest('.char-polaroid-menu-btn')) {
      return;
    }
    if (isEditing) {
      e.stopPropagation();
      e.preventDefault();
      // A tap with no movement in edit mode → select a point for relation linking
      if (onEditTap) onEditTap(id);
      return;
    }
    if (onClick) onClick(e);
  }

  return (
    <div
      className={`${className || ''} absolute left-0 top-0 select-none`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClickCapture={handleClick}
      style={{
        width: w,
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${rot}deg)`,
        zIndex: isDragging ? 9999999 : zIndex,
        cursor: isDragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        WebkitUserSelect: 'none'
      }}
    >
      {children}
    </div>
  )
}


// ── Classified archive view (detail page) ─────────────────────────────────────────

function CharArchiveView({
  char,
  isEditing = false,
  onBack,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onExportJson,
  onExportPng,
  dummy,
}: {
  char: Character;
  isEditing?: boolean;
  onBack: () => void;
  onEdit: () => void;
  onCancelEdit?: () => void;
  onSave?: (data: CharacterImportData) => void;
  onDelete: () => void;
  onExportJson: () => void;
  onExportPng: () => Promise<void>;
  dummy?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState<"back" | "cancel" | null>(null);
  const [name, setName] = useState(char.name || "");
  const [persona, setPersona] = useState(char.persona || "");
  const [personality, setPersonality] = useState(char.personality || "");
  const [briefPersona, setBriefPersona] = useState(char.briefPersona || "");
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [timeZone, setTimeZone] = useState(char.timeZone || "");
  const [tags, setTags] = useState<string[]>(char.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [showTimeZonePicker, setShowTimeZonePicker] = useState(false);
  const [timeZoneSearch, setTimeZoneSearch] = useState(char.timeZone || "");
  const [avatar, setAvatar] = useState<string | null>(char.avatar || null);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Send mascot page context (on mount + field changes)
  useEffect(() => {
    notifyMascotPageContext({
      page: "character",
      mode: isEditing ? "editing" : "viewing",
      label: `Character Edit · ${name || "New Character"}`,
      fields: {
        _characterId: char.id || "",
        name,
        persona,
        personality,
        timeZone,
      },
    });
  }, [isEditing, name, persona, personality, timeZone, char.id]);

  // Listen for mascot fill events (unified)
  useEffect(() => {
    const onFill = (e: Event) => {
      const { field, value } = (e as CustomEvent).detail;
      if (field === "name") setName(value);
      else if (field === "persona") setPersona(value);
      else if (field === "personality") setPersonality(value);
      else if (field === "timeZone") {
        setTimeZone(value);
        setTimeZoneSearch(value);
      }
    };
    window.addEventListener("mascot-fill-field", onFill);
    return () => window.removeEventListener("mascot-fill-field", onFill);
  }, []);

  // Reset mascot context on unmount
  useEffect(() => {
    return () => {
      notifyMascotPageContext({ page: "desktop", mode: "idle", label: "Desktop", fields: {} });
    };
  }, []);

  // Dirty check — compare current edit state vs original char
  function isDirty(): boolean {
    if (!isEditing) return false;
    if (name !== (char.name || "")) return true;
    if (persona !== (char.persona || "")) return true;
    if (personality !== (char.personality || "")) return true;
    if (briefPersona !== (char.briefPersona || "")) return true;
    if (timeZone !== (char.timeZone || "")) return true;
    if (avatar !== (char.avatar || null)) return true;
    const origTags = char.tags || [];
    if (tags.length !== origTags.length || tags.some((t, i) => t !== origTags[i])) return true;
    return false;
  }

  function handleBack() {
    if (isDirty()) {
      setShowUnsavedConfirm("back");
    } else {
      onBack();
    }
  }

  useEffect(() => {
    if (!isEditing) {
      setName(char.name || "");
      setPersona(char.persona || "");
      setPersonality(char.personality || "");
      setBriefPersona(char.briefPersona || "");
      setBriefError("");
      setTimeZone(char.timeZone || "");
      setTimeZoneSearch(char.timeZone || "");
      setShowTimeZonePicker(false);
      setTags(char.tags || []);
      setAvatar(char.avatar || null);
    }
  }, [isEditing, char]);

  async function handleAvatarFile(file: File) {
    const url = await fileToDataUrl(file);
    setAvatar(url);
  }

  function handleAvatarUrl() {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setAvatar(trimmed);
    setShowUrlInput(false);
    setUrlInput("");
  }

  function handleAddTag() {
    const t = tagInput.trim();
    if (!t) return;
    const split = t.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    const newTags = Array.from(new Set([...tags, ...split]));
    setTags(newTags);
    setTagInput("");
  }

  function handleSave() {
    const trimmedTimeZone = timeZone.trim();
    const normalizedTimeZone = trimmedTimeZone ? normalizeTimeZone(trimmedTimeZone) : undefined;
    if (onSave) {
      const trimmedBrief = briefPersona.trim();
      onSave({
        name: name.trim() || char.name || "UNNAMED",
        persona,
        personality: personality.trim() || undefined,
        briefPersona: trimmedBrief || undefined,
        // Only refresh the timestamp when the brief changes; otherwise keep the original value (used to determine the "settings updated" staleness hint)
        briefPersonaUpdatedAt: trimmedBrief
          ? (trimmedBrief !== (char.briefPersona || "").trim() ? new Date().toISOString() : char.briefPersonaUpdatedAt)
          : undefined,
        timeZone: normalizedTimeZone,
        tags,
        avatar: avatar ?? null
      });
    }
  }

  async function handleGenerateBrief() {
    if (briefBusy) return;
    setBriefBusy(true);
    setBriefError("");
    try {
      const text = await generateBriefPersonaText({
        ...char,
        name: name.trim() || char.name || "Unnamed Character",
        persona,
        personality: personality.trim() || undefined,
      });
      setBriefPersona(text);
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : String(error));
    } finally {
      setBriefBusy(false);
    }
  }

  // Helper limits
  const personaText = persona || "NO DATA AVAILABLE.";
  const timeZoneOptions = getCharacterTimeZoneOptions(timeZone || timeZoneSearch);
  const timeZoneQuery = timeZoneSearch.trim().toLowerCase();
  const matchedTimeZoneOptions = timeZoneQuery
    ? timeZoneOptions.filter(option => option.toLowerCase().includes(timeZoneQuery))
    : timeZoneOptions;
  const filteredTimeZoneOptions = matchedTimeZoneOptions.slice(0, 80);
  const hasMoreTimeZoneOptions = matchedTimeZoneOptions.length > filteredTimeZoneOptions.length;

  function openTimeZonePicker() {
    setTimeZoneSearch(timeZone);
    setShowTimeZonePicker(true);
  }

  function closeTimeZonePicker() {
    setShowTimeZonePicker(false);
  }

  function selectTimeZoneOption(option: string) {
    setTimeZone(option);
    setTimeZoneSearch(option);
    setShowTimeZonePicker(false);
  }

  function applyTimeZoneSearch() {
    setTimeZone(timeZoneSearch.trim());
    setShowTimeZonePicker(false);
  }

  function clearTimeZone() {
    setTimeZone("");
    setTimeZoneSearch("");
    setShowTimeZonePicker(false);
  }

  const archiveFrame = (
      <div className="char-archive-frame">
        <div className="char-archive-stamp">CLASSIFIED</div>

        <div className="char-archive-header">
          <div>
            <div className="char-archive-title">{isEditing ? "EDITING ARCHIVE" : "ARCHIVAL\nINFORMATION"}</div>
            <div className="char-archive-subtitle">THE INTELLIGENCE DATABASE</div>
          </div>
          <div className="char-archive-id">ID: {char.id.slice(0, 8).toUpperCase()}</div>
        </div>

        <div className="char-archive-body">
          <div className="char-archive-left">
            <div
              className="char-archive-photo relative"
              style={{ cursor: isEditing ? "pointer" : "default" }}
              onClick={() => {
                if (isEditing) {
                  fileRef.current?.click();
                }
              }}
            >
              {avatar ? (
                <img src={avatar} alt="Avatar" />
              ) : (
                <CharAvatarFallback name={name || char.name} size="100%" />
              )}
              {isEditing && (
                <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center pointer-events-none text-white">
                  <IconCamera size={24} />
                  <span className="ts-10 mt-1">Change Photo</span>
                </div>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await handleAvatarFile(file);
                e.target.value = "";
              }}
            />
            {isEditing && (
              <div className="mt-2 flex flex-col gap-1 w-full justify-center">
                <button
                  className="ts-10 px-3 py-1 bg-[#111111] text-white border-none rounded-full cursor-pointer hover:bg-[#222222] transition-colors"
                  onClick={() => setShowUrlInput((v) => !v)}
                >
                  Use IMG URL
                </button>
                {showUrlInput && (
                  <div className="flex gap-1 mt-1">
                    <input
                      className="flex-1 ts-10 p-1 border border-[var(--c-input-border)] rounded w-full min-w-0"
                      placeholder="Image URL..."
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAvatarUrl();
                      }}
                    />
                    <button
                      className="ts-10 px-2 py-1 bg-[#444] text-white border-none rounded cursor-pointer"
                      onClick={handleAvatarUrl}
                    >OK</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="char-archive-right flex-1 flex flex-col">

            {/* Name Box moved to the top of Right Column */}
            <div className="char-archive-name-box flex-1 flex flex-col justify-center text-left border-b border-[var(--c-panel-border)]" style={{ padding: "4px 6px 8px 6px" }}>
              <span className="ts-8 text-[var(--c-text)] font-mono block mb-0.5">TARGET NAME / CODENAME</span>
              {isEditing ? (
                <input
                  className="char-archive-input ts-20 font-black w-full text-left bg-[var(--c-input)]/50 border border-dashed border-[#666] font-inherit tracking-[1px]"
                  placeholder="Name or Codename"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{
                    padding: "2px 4px",
                  }}
                />
              ) : (
                <h2 className="whitespace-pre-wrap break-words ts-20 font-black m-0 tracking-[1px]">
                  {name || "UNNAMED"}
                </h2>
              )}
            </div>

            <div className="char-archive-row">
              <div className="char-archive-cell" style={{ flex: 0.8 }}>
                <span className="char-archive-label">Status</span>
                <span className="char-archive-val">{isEditing ? "EDITING" : "ACTIVE"}</span>
              </div>
              <div className="char-archive-cell" style={{ flex: 1.5 }}>
                <span className="char-archive-label">WeChat</span>
                <span className="char-archive-val select-text cursor-text tracking-[-0.5px]">
                  {char.wechatID || "N/A"}
                </span>
              </div>
              <div className="char-archive-cell" style={{ flex: 1.1 }}>
                <span className="char-archive-label">Update</span>
                <span className="char-archive-val">{char.updatedAt ? char.updatedAt.slice(0, 10).replace(/-/g, "/") : "N/A"}</span>
              </div>
            </div>

          </div>
        </div>

        <div className="char-archive-row">
          <div className="char-archive-cell" style={{ flex: 1.8 }}>
            <span className="char-archive-label">Tags</span>
            <div className="flex flex-wrap gap-2">
              {tags.map((t, i) => (
                <div key={i} className="char-archive-tag">
                  {t}
                  {isEditing && (
                    <button
                      onClick={() => setTags(tags.filter((_, idx) => idx !== i))}
                      className="bg-none border-none ml-1 cursor-pointer opacity-60 ts-12 p-0"
                    >×</button>
                  )}
                </div>
              ))}
              {tags.length === 0 && !isEditing && (
                <span className="char-archive-val opacity-50">N/A</span>
              )}
              {isEditing && (
                <div className="flex gap-1 w-full mt-1">
                  <input
                    className="char-archive-tag-input flex-1 min-w-0"
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag(); } }}
                    placeholder="Add tag..."
                  />
                  <button onClick={handleAddTag} className="bg-[#4a3f2f] text-white border-none rounded-[2px] px-2 ts-10 cursor-pointer">ADD</button>
                </div>
              )}
            </div>
          </div>
          <div className="char-archive-cell" style={{ flex: 1.2 }}>
            <span className="char-archive-label">Timezone</span>
            {isEditing ? (
              <div className="char-timezone-picker">
                <button
                  type="button"
                  className="char-timezone-trigger"
                  onClick={openTimeZonePicker}
                >
                  {timeZone || "SYSTEM"}
                </button>
              </div>
            ) : (
              <span className="char-archive-val">{timeZone || "SYSTEM"}</span>
            )}
          </div>
        </div>

        {/* Persona Section (Full Width) */}
        <div className="char-archive-text-section border-b-0">
          <div className="char-log-entry mb-4">
            <div className="char-log-entry-header">
              <span>PERSONA / TRAITS</span>
            </div>
            {isEditing ? (
              <AutoResizingTextarea
                value={persona}
                onChange={setPersona}
                placeholder="Describe background, personality..."
                minHeight={120}
                style={{
                  width: "100%", background: "color-mix(in srgb, var(--c-input) 50%, transparent)",
                  border: "1px dashed #666", padding: 8, fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.5,
                  fontFamily: "inherit", marginTop: 8
                }}
              />
            ) : (
              <p className="char-archive-p whitespace-pre-wrap break-words">{personaText}</p>
            )}
          </div>

          {/* Personality — shown when editing or when has content */}
          {(isEditing || personality.trim()) && (
            <div className="char-log-entry mb-4 border-t border-dashed border-[#999] pt-3">
              <div className="char-log-entry-header">
                <span>PERSONALITY</span>
              </div>
              {isEditing ? (
                <AutoResizingTextarea
                  value={personality}
                  onChange={setPersonality}
                  placeholder="Character personality traits..."
                  minHeight={60}
                  style={{
                    width: "100%", background: "color-mix(in srgb, var(--c-input) 50%, transparent)",
                    border: "1px dashed #666", padding: 8, fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.5,
                    fontFamily: "inherit", marginTop: 8
                  }}
                />
              ) : (
                <p className="char-archive-p whitespace-pre-wrap break-words">{personality}</p>
              )}
            </div>
          )}

          {/* Brief persona — injected into the context of related characters in the same world, to keep them from going OOC */}
          {(isEditing || briefPersona.trim()) && (
            <div className="char-log-entry mb-4 border-t border-dashed border-[#999] pt-3">
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <span className="char-log-entry-header !mb-0">BRIEF PERSONA</span>
                {isEditing && (
                  <button
                    className="ts-10 px-3 py-1 bg-[#111111] text-white border-none rounded-full cursor-pointer disabled:opacity-50 hover:bg-[#222222] transition-colors"
                    disabled={briefBusy}
                    onClick={handleGenerateBrief}
                  >
                    {briefBusy ? "Generating…" : briefPersona.trim() ? "Regenerate" : "AI Generate"}
                  </button>
                )}
              </div>
              <p className="ts-10 opacity-60 mt-1">
                Injected into related characters' context within the same world, to help them avoid going OOC when mentioning this character.
                {!isEditing && isBriefPersonaStale(char) ? " ⚠ Settings have been updated — consider regenerating the brief." : ""}
              </p>
              {briefError && <p className="ts-10 mt-1" style={{ color: "#b4233b" }}>{briefError}</p>}
              {isEditing ? (
                <AutoResizingTextarea
                  value={briefPersona}
                  onChange={setBriefPersona}
                  placeholder="Tap 'AI Generate' to auto-condense the persona, or write a 100-200 word brief by hand…"
                  minHeight={60}
                  style={{
                    width: "100%", background: "color-mix(in srgb, var(--c-input) 50%, transparent)",
                    border: "1px dashed #666", padding: 8, fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.5,
                    fontFamily: "inherit", marginTop: 8
                  }}
                />
              ) : (
                <p className="char-archive-p whitespace-pre-wrap break-words">{briefPersona}</p>
              )}
            </div>
          )}

        </div>

        <div className="char-archive-actions">
          {!dummy && confirmDelete ? (
            <div className="char-confirm-row">
              <span className="char-confirm-text">CONFIRM DELETE?</span>
              <button className="char-confirm-yes" onClick={onDelete}>YES</button>
              <button className="char-confirm-no" onClick={() => setConfirmDelete(false)}>NO</button>
            </div>
          ) : (
            !dummy && isEditing ? (
              <>
                <button className="char-archive-btn char-archive-btn-danger" onClick={() => { if (isDirty()) { setShowUnsavedConfirm("cancel"); } else { onCancelEdit?.(); } }}>CANCEL</button>
                <button className="char-archive-btn bg-[var(--c-text)] text-[var(--c-page-body-bg)] border-[var(--c-input-border)]" onClick={handleSave}>SAVE</button>
              </>
            ) : !dummy && !isEditing ? (
              <>
                <button className="char-archive-btn" onClick={onExportPng}>EXPORT IMG</button>
                <button className="char-archive-btn" onClick={onExportJson}>EXPORT JSON</button>
                <button className="char-archive-btn char-archive-btn-danger" onClick={() => setConfirmDelete(true)}>DELETE</button>
              </>
            ) : null
          )}
        </div>
      </div>
  );

  if (dummy) {
    return (
      <div className="char-archive-view" style={{ pointerEvents: "none" }}>
        {archiveFrame}
      </div>
    );
  }

  return (
    <PageShell
      title=""
      onBack={handleBack}
      className="bg-[var(--c-page-body-bg)]"
      rightAction={!isEditing ? (
        <button className="char-action-btn" onClick={onEdit}>
          <IconEdit />
        </button>
      ) : undefined}
    >
      {archiveFrame}

      {isEditing && showTimeZonePicker && (
        <div
          className="char-timezone-sheet-backdrop"
          onPointerDown={e => {
            if (e.target === e.currentTarget) closeTimeZonePicker();
          }}
        >
          <div className="char-timezone-sheet" role="dialog" aria-modal="true" aria-label="Timezone">
            <div className="char-timezone-sheet-header">
              <span>TIMEZONE</span>
              <button type="button" onClick={closeTimeZonePicker}>CLOSE</button>
            </div>
            <input
              className="char-timezone-search"
              value={timeZoneSearch}
              onChange={e => setTimeZoneSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  closeTimeZonePicker();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (filteredTimeZoneOptions[0]) selectTimeZoneOption(filteredTimeZoneOptions[0]);
                  else applyTimeZoneSearch();
                }
              }}
              placeholder="Asia/Shanghai"
              spellCheck={false}
              autoFocus
            />
            <div className="char-timezone-sheet-actions">
              <button type="button" onClick={clearTimeZone}>SYSTEM</button>
              <button type="button" onClick={applyTimeZoneSearch}>DONE</button>
            </div>
            <div className="char-timezone-options" role="listbox">
              {filteredTimeZoneOptions.length > 0 ? (
                <>
                  {filteredTimeZoneOptions.map(option => (
                    <button
                      key={option}
                      type="button"
                      className="char-timezone-option"
                      onClick={() => selectTimeZoneOption(option)}
                      role="option"
                      aria-selected={option === timeZone}
                    >
                      {option}
                    </button>
                  ))}
                  {hasMoreTimeZoneOptions && (
                    <div className="char-timezone-more">MORE RESULTS</div>
                  )}
                </>
              ) : (
                <div className="char-timezone-empty">NO MATCHES</div>
              )}
            </div>
          </div>
        </div>
      )}



      {/* Unsaved changes confirmation dialog */}
      {showUnsavedConfirm && (
        <ConfirmDialog
          title="Discard editing?"
          message="Your changes haven't been saved yet. Leaving now will lose all edits."
          icon={AlertCircle}
          variant="danger"
          confirmLabel="Discard Changes"
          cancelLabel="Keep Editing"
          onConfirm={() => {
            const action = showUnsavedConfirm;
            setShowUnsavedConfirm(null);
            if (action === "back") onBack();
            else onCancelEdit?.();
          }}
          onCancel={() => setShowUnsavedConfirm(null)}
        />
      )}
    </PageShell>
  );
}

// The CharEditView component has been removed as editing is now inline within CharArchiveView.

// ── Shared subcomponents ───────────────────────────────────────

function CharAvatarFallback({
  name,
  size,
}: {
  name: string;
  size: number | string;
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: typeof size === "number" ? Math.round(size * 0.42) : "2rem",
  };
  return (
    <div className="flex items-center justify-center shrink-0 text-white font-bold" style={{ ...style, background: "linear-gradient(135deg, #7a8088, #5a6068)", fontFamily: "var(--app-font-family)" }}>
      {(name ?? "U").charAt(0).toUpperCase() || "?"}
    </div>
  );
}

function AutoResizingTextarea({
  value,
  onChange,
  placeholder,
  style,
  minHeight = 60,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  minHeight?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // useLayoutEffect (runs synchronously before paint): do the "collapse to one line → expand back to real height" within the same frame, before paint,
  // to avoid some engines (e.g. Xiaomi's browser) painting the intermediate frame's collapsed height and then yanking/pulling the viewport up as the document shrinks.
  // Also record and restore the nearest scrollable ancestor's scrollTop, as extra protection for scroll anchoring during reflow.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let scroller: HTMLElement | null = ta.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    const prevTop = scroller ? scroller.scrollTop : window.scrollY;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(minHeight, ta.scrollHeight)}px`;
    if (scroller) {
      if (scroller.scrollTop !== prevTop) scroller.scrollTop = prevTop;
    } else if (window.scrollY !== prevTop) {
      window.scrollTo(0, prevTop);
    }
  }, [value, minHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="resize-none overflow-hidden"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        ...style,
        minHeight,
      }}
    />
  );
}

// ── Utility functions ─────────────────────────────────────────

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_SIZE = 400;
        let w = img.width;
        let h = img.height;
        if (w > MAX_SIZE || h > MAX_SIZE) {
          if (w > h) {
            h = Math.round(h * MAX_SIZE / w);
            w = MAX_SIZE;
          } else {
            w = Math.round(w * MAX_SIZE / h);
            h = MAX_SIZE;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(reader.result as string);
        ctx.drawImage(img, 0, 0, w, h);

        // Use webp or jpeg to heavily compress large png files before saving to localstorage
        resolve(canvas.toDataURL("image/webp", 0.8));
      };
      img.onerror = () => resolve(reader.result as string); // fallback to raw
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Icons ─────────────────────────────────────────────

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconImport() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconCamera({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"></path>
      <circle cx="12" cy="14" r="3"></circle>
    </svg>
  );
}

function IconTrash({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" y1="11" x2="10" y2="17"></line>
      <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>
  );
}

// ── Component implementation ─────────────────────────────────────────────

// ── NPC generator ─────────────────────────────────────────────
// "Generate Supporting Character" popover: pick a target character + optional requirements → LLM generates a full character card → editable preview → confirm to persist.
// See lib/npc-generator.ts for the generation logic; the persistence action lives in the parent component's handleNpcGenerated.
function NpcGeneratorSheet({ characters, onClose, onConfirm }: {
  characters: Character[];
  onClose: () => void;
  onConfirm: (results: GeneratedSupportingCharacter[], targetId: string, allowAutoPost: boolean) => void;
}) {
  const [targetId, setTargetId] = useState(characters[0]?.id ?? "");
  const [hint, setHint] = useState("");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<GeneratedSupportingCharacter[] | null>(null);
  const [allowAutoPost, setAllowAutoPost] = useState(false);

  const targetName = characters.find(c => c.id === targetId)?.name ?? "";

  async function handleGenerate() {
    if (!targetId || busy) return;
    setBusy(true);
    setError("");
    try {
      const generated = await generateSupportingCharacters(targetId, hint, count);
      setResults(generated);
      if (generated.length < count) {
        setError(`Only successfully parsed ${generated.length} supporting character(s) this time — you can use them as-is or regenerate.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const patchAt = (index: number, partial: Partial<GeneratedSupportingCharacter>) => {
    setResults(prev => (prev ? prev.map((item, i) => (i === index ? { ...item, ...partial } : item)) : prev));
  };
  const removeAt = (index: number) => {
    setResults(prev => {
      const next = prev ? prev.filter((_, i) => i !== index) : prev;
      return next && next.length > 0 ? next : null; // If all are removed, go back to the generation form
    });
  };
  const confirmDisabled = busy
    || !results
    || results.length === 0
    || results.some(r => !r.name.trim() || !r.persona.trim());

  return (
    <div
      className="wt-modal"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="wt-paper"
        onClick={e => e.stopPropagation()}
      >
        <div className="wt-paper-tape" />
        <div className="wt-paper-kicker text-center">
          {results ? "REVIEW NPC" : "GENERATE NPC"}
        </div>

        {!results ? (
          <div className="flex flex-col">
            <label className="wt-paper-label">Generate a supporting character for</label>
            <select className="wt-paper-input" value={targetId} onChange={e => setTargetId(e.target.value)}>
              {characters.map(c => (
                <option key={c.id} value={c.id}>{c.name || "Unnamed Character"}</option>
              ))}
            </select>
            <label className="wt-paper-label mt-2">Number to Generate</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  type="button"
                  className={`wt-btn flex-1 ${count === n ? "wt-btn-primary" : ""}`}
                  onClick={() => setCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <label className="wt-paper-label mt-2">Additional Requirements (optional)</label>
            <textarea
              className="wt-paper-textarea"
              style={{ minHeight: 64 }}
              placeholder="e.g. a troublesome friend / her younger sister / a senior who has a crush on her…"
              value={hint}
              onChange={e => setHint(e.target.value)}
            />
            <p className="wt-paper-hint mt-1">This will draw on the character's core and related long-term memories — people mentioned in memories make the best supporting character material.</p>
            {error && <p className="wt-paper-confirm mt-2">{error}</p>}

            <div className="wt-paper-actions mt-4">
              <button className="wt-btn flex-1" onClick={onClose} disabled={busy}>Cancel</button>
              <button
                className="wt-btn wt-btn-primary flex-1"
                onClick={handleGenerate}
                disabled={busy || !targetId}
              >
                {busy ? "Generating…" : "Generate"}
              </button>
            </div>
            {characters.length === 0 && <p className="wt-paper-hint mt-2">No characters yet — create a main character first.</p>}
          </div>
        ) : (
          <div className="flex flex-col">
            {results.map((result, index) => (
              <div key={index} className={index > 0 ? "mt-4 pt-3" : ""} style={index > 0 ? { borderTop: "1px dashed #c9b98a" } : undefined}>
                <div className="flex items-center">
                  <span className="wt-paper-kicker" style={{ marginBottom: 0 }}>NPC {index + 1} / {results.length}</span>
                  <span className="wt-paper-spacer" />
                  {results.length > 1 && (
                    <button type="button" className="wt-btn wt-btn-danger wt-btn-small" onClick={() => removeAt(index)}>
                      Remove
                    </button>
                  )}
                </div>

                <label className="wt-paper-label mt-2">Name</label>
                <input className="wt-paper-input" value={result.name} onChange={e => patchAt(index, { name: e.target.value })} />

                <label className="wt-paper-label mt-2">Persona (full character card)</label>
                <textarea
                  className="wt-paper-textarea"
                  style={{ minHeight: 120 }}
                  value={result.persona}
                  onChange={e => patchAt(index, { persona: e.target.value })}
                />

                <label className="wt-paper-label mt-2">Personality</label>
                <input className="wt-paper-input" value={result.personality} onChange={e => patchAt(index, { personality: e.target.value })} />

                <label className="wt-paper-label mt-2">Brief Persona (injected into characters in the same world)</label>
                <textarea
                  className="wt-paper-textarea"
                  style={{ minHeight: 64 }}
                  value={result.briefPersona}
                  onChange={e => patchAt(index, { briefPersona: e.target.value })}
                />

                <div className="flex gap-2 mt-2">
                  <div className="flex-1 flex flex-col">
                    <label className="wt-paper-label">This character is {targetName}'s</label>
                    <input className="wt-paper-input" value={result.relationLabel} onChange={e => patchAt(index, { relationLabel: e.target.value })} />
                  </div>
                  <div className="flex-1 flex flex-col">
                    <label className="wt-paper-label">{targetName} is this character's</label>
                    <input className="wt-paper-input" value={result.reverseRelationLabel} onChange={e => patchAt(index, { reverseRelationLabel: e.target.value })} />
                  </div>
                </div>
              </div>
            ))}

            <label className="flex items-center gap-2 mt-3 wt-paper-label" style={{ fontWeight: 'normal' }}>
              <input type="checkbox" checked={allowAutoPost} onChange={e => setAllowAutoPost(e.target.checked)} />
              Allow auto-posting to Moments after becoming friends (applies to this whole batch)
            </label>

            {error && <p className="wt-paper-confirm mt-2">{error}</p>}

            <div className="wt-paper-actions mt-4">
              <button className="wt-btn flex-1" onClick={handleGenerate} disabled={busy}>
                {busy ? "Generating…" : "Regenerate"}
              </button>
              <button
                className="wt-btn wt-btn-primary flex-1"
                disabled={confirmDisabled}
                onClick={() => results && onConfirm(results, targetId, allowAutoPost)}
              >
                {results.length > 1 ? `Confirm & Create ${results.length}` : "Confirm & Create"}
              </button>
            </div>

            <div className="flex mt-2">
              <button className="wt-btn flex-1" onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
