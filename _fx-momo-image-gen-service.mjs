// Fixture for the momo.float.phone sync, Image Generation Stage 2 (service layer). Drives the
// real generateImageFromConfiguredApi/hasCharacterReferenceImage from lib/image-generation-service.ts
// via jiti, with global.fetch mocked so the branching/binding/prompt-building logic can be
// exercised without a live network call.
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
    alias: {
        "@": __dirname,
        dexie: path.join(__dirname, "_fx-dexie-stub.mjs"),
        "./theme-storage": path.join(__dirname, "_fx-theme-storage-stub.mjs"),
    },
});

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; results.push({ name, extra }); }
}

const settingsStorage = await jiti.import("./lib/settings-storage.ts");
const chatAssetStorage = await jiti.import("./lib/chat-asset-storage.ts");
const service = await jiti.import("./lib/image-generation-service.ts");

// ── Fetch mock: records every call and returns a canned image/png-ish JSON response. ──
let fetchCalls = [];
function fakeJsonResponse(body) {
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}
function fakeBinaryResponse(bytes, contentType = "image/png") {
    return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
        arrayBuffer: async () => bytes.buffer,
        text: async () => "",
    };
}
globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("image.novelai.net")) {
        // A tiny non-zip binary body -> exercises the plain-binary fallback path.
        return fakeBinaryResponse(new Uint8Array([1, 2, 3, 4]));
    }
    return fakeJsonResponse({ data: [{ b64_json: "QUFBQQ==" }] });
};

// Minimal FormData/Blob polyfIll check (Node 18+ has both globally) -- just confirm they exist,
// since the reference-image path depends on them.
check("ENV FormData and Blob are available in this Node runtime", typeof FormData === "function" && typeof Blob === "function");

// ── A. Disabled / missing-field short circuits ──
{
    const disabled = { enabled: false, provider: "openai", requestMode: "direct", apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "", openaiPresets: [], characterReferences: {} };
    check("A1 disabled settings returns null", await service.generateImageFromConfiguredApi({ description: "a cat", settings: disabled }) === null);

    const enabledNoDesc = { enabled: true, provider: "openai", requestMode: "direct", apiKey: "k", baseUrl: "https://a", model: "m", size: "", quality: "", extraPrompt: "", openaiPresets: [], characterReferences: {} };
    check("A2 empty description returns null", await service.generateImageFromConfiguredApi({ description: "   ", settings: enabledNoDesc }) === null);

    const noKey = { enabled: true, provider: "openai", requestMode: "direct", apiKey: "", baseUrl: "https://a", model: "m", size: "", quality: "", extraPrompt: "", openaiPresets: [{ id: "p", name: "P", requestMode: "direct", apiKey: "", baseUrl: "https://a", model: "m", size: "", quality: "", extraPrompt: "" }], activeOpenAiPresetId: "p", characterReferences: {} };
    check("A3 OpenAI preset missing apiKey returns null", await service.generateImageFromConfiguredApi({ description: "a cat", settings: noKey }) === null);
}

// ── B. NovelAI branch: missing key short-circuits; prompt is built from preset + character feature + description ──
{
    fetchCalls = [];
    const naiNoKey = { enabled: true, provider: "novelai", requestMode: "direct", apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "", openaiPresets: [], characterReferences: {}, novelai: { apiKey: "", requestMode: "direct", activePresetId: "n1", presets: [{ id: "n1", name: "P", model: "nai-diffusion-3", resolution: "1024x1024", steps: 28, scale: 6, sampler: "k_euler", noiseSchedule: "karras", positivePrompt: "masterpiece", negativePrompt: "", qualityToggle: true, smea: false, smeaDyn: false }] } };
    check("B1 NovelAI provider with no apiKey returns null, no fetch performed", await service.generateImageFromConfiguredApi({ description: "a cat", settings: naiNoKey }) === null && fetchCalls.length === 0);

    fetchCalls = [];
    const naiSettings = {
        enabled: true, provider: "novelai", requestMode: "direct", apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "", openaiPresets: [],
        characterReferences: { char1: { assetId: "asset1", featurePrompt: "long silver hair", novelAiFeaturePromptEnabled: true } },
        novelai: { apiKey: "nai-key", requestMode: "direct", activePresetId: "n1", presets: [{ id: "n1", name: "P", model: "nai-diffusion-3", resolution: "1024x1024", steps: 28, scale: 6, sampler: "k_euler", noiseSchedule: "karras", positivePrompt: "masterpiece", negativePrompt: "", qualityToggle: true, smea: false, smeaDyn: false }] },
    };
    const naiResult = await service.generateImageFromConfiguredApi({ description: "standing in the rain", characterId: "char1", settings: naiSettings });
    check("B2 NovelAI branch returns a result", naiResult !== null && !!naiResult?.mediaRef);
    check("B3 NovelAI branch hit the NovelAI endpoint, not an OpenAI one", fetchCalls.length === 1 && fetchCalls[0].url.includes("image.novelai.net"));
    const naiBody = fetchCalls.length ? JSON.parse(fetchCalls[0].init.body) : {};
    check("B4 NovelAI prompt joins preset positivePrompt + character feature prompt + description, in that order", naiBody.input === "masterpiece, long silver hair, standing in the rain");
    check("B5 NovelAI request carries the Authorization header with the NovelAI key", fetchCalls[0].init.headers.Authorization === "Bearer nai-key");
    check("B6 the returned prompt on the result matches what was actually sent", naiResult.prompt === naiBody.input);

    // novelAiFeaturePromptEnabled: false must suppress the character feature prompt for NovelAI specifically.
    fetchCalls = [];
    const naiSettingsDisabledFeature = {
        ...naiSettings,
        characterReferences: { char1: { assetId: "asset1", featurePrompt: "long silver hair", novelAiFeaturePromptEnabled: false } },
    };
    await service.generateImageFromConfiguredApi({ description: "standing in the rain", characterId: "char1", settings: naiSettingsDisabledFeature });
    const naiBody2 = fetchCalls.length ? JSON.parse(fetchCalls[0].init.body) : {};
    check("B7 novelAiFeaturePromptEnabled:false suppresses the character feature prompt for NovelAI", naiBody2.input === "masterpiece, standing in the rain");
}

