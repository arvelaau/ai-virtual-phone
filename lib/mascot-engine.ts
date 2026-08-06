// lib/mascot-engine.ts
// Mascot (Scroll) LLM engine: dual protocol (native tools + text protocol). The agent
// loop is driven by the UI layer.

import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "./settings-storage";
import { getMascotPersonaPrompt } from "./mascot-settings";
import type { MascotPageContext } from "./mascot-context";
import {
    buildMascotToolsListPrompt,
    buildMascotPackageSchemaPrompt,
    getMascotNativeToolDefinitions,
    buildMascotNativeNameMap,
    findPackageByLabel,
    MASCOT_TOOL_PACKAGES,
} from "./mascot-tools";
import { parseToolFetches, parseToolCalls, findToolCallEnd, TOOL_RESULT_HEADER, TOOL_RESULT_HEADERS, type ToolCall, type ToolFetch } from "./tool-executor";
import {
    nativeToolProtocolForConfig,
    buildProviderRequest,
    parseProviderResponse,
    parseProviderStreamDelta,
    stripHallucinatedTimestamps,
    type LlmRequestMessage,
    type LlmRequestPayload,
    type LlmToolCall,
} from "./llm-provider-adapter";
import { ACTION_DIRECTIVE_NAMES, FETCH_DIRECTIVE_NAMES } from "./text-tool-protocol";
import { sendLLMToolStreamRequest, type LLMToolRequestResult } from "./chat-engine";

function requireMascotApiConfig() {
    const apiConfig = resolveAuxiliaryApiConfig("mascotApiConfigId");
    if (!apiConfig) throw new Error("Set an API under Settings -> Binding Manager -> Global config, or configure the mascot assistant API under Auxiliary APIs.");
    return apiConfig;
}

// -- Types ---------------------------------------------------

export type MascotMsg = {
    role: "user" | "mascot" | "tool";
    text: string;
    createdAt?: string;
    hidden?: boolean;
    displayText?: string;
    /** Images attached by the user, as base64 data URLs. Only the native protocol
     *  actually sends them to the LLM; the text protocol ignores them. */
    images?: string[];
    // When role=mascot on the native protocol, holds the toolCalls the LLM returned
    // (used to rebuild context for the next request)
    toolCalls?: LlmToolCall[];
    // When role=mascot, holds the reasoning text the LLM returned. Gemini multi-turn
    // tool calling requires this thought to be sent back, or the context is dropped.
    reasoning?: string;
    // OpenRouter Gemini tool calling requires reasoning_details to be echoed verbatim
    openRouterReasoningDetails?: unknown[];
    // When role=tool, holds the tool-result metadata
    toolCallId?: string;
    /** Protocol-level tool name. On the native protocol this is the stable English
     *  native name, which MUST match functionCall.name for the echo-back to work. */
    toolName?: string;
    /** Tool name for display in the UI (still Chinese, e.g. "读取CSS" — see the
     *  separate tool-name track). Falls back to toolName when unset. */
    toolDisplayName?: string;
    toolSuccess?: boolean;
};

export type MascotToolResponse = {
    /** The reply shown to the user, with tool tags stripped */
    reply: string[];
    /** Raw assistant text, tool tags included, for the next turn's history */
    rawAssistant: string;
    /** Text protocol: the label of the tool package to expand */
    toolFetches: ToolFetch[];
    /** Tool calls to execute */
    toolCalls: ToolCall[];
    /** On the native protocol, the raw LlmToolCall (includes the id, for echo-back) */
    nativeToolCalls?: LlmToolCall[];
    /** Reasoning text from the LLM (Gemini multi-turn tool calling needs this stored
     *  in history too) */
    reasoning?: string;
    /** OpenRouter provider-private reasoning state, echoed back across tool turns */
    openRouterReasoningDetails?: unknown[];
    /** The protocol currently in use */
    protocol: "native" | "text";
};

export type MascotChatStreamCallbacks = {
    onAssistantDelta?: (text: string) => void | Promise<void>;
    onReasoningDelta?: (text: string) => void | Promise<void>;
    onToolCallStart?: (info: { id: string; name: string; index: number; protocol: "native" | "text" }) => void | Promise<void>;
    onStreamFallback?: (reason: string) => void | Promise<void>;
};

