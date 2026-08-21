// Shared memory, layer 1 (name match).
//
// The filter is the ONLY thing standing between "controlled sharing" and "everything leaks",
// so this leans on negative assertions: what must NOT cross is tested as hard as what must.
//
//   node _fx-memory-sharing.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs2 from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });

const SH = jiti(path.join(root, "lib/memory-sharing.ts"));
const INJ = jiti(path.join(root, "lib/memory-injector.ts"));
const TYPES = jiti(path.join(root, "lib/memory-types.ts"));
const { mentionsName, borrowedFromName } = SH;
const { formatLongTermMemories } = INJ;
const { DEFAULT_MEMORY_CONFIG } = TYPES;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`  FAIL ${name}${extra === undefined ? "" : ` -- ${extra}`}`);
};
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── A. the name matcher: what must match ───────────────────────────────────────
{
    ok("A1 plain mention", mentionsName("Went to the pier with Alice today.", "Alice"));
    ok("A2 case-insensitive", mentionsName("went to the pier with ALICE", "alice"));
    ok("A3 at the very start", mentionsName("Alice laughed at me.", "Alice"));
    ok("A4 at the very end", mentionsName("The one who stayed was Alice", "Alice"));
    ok("A5 followed by punctuation", mentionsName("I saw Alice, then left.", "Alice"));
    ok("A6 possessive", mentionsName("I borrowed Alice's umbrella.", "Alice"));
    ok("A7 in quotes", mentionsName('She said "Alice" out loud.', "Alice"));
    ok("A8 two-word name", mentionsName("Cheng Jibai poured the last glass.", "Cheng Jibai"));
    ok("A9 name with an accent", mentionsName("Zoe met Renee at the bar.", "Renee"));
    // CJK has no word separators, so a plain substring is the correct rule there
    ok("A10 CJK name", mentionsName("今天和阿澜去了码头。", "阿澜"));
    ok("A11 CJK name followed by a particle", mentionsName("阿澜说他不想说话。", "阿澜"));
}

// ── B. the name matcher: what must NOT match (this is the leak boundary) ───────
{
    ok("B1 substring inside a longer word", !mentionsName("The alliance broke up.", "Al"));
    ok("B2 name inside another name", !mentionsName("Alicia came over.", "Alice"));
    ok("B3 name as a prefix of a longer word", !mentionsName("Alicexandra waved.", "Alice"));
    ok("B4 unrelated memory", !mentionsName("I made coffee and read for an hour.", "Alice"));
    ok("B5 empty content", !mentionsName("", "Alice"));
    ok("B6 one-character name never matches", !mentionsName("A went home.", "A"));
    ok("B7 blank name never matches", !mentionsName("Alice went home.", "   "));
    ok("B8 null-ish content is safe", !mentionsName(undefined, "Alice"));
    // A group word is NOT layer 1. If this ever starts passing, layer 2 shipped by accident.
    ok("B9 group keyword does not match a name", !mentionsName("Out with the guys again.", "Alice"));
}

