// Shared memory, layer 1: match by character name.
//
// A character may pick up another character's long-term memories, but ONLY the ones that
// mention it by name. Nothing else crosses -- not core memories, not persona, not state, not
// short-term events.
//
// This is READ-TIME ONLY. Nothing is written into anyone's store, so:
//   - turning the feature off restores the previous behaviour exactly, with no cleanup;
//   - editing or deleting the source memory takes effect immediately;
//   - a character that has never been summarized still hears about itself.
//
// It FAILS CLOSED: disabled, no viewer, or no name means nothing is borrowed. The name filter
// is the only thing bounding this leak, so every early return errs towards sharing nothing.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { loadCharacters } from "./character-storage";
import { loadCharacterWorldGroups } from "./character-world-storage";
import { loadStoryProjectionEntries } from "./story-storage";
import { loadVnProjectionEntries } from "./vn-storage";
import { loadChatOfflineProjectionEntries } from "./chat-offline-storage";

/** Minimum name length to match on. A one-character name would hit almost every sentence. */
const MIN_NAME_LENGTH = 2;

/**
 * Hard cap on borrowed rows, applied after sorting newest-first and before the token budget.
 *
 * The budget alone is not enough of a bound. A character with a long story history can produce
 * hundreds of narrative summaries, and secondhand knowledge that dominates the prompt pushes
 * out the things the character actually needs -- in story mode the <summary> is generated last
 * and is the first casualty when the prompt is bloated. This is "what you have heard about
 * yourself lately", not a second memory bank.
 */
const MAX_BORROWED_ENTRIES = 24;

/** CJK (and kana) -- scripts written without spaces, so word boundaries do not apply */
const NO_WORD_BOUNDARY_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isWordChar(ch: string): boolean {
    return ch !== "" && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Does this memory mention that name?
 *
 * Deliberately hand-rolled rather than a regex with lookbehind: `(?<!...)` is unsupported on
 * older Safari, which is a real target for a phone-shaped app. Scanning also makes the
 * boundary rule explicit enough to test.
 *
 * For Latin-script names the match must not sit inside a longer word, so "Al" does not match
 * "Alice". For CJK there are no separators, so a plain substring is the correct rule.
 */
export function mentionsName(content: string, name: string): boolean {
    const needle = name.trim().toLowerCase();
    if (needle.length < MIN_NAME_LENGTH) return false;
    const haystack = String(content ?? "").toLowerCase();
    if (!haystack) return false;

    const boundaryless = NO_WORD_BOUNDARY_SCRIPT.test(needle);
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) return false;
        if (boundaryless) return true;
        const before = at > 0 ? haystack[at - 1] : "";
        const after = at + needle.length < haystack.length ? haystack[at + needle.length] : "";
        if (!isWordChar(before) && !isWordChar(after)) return true;
        from = at + 1;
    }
}

/** Metadata stamped onto a borrowed copy. The stored entry is never touched. */
export type BorrowedMemoryMeta = {
    borrowedFrom: string;
    borrowedFromName: string;
};

export function borrowedFromName(entry: MemoryEntry): string | null {
    const name = entry.metadata?.borrowedFromName;
    return typeof name === "string" && name.trim() ? name : null;
}

/** The character doing the borrowing */
export type MemoryViewer = {
    id: string;
    name: string;
    /** World group id. Memory never crosses worlds -- see selectBorrowableMemories. */
    worldId: string;
};

/** One other character's long-term memories, as handed to the selector below */
export type MemoryOwnerBundle = {
    ownerId: string;
    ownerName: string;
    worldId: string;
    entries: MemoryEntry[];
};

/**
 * The decision itself, kept PURE and separate from storage.
 *
 * Every guarantee this feature makes lives here -- fail-closed, never borrow from yourself,
 * the name filter, and copy-never-mutate -- so all of them can be driven by a fixture. The
 * wrapper below only does IO. Splitting it this way is what makes the safety properties
 * testable at all: driven through the wrapper, an empty character list makes a broken guard
 * look like a working one.
 *
 * Returns shallow COPIES carrying `borrowedFrom` / `borrowedFromName` in metadata -- the
 * originals must not be mutated, since they belong to another character and are rendered on
 * its own memory page.
 *
 * Unbudgeted on purpose: the caller trims to `sharedMemoryTokenBudget` with the same
 * `fillByBudget` the character's own memories go through, and keeping that in one place
 * avoids a cycle back into memory-service.
 */
export function selectBorrowableMemories(
    config: Pick<MemoryConfig, "sharedMemoryEnabled">,
    viewer: MemoryViewer,
    owners: MemoryOwnerBundle[],
): MemoryEntry[] {
    if (!config?.sharedMemoryEnabled) return [];
    if (!viewer?.id) return [];
    const name = viewer.name?.trim();
    if (!name || name.length < MIN_NAME_LENGTH) return [];
    // No world means something is wrong upstream -- every character is normalised into one,
    // defaulting to world_default. Borrow nothing rather than fall back to "share with all".
    const viewerWorld = viewer.worldId?.trim();
    if (!viewerWorld) return [];

    const borrowed: MemoryEntry[] = [];
    for (const owner of owners) {
        if (!owner) continue;
        if (owner.ownerId === viewer.id) continue;
        // Memory never crosses worlds. Names are the identifier here, and two different
        // characters in two different worlds may legitimately share one -- "Alice" in world A
        // and "Alice" in world B are different people, and without this their memories mix.
        if (owner.worldId?.trim() !== viewerWorld) continue;
        // A memory whose character no longer exists is skipped: with no name there is nothing
        // to attribute it to, and unattributed borrowed memory is exactly the POV bug.
        const ownerName = owner.ownerName?.trim();
        if (!ownerName) continue;

        for (const entry of owner.entries ?? []) {
            if (!mentionsName(entry.content, name)) continue;
            borrowed.push({
                ...entry,
                metadata: {
                    ...(entry.metadata ?? {}),
                    borrowedFrom: owner.ownerId,
                    borrowedFromName: ownerName,
                },
            });
        }
    }

    borrowed.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return borrowed.slice(0, MAX_BORROWED_ENTRIES);
}

