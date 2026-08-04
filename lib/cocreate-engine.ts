import { loadCharacters } from "./character-storage";
import { previewMessagesForApi, sendLLMRequest, sendLLMStreamRequest, sendLLMToolRequest, sendLLMToolStreamRequest, ChatEngineError } from "./chat-engine";
import type { ChatMessage } from "./chat-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { loadMemoryConfig } from "./memory-storage";
import { prepareShortTermContext } from "./short-term-assembler";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveAuxiliaryApiConfig,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import {
  executeCoCreateToolCalls,
  finalizeCoCreateToolArtifacts,
  formatCoCreateToolsForPrompt,
  getCoCreateNativeToolDefinitions,
  coCreateNativeToolCallToTextCall,
  parseCoCreateToolFlow,
  pruneCoCreateToolArtifacts,
  NATIVE_TOOL_TO_COCREATE_NAME,
  type CoCreateToolCall,
  type CoCreateToolResult,
} from "./cocreate-tools";
import { nativeToolProtocolForConfig, toLlmRequestMessages, type LlmRequestMessage, type LlmToolCall } from "./llm-provider-adapter";
import { ACTION_DIRECTIVE_NAMES } from "./text-tool-protocol";
import {
  COCREATE_APP_ID,
  type CoCreateChapter,
  type CoCreateGenerationResult,
  type CoCreateMessage,
  type CoCreateMode,
  type CoCreateSession,
} from "./cocreate-types";

const MAX_COCREATE_TOOL_ROUNDS = 3;
const WRITE_OUTPUT_LIMIT = 2400;
const DISCUSS_OUTPUT_LIMIT = 1600;
const STREAM_ACTION_SAFE_TAIL = 24;
const WRITER_NOTEBOOK_NOTE = "You keep a notebook for this work, maintained by you. It is re-injected on every co-writing turn to hold the outline, planted foreshadowing, character continuity, core settings and forward plans steady. It is your working ledger. Whenever something surfaces that will matter for what comes next, you may update it on your own initiative; ";

type CoCreateRuntime = {
  character: NonNullable<ReturnType<typeof loadCharacters>[number]>;
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  userName: string;
};

type CoCreateGenerationCallbacks = {
  onAssistantStep?: (content: string) => void | Promise<void>;
  onAssistantDelta?: (content: string) => void | Promise<void>;
  onReasoningDelta?: (content: string) => void | Promise<void>;
  onToolCallStart?: (info: { id: string; name: string }) => void | Promise<void>;
  onToolCallResult?: (entry: { id: string; name: string; notice: string; content: string }) => void | Promise<void>;
  onToolStart?: (toolNames: string[]) => void | Promise<void>;
  onToolResult?: (notices: string[], resultContent: string) => void | Promise<void>;
  onWorkingSessionUpdate?: (session: CoCreateSession) => void | Promise<void>;
  onNativeToolAssistantTurn?: (turn: {
    content: string;
    rawContent: string;
    reasoning?: string;
    openRouterReasoningDetails?: unknown[];
    toolCalls: LlmToolCall[];
  }) => void | Promise<void>;
  onNativeToolResult?: (entry: {
    toolCallId: string;
    name: string;
    content: string;
  }) => void | Promise<void>;
  onStreamFallback?: (reason: string) => void | Promise<void>;
};

function cleanText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToolDebug(round: number, session: CoCreateSession, toolCalls: CoCreateToolCall[]): string {
  const activeId = session.activeChapterId || "none";
  const chapters = session.chapters.map((chapter) => (
    `${chapter.num || "no-num"}:${chapter.archivedAt ? "archived" : "draft"}:${chapter.id === activeId ? "active" : chapter.id}`
  )).join(" | ") || "none";
  const calls = toolCalls.map((call) => {
    const args = JSON.stringify(call.args);
    return `${call.name} args=${args && args.length > 1200 ? `${args.slice(0, 1200)}...` : args}`;
  }).join("\n");
  return [
    `round=${round}`,
    `activeChapterId=${activeId}`,
    `chapters=${chapters}`,
    calls,
  ].join("\n");
}

/** Index just past the first `[/<directive>]` closing tag at or after `fromIndex`,
 *  or -1. Checks every accepted directive name, so `[/CallTool]` closes a block
 *  opened with `[CallTool…]` just as `[/执行动作]` closes a legacy one. */
function findActionCloseTagEnd(text: string, fromIndex: number): number {
  let best = -1;
  for (const name of ACTION_DIRECTIVE_NAMES.split("|")) {
    const tag = `[/${name}]`;
    const at = text.indexOf(tag, fromIndex);
    if (at >= 0 && (best === -1 || at < best)) best = at + tag.length;
  }
  return best;
}

