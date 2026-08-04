"use client";

import { useState, useEffect, useRef, useCallback, useContext } from "react";
import { Plus, Play, Pause, AlertCircle, RefreshCw, FileEdit, Trash2, X, Check, Upload, List } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { loadVoiceConfigs, saveVoiceConfigs } from "@/lib/settings-storage";
import { synthesizeSpeech } from "@/lib/tts-service";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";

const SUPPORTED_VOICE_PROVIDERS = new Set(["Minimax", "OpenAI"]);
const MINIMAX_BASE_URL_OPTIONS = [
    { id: "cn", label: "Mainland China", baseUrl: "https://api.minimaxi.com/v1" },
    { id: "global", label: "Global", baseUrl: "https://api.minimax.io/v1" },
];
const DEFAULT_MINIMAX_BASE_URL = MINIMAX_BASE_URL_OPTIONS[0].baseUrl;
const GLOBAL_MINIMAX_BASE_URL = MINIMAX_BASE_URL_OPTIONS[1].baseUrl;
const VOICE_PROVIDER_OPTIONS = [
    { value: "OpenAI", label: "OpenAI TTS" },
    { value: "MinimaxCN", label: "Minimax Voice (Mainland China)" },
    { value: "MinimaxGlobal", label: "Minimax Voice (Global)" },
];

const DEFAULT_VOICE_CONFIGS: VoiceApiConfig[] = [
    {
        id: "default-minimax-tts",
        name: "Minimax Voice",
        provider: "Minimax",
        apiKey: "",
        baseUrl: DEFAULT_MINIMAX_BASE_URL,
        model: "speech-2.8-turbo",
        defaultVoice: "male-qn-qingse",
        enableSTT: true,
        enableTTS: true,
    }
];

const DEFAULT_MINIMAX_MODELS = [
    { id: "speech-2.8-hd", name: "speech-2.8-hd" },
    { id: "speech-2.8-turbo", name: "speech-2.8-turbo" },
    { id: "speech-2.6-hd", name: "speech-2.6-hd" },
    { id: "speech-2.6-turbo", name: "speech-2.6-turbo" },
    { id: "speech-02-hd", name: "speech-02-hd" },
    { id: "speech-02-turbo", name: "speech-02-turbo" },
    { id: "speech-01-hd", name: "speech-01-hd" },
    { id: "speech-01-turbo", name: "speech-01-turbo (fast, cost-effective)" },
];

const MINIMAX_LANGUAGE_OPTIONS = [
    { value: "", label: "Not specified (keep default)" },
    { value: "auto", label: "Auto-detect" },
    { value: "Chinese", label: "Mandarin" },
    { value: "Chinese,Yue", label: "Cantonese" },
    { value: "English", label: "English" },
    { value: "Arabic", label: "Arabic" },
    { value: "Russian", label: "Russian" },
    { value: "Spanish", label: "Spanish" },
    { value: "French", label: "French" },
    { value: "Portuguese", label: "Portuguese" },
    { value: "German", label: "German" },
    { value: "Turkish", label: "Turkish" },
    { value: "Dutch", label: "Dutch" },
    { value: "Ukrainian", label: "Ukrainian" },
    { value: "Vietnamese", label: "Vietnamese" },
    { value: "Indonesian", label: "Indonesian" },
    { value: "Japanese", label: "Japanese" },
    { value: "Italian", label: "Italian" },
    { value: "Korean", label: "Korean" },
    { value: "Thai", label: "Thai" },
    { value: "Polish", label: "Polish" },
    { value: "Romanian", label: "Romanian" },
    { value: "Greek", label: "Greek" },
    { value: "Czech", label: "Czech" },
    { value: "Finnish", label: "Finnish" },
    { value: "Hindi", label: "Hindi" },
    { value: "Bulgarian", label: "Bulgarian" },
    { value: "Danish", label: "Danish" },
    { value: "Hebrew", label: "Hebrew" },
    { value: "Malay", label: "Malay" },
    { value: "Persian", label: "Persian" },
    { value: "Slovak", label: "Slovak" },
    { value: "Swedish", label: "Swedish" },
    { value: "Croatian", label: "Croatian" },
    { value: "Filipino", label: "Filipino" },
    { value: "Hungarian", label: "Hungarian" },
    { value: "Norwegian", label: "Norwegian" },
    { value: "Slovenian", label: "Slovenian" },
    { value: "Catalan", label: "Catalan" },
    { value: "Nynorsk", label: "Norwegian Nynorsk" },
    { value: "Tamil", label: "Tamil" },
    { value: "Afrikaans", label: "Afrikaans" },
];

