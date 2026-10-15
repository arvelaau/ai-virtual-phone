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
    CHAT_MESSAGE_PUSHED_EVENT,
    createOrGetSession,
    getLatestCharacterStateValues,
    hydrateChatStorage,
    loadChatAppSettings,
    loadChatMessages,
    reindexSessionMessageOrdersByTime,
    type ChatMessage,
} from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { runChatPluginTransform } from "./chat-plugin-hooks";
import { buildChatPluginPromptFragments } from "./chat-plugin-storage";
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
import { loadIMessageLines, recordIMessageMirror } from "./imessage-storage";
import { buildCharacterTimeContext, getSystemTimeZone } from "./character-time";
import {
    TIME_TOKEN_BLOCK,
    TIME_TOKEN_CHARACTER_TIME,
    TIME_TOKEN_CHARACTER_WEEKDAY,
    TIME_TOKEN_NOW,
    TIME_TOKEN_WEEKDAY,
    type IMessageTimeSettings,
} from "./imessage-time";
import { generateImageFromConfiguredApi, isImageGenerationAvailableFor } from "./image-generation-service";
import { resolveVoiceConfig, synthesizeSpeech } from "./tts-service";
import { decideMirror, lastLocalUserMessageAt, mirrorJobId, normalizeMirrorMode } from "./imessage-mirror";
import {
    buildTextJob,
    isMediaJob,
    JOB_LEASE_MS,
    MAX_JOB_ATTEMPTS,
    mediaJobAudioPath,
    mediaJobImagePath,
    mediaJobPath,
    mediaJobPrefix,
    selectRunnableJobs,
    type IMessageMediaJob,
} from "./imessage-media-jobs";
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

/**
 * Lets the user's chat plugins rewrite the template the way they rewrite a live request.
 *
 * Plugins run in the browser, never on the server, so this is the only moment they can act on
 * an iMessage reply. The history slot is handed over as the final USER message (that is where
 * a live request puts the newest message), then found again afterwards. Anything that goes
 * wrong -> the untouched template, so a broken plugin can never stop the sync.
 *
 * What cannot carry over: a plugin that reacts to the content of the incoming message, and
 * llm.response (it runs on the reply, which is generated on the server).
 */
export async function applyChatPluginsToTemplate(
    messages: LLMMessage[],
    sessionId: string,
): Promise<{ messages: LLMMessage[]; applied: boolean }> {
    const holdsSlot = (message: LLMMessage) => (
        typeof message.content === "string"
            ? message.content.includes(IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN)
            : message.content.some((part) => part.type === "text" && part.text.includes(IMESSAGE_CLOUD_HISTORY_SLOT_TOKEN))
    );
    try {
        let slotIndex = -1;
        messages.forEach((message, i) => { if (holdsSlot(message)) slotIndex = i; });
        if (slotIndex < 0) return { messages, applied: false };

        const forPlugins = messages.map((message, i) => (i === slotIndex ? { ...message, role: "user" as const } : { ...message }));
        const before = JSON.stringify(forPlugins);
        const payload = await runChatPluginTransform("llm.request", {
            messages: forPlugins as unknown as Array<{ role: string; content: unknown }>,
            purpose: "chat",
            sessionId,
        });
        const next = payload.messages as unknown as LLMMessage[] | undefined;
        if (!Array.isArray(next) || next.length === 0 || !next.some(holdsSlot)) return { messages, applied: false };
        if (JSON.stringify(next) === before) return { messages, applied: false };
        return { messages: next, applied: true };
    } catch {
        return { messages, applied: false };
    }
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

    // The same extra prompt text a live chat gets from the user's chat plugins.
    let pluginPromptHint = "";
    try {
        const pluginPrompt = await runChatPluginTransform("prompt.system", {
            sessionId: session.id,
            isGroup: false,
            characterId: character.id,
            hint: buildChatPluginPromptFragments(session.id),
        });
        if (pluginPrompt.hint?.trim()) pluginPromptHint = `\n\n### Plugins\n${pluginPrompt.hint.trim()}\n`;
    } catch { /* a broken plugin must not stop the sync */ }

    // "Now" is not known until a message arrives, so the template carries tokens and the server
    // fills them in per reply (lib/imessage-time.ts). Otherwise the clock, the weekday and the
    // time-zone block would stay frozen at whenever Sync to cloud was last pressed.
    const systemTimeZone = getSystemTimeZone();
    const realTime = buildCharacterTimeContext(character.timeZone, new Date(), systemTimeZone);
    const timeSettings: IMessageTimeSettings = {
        timeAware: chatAppSettings.timeAware !== false,
        systemTimeZone,
        characterTimeZone: character.timeZone?.trim() || undefined,
        includeTimeZone: realTime.hasDifference,
    };
    const tokenTime = {
        ...realTime,
        timeContext: TIME_TOKEN_BLOCK,
        // These only exist while the two clocks differ; a token for them would print blanks otherwise
        characterTime: realTime.hasDifference ? TIME_TOKEN_CHARACTER_TIME : "",
        characterWeekday: realTime.hasDifference ? TIME_TOKEN_CHARACTER_WEEKDAY : "",
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
        // A keyword entry is switched on by words in the NEWEST message. That message does not
        // exist yet when this template is built, so matching keywords here would silently leave
        // those entries out of every reply. Include every enabled entry instead.
        activateAllWorldBooks: true,
        timeContext: tokenTime,
        promptTimestampOptions: { timeZone: systemTimeZone, includeTimeZone: realTime.hasDifference },
        timeTokens: { now: TIME_TOKEN_NOW, weekday: TIME_TOKEN_WEEKDAY },
        customAppRichMediaDirectives: pluginPromptHint,
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

    const assembledTemplate = buildMessages([...promptHistory, slotMessage]);
    const withPlugins = await applyChatPluginsToTemplate(assembledTemplate, session.id);
    const split = splitPromptMessagesAtHistorySlot(withPlugins.messages);
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
        // Real pictures need image generation, which only the browser can run, so whether a line
        // may promise them is decided here, at sync time.
        capabilities: {
            photos: line.sendPhotos !== false && isImageGenerationAvailableFor(character.id),
            // a spoken note needs a voice bound to this character (settings live in this browser)
            voice: line.sendVoice !== false && resolveVoiceConfig(character.id, "chat") !== null,
        },
        timeSettings,
        promptBuild: {
            allWorldBookEntries: true,
            pluginPromptHint: pluginPromptHint.length > 0,
            pluginRequestHookApplied: withPlugins.applied,
        },
        stats: { messageCount: rawMessages.length, memoryCount: memories.length },
    };
}

