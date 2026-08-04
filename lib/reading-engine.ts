// lib/reading-engine.ts — LLM integration for Reading feature.
// All prompts go through the preset system via assemblePromptPayload. No extra message push.

import type { Book, BookChapter, ReadingAnnotation } from "./reading-types";
import type { ChatSession } from "./chat-storage";
import { loadChatMessages, pushChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadReadingInteractionConfig } from "./reading-storage";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import {
    assemblePromptPayload,
    type AssemblerInput,
    type LLMMessage,
} from "./llm-prompt-assembler";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { DEFAULT_READING_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";

export type ReadingDiscussAction =
    | { type: "add_annotation"; paragraphIndex: number; content: string }
    | { type: "delete_annotation"; annotationId: string }
    | { type: "update_annotation"; annotationId: string; content: string };

export type AnnotationTarget = {
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
};

export type ReadingDiscussContext = {
    chapterTitle: string;
    chapterContent: string;
    annotations: ReadingAnnotation[];
};

function buildReadingBilingualInstruction(enabled: boolean, customPrompt?: string): string {
    return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_READING_BILINGUAL_PROMPT);
}

// ── Resolve assembler input for reading context ──

async function resolveReadingInput(
    characterId: string,
    appTags: string[],
    options: {
        bookTitle: string;
        chapterTitle: string;
        chapterContent: string;
        annotationHistory: string;
        history?: ReturnType<typeof loadChatMessages>;
    },
): Promise<{ input: AssemblerInput; apiConfig: ApiConfig | null; preset: PresetConfig | null } | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "reading");

    const apiConfigId = slot.apiConfigId;
    const presetId = slot.presetId;
    const worldBookIds = slot.worldBookIds || [];
    const regexIds = slot.regexIds || [];
    const userIdentityId = slot.userIdentityId;

    let apiConfig: ApiConfig | null = null;
    if (apiConfigId) {
        apiConfig = loadApiConfigs().find(c => c.id === apiConfigId) ?? null;
    }
    if (!apiConfig) return null;

    const presets = loadPresets();
    let preset: PresetConfig | null = presetId
        ? presets.find(p => p.id === presetId) ?? null
        : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? presets[0] ?? null;

    const worldBooks = loadWorldBooks().filter(wb => worldBookIds.includes(wb.id));
    const regexes = loadRegexes().filter(r => regexIds.includes(r.id));

    const identities = (await import("./settings-storage")).loadUserIdentities();
    const userIdentity = userIdentityId
        ? identities.find(i => i.id === userIdentityId) || identities[0]
        : identities[0] || null;

    // Memory
    const memConfig = loadMemoryConfig();
    const coreMemories = await retrieveCoreMemoriesForPrompt(characterId, memConfig);
    const longTermMemories = await retrieveMemoriesForPrompt(characterId, options.bookTitle, memConfig);

    // Short-term context
    const { recentBlocks, truncatedHistory, unifiedRecentItems } = prepareShortTermContext(characterId, "chat", {
        history: options.history,
        userName: userIdentity?.name ?? "User",
    });
    const readingConfig = loadReadingInteractionConfig();

    const input: AssemblerInput = {
        character,
        history: truncatedHistory,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "reading",
        appTags,
        coreMemories: formatCoreMemories(coreMemories),
        longTermMemories: formatLongTermMemories(longTermMemories),
        recentBlocks,
        unifiedRecentItems,
        bookTitle: options.bookTitle,
        chapterTitle: options.chapterTitle,
        chapterContent: options.chapterContent,
        annotationHistory: options.annotationHistory,
        chatBilingualInstruction: buildReadingBilingualInstruction(
            readingConfig.bilingualTranslationEnabled === true,
            readingConfig.bilingualTranslationPrompt,
        ),
    };

    return { input, apiConfig, preset };
}

async function callReadingLLM(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    characterName: string,
    regexes?: RegexConfig[],
    appTags?: string[],
    userName?: string,
): Promise<string> {
    return sendLLMRequest(
        config,
        preset,
        messages,
        regexes ?? [],
        { characterName, userName },
        { appId: "reading", appTags },
    );
}

// ── Reading protocol tags ──
//
// Dual recognition (Track 2): every matcher below accepts the legacy Chinese token the
// model was taught before this migration AND the English token it is taught now (the
// `reading_annotation` / `reading_discuss` entries in lib/builtin-preset.ts). Producers
// emit English only.
//
// Unlike the chat protocol, none of these tags is ever persisted: a match is turned into
// a plain `content` string on a ReadingAnnotation / ReadingDiscussAction before it
// reaches storage. So the Chinese half here is robustness against a model that still
// thinks in Chinese, not a stored-data compatibility requirement.

/** `[Annotation:N]…[/Annotation]`, legacy `[批注:N]…[/批注]`. */
const ANNOTATION_BLOCK_ALIASES = "批注|Annotation";

