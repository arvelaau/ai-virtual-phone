import { jsonrepair } from "jsonrepair";

import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { MacroEngine } from "./macro-engine";
import { normalizeUserNameToMacro } from "./user-macro";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadUserIdentities,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { loadInterviewHostPrompt, loadInterviewMemoryPrompt } from "./interview-magazine-storage";
import {
  INTERVIEW_MAGAZINE_APP_ID,
  INTERVIEW_MAGAZINE_HOST_NAME,
  type InterviewArticle,
  type InterviewCharacterSnapshot,
  type InterviewGuestSnapshot,
  type InterviewMessage,
  type InterviewUserSnapshot,
  type InterviewWorldBookSnapshot,
} from "./interview-magazine-types";

type InterviewGuestContext = {
  character: Character;
  characterSnapshot: InterviewCharacterSnapshot;
  worldBooks: WorldBookConfig[];
  worldBookSnapshot: InterviewWorldBookSnapshot[];
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
};

type InterviewContext = {
  guests: InterviewGuestContext[];
  primaryGuest: InterviewGuestContext;
  character: Character;
  characterSnapshot: InterviewCharacterSnapshot;
  userIdentity: UserIdentity | null;
  userSnapshot: InterviewUserSnapshot | null;
  userName: string;
  guestNames: string[];
  guestListText: string;
  worldBooks: WorldBookConfig[];
  worldBookSnapshot: InterviewWorldBookSnapshot[];
  guestSnapshots: InterviewGuestSnapshot[];
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
};

type HostQuestionResult = {
  intro?: string;
  question: string;
  targetGuest?: string;
  targetCharacterId?: string;
};

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function cleanArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseJsonLike<T>(raw: string): T | null {
  const source = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1")
    .trim();
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? source.slice(first, last + 1) : source;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(candidate)) as T;
    } catch {
      return null;
    }
  }
}

export function makeInterviewMessage(
  role: InterviewMessage["role"],
  content: string,
  options?: Pick<InterviewMessage, "kind" | "target" | "targetCharacterId" | "targetCharacterName" | "speakerCharacterId" | "speakerName">,
): InterviewMessage {
  return {
    id: createId("imsg"),
    role,
    content,
    kind: options?.kind,
    target: options?.target,
    targetCharacterId: options?.targetCharacterId,
    targetCharacterName: options?.targetCharacterName,
    speakerCharacterId: options?.speakerCharacterId,
    speakerName: options?.speakerName,
    createdAt: new Date().toISOString(),
  };
}

