"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, Camera, ChevronDown, Image, Info, Plus, Power, RefreshCw, ScanFace, Sparkles, Trash2, Upload } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType, NovelAiPreset, NovelAiSettings, OpenAiImagePreset } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    DEFAULT_NOVELAI_PRESET,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import {
    fetchImageGenerationModels,
    fetchNovelAiModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import {
    NOVELAI_COMMON_MODELS,
    NOVELAI_NOISE_SCHEDULE_OPTIONS,
    NOVELAI_RESOLUTION_OPTIONS,
    NOVELAI_SAMPLER_OPTIONS,
} from "@/lib/novelai-image-config";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];

// Some relay APIs (e.g. gpt-image-2 on certain relays) ignore the `size` param and pick
// their own aspect ratio. As a fallback we append a natural-language ratio hint
// to the prompt, which these models DO respect. The marker lets us replace the
// previously-appended hint instead of stacking them when the size changes.
const RATIO_HINT_MARKER = "[Aspect Ratio]";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "square 1:1 composition",
    "1024x1536": "vertical portrait 2:3 composition",
    "1536x1024": "horizontal landscape 3:2 composition",
};

// The marker contains regex metacharacters, so it MUST be escaped before being
// interpolated into a RegExp. Unescaped, `[Aspect Ratio]` compiles to a character
// class matching any single one of "AspectRaio" — so the pattern became
// "\s*<any of those letters><rest of line>", which silently truncated almost every
// Extra prompt at its first such character and then persisted the damage (the
// on-mount sync below saves the result). Ordinary prose like
// "a warm domestic scene" was deleted entirely.
const RATIO_HINT_MARKER_PATTERN = RATIO_HINT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Remove any auto-appended ratio hint line(s), preserving the user's own text.
function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER_PATTERN}[^\\n]*`, "g"), "").replace(/\s+$/, "");
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
    const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
    const [cropCharacterId, setCropCharacterId] = useState<string | null>(null);
    const [cropDraft, setCropDraft] = useState({ x: 0.27, y: 0.12, size: 0.46 });
    const [cropViewport, setCropViewport] = useState({ width: 0, height: 0 });
    const cropContainerRef = useRef<HTMLDivElement | null>(null);
    const cropDragRef = useRef<{ pointerId: number; startX: number; startY: number; cropX: number; cropY: number } | null>(null);
    const characterListRef = useRef<HTMLDivElement | null>(null);
    const characterScrollDragRef = useRef<{
        pointerId: number;
        startY: number;
        startScrollTop: number;
        maxScroll: number;
        maxThumbTravel: number;
    } | null>(null);
    const [characterScrollMetrics, setCharacterScrollMetrics] = useState({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [naiModels, setNaiModels] = useState<string[]>(NOVELAI_COMMON_MODELS);
    const [isFetchingNaiModels, setIsFetchingNaiModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [naiTokenStatus, setNaiTokenStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);
    const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null);
    const [pendingDeleteOpenAiPresetId, setPendingDeleteOpenAiPresetId] = useState<string | null>(null);
    const openaiPresets = useMemo<OpenAiImagePreset[]>(() => (
        settings.openaiPresets?.length ? settings.openaiPresets : [{
            id: "preset_openai_default",
            name: "Default preset",
            requestMode: settings.requestMode,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.model,
            size: settings.size,
            quality: settings.quality,
            extraPrompt: settings.extraPrompt,
        }]
    ), [settings]);
    const activeOpenAiPresetId = settings.activeOpenAiPresetId && openaiPresets.some(p => p.id === settings.activeOpenAiPresetId)
        ? settings.activeOpenAiPresetId
        : openaiPresets[0].id;
    const activeOpenAiPreset = openaiPresets.find(p => p.id === activeOpenAiPresetId) || openaiPresets[0];

    useEffect(() => {
        // Sync the ratio hint to the saved size on load, so the hint is present
        // by default (not only after the user manually switches the size).
        const loaded = loadImageGenerationSettings();
        const loadedPresets = loaded.openaiPresets?.length ? loaded.openaiPresets : [{
            id: "preset_openai_default",
            name: "Default preset",
            requestMode: loaded.requestMode,
            apiKey: loaded.apiKey,
            baseUrl: loaded.baseUrl,
            model: loaded.model,
            size: loaded.size,
            quality: loaded.quality,
            extraPrompt: loaded.extraPrompt,
        } satisfies OpenAiImagePreset];
        const loadedActiveId = loaded.activeOpenAiPresetId && loadedPresets.some(preset => preset.id === loaded.activeOpenAiPresetId)
            ? loaded.activeOpenAiPresetId
            : loadedPresets[0].id;
        const loadedActivePreset = loadedPresets.find(preset => preset.id === loadedActiveId) || loadedPresets[0];
        const syncedExtra = withRatioHint(loadedActivePreset.extraPrompt, loadedActivePreset.size);
        if (syncedExtra !== loadedActivePreset.extraPrompt) {
            const nextPresets = loadedPresets.map(preset => preset.id === loadedActiveId
                ? { ...preset, extraPrompt: syncedExtra }
                : preset);
            const next = { ...loaded, openaiPresets: nextPresets, activeOpenAiPresetId: loadedActiveId, extraPrompt: syncedExtra };
            saveImageGenerationSettings(next);
            setSettings(next);
        } else {
            setSettings(loaded);
        }
        const loadedCharacters = loadCharacters();
        setCharacters(loadedCharacters);
        setSelectedCharacterId(loadedCharacters[0]?.id || null);
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

    const syncCharacterScrollMetrics = useCallback(() => {
        const list = characterListRef.current;
        if (!list) return;
        setCharacterScrollMetrics({
            scrollTop: list.scrollTop,
            clientHeight: list.clientHeight,
            scrollHeight: list.scrollHeight,
        });
    }, []);

    useEffect(() => {
        const frame = window.requestAnimationFrame(syncCharacterScrollMetrics);
        window.addEventListener("resize", syncCharacterScrollMetrics);
        return () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener("resize", syncCharacterScrollMetrics);
        };
    }, [characters, syncCharacterScrollMetrics]);

    const persist = useCallback((next: ImageGenerationSettingsType) => {
        setSettings(next);
        saveImageGenerationSettings(next);
    }, []);

    const updateSettings = useCallback((patch: Partial<ImageGenerationSettingsType>) => {
        persist({ ...settings, ...patch });
    }, [persist, settings]);

    const updateOpenAiPreset = useCallback((patch: Partial<OpenAiImagePreset>) => {
        const nextPresets = openaiPresets.map(preset => preset.id === activeOpenAiPresetId ? { ...preset, ...patch } : preset);
        const active = nextPresets.find(preset => preset.id === activeOpenAiPresetId) || nextPresets[0];
        persist({ ...settings, openaiPresets: nextPresets, activeOpenAiPresetId, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const addOpenAiPreset = useCallback(() => {
        const newId = `preset_openai_${Date.now()}`;
        const newPreset = { ...activeOpenAiPreset, id: newId, name: `${activeOpenAiPreset.name || "Default preset"} (Copy)` };
        persist({ ...settings, openaiPresets: [...openaiPresets, newPreset], activeOpenAiPresetId: newId, requestMode: newPreset.requestMode, apiKey: newPreset.apiKey, baseUrl: newPreset.baseUrl, model: newPreset.model, size: newPreset.size, quality: newPreset.quality, extraPrompt: newPreset.extraPrompt });
    }, [activeOpenAiPreset, openaiPresets, persist, settings]);

    const deleteOpenAiPreset = useCallback(() => {
        if (openaiPresets.length <= 1) return;
        const next = openaiPresets.filter(preset => preset.id !== activeOpenAiPresetId);
        const active = next[0];
        persist({ ...settings, openaiPresets: next, activeOpenAiPresetId: active.id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const selectOpenAiPreset = useCallback((id: string) => {
        const active = openaiPresets.find(preset => preset.id === id);
        if (!active) return;
        persist({ ...settings, activeOpenAiPresetId: id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [openaiPresets, persist, settings]);

    // NovelAI preset management + status
    const naiSettings = useMemo(() => {
        const nai = settings.novelai;
        const presets = nai?.presets && nai.presets.length > 0 ? nai.presets : [DEFAULT_NOVELAI_PRESET];
        const activePreset = presets.find(p => p.id === nai?.activePresetId) || presets[0];
        return {
            apiKey: nai?.apiKey || "",
            requestMode: nai?.requestMode || settings.requestMode,
            activePresetId: activePreset.id,
            presets,
            activePreset,
        };
    }, [settings.novelai, settings.requestMode]);

    const updateNovelAi = useCallback((patch: Partial<NovelAiSettings>) => {
        persist({
            ...settings,
            novelai: {
                apiKey: naiSettings.apiKey,
                requestMode: naiSettings.requestMode,
                activePresetId: naiSettings.activePresetId,
                presets: naiSettings.presets,
                ...patch,
            },
        });
    }, [naiSettings, persist, settings]);

    const updateActivePreset = useCallback((patch: Partial<NovelAiPreset>) => {
        const nextPresets = naiSettings.presets.map(p => {
            if (p.id === naiSettings.activePresetId) {
                return { ...p, ...patch };
            }
            return p;
        });
        updateNovelAi({ presets: nextPresets });
    }, [naiSettings, updateNovelAi]);

    const addPreset = useCallback(() => {
        const newId = `preset_nai_${Date.now()}`;
        const newPreset: NovelAiPreset = {
            ...naiSettings.activePreset,
            id: newId,
            name: `${naiSettings.activePreset.name} (Copy)`,
        };
        updateNovelAi({
            presets: [...naiSettings.presets, newPreset],
            activePresetId: newId,
        });
    }, [naiSettings, updateNovelAi]);

    const deletePreset = useCallback((presetId: string) => {
        if (naiSettings.presets.length <= 1) return;
        const deletedIndex = naiSettings.presets.findIndex(p => p.id === presetId);
        if (deletedIndex < 0) return;
        const nextPresets = naiSettings.presets.filter(p => p.id !== presetId);
        const nextActivePreset = nextPresets[Math.min(deletedIndex, nextPresets.length - 1)];
        updateNovelAi({
            presets: nextPresets,
            activePresetId: nextActivePreset.id,
        });
    }, [naiSettings, updateNovelAi]);

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
        if (!activeOpenAiPreset.apiKey.trim() || !activeOpenAiPreset.baseUrl.trim()) {
            setStatus({ success: false, message: "Please fill in the Base URL and API Key first." });
            return;
        }
        setIsFetchingModels(true);
        try {
            const fetched = await fetchImageGenerationModels(activeOpenAiPreset);
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

    const fetchNaiModels = async () => {
        setNaiTokenStatus(null);
        if (!naiSettings.apiKey.trim()) {
            setNaiTokenStatus({ success: false, message: "Please fill in the NovelAI API Token first." });
            return;
        }
        setIsFetchingNaiModels(true);
        try {
            const fetched = await fetchNovelAiModels(naiSettings.apiKey);
            setNaiModels(fetched);
            setNaiTokenStatus({
                success: true,
                message: `NovelAI Token is valid; loaded ${fetched.length} common models.`,
            });
        } catch (err) {
            setNaiTokenStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingNaiModels(false);
        }
    };

    const testGeneration = async () => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({
                description: settings.provider === "novelai"
                    ? "1girl, solo, upper body, white coffee cup on the wooden table, soft window light"
                    : "A white coffee cup on a desk, soft natural light, realistic photo style",
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
        const current = settings.characterReferences?.[characterId];
        const faceCrop = current?.faceCrop || { x: 0.27, y: 0.12, size: 0.46 };
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: {
                    ...current,
                    assetId,
                    updatedAt: Date.now(),
                    enabled: true,
                    faceCrop,
                },
            },
        });
        setCropDraft(faceCrop);
        setCropCharacterId(characterId);
    };

    const updateCharacterReference = (
        characterId: string,
        patch: Partial<ImageGenerationSettingsType["characterReferences"][string]>,
    ) => {
        const current = settings.characterReferences?.[characterId];
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: {
                    ...current,
                    ...patch,
                    updatedAt: Date.now(),
                },
            },
        });
    };

    const openFaceCrop = (characterId: string) => {
        const crop = settings.characterReferences?.[characterId]?.faceCrop || { x: 0.27, y: 0.12, size: 0.46 };
        setCropDraft(crop);
        setCropViewport({ width: 0, height: 0 });
        setCropCharacterId(characterId);
    };

    const updateCropViewport = () => {
        const rect = cropContainerRef.current?.getBoundingClientRect();
        if (rect) setCropViewport({ width: rect.width, height: rect.height });
    };

    const handleCropPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        cropDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            cropX: cropDraft.x,
            cropY: cropDraft.y,
        };
    };

    const handleCropPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = cropDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !cropViewport.width || !cropViewport.height) return;
        const side = cropDraft.size * Math.min(cropViewport.width, cropViewport.height);
        const maxX = Math.max(0, 1 - side / cropViewport.width);
        const maxY = Math.max(0, 1 - side / cropViewport.height);
        setCropDraft(current => ({
            ...current,
            x: Math.max(0, Math.min(maxX, drag.cropX + (event.clientX - drag.startX) / cropViewport.width)),
            y: Math.max(0, Math.min(maxY, drag.cropY + (event.clientY - drag.startY) / cropViewport.height)),
        }));
    };

    const handleCropPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (cropDragRef.current?.pointerId === event.pointerId) cropDragRef.current = null;
    };

    const handleCharacterScrollPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const list = characterListRef.current;
        const track = event.currentTarget.parentElement?.getBoundingClientRect();
        const thumb = event.currentTarget.getBoundingClientRect();
        if (!list || !track) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        characterScrollDragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startScrollTop: list.scrollTop,
            maxScroll: Math.max(0, list.scrollHeight - list.clientHeight),
            maxThumbTravel: Math.max(1, track.height - thumb.height),
        };
    };

    const handleCharacterScrollPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = characterScrollDragRef.current;
        const list = characterListRef.current;
        if (!drag || !list || drag.pointerId !== event.pointerId) return;
        const delta = event.clientY - drag.startY;
        list.scrollTop = Math.max(0, Math.min(drag.maxScroll, drag.startScrollTop + delta / drag.maxThumbTravel * drag.maxScroll));
        syncCharacterScrollMetrics();
    };

    const handleCharacterScrollPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (characterScrollDragRef.current?.pointerId === event.pointerId) characterScrollDragRef.current = null;
    };

    const selectedCharacter = characters.find(character => character.id === selectedCharacterId) || null;
    const selectedReference = selectedCharacter ? settings.characterReferences?.[selectedCharacter.id] : undefined;
    const characterListOverflows = characterScrollMetrics.scrollHeight > characterScrollMetrics.clientHeight + 1;
    const characterScrollThumbPercent = characterListOverflows
        ? Math.max(14, characterScrollMetrics.clientHeight / characterScrollMetrics.scrollHeight * 100)
        : 100;
    const characterScrollTopPercent = characterListOverflows
        ? (characterScrollMetrics.scrollTop / Math.max(1, characterScrollMetrics.scrollHeight - characterScrollMetrics.clientHeight))
            * (100 - characterScrollThumbPercent)
        : 0;

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
                    <label className="menu-desc ml-1">Image generation provider / engine</label>
                    <Select
                        value={settings.provider || "openai"}
                        onChange={(event) => updateSettings({
                            provider: event.target.value as "openai" | "novelai",
                        })}
                    >
                        <option value="openai">OpenAI-compatible (general models / DALL-E / Flux / SD relay, etc.)</option>
                        <option value="novelai">NovelAI native API (official)</option>
                    </Select>
                </div>

                {settings.provider === "novelai" && (
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">Request method</label>
                        <Select
                            value={naiSettings.requestMode}
                            onChange={(event) => updateNovelAi({
                                requestMode: event.target.value as ImageGenerationSettingsType["requestMode"],
                            })}
                        >
                            <option value="server">Server-side relay (recommended, avoids CORS errors)</option>
                            <option value="direct">Direct browser connection (requires the endpoint to allow CORS)</option>
                        </Select>
                    </div>
                )}

                {settings.provider === "novelai" ? (
                    /* --- NovelAI configuration panel --- */
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">NovelAI API Token</label>
                            <Input
                                type="password"
                                value={naiSettings.apiKey}
                                onChange={(event) => {
                                    updateNovelAi({ apiKey: event.target.value });
                                    setNaiTokenStatus(null);
                                }}
                                placeholder="pst-..."
                            />
                            <span className="menu-desc ml-1">Get a Persistent API Token from the Account page on the NovelAI website.</span>
                            {naiTokenStatus && (
                                <div role={naiTokenStatus.success ? "status" : "alert"} className="mt-2">
                                    <Alert variant={naiTokenStatus.success ? "success" : "danger"}>
                                        <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                        <span className="break-all leading-[1.5]">{naiTokenStatus.message}</span>
                                    </Alert>
                                </div>
                            )}
                        </div>

                        {/* Preset management bar */}
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">NovelAI parameter presets</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                                    <button
                                        type="button"
                                        onClick={addPreset}
                                        className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                        title="Duplicate the current preset"
                                    >
                                        <Plus size={14} />
                                        New preset
                                    </button>
                                    {naiSettings.presets.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => setPendingDeletePresetId(naiSettings.activePresetId)}
                                            className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                            title="Delete the currently selected preset"
                                        >
                                            <Trash2 size={14} />
                                            Delete preset
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">Switch preset</span>
                                    <Select
                                        value={naiSettings.activePresetId}
                                        onChange={(event) => updateNovelAi({ activePresetId: event.target.value })}
                                    >
                                        {naiSettings.presets.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">Preset name</span>
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.name}
                                        onChange={(event) => updateActivePreset({ name: event.target.value })}
                                        placeholder="Preset name"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Preset parameters */}
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Model</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.model}
                                        onChange={(event) => updateActivePreset({ model: event.target.value })}
                                        placeholder="nai-diffusion-4-curated-preview"
                                        className={naiModels.length > 0 ? "w-full pr-9" : "w-full"}
                                    />
                                    {naiModels.length > 0 && (
                                        <>
                                            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                            <select
                                                aria-label="Select a common NovelAI model"
                                                value=""
                                                onChange={(event) => {
                                                    if (event.target.value) updateActivePreset({ model: event.target.value });
                                                }}
                                                className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                            >
                                                <option value="">Quick-select a model...</option>
                                                {naiModels.map(m => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={fetchNaiModels}
                                    disabled={isFetchingNaiModels}
                                    className="ui-btn ui-btn-soft-action min-h-11 shrink-0"
                                >
                                    <RefreshCw size={16} className={isFetchingNaiModels ? "animate-spin" : ""} />
                                    {isFetchingNaiModels ? "Verifying" : "Verify Token"}
                                </button>
                            </div>
                            <span className="menu-desc ml-1 opacity-70">The model dropdown is built into the app; "Verify Token" only checks the credential, it does not generate an image.</span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Resolution</label>
                            <Select
                                value={naiSettings.activePreset.resolution}
                                onChange={(event) => updateActivePreset({ resolution: event.target.value })}
                            >
                                {NOVELAI_RESOLUTION_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">Sampler</label>
                                <Select
                                    value={naiSettings.activePreset.sampler}
                                    onChange={(event) => updateActivePreset({ sampler: event.target.value })}
                                >
                                    {NOVELAI_SAMPLER_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">Noise Schedule</label>
                                <Select
                                    value={naiSettings.activePreset.noiseSchedule || "karras"}
                                    onChange={(event) => updateActivePreset({ noiseSchedule: event.target.value })}
                                >
                                    {NOVELAI_NOISE_SCHEDULE_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">Steps ({naiSettings.activePreset.steps})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={naiSettings.activePreset.steps}
                                    onChange={(event) => updateActivePreset({
                                        steps: Math.max(1, Math.min(50, parseInt(event.target.value, 10) || 28)),
                                    })}
                                />
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">Prompt Guidance (CFG Scale: {naiSettings.activePreset.scale})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={30}
                                    step={0.1}
                                    value={naiSettings.activePreset.scale}
                                    onChange={(event) => updateActivePreset({
                                        scale: Math.max(1, Math.min(30, parseFloat(event.target.value) || 6.0)),
                                    })}
                                />
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Artist tags / positive quality prompt</label>
                            <Textarea
                                value={naiSettings.activePreset.positivePrompt}
                                onChange={(event) => updateActivePreset({ positivePrompt: event.target.value })}
                                placeholder="masterpiece, best quality, very aesthetic, artist:..."
                                rows={3}
                            />
                            <span className="menu-desc ml-1 opacity-70">
                                Sent together with the character's chat-generated scene description, as the base style.
                            </span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Negative prompt (undesired content)</label>
                            <Textarea
                                value={naiSettings.activePreset.negativePrompt}
                                onChange={(event) => updateActivePreset({ negativePrompt: event.target.value })}
                                placeholder="lowres, bad anatomy, bad hands, blurry..."
                                rows={3}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2 pt-1">
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.qualityToggle !== false}
                                    onChange={(e) => updateActivePreset({ qualityToggle: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">Enable quality tags (Quality+)</span>
                            </label>
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.smea === true}
                                    onChange={(e) => updateActivePreset({ smea: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">Enable SMEA</span>
                            </label>
                        </div>
                    </>
                ) : (
                    /* --- OpenAI-compatible configuration panel --- */
                    <>
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">OpenAI API configuration presets</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex">
                                    <button type="button" onClick={addOpenAiPreset} className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"><Plus size={14} />New preset</button>
                                    {openaiPresets.length > 1 && <button type="button" onClick={() => setPendingDeleteOpenAiPresetId(activeOpenAiPresetId)} className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"><Trash2 size={14} />Delete preset</button>}
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">Current preset</span>
                                    <Select value={activeOpenAiPresetId} onChange={(event) => selectOpenAiPreset(event.target.value)}>
                                        {openaiPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name.trim() || "Unnamed preset"}</option>)}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">Preset note</span>
                                    <Input type="text" value={activeOpenAiPreset.name} onChange={(event) => updateOpenAiPreset({ name: event.target.value })} placeholder="Unnamed preset" />
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Request method</label>
                            <Select value={activeOpenAiPreset.requestMode} onChange={(event) => updateOpenAiPreset({ requestMode: event.target.value as ImageGenerationSettingsType["requestMode"] })}>
                                <option value="server">Server-side relay (recommended, avoids CORS errors)</option>
                                <option value="direct">Direct browser connection (requires the endpoint to allow CORS)</option>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Base URL</label>
                            <Input
                                type="url"
                                value={activeOpenAiPreset.baseUrl}
                                onChange={(event) => updateOpenAiPreset({ baseUrl: event.target.value })}
                                placeholder="https://api.example.com/v1"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">API Key</label>
                            <Input
                                type="password"
                                value={activeOpenAiPreset.apiKey}
                                onChange={(event) => updateOpenAiPreset({ apiKey: event.target.value })}
                                placeholder="sk-..."
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Model name</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={activeOpenAiPreset.model}
                                        onChange={(event) => updateOpenAiPreset({ model: event.target.value })}
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
                                                    if (event.target.value) updateOpenAiPreset({ model: event.target.value });
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
                                <Select value={activeOpenAiPreset.size} onChange={(event) => {
                                        const size = event.target.value;
                                        updateOpenAiPreset({ size, extraPrompt: withRatioHint(activeOpenAiPreset.extraPrompt, size) });
                                    }}>
                                    {SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">Quality</label>
                                <Select value={activeOpenAiPreset.quality} onChange={(event) => updateOpenAiPreset({ quality: event.target.value })}>
                                    {QUALITY_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                                </Select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Extra prompt</label>
                            <Textarea
                                value={activeOpenAiPreset.extraPrompt}
                                onChange={(event) => updateOpenAiPreset({ extraPrompt: event.target.value })}
                                placeholder="Sent to the image model together with the character's photo description."
                                rows={4}
                            />
                            <p className="menu-desc ml-1 opacity-70">
                                After choosing a size, a composition hint like "{RATIO_HINT_MARKER}..." is automatically appended at the end, to correct APIs that ignore the size parameter (e.g. gpt-image-2). You can edit or remove it manually.
                            </p>
                        </div>
                    </>
                )}

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
                    <div role={status.success ? "status" : "alert"}>
                        <Alert variant={status.success ? "success" : "danger"}>
                            <AlertCircle size={16} className="mt-[2px] shrink-0" />
                            <span className="break-all leading-[1.5]">{status.message}</span>
                        </Alert>
                    </div>
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
                <p className="settings-menu-section-title">Character Identity</p>
                {settings.provider === "novelai" && (
                    <Alert variant="info">
                        <Info size={16} className="mt-[2px] shrink-0" />
                        <span className="leading-[1.5]">NovelAI uses the character's own feature prompt, but doesn't read the reference image yet; switching back to the OpenAI-compatible engine keeps the reference image intact.</span>
                    </Alert>
                )}
                <div className="relative">
                    <div
                        ref={characterListRef}
                        className="menu-group max-h-[292px] overflow-y-auto overscroll-contain pr-3"
                        onScroll={syncCharacterScrollMetrics}
                    >
                        {characters.length === 0 ? (
                            <div className="ui-empty py-8">
                                <Camera size={22} />
                                <span className="menu-desc">No characters yet.</span>
                            </div>
                        ) : characters.map(character => {
                            const preview = referencePreviews[character.id];
                            const ref = settings.characterReferences?.[character.id];
                            return (
                                <button
                                    key={character.id}
                                    type="button"
                                    className={`menu-item w-full text-left ${selectedCharacterId === character.id ? "bg-[var(--c-input)]" : ""}`}
                                    onClick={() => setSelectedCharacterId(character.id)}
                                >
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
                                        <span className="menu-desc truncate">
                                            {preview ? (ref?.enabled === false ? "Reference image disabled" : "Reference image enabled") : "No reference image uploaded"}
                                            {ref?.featurePrompt?.trim() ? " · Feature prompt set" : ""}
                                        </span>
                                    </span>
                                    <ChevronDown size={16} className={selectedCharacterId === character.id ? "-rotate-90 opacity-70" : "opacity-40"} />
                                </button>
                            );
                        })}
                    </div>
                    {characterListOverflows && (
                        <div className="pointer-events-auto absolute bottom-3 right-1 top-3 z-10 w-1.5 rounded-full bg-black/10">
                            <button
                                type="button"
                                aria-label="Drag the character list scrollbar"
                                className="absolute left-0 w-1.5 touch-none rounded-full bg-black/45 shadow-sm"
                                style={{
                                    height: `${characterScrollThumbPercent}%`,
                                    top: `${characterScrollTopPercent}%`,
                                }}
                                onPointerDown={handleCharacterScrollPointerDown}
                                onPointerMove={handleCharacterScrollPointerMove}
                                onPointerUp={handleCharacterScrollPointerUp}
                                onPointerCancel={handleCharacterScrollPointerUp}
                            />
                        </div>
                    )}
                </div>

                {selectedCharacter && (
                    <div className="menu-group p-4 flex flex-col gap-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="menu-label truncate">{selectedCharacter.name} · Image generation settings</div>
                                <div className="menu-desc">Only affects this character; doesn't change the character card's own text.</div>
                            </div>
                            {referencePreviews[selectedCharacter.id] && (
                                <button
                                    type="button"
                                    className={`ui-btn shrink-0 ${selectedReference?.enabled === false ? "ui-btn-primary" : "ui-btn-outline"}`}
                                    onClick={() => updateCharacterReference(selectedCharacter.id, { enabled: selectedReference?.enabled === false })}
                                >
                                    <Power size={16} />
                                    {selectedReference?.enabled === false ? "Enable reference image" : "Disable reference image"}
                                </button>
                            )}
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Character-specific feature prompt</label>
                            <Textarea
                                value={selectedReference?.featurePrompt || ""}
                                onChange={(event) => updateCharacterReference(selectedCharacter.id, { featurePrompt: event.target.value })}
                                placeholder="e.g. long black wavy hair, grey-blue eyes, a small mole under the left eye, an aloof air..."
                                rows={4}
                            />
                            <span className="menu-desc ml-1">Automatically appended whenever an image is generated for this character; applies to both OpenAI and NovelAI.</span>
                        </div>

                        {settings.provider === "novelai" && (
                            <div className="menu-item !px-0 !py-0">
                                <span className="settings-tools-menu-copy">
                                    <span className="menu-label appearance-menu-item-label">NovelAI uses the character-specific prompt</span>
                                    <span className="menu-desc settings-tools-menu-desc">When off, NovelAI only uses the current scene description and preset, without appending the feature prompt above.</span>
                                </span>
                                <span className="menu-right settings-tools-menu-toggle">
                                    <Toggle
                                        checked={selectedReference?.novelAiFeaturePromptEnabled !== false}
                                        onChange={(novelAiFeaturePromptEnabled) => updateCharacterReference(selectedCharacter.id, { novelAiFeaturePromptEnabled })}
                                        className="settings-toggle-control"
                                    />
                                </span>
                            </div>
                        )}

                        {settings.provider !== "novelai" && (
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-soft-action flex-1"
                                    onClick={() => {
                                        const input = document.createElement("input");
                                        input.type = "file";
                                        input.accept = "image/*";
                                        input.onchange = async () => {
                                            const file = input.files?.[0];
                                            if (file) await uploadReference(selectedCharacter.id, file);
                                        };
                                        input.click();
                                    }}
                                >
                                    <Upload size={16} />
                                    {referencePreviews[selectedCharacter.id] ? "Change reference image" : "Select reference image"}
                                </button>
                                {referencePreviews[selectedCharacter.id] && (
                                    <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => openFaceCrop(selectedCharacter.id)}>
                                        <ScanFace size={16} />
                                        Select face
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {cropCharacterId && referencePreviews[cropCharacterId] && (
                <ContentDialog
                    title="Select the face-lock region"
                    confirmLabel="Save selection"
                    cancelLabel="Cancel"
                    onCancel={() => setCropCharacterId(null)}
                    onConfirm={() => {
                        updateCharacterReference(cropCharacterId, { faceCrop: cropDraft, enabled: true });
                        setCropCharacterId(null);
                    }}
                >
                    <div className="flex flex-col gap-3">
                        <p className="menu-desc">Drag the box to cover the character's face; only this region is cropped when the reference image is sent, cutting down on clothing/background interference.</p>
                        <div ref={cropContainerRef} className="relative mx-auto w-fit max-h-[52vh] max-w-full overflow-hidden rounded-xl bg-black/80">
                            <img
                                src={referencePreviews[cropCharacterId]}
                                alt="Reference image face selection"
                                draggable={false}
                                className="block max-h-[52vh] max-w-full select-none object-contain"
                                onLoad={updateCropViewport}
                            />
                            {cropViewport.width > 0 && cropViewport.height > 0 && (
                                <button
                                    type="button"
                                    aria-label="Drag the face selection"
                                    className="absolute cursor-move touch-none border-2 border-white bg-white/10 shadow-[0_0_0_999px_rgba(0,0,0,0.42)]"
                                    style={{
                                        left: cropDraft.x * cropViewport.width,
                                        top: cropDraft.y * cropViewport.height,
                                        width: cropDraft.size * Math.min(cropViewport.width, cropViewport.height),
                                        height: cropDraft.size * Math.min(cropViewport.width, cropViewport.height),
                                    }}
                                    onPointerDown={handleCropPointerDown}
                                    onPointerMove={handleCropPointerMove}
                                    onPointerUp={handleCropPointerUp}
                                    onPointerCancel={handleCropPointerUp}
                                >
                                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-2 py-1 text-xs text-white">Drag to face</span>
                                </button>
                            )}
                        </div>
                        <label className="flex items-center gap-3 menu-desc">
                            Selection size
                            <input
                                type="range"
                                min="18"
                                max="80"
                                value={Math.round(cropDraft.size * 100)}
                                onChange={(event) => setCropDraft(current => ({ ...current, size: Number(event.target.value) / 100 }))}
                                className="flex-1"
                            />
                        </label>
                    </div>
                </ContentDialog>
            )}

            {pendingDeletePresetId && (
                <ConfirmDialog
                    title="Delete this preset?"
                    message={`The preset "${naiSettings.presets.find(p => p.id === pendingDeletePresetId)?.name || "Unnamed preset"}" can't be recovered once deleted.`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        deletePreset(pendingDeletePresetId);
                        setPendingDeletePresetId(null);
                    }}
                    onCancel={() => setPendingDeletePresetId(null)}
                />
            )}

            {pendingDeleteOpenAiPresetId && (
                <ConfirmDialog
                    title="Delete this OpenAI preset?"
                    message={`The preset "${openaiPresets.find(preset => preset.id === pendingDeleteOpenAiPresetId)?.name || "Unnamed preset"}" and its API configuration can't be recovered once deleted.`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        deleteOpenAiPreset();
                        setPendingDeleteOpenAiPresetId(null);
                    }}
                    onCancel={() => setPendingDeleteOpenAiPresetId(null)}
                />
            )}

        </div>
    );
}
