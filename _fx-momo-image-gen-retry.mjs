// Fixture for the momo.float.phone sync, Image Generation Stage 5 (consumer wiring):
// the retry-time reference-image toggle (generateAndApplyChatGeneratedImage /
// retryChatGeneratedImage / retryMomentGeneratedPhoto), its bilingual photo-tag rewriter
// in chat-storage.ts (replacePhotoDirectiveDescription / syncChatGeneratedImagePromptText),
// and the binding-aware availability check in dwelling-image.ts. Drives the REAL functions
// via jiti, aliasing dexie to the shared in-memory stub so chat-storage.ts's message cache
// and moments-storage.ts's post cache are the real Dexie-backed modules, not copies.
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};
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

const chatStorage = await jiti.import("./lib/chat-storage.ts");
const momentsStorage = await jiti.import("./lib/moments-storage.ts");
const retry = await jiti.import("./lib/generated-image-retry.ts");
const settingsStorage = await jiti.import("./lib/settings-storage.ts");
const dwellingImage = await jiti.import("./lib/dwelling-image.ts");

await chatStorage.hydrateChatStorage();
await momentsStorage.hydrateMomentsStorage();

// ── A. replacePhotoDirectiveDescription / syncChatGeneratedImagePromptText ──
// (exercised indirectly through the exported syncChatGeneratedImagePromptText, which is
// the only way to reach the module-private rewriter -- same approach this project's other
// chat-storage fixtures use.)
function seedRawTextMessage(id, rawResponseText) {
    const sessionId = "session_photo_sync";
    // pushChatMessage assigns its own id; overwrite it in the cache afterward so repeated
    // calls in this fixture can target a stable, known id.
    const pushed = chatStorage.pushChatMessage({
        sessionId,
        role: "assistant",
        content: "placeholder",
        rawResponseText,
        responseBatchId: `batch_${id}`,
    });
    // Directly patch the id via updateChatMessage's own machinery isn't available for id
    // itself, so instead re-push isn't needed -- just return the real generated id and use it.
    return pushed.id;
}