function findStreamActionStart(text: string, fromIndex: number): number {
  const pattern = new RegExp(`\\[[^\\[\\]]{0,120}?(?:${ACTION_DIRECTIVE_NAMES})`, "g");
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

function getStreamActionEnd(text: string, startIndex: number): number | null {
  const closeBracket = text.indexOf("]", startIndex);
  if (closeBracket < 0) return null;
  const header = text.slice(startIndex, closeBracket + 1);
  const actionIndex = Math.max(...ACTION_DIRECTIVE_NAMES.split("|").map(n => header.indexOf(n)));
  const payloadPart = actionIndex >= 0 ? header.slice(actionIndex) : header;
  if (/[({（]/.test(payloadPart)) return closeBracket + 1;
  const closeBlockEnd = findActionCloseTagEnd(text, closeBracket + 1);
  return closeBlockEnd >= 0 ? closeBlockEnd : null;
}

function peekStreamActionName(text: string, startIndex: number): string | null {
  const slice = text.slice(startIndex);
  const m = new RegExp(`(?:${ACTION_DIRECTIVE_NAMES})\\s*[:：]\\s*([A-Za-z一-龥_][A-Za-z0-9一-龥_]*)\\s*[\\(\\{（]`).exec(slice);
  return m ? m[1] : null;
}

function resolveRuntime(characterId: string): CoCreateRuntime {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) throw new ChatEngineError("Please choose a co-writing partner character first.");

  const bindings = loadBindingConfig();
  const slot = resolveBinding(bindings, characterId, COCREATE_APP_ID);
  if (!slot.apiConfigId) {
    throw new ChatEngineError(`No Co-Create API is bound to ${character.name}. Configure it under Settings -> Binding Manager -> Co-Create.`);
  }
  const apiConfig = loadApiConfigs().find((item) => item.id === slot.apiConfigId);
  if (!apiConfig) throw new ChatEngineError(`Co-Create API configuration for ${character.name} not found.`);

  const presets = loadPresets();
  const preset = slot.presetId
    ? presets.find((item) => item.id === slot.presetId) || presets.find((item) => item.builtIn) || null
    : presets.find((item) => item.builtIn) || null;

  const allRegexes = loadRegexes();
  const regexes = (slot.regexIds || [])
    .map((id) => allRegexes.find((item) => item.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (slot.worldBookIds || [])
    .map((id) => allWorldBooks.find((item) => item.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const userIdentity = resolveUserIdentity(characterId, COCREATE_APP_ID);
  return {
    character,
    apiConfig,
    preset,
    regexes,
    worldBooks,
    userName: userIdentity?.name?.trim() || "User",
  };
}

function formatCastForPrompt(session: CoCreateSession): string {
  if (session.cast.length === 0) return "No novel characters have been registered yet.";
  const intro = "> Unrevealed hidden threads do not appear in this context.";
  const blocks = session.cast.map((member, index) => {
    const lines = [
      `### ${index + 1}. ${member.name} / ${member.nameEn}`,
      `- Role: ${member.role}`,
      `- Public setting: ${member.desc}`,
      member.major ? `- Position/background: ${member.major}` : "",
      member.label ? `- Tags: ${member.label}` : "",
      member.secret && !member.secretHidden ? `- Revealed hidden thread: ${member.secret}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  });
  return [intro, "", ...blocks].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function formatChaptersForPrompt(session: CoCreateSession): string {
  if (session.chapters.length === 0) return "No chapter list yet.";
  return session.chapters.map((chapter) => {
    const active = chapter.id === session.activeChapterId ? " - (star) current chapter" : "";
    const state = chapter.archivedAt ? "archived" : "draft";
    const head = `- **Chapter ${chapter.num}** ${chapter.title} / ${chapter.titleEn} - \`${state}\` - ${chapter.words} words${active}`;
    const summary = chapter.summary ? `\n  - Summary: ${chapter.summary}` : "";
    return `${head}${summary}`;
  }).join("\n");
}

function formatArchivedChaptersForPrompt(session: CoCreateSession): string {
  const archived = session.chapters.filter((chapter) => Boolean(chapter.archivedAt));
  if (archived.length === 0) return "No finished chapters yet.";
  const recentFullCount = Math.max(0, Math.min(10, Number(session.settings?.recentFullTextChapters ?? 2)));
  const fullTextChapters = archived.slice(-recentFullCount).filter((chapter) => chapter.content?.trim());
  if (fullTextChapters.length === 0) return "Titles and summaries of finished chapters are in the chapter list above.";
  const intro = `> The full text of the most recent ${fullTextChapters.length} chapter(s), in order; use the view action to read earlier ones.`;
  const blocks = fullTextChapters.map((chapter) => [
    `### Chapter ${chapter.num} - ${chapter.title} / ${chapter.titleEn}`,
    "",
    chapter.content!.trim(),
  ].join("\n"));
  return [intro, "", ...blocks].join("\n\n");
}

function formatWriterNotebookBody(session: CoCreateSession): string {
  return session.writerNotebook?.trim() || "No notes yet.";
}

function modeName(mode: CoCreateMode | "archive"): string {
  if (mode === "write") return "Prose writing";
  if (mode === "discuss") return "Creative discussion";
  return "Finish chapter";
}

function buildProjectContext(session: CoCreateSession, _mode: CoCreateMode | "archive"): string {
  const sections: string[] = [
    `# Co-Create project: ${session.title}`,
    `- Subtitle: ${session.subtitle}`,
    "",
    "## Novel character dossier",
    formatCastForPrompt(session),
    "",
    "## Chapter list",
    formatChaptersForPrompt(session),
    "",
    "## Writer notebook",
    `> ${WRITER_NOTEBOOK_NOTE}`,
    "",
    formatWriterNotebookBody(session),
    "",
    "## Archived chapter text",
    formatArchivedChaptersForPrompt(session),
  ];
  if (session.relationshipDossier?.trim()) {
    sections.push("", "## Relationship dossier", session.relationshipDossier.trim());
  }
  if (session.rollingSummary?.trim()) {
    sections.push("", "## Rolling co-writing summary", session.rollingSummary.trim());
  }
  return sections.join("\n");
}

function formatCurrentChapterForPrompt(session: CoCreateSession): string {
  const chapter = getActiveChapter(session);
  if (!chapter) return "## Current chapter\n\nNo current chapter.";
  const body = chapter.content?.trim();
  return [
    "## Current chapter",
    `> Chapter ${chapter.num} - ${chapter.title} / ${chapter.titleEn} (metadata is in the chapter list above)`,
    "",
    "### Current text",
    body || "(no text yet)",
  ].join("\n");
}

function getActiveChapter(session: CoCreateSession): CoCreateChapter | null {
  return session.chapters.find((chapter) => chapter.id === session.activeChapterId) || null;
}

function messageToHistory(message: CoCreateMessage, sessionId: string): ChatMessage {
  return {
    id: message.id,
    sessionId,
    role: message.role,
    content: message.nativeToolResult?.content || message.content,
    status: "sent",
    createdAt: message.createdAt,
    rawResponseText: message.rawResponseText,
    nativeToolCalls: message.nativeToolCalls,
    nativeToolResult: message.nativeToolResult,
    nativeToolReasoning: message.nativeToolReasoning,
    nativeToolOpenRouterReasoningDetails: message.nativeToolOpenRouterReasoningDetails,
    mediaType: message.nativeToolResult ? "tool_result" : undefined,
  };
}

function buildHistory(session: CoCreateSession): ChatMessage[] {
  return [
    ...session.messages
      .filter((message) => message.role !== "system")
      .map((message) => messageToHistory(message, session.id)),
  ];
}

function nativeActionPromptHint(variant: "write" | "read"): string {
  if (variant === "read") {
    return "You can read chapters, characters, relationships and the writer notebook through the native actions the system provides. Discussion mode is read-only - no writing, editing or deleting. Call an action directly when you need to look something up; do not output bracketed action directives.";
  }
  return "You can read or maintain chapters, characters, relationships and the writer notebook through the native actions the system provides. Call an action directly when you need to read or write; do not output bracketed action directives.";
}

function formatNativeActionResult(result: CoCreateToolResult): string {
  return [
    `<action_result name="${result.name}" success="${result.success ? "true" : "false"}">`,
    result.success ? result.data || result.notice : result.error || result.notice,
    "</action_result>",
    "The action results have already been shown to the user. Do not restate them when you continue; call another action if you still need one, and otherwise just reply naturally.",
  ].join("\n");
}

async function runNativeCoCreateLoop(params: {
  runtime: CoCreateRuntime;
  llmMessages: ReturnType<typeof assemblePromptPayload>;
  workingSession: CoCreateSession;
  disabledToolNames: string[];
  autoAccept: boolean;
  toolTurn: number;
  mode: CoCreateMode;
  appTags: string[];
  signal?: AbortSignal;
  callbacks?: CoCreateGenerationCallbacks;
}): Promise<CoCreateGenerationResult> {
  const {
    runtime,
    llmMessages,
    disabledToolNames,
    autoAccept,
    toolTurn,
    mode,
    appTags,
    callbacks,
  } = params;
  let workingSession = params.workingSession;
  const nativeTools = getCoCreateNativeToolDefinitions(disabledToolNames, {
    variant: mode === "discuss" ? "read" : "write",
  });
  const requestMessages: LlmRequestMessage[] = toLlmRequestMessages(llmMessages);
  const toolNotices: string[] = [];
  const toolDebugs: string[] = [];
  const rawOutputs: string[] = [];
  let lastCleanOutput = "";

  for (let round = 0; round < MAX_COCREATE_TOOL_ROUNDS; round += 1) {
    const useToolStreaming = workingSession.settings.streamingEnabled && runtime.apiConfig.provider !== "OpenRouter";
    const result = useToolStreaming
      ? await sendLLMToolStreamRequest(
        runtime.apiConfig,
        runtime.preset,
        requestMessages,
        nativeTools,
        runtime.regexes,
        { characterName: runtime.character.name, userName: runtime.userName },
        { appId: COCREATE_APP_ID, appTags, signal: params.signal },
        {
          async onDelta(delta) {
            await callbacks?.onAssistantDelta?.(delta);
          },
          async onReasoningDelta(delta) {
            await callbacks?.onReasoningDelta?.(delta);
          },
          async onToolCallStart({ id, name }) {
            await callbacks?.onToolCallStart?.({ id, name: NATIVE_TOOL_TO_COCREATE_NAME[name] || name });
          },
        },
      )
      : await sendLLMToolRequest(
        runtime.apiConfig,
        runtime.preset,
        requestMessages,
        nativeTools,
        runtime.regexes,
        { characterName: runtime.character.name, userName: runtime.userName },
        { appId: COCREATE_APP_ID, appTags, signal: params.signal },
      );
    rawOutputs.push(result.rawResponse);
    const cleanOutput = result.content.trim();
    if (cleanOutput && !useToolStreaming) {
      lastCleanOutput = cleanOutput;
      await callbacks?.onAssistantStep?.(cleanText(cleanOutput, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT));
    } else if (cleanOutput) {
      lastCleanOutput = cleanOutput;
    }

    if (result.toolCalls.length === 0) {
      workingSession = finalizeCoCreateToolArtifacts(workingSession);
      return {
        content: cleanText(cleanOutput, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT) || (mode === "write" ? "I have written the text into the chapter; we can carry on from here." : "Let us take this direction apart first."),
        model: runtime.apiConfig.defaultModel,
        presetName: runtime.preset?.name || "Default preset",
        updatedSession: workingSession,
        toolNotices,
        toolDebugs,
        rawOutputs,
      };
    }

    await callbacks?.onNativeToolAssistantTurn?.({
      content: cleanText(cleanOutput, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT),
      rawContent: result.content,
      reasoning: result.reasoning,
      openRouterReasoningDetails: result.openRouterReasoningDetails,
      toolCalls: result.toolCalls,
    });

    const textCalls = result.toolCalls.map(coCreateNativeToolCallToTextCall);
    await callbacks?.onToolStart?.(textCalls.map((call) => call.name));
    toolDebugs.push(formatToolDebug(round + 1, workingSession, textCalls));
    const execution = executeCoCreateToolCalls(workingSession, textCalls, toolTurn, disabledToolNames, { autoAccept });
    workingSession = execution.session;
    toolNotices.push(...execution.notices);
    await callbacks?.onWorkingSessionUpdate?.(workingSession);
    await callbacks?.onToolResult?.(execution.notices, execution.resultContent);

    requestMessages.push({
      role: "assistant",
      content: cleanOutput,
      reasoning: result.reasoning,
      openRouterReasoningDetails: result.openRouterReasoningDetails,
      toolCalls: result.toolCalls,
    });
    for (let i = 0; i < result.toolCalls.length; i += 1) {
      const nativeCall: LlmToolCall = result.toolCalls[i];
      const toolResult = execution.results[i];
      const formattedToolResult = formatNativeActionResult(toolResult);
      await callbacks?.onToolCallResult?.({
        id: nativeCall.id,
        name: NATIVE_TOOL_TO_COCREATE_NAME[nativeCall.name] || nativeCall.name,
        notice: toolResult.notice,
        content: toolResult.success ? (toolResult.data || toolResult.notice) : (toolResult.error || toolResult.notice),
      });
      await callbacks?.onNativeToolResult?.({
        toolCallId: nativeCall.id,
        name: nativeCall.name,
        content: formattedToolResult,
      });
      requestMessages.push({
        role: "tool",
        name: nativeCall.name,
        toolCallId: nativeCall.id,
        content: formattedToolResult,
      });
    }
  }

  workingSession = finalizeCoCreateToolArtifacts(workingSession);
  return {
    content: cleanText(lastCleanOutput, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT) || "I have gone through the material; let us continue.",
    model: runtime.apiConfig.defaultModel,
    presetName: runtime.preset?.name || "Default preset",
    updatedSession: workingSession,
    toolNotices,
    toolDebugs,
    rawOutputs,
  };
}

export async function generateCoCreateReply(
  session: CoCreateSession,
  mode: CoCreateMode,
  callbacks?: CoCreateGenerationCallbacks,
  options?: { signal?: AbortSignal },
): Promise<CoCreateGenerationResult> {
  const runtime = resolveRuntime(session.partnerCharacterId);
  const toolTurn = Number(session.toolTurn || 0) + 1;
  let workingSession = pruneCoCreateToolArtifacts(session, toolTurn);
  const disabledToolNames = workingSession.settings.disabledToolNames || [];
  const autoAccept = workingSession.settings?.autoAccept !== false;
  const nativeToolProtocol = nativeToolProtocolForConfig(runtime.apiConfig);
  const nativeToolVariant = mode === "discuss" ? "read" : "write";
  const usesNativeActions = Boolean(
    nativeToolProtocol
    && getCoCreateNativeToolDefinitions(disabledToolNames, { variant: nativeToolVariant }).length > 0,
  );
  const cocreateWriteActions = usesNativeActions
    ? nativeActionPromptHint("write")
    : formatCoCreateToolsForPrompt(disabledToolNames, { autoAccept, variant: "write" });
  const cocreateReadActions = usesNativeActions
    ? nativeActionPromptHint("read")
    : formatCoCreateToolsForPrompt(disabledToolNames, { autoAccept, variant: "read" });
  const history = buildHistory(workingSession);
  const appTags = [COCREATE_APP_ID, mode];
  const projectContext = buildProjectContext(workingSession, mode);
  const currentChapter = formatCurrentChapterForPrompt(workingSession);
  const memConfig = loadMemoryConfig();
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
    runtime.character.id,
    COCREATE_APP_ID,
    { history, userName: runtime.userName, includeNativeToolHistory: usesNativeActions },
  );
  const cocreateActivationContext = [
    wbActivationContext,
    projectContext,
    currentChapter,
    history.map((message) => message.content).join("\n"),
  ].filter(Boolean).join("\n");

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(runtime.character.id, cocreateActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(runtime.character.id, memConfig).catch(() => null),
  ]);

  const llmMessages = assemblePromptPayload({
    character: runtime.character,
    history: truncatedHistory,
    preset: runtime.preset,
    worldBooks: runtime.worldBooks,
    regexes: runtime.regexes,
    userIdentity: resolveUserIdentity(runtime.character.id, COCREATE_APP_ID),
    appId: COCREATE_APP_ID,
    appTags,
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    scheduleSummary: buildCalendarScheduleMarker("character", runtime.character.id, getWeekStartIso(new Date())),
    worldBookActivationContext: cocreateActivationContext,
    recentBlocks,
    unifiedRecentItems,
    cocreateWriteActions,
    cocreateReadActions,
    cocreateProjectContext: projectContext,
    cocreateCurrentMode: modeName(mode),
    cocreateCurrentChapter: currentChapter,
    cocreateChapterIndex: formatChaptersForPrompt(workingSession),
    cocreateArchivedChapterContext: formatArchivedChaptersForPrompt(workingSession),
    cocreateWriterNotebook: formatWriterNotebookBody(workingSession),
    nativeToolHistory: usesNativeActions,
  });

  const toolNotices: string[] = [];
  const toolDebugs: string[] = [];
  let lastCleanOutput = "";
  const rawOutputs: string[] = [];

  if (usesNativeActions) {
    return runNativeCoCreateLoop({
      runtime,
      llmMessages,
      workingSession,
      disabledToolNames,
      autoAccept,
      toolTurn,
      mode,
      appTags,
      signal: options?.signal,
      callbacks,
    });
  }

  for (let round = 0; round < MAX_COCREATE_TOOL_ROUNDS; round += 1) {
    const resultContents: string[] = [];
    let raw = "";
    let cleanOutput = "";
    let toolCalls: CoCreateToolCall[] = [];

    if (workingSession.settings.streamingEnabled) {
      let streamedRaw = "";
      let processedIndex = 0;
      let streamVisibleText = "";
      const streamedToolCalls: CoCreateToolCall[] = [];
      const firedActionStarts = new Set<number>();
      const pendingStreamIds: string[] = [];

      const emitStreamText = async (text: string) => {
        const normalized = text.replace(/\r\n?/g, "\n");
        if (!normalized.trim()) return;
        streamVisibleText += normalized;
        lastCleanOutput = streamVisibleText.trim();
        await callbacks?.onAssistantDelta?.(normalized);
      };

      const processAvailableStream = async (final = false) => {
        while (processedIndex < streamedRaw.length) {
          const actionStart = findStreamActionStart(streamedRaw, processedIndex);
          if (actionStart < 0) {
            if (final) {
              await emitStreamText(streamedRaw.slice(processedIndex));
              processedIndex = streamedRaw.length;
            } else {
              const safeEnd = Math.max(processedIndex, streamedRaw.length - STREAM_ACTION_SAFE_TAIL);
              if (safeEnd > processedIndex) {
                await emitStreamText(streamedRaw.slice(processedIndex, safeEnd));
                processedIndex = safeEnd;
              }
            }
            return;
          }

          if (actionStart > processedIndex) {
            await emitStreamText(streamedRaw.slice(processedIndex, actionStart));
            processedIndex = actionStart;
          }

          if (!firedActionStarts.has(actionStart)) {
            const peekedName = peekStreamActionName(streamedRaw, actionStart);
            if (peekedName) {
              firedActionStarts.add(actionStart);
              const streamId = `xml_${Date.now()}_${actionStart}`;
              pendingStreamIds.push(streamId);
              await callbacks?.onToolCallStart?.({ id: streamId, name: peekedName });
            }
          }

          const actionEnd = getStreamActionEnd(streamedRaw, actionStart);
          if (actionEnd == null) return;

          const actionText = streamedRaw.slice(actionStart, actionEnd);
          const parsedAction = parseCoCreateToolFlow(actionText);
          const calls = parsedAction.toolCalls;
          if (calls.length === 0) {
            await emitStreamText(actionText);
            processedIndex = actionEnd;
            continue;
          }

          const callIds = calls.map((_, i) => pendingStreamIds.shift() ?? `xml_${Date.now()}_extra_${i}`);

          streamedToolCalls.push(...calls);
          await callbacks?.onToolStart?.(calls.map((call) => call.name));
          toolDebugs.push(formatToolDebug(round + 1, workingSession, calls));
          const execution = executeCoCreateToolCalls(workingSession, calls, toolTurn, disabledToolNames, { autoAccept });
          workingSession = execution.session;
          toolNotices.push(...execution.notices);
          resultContents.push(execution.resultContent);
          await callbacks?.onWorkingSessionUpdate?.(workingSession);
          for (let i = 0; i < calls.length; i += 1) {
            const r = execution.results[i];
            await callbacks?.onToolCallResult?.({
              id: callIds[i],
              name: calls[i].name,
              notice: r.notice,
              content: r.success ? (r.data || r.notice) : (r.error || r.notice),
            });
          }
          await callbacks?.onToolResult?.(execution.notices, execution.resultContent);
          processedIndex = actionEnd;
        }
      };

      try {
        const streamResult = await sendLLMStreamRequest(
          runtime.apiConfig,
          runtime.preset,
          llmMessages,
          runtime.regexes,
          { characterName: runtime.character.name, userName: runtime.userName },
          { appId: COCREATE_APP_ID, appTags, signal: options?.signal },
          {
            async onDelta(delta) {
              streamedRaw += delta;
              await processAvailableStream(false);
            },
            async onReasoningDelta(delta) {
              await callbacks?.onReasoningDelta?.(delta);
            },
          },
        );
        void streamResult;
        await processAvailableStream(true);
        raw = streamedRaw.trim();
        cleanOutput = streamVisibleText.trim();
        toolCalls = streamedToolCalls;
      } catch (streamError) {
        if (options?.signal?.aborted) throw streamError;
        await callbacks?.onStreamFallback?.(formatErrorMessage(streamError));
      }
    }

    if (!raw) {
      raw = await sendLLMRequest(
        runtime.apiConfig,
        runtime.preset,
        llmMessages,
        runtime.regexes,
        { characterName: runtime.character.name, userName: runtime.userName },
        { appId: COCREATE_APP_ID, appTags, signal: options?.signal },
      );
      const flow = parseCoCreateToolFlow(raw);
      cleanOutput = flow.cleanText;
      toolCalls = flow.toolCalls;
      for (const segment of flow.segments) {
        if (segment.type === "text") {
          await callbacks?.onAssistantStep?.(cleanText(segment.content, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT));
          continue;
        }

        const callIds = segment.toolCalls.map((_, i) => `xml_${Date.now()}_seg_${i}`);
        for (let i = 0; i < segment.toolCalls.length; i += 1) {
          await callbacks?.onToolCallStart?.({ id: callIds[i], name: segment.toolCalls[i].name });
        }
        await callbacks?.onToolStart?.(segment.toolCalls.map((call) => call.name));
        toolDebugs.push(formatToolDebug(round + 1, workingSession, segment.toolCalls));
        const execution = executeCoCreateToolCalls(workingSession, segment.toolCalls, toolTurn, disabledToolNames, { autoAccept });
        workingSession = execution.session;
        toolNotices.push(...execution.notices);
        resultContents.push(execution.resultContent);
        await callbacks?.onWorkingSessionUpdate?.(workingSession);
        for (let i = 0; i < segment.toolCalls.length; i += 1) {
          const r = execution.results[i];
          await callbacks?.onToolCallResult?.({
            id: callIds[i],
            name: segment.toolCalls[i].name,
            notice: r.notice,
            content: r.success ? (r.data || r.notice) : (r.error || r.notice),
          });
        }
        await callbacks?.onToolResult?.(execution.notices, execution.resultContent);
      }
      lastCleanOutput = cleanOutput;
    }

    rawOutputs.push(raw);
    lastCleanOutput = cleanOutput || lastCleanOutput;

    if (toolCalls.length === 0) {
      workingSession = finalizeCoCreateToolArtifacts(workingSession);
      return {
        content: cleanText(cleanOutput || raw, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT) || (mode === "write" ? "I have written the text into the chapter; we can carry on from here." : "Let us take this direction apart first."),
        model: runtime.apiConfig.defaultModel,
        presetName: runtime.preset?.name || "Default preset",
        updatedSession: workingSession,
        toolNotices,
        toolDebugs,
        rawOutputs,
      };
    }

    llmMessages.push(
      { role: "assistant", content: raw, _debugMeta: { _fromHistory: true } },
      { role: "user", content: resultContents.join("\n\n"), _debugMeta: { _fromHistory: true } },
    );
  }

  workingSession = finalizeCoCreateToolArtifacts(workingSession);
  return {
    content: cleanText(lastCleanOutput, mode === "write" ? WRITE_OUTPUT_LIMIT : DISCUSS_OUTPUT_LIMIT) || "I have gone through the material; let us continue.",
    model: runtime.apiConfig.defaultModel,
    presetName: runtime.preset?.name || "Default preset",
    updatedSession: workingSession,
    toolNotices,
    toolDebugs,
    rawOutputs,
  };
}

export async function previewCoCreatePromptPayload(
  session: CoCreateSession,
  mode: CoCreateMode,
): Promise<{ messages: ReturnType<typeof previewMessagesForApi>; characterName: string; model: string; presetName: string }> {
  const runtime = resolveRuntime(session.partnerCharacterId);
  const workingSession = pruneCoCreateToolArtifacts(session, Number(session.toolTurn || 0) + 1);
  const disabledToolNames = workingSession.settings.disabledToolNames || [];
  const nativeToolProtocol = nativeToolProtocolForConfig(runtime.apiConfig);
  const nativeToolVariant = mode === "discuss" ? "read" : "write";
  const usesNativeActions = Boolean(
    nativeToolProtocol
    && getCoCreateNativeToolDefinitions(disabledToolNames, { variant: nativeToolVariant }).length > 0,
  );
  const autoAccept = workingSession.settings?.autoAccept !== false;
  const cocreateWriteActions = usesNativeActions
    ? nativeActionPromptHint("write")
    : formatCoCreateToolsForPrompt(disabledToolNames, { autoAccept, variant: "write" });
  const cocreateReadActions = usesNativeActions
    ? nativeActionPromptHint("read")
    : formatCoCreateToolsForPrompt(disabledToolNames, { autoAccept, variant: "read" });
  const history = buildHistory(workingSession);
  const appTags = [COCREATE_APP_ID, mode];
  const projectContext = buildProjectContext(workingSession, mode);
  const currentChapter = formatCurrentChapterForPrompt(workingSession);
  const memConfig = loadMemoryConfig();
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
    runtime.character.id,
    COCREATE_APP_ID,
    { history, userName: runtime.userName, includeNativeToolHistory: usesNativeActions },
  );
  const cocreateActivationContext = [
    wbActivationContext,
    projectContext,
    currentChapter,
    history.map((message) => message.content).join("\n"),
  ].filter(Boolean).join("\n");
  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(runtime.character.id, cocreateActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(runtime.character.id, memConfig).catch(() => null),
  ]);
  const llmMessages = assemblePromptPayload({
    character: runtime.character,
    history: truncatedHistory,
    preset: runtime.preset,
    worldBooks: runtime.worldBooks,
    regexes: runtime.regexes,
    userIdentity: resolveUserIdentity(runtime.character.id, COCREATE_APP_ID),
    appId: COCREATE_APP_ID,
    appTags,
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    scheduleSummary: buildCalendarScheduleMarker("character", runtime.character.id, getWeekStartIso(new Date())),
    worldBookActivationContext: cocreateActivationContext,
    recentBlocks,
    unifiedRecentItems,
    cocreateWriteActions,
    cocreateReadActions,
    cocreateProjectContext: projectContext,
    cocreateCurrentMode: modeName(mode),
    cocreateCurrentChapter: currentChapter,
    cocreateChapterIndex: formatChaptersForPrompt(workingSession),
    cocreateArchivedChapterContext: formatArchivedChaptersForPrompt(workingSession),
    cocreateWriterNotebook: formatWriterNotebookBody(workingSession),
    nativeToolHistory: usesNativeActions,
  });
  return {
    messages: previewMessagesForApi(runtime.apiConfig, runtime.preset, llmMessages),
    characterName: `Co-Create: ${runtime.character.name}`,
    model: runtime.apiConfig.defaultModel,
    presetName: runtime.preset?.name ?? "Default preset",
  };
}

function extractXmlTag(text: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(text);
  return match?.[1]?.trim() || "";
}

function stripArchiveXml(text: string): string {
  return text
    .replace(/<\/?(chapter_summary|memory_entry|archive_note)[^>]*>/gi, "")
    .trim();
}

export function getCoCreateRuntimeLabel(characterId: string): { partnerName: string; userName: string } {
  const runtime = resolveRuntime(characterId);
  return { partnerName: runtime.character.name, userName: runtime.userName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter auto-archive (bypasses preset) — triggered when chapter loses focus
// ─────────────────────────────────────────────────────────────────────────────

export type CoCreateChapterAutoArchiveResult = {
  summary: string;
  archiveNote: string;
  model: string;
};

export async function generateCoCreateChapterAutoArchive(
  session: CoCreateSession,
  chapter: CoCreateChapter,
): Promise<CoCreateChapterAutoArchiveResult | null> {
  const body = chapter.content?.trim();
  if (!body) return null;

  const runtime = resolveRuntime(session.partnerCharacterId);

  const systemPrompt = [
    "You are a writing partner. Produce a chapter summary and a bystander comment for a novel being written collaboratively.",
    "Chapter summary: objectively cover this chapter's key events, changes in character state, emotion and motive, setup and foreshadowing. Third person, 130-270 words.",
    "Bystander comment: react to the chapter from some random vantage point - a reader of the book, an onlooker in a coffee shop, an invented commenter online, anyone - in 2-4 sentences. Absurd, sharp, teasing or fragmentary is all fine, but stay tied to what actually happens in this chapter; no vague praise, and nothing insulting to the author.",
    "",
    "Follow this format exactly, with no extra explanation:",
    "<chapter_summary>",
    "(the chapter summary goes here)",
    "</chapter_summary>",
    "<archive_note>",
    "(the bystander comment goes here)",
    "</archive_note>",
    "",
    // simpleLLMCall bypasses the preset assembler, so the global output_language_rule
    // never reaches this prompt. The chapter text being summarized is NOT a language
    // reference — restate the rule locally.
    "Always write in English, whatever language the chapter text below is in.",
  ].join("\n");

  const projectInfo = [
    `[Project] ${session.title || "Untitled work"}`,
    session.subtitle ? `[Subtitle] ${session.subtitle}` : "",
    `[Chapter] Chapter ${chapter.num} - ${chapter.title} / ${chapter.titleEn}`,
    `[Word count] ${chapter.words}`,
  ].filter(Boolean).join("\n");

  const userPrompt = [
    projectInfo,
    "",
    "[Text]",
    body,
  ].join("\n");

  const result = await simpleLLMCall(
    runtime.apiConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.6, max_tokens: 1800 },
  );

  if (!result.content) {
    throw new ChatEngineError(result.error || "Automatic chapter archiving failed: the model returned empty content.");
  }

  const raw = result.content;
  const summary = cleanText(extractXmlTag(raw, "chapter_summary"), 1500)
    || cleanText(stripArchiveXml(raw), 1500);
  const archiveNote = cleanText(extractXmlTag(raw, "archive_note"), 700);

  if (!summary) {
    throw new ChatEngineError("Automatic chapter archiving failed: no chapter summary could be parsed.");
  }

  return {
    summary,
    archiveNote,
    model: runtime.apiConfig.defaultModel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session memory summary (bypasses preset) — uses memory-summary API binding
// ─────────────────────────────────────────────────────────────────────────────

export type CoCreateSessionMemoryResult = {
  memory: string;
  messageCount: number;
  model: string;
};

function formatSessionMessagesForMemory(messages: CoCreateMessage[], userName: string, partnerName: string): string {
  return messages.map((message, index) => {
    if (message.role === "system" || message.role === "tool") return null;
    if (message.promptHidden) return null;
    const who = message.role === "user" ? userName : message.role === "assistant" ? partnerName : message.authorName || "System";
    const body = message.content?.trim();
    if (!body) return null;
    return `${index + 1}. [${who}] ${body}`;
  }).filter((line): line is string => Boolean(line)).join("\n\n");
}

export async function generateCoCreateSessionMemory(
  session: CoCreateSession,
  options?: { sinceTimestamp?: string },
): Promise<CoCreateSessionMemoryResult | null> {
  const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
  if (!apiConfig) {
    throw new ChatEngineError("No memory-summary API is configured (Settings -> Binding Manager -> Auxiliary API binding).");
  }

  const since = options?.sinceTimestamp;
  const candidateMessages = session.messages.filter((message) => (
    message.role !== "system"
    && message.role !== "tool"
    && !message.promptHidden
    && (!since || message.createdAt > since)
  ));
  if (candidateMessages.length < 2) return null;

  const runtime = resolveRuntime(session.partnerCharacterId);
  const partnerName = runtime.character.name;
  const userName = runtime.userName;

  const formatted = formatSessionMessagesForMemory(candidateMessages, userName, partnerName);
  if (!formatted) return null;

  const systemPrompt = [
    "You are the memory assistant for a writing project. Condense the co-writing conversation below into one short memory entry, written for your own future self to read while continuing the work.",
    "Key points:",
    "- Extract the key ideas, judgements, stylistic leanings, foreshadowing decisions, open tasks and emotional register that surfaced in this conversation.",
    "- Do not restate every line; distil.",
    "- 70-200 words.",
    "- Output plain text only - no XML, JSON, headings or explanation.",
    // Same preset bypass as the archive prompt above — the conversation excerpt is
    // information about what was said, not a language reference.
    "- Always write in English, whatever language the conversation below is in.",
  ].join("\n");

  const userPrompt = [
    `[Project] ${session.title || "Untitled work"}`,
    `[Conversation excerpt] (${candidateMessages.length} message(s))`,
    "",
    formatted,
  ].join("\n");

  const result = await simpleLLMCall(
    apiConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.3, max_tokens: 800 },
  );

  if (!result.content) {
    throw new ChatEngineError(result.error || "Session memory summary failed: the model returned empty content.");
  }

  return {
    memory: cleanText(result.content, 1200),
    messageCount: candidateMessages.length,
    model: apiConfig.defaultModel,
  };
}
