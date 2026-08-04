import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import type { ChatMessage } from "./chat-storage";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { ChatEngineError, sendLLMRequest } from "./chat-engine";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { MacroEngine, postProcessTrim } from "./macro-engine";
import { loadMemoryConfig, incrementEventCounter } from "./memory-storage";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { maybeRunSummarization } from "./memory-summarizer";
import { prepareShortTermContext } from "./short-term-assembler";
import {
  appendBlackMarketSceneMessage,
  endBlackMarketSceneSession,
  getBlackMarketSceneSession,
  loadBlackMarketState,
  recordBlackMarketTheaterProjectionEvent,
} from "./black-market-storage";
import type { BlackMarketOwnedTheater, BlackMarketSceneMessage, BlackMarketSceneSession, BlackMarketTheaterTemplate } from "./black-market-types";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";

type SceneConfigs = {
  character: Character;
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
};

const BLACK_MARKET_BINDING_APP_ID = "shopping";
const BLACK_MARKET_PROMPT_APP_ID = "black_market_theater";
const BLACK_MARKET_PROMPT_TAGS = ["black_market_theater"];

export type BlackMarketSceneGenerationResult = {
  session: BlackMarketSceneSession;
  reply: string;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type BlackMarketSceneSummaryResult = {
  session: BlackMarketSceneSession;
  summary: string;
};

function resolveSceneConfigs(characterId: string): SceneConfigs {
  const character = loadCharacters().find(item => item.id === characterId);
  if (!character) throw new ChatEngineError(`Character not found: ${characterId}`);

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, BLACK_MARKET_BINDING_APP_ID);
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> Binding Manager -> Shopping to assign one.`);
  }

  const apiConfig = loadApiConfigs().find(config => config.id === activeSlot.apiConfigId);
  if (!apiConfig) throw new ChatEngineError(`API Configuration not found for ${character.name}.`);

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(item => item.id === activeSlot.presetId) || null : null;
  if (!preset) preset = presets.find(item => item.builtIn) ?? null;

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(regex => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(worldBook => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];

  return { character, apiConfig, preset, regexes, worldBooks };
}

export function expandBlackMarketMacros(text: string, characterName?: string, userName?: string): string {
  const engine = new MacroEngine(characterName || "Character", userName || "User");
  return postProcessTrim(engine.expand(text || "")).trim();
}

function findOwnedTheater(localTheaterId: string): BlackMarketOwnedTheater | undefined {
  return loadBlackMarketState().ownedTheaters.find(item => item.localId === localTheaterId);
}

function toChatHistoryMessage(session: BlackMarketSceneSession, message: BlackMarketSceneMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: session.id,
    role: message.role,
    content: message.content,
    status: "sent",
    createdAt: message.createdAt,
  };
}

function buildSceneDirective(template: BlackMarketTheaterTemplate, characterName: string, userName: string): string {
  const aiInstruction = expandBlackMarketMacros(template.aiInstruction, characterName, userName);
  const outputContract = expandBlackMarketMacros(template.outputContract, characterName, userName);
  return [
    "<scene_directive>",
    "【Scene Directive】",
    aiInstruction,
    // NOTE: only the section heading is translated here — never the contract body.
    // `outputContract` is per-template DATA with two different origins:
    //   - built-in templates: CONTRACT_* constants in lib/black-market-builtins.ts
    //   - user templates: authored in the Studio, whose default seeds the
    //     【秘密】/【失控】/【反应】 markers that the template's own `renderRulesText`
    //     regex matches (see components/shopping/black-market-app.tsx ~637/650).
    // Either way the body is data the user can edit, and its markers must round-trip
    // to that template's render rules — so it is never rewritten here.
    outputContract ? `\n【Output Contract】\n${outputContract}` : "",
    "</scene_directive>",
  ].filter(Boolean).join("\n");
}

async function buildScenePromptMessages(session: BlackMarketSceneSession, template: BlackMarketTheaterTemplate): Promise<{
  messages: LLMMessage[];
  configs: SceneConfigs;
}> {
  const configs = resolveSceneConfigs(session.characterId);
  const userIdentity = resolveUserIdentity(session.characterId, BLACK_MARKET_BINDING_APP_ID);
  const userName = session.userName || userIdentity?.name || "User";
  const history = session.messages.map(message => toChatHistoryMessage(session, message));
  const memConfig = loadMemoryConfig();
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(session.characterId, BLACK_MARKET_PROMPT_APP_ID, {
    userName,
    history,
  });
  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(session.characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(session.characterId, memConfig).catch(() => null),
  ]);

  const messages = assemblePromptPayload({
    character: configs.character,
    history: truncatedHistory,
    preset: configs.preset,
    worldBooks: configs.worldBooks,
    regexes: configs.regexes,
    userIdentity,
    appId: BLACK_MARKET_PROMPT_APP_ID,
    appTags: BLACK_MARKET_PROMPT_TAGS,
    scheduleSummary: buildCalendarScheduleMarker("character", session.characterId, getWeekStartIso(new Date())),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
  });

  messages.push({
    role: "system",
    content: buildSceneDirective(template, session.characterName, userName),
    _debugMeta: { marker: "blackMarketSceneDirective", depth: 0, order: Number.MAX_SAFE_INTEGER },
  });

  return { messages, configs };
}

export async function generateBlackMarketSceneReply(sessionId: string, userText: string): Promise<BlackMarketSceneGenerationResult> {
  const current = getBlackMarketSceneSession(sessionId);
  if (!current) throw new ChatEngineError("That mini-theater session no longer exists.");
  if (current.status !== "active") throw new ChatEngineError("This mini-theater session has already ended.");
  const owned = findOwnedTheater(current.localTheaterId);
  if (!owned) throw new ChatEngineError("That night file was not found in the cabinet.");

  let withUser = current;
  const lastMessage = current.messages[current.messages.length - 1];
  if (!(lastMessage?.role === "user" && lastMessage.content === userText)) {
    const appended = appendBlackMarketSceneMessage(sessionId, "user", userText);
    if (!appended) throw new ChatEngineError("Could not record the player action.");
    withUser = appended;
  }

  const { messages, configs } = await buildScenePromptMessages(withUser, owned.templateSnapshot);
  const userName = withUser.userName || resolveUserIdentity(withUser.characterId, BLACK_MARKET_BINDING_APP_ID)?.name || "User";
  const reply = await sendLLMRequest(configs.apiConfig, configs.preset, messages, configs.regexes, {
    characterName: withUser.characterName,
    userName,
  }, {
    appId: BLACK_MARKET_PROMPT_APP_ID,
    appTags: BLACK_MARKET_PROMPT_TAGS,
  });

  const updated = appendBlackMarketSceneMessage(sessionId, "assistant", reply);
  if (!updated) throw new ChatEngineError("Could not record the character reply.");

  return {
    session: updated,
    reply,
    promptMessages: messages,
    model: configs.apiConfig.defaultModel,
    presetName: configs.preset?.name || "(default preset)",
  };
}

function formatSceneTranscript(session: BlackMarketSceneSession): string {
  return session.messages.map(message => {
    const speaker = message.role === "assistant" ? session.characterName : session.userName;
    return `${speaker}: ${message.content}`;
  }).join("\n\n");
}

export async function summarizeAndRecordBlackMarketScene(sessionId: string): Promise<BlackMarketSceneSummaryResult> {
  const session = getBlackMarketSceneSession(sessionId);
  if (!session) throw new ChatEngineError("That mini-theater session no longer exists.");
  const owned = findOwnedTheater(session.localTheaterId);
  if (!owned) throw new ChatEngineError("That night file was not found in the cabinet.");
  if (session.messages.length === 0) throw new ChatEngineError("This mini-theater has no story yet to summarize.");

  const { apiConfig } = resolveSceneConfigs(session.characterId);
  const promptTemplate = expandBlackMarketMacros(
    owned.templateSnapshot.memorySummaryPrompt || "Condense the mini-theater scene below into a single short-term memory entry. Keep the key facts, any shift in the character's attitude, and any change in the relationship. Do not include system information.",
    session.characterName,
    session.userName,
  );
  const prompt = [
    promptTemplate,
    "",
    `Mini-theater title: ${owned.templateSnapshot.title}`,
    `Character: ${session.characterName}`,
    `User: ${session.userName}`,
    "",
    "Scene transcript:",
    formatSceneTranscript(session),
    "",
    "Output only the short-term memory text.",
  ].join("\n");

  const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], {
    temperature: 0.3,
  });
  const summary = (result.content || "").trim();
  if (!summary) throw new ChatEngineError(result.error || "The memory summary came back empty.");

  const ended = endBlackMarketSceneSession(sessionId, summary);
  const finalSession = ended ?? session;
  const timestamp = finalSession.endedAt || new Date().toISOString();
  recordBlackMarketTheaterProjectionEvent({
    sessionId,
    characterId: finalSession.characterId,
    characterName: finalSession.characterName,
    userName: finalSession.userName,
    theaterTitle: finalSession.title,
    summary,
    timestamp,
  });

  try {
    incrementEventCounter(finalSession.characterId);
    maybeRunSummarization(finalSession.characterId, finalSession.characterName)
      .catch(err => console.warn("[BlackMarketScene] Summarization check failed:", err));
  } catch (err) {
    console.warn("[BlackMarketScene] Memory counter failed:", err);
  }

  return {
    session: {
      ...finalSession,
      status: "ended",
      summary,
      summaryWrittenAt: timestamp,
    },
    summary,
  };
}