const MINIMAX_PREVIEW_TEXT: Record<string, string> = {
    Chinese: "你好，很高兴认识你。这是一段普通话试听。",
    "Chinese,Yue": "大家好，我而家用紧粤语同你讲话，好开心认识你。",
    English: "Hello, it is nice to meet you. This is an English voice preview.",
    Arabic: "مرحبا، سعيد بلقائك. هذا اختبار صوتي باللغة العربية.",
    Russian: "Здравствуйте, приятно познакомиться. Это пример русской речи.",
    Spanish: "Hola, mucho gusto. Esta es una prueba de voz en español.",
    French: "Bonjour, enchanté de vous rencontrer. Ceci est un aperçu de la voix française.",
    Portuguese: "Olá, prazer em conhecer você. Esta é uma prévia de voz em português.",
    German: "Hallo, schön Sie kennenzulernen. Dies ist eine deutsche Sprachprobe.",
    Turkish: "Merhaba, tanıştığımıza memnun oldum. Bu bir Türkçe ses denemesidir.",
    Dutch: "Hallo, leuk u te ontmoeten. Dit is een Nederlandse stemtest.",
    Ukrainian: "Вітаю, приємно познайомитися. Це приклад українського мовлення.",
    Vietnamese: "Xin chào, rất vui được gặp bạn. Đây là bản nghe thử tiếng Việt.",
    Indonesian: "Halo, senang bertemu dengan Anda. Ini adalah contoh suara bahasa Indonesia.",
    Japanese: "こんにちは、はじめまして。これは日本語の音声サンプルです。",
    Italian: "Ciao, piacere di conoscerti. Questa è una prova vocale in italiano.",
    Korean: "안녕하세요, 만나서 반갑습니다. 한국어 음성 미리 듣기입니다.",
    Thai: "สวัสดี ยินดีที่ได้รู้จัก นี่คือตัวอย่างเสียงภาษาไทย",
    Polish: "Dzień dobry, miło mi cię poznać. To jest polska próbka głosu.",
    Romanian: "Bună, îmi pare bine să vă cunosc. Aceasta este o mostră de voce în limba română.",
    Greek: "Γεια σας, χαίρομαι που σας γνωρίζω. Αυτό είναι ένα δείγμα ελληνικής φωνής.",
    Czech: "Dobrý den, těší mě. Toto je ukázka českého hlasu.",
    Finnish: "Hei, hauska tavata. Tämä on suomenkielinen ääninäyte.",
    Hindi: "नमस्ते, आपसे मिलकर खुशी हुई। यह हिंदी आवाज़ का नमूना है।",
    Bulgarian: "Здравейте, приятно ми е да се запознаем. Това е пример за български глас.",
    Danish: "Hej, rart at møde dig. Dette er en dansk stemmeprøve.",
    Hebrew: "שלום, נעים להכיר. זוהי דוגמת קול בעברית.",
    Malay: "Helo, gembira bertemu dengan anda. Ini ialah contoh suara bahasa Melayu.",
    Persian: "سلام، از آشنایی با شما خوشحالم. این یک نمونه صدای فارسی است.",
    Slovak: "Dobrý deň, teší ma. Toto je ukážka slovenského hlasu.",
    Swedish: "Hej, trevligt att träffas. Det här är ett svenskt röstprov.",
    Croatian: "Pozdrav, drago mi je. Ovo je primjer hrvatskog glasa.",
    Filipino: "Kumusta, ikinagagalak kitang makilala. Ito ay halimbawa ng boses sa Filipino.",
    Hungarian: "Üdvözlöm, örülök, hogy találkoztunk. Ez egy magyar hangminta.",
    Norwegian: "Hei, hyggelig å møte deg. Dette er en norsk stemmeprøve.",
    Slovenian: "Pozdravljeni, veseli me. To je primer slovenskega glasu.",
    Catalan: "Hola, encantat de conèixer-te. Aquesta és una mostra de veu en català.",
    Nynorsk: "Hei, hyggeleg å møte deg. Dette er ei nynorsk stemmeprøve.",
    Tamil: "வணக்கம், உங்களைச் சந்தித்ததில் மகிழ்ச்சி. இது ஒரு தமிழ் குரல் மாதிரி.",
    Afrikaans: "Hallo, aangename kennis. Dit is 'n Afrikaanse stemvoorbeeld.",
};