export async function syncIMessageLineRuntimeToCloud(
    lineId: string,
    options?: { cloudConfig?: CloudBackupConfig; messageLimit?: number },
): Promise<{
    path: string;
    bytes: number;
    slotFound: boolean;
    worldBookCount: number;
    pluginPromptHint: boolean;
    pluginRequestHookApplied: boolean;
}> {
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

    return {
        path,
        bytes,
        slotFound: snapshot.promptTemplate.slotFound !== false,
        worldBookCount: snapshot.worldBooks.length,
        pluginPromptHint: snapshot.promptBuild?.pluginPromptHint === true,
        pluginRequestHookApplied: snapshot.promptBuild?.pluginRequestHookApplied === true,
    };
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
            // A mirror of a message the character already sent in this app: it is in the
            // local chat, and importing it again would show every proactive message twice.
            if (stored.localMessageId) { result.skipped += 1; continue; }
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

// ── Photos the character wants to send over real iMessage ─────────────────────────
// The webhook only records what the character wanted to send (a job, see
// lib/imessage-media-jobs.ts). Generating the picture needs this app's image settings and
// reference images, so it happens here, in the browser, and the finished picture is handed to
// /api/imessage/send-media for delivery. Jobs are therefore delivered only while the app is open.

export type IMessageMediaJobRunResult = { checked: number; delivered: number; fallbacks: number; errors: string[] };

let mediaJobsRunning = false;

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
        reader.onload = () => {
            const text = String(reader.result || "");
            const comma = text.indexOf(",");
            resolve(comma >= 0 ? text.slice(comma + 1) : text);
        };
        reader.readAsDataURL(blob);
    });
}

/** A generated picture can be several MB as PNG; an iMessage photo does not need to be. */
async function pictureForUpload(blob: Blob): Promise<{ mimeType: string; dataBase64: string }> {
    try {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no canvas");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        if (jpeg && jpeg.size > 0) return { mimeType: "image/jpeg", dataBase64: await blobToBase64(jpeg) };
    } catch {
        // fall through to the original bytes
    }
    return { mimeType: blob.type || "image/png", dataBase64: await blobToBase64(blob) };
}

