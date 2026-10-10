// Fixture for the momo.float.phone sync, Image Generation Stage 1 (types + storage +
// binding-cascade fix). Drives the real lib/settings-storage.ts, lib/image-generation-binding.ts
// and lib/novelai-image-config.ts via jiti.
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; results.push({ name, extra }); }
}

const settingsStorage = await jiti.import("./lib/settings-storage.ts");
const binding = await jiti.import("./lib/image-generation-binding.ts");
const naiConfig = await jiti.import("./lib/novelai-image-config.ts");

// ── A. Legacy single-config -> multi-preset migration ──
{
    // A user who only ever had the OLD single-config shape (no openaiPresets/novelai at all)
    // must get exactly one migrated preset carrying their old values, and it must be selected.
    const legacy = {
        enabled: true,
        requestMode: "direct",
        apiKey: "sk-legacy-key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-image-1",
        size: "512x512",
        quality: "high",
        extraPrompt: "legacy extra prompt",
        characterReferences: {},
        imageHosting: { provider: "none", imgbbApiKey: "", defaultExpirationSeconds: 0, maxUploadBytes: 900 * 1024, autoConvertToWebp: true, allowMascotUpload: false },
    };
    settingsStorage.saveImageGenerationSettings(legacy);
    const loaded = settingsStorage.loadImageGenerationSettings();
    check("A1 migration produces exactly one OpenAI preset", Array.isArray(loaded.openaiPresets) && loaded.openaiPresets.length === 1);
    check("A2 the migrated preset carries the old apiKey", loaded.openaiPresets[0].apiKey === "sk-legacy-key");
    check("A3 the migrated preset carries the old model/size/quality/extraPrompt", loaded.openaiPresets[0].model === "gpt-image-1" && loaded.openaiPresets[0].size === "512x512" && loaded.openaiPresets[0].quality === "high" && loaded.openaiPresets[0].extraPrompt === "legacy extra prompt");
    check("A4 the migrated preset is the active one", loaded.activeOpenAiPresetId === loaded.openaiPresets[0].id);
    check("A5 top-level legacy fields mirror the active preset (back-compat readers still work)", loaded.apiKey === "sk-legacy-key" && loaded.model === "gpt-image-1");
    check("A6 a default NovelAI preset exists even though the user never touched NovelAI", Array.isArray(loaded.novelai?.presets) && loaded.novelai.presets.length === 1);
    check("A7 default NovelAI preset uses the shared novelai-image-config defaults", loaded.novelai.presets[0].model === naiConfig.NOVELAI_DEFAULT_MODEL);
}

// ── B. Multi-preset settings round-trip (already-migrated shape) ──
{
    const multi = {
        enabled: true,
        provider: "novelai",
        requestMode: "direct",
        apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "",
        openaiPresets: [
            { id: "p1", name: "Preset One", requestMode: "direct", apiKey: "k1", baseUrl: "https://a", model: "m1", size: "512x512", quality: "auto", extraPrompt: "" },
            { id: "p2", name: "Preset Two", requestMode: "server", apiKey: "k2", baseUrl: "https://b", model: "m2", size: "1024x1024", quality: "hd", extraPrompt: "extra" },
        ],
        activeOpenAiPresetId: "p2",
        novelai: {
            apiKey: "nai-key",
            requestMode: "direct",
            activePresetId: "n1",
            presets: [{ id: "n1", name: "My Anime", model: naiConfig.NOVELAI_DEFAULT_MODEL, resolution: "1024x1024", steps: 28, scale: 6, sampler: "k_euler", noiseSchedule: "karras", positivePrompt: "p", negativePrompt: "n", qualityToggle: true, smea: false, smeaDyn: false }],
        },
        characterReferences: {},
        imageHosting: { provider: "none", imgbbApiKey: "", defaultExpirationSeconds: 0, maxUploadBytes: 900 * 1024, autoConvertToWebp: true, allowMascotUpload: false },
    };
    settingsStorage.saveImageGenerationSettings(multi);
    const loaded = settingsStorage.loadImageGenerationSettings();
    check("B1 both OpenAI presets survive the round trip", loaded.openaiPresets.length === 2);
    check("B2 the active preset (p2) is preserved", loaded.activeOpenAiPresetId === "p2");
    check("B3 top-level legacy fields mirror the ACTIVE preset (p2), not the first one", loaded.model === "m2" && loaded.quality === "hd");
    check("B4 the NovelAI preset survives", loaded.novelai.presets.length === 1 && loaded.novelai.presets[0].id === "n1");
    check("B5 provider stays novelai", loaded.provider === "novelai");
}