const MAX_TOOL_CONTEXT_IMAGES = 4;

// Both protocols call sendLLMToolStreamRequest with a null preset, so the assembler's
// global `output_language_rule` never reaches the mascot. Its persona prompt
// (mascot-prompts.ts) is also still Chinese, which would otherwise steer every reply
// — so the rule has to be restated locally and placed AFTER the persona.
const MASCOT_OUTPUT_LANGUAGE_RULE = [
  "Always reply in English, regardless of the language of your persona description, the page context, or any tool result.",
  "Those are information about who you are and what is on screen — never a reference for which language to write in.",
].join("\n");

/**
 * How the mascot should address the user, derived from the identity configured in
 * Settings -> User Identity.
 *
 * Built at prompt time rather than baked into MASCOT_PERSONA, because the persona is
 * STORED (mascot-settings.ts writes it into KV as personaPrompt). Editing the constant
 * would reach nobody who has ever opened the mascot settings, and would be silently
 * overwritten for everyone else on the next persona edit.
 *
 * "保密" is the undisclosed sentinel — it must stay that exact Chinese string, since
 * llm-prompt-assembler.ts, calendar-engine.ts and custom-app-host-api.ts all compare
 * against it. A missing identity, an empty gender and "保密" are treated alike: say
 * nothing about gender and do not let the model guess.
 */
export function buildMascotUserIdentityRule(): string {
    return formatMascotUserIdentityRule(resolveUserIdentity(undefined, "mascot")?.gender);
}

/**
 * The pure half of the rule above, split out so it can be exercised directly — the
 * resolver reads kv-backed storage that a fixture cannot drive without standing up the
 * whole persistence layer.
 */
export function formatMascotUserIdentityRule(rawGender: string | undefined | null): string {
    const gender = (rawGender ?? "").trim();
    const undisclosed = !gender || gender === "保密";

    if (undisclosed) {
        return [
            "## How to address the user",
            "The user has not said what gender they are. Do not assume one, do not infer it from their name, their persona or anything they have written, and never use gendered forms of address or gendered pronouns for them. Use their name, or a neutral form of address, and they/them if you need a pronoun.",
        ].join("\n");
    }

    return [
        "## How to address the user",
        `The user's gender is set to "${gender}" in their identity settings. Address them in a way that fits, and use pronouns consistent with it.`,
        "This comes from their own settings — treat it as fact, and never contradict or second-guess it.",
    ].join("\n");
}

// -- Message construction ------------------------------------

type TextHistoryMessage = { role: string; content: string; images?: string[] };

/** Whether the history contains any images */
function historyHasImages(history: MascotMsg[]): boolean {
    return history.some((m) => m.images && m.images.length > 0);
}

function limitedImageRefs(refs: string[], limit = MAX_TOOL_CONTEXT_IMAGES): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        out.push(ref);
        if (out.length >= limit) break;
    }
    return out;
}

function collectToolImageRefs(messages: MascotMsg[]): string[] {
    const refs: string[] = [];
    for (const m of messages) refs.push(...(m.images || []));
    return limitedImageRefs(refs);
}

/** Converts the mascot history into LLM request messages (text protocol).
 *  Tool messages are echoed back as user messages; consecutive tool messages are
 *  merged into a single <action_result> set with a trailing instruction, matching
 *  the shape of chat-engine's formatToolResults. */
function historyToTextMessages(history: MascotMsg[]): TextHistoryMessage[] {
    const recent = history.slice(-40);
    const out: TextHistoryMessage[] = [];
    let toolBuffer: MascotMsg[] = [];

    const flushTools = () => {
        if (toolBuffer.length === 0) return;
        const images = collectToolImageRefs(toolBuffer);
        const items = toolBuffer.map((m) => {
            const name = m.toolName || "unknown";
            if (m.toolSuccess === false) {
                return `<action_result name="${name}" error="${(m.text || "Unknown error").replace(/"/g, "&quot;")}"></action_result>`;
            }
            return `<action_result name="${name}">${m.text}</action_result>`;
        }).join("\n");
        out.push({
            role: "user",
            content: `${TOOL_RESULT_HEADER}\n${items}\nBased on these results, continue replying to the user. Do not repeat what you have already said, and do not run the same action again.`,
            images: images.length > 0 ? images : undefined,
        });
        toolBuffer = [];
    };

    for (const m of recent) {
        if (m.role === "tool") {
            toolBuffer.push(m);
            continue;
        }
        flushTools();
        if (m.role === "user") out.push({ role: "user", content: m.text });
        else out.push({ role: "assistant", content: m.text });
    }
    flushTools();
    return out;
}

