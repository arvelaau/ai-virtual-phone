import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { parseActionTags, dispatchActions } from "./action-parser";
import { extractCustomAppCard } from "./rich-message-parser";
import { formatCustomAppChatDirectivesForPrompt } from "./custom-app-chat-directives";

import { STORY_PARSER_VERSION } from "./story-parser";
import { loadStoryMessages, replaceStoryMessages, type StoryMessage } from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";
import {
    stripContextExcludedTags as sharedStripContextExcludedTags,
    isCompleteDispatchableMessage,
    narrativeTextSurvives,
} from "./narrative-message-guards";

const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking";

/** `<content>` / `<summary>` -- the story turn's own structure. */
const STORY_STRUCTURAL_FIELDS = ["content", "summary"];

/**
 * The one action a story turn may actually fire: the character taking out their phone and
 * messaging the user for real. `ActionTag.type` is the CANONICAL Chinese name regardless of
 * which alias the model wrote (see action-parser's parseActionHeader), so this compares
 * against that rather than against "Message".
 */
const STORY_DISPATCHABLE_ACTION = "消息";

/**
 * Story only fires a message from a PROPERLY CLOSED block, and the turn must still have a
 * story in it once one fires -- see lib/narrative-message-guards.ts for the full history of
 * why (five separately user-reported bugs). Thin story-flavored wrappers so every existing
 * caller/import of these two names keeps working unchanged; offline mode uses the same shared
 * functions with its own structural field list instead of duplicating either check.
 */
export function isCompleteStoryMessage(action: { content: string; rawText?: string }): boolean {
    return isCompleteDispatchableMessage(action, STORY_STRUCTURAL_FIELDS);
}

export function storyTextSurvives(cleanText: string, contextExcludedTags?: string): boolean {
    return narrativeTextSurvives(cleanText, contextExcludedTags, STORY_STRUCTURAL_FIELDS, DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS);
}

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
  /** A custom-app chat directive this turn triggered (a boarding-pass/menu-style card), if any. */
  appId?: string;
  appName?: string;
  appCardLayout?: Record<string, unknown>;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  return sharedStripContextExcludedTags(text, excludedTags, DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS);
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
  };
}

function resolveStoryConfigs(characterId: string): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> Binding Manager -> Story to assign one.`);
  }

  const apiConfig = loadApiConfigs().find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null;
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === characterId);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = storyOverrideRegexIds && storyOverrideRegexIds.length > 0
    ? storyOverrideRegexIds
    : activeSlot.regexIds || [];
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

export function getStoryRenderSignature(characterId: string): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterId);
  return {
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

export async function generateStoryCompletion(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionFoldTags?: string; sessionContextExcludedTags?: string; signal?: AbortSignal },
): Promise<StoryGenerationResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);

  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "User");

  const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
    characterName: character.name,
  }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });

  // Action tags are parsed from the RAW output, before the user's regexes run over it in
  // parseStoryResponse -- a regex that rewrites the reply could otherwise mangle a tag before
  // it is ever recognised. Same order chat uses.
  //
  // Scope is deliberately [Message] only for now. parseActionTags also recognises Moments,
  // GroupMessage, DirectMessage, Comment and Reply; dispatching those from story too would
  // widen the blast radius a long way (a story beat could silently post to Moments), so
  // anything else is stripped from the display text but NOT acted on.
  const { cleanText, actions } = parseActionTags(rawOutput);
  const chatMessages = actions.filter(
    action => action.type === STORY_DISPATCHABLE_ACTION && isCompleteStoryMessage(action));
  // If stripping the actions left no story behind, the model wrapped the turn in the tag
  // rather than appending it. Send nothing: what it produced is a scene, not a message.
  if (chatMessages.length && !storyTextSurvives(cleanText, effectiveContextExcludedTags)) {
    console.warn("[StoryEngine] [Message] swallowed the whole turn — nothing sent to chat");
    chatMessages.length = 0;
  }
  if (chatMessages.length) {
    // Fire and forget, exactly as chat and moments do: a failed side-effect must never take
    // the story turn down with it. parseAndSaveResponse inside the dispatcher runs the full
    // chat pipeline, notification banner included.
    dispatchActions(chatMessages, { characterId, sourceEngine: "story", signal: options?.signal })
      .catch(err => console.warn("[StoryEngine] chat message dispatch failed:", err));
  }

  // A custom-app directive (e.g. a boarding-pass/menu card) can appear alongside the story
  // prose, the same way it already can in live chat. Scanned on the text AFTER [Message]
  // extraction -- a directive's syntax head is validated at registration time to never shadow
  // a built-in action tag name, so the two extractions cannot collide.
  const appCard = extractCustomAppCard(cleanText);
  const textForStoryParser = appCard
    ? (cleanText.slice(0, appCard.matchIndex) + cleanText.slice(appCard.matchIndex + appCard.matchLength)).trim()
    : cleanText;

  const parsed = parseStoryResponse(textForStoryParser, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "(default preset)",
    appId: appCard?.appId,
    appName: appCard?.appName,
    appCardLayout: appCard?.appCardLayout,
  };
}

async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const historyMessages = history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const memConfig = loadMemoryConfig();
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "story", {
    userName: userIdentity?.name ?? "User",
    history: historyMessages,
  });

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);

  const now = new Date();

  return assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(now)),
    currentSchedule: getCurrentCalendarScheduleForPrompt("character", characterId, now),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
    // Without this, the model has no idea an installed custom app's directive (e.g. a
    // boarding-pass/menu card) exists at all in story mode -- chat and offline both get this
    // automatically via buildChatPromptMessages in chat-engine.ts; story builds its own prompt
    // payload here and was missing it entirely.
    customAppRichMediaDirectives: formatCustomAppChatDirectivesForPrompt(),
  });
}

export async function previewStoryPromptPayload(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionContextExcludedTags?: string },
): Promise<StoryPreviewResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }
  const { apiConfig, preset, regexes, worldBooks } = resolveStoryConfigs(characterId);
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: character.name,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "(default preset)",
  };
}

export function rebuildStorySessionRenderCache(characterId: string, sessionId: string, options?: { sessionFoldTags?: string }): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterId);
  const { regexes, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;

  const character = loadCharacters().find((c) => c.id === characterId);
  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "User");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText || message.storySummary,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
