import Dexie from "dexie";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import { hydrateKvDb, kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StoryUiPrefs = {
  hideBubble?: boolean;
  hideAvatar?: boolean;
  hideTimestamp?: boolean;
  theme?: string;
  /** Whether this story page's character-bound voice is enabled. */
  voiceEnabled?: boolean;
  /** This character's own story-page wallpaper (a data URL or a reachable URL). */
  wallpaper?: string;
  /** A font file uploaded for this story session (a data URL). */
  customFontDataUrl?: string;
  /** A remote font URL used by this story session. */
  customFontUrl?: string;
  /** The uploaded font's original file name, for display on the settings page only. */
  customFontName?: string;
  /** Whether to show the auto-reading control in the story input bar. */
  autoReadingEnabled?: boolean;
  /** Auto-reading scroll speed, in pixels/second. */
  autoReadingSpeed?: number;
  /** Whether to show the quick-input panel button next to "Continue". */
  quickInputEnabled?: boolean;
  /** The quick-input scheme this character has enabled (stored in the shared repository); only the choice is saved here. */
  activeQuickInputSchemeId?: string;
  /** @deprecated The old per-character quick-input options; migrated into the shared scheme repository. */
  quickInputOptions?: string[];
  /** @deprecated The old per-character insertion-cursor position; migrated into the shared scheme repository. */
  quickInputCursor?: "left" | "middle" | "right";
};

/** Quick-input panel default options: paired quotes + common punctuation. */
export const STORY_DEFAULT_QUICK_INPUT_OPTIONS = ["“”", "「」", "，", "？", "……"];

export type StoryTailScheme = {
  id: string;
  name: string;
  /** The output format/contract written into the generation prompt. */
  prompt: string;
  /** The HTML/CSS/JS render template that runs in a sandboxed iframe. */
  renderHtml?: string;
  /** The editable preview source text handed to the render template. */
  preview: string;
};

// ── Story tail built-in schemes (shared by the story settings page and the mascot's own tools) ──
// The render canvas runs inside a sandboxed iframe; the AI's raw output is injected via
// window.STORY_RAW / {{RAW}}.

export const STORY_DEFAULT_STATUS_RENDER = `<style>
:root{--bg:#fff;--text:#334155;--sub:#94a3b8;--line:#e2e8f0}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--text:#e5e7eb;--sub:#94a3b8;--line:#334155}}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.status{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:2px}
.item{min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.key{display:block;color:var(--sub);font-size:10px;margin-bottom:2px}.value{display:block;overflow-wrap:anywhere;white-space:pre-wrap}
</style>
<div id="status" class="status"></div>
<script>
const root=document.getElementById('status');
const rows=(window.STORY_RAW||'').split(/\\n+/).flatMap(line=>line.split(/\\s{2,}/)).map(v=>v.trim()).filter(Boolean);
for(const row of rows){const parts=row.split(/[｜|：:]/);const item=document.createElement('div');item.className='item';const key=document.createElement('span');key.className='key';key.textContent=parts.length>1?parts.shift().trim():'Status';const value=document.createElement('span');value.className='value';value.textContent=parts.join('｜').trim()||row;item.append(key,value);root.append(item)}
</script>`;

export const STORY_DEFAULT_THEATER_RENDER = `<style>
:root{--paper:#fffdf8;--text:#4b5563;--sub:#9a8f80;--line:#eadfce}
@media(prefers-color-scheme:dark){:root{--paper:#24211d;--text:#e7e1d8;--sub:#a89f94;--line:#4a433a}}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:13px/1.8 Georgia,"Songti SC",serif}
.theater{position:relative;padding:16px 17px;border:1px solid var(--line);border-radius:14px;background:var(--paper)}
.title{margin-bottom:7px;color:var(--sub);font:10px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;letter-spacing:.22em}.text{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
<section class="theater"><div class="title">SKIT</div><div id="text" class="text"></div></section>
<script>document.getElementById('text').textContent=window.STORY_RAW||''</script>`;

export const STORY_DEFAULT_STATUS_SCHEME: StoryTailScheme = {
  id: "status-default",
  name: "Relationship Meter",
  prompt: "At the end of the prose, output <story_status>: briefly record the current time, location, relationship temperature and both parties' state; this content carries into the next round's context.",
  renderHtml: STORY_DEFAULT_STATUS_RENDER,
  preview: "Time｜Night  Location｜By the window\nRelationship｜72%  State｜Close",
};

export const STORY_DEFAULT_STATUS_HTML_SCHEME: StoryTailScheme = {
  id: "status-html",
  name: "Custom HTML Status Bar",
  prompt: "At the end of the prose, output <story_status>, recording time, location, relationship and both parties' state in that order; output only structured plain text, do not write HTML yourself. This content carries into the next round's context.",
  renderHtml: STORY_DEFAULT_STATUS_RENDER,
  preview: "Time｜Night  Location｜By the window\nRelationship｜Growing closer  State｜Quietly together",
};

export const STORY_DEFAULT_THEATER_SCHEME: StoryTailScheme = {
  id: "theater-default",
  name: "Post-Credits Scene",
  prompt: "At the end of the prose, output <story_theater>: write a short post-credits scene that doesn't affect the main story; by default it is shown only, and does not carry into the next round's context.",
  renderHtml: STORY_DEFAULT_THEATER_RENDER,
  preview: "Post-credits｜If that moment had been a photograph, it would have been kept for a long time.",
};

export const STORY_DEFAULT_FURRY_THEATER_SCHEME: StoryTailScheme = {
  id: "theater-furry",
  name: "Furry Party Skit",
  prompt: "At the end of the prose, output <story_theater>: write a \"furry party\" skit -- imagine the character and the user are both some kind of furry animal, and, based on what just happened in the story, write a short scene of them interacting in animal form; by default it is shown only, and does not carry into the next round's context.",
  renderHtml: STORY_DEFAULT_THEATER_RENDER,
  preview: "Furry party｜A big tail swept across your nose; you dozed off together, purring in the sun.",
};

/** Quick-input panel scheme: a named set of options + an insertion cursor position, stored in the shared scheme repository. */
export type StoryQuickInputScheme = {
  id: string;
  name: string;
  /** The options shown; tapping one inserts it into the input box. */
  options: string[];
  /** Where the cursor lands after an option is inserted: left/middle/right of the inserted text. */
  cursor?: "left" | "middle" | "right";
};

/** The shared scheme repository: prose/status/theater/quick-input scheme DEFINITIONS are all shared globally; a character only stores which one it has enabled. */
export type StorySchemeRepository = {
  proseStyleSchemes: StoryProseStyleScheme[];
  statusSchemes: StoryTailScheme[];
  theaterSchemes: StoryTailScheme[];
  quickInputSchemes: StoryQuickInputScheme[];
};

/** Prose-style scheme built-in defaults (seeded into the shared repository on first use / when the repository is empty). */
export const STORY_DEFAULT_PROSE_STYLE_SCHEMES: StoryProseStyleScheme[] = [
  { id: "style-natural", name: "Natural", prompt: "Move the scene forward naturally and coherently, balancing action and dialogue; never decide the user's thoughts or actions for them." },
  { id: "style-delicate", name: "Slow & Tender", prompt: "Keep the pace unhurried, favoring small gestures, sensory detail and gradual emotional build-up; avoid abrupt jumps in the relationship." },
  { id: "style-cinema", name: "Cinematic", prompt: "Advance the story with a clear sense of shot composition and blocking; keep the language restrained and the imagery concrete." },
];

/** Quick-input panel built-in default scheme. */
export const STORY_DEFAULT_QUICK_INPUT_SCHEME: StoryQuickInputScheme = {
  id: "quick-default",
  name: "Default Symbols",
  options: [...STORY_DEFAULT_QUICK_INPUT_OPTIONS],
  cursor: "middle",
};

function defaultStorySchemeRepository(): StorySchemeRepository {
  return {
    proseStyleSchemes: STORY_DEFAULT_PROSE_STYLE_SCHEMES.map((item) => ({ ...item })),
    statusSchemes: [STORY_DEFAULT_STATUS_SCHEME, STORY_DEFAULT_STATUS_HTML_SCHEME].map((item) => ({ ...item })),
    theaterSchemes: [STORY_DEFAULT_THEATER_SCHEME, STORY_DEFAULT_FURRY_THEATER_SCHEME].map((item) => ({ ...item })),
    quickInputSchemes: [{ ...STORY_DEFAULT_QUICK_INPUT_SCHEME, options: [...STORY_DEFAULT_QUICK_INPUT_SCHEME.options] }],
  };
}

/** The shared scheme repository's KV key; registered with the data-backup module (Creative & Play) and travels with export/import. */
const STORY_SCHEME_REPO_KEY = "ai_phone_story_scheme_repo_v1";

/** Repository event: broadcast whenever the repository's content changes (written from the settings page or a mascot tool); the story page refreshes off this. */
export const STORY_SCHEME_REPO_EVENT = "story-scheme-repo-updated";

function sanitizeProseStyleScheme(raw: unknown): StoryProseStyleScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  // An empty prompt on a newly created scheme is a normal state (waiting for the user to fill
  // it in) -- it must not cause the whole scheme to be discarded.
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Untitled Style",
    prompt: typeof item.prompt === "string" ? item.prompt : "",
  };
}

