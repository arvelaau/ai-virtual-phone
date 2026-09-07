// lib/proactive-cloud-sync.ts
// Builds the per-character data package that gets uploaded to the deployed
// Cloudflare Worker (Proactive Message 2.0). See PROACTIVE-MESSAGE-2.0-PLAN.md
// at the repo root.
//
// Modeled closely on lib/weixin-cloud-sync.ts's buildWeixinCloudRuntimeSnapshot
// / buildWeixinCloudPromptContext — that file already solved "package
// everything needed to generate a reply outside the browser." This is a
// parallel, purpose-built version for the three existing proactive
// mechanisms (lib/follow-up-service.ts) instead of the WeChat bridge.
//
// Known, deliberate limitation (documented in the plan): unlike the weixin
// path, which polls every 5-8s, a proactive message fires hours later, so
// the baked context (persona, schedule, memory, {{time}}-style macros) is
// only "as of last sync," not live. Re-sync on character edits / app open,
// not on a tight timer. Also out of scope for this pass (kept simple on
// purpose, revisit if proactive messages need them): image generation and
// native-tool-calling context.

import { createOrGetSession, getLatestCharacterStateValues, hydrateChatStorage, loadAllFollowUpSchedules, loadChatMessages, type StateValue } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import {
    loadApiConfigs,
    loadBindingConfig,
    loadPresets,
    loadRegexes,
    loadWorldBooks,
    resolveBinding,
    resolveUserIdentity,
    loadFollowUpConfig,
    ensureSettingsStorageHydrated,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { buildChatBilingualInstruction, buildMusicCloudMacro, buildMusicLocalMacro } from "./chat-engine";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { isNeteaseConfigured } from "./music-service";
import { loadTimedWakeSchedules, type TimedWakeSchedule } from "./timed-wake-storage";
import { getMenstrualPeriodCareEvent, loadMenstrualConfig, loadMenstrualRecords } from "./menstrual-storage";
import { isProactiveCloudSyncEnabled } from "./proactive-cloud-storage";
import { loadPushNotificationConfig } from "./push-notification-storage";
import { deleteSnapshotFromWorker, uploadSnapshotToWorker } from "./proactive-worker-client";

const PROACTIVE_FOLLOW_UP_APP_TAGS = ["chat", "text", "followup"];
const PROACTIVE_TIMED_WAKE_APP_TAGS = ["chat", "text", "timed_wake"];
const PROACTIVE_PERIOD_CARE_APP_TAGS = ["chat", "text", "period_care"];
const RECENT_MESSAGE_LIMIT = 60; // enough for short-term context; proactive messages don't need full history

export type ProactiveMechanism = "follow_up" | "timed_wake" | "period_care";

export type ProactivePromptTemplate = {
    mechanism: ProactiveMechanism;
    appTags: string[];
    /** Fully assembled, ready to send as the `messages` array of a chat completion request. */
    messages: LLMMessage[];
    builtAt: string;
};

export type ProactiveTimedWakeEntry = {
    id: string;
    fireAt: number;
    delayMinutes: number;
    intent: string;
};

/** Mirrors chat-storage.ts's FollowUpSchedule — a session has at most one pending entry. */
export type ProactiveFollowUpEntry = {
    sessionId: string;
    fireAt: number;
    count: number;
    delaySec?: number;
};

export type ProactiveCharacterSnapshot = {
    format: "ai-phone-proactive-snapshot";
    version: 1;
    characterId: string;
    characterName: string;
    createdAt: string;
    apiConfig: ApiConfig;
    latestStateValues: StateValue[];
    followUp: {
        anxietyFieldName: string;
        anxietyThreshold: number;
        anxietyMinDelay: number;
        anxietyMaxDelay: number;
        /** Real pending schedule(s) from lib/follow-up-service.ts's scheduleFollowUp — the
         *  Worker fires whichever is due, it does not re-derive eligibility from anxiety alone. */
        schedules: ProactiveFollowUpEntry[];
        template: ProactivePromptTemplate;
    };
    timedWake: {
        schedules: ProactiveTimedWakeEntry[];
        template: ProactivePromptTemplate;
    };
    periodCare: {
        enabled: boolean;
        /** From getMenstrualPeriodCareEvent — synced as-is rather than re-implementing the
         *  cycle-date math in the Worker. Null when not due at sync time. */
        cycleKey: string | null;
        template: ProactivePromptTemplate | null;
    };
};

type SharedPromptContext = Awaited<ReturnType<typeof buildSharedPromptContext>>;

async function buildSharedPromptContext(character: Character, session: ReturnType<typeof createOrGetSession>) {
    const bindings = loadBindingConfig();
    const bindingSlot = resolveBinding(bindings, character.id, "chat");

    const apiConfig = bindingSlot.apiConfigId
        ? loadApiConfigs().find((item) => item.id === bindingSlot.apiConfigId)
        : undefined;
    if (!apiConfig) throw new Error(`Character "${character.name}" has no API config bound for chat.`);

    const presets = loadPresets();
    const preset = bindingSlot.presetId
        ? presets.find((item) => item.id === bindingSlot.presetId) ?? presets.find((item) => item.builtIn) ?? null
        : presets.find((item) => item.builtIn) ?? null;

    const allWorldBooks = loadWorldBooks();
    const worldBooks = (bindingSlot.worldBookIds || [])
        .map((id) => allWorldBooks.find((item) => item.id === id))
        .filter((item): item is WorldBookConfig => Boolean(item));

    const allRegexes = loadRegexes();
    const regexes = (bindingSlot.regexIds || [])
        .map((id) => allRegexes.find((item) => item.id === id))
        .filter((item): item is RegexConfig => Boolean(item));

    const rawHistory = loadChatMessages(session.id, RECENT_MESSAGE_LIMIT);
    const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
        character.id,
        "chat",
        { history: rawHistory, includeNativeToolHistory: false, timeAware: true },
    );

    const memoryConfig = loadMemoryConfig();
    const [memResults, coreResults, musicLocal, musicCloud] = await Promise.all([
        retrieveMemoriesForPrompt(character.id, wbActivationContext, memoryConfig).catch(() => null),
        retrieveCoreMemoriesForPrompt(character.id, memoryConfig).catch(() => null),
        buildMusicLocalMacro(),
        buildMusicCloudMacro(),
    ]);

    const now = new Date();
    return {
        apiConfig,
        preset,
        worldBooks,
        regexes,
        history: truncatedHistory,
        recentBlocks,
        unifiedRecentItems,
        worldBookActivationContext: wbActivationContext,
        userIdentity: resolveUserIdentity(character.id, "chat"),
        initialStateValues: getLatestCharacterStateValues(character.id),
        longTermMemories: memResults ? formatLongTermMemories(memResults) : "",
        coreMemories: coreResults ? formatCoreMemories(coreResults) : "",
        scheduleSummary: buildCalendarScheduleMarker("character", character.id, getWeekStartIso(now)),
        currentSchedule: getCurrentCalendarScheduleForPrompt("character", character.id, now),
        customStickerNames: getCustomStickerNames(character.id),
        customStickerExample: getCustomStickerExample(character.id),
        musicLocal,
        musicCloud,
        musicOnlineHint: isNeteaseConfigured() ? "- You may recommend any song; the system searches and plays it online. Not limited to the user's local library.\n" : "\n",
        chatBilingualInstruction: buildChatBilingualInstruction(
            session.bilingualTranslationEnabled !== false,
            "single",
            session.bilingualTranslationPrompt,
        ),
    };
}