async function readMediaJob(config: CloudBackupConfig, path: string): Promise<IMessageMediaJob | null> {
    try {
        const blob = await getObject(config, path);
        if (!blob) return null;
        const parsed = JSON.parse(await blob.text());
        return isMediaJob(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

async function writeMediaJob(config: CloudBackupConfig, job: IMessageMediaJob): Promise<void> {
    await putObject(config, mediaJobPath(IMESSAGE_CLOUD_PREFIX, job.lineId, job.id), JSON.stringify(job), "application/json");
}

async function requestDelivery(
    job: IMessageMediaJob,
    fallback?: { reason: string },
): Promise<{ ok: boolean; code: string; detail?: string }> {
    const response = await fetch("/api/imessage/send-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            lineId: job.lineId,
            jobId: job.id,
            token: job.token,
            ...(fallback ? { fallback: true, reason: fallback.reason } : {}),
        }),
    });
    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    return {
        ok: response.ok && data.ok !== false,
        code: typeof data.code === "string" ? data.code : `http_${response.status}`,
        detail: typeof data.detail === "string" ? data.detail : undefined,
    };
}

/** A clip above this is not worth uploading; a spoken sentence or two is a few hundred KB. */
const MAX_VOICE_UPLOAD_BYTES = 6 * 1024 * 1024;

async function runVoiceJob(config: CloudBackupConfig, job: IMessageMediaJob, result: IMessageMediaJobRunResult): Promise<void> {
    const report = (code: string, detail?: string) => result.errors.push(`voice ${job.id}: ${code}${detail ? ` (${detail})` : ""}`);

    // The clip already exists; only delivery is missing.
    if (job.status === "ready") {
        const delivery = await requestDelivery(job);
        if (delivery.ok) result.delivered += 1;
        else if (delivery.code === "audio_not_ready") await writeMediaJob(config, { ...job, status: "pending", updatedAt: new Date().toISOString() });
        else report(delivery.code, delivery.detail);
        return;
    }

    const leased: IMessageMediaJob = {
        ...job,
        status: "generating",
        attempts: job.attempts + 1,
        leaseUntil: Date.now() + JOB_LEASE_MS,
        updatedAt: new Date().toISOString(),
    };
    await writeMediaJob(config, leased);

    let failure = "";
    let clip: { mimeType: string; dataBase64: string } | null = null;
    const voiceConfig = resolveVoiceConfig(job.characterId, "chat");
    try {
        if (!voiceConfig) throw new Error("no voice is set up for this character");
        const blob = await synthesizeSpeech(job.text || "", voiceConfig);
        if (!blob || blob.size === 0) throw new Error("speech synthesis returned nothing");
        if (blob.size > MAX_VOICE_UPLOAD_BYTES) throw new Error("the spoken clip is too large");
        clip = { mimeType: blob.type || "audio/mpeg", dataBase64: await blobToBase64(blob) };
    } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
    }

    if (!clip) {
        if (!voiceConfig || leased.attempts >= MAX_JOB_ATTEMPTS) {
            // Out of road: the words go out as text instead of leaving the user hanging.
            const delivery = await requestDelivery(leased, { reason: failure });
            if (delivery.ok) result.fallbacks += 1;
            else report(delivery.code, delivery.detail);
        } else {
            await writeMediaJob(config, { ...leased, status: "pending", leaseUntil: undefined, error: failure.slice(0, 200), updatedAt: new Date().toISOString() });
            report("synthesis failed, will retry", failure.slice(0, 120));
        }
        return;
    }

    await putObject(config, mediaJobAudioPath(IMESSAGE_CLOUD_PREFIX, job.lineId, job.id), JSON.stringify(clip), "application/json");
    const ready: IMessageMediaJob = { ...leased, status: "ready", leaseUntil: undefined, error: undefined, updatedAt: new Date().toISOString() };
    await writeMediaJob(config, ready);

    const delivery = await requestDelivery(ready);
    if (delivery.ok) result.delivered += 1;
    else report(delivery.code, delivery.detail);
}