function sanitizeTailScheme(raw: unknown): StoryTailScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Untitled Scheme",
    prompt: typeof item.prompt === "string" ? item.prompt : "",
    renderHtml: typeof item.renderHtml === "string" ? item.renderHtml : "",
    preview: typeof item.preview === "string" ? item.preview : "",
  };
}

function sanitizeQuickInputScheme(raw: unknown): StoryQuickInputScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (!Array.isArray(item.options)) return null;
  const options = item.options.filter((option): option is string => typeof option === "string");
  const cursor = item.cursor === "left" || item.cursor === "right" ? item.cursor : "middle";
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Untitled Scheme",
    options,
    cursor,
  };
}

/** Reads the shared scheme repository; a missing/empty list is backfilled with the defaults, and corrupt data is dropped automatically. */
export function loadStorySchemeRepository(): StorySchemeRepository {
  const fallback = defaultStorySchemeRepository();
  let raw: unknown = null;
  try {
    const text = kvGet(STORY_SCHEME_REPO_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return fallback;
  const item = raw as Record<string, unknown>;

  const proseStyleSchemes = Array.isArray(item.proseStyleSchemes)
    ? item.proseStyleSchemes.map(sanitizeProseStyleScheme).filter((s): s is StoryProseStyleScheme => s !== null)
    : [];
  const statusSchemes = Array.isArray(item.statusSchemes)
    ? item.statusSchemes.map(sanitizeTailScheme).filter((s): s is StoryTailScheme => s !== null)
    : [];
  const theaterSchemes = Array.isArray(item.theaterSchemes)
    ? item.theaterSchemes.map(sanitizeTailScheme).filter((s): s is StoryTailScheme => s !== null)
    : [];
  const quickInputSchemes = Array.isArray(item.quickInputSchemes)
    ? item.quickInputSchemes.map(sanitizeQuickInputScheme).filter((s): s is StoryQuickInputScheme => s !== null)
    : [];

  return {
    proseStyleSchemes: proseStyleSchemes.length ? proseStyleSchemes : fallback.proseStyleSchemes,
    statusSchemes: statusSchemes.length ? statusSchemes : fallback.statusSchemes,
    theaterSchemes: theaterSchemes.length ? theaterSchemes : fallback.theaterSchemes,
    quickInputSchemes: quickInputSchemes.length ? quickInputSchemes : fallback.quickInputSchemes,
  };
}

/** Saves the shared scheme repository and broadcasts the change event. */
export function saveStorySchemeRepository(repo: StorySchemeRepository): void {
  kvSet(STORY_SCHEME_REPO_KEY, JSON.stringify(repo));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STORY_SCHEME_REPO_EVENT));
  }
}

