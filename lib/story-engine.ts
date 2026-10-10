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
import { prepareShortTermContext, type RecentBlock, type UnifiedRecentItem } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { parseActionTags, dispatchActions } from "./action-parser";
import { extractCustomAppCard } from "./rich-message-parser";
import { formatCustomAppChatDirectivesForPrompt } from "./custom-app-chat-directives";

import { STORY_PARSER_VERSION } from "./story-parser";
import {
  loadStoryMessages,
  replaceStoryMessages,
  resolveActiveStorySchemes,
  type StoryCharacterSettings,
  type StoryMessage,
} from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";
import {
    stripContextExcludedTags as sharedStripContextExcludedTags,
    isCompleteDispatchableMessage,
    narrativeTextSurvives,
} from "./narrative-message-guards";

// story_status/story_theater are story mode's own fixed tail regions (the status-bar and
// mini-theater schemes) -- always foldable/excluded-from-context regardless of the user's own
// advanced fold-tags setting, matching story-parser.ts's applyFoldTags.
const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary,story_status,story_theater";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking,story_theater";

// Taught verbatim below -- kept as a structural token, not translated. Matches this repo's own
// established convention for the exact same prose-semantics format in lib/mixology/assembler.ts
// ("Wrap anything spoken aloud in 「」..."): it is a rendering protocol, not UI prose.
const STORY_VOICE_FORMAT_PROMPT = [
  "# Story prose format",
  "Use the same prose format as House Special:",
  "- Wrap anything a character actually says aloud in 「」; wrap each spoken line separately, and don't repeat the character's name inside the brackets.",
  "- Wrap a character's unspoken inner voice in *asterisks*.",
  "- Mark a location, time, or scene transition on its own line with 【】.",
  "- Wrap a short phrase that needs emphasis in ~tildes~.",
  "- Use \"...\" only for an object, action, or ambient sound -- never for a character's own spoken line.",
  "Dialogue punctuation has exactly one form: no matter what punctuation the user's own words or the history use, your own character dialogue must always be wrapped in 「」, never mimicking the user's own style.",
  "Narration, action text, and the user's own words must never be written inside 「」; don't explain these formatting rules, and don't output an extra voice-line list.",
].join("\n");

export type StoryGenerationOptions = {
  sessionFoldTags?: string;
  sessionContextExcludedTags?: string;
  settings?: StoryCharacterSettings;
  floatingChatContext?: string;
  /** The multiplayer story's character roster; the first character is still the one used for API/preset/voice binding. */
  participantIds?: string[];
  storyMemory?: {
    independent?: boolean;
    inheritRecentMemory?: boolean;
    startedAt?: string;
  };
  signal?: AbortSignal;
};

/** Exported only so a fixture can drive it directly. */
export function selectStoryPresetPrompts(preset: PresetConfig | null, selectedIds?: string[]): PresetConfig | null {
  if (!preset || selectedIds === undefined) return preset;
  const allowed = new Set(selectedIds);
  return {
    ...preset,
    prompts: preset.prompts.map((prompt) => prompt.marker ? prompt : { ...prompt, enabled: prompt.enabled && allowed.has(prompt.identifier) }),
    prompt_order: preset.prompt_order,
  };
}

/**
 * "First person, limited" -- {{char}} narrates as "I" and the prose only ever contains what
 * they themself can personally see, hear, feel, think or infer; the user's own inner state is
 * never stated directly, only guessed at from the outside, the way a first-person narrator
 * would. Paired with third-person, gender-aware pronouns for the user (never "you"), since a
 * first-person narrator addressing the reader as "you" would read as second person instead.
 * Gender handling mirrors lib/mascot-engine.ts's formatMascotUserIdentityRule: fail closed to
 * they/them when unset, since "保密" (undisclosed) is a real, deliberate choice the user made in
 * Settings -> User Identity, not a missing value to guess past.
 */
function buildFirstPersonLimitedPerspective(userName: string, userGender: string | undefined): string {
  const gender = (userGender ?? "").trim();
  const undisclosed = !gender || gender === "保密";
  const pronounInstruction = undisclosed
    ? `their gender has not been set, so do not assume one -- use they/them`
    : `use pronouns consistent with their gender ("${gender}") as set in their identity settings -- treat it as fact`;
  return `Write in first-person limited perspective: narrate as "I", and only ever state what you personally see, hear, feel, think or infer -- never state what ${userName} is thinking or feeling directly, only what you can observe or guess from the outside. Refer to ${userName} in the third person, never as "you": ${pronounInstruction}.`;
}

