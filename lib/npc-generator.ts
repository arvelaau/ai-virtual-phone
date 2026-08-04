// lib/npc-generator.ts
// "Generate supporting characters": has the AI create a batch of same-world side
// characters for a given character (count is user-selectable). Each one yields a
// full character card (same spec as a main character) + a brief persona + a
// two-way relation label.
//
// Deliberately does NOT go through preset assembly (simpleLLMCall + a hand-built
// prompt): this is a structured tool task, and the roleplay instructions, style
// requirements and regex post-processing in the user's chat preset would all
// corrupt the tagged output format. The API config still comes from the
// character's chat binding (config only — no preset, no regexes).

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { createCharacter, loadCharacters, saveCharacters } from "./character-storage";
import {
    addCharacterWorldRelation,
    getCharacterWorldGroupId,
    loadCharacterWorldGroups,
    moveCharacterToWorld,
} from "./character-world-storage";
import { loadMomentsConfig, saveMomentsConfig, loadMomentPosts, loadMomentComments } from "./moments-storage";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import type { Character } from "./character-types";

export type GeneratedSupportingCharacter = {
    name: string;
    persona: string;
    personality: string;
    briefPersona: string;
    /** Who the new character is to the target character (e.g. colleague) */
    relationLabel: string;
    /** Who the target character is to the new character (e.g. manager) */
    reverseRelationLabel: string;
};

export const NPC_GENERATE_MAX_COUNT = 5;

// Protocol tags. The prompt teaches the English names; the Chinese ones are kept
// as accepted aliases so a model steered by a Chinese persona still parses. These
// tags are never persisted — they live for exactly one LLM round-trip (taught,
// emitted, parsed into an object here) — so this is robustness, not a migration.
const TAG_BLOCK = ["Supporting", "配角"] as const;
const TAG_NAME = ["Name", "名字"] as const;
const TAG_PERSONA = ["Persona", "人设"] as const;
const TAG_PERSONALITY = ["Personality", "性格"] as const;
const TAG_BRIEF = ["Brief", "简介"] as const;
const TAG_RELATION = ["Relation", "关系"] as const;
const TAG_REVERSE_RELATION = ["ReverseRelation", "反向关系"] as const;

function extractTag(text: string, tags: readonly string[]): string {
    for (const tag of tags) {
        const match = text.match(new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${tag}\\]`));
        const value = match?.[1]?.trim();
        if (value) return value;
    }
    return "";
}

function parseOneBlock(block: string): GeneratedSupportingCharacter | null {
    const name = extractTag(block, TAG_NAME);
    const persona = extractTag(block, TAG_PERSONA);
    if (!name || !persona) return null;
    return {
        name,
        persona,
        personality: extractTag(block, TAG_PERSONALITY),
        briefPersona: extractTag(block, TAG_BRIEF),
        relationLabel: extractTag(block, TAG_RELATION),
        reverseRelationLabel: extractTag(block, TAG_REVERSE_RELATION),
    };
}

/** World context: the world description + every character name in that world (not
 *  gated on "empty when no world is configured", so the LLM always knows which
 *  characters already exist and avoids duplicate names/roles) + the relation graph
 *  + one-hop character briefs. */
function buildWorldContext(character: Character): string {
    const characters = loadCharacters();
    const nameById = new Map(characters.map(c => [c.id, c.name || "Unnamed"]));
    const briefById = new Map(characters.map(c => [c.id, c.briefPersona?.trim() || ""]));
    const group = loadCharacterWorldGroups().find(g => g.memberIds.includes(character.id));

    const lines: string[] = [];
    if (group) {
        lines.push(`World: ${group.name}`);
        if (group.description.trim()) lines.push(`World description: ${group.description.trim()}`);
        const memberNames = group.memberIds
            .map(id => nameById.get(id))
            .filter((name): name is string => Boolean(name));
        if (memberNames.length > 0) lines.push(`Characters already in this world (the new character must not duplicate their names or roles): ${memberNames.join(", ")}`);
        for (const relation of group.relations) {
            const fromName = nameById.get(relation.fromCharacterId);
            const toName = nameById.get(relation.toCharacterId);
            if (fromName && toName) lines.push(`${fromName} is ${toName}'s ${relation.label}.`);
        }
        // Attach brief personas for characters already linked to the target, so the new
        // character can echo them
        const counterpartIds = new Set<string>();
        for (const relation of group.relations) {
            if (relation.fromCharacterId === character.id) counterpartIds.add(relation.toCharacterId);
            else if (relation.toCharacterId === character.id) counterpartIds.add(relation.fromCharacterId);
        }
        for (const id of counterpartIds) {
            const brief = briefById.get(id);
            if (brief) lines.push(`Brief for ${nameById.get(id)}: ${brief}`);
        }
    }
    return lines.join("\n");
}