/** Reads the tail schemes out of the shared repository; a character's settings no longer holds its own scheme list (only the active choice survives migration). */
export function loadStoryTailSchemes(settings: StoryCharacterSettings | undefined): {
  statusSchemes: StoryTailScheme[];
  theaterSchemes: StoryTailScheme[];
} {
  const repo = loadStorySchemeRepository();
  // Compatibility for an imported old backup: if the session still carries an old-style
  // scheme list, show it first (hydration's migration folds it into the repository).
  return {
    statusSchemes: settings?.statusSchemes?.length ? settings.statusSchemes : repo.statusSchemes,
    theaterSchemes: settings?.theaterSchemes?.length ? settings.theaterSchemes : repo.theaterSchemes,
  };
}

/** Resolves the prose/status/theater scheme a character currently has enabled (shared repository, with a fallback for old data). */
export function resolveActiveStorySchemes(settings: StoryCharacterSettings | undefined): {
  proseStyle: StoryProseStyleScheme | null;
  status: StoryTailScheme | null;
  theater: StoryTailScheme | null;
} {
  const repo = loadStorySchemeRepository();
  const pickProse = settings?.proseStyleSchemes?.find((item) => item.id === settings?.activeProseStyleSchemeId) || null;
  const pickStatus = settings?.statusSchemes?.find((item) => item.id === settings?.activeStatusSchemeId) || null;
  const pickTheater = settings?.theaterSchemes?.find((item) => item.id === settings?.activeTheaterSchemeId) || null;
  // If the enabled scheme was deleted (e.g. another character deleted a shared scheme, leaving
  // this character's choice dangling), fall back to the first scheme -- matching the same
  // fallback semantics as the settings page's normalizeSettings and
  // resolveActiveQuickInputScheme, so this character's prose/tail output doesn't silently stop.
  return {
    proseStyle: repo.proseStyleSchemes.find((item) => item.id === settings?.activeProseStyleSchemeId) || pickProse || repo.proseStyleSchemes[0] || null,
    status: repo.statusSchemes.find((item) => item.id === settings?.activeStatusSchemeId) || pickStatus || repo.statusSchemes[0] || null,
    theater: repo.theaterSchemes.find((item) => item.id === settings?.activeTheaterSchemeId) || pickTheater || repo.theaterSchemes[0] || null,
  };
}

