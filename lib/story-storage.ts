import Dexie from "dexie";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import { hydrateKvDb, kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StoryUiPrefs = {
  hideBubble?: boolean;
  hideAvatar?: boolean;
  hideTimestamp?: boolean;
  theme?: string;
};

/**
 * Several characters sharing ONE story scene. The group is a saved roster; its story is a normal
 * StorySession that points back at it (StorySession.groupId).
 */
export type StoryGroup = {
  id: string;
  name: string;
  /** Every character in the scene. The first one is the "primary" (API / preset / world books). */
  characterIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type StorySession = {
  id: string;
  /** The character this story is bound to. For a group story: the group's first character. */
  characterId: string;
  /** Set on a multi-character story: the StoryGroup it belongs to. */
  groupId?: string;
  /** Set on a multi-character story: every character in the scene. */
  participantIds?: string[];
  /**
   * Fields written by an older build of Story mode (branches, groups under another shape). They
   * are not used any more but are read so that data saved by that build is neither lost nor
   * mistaken for something else.
   */
  ownerType?: "single" | "group";
  ownerId?: string;
  branchId?: string;
  independentStory?: boolean;
  title?: string;
  updatedAt: string;
  customCSS?: string;
  foldTags?: string;            // Comma-separated tag names to fold for this session.
  contextExcludedTags?: string; // Comma-separated tag names stripped before sending story history to the LLM.
  uiPrefs?: StoryUiPrefs;
  lastMessageId?: string;
  lastMessagePreview?: string;
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

/** The group a session belongs to, including groups saved by the older build (ownerType "group"). */
export function getStorySessionGroupId(session: Pick<StorySession, "groupId" | "ownerType" | "ownerId">): string | undefined {
  if (session.groupId?.trim()) return session.groupId.trim();
  if (session.ownerType === "group" && session.ownerId?.trim()) return session.ownerId.trim();
  return undefined;
}

/** A branch page created by the older build. Kept in storage, never shown. */
function isLeftoverBranchSession(session: Pick<StorySession, "branchId">): boolean {
  const branch = session.branchId?.trim();
  return Boolean(branch) && branch !== "main";
}

function storySessionKey(session: StorySession): string {
  if (isLeftoverBranchSession(session)) return `branch:${session.id}`;
  const groupId = getStorySessionGroupId(session);
  return groupId ? `group:${groupId}` : `character:${session.characterId}`;
}

function normalizeStorySessions(sessions: StorySession[]): { items: StorySession[]; changed: boolean } {
  const normalized: StorySession[] = [];
  const indexByCharacter = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    const id = session.id?.trim();
    const characterId = session.characterId?.trim();
    if (!id || !characterId) {
      changed = true;
      continue;
    }
    const item = id === session.id && characterId === session.characterId
      ? session
      : { ...session, id, characterId };
    const sessionKey = storySessionKey(item);
    const existingIndex = indexByCharacter.get(sessionKey);
    if (existingIndex === undefined) {
      indexByCharacter.set(sessionKey, normalized.length);
      normalized.push(item);
      if (item !== session) changed = true;
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

export async function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  // The saved groups live in KV: hydrate it first so the first paint does not mistake an existing group for none.
  try { await hydrateKvDb(); } catch { /* a KV failure must not stop the story messages from loading */ }
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
  return _sessionsCache
    .filter((session) => !isLeftoverBranchSession(session))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function loadStoryMessages(sessionId: string): StoryMessage[] {
  return _messagesCache
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createOrGetStorySession(characterId: string): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  // A character's OWN story: never a group's, never a leftover branch.
  const existing = _sessionsCache.find((session) => (
    session.characterId === characterId && !getStorySessionGroupId(session) && !isLeftoverBranchSession(session)
  ));
  if (existing) return existing;

  const session: StorySession = {
    id: generateId("story_sess"),
    characterId,
    updatedAt: new Date().toISOString(),
    uiPrefs: {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

/** The shared story of a group, created on first use. */
export function createOrGetStoryGroupSession(group: StoryGroup): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const primaryId = group.characterIds[0];
  const existing = _sessionsCache.find((session) => getStorySessionGroupId(session) === group.id && !isLeftoverBranchSession(session));
  if (existing) {
    const sameRoster = (existing.participantIds || []).join("\u0001") === group.characterIds.join("\u0001");
    if (sameRoster && existing.characterId === primaryId && existing.groupId === group.id) return existing;
    // The roster was edited: keep the story, follow the new roster.
    return updateStorySession(existing.id, {
      groupId: group.id,
      characterId: primaryId,
      participantIds: [...group.characterIds],
      updatedAt: existing.updatedAt,
    }) ?? existing;
  }

  const session: StorySession = {
    id: generateId("story_sess"),
    characterId: primaryId,
    groupId: group.id,
    participantIds: [...group.characterIds],
    title: group.name,
    updatedAt: new Date().toISOString(),
    uiPrefs: {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

// ── Saved groups (KV) ───────────────────────────────────────────────────────────────

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
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Group Story",
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

function saveStoryGroups(groups: StoryGroup[]): void {
  kvSet(STORY_GROUPS_KEY, JSON.stringify(groups.map(sanitizeStoryGroup).filter(Boolean)));
}

export function createStoryGroup(characterIds: string[], name?: string): StoryGroup {
  const ids = Array.from(new Set(characterIds.filter(Boolean)));
  if (ids.length < 2) throw new Error("A group story needs at least two characters");
  const now = new Date().toISOString();
  const group: StoryGroup = {
    id: generateId("story_group"),
    name: name?.trim() || "Group Story",
    characterIds: ids,
    createdAt: now,
    updatedAt: now,
  };
  saveStoryGroups([group, ...loadStoryGroups()]);
  return group;
}

export function renameStoryGroup(groupId: string, name: string): StoryGroup | null {
  const groups = loadStoryGroups();
  const index = groups.findIndex((group) => group.id === groupId);
  if (index === -1 || !name.trim()) return null;
  groups[index] = { ...groups[index], name: name.trim(), updatedAt: new Date().toISOString() };
  saveStoryGroups(groups);
  return groups[index];
}

/** Deletes the group AND its story (messages included). */
export function deleteStoryGroup(groupId: string): void {
  saveStoryGroups(loadStoryGroups().filter((group) => group.id !== groupId));
  const ids = new Set(_sessionsCache.filter((session) => getStorySessionGroupId(session) === groupId).map((session) => session.id));
  if (ids.size === 0) return;
  const messageIds = _messagesCache.filter((message) => ids.has(message.sessionId)).map((message) => message.id);
  _sessionsCache = _sessionsCache.filter((session) => !ids.has(session.id));
  _messagesCache = _messagesCache.filter((message) => !ids.has(message.sessionId));
  storyDb.transaction("rw", storyDb.sessions, storyDb.messages, async () => {
    await storyDb.sessions.bulkDelete(Array.from(ids));
    if (messageIds.length) await storyDb.messages.bulkDelete(messageIds);
  }).catch(() => undefined);
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
    updatedAt: message.createdAt,
  });

  return message;
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
  // The character's own story, plus every group story it is in. A group story is one shared
  // scene, so each participant remembers what happened in it.
  const sessions = _sessionsCache.filter((item) => {
    if (isLeftoverBranchSession(item) || item.independentStory) return false;
    const participants = getStorySessionGroupId(item)
      ? (item.participantIds?.length ? item.participantIds : [item.characterId])
      : [item.characterId];
    return participants.includes(characterId);
  });
  if (sessions.length === 0) return [];
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