// ── C. borrowing behaviour, driven through the pure selector ──────────────────
//
// Driven through selectBorrowableMemories rather than gatherBorrowedMemories on purpose:
// the wrapper reads storage, and under Node the character list comes back empty, so a
// BROKEN guard returns [] for the wrong reason and looks like a working one. That exact
// false pass is what the first version of this group did.
{
    const { selectBorrowableMemories } = SH;
    const ON = { sharedMemoryEnabled: true };
    const OFF = { sharedMemoryEnabled: false };

    const entry = (id, content, createdAt) => ({
        id, content, createdAt, updatedAt: createdAt,
        characterId: "cx", type: "long_term", sourceApp: "chat", importance: 0.8,
        metadata: { summarizedEvents: 3 },
    });
    const alice = {
        ownerId: "c_alice", ownerName: "Alice", worldId: "w1",
        entries: [
            entry("m1", "Bo and I closed the bar together.", "2026-08-01T10:00:00Z"),
            entry("m2", "I called her Sayang for the first time.", "2026-08-02T10:00:00Z"),
        ],
    };
    const cara = {
        ownerId: "c_cara", ownerName: "Cara", worldId: "w1",
        entries: [entry("m3", "Ran into Bo at the pier.", "2026-08-03T10:00:00Z")],
    };
    const viewerOwn = {
        ownerId: "c_bo", ownerName: "Bo", worldId: "w1",
        entries: [entry("m4", "Bo is me, this should never be borrowed.", "2026-08-04T10:00:00Z")],
    };
    const owners = [alice, cara, viewerOwn];
    const BO = { id: "c_bo", name: "Bo", worldId: "w1" };

    ok("C1 disabled by default", DEFAULT_MEMORY_CONFIG.sharedMemoryEnabled === false);
    ok("C2 has its own budget", typeof DEFAULT_MEMORY_CONFIG.sharedMemoryTokenBudget === "number"
        && DEFAULT_MEMORY_CONFIG.sharedMemoryTokenBudget > 0);

    // fail closed -- and now it genuinely discriminates, because ON returns rows
    const off = selectBorrowableMemories(OFF, BO, owners);
    eq("C3 disabled borrows nothing", off.length, 0);
    const on = selectBorrowableMemories(ON, BO, owners);
    ok("C4 enabled does borrow", on.length > 0, `got ${on.length}`);

    // the filter: only memories naming Bo cross
    eq("C5 borrows exactly the mentions", on.length, 2);
    const ids = on.map((e) => e.id).sort();
    eq("C6 the right two entries", ids.join(","), "m1,m3");
    ok("C7 the unrelated private memory did NOT cross", !on.some((e) => e.id === "m2"));
    ok("C8 never borrows from itself", !on.some((e) => e.id === "m4"));

    // attribution
    eq("C9 attributed to the right owner", borrowedFromName(on.find((e) => e.id === "m1")), "Alice");
    eq("C10 second owner attributed too", borrowedFromName(on.find((e) => e.id === "m3")), "Cara");
    eq("C11 borrowedFrom id is stamped", on.find((e) => e.id === "m1").metadata.borrowedFrom, "c_alice");
    eq("C12 pre-existing metadata survives", on.find((e) => e.id === "m1").metadata.summarizedEvents, 3);

    // copy, never mutate -- the source entry is rendered on its owner's own memory page
    ok("C13 source entry untouched", alice.entries[0].metadata.borrowedFrom === undefined);
    ok("C14 the copy is a different object", on.find((e) => e.id === "m1") !== alice.entries[0]);

    // newest first
    eq("C15 sorted newest first", on[0].id, "m3");

    // guards
    eq("C16 no viewer id borrows nothing", selectBorrowableMemories(ON, { ...BO, id: "" }, owners).length, 0);
    eq("C17 no viewer name borrows nothing", selectBorrowableMemories(ON, { ...BO, name: "  " }, owners).length, 0);
    eq("C18 one-character viewer name borrows nothing", selectBorrowableMemories(ON, { ...BO, name: "B" }, owners).length, 0);
    eq("C19 an owner with no name is skipped",
        selectBorrowableMemories(ON, BO, [{ ownerId: "ghost", ownerName: "", worldId: "w1", entries: alice.entries }]).length, 0);
    eq("C20 no owners at all is fine", selectBorrowableMemories(ON, BO, []).length, 0);

    // a viewer nobody has ever mentioned gets nothing -- the name filter IS the sharing circle
    eq("C21 an unmentioned character borrows nothing",
        selectBorrowableMemories(ON, { id: "c_zed", name: "Zed", worldId: "w1" }, owners).length, 0);
}