// ── C. Image-generation binding: option listing + applying a binding ──
{
    const settings = settingsStorage.loadImageGenerationSettings(); // the Stage-B multi-preset settings
    const options = binding.getImageGenerationBindingOptions(settings);
    check("C1 binding options list both OpenAI presets and the NovelAI preset", options.length === 3);
    check("C2 OpenAI options are prefixed openai:", options.filter(o => o.provider === "openai").every(o => o.id.startsWith("openai:")));
    check("C3 NovelAI options are prefixed novelai:", options.filter(o => o.provider === "novelai").every(o => o.id.startsWith("novelai:")));

    const applied = binding.applyImageGenerationBinding(settings, "openai:p1");
    check("C4 applying an openai: binding switches provider to openai", applied.provider === "openai");
    check("C5 applying an openai: binding pulls that preset's own apiKey/model", applied.apiKey === "k1" && applied.model === "m1");

    const appliedNai = binding.applyImageGenerationBinding(settings, "novelai:n1");
    check("C6 applying a novelai: binding switches provider to novelai", appliedNai.provider === "novelai");
    check("C7 applying a binding that doesn't exist is a harmless no-op", binding.applyImageGenerationBinding(settings, "openai:does-not-exist") === settings);
}

// ── D. resolveBinding cascade order fix: app-default applies even with no character ──
{
    const config = {
        globalDefaults: { apiConfigId: "global-api", imageConfigId: "global-image", voiceConfigId: "global-voice" },
        characterBindings: [
            { characterId: "char1", defaults: { apiConfigId: "char1-api", voiceConfigId: "char1-voice" }, appOverrides: { chat: { apiConfigId: "char1-chat-override" } } },
        ],
        appDefaults: { chat: { apiConfigId: "app-chat-api", imageConfigId: "app-chat-image", voiceConfigId: "app-chat-voice" } },
    };

    // No character at all (e.g. group chat) -- app default MUST still apply. This is the exact
    // bug momo fixed: the old code returned pure global defaults whenever characterId was unset.
    const noChar = settingsStorage.resolveBinding(config, undefined, "chat");
    check("D1 app default's apiConfigId applies with no character", noChar.apiConfigId === "app-chat-api");
    check("D2 app default's imageConfigId applies with no character", noChar.imageConfigId === "app-chat-image");

    // App-level default must NOT carry voiceConfigId (deliberately excluded at that layer).
    check("D3 app-level default does NOT apply voiceConfigId (global voice survives instead)", noChar.voiceConfigId === "global-voice");

    // Character + a DIFFERENT app (no app-override registered for it): isolates character-default
    // beating the app-chat-only default, without the char-app-override layer also firing.
    const charNoOverrideApp = settingsStorage.resolveBinding(config, "char1", "other_app");
    check("D4 character default's apiConfigId beats an app default with no matching override", charNoOverrideApp.apiConfigId === "char1-api");

    // With a character and no app override: character defaults apply on top of the app default.
    const withChar = settingsStorage.resolveBinding(config, "char1", "chat");
    check("D5 character default's voiceConfigId DOES apply (voice is char-level only)", withChar.voiceConfigId === "char1-voice");

    // Character's own app override is the most precise layer and wins over everything else.
    check("D6 character's app override is the final, most precise layer", withChar.apiConfigId === "char1-chat-override");
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