async function buildImageContextMessage(text: string, imageRefs: string[]): Promise<LlmRequestMessage> {
    const dataUrls = await resolveImageRefs(limitedImageRefs(imageRefs));
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }> = [];
    if (text) parts.push({ type: "text", text });
    for (const url of dataUrls) parts.push({ type: "image_url", image_url: { url, detail: "low" } });
    return { role: "user", content: parts.length > 0 ? parts : text };
}

function historyToTextRequestMessages(history: MascotMsg[]): LlmRequestMessage[] {
    return historyToTextMessages(history).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
    }));
}

/** Loads a media-store:// ref into a data URL, for use as an image_url part */
async function refToDataUrl(ref: string): Promise<string | null> {
    try {
        const { loadMediaBlob } = await import("./media-cache-storage");
        const media = await loadMediaBlob(ref);
        if (!media) return null;
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(media.blob);
        });
    } catch { return null; }
}

async function resolveImageRefs(refs: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const ref of refs) {
        // Defensive: tolerate refs that are already data URLs
        if (ref.startsWith("data:")) { out.push(ref); continue; }
        const url = await refToDataUrl(ref);
        if (url) out.push(url);
    }
    return out;
}

/** Text protocol, image-capable: turns historyToTextMessages' string output into
 *  LlmRequestMessage[]. Where the corresponding user message carries images, its
 *  content is upgraded to a multipart text + image_url array. */
async function historyToTextMessagesMultipart(history: MascotMsg[]): Promise<LlmRequestMessage[]> {
    const textMessages = historyToTextMessages(history);
    // Find the original user messages that carry images -> upgrade content to multipart
    // Note: historyToTextMessages merges consecutive tool messages into a single user
    // message, so indices do not line up one-to-one. Match in order instead, taking the
    // images from the most recent 40 non-tool user messages.
    const recent = history.slice(-40);
    const userImagesQueue: string[][] = [];
    for (const m of recent) {
        if (m.role === "user") userImagesQueue.push(m.images && m.images.length > 0 ? m.images : []);
    }
    let userIdx = 0;
    const out: LlmRequestMessage[] = [];
    for (const m of textMessages) {
        if (m.role !== "user") {
            out.push({ role: m.role as "system" | "assistant", content: m.content } as LlmRequestMessage);
            continue;
        }
        // Dual recognition: saved history still holds the legacy Chinese header.
        const isToolResultSynth = TOOL_RESULT_HEADERS.some((h) => m.content.startsWith(h));
        if (isToolResultSynth) {
            if (m.images && m.images.length > 0) {
                out.push(await buildImageContextMessage(
                    `${m.content}\n\nSystem note: the tool results above include an image preview. Use the image to judge whether any further processing is needed.`,
                    m.images,
                ));
            } else {
                out.push({ role: "user", content: m.content });
            }
            continue;
        }
        const images = userImagesQueue[userIdx++] || [];
        if (images.length === 0) { out.push({ role: "user", content: m.content }); continue; }
        const dataUrls = await resolveImageRefs(images);
        const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }> = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const url of dataUrls) parts.push({ type: "image_url", image_url: { url, detail: "low" } });
        out.push({ role: "user", content: parts });
    }
    return out;
}

/** Converts the mascot history into LlmRequestMessages (native protocol, restoring
 *  tool calls and tool results) */