/**
 * Built fresh on every call: this is a `g` regex, and a shared instance would carry
 * `lastIndex` from one generation into the next.
 *
 * Opening and closing tags may use DIFFERENT aliases of the same tag
 * (`[Annotation:1]…[/批注]`). Pinning them together with a backreference is exactly what
 * made the chat block tags leak during the bilingual window, so it is not done here.
 */
function annotationBlockRegex(): RegExp {
    return new RegExp(
        `\\[(?:${ANNOTATION_BLOCK_ALIASES})[:：]\\s*(\\d+)\\s*\\]([\\s\\S]*?)\\[\\/(?:${ANNOTATION_BLOCK_ALIASES})\\]`,
        "gi",
    );
}

/** `[NoAnnotation]`, legacy `[无批注]` — "nothing here is worth commenting on". */
const NO_ANNOTATION_RE = /\[\s*(?:无批注|no[\s_-]*annotation)\s*\]/i;

// Discuss action tail. The legacy forms are wrapped in full-width 【】; the English
// teaching uses ASCII [] because that is what a model writing English reaches for.
// Both bracket pairs are accepted for both languages, so a half-migrated model — English
// verb, Chinese brackets — still parses.
const OPEN_BRACKET = "[【\\[]";
const CLOSE_BRACKET = "[】\\]]";
const ID_VALUE = "[^\\s】\\]]+";
const ADD_VERBS = "新增批注|AddAnnotation";
const DELETE_VERBS = "删除批注|DeleteAnnotation";
const UPDATE_VERBS = "修改批注|EditAnnotation|UpdateAnnotation";
const PARAGRAPH_KEY = "(?:段落|paragraph)";
const ID_KEY = "id"; // every regex below carries the `i` flag, so this also matches `ID=`

const ADD_ANNOTATION_RE = new RegExp(
    `^${OPEN_BRACKET}(?:${ADD_VERBS})\\s+${PARAGRAPH_KEY}\\s*=\\s*(\\d+)${CLOSE_BRACKET}([\\s\\S]+)$`,
    "i",
);
const DELETE_ANNOTATION_RE = new RegExp(
    `^${OPEN_BRACKET}(?:${DELETE_VERBS})\\s+${ID_KEY}\\s*=\\s*(${ID_VALUE})${CLOSE_BRACKET}$`,
    "i",
);
const UPDATE_ANNOTATION_RE = new RegExp(
    `^${OPEN_BRACKET}(?:${UPDATE_VERBS})\\s+${ID_KEY}\\s*=\\s*(${ID_VALUE})${CLOSE_BRACKET}([\\s\\S]+)$`,
    "i",
);

// Header only — classifies a line as belonging to the action tail. Built from the same
// fragments as the three parsers above so the classifier and the parsers cannot drift.
const DISCUSS_ACTION_LINE_RE = new RegExp(
    `^${OPEN_BRACKET}(?:`
    + `(?:${ADD_VERBS})\\s+${PARAGRAPH_KEY}\\s*=\\s*\\d+`
    + `|(?:${DELETE_VERBS}|${UPDATE_VERBS})\\s+${ID_KEY}\\s*=\\s*${ID_VALUE}`
    + `)${CLOSE_BRACKET}`,
    "i",
);

// ── Format helpers ──
//
// These build the context SENT to the model. Nothing parses them back, but they
// deliberately mirror the tag formats taught in the preset — the model copies the shape
// it sees — so they have to be flipped in lockstep with the teaching.
//
// `formatChapterContent` and `formatAnnotationHistory` are currently unreferenced; they
// are the single-chapter counterparts of the `formatBatch*` pair and are kept (and kept
// correct) so a future caller does not resurrect the pre-migration format.

function formatChapterContent(paragraphs: string[]): string {
    return paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
}

function formatAnnotationHistory(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "(No annotations yet)";
    return annotations.map(a => `[Annotation:${a.paragraphIndex + 1}] ${a.content}`).join("\n");
}

function formatBatchChapterContent(targets: AnnotationTarget[]): string {
    return targets.map((target, index) => `[${index + 1}] ${target.text}`).join("\n\n");
}

function formatBatchAnnotationHistory(annotations: ReadingAnnotation[], targets: AnnotationTarget[]): string {
    if (annotations.length === 0) return "(No annotations yet)";

    const targetIndexMap = new Map<string, number>();
    targets.forEach((target, index) => {
        targetIndexMap.set(`${target.chapterIndex}:${target.paragraphIndex}`, index + 1);
    });

    const lines = annotations.flatMap((annotation) => {
        const relativeIndex = targetIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
        if (!relativeIndex) return [];
        return [`[Annotation:${relativeIndex}][Character:${annotation.characterName}] ${annotation.content}`];
    });

    return lines.length > 0 ? lines.join("\n") : "(No annotations yet)";
}

function formatAnnotationActionContext(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "(No annotations in the current range)";
    return annotations
        .map((annotation) => `- id=${annotation.id} | paragraph=${annotation.paragraphIndex + 1} | character=${annotation.characterName} | content=${annotation.content}`)
        .join("\n");
}

function isDiscussActionLine(line: string): boolean {
    return DISCUSS_ACTION_LINE_RE.test(line);
}

