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
import { getAllCharacterIdsWithMemories, loadMemoryEntriesByType } from "./memory-storage";
import { loadCharacters } from "./character-storage";

/** Minimum name length to match on. A one-character name would hit almost every sentence. */
const MIN_NAME_LENGTH = 2;

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

/** One other character's long-term memories, as handed to the selector below */
export type MemoryOwnerBundle = {
    ownerId: string;
    ownerName: string;
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
    viewerId: string,
    viewerName: string,
    owners: MemoryOwnerBundle[],
): MemoryEntry[] {
    if (!config?.sharedMemoryEnabled) return [];
    if (!viewerId) return [];
    const name = viewerName?.trim();
    if (!name || name.length < MIN_NAME_LENGTH) return [];

    const borrowed: MemoryEntry[] = [];
    for (const owner of owners) {
        if (!owner) continue;
        if (owner.ownerId === viewerId) continue;
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
    return borrowed;
}

/**
 * Storage-facing wrapper: gather every other character's long-term memories, then delegate the
 * decision to `selectBorrowableMemories`.
 *
 * long_term only. Core memories are identity- and relationship-level, and sharing those is a
 * much bigger decision that is deliberately out of scope for layer 1.
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

    const nameById = new Map(characters.map((item) => [item.id, item.name]));
    const ownerIds = await getAllCharacterIdsWithMemories();

    const owners: MemoryOwnerBundle[] = [];
    for (const ownerId of ownerIds) {
        if (ownerId === viewerId) continue;
        const ownerName = nameById.get(ownerId)?.trim();
        if (!ownerName) continue;
        owners.push({ ownerId, ownerName, entries: await loadMemoryEntriesByType(ownerId, "long_term") });
    }

    return selectBorrowableMemories(config, viewerId, viewerName, owners);
}
