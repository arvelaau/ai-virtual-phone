import type { ImageGenerationSettings, NovelAiPreset } from "./settings-types";
import { loadBindingConfig, loadImageGenerationSettings, resolveBinding, DEFAULT_NOVELAI_PRESET } from "./settings-storage";
import { applyImageGenerationBinding } from "./image-generation-binding";
import JSZip from "jszip";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { storeMediaBlob } from "./media-cache-storage";
import { throwIfAborted } from "./abort-utils";
import { resolvePhotoStylePrompt } from "./photo-style";
import {
  NOVELAI_COMMON_MODELS,
  getNovelAiResolution,
  normalizeNovelAiModel,
  normalizeNovelAiNoiseSchedule,
  normalizeNovelAiSampler,
  normalizeNovelAiScale,
  normalizeNovelAiSteps,
} from "./novelai-image-config";

export type ImageGenerationResult = {
  mediaRef: string;
  dataUrl: string;
  blob: Blob;
  mimeType: string;
  prompt: string;
  usedReferenceImage: boolean;
  revisedPrompt?: string;
};

type ExtractedImage =
  | { kind: "b64"; b64: string; mimeType?: string; revisedPrompt?: string }
  | { kind: "url"; url: string; revisedPrompt?: string };

type ImageGenerationApiResponse = {
  b64: string;
  mimeType?: string;
  revisedPrompt?: string;
};

const IMAGE_MODEL_HINTS = [
  "image",
  "img",
  "dall",
  "flux",
  "stable",
  "sd",
  "midjourney",
  "mj",
  "ideogram",
  "imagen",
  "qwen-image",
  "kolors",
  "wan",
];

function mergePrompt(description: string, extraPrompt: string): string {
  const main = description.trim();
  const extra = extraPrompt.trim();
  return extra ? `${main}\n\n${extra}` : main;
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function dataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  return match?.[1]?.toLowerCase() || "";
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return null;
  return { blob: base64ToBlob(match[2], match[1] || "image/png"), mimeType: match[1] || "image/png" };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode the reference image"));
    image.src = dataUrl;
  });
}

async function normalizeReferenceImageForEdit(
  dataUrl: string,
  crop?: { x: number; y: number; size: number },
): Promise<string> {
  if (!crop && dataUrlMimeType(dataUrl) === "image/png") return dataUrl;
  if (typeof document === "undefined") return dataUrl;

  try {
    const image = await loadDataUrlImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return dataUrl;

    const canvas = document.createElement("canvas");
    const normalizedSize = crop ? Math.max(0.18, Math.min(1, crop.size)) : 1;
    const sourceSize = Math.max(1, Math.round(Math.min(width, height) * normalizedSize));
    const sourceX = crop
      ? Math.round(Math.max(0, Math.min(width - sourceSize, crop.x * width)))
      : 0;
    const sourceY = crop
      ? Math.round(Math.max(0, Math.min(height - sourceSize, crop.y * height)))
      : 0;
    canvas.width = crop ? sourceSize : width;
    canvas.height = crop ? sourceSize : height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    if (crop) {
      context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, sourceSize, sourceSize);
    } else {
      context.drawImage(image, 0, 0, width, height);
    }
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1] || "png";
  return subtype.replace("jpeg", "jpg");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
}

