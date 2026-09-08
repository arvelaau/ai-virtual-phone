// Rich HTML custom-app cards (boarding-pass/menu-style, triggered by a chat directive) now
// also extract in story and offline mode, not just live chat. Drives the real
// extractCustomAppCard() (lib/rich-message-parser.ts) and its wiring into
// lib/offline-message-dispatch.ts and lib/story-engine.ts.
//
// SCOPE IS PER-CARD, NOT A GLOBAL SETTING (corrected 2026-09-08 after the first version of this
// feature put chat/story/offline availability behind a global Settings toggle -- the user
// clarified that was a misread: which surfaces a card can appear on is a property of the card
// itself, authored in the Studio app, exactly like its HTML or its trigger tag). This fixture
// was rewritten to match: formatCustomAppChatDirectivesForPrompt()/extractCustomAppCard() now
// take a required `mode` argument and filter directives by their own `scope` field
// (directiveMatchesScope() in custom-app-chat-directives.ts) instead of consulting a stored
// setting. lib/app-card-settings.ts now only covers card POSITION (before/after text), which
// really is a global, surface-agnostic preference.
//
//   node _fx-narrative-app-card.mjs

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });

const { kvSet } = jiti(path.join(root, "lib/kv-db.ts"));
const { saveInstalledCustomApps } = jiti(path.join(root, "lib/custom-app-storage.ts"));
const { extractCustomAppCard } = jiti(path.join(root, "lib/rich-message-parser.ts"));
const { extractOfflineDispatchableMessages } = jiti(path.join(root, "lib/offline-message-dispatch.ts"));
const { formatCustomAppChatDirectivesForPrompt, loadCustomAppChatDirectives, directiveMatchesScope } = jiti(path.join(root, "lib/custom-app-chat-directives.ts"));
const { loadStudioCards, saveStudioCard, deleteStudioCard, STUDIO_APP_ID } = jiti(path.join(root, "lib/card-studio-storage.ts"));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${x === undefined ? "" : ` -- ${JSON.stringify(x).slice(0, 300)}`}`); } };
const eq = (n, g, w) => ok(n, Object.is(g, w), { got: g, want: w });

function seedTestApp(syntax, scope) {
    const directive = {
        id: "boarding-pass",
        label: "Show boarding pass",
        syntax,
        description: "Shows a boarding pass card",
        card: {
            appLabel: "Travel Companion",
            title: "Boarding Pass",
            html: "<div class=\"pass\">ATH-JTR 0521</div>",
        },
    };
    if (scope) directive.scope = scope;
    const app = {
        id: "test.travelapp",
        name: "Travel Companion",
        version: "1.0.0",
        entryHtml: "<html><body>test app</body></html>",
        permissions: ["chat.write"],
        manifest: {
            id: "test.travelapp",
            name: "Travel Companion",
            version: "1.0.0",
            entry: "index.html",
            permissions: ["chat.write"],
            extensions: { chat: { directives: [directive] } },
        },
        assets: {},
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveInstalledCustomApps([app], false);
}

function clearApps() {
    kvSet("ai_phone_custom_apps_v1", JSON.stringify([]));
}

function clearStudioCards() {
    kvSet("ai_phone_card_studio_v1", JSON.stringify([]));
}

// ── A. the app-card extraction itself ────────────────────────────────────────
{
    seedTestApp("[BoardingPass]");
    const found = extractCustomAppCard("She hands you the tickets.\n[BoardingPass]\nSee you at the gate.", "chat");
    ok("A1 a directive-triggered card is found", Boolean(found), found);
    eq("A2 the app id is carried", found?.appId, "test.travelapp");
    ok("A3 the card's html reaches appCardLayout", found?.appCardLayout?.html?.includes("ATH-JTR 0521"), found?.appCardLayout);
    eq("A4 matchIndex points at the tag", "She hands you the tickets.\n[BoardingPass]\nSee you at the gate.".slice(found?.matchIndex, found?.matchIndex + found?.matchLength), "[BoardingPass]");

    const none = extractCustomAppCard("Just ordinary prose, no directive here.", "chat");
    eq("A5 no match when there is no directive", none, null);
}

// ── A-scope. scope is a property of the CARD, checked per mode, not a global setting ────────
{
    // A card explicitly scoped to "story" only.
    seedTestApp("[BoardingPass]", ["story"]);
    ok("AS1 extracts in story mode", Boolean(extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "story")));
    eq("AS2 does NOT extract in chat mode", extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "chat"), null);
    eq("AS3 does NOT extract in offline mode", extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "offline"), null);

    // A card scoped to two of the three.
    seedTestApp("[BoardingPass]", ["chat", "offline"]);
    ok("AS4 extracts in chat mode", Boolean(extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "chat")));
    ok("AS5 extracts in offline mode", Boolean(extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "offline")));
    eq("AS6 does NOT extract in story mode", extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "story"), null);

    // An unscoped (undefined) card is unrestricted -- matches every mode, same as before scope existed.
    seedTestApp("[BoardingPass]");
    ok("AS7 unscoped extracts in chat", Boolean(extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "chat")));
    ok("AS8 unscoped extracts in story", Boolean(extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "story")));
    ok("AS9 unscoped extracts in offline", Boolean(extractCustomAppCard("Text.\n[BoardingPass]\nMore.", "offline")));

    // directiveMatchesScope() itself, the shared predicate everything above is built on.
    eq("AS10 empty scope array is treated as unrestricted", directiveMatchesScope({ scope: [] }, "chat"), true);
    eq("AS11 a scope not containing the mode is rejected", directiveMatchesScope({ scope: ["story"] }, "chat"), false);
    eq("AS12 a scope containing the mode matches", directiveMatchesScope({ scope: ["story", "chat"] }, "chat"), true);
}

// ── B. wired into offline mode ───────────────────────────────────────────────
{
    seedTestApp("[BoardingPass]");
    const raw = `<content>