type GenerationOptions = {
    count: number;
    hint: string;
    /** Locked name: used when profiling a specific person the AI mentioned on a chat contact card */
    fixedName?: string;
    /** Recommendation context: the conversation excerpt around the card message; the generated persona must stay consistent with it */
    chatContext?: string;
};

/** The target character's recent Moments posts + comment threads: the walk-on names
 *  that appear there (one-off NPCs) are the best material for a new profile. */
function buildMomentsContext(character: Character, maxPosts = 6, maxChars = 1600): string {
    try {
        const characters = loadCharacters();
        const nameById = new Map(characters.map(c => [c.id, c.name || "Unnamed"]));
        const posts = loadMomentPosts()
            .filter(post => post.authorType === "character" && post.authorId === character.id)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, maxPosts);
        if (posts.length === 0) return "";

        const lines: string[] = [];
        for (const post of posts) {
            const content = (post.content || "").trim().slice(0, 120);
            if (content) lines.push(`Post: ${content}`);
            const likeNames = post.likes
                .map(like => like.authorType === "user" ? "User" : like.authorType === "npc" ? like.authorName : nameById.get(like.authorId))
                .filter((name): name is string => Boolean(name));
            if (likeNames.length > 0) lines.push(`  Liked by: ${likeNames.join(", ")}`);
            for (const comment of loadMomentComments(post.id).slice(0, 6)) {
                const author = comment.authorType === "user"
                    ? "User"
                    : comment.authorType === "npc"
                        ? (comment.authorName || "passer-by")
                        : (nameById.get(comment.authorId) || "passer-by");
                const text = (comment.content || "").trim().slice(0, 60);
                if (text) lines.push(`  ${author} commented: ${text}`);
            }
        }
        let context = lines.join("\n");
        if (context.length > maxChars) context = context.slice(0, maxChars);
        return context;
    } catch {
        return "";
    }
}

function buildSystemPrompt(character: Character, worldContext: string, coreMemories: string, longTermMemories: string, options: GenerationOptions): string {
    const sections: string[] = [];
    sections.push(`You are a character-profile assistant. Below is the material for the character ${character.name}. Generate supporting characters for them — secondary figures in the same world — to fill out their social circle.`);
    sections.push(`[Character setting]\n${character.persona || "(none yet)"}`);
    if (character.personality?.trim()) sections.push(`[Personality]\n${character.personality.trim()}`);
    if (coreMemories) sections.push(`[Core memories]\n${coreMemories}`);
    if (longTermMemories) sections.push(`[Relevant long-term memories]\n${longTermMemories}`);
    if (worldContext) sections.push(`[World and relationships]\n${worldContext}`);
    const momentsContext = buildMomentsContext(character);
    if (momentsContext) sections.push(`[${character.name}'s recent Moments, including people who appeared in the comments]\n${momentsContext}`);
    if (options.chatContext?.trim()) {
        sections.push(`[Recommendation context - a recent excerpt of ${character.name} talking with the user]\n${options.chatContext.trim()}`);
    }
    const rules = [
        "Requirements:",
        `- Each character must fit naturally into ${character.name}'s world and social circle, and must not duplicate an existing character's name or role`,
        "- Prefer echoing the character's memories and history: someone who appeared in a memory or in Moments but is absent from the list of existing characters (a colleague, an old friend, a family member, a regular commenter) is the best material — reuse their name and whatever has already been revealed about them",
        "- Make the persona complete but restrained: this is a supporting character, not a second protagonist — do not write them as a chosen one",
    ];
    if (options.fixedName) {
        rules.push(`- Generate exactly one character this time, and the name must be ${options.fixedName} — do not change it`);
        rules.push(`- The persona must be fully consistent with what the excerpt above reveals about ${options.fixedName} (identity, relationships and any stated facts must all line up)`);
    } else {
        rules.push("- When generating several at once, vary their roles and personality types - do not make them alike");
    }
    rules.push("- If the user message carries extra requirements, satisfy those first");
    sections.push(rules.join("\n"));
    sections.push([
        `Wrap each supporting character in [${TAG_BLOCK[0]}]…[/${TAG_BLOCK[0]}]. Inside, follow the tags below exactly. Every tag is required, and you must output nothing at all outside the tags:`,
        `[${TAG_BLOCK[0]}]`,
        `[${TAG_NAME[0]}]the character's name[/${TAG_NAME[0]}]`,
        `[${TAG_PERSONA[0]}]a complete character card: background and identity, appearance, personality, speech style, habits and quirks — 200-400 words[/${TAG_PERSONA[0]}]`,
        `[${TAG_PERSONALITY[0]}]a one-line summary of their personality[/${TAG_PERSONALITY[0]}]`,
        `[${TAG_BRIEF[0]}]a 70-140 word third-person brief, injected when other characters need to know who this is; include only what others could plausibly perceive[/${TAG_BRIEF[0]}]`,
        `[${TAG_RELATION[0]}]who they are to ${character.name}, 1-4 words, e.g. colleague, partner in crime, younger sister[/${TAG_RELATION[0]}]`,
        `[${TAG_REVERSE_RELATION[0]}]who ${character.name} is to them, 1-4 words[/${TAG_REVERSE_RELATION[0]}]`,
        `[/${TAG_BLOCK[0]}]`,
    ].join("\n"));
    // simpleLLMCall bypasses the preset assembler entirely (see the file header), so
    // the global `output_language_rule` never reaches this prompt. Restate it locally.
    sections.push([
        "Always write in English, regardless of the language of the material above.",
        "The character card, memories, world book and quoted conversation are information about who this person is — never a reference for which language to write in.",
    ].join("\n"));
    return sections.join("\n\n");
}