function joinGuestNames(names: string[]): string {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  if (cleaned.length === 0) return "the guest";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(", ")} and ${cleaned[cleaned.length - 1]}`;
}

function normalizeCharacterIds(characterIds: string | string[]): string[] {
  const source = Array.isArray(characterIds) ? characterIds : [characterIds];
  return [...new Set(source.map((id) => id.trim()).filter(Boolean))];
}

export function formatInterviewTranscript(
  messages: InterviewMessage[],
  characterName: string,
  userName: string,
  characterNameById?: Record<string, string>,
): string {
  if (messages.length === 0) return "(no interview transcript yet)";
  return messages
    .map((message) => {
      if (message.role === "host") return `Host ${INTERVIEW_MAGAZINE_HOST_NAME}: ${message.content}`;
      if (message.role === "character") {
        const speakerName = message.speakerName
          || (message.speakerCharacterId ? characterNameById?.[message.speakerCharacterId] : undefined)
          || characterName;
        return `${speakerName}: ${message.content}`;
      }
      return `${userName}: ${message.content}`;
    })
    .join("\n");
}

function snapshotCharacter(character: Character): InterviewCharacterSnapshot {
  return {
    id: character.id,
    name: character.name,
    avatar: character.avatar,
    persona: character.persona ?? "",
    personality: character.personality,
    tags: character.tags ?? [],
  };
}

function snapshotUserIdentity(identity: UserIdentity | null): InterviewUserSnapshot | null {
  if (!identity) return null;
  return {
    name: identity.name,
    gender: identity.gender,
    age: identity.age,
    occupation: identity.occupation,
    bio: identity.bio,
    customSettings: identity.customSettings,
  };
}

function resolveInterviewUserIdentity(characterIds: string[], userIdentityId?: string): UserIdentity | null {
  const identities = loadUserIdentities();
  if (identities.length === 0) return null;
  if (userIdentityId) {
    return identities.find((identity) => identity.id === userIdentityId) || identities[0];
  }
  const resolved = characterIds
    .map((characterId) => resolveUserIdentity(characterId, INTERVIEW_MAGAZINE_APP_ID))
    .filter(Boolean) as UserIdentity[];
  const uniqueIds = new Set(resolved.map((identity) => identity.id));
  if (resolved.length > 0 && uniqueIds.size === 1) return resolved[0];
  return identities[0];
}

function formatCharacterCard(snapshot: InterviewCharacterSnapshot): string {
  return [
    `Name: ${snapshot.name}`,
    `Persona: ${snapshot.persona || "(not provided)"}`,
    `Personality: ${snapshot.personality || "(not provided)"}`,
    `Tags: ${snapshot.tags.length > 0 ? snapshot.tags.join(", ") : "(none)"}`,
  ].join("\n");
}

function formatUserSnapshot(snapshot: InterviewUserSnapshot | null): string {
  if (!snapshot) return "(no co-interviewee profile provided)";
  return [
    `Name: ${snapshot.name || "User"}`,
    snapshot.gender ? `Gender: ${snapshot.gender}` : "",
    snapshot.age ? `Age: ${snapshot.age}` : "",
    snapshot.occupation ? `Occupation: ${snapshot.occupation}` : "",
    snapshot.bio ? `Bio: ${snapshot.bio}` : "",
    snapshot.customSettings ? `Additional setting: ${snapshot.customSettings}` : "",
  ].filter(Boolean).join("\n") || "(no co-interviewee profile provided)";
}

function snapshotWorldBooks(worldBooks: WorldBookConfig[]): InterviewWorldBookSnapshot[] {
  return worldBooks.map((book) => ({
    id: book.id,
    name: book.name,
    entries: (book.entries || [])
      .filter((entry) => !entry.disable)
      .map((entry) => ({
        key: entry.key,
        comment: entry.comment,
        content: entry.content,
      })),
  }));
}

function formatWorldBooks(snapshot: InterviewWorldBookSnapshot[]): string {
  if (snapshot.length === 0) return "(no supplementary material provided)";
  const lines: string[] = [];
  for (const book of snapshot) {
    lines.push(`[${book.name}]`);
    if (book.entries.length === 0) {
      lines.push("(no enabled entries)");
      continue;
    }
    book.entries.forEach((entry, index) => {
      lines.push(`${index + 1}. Keyword: ${entry.key || "(none)"}`);
      if (entry.comment) lines.push(`Note: ${entry.comment}`);
      lines.push(`Content: ${entry.content}`);
    });
  }
  return lines.join("\n");
}

export function loadInterviewContext(characterId: string): InterviewContext {
  return loadInterviewContextForGuests([characterId]);
}

export function loadInterviewContextForGuests(characterIds: string[], userIdentityId?: string): InterviewContext {
  const ids = normalizeCharacterIds(characterIds);
  if (ids.length === 0) throw new ChatEngineError("Please select at least one valid character.");
  const allCharacters = loadCharacters();
  const bindings = loadBindingConfig();
  const presets = loadPresets();
  const apiConfigs = loadApiConfigs();
  const allWorldBooks = loadWorldBooks();
  const allRegexes = loadRegexes();
  const guests = ids.map((id) => {
    const character = allCharacters.find((item) => item.id === id);
    if (!character) throw new ChatEngineError(`Interview guest not found: ${id}`);

    const slot = resolveBinding(bindings, id, INTERVIEW_MAGAZINE_APP_ID);
    if (!slot.apiConfigId) {
      throw new ChatEngineError(`No API configuration is bound to ${character.name} for the Interview app.`);
    }

    const apiConfig = apiConfigs.find((config) => config.id === slot.apiConfigId);
    if (!apiConfig) throw new ChatEngineError(`Interview API configuration for ${character.name} not found.`);

    let preset = slot.presetId ? presets.find((entry) => entry.id === slot.presetId) ?? null : null;
    if (!preset) preset = presets.find((entry) => entry.builtIn) ?? null;

    const worldBooks = (slot.worldBookIds || [])
      .map((bookId) => allWorldBooks.find((book) => book.id === bookId))
      .filter(Boolean) as WorldBookConfig[];

    const regexes = (slot.regexIds || [])
      .map((regexId) => allRegexes.find((group) => group.id === regexId))
      .filter(Boolean) as RegexConfig[];

    return {
      character,
      characterSnapshot: snapshotCharacter(character),
      worldBooks,
      worldBookSnapshot: snapshotWorldBooks(worldBooks),
      apiConfig,
      preset,
      regexes,
    };
  });

  const primaryGuest = guests[0];
  const userIdentity = resolveInterviewUserIdentity(ids, userIdentityId);
  const userSnapshot = snapshotUserIdentity(userIdentity);
  const guestNames = guests.map((guest) => guest.character.name);
  const guestSnapshots = guests.map((guest) => ({
    characterId: guest.character.id,
    characterName: guest.character.name,
    characterSnapshot: guest.characterSnapshot,
    worldBookSnapshot: guest.worldBookSnapshot,
  }));

  return {
    guests,
    primaryGuest,
    character: primaryGuest.character,
    characterSnapshot: primaryGuest.characterSnapshot,
    userIdentity,
    userSnapshot,
    userName: userSnapshot?.name || "User",
    guestNames,
    guestListText: joinGuestNames(guestNames),
    worldBooks: primaryGuest.worldBooks,
    worldBookSnapshot: primaryGuest.worldBookSnapshot,
    guestSnapshots,
    apiConfig: primaryGuest.apiConfig,
    preset: primaryGuest.preset,
    regexes: primaryGuest.regexes,
  };
}

function getCharacterNameMap(context: InterviewContext): Record<string, string> {
  return Object.fromEntries(context.guests.map((guest) => [guest.character.id, guest.character.name]));
}

function findGuestContext(context: InterviewContext, characterId: string): InterviewGuestContext {
  return context.guests.find((guest) => guest.character.id === characterId) || context.primaryGuest;
}

function resolveTargetGuest(context: InterviewContext, rawTarget?: string, fallbackCharacterId?: string): InterviewGuestContext {
  const target = rawTarget?.trim();
  if (target) {
    const exact = context.guests.find((guest) => guest.character.id === target || guest.character.name === target);
    if (exact) return exact;
    const fuzzy = context.guests.find((guest) => target.includes(guest.character.name) || guest.character.name.includes(target));
    if (fuzzy) return fuzzy;
  }
  if (fallbackCharacterId) {
    const fallback = context.guests.find((guest) => guest.character.id === fallbackCharacterId);
    if (fallback) return fallback;
  }
  return context.primaryGuest;
}

function getOtherGuestNames(context: InterviewContext, currentCharacterId: string): string {
  const names = context.guests
    .filter((guest) => guest.character.id !== currentCharacterId)
    .map((guest) => guest.character.name);
  return names.length > 0 ? joinGuestNames(names) : "none";
}

function formatGuestCards(context: InterviewContext): string {
  return context.guests
    .map((guest, index) => [
      `[Guest ${index + 1}: ${guest.character.name}]`,
      formatCharacterCard(guest.characterSnapshot),
    ].join("\n"))
    .join("\n\n");
}

function formatGuestWorldBooks(context: InterviewContext): string {
  if (context.guests.every((guest) => guest.worldBookSnapshot.length === 0)) return "(no supplementary material provided)";
  return context.guests
    .map((guest) => [
      `[Supplementary material for ${guest.character.name}]`,
      formatWorldBooks(guest.worldBookSnapshot),
    ].join("\n"))
    .join("\n\n");
}

function buildHostBriefing(params: {
  context: InterviewContext;
  theme: string;
  phase: string;
  transcript: InterviewMessage[];
}): string {
  const { context, theme, phase, transcript } = params;
  return [
    "<interview_briefing>",
    `Theme of this issue: ${theme}`,
    `Current interview stage: ${phase}`,
    `Guests this issue: ${context.guestListText}`,
    `Co-interviewee: ${context.userName}`,
    "",
    "<guest_reference>",
    formatGuestCards(context),
    "</guest_reference>",
    "",
    "<guest_background>",
    formatGuestWorldBooks(context),
    "</guest_background>",
    "",
    "<user_profile>",
    formatUserSnapshot(context.userSnapshot),
    "</user_profile>",
    "",
    "<transcript>",
    formatInterviewTranscript(transcript, context.character.name, context.userName, getCharacterNameMap(context)),
    "</transcript>",
    "</interview_briefing>",
  ].join("\n");
}

async function callHostJson<T>(context: InterviewContext, systemPrompt: string, userPrompt: string): Promise<T | null> {
  const raw = await sendLLMRequest(
    context.apiConfig,
    null,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [],
    { characterName: INTERVIEW_MAGAZINE_HOST_NAME, userName: context.userName },
    { skipOutputRegex: true, appId: INTERVIEW_MAGAZINE_APP_ID },
  );
  return parseJsonLike<T>(raw);
}

function expandInterviewPromptMacros(prompt: string, context: InterviewContext): string {
  const engine = new MacroEngine(context.character.name, context.userName);
  engine.interviewGuests = context.guestListText;
  engine.interviewGuestCount = String(context.guests.length);
  engine.interviewCurrentGuest = context.character.name;
  engine.interviewOtherGuests = getOtherGuestNames(context, context.character.id);
  return engine.expand(prompt);
}

function expandMemoryPromptMacros(prompt: string, context: InterviewContext): string {
  const literalUserMacro = "__INTERVIEW_LITERAL_USER_MACRO__";
  return expandInterviewPromptMacros(
    prompt.replace(/\{\{\s*user\s*\}\}/gi, literalUserMacro),
    context,
  ).replaceAll(literalUserMacro, "{{user}}");
}

// The host path calls sendLLMRequest with a null preset (see callHostJson), so it
// never receives the assembler's global `output_language_rule`. Without the line
// below the host simply mirrors whatever language the transcript happens to be in
// — e.g. a guest with a Chinese persona, or a resumed draft with older Chinese
// turns — so the rule has to be restated locally here.
const HOST_OUTPUT_LANGUAGE_RULE = [
  "Always write in English, regardless of the language of anything quoted to you.",
  "The interview transcript, the guest material and the world book are information about what was said — never a reference for which language to answer in.",
].join("\n");

function buildHostSystemPrompt(context: InterviewContext, lines: string[]): string {
  return [
    expandInterviewPromptMacros(loadInterviewHostPrompt(), context),
    "",
    ...lines,
    HOST_OUTPUT_LANGUAGE_RULE,
    "Output must be JSON — no markdown, no explanation.",
  ].join("\n");
}

export async function generateHostOpening(
  theme: string,
  characterIds: string | string[],
  userIdentityId?: string,
): Promise<{ context: InterviewContext; intro: string; question: string; targetCharacterId: string; targetCharacterName: string }> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(characterIds), userIdentityId);
  const briefing = buildHostBriefing({ context, theme, phase: "Opening — the host introduces this issue's theme and puts the first question to a guest", transcript: [] });
  const result = await callHostJson<HostQuestionResult>(
    context,
    buildHostSystemPrompt(context, [
      "Current task: open this interview and put the first question to a guest.",
      "You do not play the guests, and you never answer on the user's behalf. Your only job is to do your homework and ask questions with presence and real depth of character.",
    ]),
    [
      briefing,
      "",
      "Write the opening:",
      "- intro: 25-45 words, like the opening of a magazine video segment, naming this issue's theme, the guests, and the co-interviewee.",
      "- question: the first question for a guest, 25-50 words, specific, sharp, no platitudes.",
      `- targetGuest: choose one guest to address; it must be exactly one of these names: ${context.guestNames.join(", ")}.`,
      "",
      'Response format: {"intro":"...","question":"...","targetGuest":"..."}',
    ].join("\n"),
  );
  const targetGuest = resolveTargetGuest(context, result?.targetCharacterId || result?.targetGuest);

  return {
    context,
    intro: cleanText(result?.intro, 220) || `Welcome to Presence. This issue's theme is "${theme}", and we begin with a detail there is no way around.`,
    question: cleanText(result?.question, 220) || `${targetGuest.character.name}, on the subject of "${theme}" — what is the first concrete moment that comes to mind?`,
    targetCharacterId: targetGuest.character.id,
    targetCharacterName: targetGuest.character.name,
  };
}