/** Resolves the quick-input scheme a character currently has enabled; also handles the pre-migration legacy-field fallback. */
export function resolveActiveQuickInputScheme(prefs: StoryUiPrefs | undefined, repoInput?: StorySchemeRepository): StoryQuickInputScheme {
  const repo = repoInput ?? loadStorySchemeRepository();
  const selected = repo.quickInputSchemes.find((item) => item.id === prefs?.activeQuickInputSchemeId);
  if (selected) return selected;
  // Pre-migration / old-backup fallback: match this character's own saved options against a
  // same-content scheme in the repository.
  const legacyOptions = (prefs?.quickInputOptions ?? []).filter((item) => item.trim());
  if (legacyOptions.length) {
    const cursor = prefs?.quickInputCursor ?? "middle";
    const matched = repo.quickInputSchemes.find((item) => item.cursor === cursor && item.options.length === legacyOptions.length && item.options.every((option, index) => option === legacyOptions[index]));
    if (matched) return matched;
  }
  return repo.quickInputSchemes[0] || STORY_DEFAULT_QUICK_INPUT_SCHEME;
}

/** Story-prose style scheme: constrains only the AI's writing style, never defines any tail-output structure. */
export type StoryProseStyleScheme = {
  id: string;
  name: string;
  prompt: string;
};

export type StoryPromptEntry = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
};

export type StoryCharacterSettings = {
  presetName?: string;
  extraPrompt?: string;
  customPromptEntries?: StoryPromptEntry[];
  enabledPresetPromptIds?: string[];
  minChars?: number;
  maxChars?: number;
  userPerspective?: "second" | "third" | "username";
  proseStyle?: string;
  proseStylePrompt?: string;
  /** The prose-style scheme this character has enabled (stored in the shared repository); only the choice is saved here. */
  activeProseStyleSchemeId?: string;
  /** The status-bar scheme this character has enabled (stored in the shared repository); only the choice is saved here. */
  activeStatusSchemeId?: string;
  /** The mini-theater scheme this character has enabled (stored in the shared repository); only the choice is saved here. */
  activeTheaterSchemeId?: string;
  /** @deprecated The old per-character prose-style scheme list; migrated into the shared scheme repository. */
  proseStyleSchemes?: StoryProseStyleScheme[];
  /** @deprecated The old per-character status-bar scheme list; migrated into the shared scheme repository. */
  statusSchemes?: StoryTailScheme[];
  /** @deprecated The old per-character mini-theater scheme list; migrated into the shared scheme repository. */
  theaterSchemes?: StoryTailScheme[];
  floatingPhoneEnabled?: boolean;
  floatingPhoneInContext?: boolean;
};

export type StoryOwnerType = "single" | "group";

