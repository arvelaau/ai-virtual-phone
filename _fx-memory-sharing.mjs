// Shared memory, layer 1 (name match).
//
// The filter is the ONLY thing standing between "controlled sharing" and "everything leaks",
// so this leans on negative assertions: what must NOT cross is tested as hard as what must.
//
//   node _fx-memory-sharing.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
        ownerId: "c_alice", ownerName: "Alice",
        entries: [
            entry("m1", "Bo and I closed the bar together.", "2026-08-01T10:00:00Z"),
            entry("m2", "I called her Sayang for the first time.", "2026-08-02T10:00:00Z"),
        ],
    };
    const cara = {
        ownerId: "c_cara", ownerName: "Cara",
        entries: [entry("m3", "Ran into Bo at the pier.", "2026-08-03T10:00:00Z")],
    };
    const viewerOwn = {
        ownerId: "c_bo", ownerName: "Bo",
        entries: [entry("m4", "Bo is me, this should never be borrowed.", "2026-08-04T10:00:00Z")],
    };
    const owners = [alice, cara, viewerOwn];

    ok("C1 disabled by default", DEFAULT_MEMORY_CONFIG.sharedMemoryEnabled === false);
    ok("C2 has its own budget", typeof DEFAULT_MEMORY_CONFIG.sharedMemoryTokenBudget === "number"
        && DEFAULT_MEMORY_CONFIG.sharedMemoryTokenBudget > 0);

    // fail closed -- and now it genuinely discriminates, because ON returns rows
    const off = selectBorrowableMemories(OFF, "c_bo", "Bo", owners);
    eq("C3 disabled borrows nothing", off.length, 0);
    const on = selectBorrowableMemories(ON, "c_bo", "Bo", owners);
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
    eq("C16 no viewer id borrows nothing", selectBorrowableMemories(ON, "", "Bo", owners).length, 0);
    eq("C17 no viewer name borrows nothing", selectBorrowableMemories(ON, "c_bo", "  ", owners).length, 0);
    eq("C18 one-character viewer name borrows nothing", selectBorrowableMemories(ON, "c_bo", "B", owners).length, 0);
    eq("C19 an owner with no name is skipped",
        selectBorrowableMemories(ON, "c_bo", "Bo", [{ ownerId: "ghost", ownerName: "", entries: alice.entries }]).length, 0);
    eq("C20 no owners at all is fine", selectBorrowableMemories(ON, "c_bo", "Bo", []).length, 0);

    // a viewer nobody has ever mentioned gets nothing -- the name filter IS the sharing circle
    eq("C21 an unmentioned character borrows nothing",
        selectBorrowableMemories(ON, "c_zed", "Zed", owners).length, 0);
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
const EXPECTED = 64;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
