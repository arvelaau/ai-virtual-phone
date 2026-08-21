# Story mode: multiple characters, isolated knowledge — implementation plan

Status: **plan only, nothing implemented.** Decision taken (2026-08-20): **Option 1** — spoken
dialogue in a shared scene is public (a character standing there heard it), while memory,
persona, inner thoughts, state values, world books, bindings and prior sessions stay strictly
per-character.

Written the same way as `PROTOCOL-MIGRATION-PLAN.md`: findings first, then phased work, so the
phases can be picked up one at a time without re-deriving the research.

---

## The central finding: the engine is already multi-character-capable

`buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, excludedTags)`
(`lib/story-engine.ts:177`) takes the character and the history as **separate arguments**, and
every per-character thing resolves from `characterId` alone:

| what | resolved by | file:line |
|---|---|---|
| API config, preset, regexes, world books, summary tag | `resolveStoryConfigs(characterId)` | `story-engine.ts:72` |
| user identity (incl. what this character calls the user) | `resolveUserIdentity(characterId, "story")` | `story-engine.ts:190` |
| short-term context + world-book activation | `prepareShortTermContext(characterId, "story", …)` | `story-engine.ts:193` |
| long-term memory | `retrieveMemoriesForPrompt(characterId, …)` | `story-engine.ts:199` |
| core memory | `retrieveCoreMemoriesForPrompt(characterId, …)` | `story-engine.ts:200` |
| schedule / calendar | `getCurrentCalendarScheduleForPrompt("character", characterId, …)` | `story-engine.ts:214` |
| couple space | `buildCoupleSpacePromptBlock({ characterId })` | `story-engine.ts:215` |

**So the isolation the feature is for does not have to be built — it already exists**, enforced
at the storage layer: `lib/memory-storage.ts` indexes memory by `by_character`,
`by_character_type`, `by_character_created` and reads through `loadMemoryEntries(characterId)`.

Calling `generateStoryCompletion(charX, sharedHistory)` and then
`generateStoryCompletion(charY, sharedHistory)` already gives two fully isolated minds reading
one shared scene. That is the whole feature, minus plumbing.

### Group chat is the WRONG model to copy
`lib/group-chat-engine.ts` puts every member's persona and state into **one** prompt and makes
**one** LLM call that voices all characters, splitting the output afterwards by
`[CharacterName]:` (`parseGroupChatResponse`, `:140`). Knowledge isolation is structurally
impossible there. Story multi-character must do the opposite: **one call per speaking
character**. That is the core architectural commitment of this plan.

### Blast radius is small
- `generateStoryCompletion` — 2 call sites, both `components/story/story-app-base.tsx` (`:574`, `:789`)
- `createOrGetStorySession` — 2 call sites, same file (`:312`, `:328`)
- `loadStoryProjectionEntries` — 1 call site, `lib/short-term-assembler.ts:531`

---

## The two places knowledge would actually leak

Everything else is UI. These two are the feature.

### Leak 1 — memory projection (the important one)
`loadStoryProjectionEntries(characterId)` (`lib/story-storage.ts:260`) finds the session by
`characterId`, then projects **every** assistant message's `storySummary` into that character's
memory stream. With several characters in one session, X would absorb Y's summaries as X's own
memories — exactly the contamination this feature exists to prevent.

Fix is one predicate: project only messages the character itself authored
(`speakerId === characterId`). Because X's summary was written by X's own model call while X
could see the shared scene, X's memory still naturally contains what X witnessed — framed in
X's voice. That is precisely the Option-1 semantic, and it falls out for free.

### Leak 2 — history role attribution
`toHistoryMessage` (`lib/story-engine.ts:61`) copies `message.role` straight through. Today
that is fine because every assistant turn belongs to the one character. With several speakers,
Y's prose would arrive in X's prompt as role `assistant` — i.e. X reads it as **its own earlier
output** and will happily keep writing as Y.

Group chat's answer is a `[Name]: ` content prefix with the role left alone
(`annotateGroupHistory`, `group-chat-engine.ts:100-133`). That is not enough here, because we
want X to treat Y as *external*. Story needs a viewer-relative mapping:

| message | role in X's prompt | content |
|---|---|---|
| X's own turn | `assistant` | unchanged |
| Y's turn | `user` | `[Y]: …` |
| the player's turn | `user` | `[PlayerName]: …` |
| system | `system` | unchanged |

Consecutive `user` messages are already normal in this codebase (group chat does it), so no
merging is required.

---

## Phase 0 — spike, before any migration (≈30 min)

Prove the central finding on the running app with **zero schema change**: temporarily call
`generateStoryCompletion(someOtherCharacterId, currentHistory)` from a dev-only button in
`story-app-base.tsx` and confirm the reply comes back in that other character's voice, with its
own binding and memory.

If this does not feel right, stop — everything below is plumbing on top of it. Revert the
button afterwards; it is a throwaway.

---

## Phase 1 — data model + migration

**`lib/story-storage.ts`**

```ts
export type StorySession = {
  id: string;
  /** @deprecated legacy single-character field, kept so old rows still migrate */
  characterId?: string;
  characterIds: string[];      // participants, order = display order
  // …unchanged
};

export type StoryMessage = {
  // …unchanged
  /** which character wrote this turn; absent on user/system rows */
  speakerId?: string;
};
```

Dexie is currently `version(1)` with `sessions: "id, characterId, updatedAt"`
(`story-storage.ts:50-53`). Add:

