// lib/review-engine.ts — LLM integration for the Review app.
// Two discussion modes (spoiler-safe / unrestricted) and one review-writing call, all going
// through the real preset system via assemblePromptPayload, mirroring lib/reading-engine.ts.

import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import {
  resolveBinding,
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  loadUserIdentities,
} from "./settings-storage";
import { assemblePromptPayload, type AssemblerInput, type LLMMessage } from "./llm-prompt-assembler";
import type { ApiConfig, PresetConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { parseJsonLike } from "./llm-json-parse";
import type {
  PublishedReview,
  ReviewDiscussionMessage,
  ReviewDiscussMode,
  ReviewJournalEntry,
  ReviewTitle,
} from "./review-types";
import { makeReviewRating } from "./review-types";

const REVIEW_APP_ID = "review";

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

/** Which discussion-mode tag pair applies right now, per the title's *current* status --
 * resolved per-message at send time, so a single thread can legitimately contain both
 * spoiler-safe and unrestricted turns if the user marks the title finished mid-conversation. */
export function resolveDiscussMode(title: ReviewTitle): ReviewDiscussMode {
  return title.status === "finished" ? "discuss_free" : "discuss_safe";
}

function formatJournalHistory(entries: ReviewJournalEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => `- (${entry.authorType === "character" ? entry.authorName : "user"}) ${entry.body}`)
    .join("\n");
}

function formatDiscussionHistory(messages: ReviewDiscussionMessage[]): string {
  if (messages.length === 0) return "";
  return messages.map((msg) => `${msg.authorType === "character" ? "them" : "user"}: ${msg.content}`).join("\n");
}

function yearSuffix(year?: string): string {
  return year ? ` (${year})` : "";
}

type ResolvedReviewInput = {
  input: AssemblerInput;
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  character: Character;
};

async function resolveReviewInput(
  characterId: string,
  appTags: string[],
  title: ReviewTitle,
  journalHistory: string,
  discussionHistory: string,
): Promise<ResolvedReviewInput> {
  const character = loadCharacters().find((c) => c.id === characterId);
  if (!character) throw new ChatEngineError("Character not found.");

  const bindings = loadBindingConfig();
  const slot = resolveBinding(bindings, characterId, REVIEW_APP_ID);
  const apiConfig = slot.apiConfigId ? loadApiConfigs().find((c) => c.id === slot.apiConfigId) ?? null : null;
  if (!apiConfig) {
    throw new ChatEngineError(`No API configuration is bound to ${character.name} for the Review app.`);
  }

  const presets = loadPresets();
  const preset = slot.presetId ? presets.find((p) => p.id === slot.presetId) ?? null : presets.find((p) => p.builtIn) ?? presets[0] ?? null;
  const worldBooks = loadWorldBooks().filter((wb) => (slot.worldBookIds || []).includes(wb.id));
  const regexes = loadRegexes().filter((r) => (slot.regexIds || []).includes(r.id));
  const identities = loadUserIdentities();
  const userIdentity = slot.userIdentityId ? identities.find((i) => i.id === slot.userIdentityId) || identities[0] : identities[0] || null;

  const memConfig = loadMemoryConfig();
  const coreMemories = await retrieveCoreMemoriesForPrompt(characterId, memConfig);
  const longTermMemories = await retrieveMemoriesForPrompt(characterId, title.title, memConfig);
  const { recentBlocks, unifiedRecentItems } = prepareShortTermContext(characterId, REVIEW_APP_ID, {
    userName: userIdentity?.name ?? "User",
  });

  const grounding = title.grounding && title.grounding.status !== "cleared" ? title.grounding : null;

  const input: AssemblerInput = {
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: REVIEW_APP_ID,
    appTags,
    coreMemories: formatCoreMemories(coreMemories),
    longTermMemories: formatLongTermMemories(longTermMemories),
    recentBlocks,
    unifiedRecentItems,
    reviewTitleKind: title.kind,
    reviewTitle: title.title,
    reviewYear: yearSuffix(title.year),
    reviewCreator: title.creator || "an unknown creator",
    reviewOverview: title.overview,
    reviewGroundingLabel: grounding?.sourceLabel ?? "",
    reviewGroundingText: grounding?.text ?? "",
    reviewJournalHistory: journalHistory,
    reviewDiscussionHistory: discussionHistory,
  };

  return { input, apiConfig, preset, character };
}