export async function generateHostQuestion(params: {
  theme: string;
  characterIds: string | string[];
  userIdentityId?: string;
  transcript: InterviewMessage[];
  target: "character" | "user";
  phase: string;
  fallbackTargetCharacterId?: string;
}): Promise<{ question: string; targetCharacterId?: string; targetCharacterName?: string }> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const fallbackGuest = resolveTargetGuest(context, undefined, params.fallbackTargetCharacterId);
  const targetLabel = params.target === "character" ? fallbackGuest.character.name : context.userName;
  const briefing = buildHostBriefing({
    context,
    theme: params.theme,
    phase: params.phase,
    transcript: params.transcript,
  });
  const result = await callHostJson<HostQuestionResult>(
    context,
    buildHostSystemPrompt(context, [
      "Current task: ask a natural follow-up based on the guest material and the transcript so far.",
      "The question must push the conversation forward — do not summarize, do not answer for anyone.",
    ]),
    [
      briefing,
      "",
      params.target === "character"
        ? `Ask the next question, addressed to one of this issue's guests. Default choice: ${targetLabel}.`
        : `Ask the next question, addressed to: ${targetLabel}.`,
      "- The question must follow naturally from the previous answer.",
      "- 20-50 words.",
      "- Avoid generic prompts like \"what do you think\" or \"how do you feel\".",
      params.target === "user" ? "- When questioning the user, turn what the guest just said into a personal experience or judgement the user can respond to." : "- When questioning a guest, throw what the user just said back to them, so it becomes a real exchange.",
      params.target === "character" ? `- targetGuest: choose one guest to address; it must be exactly one of these names: ${context.guestNames.join(", ")}.` : "",
      "",
      params.target === "character"
        ? 'Response format: {"question":"...","targetGuest":"..."}'
        : 'Response format: {"question":"..."}',
    ].join("\n"),
  );
  const targetGuest = params.target === "character"
    ? resolveTargetGuest(context, result?.targetCharacterId || result?.targetGuest, params.fallbackTargetCharacterId)
    : undefined;
  return {
    question: cleanText(result?.question, 240) || `${targetLabel}, would you start from a more specific detail?`,
    targetCharacterId: targetGuest?.character.id,
    targetCharacterName: targetGuest?.character.name,
  };
}