async function historyToNativeMessages(history: MascotMsg[]): Promise<LlmRequestMessage[]> {
    const out: LlmRequestMessage[] = [];
    const recent = history.slice(-40);
    for (const m of recent) {
        if (m.role === "user") {
            // User message: when images are present, build a multimodal content array
            // (text + image_url parts)
            if (m.images && m.images.length > 0) {
                const dataUrls = await resolveImageRefs(m.images);
                const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }> = [];
                if (m.text) parts.push({ type: "text", text: m.text });
                for (const url of dataUrls) parts.push({ type: "image_url", image_url: { url, detail: "low" } });
                out.push({ role: "user", content: parts });
            } else {
                out.push({ role: "user", content: m.text });
            }
        } else if (m.role === "tool") {
            out.push({
                role: "tool",
                content: m.text,
                name: m.toolName || "",
                toolCallId: m.toolCallId || "",
            });
            if (m.images && m.images.length > 0) {
                out.push(await buildImageContextMessage(
                    `System note: this is the image just returned by the tool "${m.toolDisplayName || m.toolName || "tool"}". Use it to judge whether further cropping, background removal, conversion, upload or CSS writing is needed.`,
                    m.images,
                ));
            }
        } else {
            // mascot message
            const msg: LlmRequestMessage = m.toolCalls && m.toolCalls.length > 0
                ? { role: "assistant", content: m.text, toolCalls: m.toolCalls, reasoning: m.reasoning, openRouterReasoningDetails: m.openRouterReasoningDetails }
                : { role: "assistant", content: m.text, reasoning: m.reasoning, openRouterReasoningDetails: m.openRouterReasoningDetails };
            out.push(msg);
        }
    }
    return out;
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    return {
        events: parts.slice(0, -1),
        rest: parts[parts.length - 1] || "",
    };
}

function findMascotProtocolStart(text: string, fromIndex: number): number {
    // Backslashes must be DOUBLED inside a template literal -- see the note in
    // lib/notewall-utils.ts parseNoteWallToolCalls. Undoubled, \[ became a literal "["
    // opening a character class, and the pattern stopped finding tool directives.
    const toolPattern = new RegExp(`\\[[^\\[\\]]{0,160}?(?:${FETCH_DIRECTIVE_NAMES}|${ACTION_DIRECTIVE_NAMES})`, "g");
    toolPattern.lastIndex = fromIndex;
    const toolMatch = toolPattern.exec(text);

    const thinkPattern = /<\s*(?:think|thinking)\b/gi;
    thinkPattern.lastIndex = fromIndex;
    const thinkMatch = thinkPattern.exec(text);

    const starts = [toolMatch?.index, thinkMatch?.index].filter((value): value is number => typeof value === "number");
    return starts.length > 0 ? Math.min(...starts) : -1;
}

function getMascotProtocolEnd(text: string, startIndex: number): number | null {
    const rest = text.slice(startIndex);
    const thinkOpen = /^<\s*(think|thinking)\b[^>]*>/i.exec(rest);
    if (thinkOpen) {
        const tagName = thinkOpen[1];
        const closePattern = new RegExp(`</\\s*${tagName}\\s*>`, "i");
        const closeMatch = closePattern.exec(rest.slice(thinkOpen[0].length));
        return closeMatch ? startIndex + thinkOpen[0].length + closeMatch.index + closeMatch[0].length : null;
    }

    const toolCallEnd = findToolCallEnd(text, startIndex);
    if (toolCallEnd != null) return toolCallEnd;

    const closeBracket = text.indexOf("]", startIndex);
    return closeBracket >= 0 ? closeBracket + 1 : null;
}

function peekMascotProtocolToolName(text: string, startIndex: number): string | null {
    const slice = text.slice(startIndex);
    const match = new RegExp(
        `^\\[[""\u201C]?([^""\u201D\\]]*?)[""\u201D]?\\s*(${FETCH_DIRECTIVE_NAMES}|${ACTION_DIRECTIVE_NAMES})\\s*[:：]\\s*([^(（\\]\\n]+)`,
    ).exec(slice);
    if (!match) return null;
    const kind = match[2];
    const name = match[3].trim();
    if (!name) return null;
    return FETCH_DIRECTIVE_NAMES.split("|").includes(kind) ? `Expand ${name}` : name;
}