async function runMediaJob(config: CloudBackupConfig, job: IMessageMediaJob, result: IMessageMediaJobRunResult): Promise<void> {
    if (job.kind === "voice") {
        await runVoiceJob(config, job, result);
        return;
    }

    // A mirrored text: nothing to generate, only delivery to retry.
    if (job.kind === "text") {
        const delivery = await requestDelivery(job);
        if (delivery.ok) result.delivered += 1;
        else result.errors.push(`text ${job.id}: ${delivery.code}${delivery.detail ? ` (${delivery.detail})` : ""}`);
        return;
    }

    // The picture already exists; only delivery is missing.
    if (job.status === "ready") {
        const delivery = await requestDelivery(job);
        if (delivery.ok) result.delivered += 1;
        else if (delivery.code === "image_not_ready") await writeMediaJob(config, { ...job, status: "pending", updatedAt: new Date().toISOString() });
        else result.errors.push(`photo ${job.id}: ${delivery.code}${delivery.detail ? ` (${delivery.detail})` : ""}`);
        return;
    }

    const leased: IMessageMediaJob = {
        ...job,
        status: "generating",
        attempts: job.attempts + 1,
        leaseUntil: Date.now() + JOB_LEASE_MS,
        updatedAt: new Date().toISOString(),
    };
    await writeMediaJob(config, leased);

    let generated: Awaited<ReturnType<typeof generateImageFromConfiguredApi>> = null;
    let failure = "";
    try {
        if (!isImageGenerationAvailableFor(job.characterId)) throw new Error("image generation is not set up in this app");
        generated = await generateImageFromConfiguredApi({
            description: job.description,
            characterId: job.characterId,
            appId: "chat",
            useReferenceImage: job.withRef,
            photoStyle: true,
        });
        if (!generated) throw new Error("image generation returned nothing");
    } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
    }

    if (!generated) {
        const notSetUp = !isImageGenerationAvailableFor(job.characterId);
        if (notSetUp || leased.attempts >= MAX_JOB_ATTEMPTS) {
            // Out of road: say what the picture was instead of leaving the user hanging.
            const delivery = await requestDelivery(leased, { reason: failure });
            if (delivery.ok) result.fallbacks += 1;
            else result.errors.push(`photo ${job.id}: ${delivery.code}${delivery.detail ? ` (${delivery.detail})` : ""}`);
        } else {
            await writeMediaJob(config, { ...leased, status: "pending", leaseUntil: undefined, error: failure.slice(0, 200), updatedAt: new Date().toISOString() });
            result.errors.push(`photo ${job.id}: generation failed, will retry (${failure.slice(0, 120)})`);
        }
        return;
    }

    const picture = await pictureForUpload(generated.blob);
    await putObject(
        config,
        mediaJobImagePath(IMESSAGE_CLOUD_PREFIX, job.lineId, job.id),
        JSON.stringify(picture),
        "application/json",
    );
    const ready: IMessageMediaJob = { ...leased, status: "ready", leaseUntil: undefined, error: undefined, updatedAt: new Date().toISOString() };
    await writeMediaJob(config, ready);

    const delivery = await requestDelivery(ready);
    if (delivery.ok) result.delivered += 1;
    else result.errors.push(`photo ${job.id}: ${delivery.code}${delivery.detail ? ` (${delivery.detail})` : ""}`);
}

/**
 * Generates and delivers the photos queued by the webhook. One job per call by default (an
 * image can take minutes); the periodic sync calls this again. Safe to call concurrently:
 * a second call while one is running returns immediately.
 */