function buildTemplateFromSharedContext(
    character: Character,
    shared: SharedPromptContext,
    mechanism: ProactiveMechanism,
    appTags: string[],
    extra: { followUpCount?: number; followUpDelay?: number; timedWakeElapsedMinutes?: number; timedWakeIntent?: string; periodCareContext?: string },
): ProactivePromptTemplate {
    const messages = assemblePromptPayload({
        character,
        history: shared.history,
        preset: shared.preset,
        worldBooks: shared.worldBooks,
        regexes: shared.regexes,
        userIdentity: shared.userIdentity,
        appId: "chat",
        appTags,
        initialStateValues: shared.initialStateValues,
        scheduleSummary: shared.scheduleSummary,
        currentSchedule: shared.currentSchedule,
        coreMemories: shared.coreMemories,
        longTermMemories: shared.longTermMemories,
        worldBookActivationContext: shared.worldBookActivationContext,
        recentBlocks: shared.recentBlocks,
        unifiedRecentItems: shared.unifiedRecentItems,
        customStickerNames: shared.customStickerNames,
        customStickerExample: shared.customStickerExample,
        musicLocal: shared.musicLocal,
        musicCloud: shared.musicCloud,
        musicOnlineHint: shared.musicOnlineHint,
        chatBilingualInstruction: shared.chatBilingualInstruction,
        timeAware: true,
        ...extra,
    });
    return { mechanism, appTags, messages, builtAt: new Date().toISOString() };
}

/**
 * Builds the full snapshot for one opted-in character. Throws if the
 * character isn't opted in, doesn't exist, or has no chat API config bound —
 * callers should check isProactiveCloudSyncEnabled() first for UI purposes.
 */
