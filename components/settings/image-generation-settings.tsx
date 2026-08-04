"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertCircle, Camera, ChevronDown, Image, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import {
    fetchImageGenerationModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];

// Some relay APIs (e.g. dzzi's gpt-image-2) ignore the `size` param and pick
// their own aspect ratio. As a fallback we append a natural-language ratio hint
// to the prompt, which these models DO respect. The marker lets us replace the
// previously-appended hint instead of stacking them when the size changes.
const RATIO_HINT_MARKER = "[Aspect Ratio]";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "square 1:1 composition",
    "1024x1536": "vertical portrait 2:3 composition",
    "1536x1024": "horizontal landscape 3:2 composition",
};

// Remove any auto-appended ratio hint line(s), preserving the user's own text.
function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER}[^\\n]*`, "g"), "").replace(/\s+$/, "");
}

// Return the prompt with the ratio hint for `size` appended (replacing any
// previous hint). `auto` strips the hint entirely.
function withRatioHint(extraPrompt: string, size: string): string {
    const base = stripRatioHint(extraPrompt);
    const hint = SIZE_RATIO_HINTS[size];
    if (!hint) return base;
    return base ? `${base}\n${RATIO_HINT_MARKER}${hint}` : `${RATIO_HINT_MARKER}${hint}`;
}
const IMAGE_HOSTING_PROVIDER_OPTIONS = [
    { value: "none", label: "No image hosting" },
    { value: "imgbb", label: "ImgBB" },
] as const;
const imageGenerationIconStyle = { "--icon-color": "#0EA5E9" } as CSSProperties;

type Status = { success: boolean; message: string };

export function ImageGenerationSettings() {
    const [settings, setSettings] = useState<ImageGenerationSettingsType>(DEFAULT_IMAGE_GENERATION_SETTINGS);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);

    useEffect(() => {
        // Sync the ratio hint to the saved size on load, so the hint is present
        // by default (not only after the user manually switches the size).
        const loaded = loadImageGenerationSettings();
        const syncedExtra = withRatioHint(loaded.extraPrompt, loaded.size);
        if (syncedExtra !== loaded.extraPrompt) {
            const next = { ...loaded, extraPrompt: syncedExtra };
            saveImageGenerationSettings(next);
            setSettings(next);
        } else {
            setSettings(loaded);
        }
        setCharacters(loadCharacters());
    }, []);

    useEffect(() => {
        let cancelled = false;
        const refs = settings.characterReferences || {};
        Promise.all(Object.entries(refs).map(async ([characterId, ref]) => {
            const dataUrl = ref.assetId ? await getChatImageFromIndexedDB(ref.assetId) : null;
            return [characterId, dataUrl] as const;
        })).then(entries => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [characterId, dataUrl] of entries) {
                if (dataUrl) next[characterId] = dataUrl;
            }
            setReferencePreviews(next);
        });
        return () => { cancelled = true; };
    }, [settings.characterReferences]);

    useEffect(() => {
        return () => {
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
        };
    }, [testPreviewUrl]);

    const persist = useCallback((next: ImageGenerationSettingsType) => {
        setSettings(next);
        saveImageGenerationSettings(next);
    }, []);

    const updateSettings = useCallback((patch: Partial<ImageGenerationSettingsType>) => {
        persist({ ...settings, ...patch });
    }, [persist, settings]);

    // Changing the size also refreshes the auto-appended ratio hint in the
    // Extra Prompt box (replacing any previous hint), so models that ignore the
    // `size` param still produce the requested orientation.
    const applySize = useCallback((size: string) => {
        persist({ ...settings, size, extraPrompt: withRatioHint(settings.extraPrompt, size) });
    }, [persist, settings]);

    const updateImageHosting = useCallback((patch: Partial<ImageGenerationSettingsType["imageHosting"]>) => {
        persist({
            ...settings,
            imageHosting: {
                ...settings.imageHosting,
                ...patch,
            },
        });
    }, [persist, settings]);

    const likelyModels = useMemo(() => filterLikelyImageModels(models), [models]);

    const fetchModels = async () => {
        setStatus(null);
        if (!settings.apiKey.trim() || !settings.baseUrl.trim()) {
            setStatus({ success: false, message: "Please fill in the Base URL and API Key first." });
            return;
        }
        setIsFetchingModels(true);
        try {
            const fetched = await fetchImageGenerationModels(settings);
            setModels(fetched);
            setStatus({
                success: true,
                message: fetched.length > 0 ? `Fetched ${fetched.length} models.` : "The endpoint returned nothing. You can enter the model name manually.",
            });
        } catch (err) {
            setModels([]);
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingModels(false);
        }
    };

    const testGeneration = async () => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({
                description: "A white coffee cup on a desk, soft natural light, realistic photo style",
                settings: { ...settings, enabled: true },
            });
            if (!result) throw new Error("Image generation returned no result.");
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
            setTestPreviewUrl(URL.createObjectURL(result.blob));
            setStatus({ success: true, message: "Test image generated successfully." });
        } catch (err) {
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsTesting(false);
        }
    };

    const uploadReference = async (characterId: string, file: File) => {
        const assetId = await saveChatImageToIndexedDB(file);
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: { assetId, updatedAt: Date.now() },
            },
        });
    };

    const removeReference = (characterId: string) => {
        const nextRefs = { ...(settings.characterReferences || {}) };
        delete nextRefs[characterId];
        persist({ ...settings, characterReferences: nextRefs });
        setReferencePreviews(prev => {
            const next = { ...prev };
            delete next[characterId];
            return next;
        });
    };

    return (
        <div className="flex flex-col gap-6 pb-8">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Image Generation</h2>
            </div>

            <div className="menu-group">
                <div className="menu-item">
                    <span className="card-icon" style={imageGenerationIconStyle}>
                        <Sparkles size={22} strokeWidth={1.75} />
                    </span>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">Enable auto image generation</span>
                        <span className="menu-desc settings-tools-menu-desc">Automatically calls the image generation API when the character outputs a photo tag.</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.enabled} onChange={(enabled) => updateSettings({ enabled })} className="settings-toggle-control" />
                    </span>
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">Request method</label>
                    <Select
                        value={settings.requestMode}
                        onChange={(event) => updateSettings({
                            requestMode: event.target.value as ImageGenerationSettingsType["requestMode"],
                        })}
                    >
                        <option value="server">Server-side relay</option>
                        <option value="direct">Direct browser connection</option>
                    </Select>
                    <span className="menu-desc ml-1">
                        Direct browser connection requests the image generation API straight from this device, bypassing deployment-platform function timeouts; the endpoint must allow CORS.
                    </span>
                </div>

                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">Base URL</label>
                    <Input
                        type="url"
                        value={settings.baseUrl}
                        onChange={(event) => updateSettings({ baseUrl: event.target.value })}
                        placeholder="https://api.example.com/v1"
                    />
                </div>

                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">API Key</label>
                    <Input
                        type="password"
                        value={settings.apiKey}
                        onChange={(event) => updateSettings({ apiKey: event.target.value })}
                        placeholder="sk-..."
                    />
                </div>

                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">Model name</label>
                    <div className="flex gap-2">
                        {/* Single combined field: type manually; after fetching models, a dropdown arrow appears on the right -- open the native picker to select and fill it in */}
                        <div className="relative flex-1">
                            <Input
                                type="text"
                                value={settings.model}
                                onChange={(event) => updateSettings({ model: event.target.value })}
                                placeholder="gpt-image-2 / image2 / chatgpt-image-latest"
                                className={likelyModels.length > 0 ? "w-full pr-9" : "w-full"}
                            />
                            {likelyModels.length > 0 && (
                                <>
                                    <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                    <select
                                        aria-label="Select a fetched model"
                                        value=""
                                        onChange={(event) => {
                                            if (event.target.value) updateSettings({ model: event.target.value });
                                        }}
                                        className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                    >
                                        <option value="">Select a fetched model...</option>
                                        {likelyModels.map(model => <option key={model} value={model}>{model}</option>)}
                                    </select>
                                </>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={fetchModels}
                            disabled={isFetchingModels}
                            className="ui-btn ui-btn-soft-action shrink-0"
                        >
                            <RefreshCw size={16} className={isFetchingModels ? "animate-spin" : ""} />
                            {isFetchingModels ? "Fetching" : "Fetch models"}
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">Size</label>
                        <Select value={settings.size} onChange={(event) => applySize(event.target.value)}>
                            {SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                        </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">Quality</label>
                        <Select value={settings.quality} onChange={(event) => updateSettings({ quality: event.target.value })}>
                            {QUALITY_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                        </Select>
                    </div>
                </div>

                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">Extra prompt</label>
                    <Textarea
                        value={settings.extraPrompt}
                        onChange={(event) => updateSettings({ extraPrompt: event.target.value })}
                        placeholder="Sent to the image model together with the character's photo description."
                        rows={4}
                    />
                    <p className="menu-desc ml-1 opacity-70">
                        After choosing a size, a composition hint like "{RATIO_HINT_MARKER}..." is automatically appended at the end, to correct APIs that ignore the size parameter (e.g. gpt-image-2). You can edit or remove it manually.
                    </p>
                </div>

                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={testGeneration}
                        disabled={isTesting}
                        className="ui-btn ui-btn-success flex-1"
                    >
                        <Image size={16} />
                        {isTesting ? "Testing..." : "Test generation"}
                    </button>
                </div>

                {status && (
                    <Alert variant={status.success ? "success" : "danger"}>
                        <AlertCircle size={16} className="mt-[2px] shrink-0" />
                        <span className="break-all leading-[1.5]">{status.message}</span>
                    </Alert>
                )}
                {testPreviewUrl && (
                    <img
                        src={testPreviewUrl}
                        alt="Test generation result"
                        className="max-h-[220px] max-w-full self-start rounded-xl border border-[var(--c-card-border)] object-contain"
                    />
                )}
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Image Hosting</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={imageGenerationIconStyle}>
                            <Upload size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">Allow the mascot to upload to image hosting</span>
                            <span className="menu-desc settings-tools-menu-desc">When enabled, the mascot's image toolkit can upload local assets to public image hosting and use the URL in CSS.</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.allowMascotUpload}
                                onChange={(allowMascotUpload) => updateImageHosting({ allowMascotUpload })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                <div className="menu-group p-4 flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">Image hosting provider</label>
                        <Select
                            value={settings.imageHosting.provider}
                            onChange={(event) => updateImageHosting({
                                provider: event.target.value as ImageGenerationSettingsType["imageHosting"]["provider"],
                            })}
                        >
                            {IMAGE_HOSTING_PROVIDER_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">ImgBB API Key</label>
                        <Input
                            type="password"
                            value={settings.imageHosting.imgbbApiKey}
                            onChange={(event) => updateImageHosting({ imgbbApiKey: event.target.value })}
                            placeholder="Get it from imgbb.com/api/1"
                            disabled={settings.imageHosting.provider !== "imgbb"}
                        />
                        <span className="menu-desc ml-1">The key is only stored in this project's settings; it won't be shown in the mascot's tool results.</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Default expiration (seconds)</label>
                            <Input
                                type="number"
                                min={0}
                                max={15552000}
                                value={settings.imageHosting.defaultExpirationSeconds}
                                onChange={(event) => updateImageHosting({
                                    defaultExpirationSeconds: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">0 means never expires.</span>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Upload limit (KB)</label>
                            <Input
                                type="number"
                                min={64}
                                max={32768}
                                value={Math.round(settings.imageHosting.maxUploadBytes / 1024)}
                                onChange={(event) => updateImageHosting({
                                    maxUploadBytes: Math.max(64, Number.parseInt(event.target.value, 10) || 900) * 1024,
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">Default 900KB, suitable for CSS theme assets.</span>
                        </div>
                    </div>

                    <div className="menu-item !px-0 !py-0">
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">Auto-convert to WebP before upload</span>
                            <span className="menu-desc settings-tools-menu-desc">Reduces PNG/JPEG size; GIF keeps its original format.</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.autoConvertToWebp}
                                onChange={(autoConvertToWebp) => updateImageHosting({ autoConvertToWebp })}
                                className="settings-toggle-control"
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Character References</p>
                <div className="menu-group">
                    {characters.length === 0 ? (
                        <div className="ui-empty py-8">
                            <Camera size={22} />
                            <span className="menu-desc">No characters yet.</span>
                        </div>
                    ) : characters.map(character => {
                        const preview = referencePreviews[character.id];
                        return (
                            <div key={character.id} className="menu-item">
                                <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                                    {preview ? (
                                        <img src={preview} alt="" className="h-full w-full object-cover" />
                                    ) : character.avatar ? (
                                        <img src={character.avatar} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <span className="flex h-full w-full items-center justify-center ts-13 font-semibold text-[var(--c-icon)]">
                                            {character.name.slice(0, 1)}
                                        </span>
                                    )}
                                </span>
                                <span className="min-w-0 flex flex-1 flex-col">
                                    <span className="menu-label truncate">{character.name}</span>
                                    <span className="menu-desc truncate">{preview ? "Reference image uploaded" : "No reference image uploaded"}</span>
                                </span>
                                <span className="menu-right flex gap-2">
                                    <button
                                        type="button"
                                        className="ui-link-btn"
                                        aria-label={`Upload reference image for ${character.name}`}
                                        onClick={() => {
                                            const input = document.createElement("input");
                                            input.type = "file";
                                            input.accept = "image/*";
                                            input.onchange = async () => {
                                                const file = input.files?.[0];
                                                if (file) await uploadReference(character.id, file);
                                            };
                                            input.click();
                                        }}
                                    >
                                        <Upload size={18} />
                                    </button>
                                    {preview && (
                                        <button
                                            type="button"
                                            className="ui-link-btn"
                                            data-variant="danger"
                                            aria-label={`Delete reference image for ${character.name}`}
                                            onClick={() => removeReference(character.id)}
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>

        </div>
    );
}