export async function generateCharacterInterviewAnswer(params: {
  theme: string;
  characterIds: string | string[];
  characterId: string;
  userIdentityId?: string;
  question: string;
  transcript: InterviewMessage[];
  round: number;
  lastUserAnswer?: string;
}): Promise<string> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const guest = findGuestContext(context, params.characterId);
  const transcript = formatInterviewTranscript(params.transcript, guest.character.name, context.userName, getCharacterNameMap(context));
  const characterAnswerHistory = params.transcript
    .filter((message) => message.role === "character" && (!message.speakerCharacterId || message.speakerCharacterId === guest.character.id))
    .map((message) => message.content)
    .join("\n\n");

  const llmMessages = assemblePromptPayload({
    character: guest.character,
    history: [],
    preset: guest.preset,
    worldBooks: guest.worldBooks,
    regexes: guest.regexes,
    userIdentity: context.userIdentity,
    appId: INTERVIEW_MAGAZINE_APP_ID,
    appTags: ["interview_magazine", "answer"],
    worldBookActivationContext: `${params.theme}\n${params.question}\n${transcript}`,
    interviewTheme: params.theme,
    interviewHostName: INTERVIEW_MAGAZINE_HOST_NAME,
    interviewGuests: context.guestListText,
    interviewGuestCount: String(context.guests.length),
    interviewCurrentGuest: guest.character.name,
    interviewOtherGuests: getOtherGuestNames(context, guest.character.id),
    interviewQuestion: params.question,
    interviewTranscript: transcript,
    interviewPhase: "The guest answers the host's question",
    interviewRound: String(params.round),
    interviewUserAnswer: params.lastUserAnswer || "",
    interviewCharacterAnswerHistory: characterAnswerHistory,
  });

  const raw = await sendLLMRequest(
    guest.apiConfig,
    guest.preset,
    llmMessages,
    guest.regexes,
    { characterName: guest.character.name, userName: context.userName },
    { appId: INTERVIEW_MAGAZINE_APP_ID, appTags: ["interview_magazine", "answer"] },
  );

  return cleanText(raw, 1000) || "(a short silence) To answer that, I need to start from something very small.";
}