// ── P. the summarization prompt, and its superseded-default upgrade ───────────
//
// Shared memory can only surface what the summarizer wrote down. v1 framed every scene as
// {{char}} <-> user, so other characters present were routinely dropped and the name filter
// had almost nothing to match. The prompt is the real source of yield here.
{
    const { DEFAULT_SUMMARIZATION_PROMPT, SUPERSEDED_SUMMARIZATION_PROMPTS } = TYPES;

    ok("P1 the current prompt asks for other characters by name",
        /Name every other character/i.test(DEFAULT_SUMMARIZATION_PROMPT));
    ok("P2 and says not to collapse a scene to char + user",
        /Do not collapse a scene/i.test(DEFAULT_SUMMARIZATION_PROMPT));
    ok("P3 the char <-> user interaction is still covered",
        /interactions between \{\{char\}\} and the user/i.test(DEFAULT_SUMMARIZATION_PROMPT));
    ok("P4 placeholders survive",
        ["{{char}}", "{{earliest}}", "{{latest}}", "{{events}}"].every((m) => DEFAULT_SUMMARIZATION_PROMPT.includes(m)));

    // The upgrade path. Without it, changing the constant reaches only users who have never
    // saved a memory setting -- and the shared-memory toggle itself is a memory setting.
    ok("P5 there is at least one superseded prompt recorded", SUPERSEDED_SUMMARIZATION_PROMPTS.length >= 1);
    ok("P6 the superseded v1 is the char<->user framing",
        SUPERSEDED_SUMMARIZATION_PROMPTS.some((t) => /Describe the interactions between \{\{char\}\} and the user in the third person/.test(t)));
    ok("P7 v1 genuinely lacked the other-character rule",
        SUPERSEDED_SUMMARIZATION_PROMPTS.every((t) => !/Name every other character/i.test(t)));
    ok("P8 the current default is NOT in the superseded list",
        !SUPERSEDED_SUMMARIZATION_PROMPTS.includes(DEFAULT_SUMMARIZATION_PROMPT));

    // Behavioural: the upgrade itself
    const STORE = jiti(path.join(root, "lib/memory-storage.ts"));
    const { upgradeSupersededPrompts } = STORE;
    const v1 = SUPERSEDED_SUMMARIZATION_PROMPTS[0];

    const upgraded = upgradeSupersededPrompts({ ...DEFAULT_MEMORY_CONFIG, summarizationPrompt: v1 });
    eq("P9 a stored v1 prompt is upgraded", upgraded.summarizationPrompt, DEFAULT_SUMMARIZATION_PROMPT);

    const custom = "My own prompt about {{char}}.";
    eq("P10 a genuinely customised prompt is left alone",
        upgradeSupersededPrompts({ ...DEFAULT_MEMORY_CONFIG, summarizationPrompt: custom }).summarizationPrompt, custom);

    eq("P11 the current default is left alone",
        upgradeSupersededPrompts({ ...DEFAULT_MEMORY_CONFIG, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT }).summarizationPrompt,
        DEFAULT_SUMMARIZATION_PROMPT);

    ok("P12 every other setting survives the upgrade",
        upgradeSupersededPrompts({ ...DEFAULT_MEMORY_CONFIG, summarizationPrompt: v1, maxLongTermEntries: 42 }).maxLongTermEntries === 42);

    // Source, SCOPED to loadMemoryConfig's own body. Testing the whole file would match the
    // function's own definition and pass even with the call site deleted -- which is exactly
    // how the first version of this assertion went vacuous.
    const store = fs2.readFileSync(path.join(root, "lib/memory-storage.ts"), "utf8");
    const fnStart = store.indexOf("export function loadMemoryConfig");
    const body = store.slice(fnStart, store.indexOf("\n}", fnStart));
    ok("P13 loadMemoryConfig actually calls the upgrade",
        /upgradeSupersededPrompts\(/.test(body), body.slice(-200));
}

// ── W. worlds: the same name in two worlds is two different people ────────────
//
// Names are the identifier this feature matches on, so without a world scope "Alice" in
// world A would borrow every memory naming "Alice" written in world B. Character.worldId is
// a DEAD field (declared, never written) -- membership lives on the world group.
{
    const { selectBorrowableMemories } = SH;
    const ON = { sharedMemoryEnabled: true };
    const mem = (id, content) => ({
        id, content, createdAt: "2026-08-10T10:00:00Z", updatedAt: "2026-08-10T10:00:00Z",
        characterId: "x", type: "long_term", sourceApp: "chat", importance: 0.8,
    });

    // Two DIFFERENT characters both called Alice, one per world, plus a narrator in each.
    const narratorW1 = { ownerId: "n1", ownerName: "Nara", worldId: "w1", entries: [mem("w1a", "Alice lent me her coat.")] };
    const narratorW2 = { ownerId: "n2", ownerName: "Nero", worldId: "w2", entries: [mem("w2a", "Alice betrayed the guild.")] };
    const owners = [narratorW1, narratorW2];

    const aliceW1 = { id: "c_a1", name: "Alice", worldId: "w1" };
    const aliceW2 = { id: "c_a2", name: "Alice", worldId: "w2" };

    const got1 = selectBorrowableMemories(ON, aliceW1, owners);
    eq("W1 world-1 Alice borrows one memory", got1.length, 1);
    eq("W2 and it is the one from her own world", got1[0].id, "w1a");
    ok("W3 the other world's memory did NOT cross", !got1.some((e) => e.id === "w2a"));

    const got2 = selectBorrowableMemories(ON, aliceW2, owners);
    eq("W4 world-2 Alice borrows one memory", got2.length, 1);
    eq("W5 and it is hers", got2[0].id, "w2a");
    ok("W6 symmetric: world 1 did not leak into world 2", !got2.some((e) => e.id === "w1a"));

    // fail closed on a missing world rather than falling back to "share with everyone"
    eq("W7 viewer with no world borrows nothing",
        selectBorrowableMemories(ON, { id: "c_a1", name: "Alice", worldId: "" }, owners).length, 0);
    eq("W8 owner with no world is skipped",
        selectBorrowableMemories(ON, aliceW1, [{ ownerId: "n3", ownerName: "Nyx", worldId: "", entries: [mem("z", "Alice waved.")] }]).length, 0);

    // same world, same name: genuinely ambiguous and deliberately still shared -- recorded so
    // it is a known residue rather than a surprise
    const twin = { ownerId: "c_a2", ownerName: "Alice", worldId: "w1", entries: [mem("tw", "Alice and I argued.")] };
    eq("W9 same name in the SAME world still crosses (known residue)",
        selectBorrowableMemories(ON, aliceW1, [twin]).length, 1);

    // the wrapper must read world membership from the group, not the dead field
    const shr = fs2.readFileSync(path.join(root, "lib/memory-sharing.ts"), "utf8");
    ok("W10 wrapper uses the world GROUP", /loadCharacterWorldGroups()/.test(shr));
    ok("W11 wrapper does not use the dead Character.worldId", !/\.worldId\b(?!\?)/.test(shr.split("loadCharacterWorldGroups")[0]));
}

// ── D. attribution in the rendered prompt (the POV bug) ───────────────────────
{
    const own = (content) => ({ id: "m1", content, metadata: {} });
    const borrowed = (content, from) => ({ id: "m2", content, metadata: { borrowedFrom: "cx", borrowedFromName: from } });

    eq("D1 borrowedFromName reads the stamp", borrowedFromName(borrowed("x", "Alice")), "Alice");
    eq("D2 own entries have no stamp", borrowedFromName(own("x")), null);
    eq("D3 an entry with no metadata is safe", borrowedFromName({ id: "m", content: "x" }), null);

    const onlyOwn = formatLongTermMemories([own("I made coffee.")]);
    eq("D4 own-only output is unchanged", onlyOwn, "- I made coffee.");
    ok("D5 no heading when nothing was borrowed", !onlyOwn.includes("secondhand"));

    const mixed = formatLongTermMemories([own("I made coffee."), borrowed("I took her to the pier.", "Alice")]);
    ok("D6 own line still present", mixed.includes("- I made coffee."));
    ok("D7 borrowed line is attributed", mixed.includes("- (Alice) I took her to the pier."));
    ok("D8 heading appears once borrowed", mixed.includes("secondhand"));
    // The whole point: the model must be told whose "I" it is reading
    ok("D9 heading explains the first person", /"I"/.test(mixed) && /never to you/i.test(mixed));
    ok("D10 borrowed section comes after own", mixed.indexOf("- I made coffee.") < mixed.indexOf("- (Alice)"));

    const onlyBorrowed = formatLongTermMemories([borrowed("I waited an hour.", "Bo")]);
    ok("D11 borrowed-only still gets the heading", onlyBorrowed.includes("secondhand"));
    ok("D12 borrowed-only has no stray blank lead", !onlyBorrowed.startsWith("\n"));
    eq("D13 empty in, empty out", formatLongTermMemories([]), "");
}

// ── E. wiring: the service must consult the borrower, with its own budget ─────
{
    const fs = jiti("node:fs");
    const svc = fs.readFileSync(path.join(root, "lib/memory-service.ts"), "utf8");
    ok("E1 service imports the borrower", /from "\.\/memory-sharing"/.test(svc));
    ok("E2 borrowing is actually called", /gatherBorrowedMemories\(/.test(svc));
    ok("E3 borrowed entries get the SHARED budget, not the long-term one",
        /fillByBudget\(\s*borrowedAll\s*,\s*config\.sharedMemoryTokenBudget\s*\)/.test(svc));
    // The early return for "this character has no memories yet" must not skip borrowing,
    // or a brand-new character could never hear about itself.
    ok("E4 the empty-own early return lives in the inner selector",
        /async function selectOwnLongTermMemories/.test(svc)
        && /longTermEntries\.length === 0 \|\| !currentContext\.trim\(\)/.test(svc));
    const exported = svc.slice(svc.indexOf("export async function retrieveMemoriesForPrompt"));
    const body = exported.slice(0, exported.indexOf("\n}"));
    ok("E5 the exported entry point returns own + borrowed",
        /\[\s*\.\.\.own\s*,\s*\.\.\.borrowed\s*\]/.test(body), body.slice(-160));

    const shr = fs.readFileSync(path.join(root, "lib/memory-sharing.ts"), "utf8");
    ok("E6 only long_term is borrowed, never core",
        /loadMemoryEntriesByType\(ownerId, "long_term"\)/.test(shr) && !/"core"/.test(shr));
    ok("E7 a character never borrows from itself", /ownerId === viewerId\) continue/.test(shr));
    ok("E8 stored entries are copied, never mutated", /\.\.\.entry,/.test(shr) && !/entry\.metadata\s*=/.test(shr));
    ok("E9 no CJK literals left in the script-range regex", !/[぀-鿿]/.test(shr));
    ok("E10 no control characters",
        ![...shr].some((c) => { const n = c.charCodeAt(0); return (n < 9 || (n > 13 && n < 32) || n === 127); }));
}

// Guard against the whole file silently skipping a group: the count is pinned, so a group
// that stops running fails loudly instead of shrinking the suite.
// Counted before this guard itself runs, so the total printed below is EXPECTED + 1.
const EXPECTED = 88;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