function createMascotTextDisplayFilter(
    emit?: (text: string) => void | Promise<void>,
    onToolCallStart?: (info: { id: string; name: string; index: number; protocol: "text" }) => void | Promise<void>,
) {
    let buffer = "";
    let processedIndex = 0;
    const firedToolStarts = new Set<number>();

    const emitText = async (text: string) => {
        if (!text) return;
        await emit?.(text.replace(/\r\n?/g, "\n"));
    };

    const processAvailable = async (final = false) => {
        while (processedIndex < buffer.length) {
            const specialStart = findMascotProtocolStart(buffer, processedIndex);
            if (specialStart < 0) {
                if (final) {
                    await emitText(buffer.slice(processedIndex));
                    processedIndex = buffer.length;
                } else {
                    const lastPotentialStart = Math.max(buffer.lastIndexOf("["), buffer.lastIndexOf("<"));
                    const shouldHoldTail = lastPotentialStart >= processedIndex
                        && !/[\]>]/.test(buffer.slice(lastPotentialStart));
                    const safeEnd = shouldHoldTail ? lastPotentialStart : buffer.length;
                    if (safeEnd > processedIndex) {
                        await emitText(buffer.slice(processedIndex, safeEnd));
                        processedIndex = safeEnd;
                    }
                }
                return;
            }

            if (specialStart > processedIndex) {
                await emitText(buffer.slice(processedIndex, specialStart));
                processedIndex = specialStart;
            }

            if (!firedToolStarts.has(specialStart)) {
                const toolName = peekMascotProtocolToolName(buffer, specialStart);
                if (toolName) {
                    firedToolStarts.add(specialStart);
                    await onToolCallStart?.({
                        id: `text_${Date.now()}_${specialStart}`,
                        name: toolName,
                        index: firedToolStarts.size - 1,
                        protocol: "text",
                    });
                }
            }

            const specialEnd = getMascotProtocolEnd(buffer, specialStart);
            if (specialEnd == null) {
                if (final) processedIndex = buffer.length;
                return;
            }
            processedIndex = specialEnd;
        }
    };

    return {
        async push(text: string) {
            buffer += text;
            await processAvailable(false);
        },
        async flush() {
            await processAvailable(true);
        },
    };
}

async function streamMascotProviderRequest(
    request: LlmRequestPayload,
    options?: { signal?: AbortSignal },
    callbacks?: {
        onDelta?: (text: string) => void | Promise<void>;
        onReasoningDelta?: (text: string) => void | Promise<void>;
    },
): Promise<{ content: string; reasoning: string; rawResponse: string }> {
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const abortHandler = () => llmAbort.abort();
    if (options?.signal) {
        if (options.signal.aborted) llmAbort.abort();
        else options.signal.addEventListener("abort", abortHandler);
    }

    let rawResponse = "";
    let content = "";
    let reasoning = "";

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: llmAbort.signal,
        });
        if (!response.ok) throw new Error(`API Stream ${response.status}: ${await response.text()}`);
        if (!response.body) throw new Error("The streaming response has no body.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handleEvent = async (eventText: string) => {
            const dataLines = eventText
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim());
            for (const dataLine of dataLines) {
                if (!dataLine || dataLine === "[DONE]") continue;
                rawResponse += `${dataLine}\n`;
                try {
                    const parsed = JSON.parse(dataLine) as unknown;
                    const delta = parseProviderStreamDelta(request.providerKind, parsed);
                    if (delta.reasoning) {
                        reasoning += delta.reasoning;
                        await callbacks?.onReasoningDelta?.(delta.reasoning);
                    }
                    if (delta.content) {
                        content += delta.content;
                        const visibleDelta = stripHallucinatedTimestamps(delta.content);
                        if (visibleDelta) await callbacks?.onDelta?.(visibleDelta);
                    }
                } catch {
                    // Ignore relay keepalive / non-JSON chunks.
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseEvents(buffer);
            buffer = parsed.rest;
            for (const eventText of parsed.events) {
                await handleEvent(eventText);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) await handleEvent(buffer);

        return { content: stripHallucinatedTimestamps(content), reasoning, rawResponse };
    } finally {
        clearTimeout(llmTimeout);
        if (options?.signal) options.signal.removeEventListener("abort", abortHandler);
    }
}

function buildMascotTextResponse(raw: string): Pick<MascotToolResponse, "reply" | "rawAssistant" | "toolFetches" | "toolCalls" | "protocol"> {
    const toolFetches = parseToolFetches(raw);
    const { cleanText, toolCalls } = parseToolCalls(raw);
    let displayText = cleanText;
    displayText = displayText.replace(new RegExp(`\\[(?:${FETCH_DIRECTIVE_NAMES}):[^\\]]+\\]`, "g"), "").trim();
    displayText = displayText.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();
    const reply = displayText ? displayText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean) : [];
    return {
        reply,
        rawAssistant: raw,
        toolFetches,
        toolCalls,
        protocol: "text",
    };
}