async function runGeneration(
    targetCharacterId: string,
    options: GenerationOptions,
): Promise<GeneratedSupportingCharacter[]> {
    const character = loadCharacters().find(c => c.id === targetCharacterId);
    if (!character) throw new Error("Target character does not exist.");
    const { hint } = options;
    const safeCount = Math.min(Math.max(1, Math.round(options.count) || 1), NPC_GENERATE_MAX_COUNT);

    // API config comes from the character's chat binding (config only; never preset/regexes)
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, targetCharacterId, "chat");
    if (!slot.apiConfigId) throw new Error("No API configuration is bound yet. Please set one up in Binding Manager first.");
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) throw new Error("The bound API configuration no longer exists.");

    // Memory: core memories in full; long-term memories retrieved by "relationships /
    // social circle + the user's request". A retrieval failure degrades to injecting
    // nothing rather than blocking generation.
    let coreMemories = "";
    let longTermMemories = "";
    try {
        const memConfig = loadMemoryConfig();
        const retrievalContext = `${character.name}'s relationships, family, friends, colleagues and social circle. ${hint.trim()}`;
        const [coreResults, longTermResults] = await Promise.all([
            retrieveCoreMemoriesForPrompt(targetCharacterId, memConfig),
            retrieveMemoriesForPrompt(targetCharacterId, retrievalContext, memConfig),
        ]);
        coreMemories = formatCoreMemories(coreResults);
        longTermMemories = formatLongTermMemories(longTermResults);
    } catch (err) {
        console.warn("[NpcGenerator] memory retrieval failed:", err);
    }

    const systemPrompt = buildSystemPrompt(character, buildWorldContext(character), coreMemories, longTermMemories, options);
    const trimmedHint = hint.trim();
    const userPrompt = options.fixedName
        ? `Create a full profile for ${options.fixedName}, who was mentioned in the conversation. ${trimmedHint}`
        : `Generate ${safeCount} supporting character(s) this time. ${trimmedHint}`;

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        // ~600-900 tokens per character; reasoning models burn hidden thinking tokens
        // first, and too low a cap yields finishReason=length with empty content —
        // so scale the headroom with the requested count
        { temperature: 0.85, max_tokens: Math.max(8192, safeCount * 2000) },
    );

    if (result.error || !result.content) {
        throw new Error(result.error || "The model returned empty content. Please try again.");
    }
    const text = result.content.trim();

    // Multi-block parse: [Supporting]…[/Supporting] repeats; also tolerates a single
    // character emitted without the outer wrapper. Legacy Chinese tag still accepted.
    const blocks = TAG_BLOCK.flatMap(tag =>
        [...text.matchAll(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "g"))].map(m => m[1]),
    );
    const parsed = (blocks.length > 0 ? blocks : [text])
        .map(parseOneBlock)
        .filter((item): item is GeneratedSupportingCharacter => item !== null);

    if (parsed.length === 0) {
        if (result.wasTruncated) throw new Error("The model output was truncated (max_tokens too low). Reduce the number of characters and try again.");
        throw new Error("The model output is missing required fields (name/persona). Please try again.");
    }
    // Locked-name mode: whatever the model writes, the specified name wins
    if (options.fixedName) {
        return [{ ...parsed[0], name: options.fixedName }];
    }
    return parsed.slice(0, safeCount);
}