function buildImageUrl(baseUrl: string, mode: "generations" | "edits"): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/images\/(?:generations|edits)$/i.test(trimmed)) {
    return trimmed.replace(/\/images\/(?:generations|edits)$/i, `/images/${mode}`);
  }
  if (/\/images$/i.test(trimmed)) return `${trimmed}/${mode}`;
  return `${normalizeBaseUrl(trimmed)}/images/${mode}`;
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/models`;
}

function cleanBase64(value: string): { b64: string; mimeType?: string } {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(value.trim());
  if (match) return { mimeType: match[1], b64: match[2] };
  return { b64: value.trim() };
}

function extractFromObject(data: unknown): ExtractedImage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const revisedPrompt = typeof record.revised_prompt === "string" ? record.revised_prompt : undefined;

  for (const key of ["b64_json", "base64", "b64", "image", "result"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      if (/^https?:\/\//i.test(value.trim())) return { kind: "url", url: value.trim(), revisedPrompt };
      const cleaned = cleanBase64(value);
      return { kind: "b64", ...cleaned, revisedPrompt };
    }
  }

  for (const key of ["url", "image_url"]) {
    const value = record[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return { kind: "url", url: value.trim(), revisedPrompt };
    }
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).url;
      if (typeof nested === "string" && /^https?:\/\//i.test(nested.trim())) {
        return { kind: "url", url: nested.trim(), revisedPrompt };
      }
    }
  }

  for (const key of ["data", "images", "output", "content"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          if (/^https?:\/\//i.test(item.trim())) return { kind: "url", url: item.trim(), revisedPrompt };
          const cleaned = cleanBase64(item);
          return { kind: "b64", ...cleaned, revisedPrompt };
        }
        const nested = extractFromObject(item);
        if (nested) return { ...nested, revisedPrompt: nested.revisedPrompt || revisedPrompt };
      }
    }
  }

  return null;
}

function extractModels(data: unknown): string[] {
  const results: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^models\//, "").trim();
    if (normalized) results.push(normalized);
  };

  if (Array.isArray(data)) {
    data.forEach(item => {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        push(row.id ?? row.name ?? row.model);
      }
    });
  } else if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      const value = row[key];
      if (Array.isArray(value)) results.push(...extractModels(value));
    }
    push(row.id ?? row.name ?? row.model);
  }

  return Array.from(new Set(results));
}

async function fetchImageUrlAsBase64(url: string, signal?: AbortSignal): Promise<{ b64: string; mimeType: string }> {
  throwIfAborted(signal);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to download the image URL ${res.status}: ${text.slice(0, 160)}`);
  }
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  const cleaned = cleanBase64(dataUrl);
  return { b64: cleaned.b64, mimeType: cleaned.mimeType || blob.type || "image/png" };
}

async function parseImageGenerationResponse(res: Response, signal?: AbortSignal): Promise<ImageGenerationApiResponse> {
  throwIfAborted(signal);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image-generation API error ${res.status}: ${text.slice(0, 600)}`);
  }

  if (contentType.startsWith("image/")) {
    const blob = await res.blob();
    throwIfAborted(signal);
    const dataUrl = await blobToDataUrl(blob);
    const cleaned = cleanBase64(dataUrl);
    return { b64: cleaned.b64, mimeType: cleaned.mimeType || contentType };
  }

  const json = await res.json();
  throwIfAborted(signal);
  const extracted = extractFromObject(json);
  if (!extracted) {
    throw new Error(`No image field found in the image-generation API's response: ${JSON.stringify(Object.keys(json || {})).slice(0, 200)}`);
  }

  if (extracted.kind === "url") {
    const downloaded = await fetchImageUrlAsBase64(extracted.url, signal);
    return { ...downloaded, revisedPrompt: extracted.revisedPrompt };
  }

  return {
    b64: extracted.b64,
    mimeType: extracted.mimeType || "image/png",
    revisedPrompt: extracted.revisedPrompt,
  };
}

export function filterLikelyImageModels(models: string[]): string[] {
  const filtered = models.filter(model => {
    const lower = model.toLowerCase();
    return IMAGE_MODEL_HINTS.some(hint => lower.includes(hint));
  });
  return filtered.length > 0 ? filtered : models;
}