export async function previewInterviewMagazinePromptPayload(params: {
  theme: string;
  characterIds: string | string[];
  mode: "opening" | "host" | "answer" | "article";
  transcript?: InterviewMessage[];
  question?: string;
  issueNumber?: number;
  userIdentityId?: string;
}): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const transcript = params.transcript ?? [];
  if (params.mode === "opening") {
    const briefing = buildHostBriefing({
      context,
      theme: params.theme,
      phase: "Opening — the host introduces this issue's theme and puts the first question to a guest",
      transcript: [],
    });
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: buildHostSystemPrompt(context, [
          "Current task: open this interview and put the first question to a guest.",
          "You do not play the guests, and you never answer on the user's behalf. Your only job is to do your homework and ask questions with presence and real depth of character.",
        ]),
      },
      {
        role: "user",
        content: [
          briefing,
          "",
          "Write the opening:",
          "- intro: 25-45 words, like the opening of a magazine video segment, naming this issue's theme, the guests, and the co-interviewee.",
          "- question: the first question for a guest, 25-50 words, specific, sharp, no platitudes.",
          `- targetGuest: choose one guest to address; it must be exactly one of these names: ${context.guestNames.join(", ")}.`,
          "",
          'Response format: {"intro":"...","question":"...","targetGuest":"..."}',
        ].join("\n"),
      },
    ];
    return {
      messages: previewMessagesForApi(context.apiConfig, null, messages),
      characterName: "Interview Host - Opening",
      model: context.apiConfig.defaultModel,
      presetName: "(no preset)",
    };
  }
  if (params.mode === "host") {
    const fallbackGuest = resolveTargetGuest(context, undefined);
    const briefing = buildHostBriefing({
      context,
      theme: params.theme,
      phase: "Previewing the host's next question",
      transcript,
    });
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: buildHostSystemPrompt(context, [
          "Current task: ask a natural follow-up based on the guest material and the transcript so far.",
          "The question must push the conversation forward — do not summarize, do not answer for anyone.",
        ]),
      },
      {
        role: "user",
        content: [
          briefing,
          "",
          `Ask the next question, addressed to one of this issue's guests. Default choice: ${fallbackGuest.character.name}.`,
          "- The question must follow naturally from the previous answer.",
          "- 20-50 words.",
          "- Avoid generic prompts like \"what do you think\" or \"how do you feel\".",
          "- When questioning a guest, throw what the user just said back to them, so it becomes a real exchange.",
          `- targetGuest: choose one guest to address; it must be exactly one of these names: ${context.guestNames.join(", ")}.`,
          "",
          'Response format: {"question":"...","targetGuest":"..."}',
        ].join("\n"),
      },
    ];
    return {
      messages: previewMessagesForApi(context.apiConfig, null, messages),
      characterName: "Interview Host",
      model: context.apiConfig.defaultModel,
      presetName: "(no preset)",
    };
  }
  if (params.mode === "article") {
    const briefing = buildHostBriefing({
      context,
      theme: params.theme,
      phase: "Interview finished — the editors turn the transcript into a magazine column",
      transcript,
    });
    const memoryPrompt = expandMemoryPromptMacros(loadInterviewMemoryPrompt(), context);
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: buildHostSystemPrompt(context, [
          "Current task: as editor-in-chief, shape the interview transcript into a magazine column.",
          "Do not invent facts about the user, and do not add background beyond the reference material.",
        ]),
      },
      {
        role: "user",
        content: [
          briefing,
          "",
          `Issue number: ${params.issueNumber ?? 1}`,
          "Write the magazine column:",
          "- title: a 2-6 word headline, tight and memorable.",
          "- subtitle: a 12-25 word standfirst, like a deck — never vague.",
          "- body: 3-5 paragraphs, 60-120 words each. Scene-setting, the writer's own observations, and natural direct quotes are all welcome.",
          "- pullQuote: pull one 8-25 word line from a guest's answer as the display quote; with several guests, favour the line that best carries this issue's theme.",
          "- qa: 3 selected Q&As — short questions, answers of 20-55 words.",
          "- memorySummary: produce a short-term memory summary following the \"memory summary instruction\" below; write the summary body only.",
          "- Inside memorySummary, always write {{user}} when referring to the co-interviewee or the user themselves — never a literal name.",
          "",
          "<memory_summary_instruction>",
          memoryPrompt,
          "</memory_summary_instruction>",
          "",
          'Response format: {"title":"...","subtitle":"...","body":["..."],"pullQuote":"...","qa":[{"q":"...","a":"..."}],"memorySummary":"..."}',
        ].join("\n"),
      },
    ];
    return {
      messages: previewMessagesForApi(context.apiConfig, null, messages),
      characterName: "Presence Editor - Column",
      model: context.apiConfig.defaultModel,
      presetName: "(no preset)",
    };
  }

  const guest = context.primaryGuest;
  const transcriptText = formatInterviewTranscript(transcript, context.character.name, context.userName, getCharacterNameMap(context));
  const llmMessages = assemblePromptPayload({
    character: guest.character,
    history: [],
    preset: guest.preset,
    worldBooks: guest.worldBooks,
    regexes: guest.regexes,
    userIdentity: context.userIdentity,
    appId: INTERVIEW_MAGAZINE_APP_ID,
    appTags: ["interview_magazine", "answer"],
    worldBookActivationContext: `${params.theme}\n${params.question || "Tell us about the question you most want to answer right now."}\n${transcriptText}`,
    interviewTheme: params.theme,
    interviewHostName: INTERVIEW_MAGAZINE_HOST_NAME,
    interviewGuests: context.guestListText,
    interviewGuestCount: String(context.guests.length),
    interviewCurrentGuest: guest.character.name,
    interviewOtherGuests: getOtherGuestNames(context, guest.character.id),
    interviewQuestion: params.question || "Tell us about the question you most want to answer right now.",
    interviewTranscript: transcriptText,
    interviewPhase: "The guest answers the host's question",
    interviewRound: "1",
    interviewUserAnswer: "",
    interviewCharacterAnswerHistory: "",
  });
  return {
    messages: previewMessagesForApi(guest.apiConfig, guest.preset, llmMessages),
    characterName: `Presence: ${guest.character.name}`,
    model: guest.apiConfig.defaultModel,
    presetName: guest.preset?.name ?? "Default preset",
  };
}