export function parseReadingDiscussResponse(raw: string): {
    reply: string;
    actions: ReadingDiscussAction[];
} {
    const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized) return { reply: "", actions: [] };

    const lines = normalized.split("\n");
    const actionLines: string[] = [];
    let actionStart = lines.length;
    let foundActionTail = false;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const trimmed = lines[i].trim();
        if (!foundActionTail) {
            if (!trimmed) continue;
            if (!isDiscussActionLine(trimmed)) break;
            foundActionTail = true;
            actionStart = i;
            actionLines.unshift(trimmed);
            continue;
        }

        if (!trimmed) {
            actionStart = i;
            continue;
        }
        if (!isDiscussActionLine(trimmed)) break;
        actionStart = i;
        actionLines.unshift(trimmed);
    }

    if (!foundActionTail) return { reply: normalized.trim(), actions: [] };

    const actions: ReadingDiscussAction[] = [];
    for (const line of actionLines) {
        let match = line.match(ADD_ANNOTATION_RE);
        if (match) {
            const paragraphIndex = Number(match[1]) - 1;
            const content = match[2].trim();
            if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0 && content) {
                actions.push({ type: "add_annotation", paragraphIndex, content });
            }
            continue;
        }

        match = line.match(DELETE_ANNOTATION_RE);
        if (match) {
            actions.push({ type: "delete_annotation", annotationId: match[1] });
            continue;
        }

        match = line.match(UPDATE_ANNOTATION_RE);
        if (match) {
            const content = match[2].trim();
            if (content) {
                actions.push({ type: "update_annotation", annotationId: match[1], content });
            }
        }
    }

    const reply = lines.slice(0, actionStart).join("\n").trim();
    return { reply, actions };
}

export type ParsedAnnotationBlock = {
    /** 0-based index into the batch's `targets`, i.e. the taught `N` minus one. */
    relativeIndex: number;
    content: string;
};

/**
 * Pull the `[Annotation:N]…[/Annotation]` blocks (legacy `[批注:N]…[/批注]`) out of an
 * annotation response. Blocks whose body is blank are dropped, as they always were.
 *
 * Extracted from `generateAnnotationBatch` so the protocol parser can be exercised
 * without an API key; that function still owns mapping `relativeIndex` onto a target.
 */
export function parseAnnotationBlocks(responseText: string): ParsedAnnotationBlock[] {
    const pattern = annotationBlockRegex();
    const blocks: ParsedAnnotationBlock[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(responseText)) !== null) {
        const content = match[2].trim();
        if (content) blocks.push({ relativeIndex: parseInt(match[1], 10) - 1, content });
    }
    return blocks;
}

/** True when the model said there is nothing worth annotating. */
export function isNoAnnotationResponse(responseText: string): boolean {
    return NO_ANNOTATION_RE.test(responseText);
}

// ── Public API ──

/** Generate annotations for a chapter. */
export async function generateAnnotations(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<ReadingAnnotation[]> {
    return generateAnnotationBatch(
        book,
        chapter.title,
        chapter.paragraphs.map((text, paragraphIndex) => ({
            chapterIndex: chapter.index,
            paragraphIndex,
            text,
        })),
        existingAnnotations,
        characterId,
    );
}

export async function generateAnnotationBatch(
    book: Book,
    batchTitle: string,
    targets: AnnotationTarget[],
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<ReadingAnnotation[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("Character not found.");
    if (targets.length === 0) return [];

    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: batchTitle,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved) throw new Error("No API Configuration found. Please go to Settings -> Binding Manager -> Reading to assign one.");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("The API returned empty content.");
    if (isNoAnnotationResponse(responseText)) return [];

    const results: ReadingAnnotation[] = [];
    for (const block of parseAnnotationBlocks(responseText)) {
        const target = targets[block.relativeIndex];
        if (!target) continue;
        results.push({
            id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: book.id,
            chapterIndex: target.chapterIndex,
            paragraphIndex: target.paragraphIndex,
            characterId,
            characterName: character.name,
            content: block.content,
            createdAt: new Date().toISOString(),
        });
    }
    return results;
}

export async function previewReadingAnnotationPrompt(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("Character not found.");

    const targets = chapter.paragraphs.map((text, paragraphIndex) => ({
        chapterIndex: chapter.index,
        paragraphIndex,
        text,
    }));
    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved?.apiConfig) throw new Error("No API Configuration found. Please go to Settings -> Binding Manager -> Reading to assign one.");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `Reading: ${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "Default preset",
    };
}

export async function previewReadingDiscussPrompt(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("Character not found.");

    const history = loadChatMessages(session.id);
    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved?.apiConfig) throw new Error("No API Configuration found. Please go to Settings -> Binding Manager -> Reading to assign one.");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `Reading Discussion: ${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "Default preset",
    };
}

/** Generate a chat response in reading discuss mode. */
export async function generateReadingChat(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<string | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadChatMessages(session.id);

    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved) return null;

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return null;

    // Return raw text — caller is responsible for parsing and saving (like chat-room's splitAndSaveAIMessages)
    return responseText;
}