/** A multiplayer meeting group is stored in KV; its actual story messages are still stored per-session by StorySession. */
export type StoryGroup = {
  id: string;
  name: string;
  characterIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type StorySession = {
  id: string;
  characterId: string;
  title?: string;
  /** Old data missing this field migrates to "single" automatically. */
  ownerType?: StoryOwnerType;
  /** A character id when single; a multiplayer group id when group. */
  ownerId?: string;
  /** Every participating character in a multiplayer story; the first is the primary character for API/preset binding. */
  participantIds?: string[];
  /** This story's branch/page under the same meeting target; "main" is always the fixed first main branch. */
  branchId?: string;
  branchName?: string;
  branchOrder?: number;
  createdAt?: string;
  /** Whether a new branch may read the most recent memory from before it was created; once on, the UI locks it to avoid the semantics changing back and forth. */
  inheritRecentMemory?: boolean;
  inheritRecentMemoryLocked?: boolean;
  /** An independent story does not read the character's short-term, core, or long-term memory. */
  independentStory?: boolean;
  /** Custom tags shown on the novel catalog page, stored on this story's main-branch session. */
  catalogTags?: string[];
  /** A story cover/avatar set from the photo library (a data URL); normally stored on the main-branch session. */
  storyAvatar?: string;
  /** After an invite or quick-create, the character auto-starts the story the first time it is opened. */
  autoStartPrompt?: string;
  autoStartRequestedAt?: string;
  /** An independent story can be explicitly folded into the character's memory once it ends. */
  endedAt?: string;
  includedInMemoryAt?: string;
  updatedAt: string;
  customCSS?: string;
  foldTags?: string;            // Comma-separated tag names to fold for this session.
  contextExcludedTags?: string; // Comma-separated tag names stripped before sending story history to the LLM.
  uiPrefs?: StoryUiPrefs;
  /** Story-app-specific settings; each character's own unique session stores these independently. */
  settings?: StoryCharacterSettings;
  lastMessageId?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
};

export type StoryMessageRole = "user" | "assistant" | "system";

export type StoryMessage = {
  id: string;
  sessionId: string;
  role: StoryMessageRole;
  rawContent: string;
  renderedContent?: string;
  storySummary?: string;
  regexSignature?: string;
  parserVersion?: number;
  createdAt: string;
  /** A custom-app chat directive triggered this turn (e.g. a boarding-pass/menu card) -- see extractCustomAppCard() in rich-message-parser.ts. Mirrors the subset of ChatMessage.mediaData that AppCardBubble actually reads. */
  appId?: string;
  appName?: string;
  appCardLayout?: Record<string, unknown>;
};

export type StoryProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
};

class StoryDatabase extends Dexie {
  sessions!: Dexie.Table<StorySession, string>;
  messages!: Dexie.Table<StoryMessage, string>;

  constructor() {
    super("AiPhoneStoryDB");
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
    });
  }
}

const storyDb = new StoryDatabase();

const STORY_GROUPS_KEY = "ai_phone_story_groups_v1";
registerKvMigration(STORY_GROUPS_KEY);

let _hydrated = false;
let _sessionsCache: StorySession[] = [];
let _messagesCache: StoryMessage[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getStorySessionActivityTime(session: StorySession): number {
  const lastMessageTime = _messagesCache
    .filter((message) => message.sessionId === session.id)
    .reduce((latest, message) => Math.max(latest, parseTime(message.createdAt)), 0);
  return Math.max(lastMessageTime, parseTime(session.updatedAt));
}

function isPreferredStorySession(candidate: StorySession, current: StorySession): boolean {
  const candidateTime = getStorySessionActivityTime(candidate);
  const currentTime = getStorySessionActivityTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateUpdated = parseTime(candidate.updatedAt);
  const currentUpdated = parseTime(current.updatedAt);
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return candidate.id.localeCompare(current.id) > 0;
}

function normalizeStorySessions(sessions: StorySession[]): { items: StorySession[]; changed: boolean } {
  const normalized: StorySession[] = [];
  const indexByBranch = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    const id = session.id?.trim();
    const characterId = session.characterId?.trim();
    if (!id || !characterId) {
      changed = true;
      continue;
    }
    const ownerType: StoryOwnerType = session.ownerType === "group" ? "group" : "single";
    const ownerId = session.ownerId?.trim() || characterId;
    const branchId = session.branchId?.trim() || "main";
    const branchName = session.branchName?.trim() || (branchId === "main" ? "Main Story" : session.title?.trim() || "Story Branch");
    const createdAt = session.createdAt || session.updatedAt || new Date().toISOString();
    const participantIds = ownerType === "group"
      ? Array.from(new Set((session.participantIds || [characterId]).map((value) => value.trim()).filter(Boolean)))
      : [characterId];
    const branchOrder = branchId === "main" ? 0 : Math.max(1, session.branchOrder ?? 1);
    const item: StorySession = {
      ...session,
      id,
      characterId,
      ownerType,
      ownerId,
      participantIds,
      branchId,
      branchName,
      branchOrder,
      createdAt,
    };
    if (
      id !== session.id || characterId !== session.characterId || ownerType !== session.ownerType
      || ownerId !== session.ownerId || branchId !== session.branchId || branchName !== session.branchName
      || createdAt !== session.createdAt || branchOrder !== session.branchOrder
      || participantIds.join("\u0000") !== (session.participantIds || []).join("\u0000")
    ) changed = true;
    const branchKey = `${ownerType}:${ownerId}:${branchId}`;
    const existingIndex = indexByBranch.get(branchKey);
    if (existingIndex === undefined) {
      indexByBranch.set(branchKey, normalized.length);
      normalized.push(item);
      continue;
    }

    changed = true;
    if (isPreferredStorySession(item, normalized[existingIndex])) {
      normalized[existingIndex] = item;
    }
  }

  return { items: normalized, changed };
}