export async function generateReviewDiscussReply(
  title: ReviewTitle,
  characterId: string,
  journalEntries: ReviewJournalEntry[],
  priorMessages: ReviewDiscussionMessage[],
): Promise<{ content: string; mode: ReviewDiscussMode }> {
  const mode = resolveDiscussMode(title);
  const resolved = await resolveReviewInput(
    characterId,
    ["review", mode],
    title,
    formatJournalHistory(journalEntries),
    formatDiscussionHistory(priorMessages),
  );
  const llmMessages = assemblePromptPayload(resolved.input);
  const content = await sendLLMRequest(
    resolved.apiConfig,
    resolved.preset,
    llmMessages,
    resolved.input.regexes,
    { characterName: resolved.character.name, userName: resolved.input.userIdentity?.name },
    { appId: REVIEW_APP_ID, appTags: resolved.input.appTags },
  );
  if (!content) throw new ChatEngineError("The API returned empty content.");
  return { content, mode };
}

type ReviewWriteResult = { rating: number; headline: string; body: string[] };

/**
 * Pure parse step for the review-write JSON contract, split out so it's testable without a
 * live API call. On total parse failure, falls back to hand-written content derived from the
 * raw text (mirrors composeInterviewArticle's fallback in lib/interview-magazine-engine.ts) --
 * never surfaces a raw parse error to the user.
 */
export function parseReviewWriteResponse(raw: string): { rating: number; headline: string; body: string[] } {
  const parsed = parseJsonLike<ReviewWriteResult>(raw);
  const ratingValue = parsed && Number.isFinite(Number(parsed.rating)) ? Number(parsed.rating) : 3;
  const headline = parsed ? cleanText(parsed.headline, 200) : "";
  const body = parsed ? cleanArray(parsed.body, 6, 900) : [];
  return {
    rating: ratingValue,
    headline: headline || raw.slice(0, 160),
    body: body.length > 0 ? body : [raw.slice(0, 900)],
  };
}

export async function generatePublishedReview(
  title: ReviewTitle,
  characterId: string,
  journalEntries: ReviewJournalEntry[],
  discussionMessages: ReviewDiscussionMessage[],
): Promise<Omit<PublishedReview, "id" | "createdAt">> {
  const resolved = await resolveReviewInput(
    characterId,
    ["review", "write"],
    title,
    formatJournalHistory(journalEntries),
    formatDiscussionHistory(discussionMessages),
  );
  const llmMessages = assemblePromptPayload(resolved.input);
  const raw = await sendLLMRequest(
    resolved.apiConfig,
    resolved.preset,
    llmMessages,
    resolved.input.regexes,
    { characterName: resolved.character.name, userName: resolved.input.userIdentity?.name },
    { appId: REVIEW_APP_ID, appTags: resolved.input.appTags },
  );
  if (!raw) throw new ChatEngineError("The API returned empty content.");

  const { rating, headline, body } = parseReviewWriteResponse(raw);

  return {
    titleId: title.id,
    characterId,
    characterName: resolved.character.name,
    rating: makeReviewRating(rating),
    headline,
    body,
    groundingUsed: Boolean(title.grounding && title.grounding.status !== "cleared" && title.grounding.text),
  };
}

export async function previewReviewDiscussPrompt(
  title: ReviewTitle,
  characterId: string,
  journalEntries: ReviewJournalEntry[],
  priorMessages: ReviewDiscussionMessage[],
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const mode = resolveDiscussMode(title);
  const resolved = await resolveReviewInput(
    characterId,
    ["review", mode],
    title,
    formatJournalHistory(journalEntries),
    formatDiscussionHistory(priorMessages),
  );
  const llmMessages = assemblePromptPayload(resolved.input);
  return {
    messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
    characterName: `Review Discussion: ${resolved.character.name}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "Default preset",
  };
}

export async function previewReviewWritePrompt(
  title: ReviewTitle,
  characterId: string,
  journalEntries: ReviewJournalEntry[],
  discussionMessages: ReviewDiscussionMessage[],
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const resolved = await resolveReviewInput(
    characterId,
    ["review", "write"],
    title,
    formatJournalHistory(journalEntries),
    formatDiscussionHistory(discussionMessages),
  );
  const llmMessages = assemblePromptPayload(resolved.input);
  return {
    messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
    characterName: `Review: ${resolved.character.name}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "Default preset",
  };
}