export async function fetchImageGenerationModels(settings: Pick<ImageGenerationSettings, "apiKey" | "baseUrl" | "requestMode">): Promise<string[]> {
  if (settings.requestMode === "direct") {
    try {
      const res = await fetch(buildModelsUrl(settings.baseUrl), {
        method: "GET",
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Model-list API error ${res.status}: ${text.slice(0, 400)}`);
      }
      return extractModels(JSON.parse(text));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("Direct browser connection failed: this API may not allow cross-origin requests.");
      }
      throw error;
    }
  }

  const res = await fetch("/api/image-generation/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
    }),
  });
  const data = await res.json().catch(() => ({})) as { models?: string[]; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error || `Model-list request failed ${res.status}`);
  }
  return Array.isArray(data.models) ? data.models : [];
}

// General-purpose image-generation proxy (Cloudflare Worker). Once configured, "server relay"
// mode changes to: browser -> this proxy (has CORS, no wait-time limit) -> the user's own
// image-generation API, no longer going through the Netlify function (whose streamed response
// has a hard 60s cap -- a slow generation is doomed there and the relay still gets billed
// regardless). Leave empty = off, falls back to the old Netlify heartbeat-streaming route.
// Self-hosters should configure their own proxy address.
export const IMAGE_GEN_PROXY_URL = (process.env.NEXT_PUBLIC_IMAGE_GEN_PROXY_URL || "").trim().replace(/\/+$/, "");

async function generateImageDirect(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrl: string | null;
  signal?: AbortSignal;
  /** Via the general-purpose proxy: the request goes to the proxy address, with the real upstream in the x-upstream-base-url header. */
  proxyBaseUrl?: string;
}): Promise<ImageGenerationApiResponse> {
  const { settings, prompt, referenceImageDataUrl, signal, proxyBaseUrl } = params;
  throwIfAborted(signal);
  const hasReference = Boolean(referenceImageDataUrl);
  const url = buildImageUrl(proxyBaseUrl || settings.baseUrl, hasReference ? "edits" : "generations");
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.apiKey}` };
  if (proxyBaseUrl) headers["x-upstream-base-url"] = normalizeBaseUrl(settings.baseUrl);
  let body: BodyInit;

  if (hasReference) {
    const converted = dataUrlToBlob(referenceImageDataUrl || "");
    if (!converted) throw new Error("Invalid reference-image format");
    const form = new FormData();
    form.set("model", settings.model);
    form.set("prompt", prompt);
    if (settings.size && settings.size !== "auto") form.set("size", settings.size);
    if (settings.quality && settings.quality !== "auto") form.set("quality", settings.quality);
    form.append("image", converted.blob, `reference.${imageExtension(converted.mimeType)}`);
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: settings.model,
      prompt,
      ...(settings.size && settings.size !== "auto" ? { size: settings.size } : {}),
      ...(settings.quality && settings.quality !== "auto" ? { quality: settings.quality } : {}),
    });
  }

  // Total timeout 360s, tied to the outer signal; guards against the UI spinning forever if the
  // upstream hangs. Some relays' per-image generation (e.g. the gpt-image family) is observed to
  // take 3-5 minutes for a single image; 180s would cut it off before it finishes (money still
  // charged, image lost).
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 360_000);
  try {
    return await parseImageGenerationResponse(await fetch(url, { method: "POST", headers, body, signal: controller.signal }), signal);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(proxyBaseUrl ? "Image-generation proxy timed out (no response after 360 seconds)" : "Image-generation request timed out (no response after 360 seconds)");
    }
    if (error instanceof TypeError) {
      throw new Error(proxyBaseUrl ? "Failed to connect to the image-generation proxy" : "Direct browser connection failed: this API may not allow cross-origin requests.");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

// "Server relay" mode: if a general-purpose proxy (CF Worker) is configured, ONLY it is used --
// whatever mode the user picked is the one that's actually used, with no hidden fallback (no
// longer falling back to the Netlify function, which burns site quota and has a 60s cap).
// When the constant isn't configured, the old Netlify heartbeat-streaming route is kept (for
// self-hosted deployments with no Worker).
//
// The Netlify heartbeat route is one of the biggest compute costs against site quota (each image
// occupies the function for 30-120s), and plenty of users who picked "server relay" actually have
// an image-generation API that allows cross-origin requests. So before going through Netlify, a
// direct browser connection is tried first: only when it fails due to CORS (the preflight was
// rejected, the real request never went out, so upstream is never billed for it) does it fall
// back to the server -- remembered per baseUrl so the same failure isn't re-probed again this session.
const directCorsFailedBaseUrls = new Set<string>();

async function generateImageViaServerOrProxy(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrl: string | null;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  if (IMAGE_GEN_PROXY_URL) {
    try {
      return await generateImageDirect({ ...params, proxyBaseUrl: IMAGE_GEN_PROXY_URL });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Failed to connect to the image-generation proxy")) {
        throw new Error("Failed to connect to the image-generation proxy: the current network may not be able to reach the proxy server (a VPN/proxy may be required in some regions), or try again later.");
      }
      throw error;
    }
  }
  const baseUrlKey = normalizeBaseUrl(params.settings.baseUrl);
  if (!directCorsFailedBaseUrls.has(baseUrlKey)) {
    try {
      return await generateImageDirect(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only fall back on a connection-layer failure (CORS/offline); an error from the API
      // itself (invalid key, insufficient balance, etc.) means the direct connection DID go
      // through, so a server relay would hit the same error -- throw immediately to avoid
      // getting billed twice.
      if (!message.includes("Direct browser connection failed")) throw error;
      throwIfAborted(params.signal);
      directCorsFailedBaseUrls.add(baseUrlKey);
    }
  }
  return generateImageViaServer(params);
}

async function generateImageViaServer(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrl: string | null;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { settings, prompt, referenceImageDataUrl, signal } = params;
  throwIfAborted(signal);
  // Guards against hanging forever: if the platform kills the function mid-stream, the stream may neither close nor error out.
  // Total timeout 180s + stall detection (a heartbeat byte every 3s; no byte at all for over 25s counts as stalled).
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);
  try {
    // x-stream-heartbeat: the server responds with a heartbeat stream; the real result is
    // attached after the @@RESULT@@ marker at the end of the stream. Avoids the hosting
    // platform's 10-26s timeout on a buffered response from cutting a slow generation
    // (30-120s) short as a 504.
    const res = await fetch("/api/image-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stream-heartbeat": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        prompt,
        size: settings.size,
        quality: settings.quality,
        referenceImageDataUrl: referenceImageDataUrl || undefined,
      }),
    });
    throwIfAborted(signal);

    type ServerImagePayload = { httpStatus?: number; b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let data: ServerImagePayload;
    if (contentType.includes("text/plain")) {
      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            idleTimer = setTimeout(() => controller.abort(), 25_000);
            const { done, value } = await reader.read();
            clearTimeout(idleTimer);
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (err) {
          clearTimeout(idleTimer);
          if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("Image-generation request failed (server connection interrupted, no response for over 25 seconds)");
          }
          throw err;
        }
      } else {
        text = await res.text();
      }
      const marker = "@@RESULT@@";
      const idx = text.lastIndexOf(marker);
      if (idx < 0) throw new Error(`Image-generation request failed ${res.status} (streamed response interrupted, no result received)`);
      try {
        data = JSON.parse(text.slice(idx + marker.length)) as ServerImagePayload;
      } catch {
        throw new Error("Image-generation request failed (error parsing the streamed result)");
      }
      throwIfAborted(signal);
      if (data.error || !data.b64) {
        throw new Error(data.error || `Image-generation request failed ${data.httpStatus ?? res.status}`);
      }
    } else {
      // Non-streamed fallback (older server, etc.)
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(data.error || `Image-generation request failed ${res.status}`);
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

async function generateNovelAiDirect(params: {
  apiKey: string;
  preset: NovelAiPreset;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { apiKey, preset, prompt, signal } = params;
  throwIfAborted(signal);

  const { width, height } = getNovelAiResolution(preset.resolution);

  const url = "https://image.novelai.net/ai/generate-image";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({
    input: prompt,
    model: normalizeNovelAiModel(preset.model),
    action: "generate",
    parameters: {
      width,
      height,
      scale: normalizeNovelAiScale(preset.scale),
      sampler: normalizeNovelAiSampler(preset.sampler),
      steps: normalizeNovelAiSteps(preset.steps),
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: preset.qualityToggle !== false,
      sm: preset.smea === true,
      sm_dyn: preset.smeaDyn === true,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: false,
      uncond_scale: 1,
      cfg_rescale: 0,
      noise_schedule: normalizeNovelAiNoiseSchedule(preset.noiseSchedule),
      negative_prompt: preset.negativePrompt || "",
    },
  });

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);

  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`NovelAI API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    const isZip = (uint8[0] === 0x50 && uint8[1] === 0x4b && uint8[2] === 0x03 && uint8[3] === 0x04)
      || (res.headers.get("content-type") || "").toLowerCase().includes("zip");

    if (isZip) {
      const zip = await JSZip.loadAsync(arrayBuf);
      const files = Object.keys(zip.files);
      const pngFile = files.find(f => f.endsWith(".png")) || files[0];
      if (!pngFile) throw new Error("No image found inside the zip returned by NovelAI");
      const b64 = await zip.files[pngFile].async("base64");
      return { b64, mimeType: "image/png" };
    }

    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return { b64: btoa(binary), mimeType: res.headers.get("content-type") || "image/png" };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error("Direct NovelAI request timed out (no response after 180 seconds)");
    }
    if (error instanceof TypeError) {
      throw new Error("Direct browser connection to NovelAI failed: this may be a browser CORS restriction -- switch the request mode to \"server relay\" in the image-generation settings.");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

async function generateNovelAiViaServer(params: {
  apiKey: string;
  preset: NovelAiPreset;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { apiKey, preset, prompt, signal } = params;
  throwIfAborted(signal);

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);

  try {
    const resolution = getNovelAiResolution(preset.resolution);
    const res = await fetch("/api/image-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stream-heartbeat": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        provider: "novelai",
        apiKey,
        model: normalizeNovelAiModel(preset.model),
        prompt,
        size: resolution.value,
        negativePrompt: preset.negativePrompt || "",
        steps: normalizeNovelAiSteps(preset.steps),
        scale: normalizeNovelAiScale(preset.scale),
        sampler: normalizeNovelAiSampler(preset.sampler),
        noiseSchedule: normalizeNovelAiNoiseSchedule(preset.noiseSchedule),
        qualityToggle: preset.qualityToggle,
        smea: preset.smea,
        smeaDyn: preset.smeaDyn,
      }),
    });
    throwIfAborted(signal);

    type ServerImagePayload = { httpStatus?: number; b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let data: ServerImagePayload;

    if (contentType.includes("text/plain")) {
      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            idleTimer = setTimeout(() => controller.abort(), 25_000);
            const { done, value } = await reader.read();
            clearTimeout(idleTimer);
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (err) {
          clearTimeout(idleTimer);
          if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("NovelAI request failed (server connection interrupted, no response for over 25 seconds)");
          }
          throw err;
        }
      } else {
        text = await res.text();
      }
      const marker = "@@RESULT@@";
      const idx = text.lastIndexOf(marker);
      if (idx < 0) throw new Error(`NovelAI request failed ${res.status} (streamed response interrupted, no result received)`);
      try {
        data = JSON.parse(text.slice(idx + marker.length)) as ServerImagePayload;
      } catch {
        throw new Error("NovelAI request failed (error parsing the streamed result)");
      }
      throwIfAborted(signal);
      if (data.error || !data.b64) {
        throw new Error(data.error || `NovelAI request failed ${data.httpStatus ?? res.status}`);
      }
    } else {
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(data.error || `NovelAI request failed ${res.status}`);
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchNovelAiModels(apiKey: string): Promise<string[]> {
  const token = apiKey.trim();
  if (!token) throw new Error("Enter your NovelAI API Token first.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://image.novelai.net/user/data", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("The NovelAI API Token is invalid or expired -- get a new one and try again.");
      }
      throw new Error(`NovelAI Token verification failed ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    return [...NOVELAI_COMMON_MODELS];
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("NovelAI Token verification timed out -- check your network and try again.");
    }
    if (error instanceof TypeError) {
      throw new Error("Could not connect to NovelAI -- check your network and try again.");
    }
    if (error instanceof Error) throw error;
    throw new Error("NovelAI Token verification failed -- check your network and try again.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateImageFromConfiguredApi(params: {
  description: string;
  characterId?: string;
  /** The APP the content belongs to; used to resolve the image-generation preset via "character > APP > global". */
  appId?: string;
  useReferenceImage?: boolean;
  /**
   * This image is a photo someone "took" (a chat or Moments photo): append the natural
   * phone-camera style block so it does not come out looking like AI art. Off for room
   * backdrops, CSS assets and anything else that is not meant to be a photograph.
   */
  photoStyle?: boolean;
  settings?: ImageGenerationSettings;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult | null> {
  const storedSettings = params.settings ?? loadImageGenerationSettings();
  // A config passed in explicitly (a settings-page test / a direct tool call) is kept as-is;
  // only a normal business call reads the binding.
  const settings = params.settings
    ? storedSettings
    : applyImageGenerationBinding(
        storedSettings,
        resolveBinding(loadBindingConfig(), params.characterId, params.appId).imageConfigId,
      );
  if (!settings.enabled) return null;

  const description = params.description.trim();
  if (!description) return null;

  // NovelAI mode
  if (settings.provider === "novelai") {
    const naiApiKey = settings.novelai?.apiKey?.trim();
    if (!naiApiKey) return null;

    const presets = settings.novelai?.presets && settings.novelai.presets.length > 0
      ? settings.novelai.presets
      : [DEFAULT_NOVELAI_PRESET];
    const activePreset = presets.find(p => p.id === settings.novelai?.activePresetId) || presets[0];

    const positiveParts: string[] = [];
    if (activePreset.positivePrompt?.trim()) positiveParts.push(activePreset.positivePrompt.trim());
    const novelAiCharacterReference = params.characterId
      ? settings.characterReferences?.[params.characterId]
      : undefined;
    const characterFeaturePrompt = novelAiCharacterReference?.novelAiFeaturePromptEnabled !== false
      ? novelAiCharacterReference?.featurePrompt?.trim()
      : "";
    if (characterFeaturePrompt) positiveParts.push(characterFeaturePrompt);
    if (description) positiveParts.push(description);
    const fullPrompt = positiveParts.join(", ");

    const novelAiRequestMode = settings.novelai?.requestMode || settings.requestMode;
    const data = novelAiRequestMode === "direct"
      ? await generateNovelAiDirect({ apiKey: naiApiKey, preset: activePreset, prompt: fullPrompt, signal: params.signal })
      : await generateNovelAiViaServer({ apiKey: naiApiKey, preset: activePreset, prompt: fullPrompt, signal: params.signal });

    throwIfAborted(params.signal);
    const mimeType = data.mimeType || "image/png";
    const blob = base64ToBlob(data.b64, mimeType);
    throwIfAborted(params.signal);
    const mediaRef = await storeMediaBlob(blob, mimeType, "image");
    throwIfAborted(params.signal);
    return {
      mediaRef,
      dataUrl: `data:${mimeType};base64,${data.b64}`,
      blob,
      mimeType,
      prompt: fullPrompt,
      usedReferenceImage: false,
      revisedPrompt: data.revisedPrompt,
    };
  }

  // OpenAI-compatible mode: use the currently active preset (an old, pre-migration config keeps working after the storage layer migrates it).
  const openaiPreset = settings.openaiPresets?.find(preset => preset.id === settings.activeOpenAiPresetId)
    || settings.openaiPresets?.[0];
  const openaiSettings = openaiPreset ? { ...settings, ...openaiPreset } : settings;
  if (!openaiSettings.apiKey.trim() || !openaiSettings.baseUrl.trim() || !openaiSettings.model.trim()) return null;

  const reference = params.characterId ? settings.characterReferences?.[params.characterId] : undefined;
  // The "don't use the reference image for non-selfies" toggle was removed from the image-
  // generation settings page: once the reference image is enabled, it's always used for generation.
  const shouldUseReference = Boolean(
    params.useReferenceImage
    && reference?.assetId
    && reference.enabled !== false,
  );
  const rawReferenceImageDataUrl = shouldUseReference && reference?.assetId
    ? await getChatImageFromIndexedDB(reference.assetId)
    : null;
  throwIfAborted(params.signal);
  const referenceImageDataUrl = rawReferenceImageDataUrl
    ? await normalizeReferenceImageForEdit(rawReferenceImageDataUrl, reference?.faceCrop)
    : null;
  throwIfAborted(params.signal);
  const characterPrompt = reference?.featurePrompt?.trim() || "";
  const photoStyle = params.photoStyle ? resolvePhotoStylePrompt(settings) : "";
  const prompt = mergePrompt(
    characterPrompt ? `${description}\n\n[Character's fixed appearance] ${characterPrompt}` : description,
    [photoStyle, openaiSettings.extraPrompt].map((part) => (part || "").trim()).filter(Boolean).join("\n\n"),
  );

  const data = openaiSettings.requestMode === "direct"
    ? await generateImageDirect({ settings: openaiSettings, prompt, referenceImageDataUrl, signal: params.signal })
    : await generateImageViaServerOrProxy({ settings: openaiSettings, prompt, referenceImageDataUrl, signal: params.signal });

  throwIfAborted(params.signal);
  const mimeType = data.mimeType || "image/png";
  const blob = base64ToBlob(data.b64, mimeType);
  throwIfAborted(params.signal);
  const mediaRef = await storeMediaBlob(blob, mimeType, "image");
  throwIfAborted(params.signal);
  return {
    mediaRef,
    dataUrl: `data:${mimeType};base64,${data.b64}`,
    blob,
    mimeType,
    prompt,
    usedReferenceImage: Boolean(referenceImageDataUrl),
    revisedPrompt: data.revisedPrompt,
  };
}

export function generatedImageFilename(description: string, mimeType = "image/png"): string {
  const safe = description
    .replace(/\s+/g, "-")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, "")
    .slice(0, 28) || "generated-image";
  return `${safe}.${imageExtension(mimeType)}`;
}

export function hasCharacterReferenceImage(characterId?: string): boolean {
  if (!characterId) return false;
  const settings = loadImageGenerationSettings();
  const ref = settings.characterReferences?.[characterId];
  return Boolean(ref?.assetId);
}