export async function processIMessageMediaJobs(
    options?: { cloudConfig?: CloudBackupConfig; maxJobs?: number },
): Promise<IMessageMediaJobRunResult> {
    const result: IMessageMediaJobRunResult = { checked: 0, delivered: 0, fallbacks: 0, errors: [] };
    if (mediaJobsRunning) return result;
    const config = options?.cloudConfig ?? loadCloudBackupConfig();
    if (!isCloudBackupConfigured(config)) return result;
    mediaJobsRunning = true;
    try {
        await hydrateChatStorage();
        const now = Date.now();
        for (const line of loadIMessageLines().filter((item) => item.enabled)) {
            let objects;
            try {
                objects = await listObjects(config, mediaJobPrefix(IMESSAGE_CLOUD_PREFIX, line.id), 50);
            } catch (err) {
                result.errors.push(`${line.phone}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            const jobs: IMessageMediaJob[] = [];
            for (const object of objects) {
                if (!object.name || object.name.endsWith("/")) continue;
                const job = await readMediaJob(config, `${mediaJobPrefix(IMESSAGE_CLOUD_PREFIX, line.id)}${object.name}`);
                if (job && job.lineId === line.id) jobs.push(job);
            }
            for (const job of selectRunnableJobs(jobs, now, options?.maxJobs ?? 1)) {
                result.checked += 1;
                try {
                    await runMediaJob(config, job, result);
                } catch (err) {
                    result.errors.push(`photo ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    } finally {
        mediaJobsRunning = false;
    }
    return result;
}
// ── Messages the character writes first, in the app, mirrored onto iMessage ─────────
// Follow-ups, timed wake-ups and chat plugins that make the character write first all end up
// in the local chat through pushChatMessage and fire CHAT_MESSAGE_PUSHED_EVENT. The decision
// is lib/imessage-mirror.ts; this turns an approved message into a "text" job and asks the
// delivery route to send it. Only while the app is open, which is also the only time those
// messages can be created.

const mirroredLocalIds = new Set<string>();
const mirrorSendTimes = new Map<string, number[]>();

function newSecret(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return `${c.randomUUID()}${c.randomUUID()}`.replace(/-/g, "");
    return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export async function mirrorLocalMessageToIMessage(
    message: ChatMessage,
    options?: { cloudConfig?: CloudBackupConfig },
): Promise<{ sent: boolean; reason: string }> {
    if (mirroredLocalIds.has(message.id)) return { sent: false, reason: "already_mirrored" };
    const config = options?.cloudConfig ?? loadCloudBackupConfig();
    if (!isCloudBackupConfigured(config)) return { sent: false, reason: "no_cloud_backup" };

    await hydrateChatStorage();
    for (const line of loadIMessageLines().filter((item) => item.enabled)) {
        const session = createOrGetSession(line.characterId);
        if (session.id !== message.sessionId) continue;

        const now = Date.now();
        const createdAt = Date.parse(message.createdAt);
        const decision = decideMirror({
            mode: normalizeMirrorMode(line.mirrorMode),
            message,
            isGroup: Boolean(session.isGroup),
            lastLocalUserAt: lastLocalUserMessageAt(loadChatMessages(session.id), Number.isFinite(createdAt) ? createdAt : now),
            recentMirrorTimes: mirrorSendTimes.get(line.id),
            now,
        });
        // The user's own typing is not a mirror candidate; every other outcome for a chat that
        // has a line is written down, so "why did it not arrive" has an answer.
        const log = (sent: boolean, reason: string, detail?: string) => {
            if (reason === "not_assistant") return;
            recordIMessageMirror({ lineId: line.id, sent, reason, detail, text: message.content ?? "" });
        };
        if (!decision.send) {
            log(false, decision.reason);
            return { sent: false, reason: decision.reason };
        }

        mirroredLocalIds.add(message.id);
        const jobId = mirrorJobId(message.id);
        // A job that already exists means this message was handled (possibly by another tab).
        if (await getObject(config, mediaJobPath(IMESSAGE_CLOUD_PREFIX, line.id, jobId))) {
            return { sent: false, reason: "already_mirrored" };
        }
        // Claimed up front with a short lease: the periodic runner will not pick this job up
        // while this call is still in flight, but will retry it if the call fails.
        const job: IMessageMediaJob = {
            ...buildTextJob({
                id: jobId,
                token: newSecret(),
                lineId: line.id,
                characterId: line.characterId,
                sessionId: session.id,
                text: message.content.trim(),
                localMessageId: message.id,
                now,
            }),
            status: "generating",
            attempts: 1,
            leaseUntil: now + 60_000,
        };
        await writeMediaJob(config, job);
        const delivery = await requestDelivery(job).catch((err): { ok: boolean; code: string; detail?: string } => ({
            ok: false,
            code: "network_error",
            detail: err instanceof Error ? err.message.slice(0, 120) : undefined,
        }));
        if (delivery.ok) {
            mirrorSendTimes.set(line.id, [...(mirrorSendTimes.get(line.id) ?? []).filter((t) => t > now - 3600_000), now]);
        }
        log(delivery.ok, delivery.ok ? decision.reason : delivery.code, delivery.ok ? undefined : delivery.detail);
        return { sent: delivery.ok, reason: delivery.ok ? decision.reason : delivery.code };
    }
    return { sent: false, reason: "no_bound_line" };
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
        // Photos the character queued are generated here and delivered, then pulled in so
        // they show up in Chat too. Not awaited: an image can take minutes.
        void processIMessageMediaJobs()
            .then(async (run) => {
                if (run.errors.length > 0) console.warn("[IMessageCloudSync] photo jobs:", run.errors);
                if (stopped || run.delivered + run.fallbacks === 0) return;
                const pulled = await pullIMessageCloudMessages();
                for (const sessionId of pulled.sessionIds) {
                    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
                }
            })
            .catch((err) => console.warn("[IMessageCloudSync] photo job run failed:", err));
    };

    // Anything the character starts in the app goes out over iMessage too (per-line mode).
    const onPushed = (event: Event) => {
        const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
        if (!message || stopped || !shouldRun()) return;
        void mirrorLocalMessageToIMessage(message).catch((err) => console.warn("[IMessageCloudSync] mirror failed:", err));
    };
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, onPushed);

    const onVisibility = () => { void pullNow(); };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => { void pullNow(); }, AUTO_PULL_INTERVAL_MS);
    void pullNow();

    return () => {
        stopped = true;
        window.clearInterval(timer);
        window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, onPushed);
        document.removeEventListener("visibilitychange", onVisibility);
    };
}