function persistStorySessionsSnapshot(sessions: StorySession[]): void {
  storyDb.transaction("rw", storyDb.sessions, async () => {
    await storyDb.sessions.clear();
    await storyDb.sessions.bulkPut(sessions);
  }).catch(() => undefined);
}

// NOTE: momo's own version of this file carries a migrateLegacyStorySchemeData() step here,
// folding each character's OLD per-character prose/status/theater/quick-input scheme lists
// into the new shared repository (STORY_SCHEME_REPO_KEY) the first time hydration runs after
// an upgrade. This fork never had that per-character scheme storage in the first place --
// StoryCharacterSettings, StoryUiPrefs.quickInputOptions and everything else the migration
// reads simply didn't exist here before this port -- so there is nothing to migrate, and the
// whole function (plus its very involved dedup-by-content-and-remap-dangling-ids logic) was
// deliberately left out rather than ported as dead code.

export async function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  // Multiplayer story groups and "which page was last open" live in KV; hydrate that first so
  // the very first paint doesn't mistake an existing group for an empty one.
  try { await hydrateKvDb(); } catch { /* A KV failure must not block IndexedDB story messages from hydrating. */ }
  const [sessions, messages] = await Promise.all([
    storyDb.sessions.toArray().catch(() => []),
    storyDb.messages.toArray().catch(() => []),
  ]);
  _messagesCache = messages;
  const normalized = normalizeStorySessions(sessions);
  _sessionsCache = normalized.items;
  if (normalized.changed) persistStorySessionsSnapshot(normalized.items);
  _hydrated = true;
}

