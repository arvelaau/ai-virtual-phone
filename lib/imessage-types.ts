// lib/imessage-types.ts
// Shared types for the real-iMessage bridge (Photon/Spectrum Cloud).

import type { Character } from "./character-types";
import type { ChatMessage, ChatSession } from "./chat-storage";
import type { LLMMessage } from "./llm-prompt-assembler";
import type { RecentBlock, UnifiedRecentItem } from "./short-term-assembler";
import type {
    ApiConfig,
    BindingSlot,
    PresetConfig,
    RegexConfig,
    WorldBookConfig,
} from "./settings-types";
import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { resolveUserIdentity } from "./settings-storage";
import { getLatestCharacterStateValues } from "./chat-storage";

/** One real iMessage phone number bound to one character. */
export type IMessageLineBinding = {
    id: string;
    phone: string; // E.164, e.g. "+15551234567" -- must match the "phone" Spectrum reports on the space
    characterId: string;
    enabled: boolean;
    nickname?: string;
    /** The shared Photon line this number must text. Filled by the enroll route; informational. */
    linePhone?: string;
    addedAt: string;
};

export type IMessageCloudPromptTemplate = {
    version: 1;
    slotToken: string;
    beforeMessages: LLMMessage[];
    afterMessages: LLMMessage[];
    baseHistoryLength: number;
    /**
     * False when the history slot could not be located in the assembled prompt and the whole
     * prompt was kept as the "before" part. Replies still work (the new message goes last), but
     * any instructions that were meant to follow the history are not repeated after it.
     */
    slotFound?: boolean;
    createdAt: string;
};

/**
 * Everything the server-side webhook needs to generate an in-character reply
 * without re-running the browser's whole prompt-assembly pipeline. Built and
 * uploaded from the browser (where persona/preset/worldbook/memory already
 * live); downloaded fresh by the webhook on each inbound message.
 */
export type IMessageCloudRuntimeSnapshot = {
    format: "ai-phone-imessage-runtime";
    version: 1;
    createdAt: string;
    line: IMessageLineBinding;
    character: Character;
    session: ChatSession;
    apiConfig: ApiConfig;
    preset: PresetConfig | null;
    worldBooks: WorldBookConfig[];
    regexes: RegexConfig[];
    bindingSlot: BindingSlot;
    userIdentity: ReturnType<typeof resolveUserIdentity>;
    memoryConfig: MemoryConfig;
    memories: MemoryEntry[];
    promptHistory: ChatMessage[];
    promptTemplate: IMessageCloudPromptTemplate;
    recentBlocks: RecentBlock[];
    unifiedRecentItems: UnifiedRecentItem[];
    worldBookActivationContext: string;
    initialStateValues: ReturnType<typeof getLatestCharacterStateValues>;
    longTermMemories: string;
    coreMemories: string;
    scheduleSummary: string;
    currentSchedule: string;
    stats: { messageCount: number; memoryCount: number };
};

export type IMessageCloudStoredMessage = {
    format: "ai-phone-imessage-cloud-message";
    version: 1;
    direction: "inbound" | "outbound";
    lineId: string;
    characterId: string;
    sessionId: string;
    externalId: string;
    createdAt: string;
    role: "user" | "assistant";
    content: string;
};

export type IMessageCloudRuntimeIndexItem = {
    lineId: string;
    phone: string;
    characterId: string;
    characterName: string;
    sessionId: string;
    path: string;
    updatedAt: string;
};

export type IMessageCloudRuntimeIndex = {
    format: "ai-phone-imessage-cloud-index";
    version: 1;
    updatedAt: string;
    lines: IMessageCloudRuntimeIndexItem[];
};

export type IMessageCloudMessagePullResult = {
    added: number;
    skipped: number;
    errors: string[];
    sessionIds: string[];
};
