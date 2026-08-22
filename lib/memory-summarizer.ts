// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** Manual start point for the summary, overriding the stored progress mark; ignored when force is set */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "No memory-summary API configured. Set one in Settings -> Binding Manager -> Auxiliary API." };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    const allEntries = loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined);

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0
                ? "This character has no events of its own to summarize yet. Long-term memory is built from what THIS character took part in; what other characters wrote about them is read at prompt time instead, and appears under \"Heard secondhand\"."
                : "Fewer than 4 events to summarize." };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "Could not format the event data." };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "The model returned empty content." };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "The summary looks truncated, so it was not saved. Retry, or raise the model's output limit." };
    }

    const summary = result.content;

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // Save as long-term memory
    const now = new Date().toISOString();
    const longTermEntry: MemoryEntry = {
        id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        content: summary,
        embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}