const DEFAULT_MINIMAX_VOICES = [
    { id: "male-qn-qingse", name: "Youthful Young Man (male-qn-qingse)" },
    { id: "female-shaonv", name: "Young Girl (female-shaonv)" },
    { id: "female-yujie", name: "Mature Lady (female-yujie)" },
    { id: "male-qn-badao", name: "Domineering Young Man (male-qn-badao)" },
    { id: "Wise_Woman", name: "Intellectual Woman (Wise_Woman)" },
    { id: "Friendly_Person", name: "Warm and Friendly (Friendly_Person)" },
    { id: "Calm_Woman", name: "Calm Woman (Calm_Woman)" },
    { id: "Cantonese_GentleLady", name: "Cantonese Gentle Lady (Cantonese_GentleLady)" },
    { id: "Cantonese_PlayfulMan", name: "Cantonese Playful Man (Cantonese_PlayfulMan)" },
    { id: "Cantonese_CuteGirl", name: "Cantonese Cute Girl (Cantonese_CuteGirl)" },
    { id: "Cantonese_KindWoman", name: "Cantonese Kind Woman (Cantonese_KindWoman)" },
];

const DEFAULT_OPENAI_VOICES = [
    { id: "alloy", name: "Alloy" },
    { id: "echo", name: "Echo" },
    { id: "fable", name: "Fable" },
    { id: "onyx", name: "Onyx" },
    { id: "nova", name: "Nova" },
    { id: "shimmer", name: "Shimmer" },
];

type VoiceOption = { id: string; name: string; createdAt?: number };

function uniqueOptions(options: VoiceOption[]): VoiceOption[] {
    const seen = new Set<string>();
    return options.filter(option => {
        if (!option.id || seen.has(option.id)) return false;
        seen.add(option.id);
        return true;
    });
}

function defaultVoiceOptions(provider: string): VoiceOption[] {
    return provider === "OpenAI" ? DEFAULT_OPENAI_VOICES : DEFAULT_MINIMAX_VOICES;
}

function voiceOptionsForConfig(config: VoiceApiConfig, fetchedVoices: Record<string, VoiceOption[]>): VoiceOption[] {
    return uniqueOptions([
        ...(fetchedVoices[config.id] || []),
        ...(config.customVoices || []),
        ...defaultVoiceOptions(config.provider),
    ]);
}

function normalizeVoiceConfigs(configs: VoiceApiConfig[]): VoiceApiConfig[] {
    return configs
        .filter(config => SUPPORTED_VOICE_PROVIDERS.has(config.provider))
        .map(config => {
            if (config.provider !== "Minimax") return config;
            const baseUrl = MINIMAX_BASE_URL_OPTIONS.some(option => option.baseUrl === config.baseUrl)
                ? config.baseUrl
                : DEFAULT_MINIMAX_BASE_URL;
            return { ...config, baseUrl };
        });
}

function makeCloneVoiceId(config: VoiceApiConfig): string {
    const seed = (config.name || config.defaultVoice || "voice")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24) || "voice";
    return `${seed}_${Date.now().toString(36)}`.slice(0, 64);
}

function providerSelectValue(config: VoiceApiConfig): string {
    if (config.provider === "OpenAI") return "OpenAI";
    return config.baseUrl === GLOBAL_MINIMAX_BASE_URL ? "MinimaxGlobal" : "MinimaxCN";
}