// ── C. OpenAI branch: active preset selection, character feature-prompt injection ──
{
    fetchCalls = [];
    const settings = {
        enabled: true, provider: "openai", requestMode: "direct",
        apiKey: "top-level-should-be-ignored", baseUrl: "https://top-level", model: "top-level", size: "", quality: "", extraPrompt: "",
        openaiPresets: [
            { id: "p1", name: "One", requestMode: "direct", apiKey: "k1", baseUrl: "https://a.example", model: "m1", size: "512x512", quality: "auto", extraPrompt: "" },
            { id: "p2", name: "Two", requestMode: "direct", apiKey: "k2", baseUrl: "https://b.example", model: "m2", size: "1024x1024", quality: "hd", extraPrompt: "" },
        ],
        activeOpenAiPresetId: "p2",
        characterReferences: {},
    };
    await service.generateImageFromConfiguredApi({ description: "a lighthouse", settings });
    check("C1 the ACTIVE openai preset (p2) is used, not the first one, and not the stale top-level fields", fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://b.example"));
    const c1Body = JSON.parse(fetchCalls[0].init.body);
    check("C2 the active preset's model/size/quality are used", c1Body.model === "m2" && c1Body.size === "1024x1024" && c1Body.quality === "hd");
    check("C3 the active preset's apiKey is used in the Authorization header", fetchCalls[0].init.headers.Authorization === "Bearer k2");

    // Character feature-prompt injection into the description.
    fetchCalls = [];
    const settingsWithChar = {
        ...settings,
        characterReferences: { char1: { featurePrompt: "wears a red scarf" } },
    };
    await service.generateImageFromConfiguredApi({ description: "walking in the snow", characterId: "char1", settings: settingsWithChar });
    const c4Body = JSON.parse(fetchCalls[0].init.body);
    check("C4 character featurePrompt is injected into the prompt with the fixed-appearance marker", c4Body.prompt.includes("walking in the snow") && c4Body.prompt.includes("[Character's fixed appearance] wears a red scarf"));

    // No character feature prompt -> the marker text must not appear at all.
    fetchCalls = [];
    await service.generateImageFromConfiguredApi({ description: "walking in the snow", settings });
    const c5Body = JSON.parse(fetchCalls[0].init.body);
    check("C5 no character reference -> no fixed-appearance marker in the prompt", !c5Body.prompt.includes("[Character's fixed appearance]") && c5Body.prompt === "walking in the snow");
}

// ── D. Reference-image gating: enabled:false must suppress the reference even if useReferenceImage+assetId are set ──
{
    // Seed a real chat-image asset in IndexedDB (chat-asset-storage) so getChatImageFromIndexedDB
    // has something real to return, using a 1x1 PNG so the code path is fully exercised.
    const tinyPngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const tinyPngBlob = new Blob([Buffer.from(tinyPngB64, "base64")], { type: "image/png" });
    const assetRefId = await chatAssetStorage.saveChatImageToIndexedDB(tinyPngBlob);

    const baseSettings = {
        enabled: true, provider: "openai", requestMode: "direct",
        apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "",
        openaiPresets: [{ id: "p1", name: "One", requestMode: "direct", apiKey: "k1", baseUrl: "https://ref.example", model: "m1", size: "", quality: "", extraPrompt: "" }],
        activeOpenAiPresetId: "p1",
        characterReferences: { char1: { assetId: assetRefId, enabled: true, featurePrompt: "" } },
    };

    fetchCalls = [];
    await service.generateImageFromConfiguredApi({ description: "a portrait", characterId: "char1", useReferenceImage: true, settings: baseSettings });
    check("D1 reference.enabled:true + useReferenceImage + assetId -> hits the /edits endpoint (FormData path)", fetchCalls.length === 1 && fetchCalls[0].url.endsWith("/edits"));

    fetchCalls = [];
    const disabledRefSettings = { ...baseSettings, characterReferences: { char1: { assetId: assetRefId, enabled: false, featurePrompt: "" } } };
    await service.generateImageFromConfiguredApi({ description: "a portrait", characterId: "char1", useReferenceImage: true, settings: disabledRefSettings });
    check("D2 reference.enabled:false suppresses the reference even though useReferenceImage+assetId are both set -> falls back to /generations", fetchCalls.length === 1 && fetchCalls[0].url.endsWith("/generations"));

    fetchCalls = [];
    await service.generateImageFromConfiguredApi({ description: "a portrait", characterId: "char1", useReferenceImage: false, settings: baseSettings });
    check("D3 useReferenceImage:false suppresses the reference even though it's enabled and has an assetId", fetchCalls.length === 1 && fetchCalls[0].url.endsWith("/generations"));
}

// ── E. Binding resolution: when params.settings is OMITTED, the appId/characterId binding is applied ──
{
    const stored = {
        enabled: true, provider: "openai", requestMode: "direct",
        apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "",
        openaiPresets: [
            { id: "global-preset", name: "Global", requestMode: "direct", apiKey: "gk", baseUrl: "https://global.example", model: "gm", size: "", quality: "", extraPrompt: "" },
            { id: "app-preset", name: "App", requestMode: "direct", apiKey: "ak", baseUrl: "https://app.example", model: "am", size: "", quality: "", extraPrompt: "" },
        ],
        activeOpenAiPresetId: "global-preset",
        characterReferences: {},
        imageHosting: { provider: "none", imgbbApiKey: "", defaultExpirationSeconds: 0, maxUploadBytes: 900 * 1024, autoConvertToWebp: true, allowMascotUpload: false },
    };
    settingsStorage.saveImageGenerationSettings(stored);

    const bindingConfig = {
        globalDefaults: {},
        characterBindings: [],
        appDefaults: { review: { imageConfigId: "openai:app-preset" } },
    };
    settingsStorage.saveBindingConfig(bindingConfig, false);

    fetchCalls = [];
    // No params.settings -> must resolve the binding for appId "review" and use the app-preset, not the global active preset.
    await service.generateImageFromConfiguredApi({ description: "a cover image", appId: "review" });
    check("E1 with no params.settings, the appId binding is resolved and applied (app-preset's baseUrl used, not the global active preset's)", fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://app.example"));

    fetchCalls = [];
    // A different appId with no matching override falls back to the global active preset.
    await service.generateImageFromConfiguredApi({ description: "a cover image", appId: "some_other_app" });
    check("E2 an appId with no matching binding falls back to the globally active preset", fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://global.example"));

    fetchCalls = [];
    // Passing params.settings explicitly bypasses binding resolution entirely, even with an appId set.
    await service.generateImageFromConfiguredApi({ description: "a cover image", appId: "review", settings: stored });
    check("E3 passing params.settings explicitly bypasses binding resolution (global active preset used despite appId=review)", fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://global.example"));
}

// ── F. hasCharacterReferenceImage ──
{
    const withRef = {
        enabled: true, provider: "openai", requestMode: "direct",
        apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "",
        openaiPresets: [], characterReferences: { charA: { assetId: "asset-x" }, charB: { assetId: "" } },
        imageHosting: { provider: "none", imgbbApiKey: "", defaultExpirationSeconds: 0, maxUploadBytes: 900 * 1024, autoConvertToWebp: true, allowMascotUpload: false },
    };
    settingsStorage.saveImageGenerationSettings(withRef);
    check("F1 hasCharacterReferenceImage true when assetId is set", service.hasCharacterReferenceImage("charA") === true);
    check("F2 hasCharacterReferenceImage false when assetId is empty", service.hasCharacterReferenceImage("charB") === false);
    check("F3 hasCharacterReferenceImage false when the character has no entry at all", service.hasCharacterReferenceImage("charC") === false);
    check("F4 hasCharacterReferenceImage false when characterId is undefined", service.hasCharacterReferenceImage(undefined) === false);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