/** Generates `count` supporting characters for the target; `hint` is the user's extra
 *  requirement (may be empty). Throws on failure, with a user-readable message. */
export async function generateSupportingCharacters(
    targetCharacterId: string,
    hint: string,
    count: number,
): Promise<GeneratedSupportingCharacter[]> {
    return runGeneration(targetCharacterId, { count, hint });
}

/** Profiles a specific person mentioned on a chat contact card: the name is locked,
 *  and the persona must stay consistent with the recommendation context. */
export async function generateNamedSupportingCharacter(
    recommenderCharacterId: string,
    fixedName: string,
    chatContext: string,
): Promise<GeneratedSupportingCharacter> {
    const [first] = await runGeneration(recommenderCharacterId, {
        count: 1,
        hint: "",
        fixedName,
        chatContext,
    });
    return first;
}

/** Persist: create the character card -> place it next to the target -> join the same
 *  world -> create the two-way relation -> preset the auto-post switch.
 *  Shared by the Characters app's "generate supporting cast" and the chat contact
 *  card's "profile on the spot".
 *  Writes storage directly; callers holding React state must reload themselves. */
export function materializeSupportingCharacter(
    result: GeneratedSupportingCharacter,
    targetCharacterId: string,
    options: { allowAutoPost?: boolean; placementIndex?: number } = {},
): Character {
    const characters = loadCharacters();
    const target = characters.find(c => c.id === targetCharacterId);
    const now = new Date().toISOString();
    const index = options.placementIndex ?? 0;

    const newChar = createCharacter({
        name: result.name,
        persona: result.persona,
        personality: result.personality || undefined,
        briefPersona: result.briefPersona || undefined,
        briefPersonaUpdatedAt: result.briefPersona ? now : undefined,
        avatar: null,
        tags: ["Supporting"],
    });
    const baseX = target?.canvasX ?? 120;
    const baseY = target?.canvasY ?? 120;
    // Fan out around the target character; stagger by index so batches do not overlap
    newChar.canvasX = baseX + 150 + (index % 2) * 130 + Math.round(Math.random() * 40);
    newChar.canvasY = baseY + Math.floor(index / 2) * 150 - 50 + Math.round(Math.random() * 40);
    newChar.canvasRot = Math.round((Math.random() * 8 - 4) * 10) / 10;
    newChar.canvasZIndex = Math.max(0, ...characters.map(c => c.canvasZIndex ?? 0)) + 1 + index;
    newChar.polaroidStyle = target?.polaroidStyle ?? 0;
    saveCharacters([...characters, newChar]);

    const groupId = getCharacterWorldGroupId(targetCharacterId);
    if (groupId) {
        moveCharacterToWorld(newChar.id, groupId);
        if (result.relationLabel) addCharacterWorldRelation(groupId, newChar.id, targetCharacterId, result.relationLabel);
        if (result.reverseRelationLabel) addCharacterWorldRelation(groupId, targetCharacterId, newChar.id, result.reverseRelationLabel);
    }

    // Auto-posting to Moments is off by default: seed into the disabled list (only after
    // being added as a friend does it actually enter the posting scheduler)
    if (!options.allowAutoPost) {
        const cfg = loadMomentsConfig();
        if (!cfg.autoPostDisabledCharacterIds.includes(newChar.id)) {
            saveMomentsConfig({ ...cfg, autoPostDisabledCharacterIds: [...cfg.autoPostDisabledCharacterIds, newChar.id] });
        }
    }
    return newChar;
}