export async function composeInterviewArticle(params: {
  theme: string;
  characterIds: string | string[];
  userIdentityId?: string;
  transcript: InterviewMessage[];
  issueNumber: number;
}): Promise<{ context: InterviewContext; article: InterviewArticle }> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const briefing = buildHostBriefing({
    context,
    theme: params.theme,
    phase: "Interview finished — the editors turn the transcript into a magazine column",
    transcript: params.transcript,
  });
  const memoryPrompt = expandMemoryPromptMacros(loadInterviewMemoryPrompt(), context);
  const result = await callHostJson<Partial<InterviewArticle>>(
    context,
    buildHostSystemPrompt(context, [
      "Current task: as editor-in-chief, shape the interview transcript into a magazine column.",
      "Do not invent facts about the user, and do not add background beyond the reference material.",
    ]),
    [
      briefing,
      "",
      `Issue number: ${params.issueNumber}`,
      "Write the magazine column:",
      "- title: a 2-6 word headline, tight and memorable.",
      "- subtitle: a 12-25 word standfirst, like a deck — never vague.",
      "- body: 3-5 paragraphs, 60-120 words each. Scene-setting, the writer's own observations, and natural direct quotes are all welcome.",
      "- pullQuote: pull one 8-25 word line from a guest's answer as the display quote; with several guests, favour the line that best carries this issue's theme.",
      "- qa: 3 selected Q&As — short questions, answers of 20-55 words.",
      "- memorySummary: produce a short-term memory summary following the \"memory summary instruction\" below; write the summary body only.",
      "- Inside memorySummary, always write {{user}} when referring to the co-interviewee or the user themselves — never a literal name.",
      "",
      "<memory_summary_instruction>",
      memoryPrompt,
      "</memory_summary_instruction>",
      "",
      'Response format: {"title":"...","subtitle":"...","body":["..."],"pullQuote":"...","qa":[{"q":"...","a":"..."}],"memorySummary":"..."}',
    ].join("\n"),
  );

  const fallbackTitle = params.theme.slice(0, 40) || "Untitled Interview";
  const article: InterviewArticle = {
    title: cleanText(result?.title, 40) || fallbackTitle,
    subtitle: cleanText(result?.subtitle, 90) || "A conversation about silence, detail, and the present moment.",
    body: cleanArray(result?.body, 5, 420),
    pullQuote: cleanText(result?.pullQuote, 80),
    qa: Array.isArray(result?.qa)
      ? result!.qa!.map((item) => ({
        q: cleanText((item as Record<string, unknown>).q, 140),
        a: cleanText((item as Record<string, unknown>).a, 220),
      })).filter((item) => item.q && item.a).slice(0, 3)
      : [],
    memorySummary: normalizeUserNameToMacro(cleanText(result?.memorySummary, 360), context.userName),
  };

  if (article.body.length === 0) {
    article.body = [
      "When the interview ended there was a brief quiet in the room. The answers were in no hurry to become conclusions; they sat there like a recorder left on the table, still slightly warm.",
      `Around "${params.theme}", ${context.guestListText} and ${context.userName} pushed the questions somewhere more private and more concrete.`,
    ];
  }

  if (!article.memorySummary) {
    article.memorySummary = `Around "${params.theme}", ${context.guestListText} and {{user}} completed an interview; the conversation centred on concrete choices, relational tension, and unspoken shifts in attitude.`;
  }

  return { context, article };
}
