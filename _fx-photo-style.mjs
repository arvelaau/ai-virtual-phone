// Fixture for the natural phone-camera photo style: the shared style module, how the OpenAI-
// compatible image path composes its prompt, and the teaching that tells the model how to
// write a photo description.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve("."), dexie: path.resolve("_fx-dexie-stub.mjs") } });

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const S = jiti("./lib/photo-style.ts");
const svc = jiti("./lib/image-generation-service.ts");

// ---- A: the style module ------------------------------------------------------------------
eq("A1 no settings -> nothing", S.resolvePhotoStylePrompt(undefined), "");
eq("A2 look turned off -> nothing", S.resolvePhotoStylePrompt({ naturalPhotoLook: false, photoStylePrompt: "x" }), "");
eq("A3 default on, no custom -> built-in", S.resolvePhotoStylePrompt({}), S.DEFAULT_NATURAL_PHOTO_STYLE);
eq("A4 custom replaces the built-in", S.resolvePhotoStylePrompt({ photoStylePrompt: "  my own style  " }), "my own style");
eq("A5 whitespace-only custom falls back", S.resolvePhotoStylePrompt({ photoStylePrompt: "   " }), S.DEFAULT_NATURAL_PHOTO_STYLE);
yes("A6 built-in names the camera", /iPhone 15/.test(S.DEFAULT_NATURAL_PHOTO_STYLE));
yes("A7 built-in forbids the AI-art tells", /no cinematic color grading/.test(S.DEFAULT_NATURAL_PHOTO_STYLE) && /no studio lighting/.test(S.DEFAULT_NATURAL_PHOTO_STYLE));
yes("A8 built-in is plain English", !/[^\x00-\x7f]/.test(S.DEFAULT_NATURAL_PHOTO_STYLE));
yes("A9 multi-word text survives (no whitespace stripping)", /unedited photo taken casually/.test(S.DEFAULT_NATURAL_PHOTO_STYLE));

// ---- B: the service prompt ------------------------------------------------------------------
const bodies = [];
globalThis.fetch = async (url, init) => {
  bodies.push({ url: String(url), body: typeof init.body === "string" ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const baseSettings = (over = {}) => ({
  enabled: true, provider: "openai", requestMode: "direct",
  apiKey: "k", baseUrl: "https://img.example.com/v1", model: "gpt-image-2", size: "1024x1024", quality: "auto",
  extraPrompt: "(composition: square)",
  openaiPresets: [{ id: "p1", name: "d", requestMode: "direct", apiKey: "k", baseUrl: "https://img.example.com/v1", model: "gpt-image-2", size: "1024x1024", quality: "auto", extraPrompt: "(composition: square)" }],
  activeOpenAiPresetId: "p1",
  characterReferences: {},
  ...over,
});
async function promptFor(params, settings) {
  bodies.length = 0;
  const r = await svc.generateImageFromConfiguredApi({ description: "a ramen bowl on a counter", settings, ...params });
  return { sent: bodies[0]?.body?.prompt, result: r };
}
let r = await promptFor({ photoStyle: true }, baseSettings());
eq("B1 order: description, then style, then the extra prompt", r.sent, `a ramen bowl on a counter\n\n${S.DEFAULT_NATURAL_PHOTO_STYLE}\n\n(composition: square)`);
yes("B2 the result reports the prompt that was sent", r.result?.prompt === r.sent);

r = await promptFor({}, baseSettings());
eq("B3 photoStyle not requested: untouched", r.sent, "a ramen bowl on a counter\n\n(composition: square)");

r = await promptFor({ photoStyle: true }, baseSettings({ naturalPhotoLook: false }));
eq("B4 user turned the look off: untouched", r.sent, "a ramen bowl on a counter\n\n(composition: square)");

r = await promptFor({ photoStyle: true }, baseSettings({ photoStylePrompt: "film grain, shot on a disposable camera" }));
eq("B5 custom style is used", r.sent, "a ramen bowl on a counter\n\nfilm grain, shot on a disposable camera\n\n(composition: square)");

r = await promptFor({ photoStyle: true }, baseSettings({
  extraPrompt: "",
  openaiPresets: [{ id: "p1", name: "d", requestMode: "direct", apiKey: "k", baseUrl: "https://img.example.com/v1", model: "gpt-image-2", size: "1024x1024", quality: "auto", extraPrompt: "" }],
}));
eq("B6 no extra prompt: no dangling separator", r.sent, `a ramen bowl on a counter\n\n${S.DEFAULT_NATURAL_PHOTO_STYLE}`);

// ---- C: wiring and teaching ---------------------------------------------------------------
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const retry = read("lib/generated-image-retry.ts");
yes("C1 chat photo and Moments photo retry both ask for the style", (retry.match(/photoStyle: true/g) || []).length === 2, String((retry.match(/photoStyle: true/g) || []).length));
yes("C2 Moments photo generation asks for the style", /appId: "moments",\n\s+useReferenceImage,\n\s+photoStyle: true/.test(read("lib/moments-engine.ts")));
const storage = read("lib/settings-storage.ts");
yes("C3 both settings survive normalisation", /naturalPhotoLook: settings\?\.naturalPhotoLook !== false/.test(storage) && /photoStylePrompt: typeof settings\?\.photoStylePrompt === "string"/.test(storage));
yes("C4 the settings page has the toggle and the editable style", /Natural phone-camera look/.test(read("components/settings/image-generation-settings.tsx")) && /Photo style prompt/.test(read("components/settings/image-generation-settings.tsx")));
const preset = read("lib/builtin-preset.ts");
yes("C5 both photo blocks teach the phone-photo look", (preset.match(/【Look】It must read like a casual photo someone took with their own phone/g) || []).length === 2);
yes("C6 the cinematic taxi example is gone", !/neon light blooming red and blue/.test(preset));
yes("C7 both blocks carry a selfie and a scene example", (preset.match(/casual selfie at arm's length on a train seat/g) || []).length === 2 && (preset.match(/half-eaten bowl of ramen/g) || []).length === 2);
const ver = Number((preset.match(/BUILTIN_PRESET_VERSION = (\d+)/) || [])[1]);
yes("C8 preset version bumped so the teaching reaches stored copies", ver >= 289, String(ver));
yes("C9 the cinematic words are named as forbidden, not taught", /Do not use cinematic or poster language \(neon bloom/.test(preset));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