/** Exported only so a fixture can drive it directly. */
export function buildStorySettingsPrompt(settings: StoryCharacterSettings | undefined, userName: string, userGender?: string): string {
  if (!settings) return "";
  // Length clamps to 50-10000: an unset/negative value effectively means 50, anything above
  // 10000 effectively means 10000.
  const minChars = Math.max(50, Math.min(10000, settings.minChars ?? 800));
  const maxChars = Math.max(minChars, Math.min(10000, settings.maxChars ?? 1500));
  const perspective = settings.userPerspective === "first"
    ? buildFirstPersonLimitedPerspective(userName, userGender)
    : settings.userPerspective === "third"
      ? `Refer to the user in the third person ("they")`
      : settings.userPerspective === "username"
        ? `Refer to the user by their name, "${userName}"`
        : `Refer to the user in the second person ("you")`;
  // Scheme definitions live in the shared repository now; a character's settings only carry
  // which one is enabled.
  const { proseStyle, status, theater } = resolveActiveStorySchemes(settings);
  return [
    "# Story app generation settings",
    `Aim for prose length between ${minChars}-${maxChars} characters; never pad with repeated content just to hit the count.`,
    perspective.endsWith(".") ? perspective : perspective + ".",
    // Skip a blank line rather than emitting "Prose style [xxx]: " with nothing after it when a
    // newly created scheme has no prompt yet.
    proseStyle?.prompt?.trim() ? `Prose style [${proseStyle.name}] (constrains writing style only, not the tail-output format): ${proseStyle.prompt.trim()}` : (settings.proseStyle ? `Style: ${settings.proseStyle}.` : ""),
    proseStyle?.prompt?.trim() ? "" : (settings.proseStylePrompt?.trim() || ""),
    settings.extraPrompt?.trim() || "",
    ...(settings.customPromptEntries || []).filter((item) => item.enabled && item.content.trim()).map((item) => `Custom entry [${item.name || "Untitled"}]: ${item.content.trim()}`),
    status?.prompt?.trim() || "",
    theater?.prompt?.trim() || "",
  ].filter(Boolean).join("\n");
}

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
  options?: StoryGenerationOptions,
): Promise<StoryGenerationResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset: resolvedPreset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId);
  const preset = selectStoryPresetPrompts(resolvedPreset, options?.settings?.enabledPresetPromptIds);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(
    characterId,
    history,
    preset,
    regexes,
    worldBooks,
    effectiveContextExcludedTags,
    options?.settings,
    options?.floatingChatContext,
    options?.participantIds,
    options?.storyMemory,
  );

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
  // a built-in action tag name, so the two extractions cannot collide. Each directive/Studio
  // card declares its own scope (chat/story/offline) when it's authored -- there is no global
  // "story" toggle to check here, extractCustomAppCard() filters by mode itself.
  const appCard = extractCustomAppCard(cleanText, "story");
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

/** Exported only so a fixture can drive it directly without a live API call. */
export async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
  settings?: StoryCharacterSettings,
  floatingChatContext?: string,
  participantIds?: string[],
  storyMemory?: StoryGenerationOptions["storyMemory"],
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const historyMessages = history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const memConfig = loadMemoryConfig();
  // An independent branch draws on nothing outside itself: no short-term context, no core/
  // long-term memory retrieval. World-book activation context falls back to the branch's own
  // recent turns so world books still fire correctly inside it.
  const independent = Boolean(storyMemory?.independent);
  const context = independent
    ? {
      recentBlocks: [] as RecentBlock[],
      truncatedHistory: historyMessages,
      wbActivationContext: historyMessages.slice(-10).map((message) => message.content).join("\n"),
      unifiedRecentItems: [] as UnifiedRecentItem[],
    }
    : prepareShortTermContext(characterId, "story", {
      userName: userIdentity?.name ?? "User",
      history: historyMessages,
      // A branch that does NOT inherit recent memory only sees short-term events from after it
      // started; a branch that does (or the main branch, always) sees the character's normal
      // unrestricted short-term window.
      afterTimestamp: storyMemory?.inheritRecentMemory === false ? storyMemory.startedAt : undefined,
    });
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = context;

  let memories: Awaited<ReturnType<typeof retrieveMemoriesForPrompt>> | null = null;
  let coreMemories: Awaited<ReturnType<typeof retrieveCoreMemoriesForPrompt>> | null = null;
  if (!independent) {
    [memories, coreMemories] = await Promise.all([
      retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
      retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
    ]);
  }

  const now = new Date();

  const messages = assemblePromptPayload({
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
    // payload here and was missing it entirely. Only directives/Studio cards whose own scope
    // includes "story" are taught -- see custom-app-chat-directives.ts's directiveMatchesScope().
    customAppRichMediaDirectives: formatCustomAppChatDirectivesForPrompt("story"),
  });

  const settingsPrompt = buildStorySettingsPrompt(settings, userIdentity?.name ?? "User", userIdentity?.gender);
  const participantCharacters = Array.from(new Set(participantIds || []))
    .map((id) => loadCharacters().find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (participantCharacters.length > 1) {
    const roster = participantCharacters.map((item, index) => {
      const profile = item.briefPersona?.trim() || item.personality?.trim() || item.persona?.trim();
      return `${index + 1}. ${item.name}${profile ? `: ${profile}` : ""}`;
    }).join("\n");
    messages.push({
      role: "system",
      content: `# Multiplayer meeting story\nThe following characters are present in this scene:\n${roster}\nLet each character keep their own persona, way of addressing others, and behavior logic, distributing dialogue and reactions naturally across the scene; do not merge multiple characters into a single speaker, and do not decide the user's actions for them.`,
    });
  }
  if (independent) {
    messages.push({ role: "system", content: "# Independent story branch\nThis branch does not draw on the character's existing short-term, core, or long-term memory; continue based only on the character's persona and what has already happened in this branch." });
  }
  if (settingsPrompt) messages.push({ role: "system", content: settingsPrompt });
  if (settings?.floatingPhoneInContext && floatingChatContext?.trim()) {
    messages.push({ role: "system", content: `# Recent live chat from the floating phone\nThe following log is provided to bridge the online and offline storylines; do not quote it verbatim:\n${floatingChatContext.trim()}` });
  }
  messages.push({ role: "system", content: STORY_VOICE_FORMAT_PROMPT });
  return messages;
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