{
    // A1-A4: English tag, explicit mode, language preserved on rewrite.
    const id1 = seedRawTextMessage("a1", "Here you go: [Photo:WithRef:a cat on a chair]");
    let changed = chatStorage.syncChatGeneratedImagePromptText(id1, "a cat on a chair", "a dog on a chair", true);
    check("A1 EN explicit WithRef survives when nextUseReferenceImage=true", changed.length === 1 && changed[0].rawResponseText.includes("[Photo:WithRef:a dog on a chair]"));

    const id2 = seedRawTextMessage("a2", "Here you go: [Photo:WithRef:a cat on a chair]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id2, "a cat on a chair", "a dog on a chair", false);
    check("A2 EN explicit mode flips WithRef->NoRef when nextUseReferenceImage=false", changed.length === 1 && changed[0].rawResponseText.includes("[Photo:NoRef:a dog on a chair]"));

    // A3: legacy Chinese tag, explicit mode, must stay Chinese words (never cross to English).
    const id3 = seedRawTextMessage("a3", "这是你要的：[照片:使用参考图:一只猫坐在椅子上]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id3, "一只猫坐在椅子上", "一只狗坐在椅子上", false);
    check("A3 legacy ZH explicit mode flips to 不使用参考图, never to English words",
        changed.length === 1
        && changed[0].rawResponseText.includes("[照片:不使用参考图:一只狗坐在椅子上]")
        && !changed[0].rawResponseText.includes("NoRef"));

    // A4: bare English tag (no explicit mode) gains one when nextUseReferenceImage is set.
    const id4 = seedRawTextMessage("a4", "[Photo:a plain description]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id4, "a plain description", "an updated description", true);
    check("A4 bare EN tag upgrades to an explicit WithRef mode", changed.length === 1 && changed[0].rawResponseText.includes("[Photo:WithRef:an updated description]"));

    // A5: bare Chinese tag gains a Chinese mode word, not an English one.
    const id5 = seedRawTextMessage("a5", "[照片:一段朴素描述]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id5, "一段朴素描述", "一段更新后的描述", true);
    check("A5 bare ZH tag upgrades to 使用参考图, not WithRef", changed.length === 1 && changed[0].rawResponseText.includes("[照片:使用参考图:一段更新后的描述]"));

    // A6: KEY non-vacuity case -- mode-only change (description unchanged) must still rewrite.
    // This is exactly the case the old `oldDesc === nextDesc` early-return would have skipped.
    const id6 = seedRawTextMessage("a6", "[Photo:WithRef:same description throughout]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id6, "same description throughout", "same description throughout", false);
    check("A6 mode-only change (same description) still rewrites the tag", changed.length === 1 && changed[0].rawResponseText.includes("[Photo:NoRef:same description throughout]"));

    // A7: truly nothing changes (same description, no mode override) -> no-op, no crash.
    const id7 = seedRawTextMessage("a7", "[Photo:WithRef:untouched description]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id7, "untouched description", "untouched description", undefined);
    check("A7 no description change and no mode override -> genuine no-op", changed.length === 0);

    // A8: a photo tag for a DIFFERENT description in the same text must not be touched --
    // guards the multi-photo-per-reply case the source comment calls out.
    const id8 = seedRawTextMessage("a8", "[Photo:WithRef:first photo][Photo:NoRef:second photo]");
    changed = chatStorage.syncChatGeneratedImagePromptText(id8, "second photo", "second photo updated", true);
    check("A8 only the matching photo tag is rewritten, the other is untouched",
        changed.length === 1
        && changed[0].rawResponseText.includes("[Photo:WithRef:first photo]")
        && changed[0].rawResponseText.includes("[Photo:WithRef:second photo updated]"));
}

// ── B. generateAndApplyChatGeneratedImage / retryChatGeneratedImage ──
let fetchCalls = [];
function fakeJsonResponse(body) {
    return {
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}
globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return fakeJsonResponse({ data: [{ b64_json: "QUFBQQ==" }] });
};

const imgSettings = {
    enabled: true, provider: "openai", requestMode: "direct",
    apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "",
    openaiPresets: [{ id: "p1", name: "One", requestMode: "direct", apiKey: "k1", baseUrl: "https://chat.example", model: "m1", size: "", quality: "", extraPrompt: "" }],
    activeOpenAiPresetId: "p1",
    characterReferences: {},
    imageHosting: { provider: "none", imgbbApiKey: "", defaultExpirationSeconds: 0, maxUploadBytes: 900 * 1024, autoConvertToWebp: true, allowMascotUpload: false },
};
settingsStorage.saveImageGenerationSettings(imgSettings);
settingsStorage.saveBindingConfig({ globalDefaults: {}, characterBindings: [], appDefaults: {} }, false);

{
    const sessionId = "session_retry_b";
    const seeded = chatStorage.pushChatMessage({
        sessionId,
        role: "assistant",
        content: "placeholder",
        mediaType: "image",
        mediaData: { label: "original description", useReferenceImage: true, imageGenerationStatus: "generated" },
    });

    fetchCalls = [];
    const events = [];
    globalThis.addEventListener = (type, fn) => {
        if (type === "chat-messages-updated") events.push(fn);
    };
    let broadcastCount = 0;
    globalThis.dispatchEvent = (evt) => {
        if (evt?.type === "chat-messages-updated") broadcastCount++;
        return true;
    };

    const updated = await retry.retryChatGeneratedImage(seeded, "char1", "a brand new description", false);
    check("B1 retry hits the /generations endpoint (appId:'chat' resolved through binding, no reference)", fetchCalls.length === 1 && fetchCalls[0].url.endsWith("/generations"));
    check("B2 the final message carries the new description", updated.mediaData?.label === "a brand new description");
    check("B3 useReferenceImage explicitly overridden to false is stored", updated.mediaData?.useReferenceImage === false);
    check("B4 status ends as 'generated'", updated.mediaData?.imageGenerationStatus === "generated");
    // A pending mark-and-broadcast happens BEFORE the fetch call, then a final one after --
    // at least 2 broadcasts for a single retry that starts from a non-pending state.
    check("B5 at least 2 broadcasts fired (pending mark, then final result)", broadcastCount >= 2);

    // B6: useReferenceImage left undefined -> falls back to the message's own stored value (true).
    fetchCalls = [];
    const seeded2 = chatStorage.pushChatMessage({
        sessionId,
        role: "assistant",
        content: "placeholder",
        mediaType: "image",
        mediaData: { label: "desc two", useReferenceImage: true, imageGenerationStatus: "generated" },
    });
    await retry.retryChatGeneratedImage(seeded2, "char1", "desc two updated");
    // No character reference image is configured, so /generations is still hit (nothing to attach) --
    // the assertion that matters is the STORED flag, not the endpoint.
    const finalMsg = chatStorage.loadChatMessages(sessionId).find(m => m.id === seeded2.id);
    check("B6 omitted useReferenceImage on retry falls back to the message's own prior value (true)", finalMsg?.mediaData?.useReferenceImage === true);
}

// ── C. retryMomentGeneratedPhoto ──
{
    fetchCalls = [];
    let momentsUpdatedCount = 0;
    globalThis.dispatchEvent = (evt) => {
        if (evt?.type === "moments-updated") momentsUpdatedCount++;
        return true;
    };

    const post = momentsStorage.addMomentPost({
        authorType: "character",
        authorId: "char_moments_1",
        content: "a moments post",
        photoDescription: "original moments photo",
        photoUseReferenceImage: true,
        photoGenerationStatus: "generated",
    });
    check("C0 seeded post exists", Boolean(post));

    const updatedPost = await retry.retryMomentGeneratedPhoto(post, "a new moments photo description", false);
    check("C1 retry hits the /generations endpoint", fetchCalls.length === 1 && fetchCalls[0].url.endsWith("/generations"));
    check("C2 the post's description is updated", updatedPost.photoDescription === "a new moments photo description");
    check("C3 useReferenceImage explicitly overridden to false is stored", updatedPost.photoUseReferenceImage === false);
    check("C4 status ends as 'generated'", updatedPost.photoGenerationStatus === "generated");
    check("C5 at least 2 moments-updated broadcasts fired (pending mark, then final)", momentsUpdatedCount >= 2);
}

// ── D. getDwellingImageAvailability: binding-aware provider check ──
{
    // D1: enabled + fully-configured OpenAI preset -> configured.
    settingsStorage.saveBindingConfig({ globalDefaults: {}, characterBindings: [], appDefaults: {} }, false);
    const avail1 = dwellingImage.getDwellingImageAvailability();
    check("D1 enabled+configured OpenAI preset -> configured true", avail1.configured === true);

    // D2: switch the active preset's provider to novelai with no NovelAI key -> not configured.
    settingsStorage.saveImageGenerationSettings({
        ...imgSettings,
        provider: "novelai",
        novelai: { apiKey: "", requestMode: "direct", activePresetId: "n1", presets: [{ id: "n1", name: "N", model: "nai-diffusion-3", resolution: "1024x1024", steps: 28, scale: 6, sampler: "k_euler", noiseSchedule: "karras", positivePrompt: "", negativePrompt: "", qualityToggle: true, smea: false, smeaDyn: false }] },
    });
    const avail2 = dwellingImage.getDwellingImageAvailability();
    check("D2 novelai provider with an empty API key -> configured false", avail2.configured === false);

    // D3: same novelai provider, but WITH a key -> configured true.
    settingsStorage.saveImageGenerationSettings({
        ...imgSettings,
        provider: "novelai",
        novelai: { apiKey: "nai-key", requestMode: "direct", activePresetId: "n1", presets: [{ id: "n1", name: "N", model: "nai-diffusion-3", resolution: "1024x1024", steps: 28, scale: 6, sampler: "k_euler", noiseSchedule: "karras", positivePrompt: "", negativePrompt: "", qualityToggle: true, smea: false, smeaDyn: false }] },
    });
    const avail3 = dwellingImage.getDwellingImageAvailability();
    check("D3 novelai provider WITH a key -> configured true", avail3.configured === true);

    // restore OpenAI provider for cleanliness (not strictly required, but avoids surprising a reader)
    settingsStorage.saveImageGenerationSettings(imgSettings);
}

// ── E. appId is not just a passed-through string -- it actually drives which preset
// each consumer resolves to. Give "chat", "moments" and "dwelling" three DIFFERENT
// app-level bindings and confirm each consumer's own appId reaches its own preset.
{
    const settingsWithThreePresets = {
        enabled: true, provider: "openai", requestMode: "direct",
        apiKey: "", baseUrl: "", model: "", size: "", quality: "", extraPrompt: "",
        openaiPresets: [
            { id: "global-preset", name: "Global", requestMode: "direct", apiKey: "gk", baseUrl: "https://global.example", model: "gm", size: "", quality: "", extraPrompt: "" },
            { id: "chat-preset", name: "Chat", requestMode: "direct", apiKey: "ck", baseUrl: "https://chat-app.example", model: "cm", size: "", quality: "", extraPrompt: "" },
            { id: "moments-preset", name: "Moments", requestMode: "direct", apiKey: "mk", baseUrl: "https://moments-app.example", model: "mm", size: "", quality: "", extraPrompt: "" },
        ],
        activeOpenAiPresetId: "global-preset",
        characterReferences: {},
        imageHosting: { provider: "none", imgbbApiKey: "", defaultExpirationSeconds: 0, maxUploadBytes: 900 * 1024, autoConvertToWebp: true, allowMascotUpload: false },
    };
    settingsStorage.saveImageGenerationSettings(settingsWithThreePresets);
    settingsStorage.saveBindingConfig({
        globalDefaults: {},
        characterBindings: [],
        appDefaults: {
            chat: { imageConfigId: "openai:chat-preset" },
            moments: { imageConfigId: "openai:moments-preset" },
        },
    }, false);

    fetchCalls = [];
    const chatMsg = chatStorage.pushChatMessage({
        sessionId: "session_appid_e",
        role: "assistant",
        content: "placeholder",
        mediaType: "image",
        mediaData: { label: "e-chat", useReferenceImage: false, imageGenerationStatus: "generated" },
    });
    await retry.retryChatGeneratedImage(chatMsg, undefined, "e-chat retried");
    check("E1 retryChatGeneratedImage (appId:'chat') resolves the chat-app binding, not the global default",
        fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://chat-app.example"));

    fetchCalls = [];
    const momentsPost = momentsStorage.addMomentPost({
        authorType: "user",
        authorId: "user",
        content: "e-moments post",
        photoDescription: "e-moments",
        photoUseReferenceImage: false,
        photoGenerationStatus: "generated",
    });
    await retry.retryMomentGeneratedPhoto(momentsPost, "e-moments retried");
    check("E2 retryMomentGeneratedPhoto (appId:'moments') resolves the moments-app binding, not the global default",
        fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://moments-app.example"));

    // dwelling has no app-level override in this setup -> must fall back to the global default,
    // proving the per-app bindings above are genuinely scoped and don't leak into an unrelated app.
    fetchCalls = [];
    await dwellingImage.generateDwellingRoomImage("char_dwelling_1", {
        id: "room1", name: "Living Room", description: "A cozy living room", furniture: [],
    });
    check("E3 dwelling (no app override) falls back to the global preset, unaffected by chat/moments bindings",
        fetchCalls.length === 1 && fetchCalls[0].url.startsWith("https://global.example"));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