She hands you the tickets at the gate.
[BoardingPass]
</content>
<summary>
She handed over the boarding passes.
</summary>`;
    const result = extractOfflineDispatchableMessages(raw, "summary");
    ok("B1 the app card is extracted alongside the offline parse", Boolean(result.appCard));
    eq("B2 the app id is carried through", result.appCard?.appId, "test.travelapp");
    ok("B3 the directive tag is stripped from the parsed content", !result.parsed.content.includes("[BoardingPass]"), result.parsed.content);
    ok("B4 the surrounding narration survives", result.parsed.content.includes("She hands you the tickets"));
    ok("B5 the summary still extracts", result.parsed.summary.includes("She handed over"));

    // a turn with neither [Message] nor a directive: appCard is null, nothing breaks
    const plain = extractOfflineDispatchableMessages("<content>\nAn ordinary evening.\n</content>\n<summary>\ns\n</summary>", "summary");
    eq("B6 no directive present -> appCard is null", plain.appCard, null);

    // [Message] and an app-card directive in the SAME turn -- must not collide
    const both = extractOfflineDispatchableMessages(
        `<content>\nShe hands you the tickets.\n[BoardingPass]\n</content>\n<summary>\ns\n</summary>\n[Message]\nsee you there\n[/Message]`,
        "summary");
    eq("B7 both extractions succeed in the same turn", both.dispatchable.length === 1 && Boolean(both.appCard), true, both);
    eq("B8 the message content is unaffected by the card extraction", both.dispatchable[0]?.content.trim(), "see you there");

    // Offline respects per-card scope too: a card scoped to "story" only never shows up here.
    seedTestApp("[BoardingPass]", ["story"]);
    const scoped = extractOfflineDispatchableMessages(raw, "summary");
    eq("B9 a story-only card does not extract in offline mode", scoped.appCard, null);
}

// ── C. wired into story mode (source-level, since generateStoryCompletion needs a live LLM) ──
{
    const eng = fs.readFileSync(path.join(root, "lib/story-engine.ts"), "utf8");
    const start = eng.indexOf("export async function generateStoryCompletion");
    const end = eng.indexOf("\n}", start);
    const body = start >= 0 && end > start ? eng.slice(start, end) : "";
    ok("C1 generateStoryCompletion was located", start >= 0 && end > start);
    ok("C2 it extracts a custom-app card scoped to story mode",
        body.includes('extractCustomAppCard(cleanText, "story")'));
    ok("C3 the card is scanned AFTER [Message] extraction, on cleanText not rawOutput",
        body.indexOf('extractCustomAppCard(cleanText, "story")') > body.indexOf("parseActionTags(rawOutput)"));
    ok("C4 the story parser receives the card-stripped text", body.includes("parseStoryResponse(textForStoryParser,"));
    ok("C5 the result carries the card fields through", body.includes("appId: appCard?.appId") && body.includes("appCardLayout: appCard?.appCardLayout"));
    ok("C5b no leftover reference to the old global scope setting", !body.includes("isAppCardSurfaceEnabled"));

    ok("C6 StoryMessage carries the card fields",
        fs.readFileSync(path.join(root, "lib/story-storage.ts"), "utf8").includes("appCardLayout?: Record<string, unknown>"));
    const storyApp = fs.readFileSync(path.join(root, "components/story/story-app-base.tsx"), "utf8");
    ok("C7 both call sites pass the card fields to pushStoryMessage",
        (storyApp.match(/appCardLayout: result\.appCardLayout/g) || []).length === 2,
        (storyApp.match(/appCardLayout: result\.appCardLayout/g) || []).length);

    // The parser being ready is not enough -- the model has to be TAUGHT a directive exists,
    // or it will never spontaneously write one. Chat and offline get this for free
    // (buildChatPromptMessages always computes it); story builds its own prompt payload and
    // was missing it entirely until this check existed.
    const buildFnStart = eng.indexOf("async function buildStoryPromptMessages");
    const buildFnEnd = eng.indexOf("\n}", buildFnStart);
    const buildFnBody = buildFnStart >= 0 && buildFnEnd > buildFnStart ? eng.slice(buildFnStart, buildFnEnd) : "";
    ok("C8 buildStoryPromptMessages was located", buildFnStart >= 0 && buildFnEnd > buildFnStart);
    ok("C9 it teaches only story-scoped directives via formatCustomAppChatDirectivesForPrompt(\"story\")",
        buildFnBody.includes('customAppRichMediaDirectives: formatCustomAppChatDirectivesForPrompt("story")'));
    ok("C9b no leftover reference to the old global scope setting", !buildFnBody.includes("isAppCardSurfaceEnabled"));

    const preset = fs.readFileSync(path.join(root, "lib/builtin-preset.ts"), "utf8");
    const presetStart = preset.indexOf('identifier: "story_output_format",\n                name:');
    const presetEnd = preset.indexOf('].join("\\n")', presetStart);
    const presetEntry = presetStart >= 0 && presetEnd > presetStart ? preset.slice(presetStart, presetEnd) : "";
    ok("C10 the story_output_format entry references the macro",
        presetEntry.includes("{{customAppRichMediaDirectives}}"));
    ok("C11 the entry no longer claims [Message] is the ONLY chat directive story mode may use",
        !presetEntry.includes("is the ONLY chat directive story mode may use, and it is the exception"));
    const v2 = preset.match(/BUILTIN_PRESET_VERSION = (\d+)/);
    ok("C12 the version was bumped past 281", v2 && Number(v2[1]) >= 282, v2 && v2[1]);
}

// ── D. the teaching text itself, end to end ──────────────────────────────────
{
    seedTestApp("[BoardingPass:destination]");
    const taught = formatCustomAppChatDirectivesForPrompt("chat");
    ok("D1 the directive's label becomes a heading", taught.includes("### Show boarding pass"));
    ok("D2 the exact syntax is taught", taught.includes("【Format】[BoardingPass:destination]"));
    ok("D3 the directive's own description is taught, not a generic fallback",
        taught.includes("【Rule】Shows a boarding pass card"));

    // group chat needs the [CharacterName]: prefix on the taught format
    const taughtGroup = formatCustomAppChatDirectivesForPrompt("chat", { group: true });
    ok("D4 the group variant prefixes the format with the speaker name",
        taughtGroup.includes("【Format】[CharacterName]: [BoardingPass:destination]"));

    // no installed apps -> nothing taught, and nothing breaks
    clearApps();
    eq("D5 no installed directives -> empty string", formatCustomAppChatDirectivesForPrompt("chat"), "");

    // a directive scoped to "story" only is taught for story, but not for chat or offline
    seedTestApp("[BoardingPass:destination]", ["story"]);
    ok("D6 taught in story mode", formatCustomAppChatDirectivesForPrompt("story").includes("### Show boarding pass"));
    eq("D7 NOT taught in chat mode", formatCustomAppChatDirectivesForPrompt("chat"), "");
    eq("D8 NOT taught in offline mode", formatCustomAppChatDirectivesForPrompt("offline"), "");
}

// ── E. Studio cards merge into the same directive list, at read time only ───
{
    clearApps();
    clearStudioCards();
    seedTestApp("[BoardingPass]");
    const menu = saveStudioCard({
        name: "Cafe Menu",
        syntax: "[Menu]",
        description: "Use this when they sit down at a cafe together.",
        html: "<div class=\"menu\">Flat white, croissant</div>",
        accentColor: "#d98f9b",
        height: 240,
    });
    ok("E1 saveStudioCard returns the created card", Boolean(menu) && menu.id);

    const directives = loadCustomAppChatDirectives();
    const real = directives.find(d => d.appId === "test.travelapp");
    const studio = directives.find(d => d.appId === STUDIO_APP_ID);
    ok("E2 the real installed app's directive is still present", Boolean(real));
    ok("E3 the Studio card also surfaces as a directive", Boolean(studio));
    eq("E4 the Studio directive's label is the card's name", studio?.label, "Cafe Menu");

    const taught = formatCustomAppChatDirectivesForPrompt("chat");
    ok("E5 both directives are taught in the same prompt block",
        taught.includes("### Show boarding pass") && taught.includes("### Cafe Menu"));
    ok("E6 the Studio card's own instruction is taught verbatim",
        taught.includes("【Rule】Use this when they sit down at a cafe together."));

    // A directive-triggered card in narrative text resolves to the Studio stub id, exactly
    // the way a real installed app's directive resolves to that app's id -- this is what lets
    // story/offline's click handler tell "show a popup" apart from "open a real app".
    const found = extractCustomAppCard("They sit down.\n[Menu]\nShe orders for both of them.", "chat");
    ok("E7 a Studio-triggered card extracts with the STUDIO_APP_ID stub", found?.appId === STUDIO_APP_ID, found);
    ok("E8 the card's own html reaches appCardLayout", found?.appCardLayout?.html?.includes("Flat white"), found?.appCardLayout);

    // Collision: a real app keeps first claim on a syntax head a Studio card also uses.
    clearStudioCards();
    saveStudioCard({ name: "Boarding Pass Clone", syntax: "[BoardingPass]", description: "d", html: "<div>clone</div>" });
    const afterCollision = loadCustomAppChatDirectives().filter(d => d.syntax === "[BoardingPass]" || d.syntax.startsWith("[BoardingPass"));
    eq("E9a exactly one directive claims the [BoardingPass] syntax head", afterCollision.length, 1, afterCollision);
    eq("E9b the real app's directive wins the collision, not the Studio card", afterCollision[0]?.appId, "test.travelapp");

    // Update path: saving with an existing id replaces in place, never duplicates.
    clearStudioCards();
    const created = saveStudioCard({ name: "Receipt", syntax: "[Receipt]", description: "d1", html: "<div>v1</div>" });
    const updated = saveStudioCard({ name: "Receipt", syntax: "[Receipt]", description: "d2", html: "<div>v2</div>" }, created.id);
    eq("E10 updating a card keeps the same id", updated?.id, created.id);
    eq("E11 exactly one card remains after an update", loadStudioCards().length, 1);
    ok("E12 the update actually changed the stored html", loadStudioCards()[0]?.html.includes("v2"));

    // Deleting a nonexistent id is a no-op, not a silent corruption of the real list.
    eq("E13 deleting an unknown id returns false", deleteStudioCard("does-not-exist"), false);
    eq("E14 the real card survives that no-op", loadStudioCards().length, 1);
    ok("E15 deleting the real id works", deleteStudioCard(created.id));
    eq("E16 the list is empty afterward", loadStudioCards().length, 0);

    // Whitespace hygiene: HTML is whitespace-sensitive, so cleanHtml must never collapse
    // multi-word content the way an earlier, differently-scoped cleaner in this codebase did
    // (see CLAUDE.md's recurring "blanket \s+ strip" trap).
    const spaced = saveStudioCard({ name: "Spacing Check", syntax: "[SpacingCheck]", description: "d", html: "<div>Blue Ceramic Mug</div>" });
    ok("E17 multi-word HTML content survives cleanHtml unmangled", spaced?.html.includes("Blue Ceramic Mug"), spaced?.html);
    deleteStudioCard(spaced.id);

    // Scope round-trips through Studio storage exactly like every other field.
    clearStudioCards();
    const scopedCard = saveStudioCard({ name: "Story Only", syntax: "[StoryOnly]", description: "d", html: "<div>s</div>", scope: ["story"] });
    eq("E18 a card's scope is stored", JSON.stringify(scopedCard?.scope), JSON.stringify(["story"]));
    ok("E19 it is taught for story", formatCustomAppChatDirectivesForPrompt("story").includes("### Story Only"));
    ok("E20 it is NOT taught for chat", !formatCustomAppChatDirectivesForPrompt("chat").includes("### Story Only"));
    // saving all three modes checked is stored as unrestricted (undefined), not a 3-item array
    const unrestricted = saveStudioCard({ name: "Story Only", syntax: "[StoryOnly]", description: "d", html: "<div>s</div>", scope: ["chat", "story", "offline"] }, scopedCard.id);
    eq("E21 checking every mode normalizes back to unrestricted (undefined)", unrestricted?.scope, undefined);
    deleteStudioCard(scopedCard.id);
}

// ── F. app-card POSITION setting only -- scope is per-card, not read from here ──────────────
{
    const { appCardPositionBeforeTextFor } = jiti(path.join(root, "lib/app-card-settings.ts"));

    eq("F1 position defaults to after-text", appCardPositionBeforeTextFor({}), false);
    eq("F2 position can be flipped to before-text", appCardPositionBeforeTextFor({ appCardPositionBeforeText: true }), true);

    // The old global scope toggles are gone from the settings type/storage/UI -- not just
    // unused, actually removed, so nobody mistakes a stale field for the real mechanism.
    const chatStorage = fs.readFileSync(path.join(root, "lib/chat-storage.ts"), "utf8");
    ok("F3 ChatAppSettings no longer declares appCardScopeChat/Story/Offline",
        !chatStorage.includes("appCardScopeChat") && !chatStorage.includes("appCardScopeStory") && !chatStorage.includes("appCardScopeOffline"));
    ok("F4 ChatAppSettings still declares the position field", chatStorage.includes("appCardPositionBeforeText"));

    const appCardSettings = fs.readFileSync(path.join(root, "lib/app-card-settings.ts"), "utf8");
    ok("F5 app-card-settings.ts no longer exports a scope function", !appCardSettings.includes("isAppCardSurfaceEnabled"));

    // Wiring: no engine file reads a global scope setting any more -- each just passes a mode
    // straight through to formatCustomAppChatDirectivesForPrompt()/extractCustomAppCard().
    const chatEng = fs.readFileSync(path.join(root, "lib/chat-engine.ts"), "utf8");
    ok("F6 chat-engine.ts no longer imports isAppCardSurfaceEnabled", !chatEng.includes("isAppCardSurfaceEnabled"));
    ok("F7 chat-engine.ts passes the mode straight through",
        chatEng.includes('formatCustomAppChatDirectivesForPrompt(isOfflineMode ? "offline" : "chat")'));

    const groupEng = fs.readFileSync(path.join(root, "lib/group-chat-engine.ts"), "utf8");
    ok("F8 group-chat-engine.ts no longer imports isAppCardSurfaceEnabled", !groupEng.includes("isAppCardSurfaceEnabled"));
    ok("F9 group-chat-engine.ts passes the mode straight through",
        groupEng.includes('formatCustomAppChatDirectivesForPrompt(isOfflineMode ? "offline" : "chat", { group: true })'));

    const offlineDispatch = fs.readFileSync(path.join(root, "lib/offline-message-dispatch.ts"), "utf8");
    ok("F10 offline-message-dispatch.ts no longer imports isAppCardSurfaceEnabled", !offlineDispatch.includes("isAppCardSurfaceEnabled"));
    ok("F11 offline-message-dispatch.ts passes \"offline\" straight through",
        offlineDispatch.includes('extractCustomAppCard(afterActions, "offline")'));

    // Position wiring is unaffected by the scope correction -- still global, still read the
    // same way in both narrative renderers.
    const storyApp = fs.readFileSync(path.join(root, "components/story/story-app-base.tsx"), "utf8");
    ok("F12 story-app-base.tsx reads the position setting", storyApp.includes("appCardRendersBeforeText()"));
    ok("F13 story-app-base.tsx renders the card before OR after text depending on it",
        storyApp.includes("{appCardBeforeText ? appCardNode : null}") && storyApp.includes("{appCardBeforeText ? null : appCardNode}"));

    const chatRoom = fs.readFileSync(path.join(root, "components/chat/chat-room.tsx"), "utf8");
    ok("F14 chat-room.tsx's offline turn renderer reads the position setting", chatRoom.includes("appCardRendersBeforeText()"));
    ok("F15 chat-room.tsx renders the offline card before OR after text depending on it",
        chatRoom.includes("{offlineCardBeforeText ? offlineAppCardNode : null}") && chatRoom.includes("{offlineCardBeforeText ? null : offlineAppCardNode}"));

    const settingsUi = fs.readFileSync(path.join(root, "components/phone-settings-app.tsx"), "utf8");
    ok("F16 the settings UI still wires the position toggle to storage", settingsUi.includes("appCardPositionBeforeText: next"));
    ok("F17 the settings UI no longer has the 3 removed scope toggles",
        !settingsUi.includes("appCardScopeChat") && !settingsUi.includes("appCardScopeStory") && !settingsUi.includes("appCardScopeOffline"));

    // Studio is where scope actually lives now.
    const studioApp = fs.readFileSync(path.join(root, "components/studio/studio-app.tsx"), "utf8");
    ok("F18 the Studio editor has a scope picker", studioApp.includes("toggleScope") && studioApp.includes("ALL_SCOPE_MODES"));

    const cardStorage = fs.readFileSync(path.join(root, "lib/card-studio-storage.ts"), "utf8");
    ok("F19 card-studio-storage.ts normalizes/persists scope", cardStorage.includes("normalizeScope") && cardStorage.includes("scope: normalizeScope"));

    const directives = fs.readFileSync(path.join(root, "lib/custom-app-chat-directives.ts"), "utf8");
    ok("F20 custom-app-chat-directives.ts exports the shared scope predicate", directives.includes("export function directiveMatchesScope"));
}

clearApps();
clearStudioCards();

const EXPECTED = 90;
ok(`Z1 ${EXPECTED} assertions ran before this guard`, pass + fail === EXPECTED, `ran ${pass + fail}`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