/**
 * Narrative sources that project ALREADY-SUMMARIZED text into the short-term timeline.
 *
 * The qualifying property is "already a summary", not "which app". Each of these stores a
 * summary the model itself wrote -- story's `<summary>` tag per turn, a VN chapter summary, an
 * offline turn's summary -- and each is capped at 500 characters by its own loader before it
 * ever reaches here. That is what makes them safe to lend: borrowing a raw chat transcript
 * would mean one character reading another's actual conversations, and would blow the budget.
 *
 * Raw-transcript projections are deliberately NOT in this list.
 */
const NARRATIVE_PROJECTION_SOURCES: readonly {
    app: MemoryEntry["sourceApp"];
    load: (characterId: string) => { id: string; timestamp: string; content: string }[];
}[] = [
    { app: "story", load: (id) => loadStoryProjectionEntries(id) },
    { app: "vn", load: (id) => loadVnProjectionEntries(id) },
    { app: "chat", load: (id) => loadChatOfflineProjectionEntries(id) },
];

/**
 * Narrative summaries for one character, shaped as MemoryEntry so they flow through exactly
 * the same name filter, world scope, attribution and budget as long-term memories.
 *
 * These are SYNTHETIC and never stored -- they are rebuilt from their source on every call, so
 * editing or deleting the underlying story beat takes effect immediately. `type` is set to
 * "long_term" because that is how they behave for injection; the real provenance is in
 * `metadata.narrativeSource`.
 */
function loadNarrativeSummaries(characterId: string): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const source of NARRATIVE_PROJECTION_SOURCES) {
        let entries: { id: string; timestamp: string; content: string }[] = [];
        try {
            entries = source.load(characterId) ?? [];
        } catch {
            // A feature the user has never opened may not have hydrated its store. Skip it
            // rather than failing the whole borrow.
            continue;
        }
        for (const entry of entries) {
            if (!entry?.content?.trim()) continue;
            out.push({
                id: entry.id,
                characterId,
                sourceApp: source.app,
                type: "long_term",
                content: entry.content,
                importance: 0.6,
                createdAt: entry.timestamp,
                updatedAt: entry.timestamp,
                metadata: { narrativeSource: source.app },
            });
        }
    }
    return out;
}

/**
 * Storage-facing wrapper: gather every other character's borrowable memories, then delegate the
 * decision to `selectBorrowableMemories`.
 *
 * Two sources, both already condensed: settled long-term memories, and the narrative summaries
 * above. Core memories are excluded -- they are identity- and relationship-level, and sharing
 * those is a much bigger decision that stays out of scope.
 */
export async function gatherBorrowedMemories(
    viewerId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    // Checked here too, so a disabled feature costs no storage reads at all
    if (!config.sharedMemoryEnabled || !viewerId) return [];

    const characters = loadCharacters();
    const viewer = characters.find((item) => item.id === viewerId);
    const viewerName = viewer?.name?.trim();
    if (!viewerName || viewerName.length < MIN_NAME_LENGTH) return [];

    // World membership lives on the world GROUP, not on Character.worldId -- that field is
    // declared in character-types.ts but never written or read by anything, so filtering on it
    // would silently match nothing. loadCharacterWorldGroups() normalises every character into
    // exactly one group, defaulting to world_default, so this is always resolvable.
    const groups = loadCharacterWorldGroups();
    const viewerGroup = groups.find((group) => group.memberIds.includes(viewerId));
    if (!viewerGroup) return [];
    const viewerWorldId = viewerGroup.id;

    const nameById = new Map(characters.map((item) => [item.id, item.name]));

    // Candidates are the viewer's WORLD MATES, not "everyone who has a memory row".
    // getAllCharacterIdsWithMemories() enumerates the memory store alone, so a character with
    // story or VN history but no summarized long-term entry yet was invisible -- and long-term
    // entries only appear after summarizationEventInterval (80) events, so early on that is
    // everybody. That made the whole feature silently produce nothing.
    const ownerIds = viewerGroup.memberIds.filter((id) => id !== viewerId);

    const owners: MemoryOwnerBundle[] = [];
    for (const ownerId of ownerIds) {
        const ownerName = nameById.get(ownerId)?.trim();
        if (!ownerName) continue;
        const ownerWorldId = viewerWorldId;
        owners.push({
            ownerId,
            ownerName,
            worldId: ownerWorldId,
            entries: [
                ...(await loadMemoryEntriesByType(ownerId, "long_term")),
                ...loadNarrativeSummaries(ownerId),
            ],
        });
    }

    return selectBorrowableMemories(
        config,
        { id: viewerId, name: viewerName, worldId: viewerWorldId },
        owners,
    );
}