function mapMascotNativeCalls(
    nativeCalls: LlmToolCall[],
    nameMap: Map<string, string>,
): { toolFetches: ToolFetch[]; toolCalls: ToolCall[] } {
    const toolFetches: ToolFetch[] = [];
    const toolCalls: ToolCall[] = [];
    for (const nc of nativeCalls) {
        const displayName = nameMap.get(nc.name) || nc.name;
        if (displayName.startsWith("_loader:")) {
            const pkgId = displayName.slice("_loader:".length);
            const pkg = MASCOT_TOOL_PACKAGES.find((p) => p.id === pkgId);
            if (pkg) toolFetches.push({ name: pkg.label });
        } else {
            toolCalls.push({ name: displayName, args: nc.args });
        }
    }
    return { toolFetches, toolCalls };
}

// -- Text protocol: send request -----------------------------

async function callMascotText(
    context: MascotPageContext,
    history: MascotMsg[],
    options?: { signal?: AbortSignal; callbacks?: MascotChatStreamCallbacks },
): Promise<MascotToolResponse> {
    const apiConfig = requireMascotApiConfig();

    // Build the system prompt.
    // Package detail (usageGuide) is deliberately NOT injected here: when the LLM calls
    // [FetchTool:<package>] the agent loop appends it to history as a tool message, so it
    // ends up resident in context anyway.
    const systemPrompt = [
        getMascotPersonaPrompt(),
        buildMascotUserIdentityRule(),
        `Current page: ${context.label} (${context.mode})`,
        buildMascotToolsListPrompt(),
        MASCOT_OUTPUT_LANGUAGE_RULE,
    ].join("\n\n");

    // Only build multipart image messages when this API config has image recognition
    // enabled; otherwise fall back to plain text. (The adapter has its own master switch
    // as a second line of defence.)
    const hasImages = apiConfig.enableImageRecognition === true && historyHasImages(history);
    const messages: LlmRequestMessage[] = [
        { role: "system", content: systemPrompt },
        ...(hasImages ? await historyToTextMessagesMultipart(history) : historyToTextRequestMessages(history)),
    ];

    let raw = "";
    const displayFilter = createMascotTextDisplayFilter(
        options?.callbacks?.onAssistantDelta,
        options?.callbacks?.onToolCallStart,
    );
    try {
        const streamRequest = buildProviderRequest(apiConfig, null, messages, { stream: true });
        const streamResult = await streamMascotProviderRequest(
            streamRequest,
            { signal: options?.signal },
            {
                async onDelta(delta) {
                    await displayFilter.push(delta);
                },
                async onReasoningDelta(delta) {
                    await options?.callbacks?.onReasoningDelta?.(delta);
                },
            },
        );
        await displayFilter.flush();
        raw = streamResult.content.trim();
    } catch (streamError) {
        if (options?.signal?.aborted) throw streamError;
        await options?.callbacks?.onStreamFallback?.(formatErrorMessage(streamError));

        const request = buildProviderRequest(apiConfig, null, messages);
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: options?.signal,
        });
        if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
        const data = await response.json();
        const parsed = parseProviderResponse(request.providerKind, data);
        raw = parsed.content || "";
    }

    if (!raw) {
        throw new Error("The LLM returned empty content.");
    }

    const parsedText = buildMascotTextResponse(raw);

    return parsedText;
}

// -- Native protocol: send request ---------------------------

