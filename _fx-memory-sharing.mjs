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

    // Count cap. The token budget alone is not a bound: a long story history can produce
    // hundreds of matching summaries, and secondhand knowledge that dominates the prompt
    // pushes out what the character actually needs -- in story mode the trailing <summary>
    // is the first casualty.
    const many = {
        ownerId: "c_many", ownerName: "Mira", worldId: "w1",
        entries: Array.from({ length: 200 }, (_, i) =>
            entry(`big${i}`, `Bo was there, beat ${i}.`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`)),
    };
    const capped = selectBorrowableMemories(ON, BO, [many]);
    ok("C22 borrowed rows are capped well below the match count",
        capped.length > 0 && capped.length <= 32, `got ${capped.length} from 200 matches`);
    ok("C23 the cap keeps the NEWEST, not the first found",
        new Date(capped[0].createdAt) >= new Date(capped[capped.length - 1].createdAt));
}

// ── S. short-term borrowing as summarization INPUT, and the echo break ────────
//
// A character with no history of its own can now build a long-term memory out of what world
// mates wrote about them -- effectively a name search across their short-term timelines. The
// output is flagged so it is never lent on, which is what stops the two characters echoing a
// single event back and forth forever.
{
    const { selectBorrowableMemories, isSecondhandDerived, SECONDHAND_DERIVED_FLAG } = SH;
    const ON = { sharedMemoryEnabled: true };
    const BO = { id: "c_bo", name: "Bo", worldId: "w1" };
    const row = (id, content, meta) => ({
        id, characterId: "c_alice", sourceApp: "chat", type: "long_term", content,
        importance: 0.8, createdAt: "2026-08-01T10:00:00Z", updatedAt: "2026-08-01T10:00:00Z",
        metadata: meta ?? {},
    });

    eq("S1 the flag name is stable", SECONDHAND_DERIVED_FLAG, "fromSecondhand");
    ok("S2 a flagged entry is recognised", isSecondhandDerived(row("x", "y", { fromSecondhand: true })));
    ok("S3 an ordinary entry is not", !isSecondhandDerived(row("x", "y")));
    ok("S4 a metadata-less entry is safe", !isSecondhandDerived({ id: "x", content: "y" }));

    // the echo break: a secondhand-derived memory naming Bo must NOT come back to Bo
    const owner = {
        ownerId: "c_alice", ownerName: "Alice", worldId: "w1",
        entries: [
            row("firsthand", "Bo turned up at the harbour."),
            row("derived", "Bo was mentioned again.", { fromSecondhand: true }),
        ],
    };
    const got = selectBorrowableMemories(ON, BO, [owner]);
    eq("S5 only the first-hand memory is lent", got.length, 1);
    eq("S6 and it is the right one", got[0].id, "firsthand");
    ok("S7 the derived memory is never lent on", !got.some((e) => e.id === "derived"));

    // wiring, scoped per function body -- both sides are storage-backed and return [] in Node
    const shr = fs2.readFileSync(path.join(root, "lib/memory-sharing.ts"), "utf8");
    const sum = fs2.readFileSync(path.join(root, "lib/memory-summarizer.ts"), "utf8");
    const bodyOf = (src, name) => {
        const start = src.indexOf(name);
        if (start < 0) return "";
        const end = src.indexOf("\n}", start);
        return end < 0 ? "" : src.slice(start, end);
    };
    const gather = bodyOf(shr, "export function gatherBorrowedShortTermEvents");
    ok("S8 the gatherer was located", gather.length > 200, `${gather.length}`);
    ok("S9 it reads world mates' timelines", gather.includes("loadNativeTimeline(ownerId)"));
    ok("S10 it filters by the viewer's name", gather.includes("mentionsName(event.content, viewerName)"));
    ok("S11 it never lends to itself", gather.includes("ownerId === viewerId) continue"));
    ok("S12 each event says whose account it is", gather.includes("(from ${ownerName}'s account)"));
    ok("S13 borrowed short-term is capped", gather.includes("MAX_BORROWED_SHORT_TERM"));

    const pipeline = bodyOf(sum, "export async function runSummarizationPipeline");
    ok("S14 the pipeline was located", pipeline.length > 400, `${pipeline.length}`);
    ok("S15 the summarizer pulls borrowed events", pipeline.includes("gatherBorrowedShortTermEvents(characterId, config)"));
    ok("S16 borrowed events count toward the 4-event threshold",
        pipeline.includes("allEntries.length < 4") && pipeline.includes("...ownEntries, ...borrowedEvents"));
    ok("S17 the saved entry is flagged when borrowed events contributed",
        sum.includes("[SECONDHAND_DERIVED_FLAG]: true"));
    ok("S18 and NOT flagged otherwise", sum.includes("borrowedEvents.length") && sum.includes(": {}"));
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

// ── N. narrative summaries as a second borrowable source ─────────────────────
//
// Long-term memory alone yields little: the summarizer condenses hard, so another character
// is often not named. Story / VN / offline projections are ALREADY summaries written by the
// model (each capped at 500 chars by its own loader), which makes them safe to lend where a
// raw chat transcript would not be.
{
    const { selectBorrowableMemories } = SH;
    const ON = { sharedMemoryEnabled: true };
    const BO = { id: "c_bo", name: "Bo", worldId: "w1" };

    // Shaped exactly as loadNarrativeSummaries builds them
    const narrative = (id, app, content, ts) => ({
        id, characterId: "c_alice", sourceApp: app, type: "long_term", content,
        importance: 0.6, createdAt: ts, updatedAt: ts, metadata: { narrativeSource: app },
    });
    const longTerm = (id, content, ts) => ({
        id, characterId: "c_alice", sourceApp: "chat", type: "long_term", content,
        importance: 0.8, createdAt: ts, updatedAt: ts, metadata: {},
    });

    const alice = {
        ownerId: "c_alice", ownerName: "Alice", worldId: "w1",
        entries: [
            longTerm("lt1", "Alice and the user talked for hours.", "2026-08-01T10:00:00Z"),
            narrative("st1", "story", "[Event 2 Aug 20:10] Bo showed up at the harbour and refused to explain himself.", "2026-08-02T10:00:00Z"),
            narrative("vn1", "vn", "[Event 3 Aug 09:00] The chapter closed with Bo walking out.", "2026-08-03T10:00:00Z"),
            narrative("of1", "chat", "[Event 4 Aug 21:00] Spent the evening avoiding Bo's calls.", "2026-08-04T10:00:00Z"),
            narrative("st2", "story", "[Event 5 Aug 11:00] A quiet chapter, nobody else around.", "2026-08-05T10:00:00Z"),
        ],
    };

    const got = selectBorrowableMemories(ON, BO, [alice]);
    const ids = got.map((e) => e.id).sort();
    eq("N1 all three narrative sources can be borrowed", ids.join(","), "of1,st1,vn1");
    ok("N2 the long-term entry that never names Bo did not cross", !got.some((e) => e.id === "lt1"));
    ok("N3 the narrative beat with nobody else did not cross", !got.some((e) => e.id === "st2"));

    // narrative entries go through the SAME attribution as long-term ones
    eq("N4 narrative summaries are attributed too", borrowedFromName(got.find((e) => e.id === "st1")), "Alice");
    ok("N5 provenance is preserved", got.find((e) => e.id === "st1").metadata.narrativeSource === "story");

    // and the same world scope
    eq("N6 narrative does not cross worlds",
        selectBorrowableMemories(ON, { ...BO, worldId: "w9" }, [alice]).length, 0);

    // and they render with the same secondhand framing
    const rendered = formatLongTermMemories(got);
    ok("N7 rendered under the secondhand heading", rendered.includes("secondhand"));
    ok("N8 the [Event ...] stamp survives into the prompt", /\[Event 2 Aug 20:10\]/.test(rendered));

    // source rules
    const shr = fs2.readFileSync(path.join(root, "lib/memory-sharing.ts"), "utf8");
    const table = shr.slice(shr.indexOf("NARRATIVE_PROJECTION_SOURCES"), shr.indexOf("function loadNarrativeSummaries"));
    ok("N9 story is a source", /loadStoryProjectionEntries/.test(table));
    ok("N10 vn is a source", /loadVnProjectionEntries/.test(table));
    ok("N11 offline chat is a source", /loadChatOfflineProjectionEntries/.test(table));
    // The rule is "already a summary". A raw-transcript projection must never be added here.
    ok("N12 no raw-transcript projection is borrowed",
        !/loadCheckPhoneProjectionEntries|loadXiaohongshuProjectionEntries|loadNoteWallProjectionEntries|loadGameProjectionEntries/.test(shr));
    ok("N13 a failing source is skipped, not fatal", /catch \{/.test(shr.slice(shr.indexOf("function loadNarrativeSummaries"))));
    ok("N14 synthetic entries are never written back", !/saveMemoryEntry/.test(shr));

    // The assertions above drive selectBorrowableMemories with hand-built entries, which
    // proves the SELECTOR handles narrative rows but says nothing about the wrapper actually
    // loading them or the builder shaping them. Both are storage-backed and return [] under
    // Node, so they are asserted at source, each SCOPED to its own function body -- an
    // unscoped match would be satisfied by the function's own definition.
    const fnBody = (name) => {
        const start = shr.indexOf(name);
        if (start < 0) return "";
        const end = shr.indexOf("\n}", start);
        // A missing end anchor would slice to -1, i.e. almost the whole file, and every
        // assertion below would match somewhere and pass vacuously.
        if (end < 0) return "";
        return shr.slice(start, end);
    };
    const wrapper = fnBody("export async function gatherBorrowedMemories");
    ok("N15 the wrapper actually loads narrative summaries",
        wrapper.includes("loadNarrativeSummaries(ownerId)"), wrapper.slice(-220));
    const builder = fnBody("function loadNarrativeSummaries");
    ok("N16 the builder stamps provenance",
        builder.includes("narrativeSource: source.app"), builder.slice(-220));
    ok("N17 the builder walks every declared source",
        builder.includes("for (const source of NARRATIVE_PROJECTION_SOURCES)"), builder.slice(0, 220));
    // Guard the guards: an empty slice would make all three above pass on nothing.
    ok("N18 both function bodies were actually located", wrapper.length > 200 && builder.length > 200,
        `wrapper ${wrapper.length}, builder ${builder.length}`);
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
    // The heading must say it is somebody else's experience and that the bracket names the
    // source. Deliberately ONE short line: it lives inside a data marker, and a long
    // instruction there competes with the output contract.
    ok("D9 heading marks it as not the reader's own experience", /not your own experience/i.test(mixed));
    ok("D9b heading explains the bracket", /brackets/i.test(mixed));
    const headingLine = mixed.split("\n").find((l) => /secondhand/i.test(l)) ?? "";
    ok("D9c heading stays short", headingLine.length < 130, `${headingLine.length} chars`);
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
    ok("E7 a character never borrows from itself", shr.includes("owner.ownerId === viewer.id) continue"));

    // The wrapper enumerates WORLD MATES, not "everyone who has a memory row".
    // getAllCharacterIdsWithMemories() only sees the memory store, so a character with story
    // or VN history but no summarized long-term entry was invisible -- and long-term entries
    // only appear after 80 events, so early on that is everybody. The feature produced nothing.
    ok("E12 candidates come from the world group",
        shr.includes("viewerGroup.memberIds.filter((id) => id !== viewerId)"));
    ok("E13 the memory-store enumerator is no longer used as the candidate source",
        !/await getAllCharacterIdsWithMemories\(\)/.test(shr));
    ok("E14 borrowed rows are capped by count, not only by tokens",
        shr.includes("MAX_BORROWED_ENTRIES") && /slice\(0, MAX_BORROWED_ENTRIES\)/.test(shr));
    ok("E8 stored entries are copied, never mutated", /\.\.\.entry,/.test(shr) && !/entry\.metadata\s*=/.test(shr));
    ok("E9 no CJK literals left in the script-range regex", !/[぀-鿿]/.test(shr));
    ok("E10 no control characters",
        ![...shr].some((c) => { const n = c.charCodeAt(0); return (n < 9 || (n > 13 && n < 32) || n === 127); }));
}

// Guard against the whole file silently skipping a group: the count is pinned, so a group
// that stops running fails loudly instead of shrinking the suite.
// Counted before this guard itself runs, so the total printed below is EXPECTED + 1.
const EXPECTED = 131;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