export function VoiceSettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<VoiceApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
    const [cloneTargetId, setCloneTargetId] = useState<string | null>(null);
    const [cloneVoiceId, setCloneVoiceId] = useState("");
    const [cloneFile, setCloneFile] = useState<File | null>(null);
    const [cloneError, setCloneError] = useState("");
    const [isCloning, setIsCloning] = useState(false);
    const [manualModelIds, setManualModelIds] = useState<Record<string, boolean>>({});
    const [manualVoiceIds, setManualVoiceIds] = useState<Record<string, boolean>>({});
    const [isLoaded, setIsLoaded] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Fetching states for Voices
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedVoices, setFetchedVoices] = useState<Record<string, VoiceOption[]>>({});
    const [fetchError, setFetchError] = useState<Record<string, string>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const stored = loadVoiceConfigs();
        const loaded = normalizeVoiceConfigs(stored);
        if (loaded.length > 0) {
            setConfigs(loaded);
            if (loaded.length !== stored.length) saveVoiceConfigs(loaded);
        } else {
            setConfigs(DEFAULT_VOICE_CONFIGS);
            saveVoiceConfigs(DEFAULT_VOICE_CONFIGS);
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: VoiceApiConfig[]) => {
        setConfigs(newConfigs);
        saveVoiceConfigs(newConfigs);
    }, []);

    const addConfig = useCallback(() => {
        const newConfig: VoiceApiConfig = {
            id: `voice-${Date.now()}`,
            name: "New Voice Configuration",
            provider: "Minimax",
            apiKey: "",
            baseUrl: DEFAULT_MINIMAX_BASE_URL,
            region: "",
            model: "speech-2.8-turbo",
            defaultVoice: "male-qn-qingse",
            enableSTT: true,
            enableTTS: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    useEffect(() => {
        setSubpageRightAction("voice",
            <button
                onClick={addConfig}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>Add Voice Configuration</span>
            </button>
        );
        return () => setSubpageRightAction("voice", null);
    }, [addConfig, setSubpageRightAction]);

    const updateConfig = (id: string, updates: Partial<VoiceApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const updateProvider = (id: string, providerOption: string) => {
        const current = configs.find(c => c.id === id);
        if (providerOption === "OpenAI") {
            updateConfig(id, {
                provider: "OpenAI",
                baseUrl: "https://api.openai.com/v1",
                model: "tts-1",
                defaultVoice: "alloy",
            });
            setManualModelIds(prev => ({ ...prev, [id]: true }));
            setManualVoiceIds(prev => ({ ...prev, [id]: false }));
            return;
        }
        const wasMinimax = current?.provider === "Minimax";
        updateConfig(id, {
            provider: "Minimax",
            baseUrl: providerOption === "MinimaxGlobal" ? GLOBAL_MINIMAX_BASE_URL : DEFAULT_MINIMAX_BASE_URL,
            model: wasMinimax ? (current?.model || "speech-2.8-turbo") : "speech-2.8-turbo",
            defaultVoice: wasMinimax ? (current?.defaultVoice || "male-qn-qingse") : "male-qn-qingse",
        });
        if (!wasMinimax) {
            setManualModelIds(prev => ({ ...prev, [id]: false }));
            setManualVoiceIds(prev => ({ ...prev, [id]: false }));
        }
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));

        // Cleanup states
        const newFetchedVoices = { ...fetchedVoices };
        delete newFetchedVoices[id];
        setFetchedVoices(newFetchedVoices);

        const newFetchError = { ...fetchError };
        delete newFetchError[id];
        setFetchError(newFetchError);

        setManualModelIds(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        setManualVoiceIds(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
    };

    const openCloneModal = (config: VoiceApiConfig) => {
        setCloneTargetId(config.id);
        setCloneVoiceId(makeCloneVoiceId(config));
        setCloneFile(null);
        setCloneError("");
        setIsCloning(false);
    };

    const closeCloneModal = () => {
        if (isCloning) return;
        setCloneTargetId(null);
        setCloneVoiceId("");
        setCloneFile(null);
        setCloneError("");
    };

    const submitClone = async () => {
        const config = configs.find(c => c.id === cloneTargetId);
        if (!config) return;
        setCloneError("");
        const voiceId = cloneVoiceId.trim();
        if (!config.apiKey.trim()) {
            setCloneError("Please enter your Minimax API Key first");
            return;
        }
        if (!voiceId || !/^[A-Za-z0-9_-]{4,64}$/.test(voiceId)) {
            setCloneError("Voice ID can only contain letters, numbers, underscores, and hyphens, 4-64 characters long");
            return;
        }
        if (!cloneFile) {
            setCloneError("Please upload an audio file");
            return;
        }

        if (cloneFile.size > 20 * 1024 * 1024) {
            setCloneError("Audio file exceeds 20MB. Please compress it and try again (about 30 seconds of clean voice audio is enough)");
            return;
        }

        setIsCloning(true);
        try {
            // Connect directly to MiniMax from the browser (same path as TTS), not routed through the server:
            // avoids the Netlify function's ~6MB request body and 10s timeout limits, and local dev doesn't need an outbound proxy either.
            const base = (config.baseUrl || DEFAULT_MINIMAX_BASE_URL).replace(/\/$/, "");
            const auth = { Authorization: `Bearer ${config.apiKey.trim()}` };
            const readBaseRespError = (payload: Record<string, unknown> | null): string | null => {
                const baseResp = (payload?.base_resp ?? {}) as Record<string, unknown>;
                const code = baseResp.status_code ?? payload?.status_code;
                const message = String(baseResp.status_msg || payload?.status_msg || "");
                if (typeof code === "number" && code !== 0) return message || `status_code=${code}`;
                if (typeof code === "string" && code && code !== "0") return message || `status_code=${code}`;
                return null;
            };
            const parseJson = (text: string): Record<string, unknown> | null => {
                try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
            };

            // 1) Upload the cloning sample
            const uploadForm = new FormData();
            uploadForm.set("purpose", "voice_clone");
            uploadForm.set("file", cloneFile, cloneFile.name || "voice-sample.mp3");
            const uploadResponse = await fetch(`${base}/files/upload`, { method: "POST", headers: auth, body: uploadForm });
            const uploadText = await uploadResponse.text();
            const uploadData = parseJson(uploadText);
            const uploadError = readBaseRespError(uploadData);
            if (!uploadResponse.ok || uploadError) {
                throw new Error(uploadError || `Sample upload failed (HTTP ${uploadResponse.status}) ${uploadText.slice(0, 200)}`);
            }
            const fileRecord = (uploadData?.file ?? {}) as Record<string, unknown>;
            const fileId = fileRecord.file_id ?? uploadData?.file_id ?? uploadData?.id;
            if (fileId === undefined || fileId === null || fileId === "") {
                throw new Error(`No file_id in upload result: ${uploadText.slice(0, 200)}`);
            }

            // 2) Start the clone
            const cloneResponse = await fetch(`${base}/voice_clone`, {
                method: "POST",
                headers: { ...auth, "Content-Type": "application/json" },
                body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
            });
            const cloneText = await cloneResponse.text();
            const cloneData = parseJson(cloneText);
            const cloneRespError = readBaseRespError(cloneData);
            if (!cloneResponse.ok || cloneRespError) {
                throw new Error(cloneRespError || `Cloning failed (HTTP ${cloneResponse.status}) ${cloneText.slice(0, 200)}`);
            }
            const nextVoiceId = voiceId;
            const clonedVoice: VoiceOption = {
                id: nextVoiceId,
                name: `Cloned Voice (${nextVoiceId})`,
                createdAt: Date.now(),
            };
            updateConfig(config.id, {
                defaultVoice: nextVoiceId,
                customVoices: uniqueOptions([clonedVoice, ...(config.customVoices || [])]),
            });
            setFetchedVoices(prev => {
                const current = prev[config.id] || [];
                return {
                    ...prev,
                    [config.id]: uniqueOptions([clonedVoice, ...current]),
                };
            });
            setCloneTargetId(null);
            setCloneVoiceId("");
            setCloneFile(null);
            setCloneError("");
            setManualVoiceIds(prev => ({ ...prev, [config.id]: false }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setCloneError(msg);
        } finally {
            setIsCloning(false);
        }
    };

    const fetchVoices = async (config: VoiceApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setFetchError(prev => ({ ...prev, [config.id]: "" }));

        try {
            if (config.provider === "Minimax") {
                if (!config.apiKey.trim()) {
                    setFetchedVoices(prev => ({ ...prev, [config.id]: config.customVoices || [] }));
                    setFetchError(prev => ({ ...prev, [config.id]: "Enter your API Key to sync cloned voices from your account" }));
                    return;
                }
                const response = await fetch("/api/voice/minimax-voices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        apiKey: config.apiKey,
                        baseUrl: config.baseUrl || DEFAULT_MINIMAX_BASE_URL,
                    }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.message || data.error || `Sync failed (${response.status})`);
                }
                const clonedVoices = Array.isArray(data.voices) ? data.voices as VoiceOption[] : [];
                const nextCustomVoices = uniqueOptions([...clonedVoices, ...(config.customVoices || [])]);
                updateConfig(config.id, { customVoices: nextCustomVoices });
                setFetchedVoices(prev => ({ ...prev, [config.id]: nextCustomVoices }));

            } else if (config.provider === "OpenAI") {
                setFetchedVoices(prev => ({ ...prev, [config.id]: DEFAULT_OPENAI_VOICES }));
            } else {
                throw new Error("This provider does not support fetching the voice list yet");
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setFetchError(prev => ({ ...prev, [config.id]: msg }));
            setFetchedVoices(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    const togglePreview = async (config: VoiceApiConfig) => {
        if (playingVoiceId === config.id) {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
            setPlayingVoiceId(null);
            return;
        }

        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        setPlayingVoiceId(config.id);

        try {
            const previewText = config.provider === "Minimax" && config.languageBoost
                ? MINIMAX_PREVIEW_TEXT[config.languageBoost] || "Hello, nice to meet you. This is a voice preview."
                : "Hello, I'm now using the " + (config.defaultVoice || "default") + " voice. Nice to meet you.";
            const blob = await synthesizeSpeech(
                previewText,
                config,
            );
            if (!blob) throw new Error("This voice configuration did not return real audio");
            const url = URL.createObjectURL(blob);

            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => {
                setPlayingVoiceId(null);
                audioRef.current = null;
                URL.revokeObjectURL(url);
            };
            audio.onerror = () => {
                setPlayingVoiceId(null);
                audioRef.current = null;
                URL.revokeObjectURL(url);
            };
            await audio.play();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`Voice test failed: ${msg}`);
            setPlayingVoiceId(null);
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Voice API</h2>
            </div>

            {configs.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <Play size={24} />
                    </div>
                    <span className="menu-label font-semibold">No voice configuration</span>
                    <span className="menu-desc max-w-[240px]">
                        Configure a voice API to enable voice calls and reply narration.
                    </span>
                    <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> Add Configuration
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {configs.map(config => (
                        <div
                            key={config.id}
                            className="ui-config-card min-w-0 cursor-pointer"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`Edit ${config.name || config.provider}`}
                            onClick={() => setEditingId(config.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(config.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{config.name || config.provider}</span>
                                <span className="menu-desc truncate">{config.defaultVoice || config.model || config.provider || "No voice set"}</span>
                            </div>
                            <div className="flex gap-2 shrink-0 items-center justify-end">
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setEditingId(config.id);
                                    }}
                                    className="ui-link-btn"
                                >
                                    <FileEdit size={18} />
                                </button>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setConfirmDeleteId(config.id);
                                    }}
                                    className="ui-link-btn"
                                    data-variant="danger"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "Add Voice Configuration" : "Edit Voice Configuration"}</span>
                            <button onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <div className="flex flex-col gap-4">
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">Configuration Name</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="e.g. My Voice Assistant"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">Provider</label>
                                            <select
                                                value={providerSelectValue(config)}
                                                onChange={(e) => updateProvider(config.id, e.target.value)}
                                                className="ui-select"
                                            >
                                                {VOICE_PROVIDER_OPTIONS.map(option => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="Enter API key..."
                                            />
                                        </div>
                                        {config.provider === "OpenAI" && (
                                            <>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">Endpoint (Base URL)</label>
                                                    <Input
                                                        type="text"
                                                        value={config.baseUrl || ""}
                                                        onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                        placeholder="https://api.openai.com/v1"
                                                    />
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">Voice Model (TTS Model)</label>
                                                    {manualModelIds[config.id] ? (
                                                        <div className="flex gap-2">
                                                            <Input
                                                                type="text"
                                                                value={config.model || ""}
                                                                onChange={(e) => updateConfig(config.id, { model: e.target.value })}
                                                                placeholder="Manually enter model ID"
                                                                className="flex-1"
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => setManualModelIds(prev => ({ ...prev, [config.id]: false }))}
                                                                className="ui-icon-btn"
                                                                aria-label="Back to model dropdown"
                                                                title="Back to model dropdown"
                                                            >
                                                                <List size={20} />
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <select
                                                            value={config.model === "tts-1" || config.model === "tts-1-hd" ? config.model : "__manual__"}
                                                            onChange={(e) => {
                                                                if (e.target.value === "__manual__") {
                                                                    setManualModelIds(prev => ({ ...prev, [config.id]: true }));
                                                                    return;
                                                                }
                                                                updateConfig(config.id, { model: e.target.value });
                                                            }}
                                                            className="ui-select"
                                                        >
                                                            <option value="tts-1">tts-1</option>
                                                            <option value="tts-1-hd">tts-1-hd</option>
                                                            <option value="__manual__">Manual entry...</option>
                                                        </select>
                                                    )}
                                                </div>
                                            </>
                                        )}

                                        {config.provider === "Minimax" && (
                                            <>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">Speech Language</label>
                                                    <select
                                                        value={config.languageBoost || ""}
                                                        onChange={(e) => updateConfig(config.id, { languageBoost: e.target.value || undefined })}
                                                        className="ui-select"
                                                    >
                                                        {MINIMAX_LANGUAGE_OPTIONS.map(option => (
                                                            <option key={option.value || "default"} value={option.value}>{option.label}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">Voice Model (TTS Model)</label>
                                                    <div className="flex flex-col gap-2">
                                                        {manualModelIds[config.id] ? (
                                                            <div className="flex gap-2">
                                                                <Input
                                                                    type="text"
                                                                    value={config.model || ""}
                                                                    onChange={(e) => updateConfig(config.id, { model: e.target.value })}
                                                                    placeholder="Manually enter model ID"
                                                                    className="flex-1"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setManualModelIds(prev => ({ ...prev, [config.id]: false }))}
                                                                    className="ui-icon-btn"
                                                                    aria-label="Back to model dropdown"
                                                                    title="Back to model dropdown"
                                                                >
                                                                    <List size={20} />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <select
                                                                value={DEFAULT_MINIMAX_MODELS.some(m => m.id === config.model) ? config.model : "__manual__"}
                                                                onChange={(e) => {
                                                                    if (e.target.value === "__manual__") {
                                                                        setManualModelIds(prev => ({ ...prev, [config.id]: true }));
                                                                        return;
                                                                    }
                                                                    updateConfig(config.id, { model: e.target.value });
                                                                }}
                                                                className="ui-select"
                                                            >
                                                                {DEFAULT_MINIMAX_MODELS.map(model => (
                                                                    <option key={model.id} value={model.id}>{model.name}</option>
                                                                ))}
                                                                <option value="__manual__">Manual entry...</option>
                                                            </select>
                                                        )}
                                                    </div>
                                                </div>
                                            </>
                                        )}

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">Default Voice or Custom Voice ID</label>
                                            <div className="flex flex-col gap-2">
                                                <div className="flex gap-2">
                                                    {manualVoiceIds[config.id] ? (
                                                        <>
                                                            <Input
                                                                type="text"
                                                                value={config.defaultVoice}
                                                                onChange={(e) => updateConfig(config.id, { defaultVoice: e.target.value })}
                                                                placeholder={config.provider === "OpenAI" ? "alloy" : "male-qn-qingse or cloned Voice ID"}
                                                                className="flex-1"
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => setManualVoiceIds(prev => ({ ...prev, [config.id]: false }))}
                                                                className="ui-icon-btn"
                                                                aria-label="Back to voice dropdown"
                                                                title="Back to voice dropdown"
                                                            >
                                                                <List size={20} />
                                                            </button>
                                                        </>
                                                    ) : (
                                                        (() => {
                                                            const options = voiceOptionsForConfig(config, fetchedVoices);
                                                            return (
                                                                <select
                                                                    value={options.some(v => v.id === config.defaultVoice) ? config.defaultVoice : "__manual__"}
                                                                    onChange={(e) => {
                                                                        if (e.target.value === "__manual__") {
                                                                            setManualVoiceIds(prev => ({ ...prev, [config.id]: true }));
                                                                            return;
                                                                        }
                                                                        updateConfig(config.id, { defaultVoice: e.target.value });
                                                                    }}
                                                                    className="ui-select flex-1"
                                                                >
                                                                    {options.map(v => (
                                                                        <option key={v.id} value={v.id}>{v.name}</option>
                                                                    ))}
                                                                    <option value="__manual__">Manual entry...</option>
                                                                </select>
                                                            );
                                                        })()
                                                    )}
                                                    <button
                                                        onClick={() => togglePreview(config)}
                                                        className="ui-icon-btn"
                                                        data-active={playingVoiceId === config.id}
                                                    >
                                                        {playingVoiceId === config.id ? <Pause size={20} /> : <Play size={20} />}
                                                    </button>
                                                </div>

                                                <div className="flex gap-2 mt-0.5">
                                                    <button
                                                        onClick={() => fetchVoices(config)}
                                                        disabled={isFetching[config.id]}
                                                        className="ui-btn ui-btn ui-btn-soft-action w-full"
                                                    >
                                                        <RefreshCw size={16} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                        {isFetching[config.id] ? "Syncing..." : config.provider === "Minimax" ? "Sync Voice List" : "Show Default Voices"}
                                                    </button>
                                                    {config.provider === "Minimax" && (
                                                        <button
                                                            onClick={() => openCloneModal(config)}
                                                            disabled={!config.apiKey.trim()}
                                                            className="ui-btn ui-btn-soft-action w-full"
                                                        >
                                                            <Upload size={16} />
                                                            Upload Audio to Clone Voice
                                                        </button>
                                                    )}
                                                </div>

                                                {fetchError[config.id] && (
                                                    <Alert variant="danger">
                                                        <AlertCircle size={14} />
                                                        {fetchError[config.id]}
                                                    </Alert>
                                                )}
                                            </div>
                                        </div>

                                        <div className="ui-toggle-row">
                                            <span className="menu-label font-medium">Enable Text-to-Speech (TTS)</span>
                                            <Toggle checked={config.enableTTS} onChange={(v) => updateConfig(config.id, { enableTTS: v })} />
                                        </div>
                                    </div>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {cloneTargetId && (() => {
                const config = configs.find(c => c.id === cloneTargetId);
                if (!config) return null;
                return (
                    <div className="modal-overlay">
                        <div className="modal-expand" data-ui="modal-dialog" style={{ width: "min(420px, calc(100% - 32px))", maxHeight: "82%" }}>
                            <div className="modal-header" data-ui="modal-header">
                                <button onClick={closeCloneModal} disabled={isCloning} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                                <span className="modal-header-title">Clone Minimax Voice</span>
                                <button onClick={submitClone} disabled={isCloning} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                            </div>

                            <div className="modal-body hide-scrollbar" data-ui="modal-body">
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-1">
                                        <label className="menu-desc ml-1">New Voice ID</label>
                                        <Input
                                            type="text"
                                            value={cloneVoiceId}
                                            onChange={(e) => setCloneVoiceId(e.target.value)}
                                            placeholder="e.g. voice_xxx"
                                            disabled={isCloning}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="menu-desc ml-1">Audio Sample</label>
                                        <input
                                            type="file"
                                            accept="audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/wav,.mp3,.m4a,.wav"
                                            onChange={(e) => setCloneFile(e.target.files?.[0] || null)}
                                            disabled={isCloning}
                                            className="ui-input"
                                        />
                                        <span className="menu-desc ml-1">We recommend uploading 10-30 seconds of clear audio with minimal background noise.</span>
                                        <span className="ml-1 text-xs font-medium text-red-500">
                                            The first use of a cloned voice will deduct a 9.9 RMB Minimax token fee (including preview).
                                        </span>
                                    </div>

                                    {cloneError && (
                                        <Alert variant="danger">
                                            <AlertCircle size={14} />
                                            {cloneError}
                                        </Alert>
                                    )}

                                    <button
                                        type="button"
                                        onClick={submitClone}
                                        disabled={isCloning}
                                        className="ui-btn ui-btn-primary w-full"
                                    >
                                        {isCloning ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
                                        {isCloning ? "Cloning..." : "Start Cloning and Save Voice ID"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="Confirm Delete?"
                    message="This configuration cannot be recovered after deletion. Continue?"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="Confirm Delete"
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
