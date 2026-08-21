// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";
import { borrowedFromName } from "./memory-sharing";

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 *
 * Borrowed memories (shared memory, see lib/memory-sharing.ts) are grouped into their own
 * section and attributed by name.
 *
 * The attribution is REQUIRED, not cosmetic. Folded in unlabelled, another character's memory
 * reads as this character's own experience, and the model will claim things it never did or
 * knowledge it never had. The default summarization prompt writes in the THIRD person, so the
 * usual failure is a character treating hearsay as first-hand rather than literal "I"
 * confusion -- but summarizationPrompt is user-editable, so first-person accounts do occur,
 * and the heading covers both.
 *
 * The heading only appears when something was actually borrowed.
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const own: string[] = [];
    const borrowed: string[] = [];
    for (const entry of memories) {
        const from = borrowedFromName(entry);
        if (from) borrowed.push(`- (${from}) ${entry.content}`);
        else own.push(`- ${entry.content}`);
    }

    if (borrowed.length === 0) return own.join("\n");

    const sections: string[] = [];
    if (own.length) sections.push(own.join("\n"));
    sections.push(
        "Things you know secondhand, from other people's accounts of events involving you. "
        + "These are THEIR memories, not yours: the speaker is named in brackets, and any "
        + "\"I\" inside them refers to that person, never to you.",
    );
    sections.push(borrowed.join("\n"));
    return sections.join("\n\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}