export async function buildProactiveCharacterSnapshot(characterId: string): Promise<ProactiveCharacterSnapshot> {
    if (!isProactiveCloudSyncEnabled(characterId)) {
        throw new Error("This character is not opted in to proactive cloud sync.");
    }
    await Promise.all([hydrateChatStorage(), ensureSettingsStorageHydrated()]);

    const character = loadCharacters().find((item) => item.id === characterId);
    if (!character) throw new Error("Character not found.");

    const session = createOrGetSession(character.id);
    const shared = await buildSharedPromptContext(character, session);

    const followUpConfig = loadFollowUpConfig();
    const followUpSchedules: ProactiveFollowUpEntry[] = loadAllFollowUpSchedules()
        .filter((s) => s.sessionId === session.id);
    const followUpTemplate = buildTemplateFromSharedContext(character, shared, "follow_up", PROACTIVE_FOLLOW_UP_APP_TAGS, {
        // Real values when a schedule is pending; otherwise a placeholder so the
        // preset's {{followUpCount}}/{{followUpDelay}} macros still resolve to
        // something if this template is ever used without a matching schedule.
        followUpCount: (followUpSchedules[0]?.count ?? 0) + 1,
        followUpDelay: followUpSchedules[0]?.delaySec ?? followUpConfig.anxietyMinDelay,
    });

    const timedWakeSchedules: ProactiveTimedWakeEntry[] = loadTimedWakeSchedules()
        .filter((s: TimedWakeSchedule) => s.characterId === character.id)
        .map((s) => ({ id: s.id, fireAt: s.fireAt, delayMinutes: s.delayMinutes, intent: s.intent }));
    const timedWakeTemplate = buildTemplateFromSharedContext(character, shared, "timed_wake", PROACTIVE_TIMED_WAKE_APP_TAGS, {
        timedWakeElapsedMinutes: timedWakeSchedules[0]?.delayMinutes ?? 0,
        timedWakeIntent: timedWakeSchedules[0]?.intent ?? "",
    });

    const menstrualConfig = loadMenstrualConfig();
    const periodCareEnabled = menstrualConfig.periodCareEnabled && menstrualConfig.periodCareCharacterIds.includes(character.id);
    let periodCareTemplate: ProactivePromptTemplate | null = null;
    let periodCareCycleKey: string | null = null;
    if (periodCareEnabled) {
        const event = getMenstrualPeriodCareEvent(loadMenstrualRecords(), menstrualConfig);
        if (event) {
            periodCareCycleKey = event.cycleKey;
            periodCareTemplate = buildTemplateFromSharedContext(character, shared, "period_care", PROACTIVE_PERIOD_CARE_APP_TAGS, {
                periodCareContext: event.context,
            });
        }
    }

    return {
        format: "ai-phone-proactive-snapshot",
        version: 1,
        characterId: character.id,
        characterName: character.name,
        createdAt: new Date().toISOString(),
        apiConfig: shared.apiConfig,
        latestStateValues: shared.initialStateValues,
        followUp: {
            anxietyFieldName: followUpConfig.anxietyFieldName,
            anxietyThreshold: followUpConfig.anxietyThreshold,
            anxietyMinDelay: followUpConfig.anxietyMinDelay,
            anxietyMaxDelay: followUpConfig.anxietyMaxDelay,
            schedules: followUpSchedules,
            template: followUpTemplate,
        },
        timedWake: {
            schedules: timedWakeSchedules,
            template: timedWakeTemplate,
        },
        periodCare: {
            enabled: periodCareEnabled,
            cycleKey: periodCareCycleKey,
            template: periodCareTemplate,
        },
    };
}

/**
 * Builds this character's snapshot and uploads it to the deployed Worker.
 * No-op-with-error if no Worker has been deployed yet (Stage 2) or the
 * character isn't opted in (Stage 3 gate). Called on toggling opt-in on,
 * from a manual "Sync now" action, and (later) on relevant character edits.
 */
export async function syncProactiveCharacterToCloud(characterId: string): Promise<ProactiveCharacterSnapshot> {
    const { worker } = loadPushNotificationConfig();
    if (!worker) throw new Error("Deploy the Cloudflare Worker first (Settings > Proactive Push).");
    const snapshot = await buildProactiveCharacterSnapshot(characterId);
    await uploadSnapshotToWorker(worker.workerUrl, worker.accessToken, characterId, snapshot);
    return snapshot;
}

/** Deletes this character's already-uploaded data from the Worker (opt-out). No-op if no Worker is deployed. */
export async function removeProactiveCharacterFromCloud(characterId: string): Promise<void> {
    const { worker } = loadPushNotificationConfig();
    if (!worker) return;
    await deleteSnapshotFromWorker(worker.workerUrl, worker.accessToken, characterId);
}