```ts
this.version(2).stores({
  sessions: "id, *characterIds, updatedAt",   // multi-entry index
  messages: "id, sessionId, createdAt",
}).upgrade(async (tx) => {
  await tx.table("sessions").toCollection().modify((s) => {
    if (!s.characterIds) s.characterIds = s.characterId ? [s.characterId] : [];
  });
});
```

`speakerId` backfill cannot be done in the session upgrade alone (messages need their session's
character). Do it lazily instead: on load, an assistant message with no `speakerId` inherits
`session.characterIds[0]`. Cheaper than a full table rewrite and correct for every pre-existing
session, which by definition had exactly one character.

**Touch points in the same file**: `createOrGetStorySession(characterId)` (`:154`) keeps its
signature for compatibility and becomes a thin wrapper over a new
`createOrGetStorySessionFor(characterIds: string[])`; the `indexByCharacter` dedupe logic at
`:97-107` needs rewriting for the array case.

---

## Phase 2 — isolation (this is the feature)

1. **`loadStoryProjectionEntries`** (`story-storage.ts:260`)
   - session lookup: `characterIds.includes(characterId)` instead of `=== characterId`
   - add the predicate: `if (current.speakerId && current.speakerId !== characterId) continue;`
     (the `speakerId &&` guard keeps legacy rows projecting as they do today)
2. **New `toHistoryMessageFor(viewerId, message, contextExcludedTags)`** in `story-engine.ts`,
   replacing `toHistoryMessage` at the `history.map(…)` on `:191`, implementing the role table
   above. Character names come from `loadCharacters()`, the player's from
   `resolveUserIdentity(viewerId, "story")`.
3. **`generateStoryCompletion`** — no signature change needed (`characterId` is already the
   speaker), but `parseStoryResponse` must use **that speaker's** `summaryTag` and regexes,
   which it already does via `resolveStoryConfigs(characterId)`. Verify, do not assume.

---

## Phase 3 — turn loop + UI (`components/story/story-app-base.tsx`, 1316 lines)

- session creation takes a participant list; add/remove participants on an existing session
- a speaker picker: which character writes the next turn (explicit and manual — **no auto
  director in v1**, that is a separate feature and a separate can of worms)
- store `speakerId` on the generated message; render name + avatar per bubble
- `maybeRunSummarization(characterId, …)` (`:600`) fires **for the speaker only**
- `incrementEventCounter(characterId)` (`:598-599`) likewise

---

## Phase 4 — preset

`story_output_format` (tags `["story"]`, in `lib/builtin-preset.ts`) currently assumes a single
character. It needs one line telling the model it writes **only** as `{{char}}` and must not
author other characters' dialogue or actions — otherwise X will write Y's lines and the
per-character calls buy nothing.

⚠️ **`BUILTIN_PRESET_VERSION` must be bumped**, or the edit is dead code — `loadPresets()` only
refreshes when `builtInVersion < BUILTIN_PRESET_VERSION`. This trap silently invalidated most of
early Phase D; see CLAUDE.md.

---

## Phase 5 — fixture (`_fx-story-multichar.mjs`, keep in repo)

Behavioural, driving the real modules through `jiti` + `_fx-dexie-stub.mjs` (the stub already
exists and is reusable):

1. a session with X and Y; X and Y each write a turn with a `storySummary`
2. **`loadStoryProjectionEntries(X)` returns only X's summary** — the core assertion
3. and `loadStoryProjectionEntries(Y)` only Y's
4. a legacy single-character session (no `characterIds`, no `speakerId`) still projects exactly
   as before — the back-compat assertion
5. `toHistoryMessageFor(X, …)`: X's turn is `assistant`, Y's turn is `user` prefixed `[Y]:`
6. and symmetrically for Y
7. the Dexie v1→v2 upgrade produces `characterIds: [characterId]`

**Non-vacuity controls to actually run** (not just assert): remove the `speakerId` predicate in
`loadStoryProjectionEntries` → assertions 2 and 3 must fail; make `toHistoryMessageFor` pass
roles through unchanged → 5 and 6 must fail.

---

## Costs and risks, stated plainly

- **N characters = N LLM calls per round.** Group chat does 1 call for N characters precisely to
  avoid this. This is the price of real isolation and it is not avoidable within this design.
- **`rebuildStorySessionRenderCache(characterId, sessionId)`** (`story-engine.ts:244`) rebuilds
  *every* message in a session using *one* character's regexes and `summaryTag`. With mixed
  speakers that is wrong. It must iterate per message and resolve configs from
  `message.speakerId`. **Easy to miss** — it is not on the generation path, so nothing fails
  until someone hits "Rebuild render cache" and half the session re-renders with the wrong
  regexes.
- **Per-session `customCSS` and `uiPrefs`** stay session-level, which is fine; but per-character
  regexes now vary *within* one session's render. `regexSignature`/`parserVersion` are already
  stored per message (`StoryMessage:33-34`), so the cache model already supports this — confirm
  rather than assume.
- **Summaries multiply**: each character summarizes each round from its own POV, so summary
  calls scale with participants too.
- **Not in v1, deliberately**: auto-director/turn ordering, characters addressing each other by
  name reliably, and any notion of private/whispered beats (that is Option 2, which was
  explicitly rejected for now and would need a presence model per beat).

---

## Suggested order

Phase 0 → 1 → 2 → 5 → 3 → 4.

Fixture before UI is deliberate: phases 1–2 are where correctness lives, and they are fully
testable headlessly. Phase 3 is the largest but the least risky, and phase 4 is one paragraph
plus a version bump.