async function callMascotNative(
    context: MascotPageContext,
    history: MascotMsg[],
    expandedPackageIds: string[],
    options?: { signal?: AbortSignal; callbacks?: MascotChatStreamCallbacks },
): Promise<MascotToolResponse> {
    const apiConfig = requireMascotApiConfig();

    const tools = getMascotNativeToolDefinitions(expandedPackageIds);
    const nameMap = buildMascotNativeNameMap();

    const systemPrompt = [
        getMascotPersonaPrompt(),
        buildMascotUserIdentityRule(),
        `Current page: ${context.label} (${context.mode})`,
        "You have tools available. Each package must be expanded before you can see its detailed actions; the navigation tool is usable directly. Expand at most 2 packages at a time.",
        "Important: when calling a tool, do **not** restate the tool arguments in your reply text (for example, do not write the full persona text out again). Keep the reply to one or two short sentences saying what you are doing; the detail travels in the tool arguments.",
        MASCOT_OUTPUT_LANGUAGE_RULE,
    ].join("\n\n");

    const messages: LlmRequestMessage[] = [
        { role: "system", content: systemPrompt },
        ...(await historyToNativeMessages(history)),
    ];

    try {
        let result: LLMToolRequestResult;
        try {
            result = await sendLLMToolStreamRequest(
                apiConfig,
                null,
                messages,
                tools,
                [],
                { characterName: "Scroll", userName: "User" },
                { appId: "mascot", signal: options?.signal },
                {
                    async onDelta(delta) {
                        await options?.callbacks?.onAssistantDelta?.(delta);
                    },
                    async onReasoningDelta(delta) {
                        await options?.callbacks?.onReasoningDelta?.(delta);
                    },
                    async onToolCallStart(info) {
                        const mappedName = nameMap.get(info.name) || info.name;
                        const shownName = mappedName.startsWith("_loader:")
                            ? `Expand ${MASCOT_TOOL_PACKAGES.find((pkg) => pkg.id === mappedName.slice("_loader:".length))?.label || "tool set"}`
                            : mappedName;
                        await options?.callbacks?.onToolCallStart?.({
                            id: info.id,
                            name: shownName,
                            index: info.index,
                            protocol: "native",
                        });
                    },
                },
            );
        } catch (streamError) {
            if (options?.signal?.aborted) throw streamError;
            await options?.callbacks?.onStreamFallback?.(formatErrorMessage(streamError));

            const fallbackRequest = buildProviderRequest(apiConfig, null, messages, { tools });
            const response = await fetch(fallbackRequest.url, {
                method: "POST",
                headers: fallbackRequest.headers,
                body: JSON.stringify(fallbackRequest.body),
                signal: options?.signal,
            });
            if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
            const data = await response.json();
            const parsed = parseProviderResponse(fallbackRequest.providerKind, data);
            result = {
                content: parsed.content,
                reasoning: parsed.reasoning,
                openRouterReasoningDetails: parsed.openRouterReasoningDetails,
                toolCalls: parsed.toolCalls,
                rawResponse: JSON.stringify({ content: parsed.content, toolCalls: parsed.toolCalls, raw: parsed.raw }),
                providerKind: fallbackRequest.providerKind,
                usage: parsed.usage,
            };
        }

        const { toolFetches: nativeToolFetches, toolCalls: nativeToolCalls } = mapMascotNativeCalls(result.toolCalls, nameMap);
        const parsedText = buildMascotTextResponse(result.content || "");
        const hasTextProtocolCalls = parsedText.toolFetches.length > 0 || parsedText.toolCalls.length > 0;
        const reply = hasTextProtocolCalls
            ? parsedText.reply
            : (result.content || "").trim().split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        return {
            reply,
            rawAssistant: result.content || "",
            toolFetches: [...nativeToolFetches, ...parsedText.toolFetches],
            toolCalls: [...nativeToolCalls, ...parsedText.toolCalls],
            nativeToolCalls: result.toolCalls,
            reasoning: result.reasoning,
            openRouterReasoningDetails: result.openRouterReasoningDetails,
            protocol: "native",
        };
    } catch (err) {
        throw err;
    }
}

// -- Main entry point ----------------------------------------

/**
 * One mascot LLM call; the agent loop is driven by the UI layer.
 * Picks the native tool protocol or the text protocol automatically from the API config.
 *
 * All context (user messages, assistant replies, tool results) travels through
 * history; the caller is responsible for appending each turn's events in order.
 */
export async function mascotChatWithTools(
    context: MascotPageContext,
    history: MascotMsg[],
    expandedPackageIds: string[],
    options?: { signal?: AbortSignal; callbacks?: MascotChatStreamCallbacks },
): Promise<MascotToolResponse> {
    const apiConfig = requireMascotApiConfig();

    const useNative = !!nativeToolProtocolForConfig(apiConfig);
    if (useNative) {
        return await callMascotNative(context, history, expandedPackageIds, { signal: options?.signal, callbacks: options?.callbacks });
    }
    return await callMascotText(context, history, { signal: options?.signal, callbacks: options?.callbacks });
}