export function loadStorySessions(): StorySession[] {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) _sessionsCache = normalized.items;
  // Null-safe: old-version/oddly-imported data can be missing updatedAt; sorting must not crash the page over it.
  return [..._sessionsCache].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function loadStoryMessages(sessionId: string): StoryMessage[] {
  return _messagesCache
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export type CreateStorySessionOptions = {
  ownerType?: StoryOwnerType;
  ownerId?: string;
  participantIds?: string[];
  branchId?: string;
  branchName?: string;
  branchOrder?: number;
  inheritRecentMemory?: boolean;
  independentStory?: boolean;
  baseSession?: StorySession;
};

export function getStorySessionOwnerKey(session: Pick<StorySession, "characterId" | "ownerType" | "ownerId">): string {
  const ownerType: StoryOwnerType = session.ownerType === "group" ? "group" : "single";
  return `${ownerType}:${session.ownerId || session.characterId}`;
}

export function loadStorySessionsForOwner(ownerType: StoryOwnerType, ownerId: string): StorySession[] {
  return loadStorySessions()
    .filter((session) => getStorySessionOwnerKey(session) === `${ownerType}:${ownerId}`)
    .sort((a, b) => (a.branchOrder ?? 0) - (b.branchOrder ?? 0) || (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export function createOrGetStorySession(characterId: string, options: CreateStorySessionOptions = {}): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const ownerType: StoryOwnerType = options.ownerType === "group" ? "group" : "single";
  const ownerId = options.ownerId?.trim() || characterId;
  const branchId = options.branchId?.trim() || "main";
  const existing = _sessionsCache.find((session) => (
    getStorySessionOwnerKey(session) === `${ownerType}:${ownerId}`
    && (session.branchId || "main") === branchId
  ));
  if (existing) return existing;

  const now = new Date().toISOString();
  const base = options.baseSession;
  const ownerSessions = loadStorySessionsForOwner(ownerType, ownerId);
  const session: StorySession = {
    id: generateId("story_sess"),
    characterId,
    ownerType,
    ownerId,
    participantIds: ownerType === "group"
      ? Array.from(new Set((options.participantIds || [characterId]).filter(Boolean)))
      : [characterId],
    branchId,
    branchName: options.branchName?.trim() || (branchId === "main" ? "Main Story" : `Story Branch ${ownerSessions.length}`),
    branchOrder: branchId === "main" ? 0 : options.branchOrder ?? Math.max(0, ...ownerSessions.map((item) => item.branchOrder ?? 0)) + 1,
    inheritRecentMemory: branchId === "main" ? true : Boolean(options.inheritRecentMemory),
    inheritRecentMemoryLocked: branchId !== "main" && Boolean(options.inheritRecentMemory),
    independentStory: branchId === "main" ? false : Boolean(options.independentStory),
    createdAt: now,
    updatedAt: now,
    foldTags: base?.foldTags ?? "think,thinking,story_status,story_theater",
    contextExcludedTags: base?.contextExcludedTags ?? "think,thinking,story_theater",
    customCSS: base?.customCSS,
    settings: base?.settings ? { ...base.settings } : undefined,
    uiPrefs: base?.uiPrefs ? { ...base.uiPrefs } : {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

export function deleteStorySessions(sessionIds: string[], options?: { allowMain?: boolean }): void {
  const requested = new Set(sessionIds);
  const deletable = _sessionsCache
    .filter((session) => requested.has(session.id) && (options?.allowMain || (session.branchId || "main") !== "main"))
    .map((session) => session.id);
  if (!deletable.length) return;
  const ids = new Set(deletable);
  const messageIds = _messagesCache.filter((message) => ids.has(message.sessionId)).map((message) => message.id);
  _sessionsCache = _sessionsCache.filter((session) => !ids.has(session.id));
  _messagesCache = _messagesCache.filter((message) => !ids.has(message.sessionId));
  storyDb.transaction("rw", storyDb.sessions, storyDb.messages, async () => {
    await storyDb.sessions.bulkDelete(deletable);
    if (messageIds.length) await storyDb.messages.bulkDelete(messageIds);
  }).catch(() => undefined);
}

function sanitizeStoryGroup(raw: unknown): StoryGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const characterIds = Array.isArray(item.characterIds)
    ? Array.from(new Set(item.characterIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())))
    : [];
  if (!id || characterIds.length < 2) return null;
  const now = new Date().toISOString();
  return {
    id,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Multiplayer Story",
    characterIds,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
  };
}

export function loadStoryGroups(): StoryGroup[] {
  try {
    const raw = JSON.parse(kvGet(STORY_GROUPS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeStoryGroup).filter((item): item is StoryGroup => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function saveStoryGroups(groups: StoryGroup[]): void {
  kvSet(STORY_GROUPS_KEY, JSON.stringify(groups.map(sanitizeStoryGroup).filter(Boolean)));
}

export function createStoryGroup(characterIds: string[], name?: string): StoryGroup {
  const ids = Array.from(new Set(characterIds.filter(Boolean)));
  if (ids.length < 2) throw new Error("A multiplayer story needs at least two characters selected");
  const now = new Date().toISOString();
  const group: StoryGroup = {
    id: generateId("story_group"),
    name: name?.trim() || "Multiplayer Story",
    characterIds: ids,
    createdAt: now,
    updatedAt: now,
  };
  saveStoryGroups([group, ...loadStoryGroups()]);
  return group;
}

export function updateStoryGroup(groupId: string, updates: Partial<Pick<StoryGroup, "name" | "characterIds">>): StoryGroup | null {
  const groups = loadStoryGroups();
  const index = groups.findIndex((group) => group.id === groupId);
  if (index < 0) return null;
  const characterIds = updates.characterIds
    ? Array.from(new Set(updates.characterIds.filter(Boolean)))
    : groups[index].characterIds;
  if (characterIds.length < 2) return null;
  const next = {
    ...groups[index],
    ...updates,
    name: updates.name?.trim() || groups[index].name,
    characterIds,
    updatedAt: new Date().toISOString(),
  };
  groups[index] = next;
  saveStoryGroups(groups);
  return next;
}

export function deleteStoryGroup(groupId: string): void {
  saveStoryGroups(loadStoryGroups().filter((group) => group.id !== groupId));
  const sessionIds = _sessionsCache.filter((session) => getStorySessionOwnerKey(session) === `group:${groupId}`).map((session) => session.id);
  deleteStorySessions(sessionIds, { allowMain: true });
}

export function updateStorySession(sessionId: string, updates: Partial<StorySession>): StorySession | null {
  const idx = _sessionsCache.findIndex((session) => session.id === sessionId);
  if (idx === -1) return null;
  const next: StorySession = {
    ..._sessionsCache[idx],
    ...updates,
    uiPrefs: { ..._sessionsCache[idx].uiPrefs, ...updates.uiPrefs },
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  _sessionsCache[idx] = next;
  storyDb.sessions.put(next).catch(() => undefined);
  return next;
}

export function pushStoryMessage(
  input: Omit<StoryMessage, "id" | "createdAt">
): StoryMessage {
  const message: StoryMessage = {
    ...input,
    id: generateId("story_msg"),
    createdAt: new Date().toISOString(),
  };
  _messagesCache.push(message);
  storyDb.messages.put(message).catch(() => undefined);

  const previewSource = message.renderedContent || message.rawContent;
  const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 64);
  updateStorySession(message.sessionId, {
    lastMessageId: message.id,
    lastMessagePreview: preview,
    lastMessageAt: message.createdAt,
    updatedAt: message.createdAt,
  });

  return message;
}

/** Sets the given branch/page as the story app's next-open target; callable by cross-app flows such as a chat invite. */
export function saveStoryLaunchTarget(session: StorySession): void {
  const ownerType: StoryOwnerType = session.ownerType === "group" ? "group" : "single";
  const ownerId = session.ownerId || session.characterId;
  const ownerKey = `${ownerType}:${ownerId}`;
  let pageMap: Record<string, string> = {};
  try {
    const parsed = JSON.parse(kvGet("story-active-page-map-v1") || "{}");
    if (parsed && typeof parsed === "object") pageMap = parsed as Record<string, string>;
  } catch { /* A corrupt old value is simply rebuilt. */ }
  kvSet("story-active-page-map-v1", JSON.stringify({ ...pageMap, [ownerKey]: session.id }));
  kvSet("story-last-active-target-v1", JSON.stringify({ ownerType, ownerId }));
  kvSet("story-last-active-character-id", session.characterId);
}

/** Delete a single story message */
export function deleteStoryMessage(messageId: string): void {
    _messagesCache = _messagesCache.filter(m => m.id !== messageId);
    storyDb.messages.delete(messageId).catch(() => undefined);
}

/** Delete a message and all messages after it (by createdAt in same session) */
export function deleteStoryMessagesFrom(sessionId: string, messageId: string): void {
    const msg = _messagesCache.find(m => m.id === messageId);
    if (!msg) return;
    const idsToDelete = _messagesCache
        .filter(m => m.sessionId === sessionId && m.createdAt >= msg.createdAt)
        .map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !idsToDelete.includes(m.id));
    storyDb.messages.bulkDelete(idsToDelete).catch(() => undefined);
}

/** Edit a story message's rawContent (renderedContent will be rebuilt by cache invalidation) */
export function editStoryMessage(messageId: string, newRawContent: string): void {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    _messagesCache[idx] = {
        ..._messagesCache[idx],
        rawContent: newRawContent,
        renderedContent: undefined,
        regexSignature: undefined,
        parserVersion: undefined,
    };
    storyDb.messages.put(_messagesCache[idx]).catch(() => undefined);
}

export function replaceStoryMessages(sessionId: string, messages: StoryMessage[]): void {
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  _messagesCache.push(...messages);
  storyDb.messages.where("sessionId").equals(sessionId).delete()
    .then(() => storyDb.messages.bulkPut(messages))
    .catch(() => undefined);
}

function compactProjectionText(text: string, maxLen = 160): string {
  const plain = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadStoryProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string; userName?: string; charName?: string }
): StoryProjectionEntry[] {
  const sessions = _sessionsCache.filter((item) => {
    const participants = item.participantIds?.length ? item.participantIds : [item.characterId];
    if (!participants.includes(characterId)) return false;
    return !item.independentStory || Boolean(item.includedInMemoryAt);
  });
  if (!sessions.length) return [];
  const messages = sessions.flatMap((session) => loadStoryMessages(session.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const projections: StoryProjectionEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "assistant") continue;
    if (options?.afterTimestamp && current.createdAt <= options.afterTimestamp) continue;

    if (!current.storySummary) continue;
    const summaryText = compactProjectionText(current.storySummary, 500);
    if (!summaryText) continue;

    const ts = formatChatTimestamp(current.createdAt);
    projections.push({
      id: `story_projection_${current.id}`,
      timestamp: current.createdAt,
      content: `[Event ${ts}] ${summaryText}`,
    });
  }

  return projections;
}
