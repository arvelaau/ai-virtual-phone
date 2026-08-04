// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `You are a memory-organizing assistant. Based on the event log below, write a concise, factual summary.

Character: {{char}}
Time span: {{earliest}} to {{latest}}

Event log:
{{events}}

Requirements:
- Describe the interactions between {{char}} and the user in the third person
- Preserve key facts: names mentioned, promises made, emotional shifts, relationship milestones
- Preserve specific details the user shared (birthdays, preferences, habits)
- Preserve key information from non-chat events such as Moments posts
- 100-200 words
- Do not include any formatting markup

Summary:`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `You are a core-memory assistant. Based on the long-term memory records below, write a "core memory" summary for {{char}}.

Character: {{char}}
Time span: {{earliest}} to {{latest}}

Long-term memory records:
{{events}}

Goal: highlight the most critical and most stable facts — the ones that most affect how the relationship is judged.

Include:
- Confirmed getting together / confirmed breakup / getting back together
- Engagement / marriage / divorce
- Dating anniversaries, wedding anniversaries, how long they have been together
- Explicit long-term relationship roles (e.g. partner, ex, spouse)
- Major shared-life milestones (e.g. moving in together, meeting the family, adopting a pet together)

Exclude:
- Ordinary day-to-day chitchat
- General mood swings
- Temporary conflicts or ambiguity
- Ordinary preference information
- Anything uncertain or speculative

Format:
- Third person, factual description
- 80-180 words
- Do not use JSON, list markers, headings, or formatting markup

Core memory summary:`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
};
