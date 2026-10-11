// lib/imessage-cloud-sync.ts
// Browser-side half of the real-iMessage bridge: builds a self-contained
// "runtime snapshot" (persona + preset + worldbook + memory + a pre-built
// prompt template, already following the same recipe as
// lib/weixin-cloud-sync.ts) and uploads it to the user's own Supabase
// Storage bucket, so the server-side webhook (app/api/imessage/webhook)
// never has to re-implement prompt assembly -- it only slots the new
// incoming message into the template and calls the LLM.
//
// Also pulls completed inbound/outbound message records the webhook wrote
// back to Supabase into the local chat timeline, so the conversation shows
// up in the phone's own Chat app.

import {
    createOrGetSession,
    getLatestCharacterStateValues,
    hydrateChatStorage,
    loadChatAppSettings,
    loadChatMessages,
    reindexSessionMessageOrdersByTime,
    type ChatMessage,
} from "./chat-storage";
import { loadCharacters } from "./character-storage";
import {
    loadApiConfigs,
    loadBindingConfig,
    loadPresets,
    loadRegexes,
    loadWorldBooks,
    resolveBinding,
    resolveUserIdentity,
    ensureSettingsStorageHydrated,
} from "./settings-storage";
import { loadMemoryConfig, loadMemoryEntries } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { getCurrentCalendarScheduleForPrompt, buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import {
    isCloudBackupConfigured,
    loadCloudBackupConfig,
    type CloudBackupConfig,
} from "./cloud-backup/config";
import { ensureBucket, getObject, listObjects, putObject } from "./cloud-backup/storage-client";
import { loadIMessageLines } from "./imessage-storage";
import type {
    IMessageCloudMessagePullResult,
    IMessageCloudPromptTemplate,
    IMessageCloudRuntimeIndex,
    IMessageCloudRuntimeIndexItem,
    IMessageCloudRuntimeSnapshot,
    IMessageCloudStoredMessage,
    IMessageLineBinding,
} from "./imessage-types";
import type { ApiConfig } from "./settings-types";

const IMESSAGE_CLOUD_PREFIX = "imessage-cloud";
const IMESSAGE_CLOUD_INDEX_PATH = `${IMESSAGE_CLOUD_PREFIX}/index.json`;
const IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN = "__AI_PHONE_IMESSAGE_CLOUD_HISTORY_SLOT_V1__";
const IMESSAGE_CLOUD_APP_TAGS = ["chat", "text"];
const DEFAULT_MESSAGE_LIMIT = 80;

function sanitizePathPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function runtimeSnapshotPath(lineId: string): string {
    return `${IMESSAGE_CLOUD_PREFIX}/runtime/${sanitizePathPart(lineId)}.json`;
}

function messagePath(lineId: string, externalId: string): string {
    return `${IMESSAGE_CLOUD_PREFIX}/messages/${sanitizePathPart(lineId)}/${sanitizePathPart(externalId)}.json`;
}

function cloneMessageForCloud(message: ChatMessage): ChatMessage {
    const cloned = { ...message };
    if (typeof cloned.mediaUrl === "string" && cloned.mediaUrl.startsWith("data:")) {
        cloned.mediaUrl = undefined;
    }
    return cloned;
}

function splitTextAtFirstToken(text: string, token: string): [string, string] {
    const index = text.indexOf(token);
    if (index < 0) return [text, ""];
    return [text.slice(0, index), text.slice(index + token.length)];
}

function stripPromptMessageForCloud(message: LLMMessage): LLMMessage {
    const content = typeof message.content === "string"
        ? message.content
        : message.content.map(part => (
            part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image_url" as const, image_url: { ...part.image_url } }
        ));
    const next: LLMMessage = { role: message.role, content };
    if (message.name) next.name = message.name;
    return next;
}

export function splitPromptMessagesAtHistorySlot(messages: LLMMessage[]): {
    beforeMessages: LLMMessage[];
    afterMessages: LLMMessage[];
    found: boolean;
} {
    const beforeMessages: LLMMessage[] = [];
    const afterMessages: LLMMessage[] = [];
    let found = false;

    for (const message of messages) {
        if (found) {
            afterMessages.push(stripPromptMessageForCloud(message));
            continue;
        }

        if (typeof message.content === "string") {
            if (!message.content.includes(IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN)) {
                beforeMessages.push(stripPromptMessageForCloud(message));
                continue;
            }
            const [beforeText, afterText] = splitTextAtFirstToken(message.content, IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN);
            if (beforeText.trim()) beforeMessages.push(stripPromptMessageForCloud({ ...message, content: beforeText }));
            if (afterText.trim()) afterMessages.push(stripPromptMessageForCloud({ ...message, content: afterText }));
            found = true;
            continue;
        }

        // Multi-part content (text + images): the token lives inside one text part.
        const partIndex = message.content.findIndex(
            (part) => part.type === "text" && part.text.includes(IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN),
        );
        if (partIndex < 0) {
            beforeMessages.push(stripPromptMessageForCloud(message));
            continue;
        }
        const slotPart = message.content[partIndex] as { type: "text"; text: string };
        const [beforeText, afterText] = splitTextAtFirstToken(slotPart.text, IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN);
        const head = message.content.slice(0, partIndex);
        if (beforeText.trim()) head.push({ type: "text", text: beforeText });
        const tail = message.content.slice(partIndex + 1);
        if (afterText.trim()) tail.unshift({ type: "text", text: afterText });
        if (head.length) beforeMessages.push(stripPromptMessageForCloud({ ...message, content: head }));
        if (tail.length) afterMessages.push(stripPromptMessageForCloud({ ...message, content: tail }));
        found = true;
    }

    // Not found: do NOT fail the whole sync. Keep everything as the "before" part, so a new
    // message is simply appended last, which is where a live chat puts it anyway.
    return { beforeMessages, afterMessages, found };
}

/** Builds the full self-contained snapshot for one bound iMessage line. Runs
 * entirely client-side, reusing the exact same prompt-assembly engine the
 * live Chat app uses, so the server-side webhook never needs to know about
 * personas, worldbooks, or memory retrieval -- only how to slot a new
 * message into the pre-built template. */
export async function buildIMessageCloudRuntimeSnapshot(
    lineId: string,
    options?: { messageLimit?: number },
): Promise<IMessageCloudRuntimeSnapshot> {
    await Promise.all([hydrateChatStorage(), ensureSettingsStorageHydrated()]);

    const line = loadIMessageLines().find(item => item.id === lineId);
    if (!line) throw new Error("iMessage line binding not found.");
    if (!line.phone?.trim()) throw new Error("This iMessage line is missing a phone number.");

    const character = loadCharacters().find(item => item.id === line.characterId);
    if (!character) throw new Error("The character bound to this iMessage line no longer exists.");

    const session = createOrGetSession(character.id);
    const messageLimit = Math.max(10, Math.min(300, Math.floor(options?.messageLimit ?? DEFAULT_MESSAGE_LIMIT)));
    const rawMessages = loadChatMessages(session.id, messageLimit).map(cloneMessageForCloud);

    const bindings = loadBindingConfig();
    const bindingSlot = resolveBinding(bindings, character.id, "chat");

    const apiConfig: ApiConfig | undefined = bindingSlot.apiConfigId
        ? loadApiConfigs().find(item => item.id === bindingSlot.apiConfigId)
        : undefined;
    if (!apiConfig) throw new Error(`Character "${character.name}" has no API configuration bound for chat.`);

    const presets = loadPresets();
    const preset = bindingSlot.presetId
        ? presets.find(item => item.id === bindingSlot.presetId) ?? presets.find(item => item.builtIn) ?? null
        : presets.find(item => item.builtIn) ?? null;

    const allWorldBooks = loadWorldBooks();
    const worldBooks = (bindingSlot.worldBookIds || [])
        .map(id => allWorldBooks.find(item => item.id === id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const allRegexes = loadRegexes();
    const regexes = (bindingSlot.regexIds || [])
        .map(id => allRegexes.find(item => item.id === id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const userIdentity = resolveUserIdentity(character.id);
    const memoryConfig = loadMemoryConfig();
    const memories = await loadMemoryEntries(character.id);
    const chatAppSettings = loadChatAppSettings();

    const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
        character.id,
        "chat",
        { history: rawMessages, includeNativeToolHistory: false, timeAware: chatAppSettings.timeAware },
    );
    const promptHistory = truncatedHistory.map(cloneMessageForCloud);

    const [memResults, coreResults] = await Promise.all([
        retrieveMemoriesForPrompt(character.id, wbActivationContext, memoryConfig).catch(() => null),
        retrieveCoreMemoriesForPrompt(character.id, memoryConfig).catch(() => null),
    ]);
    const longTermMemories = memResults ? formatLongTermMemories(memResults) : "";
    const coreMemories = coreResults ? formatCoreMemories(coreResults) : "";

    const weekStartIso = getWeekStartIso(new Date());
    const scheduleSummary = buildCalendarScheduleMarker("character", character.id, weekStartIso);
    const currentSchedule = getCurrentCalendarScheduleForPrompt("character", character.id);

    const createdAt = new Date().toISOString();
    const slotMessage: ChatMessage = {
        id: "imessage-cloud-history-slot",
        sessionId: session.id,
        role: "system",
        content: IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN,
        status: "sent",
        createdAt,
    };

    const buildMessages = (history: ChatMessage[]) => assemblePromptPayload({
        character,
        history,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "chat",
        appTags: IMESSAGE_CLOUD_APP_TAGS,
        initialStateValues: getLatestCharacterStateValues(character.id),
        scheduleSummary,
        currentSchedule,
        coreMemories,
        longTermMemories,
        worldBookActivationContext: wbActivationContext,
        recentBlocks,
        unifiedRecentItems,
        customStickerNames: "",
        customStickerExample: "",
        musicLocal: "",
        musicCloud: "",
        musicOnlineHint: "",
        enableVision: false,
        timeAware: chatAppSettings.timeAware,
        tools: "",
        chatBilingualInstruction: "",
        offlineBilingualInstruction: "",
        offlineSummaryTag: "",
        nativeToolHistory: false,
    });

    const templateMessages = buildMessages([...promptHistory, slotMessage]);
    const split = splitPromptMessagesAtHistorySlot(templateMessages);
    const promptTemplate: IMessageCloudPromptTemplate = {
        version: 1,
        slotToken: IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN,
        beforeMessages: split.beforeMessages,
        afterMessages: split.afterMessages,
        baseHistoryLength: promptHistory.length,
        slotFound: split.found,
        createdAt,
    };

    return {
        format: "ai-phone-imessage-runtime",
        version: 1,
        createdAt,
        line,
        character,
        session,
        apiConfig,
        preset,
        worldBooks,
        regexes,
        bindingSlot,
        userIdentity,
        memoryConfig,
        memories,
        promptHistory,
        promptTemplate,
        recentBlocks,
        unifiedRecentItems,
        worldBookActivationContext: wbActivationContext,
        initialStateValues: getLatestCharacterStateValues(character.id),
        longTermMemories,
        coreMemories,
        scheduleSummary,
        currentSchedule,
        stats: { messageCount: rawMessages.length, memoryCount: memories.length },
    };
}

export async function syncIMessageLineRuntimeToCloud(
    lineId: string,
    options?: { cloudConfig?: CloudBackupConfig; messageLimit?: number },
): Promise<{ path: string; bytes: number; slotFound: boolean }> {
    const cloudConfig = options?.cloudConfig ?? loadCloudBackupConfig();
    if (!isCloudBackupConfigured(cloudConfig)) {
        throw new Error("Please configure Supabase cloud backup in Data Management first.");
    }

    const snapshot = await buildIMessageCloudRuntimeSnapshot(lineId, { messageLimit: options?.messageLimit });
    const path = runtimeSnapshotPath(lineId);
    const json = JSON.stringify(snapshot, null, 2);
    const bytes = new TextEncoder().encode(json).byteLength;

    await ensureBucket(cloudConfig);
    await putObject(cloudConfig, path, json, "application/json");
    await updateRuntimeIndex(cloudConfig, {
        lineId,
        phone: snapshot.line.phone,
        characterId: snapshot.character.id,
        characterName: snapshot.character.name,
        sessionId: snapshot.session.id,
        path,
        updatedAt: snapshot.createdAt,
    });

    return { path, bytes, slotFound: snapshot.promptTemplate.slotFound !== false };
}

async function loadRuntimeIndex(config: CloudBackupConfig): Promise<IMessageCloudRuntimeIndex> {
    try {
        const blob = await getObject(config, IMESSAGE_CLOUD_INDEX_PATH);
        if (!blob) return { format: "ai-phone-imessage-cloud-index", version: 1, updatedAt: new Date().toISOString(), lines: [] };
        const parsed = JSON.parse(await blob.text()) as IMessageCloudRuntimeIndex;
        return Array.isArray(parsed.lines) ? parsed : { format: "ai-phone-imessage-cloud-index", version: 1, updatedAt: new Date().toISOString(), lines: [] };
    } catch {
        return { format: "ai-phone-imessage-cloud-index", version: 1, updatedAt: new Date().toISOString(), lines: [] };
    }
}

async function updateRuntimeIndex(config: CloudBackupConfig, item: IMessageCloudRuntimeIndexItem): Promise<void> {
    const index = await loadRuntimeIndex(config);
    const next = index.lines.filter(existing => existing.lineId !== item.lineId);
    next.push(item);
    await putObject(
        config,
        IMESSAGE_CLOUD_INDEX_PATH,
        JSON.stringify({ format: "ai-phone-imessage-cloud-index", version: 1, updatedAt: new Date().toISOString(), lines: next }, null, 2),
        "application/json",
    );
}

function isCloudStoredMessage(value: unknown): value is IMessageCloudStoredMessage {
    return Boolean(value) && typeof value === "object" && (value as { format?: unknown }).format === "ai-phone-imessage-cloud-message";
}

function makeImportedMessage(stored: IMessageCloudStoredMessage, imageDataUrl?: string): ChatMessage {
    return {
        id: `imsg_cloud_${stored.externalId}`,
        sessionId: stored.sessionId,
        role: stored.role,
        content: imageDataUrl && stored.content === "[Image]" ? "" : stored.content,
        status: "sent",
        createdAt: stored.createdAt,
        ...(imageDataUrl
            ? { mediaType: "media_file" as const, mediaUrl: imageDataUrl, mediaData: { fileType: "image", fileName: "iMessage photo" } }
            : {}),
    };
}

/** Reads a photo the webhook stored next to a message and returns it as a data URL. */
async function loadStoredImageDataUrl(config: CloudBackupConfig, image: { path: string; mimeType: string }): Promise<string | undefined> {
    const blob = await getObject(config, image.path);
    if (!blob) return undefined;
    try {
        const parsed = JSON.parse(await blob.text()) as { mimeType?: string; dataBase64?: string };
        if (!parsed.dataBase64) return undefined;
        return `data:${parsed.mimeType || image.mimeType};base64,${parsed.dataBase64}`;
    } catch {
        return undefined;
    }
}

/** Pulls completed inbound/outbound records the server-side webhook wrote to
 * Supabase into the local chat timeline, so the conversation appears in the
 * phone's own Chat app. Call periodically (e.g. on app focus) -- there is no
 * realtime push from this project's own server back to the browser. */
export async function pullIMessageCloudMessages(
    options?: { cloudConfig?: CloudBackupConfig; limitPerLine?: number },
): Promise<IMessageCloudMessagePullResult> {
    await hydrateChatStorage();
    const cloudConfig = options?.cloudConfig ?? loadCloudBackupConfig();
    if (!isCloudBackupConfigured(cloudConfig)) {
        throw new Error("Please configure Supabase cloud backup in Data Management first.");
    }

    const index = await loadRuntimeIndex(cloudConfig);
    const result: IMessageCloudMessagePullResult = { added: 0, skipped: 0, errors: [], sessionIds: [] };
    const touchedSessionIds = new Set<string>();
    const limit = Math.max(1, Math.min(500, Math.floor(options?.limitPerLine ?? 100)));

    // Reaching into chat-storage's module-private "existing message ids" set
    // isn't exposed, so dedupe is done by deterministic id below; chat-storage
    // itself also guards against inserting a duplicate id.
    const { upsertImportedChatMessage } = await import("./chat-storage");

    for (const target of index.lines) {
        const prefix = `${IMESSAGE_CLOUD_PREFIX}/messages/${sanitizePathPart(target.lineId)}/`;
        let objects;
        try {
            objects = await listObjects(cloudConfig, prefix, limit);
        } catch (err) {
            result.errors.push(`${target.characterName}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }

        const storedMessages: IMessageCloudStoredMessage[] = [];
        for (const object of objects) {
            if (!object.name || object.name.endsWith("/")) continue;
            try {
                const blob = await getObject(cloudConfig, `${prefix}${object.name}`);
                if (!blob) { result.skipped += 1; continue; }
                const stored = JSON.parse(await blob.text()) as IMessageCloudStoredMessage;
                if (isCloudStoredMessage(stored) && stored.lineId === target.lineId) {
                    storedMessages.push(stored);
                } else {
                    result.skipped += 1;
                }
            } catch (err) {
                result.errors.push(`${object.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        const sortedStored = storedMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const stored of sortedStored) {
            let imageDataUrl: string | undefined;
            if (stored.image) {
                try {
                    imageDataUrl = await loadStoredImageDataUrl(cloudConfig, stored.image);
                } catch (err) {
                    result.errors.push(`${stored.externalId}: photo could not be loaded (${err instanceof Error ? err.message : String(err)})`);
                }
            }
            const { inserted } = upsertImportedChatMessage(makeImportedMessage(stored, imageDataUrl));
            if (inserted) { result.added += 1; touchedSessionIds.add(stored.sessionId); } else { result.skipped += 1; }
        }
    }

    for (const sessionId of touchedSessionIds) reindexSessionMessageOrdersByTime(sessionId);
    result.sessionIds = Array.from(touchedSessionIds);
    return result;
}

export { IMESSAGE_CLOUD_PREFIX, messagePath as imessageCloudMessagePath, runtimeSnapshotPath as imessageCloudRuntimeSnapshotPath };
export type { IMessageLineBinding };

const AUTO_PULL_INTERVAL_MS = 30_000;

/**
 * Keeps the local Chat timeline in step with what the webhook wrote to Supabase.
 * Pulls once on start, again whenever the tab becomes visible, and every 30 s while it is.
 * Does nothing (and costs nothing) until at least one enabled line and a configured
 * cloud backup exist. Returns a stop function.
 */
export function startIMessageCloudSync(): () => void {
    if (typeof window === "undefined") return () => {};

    let stopped = false;
    let inFlight = false;

    const shouldRun = () =>
        isCloudBackupConfigured(loadCloudBackupConfig()) && loadIMessageLines().some((line) => line.enabled);

    const pullNow = async () => {
        if (stopped || inFlight || document.visibilityState !== "visible" || !shouldRun()) return;
        inFlight = true;
        try {
            const result = await pullIMessageCloudMessages();
            for (const sessionId of result.sessionIds) {
                window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
            }
            if (result.errors.length > 0) console.warn("[IMessageCloudSync] pull errors:", result.errors);
        } catch (err) {
            console.warn("[IMessageCloudSync] auto pull failed:", err);
        } finally {
            inFlight = false;
        }
    };

    const onVisibility = () => { void pullNow(); };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => { void pullNow(); }, AUTO_PULL_INTERVAL_MS);
    void pullNow();

    return () => {
        stopped = true;
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibility);
    };
}
