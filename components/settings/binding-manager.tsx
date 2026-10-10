"use client";

import { useState, useEffect, useContext, type CSSProperties } from "react";
import {
    Asterisk,
    BookOpen,
    Box,
    Brain,
    Check,
    ChevronRight,
    Code2,
    Image as ImageIcon,
    Languages,
    Layers,
    Mic,
    RotateCcw,
    User,
    UserPlus,
    X,
    type LucideIcon,
} from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { ICONS, type IconId } from "@/lib/desktop-config";
import { IconGlyph } from "@/components/icon-glyph";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { toCustomAppIconId } from "@/lib/custom-app-types";
import type { InstalledCustomApp } from "@/lib/custom-app-types";

/** Map ContentAppId → IconId (only needed where they differ) */
const APP_ICON_MAP: Partial<Record<ContentAppId, IconId>> = {
    adventure: "mapmode",
    vn: "vnmode",
};
const appIconId = (appId: ContentAppId): IconId => APP_ICON_MAP[appId] ?? appId as IconId;
import type {
    BindingConfig,
    BindingSlot,
    CharacterBinding,
    ContentAppId,
    ApiConfig,
    ImageGenerationSettings,
    VoiceApiConfig,
    PresetConfig,
    WorldBookConfig,
    RegexConfig,
} from "@/lib/settings-types";
import { CONTENT_APP_IDS, CONTENT_APP_LABELS } from "@/lib/settings-types";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import {
    loadBindingConfig,
    saveBindingConfig,
    getCharacterBinding,
    setCharacterBinding,
    loadApiConfigs,
    loadImageGenerationSettings,
    loadVoiceConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    loadUserIdentities,
    ensureSettingsStorageHydrated,
} from "@/lib/settings-storage";
import { getActiveImageGenerationBindingId, getImageGenerationBindingOptions } from "@/lib/image-generation-binding";
import { hydrateKvDb } from "@/lib/kv-db";
import type { UserIdentity } from "@/components/settings/user-identity";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

type Level = "global" | "app-list" | "character" | "app";
type AppBindingScope = "global" | "character";
type SingleBindingField = "apiConfigId" | "imageConfigId" | "voiceConfigId" | "presetId" | "userIdentityId";
type MultiBindingField = "worldBookIds" | "regexIds";
type BindingField = SingleBindingField | MultiBindingField;
type AuxBindingField = "memorySummaryApiConfigId" | "embeddingApiConfigId" | "mascotApiConfigId" | "reasoningTranslateApiConfigId";

const BINDING_FIELD_VISUALS: Record<BindingField, { icon: LucideIcon; color: string }> = {
    apiConfigId: { icon: Code2, color: BINDING_ACCENTS.api },
    imageConfigId: { icon: ImageIcon, color: BINDING_ACCENTS.embedding },
    voiceConfigId: { icon: Mic, color: BINDING_ACCENTS.voice },
    presetId: { icon: Layers, color: BINDING_ACCENTS.preset },
    worldBookIds: { icon: BookOpen, color: BINDING_ACCENTS.worldBook },
    regexIds: { icon: Asterisk, color: BINDING_ACCENTS.regex },
    userIdentityId: { icon: User, color: BINDING_ACCENTS.identity },
};

const AUX_FIELD_VISUALS: Record<AuxBindingField, { icon: LucideIcon; color: string }> = {
    memorySummaryApiConfigId: { icon: Brain, color: BINDING_ACCENTS.memory },
    embeddingApiConfigId: { icon: Box, color: BINDING_ACCENTS.embedding },
    mascotApiConfigId: { icon: Code2, color: BINDING_ACCENTS.api },
    reasoningTranslateApiConfigId: { icon: Languages, color: BINDING_ACCENTS.voice },
};

const APP_OVERRIDE_COLORS = CONTENT_APP_ACCENTS;
const REGEX_BINDABLE_APP_IDS: ContentAppId[] = ["chat", "group_chat", "story"];

const bindingAccentStyle = (color: string): CSSProperties => ({
    "--binding-accent": color,
} as CSSProperties);

const CUSTOM_APP_BINDING_PREFIX = "custom_app:";

const isCustomAppBindingId = (appId: string | null | undefined): boolean => (
    Boolean(appId?.startsWith(CUSTOM_APP_BINDING_PREFIX))
);

const canBindRegexInApp = (appId: string | null | undefined): boolean => (
    Boolean(appId && (REGEX_BINDABLE_APP_IDS.includes(appId as ContentAppId) || isCustomAppBindingId(appId)))
);

export function BindingManager() {
    const { setSubpageTitle, setOverrideBack } = useContext(SettingsContext);

    const [config, setConfig] = useState<BindingConfig>({ globalDefaults: {}, characterBindings: [] });
    const [characters, setCharacters] = useState<Character[]>([]);
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [imageSettings, setImageSettings] = useState<ImageGenerationSettings | null>(null);
    const [voiceConfigs, setVoiceConfigs] = useState<VoiceApiConfig[]>([]);
    const [presets, setPresets] = useState<PresetConfig[]>([]);
    const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
    const [regexes, setRegexes] = useState<RegexConfig[]>([]);
    const [identities, setIdentities] = useState<UserIdentity[]>([]);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);

    const [level, setLevel] = useState<Level>("global");
    const [appBindingScope, setAppBindingScope] = useState<AppBindingScope>("global");
    const [selectedCharId, setSelectedCharId] = useState<string>("");
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
    const [activeGlobalSheetField, setActiveGlobalSheetField] = useState<BindingField | null>(null);
    const [activeSlotSheetField, setActiveSlotSheetField] = useState<BindingField | null>(null);
    const [activeAuxSheetField, setActiveAuxSheetField] = useState<AuxBindingField | null>(null);
    const [showCharacterPicker, setShowCharacterPicker] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

    const reloadData = () => {
        setApiConfigs(loadApiConfigs());
        setImageSettings(loadImageGenerationSettings());
        setVoiceConfigs(loadVoiceConfigs());
        setPresets(loadPresets());
        setWorldBooks(loadWorldBooks());
        setRegexes(loadRegexes());
        setIdentities(loadUserIdentities());
    };

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            await Promise.all([hydrateKvDb(), ensureSettingsStorageHydrated()]);
            if (cancelled) return;
            setConfig(loadBindingConfig());
            setCharacters(loadCharacters());
            setCustomApps(loadInstalledCustomApps());
            reloadData();
            setIsLoaded(true);
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const handler = () => setCustomApps(loadInstalledCustomApps());
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
        return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
    }, []);

    const getCustomAppByBindingId = (appId: string | null | undefined): InstalledCustomApp | null => {
        if (!appId?.startsWith(CUSTOM_APP_BINDING_PREFIX)) return null;
        const customAppId = appId.slice(CUSTOM_APP_BINDING_PREFIX.length);
        return customApps.find(app => app.id === customAppId) ?? null;
    };

    const getAppLabel = (appId: string): string => {
        const customApp = getCustomAppByBindingId(appId);
        if (customApp) return customApp.name;
        return CONTENT_APP_LABELS[appId as ContentAppId] ?? appId;
    };

    // Auto-clean stale binding IDs when resource lists change
    useEffect(() => {
        if (!isLoaded) return;
        const validSets = {
            api: new Set(apiConfigs.map(c => c.id)),
            image: new Set(imageSettings ? getImageGenerationBindingOptions(imageSettings).map(option => option.id) : []),
            voice: new Set(voiceConfigs.map(c => c.id)),
            preset: new Set(presets.map(p => p.id)),
            identity: new Set(identities.map(i => i.id)),
            wb: new Set(worldBooks.map(w => w.id)),
            regex: new Set(regexes.map(r => r.id)),
        };
        const cleanSlot = (slot: BindingSlot): [BindingSlot, boolean] => {
            const s = { ...slot };
            let changed = false;
            if (s.apiConfigId && !validSets.api.has(s.apiConfigId)) { s.apiConfigId = undefined; changed = true; }
            if (s.imageConfigId && !validSets.image.has(s.imageConfigId)) { s.imageConfigId = undefined; changed = true; }
            if (s.voiceConfigId && !validSets.voice.has(s.voiceConfigId)) { s.voiceConfigId = undefined; changed = true; }
            if (s.presetId && !validSets.preset.has(s.presetId)) { s.presetId = undefined; changed = true; }
            if (s.userIdentityId && !validSets.identity.has(s.userIdentityId)) { s.userIdentityId = undefined; changed = true; }
            if (s.worldBookIds) {
                const f = s.worldBookIds.filter(id => validSets.wb.has(id));
                if (f.length !== s.worldBookIds.length) changed = true;
                s.worldBookIds = f.length > 0 ? f : undefined;
            }
            if (s.regexIds) {
                const f = s.regexIds.filter(id => validSets.regex.has(id));
                if (f.length !== s.regexIds.length) changed = true;
                s.regexIds = f.length > 0 ? f : undefined;
            }
            return [s, changed];
        };
        const cleanAppSlot = (slot: BindingSlot): [BindingSlot, boolean] => {
            const [s, slotChanged] = cleanSlot(slot);
            if (!s.voiceConfigId) return [s, slotChanged];
            s.voiceConfigId = undefined;
            return [s, true];
        };
        setConfig(prev => {
            let dirty = false;
            const [gd, gChanged] = cleanSlot(prev.globalDefaults);
            if (gChanged) dirty = true;
            // The global base fields are "what you see is what you get": once a stale/empty
            // value is cleaned up, it's immediately backfilled with the real fallback value.
            if (apiConfigs.length > 0 && !gd.apiConfigId) { gd.apiConfigId = apiConfigs[0].id; dirty = true; }
            const activeImageBindingId = imageSettings ? getActiveImageGenerationBindingId(imageSettings) : undefined;
            if (activeImageBindingId && !gd.imageConfigId) { gd.imageConfigId = activeImageBindingId; dirty = true; }
            if (presets.length > 0 && !gd.presetId) { gd.presetId = (presets.find(p => p.builtIn) ?? presets[0]).id; dirty = true; }
            if (identities.length > 0 && !gd.userIdentityId) { gd.userIdentityId = identities[0].id; dirty = true; }
            const newAppDefaults: Record<string, BindingSlot> = {};
            for (const [appId, slot] of Object.entries(prev.appDefaults ?? {})) {
                if (!slot) continue;
                const [cleaned, aChanged] = cleanAppSlot(slot);
                if (aChanged) dirty = true;
                newAppDefaults[appId] = cleaned;
            }
            const newBindings = prev.characterBindings.map(b => {
                const [defaults, dChanged] = cleanSlot(b.defaults);
                if (dChanged) dirty = true;
                const newOverrides: Record<string, BindingSlot> = {};
                for (const [k, v] of Object.entries(b.appOverrides)) {
                    if (!v) continue;
                    const [cleaned, oChanged] = cleanAppSlot(v);
                    if (oChanged) dirty = true;
                    newOverrides[k] = cleaned;
                }
                return { ...b, defaults, appOverrides: newOverrides };
            });
            const next: BindingConfig = { ...prev, globalDefaults: gd, appDefaults: newAppDefaults, characterBindings: newBindings };
            if (prev.memorySummaryApiConfigId && !validSets.api.has(prev.memorySummaryApiConfigId)) {
                next.memorySummaryApiConfigId = undefined;
                dirty = true;
            }
            if (prev.embeddingApiConfigId && !validSets.api.has(prev.embeddingApiConfigId)) {
                next.embeddingApiConfigId = undefined;
                dirty = true;
            }
            if (prev.mascotApiConfigId && !validSets.api.has(prev.mascotApiConfigId)) {
                next.mascotApiConfigId = undefined;
                dirty = true;
            }
            if (dirty) {
                saveBindingConfig(next);
                return next;
            }
            return prev;
        });
    }, [isLoaded, apiConfigs, imageSettings, voiceConfigs, presets, worldBooks, regexes, identities]);

    // Navigation management
    useEffect(() => {
        if (level === "global") {
            setOverrideBack(null);
            setSubpageTitle(null);
        } else if (level === "app-list") {
            setSubpageTitle("Global App Bindings");
            setOverrideBack(() => () => setLevel("global"));
        } else if (level === "character") {
            const charName = characters.find(c => c.id === selectedCharId)?.name || "Character";
            setSubpageTitle(`${charName}'s Bindings`);
            setOverrideBack(() => () => {
                setLevel("global");
                setSelectedCharId("");
            });
        } else if (level === "app") {
            const appLabel = selectedAppId ? getAppLabel(selectedAppId) : "";
            const charName = characters.find(c => c.id === selectedCharId)?.name || "Character";
            setSubpageTitle(appBindingScope === "global" ? `${appLabel} · App Binding` : `${appLabel} · ${charName}`);
            setOverrideBack(() => () => {
                setLevel(appBindingScope === "global" ? "app-list" : "character");
                setSelectedAppId(null);
            });
        }
    }, [level, appBindingScope, selectedCharId, selectedAppId, characters, customApps, setSubpageTitle, setOverrideBack]);

    const persist = (newConfig: BindingConfig) => {
        setConfig(newConfig);
        saveBindingConfig(newConfig);
    };

    const updateGlobalSlot = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        const newGlobal = { ...config.globalDefaults, [field]: value || undefined };
        persist({ ...config, globalDefaults: newGlobal });
    };

    const updateCharDefaultSlot = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        const binding = getCharacterBinding(config, selectedCharId);
        const newDefaults = { ...binding.defaults, [field]: value || undefined };
        const newBinding: CharacterBinding = { ...binding, defaults: newDefaults };
        persist(setCharacterBinding(config, newBinding));
    };

    const updateAppSlot = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        if (!selectedAppId) return;
        if (appBindingScope === "global") {
            const appDefaults = { ...(config.appDefaults ?? {}) };
            appDefaults[selectedAppId] = {
                ...(appDefaults[selectedAppId] ?? {}),
                [field]: value || undefined,
            };
            persist({ ...config, appDefaults });
            return;
        }
        const binding = getCharacterBinding(config, selectedCharId);
        const appSlot = binding.appOverrides[selectedAppId] || {};
        const newAppSlot = { ...appSlot, [field]: value || undefined };
        const newOverrides = { ...binding.appOverrides, [selectedAppId]: newAppSlot };
        const newBinding: CharacterBinding = { ...binding, appOverrides: newOverrides };
        persist(setCharacterBinding(config, newBinding));
    };

    const resetAppBinding = () => {
        if (!selectedAppId) return;
        if (appBindingScope === "global") {
            const appDefaults = { ...(config.appDefaults ?? {}) };
            delete appDefaults[selectedAppId];
            persist({ ...config, appDefaults });
            return;
        }
        const binding = getCharacterBinding(config, selectedCharId);
        const newOverrides = { ...binding.appOverrides };
        delete newOverrides[selectedAppId];
        const newBinding: CharacterBinding = { ...binding, appOverrides: newOverrides };
        persist(setCharacterBinding(config, newBinding));
    };

    const getCurrentSlot = (): BindingSlot => {
        if (level === "global") return config.globalDefaults;
        const binding = getCharacterBinding(config, selectedCharId);
        if (level === "character") return binding.defaults;
        if (level === "app" && selectedAppId) {
            return appBindingScope === "global"
                ? config.appDefaults?.[selectedAppId] || {}
                : binding.appOverrides[selectedAppId] || {};
        }
        return {};
    };

    const mergeSlotInto = (target: BindingSlot, slot?: BindingSlot): BindingSlot => {
        if (!slot) return target;
        if (slot.apiConfigId) target.apiConfigId = slot.apiConfigId;
        if (slot.imageConfigId) target.imageConfigId = slot.imageConfigId;
        if (slot.voiceConfigId) target.voiceConfigId = slot.voiceConfigId;
        if (slot.presetId) target.presetId = slot.presetId;
        if (slot.userIdentityId) target.userIdentityId = slot.userIdentityId;
        if (slot.worldBookIds && slot.worldBookIds.length > 0) target.worldBookIds = [...slot.worldBookIds];
        if (slot.regexIds && slot.regexIds.length > 0) target.regexIds = [...slot.regexIds];
        return target;
    };

    const getInheritedSlot = (): BindingSlot => {
        if (level === "global") return {};
        const inherited = mergeSlotInto({}, config.globalDefaults);
        if (level === "app" && selectedAppId && appBindingScope === "global") return inherited;
        const binding = getCharacterBinding(config, selectedCharId);
        if (level === "character") return inherited;
        // An app-level default applies before a character's own default; a character's own
        // binding takes higher priority.
        if (level === "app" && selectedAppId) {
            mergeSlotInto(inherited, config.appDefaults?.[selectedAppId]);
        }
        mergeSlotInto(inherited, binding.defaults);
        return inherited;
    };

    const getInheritLabel = (): string => {
        if (level === "character") return "Inherit from global";
        if (level === "app") return appBindingScope === "global" ? "Inherit from global" : "Inherit from app/global binding";
        return "";
    };

    const handleUpdate = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        if (level === "global") updateGlobalSlot(field, value);
        else if (level === "character") updateCharDefaultSlot(field, value);
        else if (level === "app") updateAppSlot(field, value);
    };

    // Count how many fields are overridden in an app slot
    const countOverrides = (slot?: BindingSlot, appId?: string): number => {
        if (!slot) return 0;
        let count = 0;
        if (slot.apiConfigId) count++;
        if (slot.imageConfigId) count++;
        if (slot.presetId) count++;
        if (slot.userIdentityId) count++;
        if (slot.worldBookIds && slot.worldBookIds.length > 0) count++;
        if ((!appId || canBindRegexInApp(appId)) && slot.regexIds && slot.regexIds.length > 0) count++;
        return count;
    };

    const hasCharacterBinding = (characterId: string): boolean => {
        const binding = config.characterBindings.find(b => b.characterId === characterId);
        if (!binding) return false;
        return Boolean(
            binding.defaults.apiConfigId ||
            binding.defaults.imageConfigId ||
            binding.defaults.voiceConfigId ||
            binding.defaults.presetId ||
            binding.defaults.userIdentityId ||
            (binding.defaults.worldBookIds && binding.defaults.worldBookIds.length > 0) ||
            (binding.defaults.regexIds && binding.defaults.regexIds.length > 0) ||
            Object.keys(binding.appOverrides).length > 0
        );
    };

    const openCharacterBinding = (characterId: string) => {
        setSelectedCharId(characterId);
        setSelectedAppId(null);
        setActiveSlotSheetField(null);
        setActiveAuxSheetField(null);
        setShowCharacterPicker(false);
        setLevel("character");
    };

    if (!isLoaded) return null;

    const currentSlot = getCurrentSlot();
    const inheritedSlot = getInheritedSlot();
    const inheritLabel = getInheritLabel();
    const appOverrideEntries = [
        ...CONTENT_APP_IDS
            .filter(appId => appIconId(appId) in ICONS)
            .map(appId => ({
                id: appId as string,
                label: CONTENT_APP_LABELS[appId],
                iconId: appIconId(appId),
                iconDataUrl: null as string | null,
                color: APP_OVERRIDE_COLORS[appId],
            })),
        ...customApps.map(app => ({
            id: toCustomAppIconId(app.id) as string,
            label: app.name,
            iconId: "appmarket" as IconId,
            iconDataUrl: app.iconDataUrl ?? null,
            color: "#14b8a6",
        })),
    ];

    const isMultiBindingField = (field: BindingField): field is MultiBindingField =>
        field === "worldBookIds" || field === "regexIds";

    const getBindingFieldLabel = (field: BindingField): string => {
        switch (field) {
            case "apiConfigId": return "Text API";
            case "imageConfigId": return "Image Generation API";
            case "voiceConfigId": return "Voice API";
            case "presetId": return "Preset";
            case "userIdentityId": return "User Identity";
            case "worldBookIds": return "Worldbook";
            case "regexIds": return "Regex Rules";
        }
    };

    const getBindingFieldDescription = (field: BindingField): string => {
        switch (field) {
            case "apiConfigId": return "Text generation endpoint";
            case "imageConfigId": return "Image generation endpoint";
            case "voiceConfigId": return "Voice synthesis endpoint";
            case "presetId": return "Prompt preset";
            case "userIdentityId": return "User identity";
            case "worldBookIds": return "Enabled worldbooks";
            case "regexIds": return "Enabled regex rules";
        }
    };

    const getAuxFieldDescription = (field: AuxBindingField): string => {
        switch (field) {
            case "memorySummaryApiConfigId": return "Used for chat memory compression";
            case "embeddingApiConfigId": return "Used for semantic vector recall";
            case "mascotApiConfigId": return "Used for mascot chat and tool calls";
            case "reasoningTranslateApiConfigId": return "Used to translate reasoning (chain-of-thought) content";
        }
    };

    const getAuxFieldLabel = (field: AuxBindingField): string => {
        switch (field) {
            case "memorySummaryApiConfigId": return "Memory Summary API";
            case "embeddingApiConfigId": return "Vector Recall API";
            case "mascotApiConfigId": return "Mascot Assistant API";
            case "reasoningTranslateApiConfigId": return "Chain-of-Thought Translation API";
        }
    };

    const getBindingFieldOptions = (field: BindingField): { id: string; name: string }[] => {
        switch (field) {
            case "apiConfigId":
                return apiConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
            case "imageConfigId":
                return imageSettings ? getImageGenerationBindingOptions(imageSettings) : [];
            case "voiceConfigId":
                return voiceConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
            case "presetId":
                return presets.map(p => ({ id: p.id, name: p.name }));
            case "userIdentityId":
                return identities.map(i => ({ id: i.id, name: i.name }));
            case "worldBookIds":
                return worldBooks.map(w => ({ id: w.id, name: w.name }));
            case "regexIds":
                return regexes.map(r => ({ id: r.id, name: r.name }));
        }
    };

    const getSlotFieldValueDisplay = (slot: BindingSlot, field: BindingField): { text: string; isEmpty: boolean } => {
        const options = getBindingFieldOptions(field);
        if (isMultiBindingField(field)) {
            const selectedIds = (slot[field] || []).filter(id => options.some(item => item.id === id));
            if (selectedIds.length === 0) return { text: "", isEmpty: true };
            if (selectedIds.length === 1) {
                return { text: options.find(item => item.id === selectedIds[0])?.name || "1 selected", isEmpty: false };
            }
            return { text: `${selectedIds.length} selected`, isEmpty: false };
        }
        const value = slot[field];
        const selected = options.find(item => item.id === value);
        return selected ? { text: selected.name, isEmpty: false } : { text: "", isEmpty: true };
    };

    const getInheritedFieldLabel = (field: BindingField, fallback: string): string => {
        const inherited = getSlotFieldValueDisplay(inheritedSlot, field);
        return inherited.isEmpty ? fallback : `Inherited: ${inherited.text}`;
    };

    const getSlotFieldDisplay = (slot: BindingSlot, field: BindingField, emptyText: string): { text: string; isEmpty: boolean; isInherited: boolean } => {
        const current = getSlotFieldValueDisplay(slot, field);
        if (!current.isEmpty) return { ...current, isInherited: false };
        const inherited = getSlotFieldValueDisplay(inheritedSlot, field);
        if (!inherited.isEmpty) return { text: `Inherited: ${inherited.text}`, isEmpty: false, isInherited: true };
        return { text: emptyText, isEmpty: true, isInherited: false };
    };

    const renderBindingFieldIcon = (field: BindingField, size = 23) => {
        const visual = BINDING_FIELD_VISUALS[field];
        const Icon = visual.icon;
        return (
            <span className="binding-choice-icon" style={bindingAccentStyle(visual.color)}>
                <Icon size={size} strokeWidth={1.9} />
            </span>
        );
    };

    const renderAuxFieldIcon = (field: AuxBindingField) => {
        const visual = AUX_FIELD_VISUALS[field];
        const Icon = visual.icon;
        return (
            <span className="binding-choice-icon binding-choice-icon-inline" style={bindingAccentStyle(visual.color)}>
                <Icon size={22} strokeWidth={1.8} />
            </span>
        );
    };

    const updateAuxField = (field: AuxBindingField, value: string | undefined) => {
        persist({ ...config, [field]: value || undefined });
    };

    const renderAuxSelect = (
        field: AuxBindingField,
        label: string,
    ) => {
        const currentValue = config[field];
        const options = apiConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
        const selectedOption = options.find(o => o.id === currentValue);
        const displayValue = selectedOption ? selectedOption.name : "Inherit from global";

        return (
            <div key={field} className="binding-aux-select">
                <button
                    type="button"
                    onClick={() => {
                        reloadData();
                        setActiveAuxSheetField(field);
                    }}
                    className="binding-aux-trigger"
                    aria-haspopup="dialog"
                >
                    {renderAuxFieldIcon(field)}
                    <span className="binding-card-copy">
                        <span className="binding-choice-label">{label}</span>
                        <span className="binding-choice-desc">{getAuxFieldDescription(field)}</span>
                    </span>
                    <span className="binding-choice-row">
                        <span className={selectedOption ? "binding-choice-value" : "binding-choice-value is-empty"}>{displayValue}</span>
                        <ChevronRight
                            size={15}
                            strokeWidth={1.7}
                            className="binding-choice-chevron"
                        />
                    </span>
                </button>
            </div>
        );
    };

    const renderBindingSlotCards = (
        slot: BindingSlot,
        emptyText: string,
        onOpenField: (field: BindingField) => void,
        options?: { includeRegex?: boolean; includeVoice?: boolean },
    ) => {
        const primaryFields: BindingField[] = options?.includeVoice === false
            ? ["apiConfigId", "imageConfigId"]
            : ["apiConfigId", "imageConfigId", "voiceConfigId"];
        const compactFields: BindingField[] = options?.includeRegex === false
            ? ["presetId", "worldBookIds"]
            : ["presetId", "worldBookIds", "regexIds"];
        const renderBindingCard = (field: BindingField, variant: "large" | "small" | "wide") => {
            const display = getSlotFieldDisplay(slot, field, emptyText);
            const valueClassName = [
                "binding-choice-value",
                display.isEmpty ? "is-empty" : "",
                display.isInherited ? "is-inherited" : "",
            ].filter(Boolean).join(" ");
            return (
                <button
                    key={field}
                    type="button"
                    className={`binding-choice-card binding-choice-card-global binding-choice-card-${variant}`}
                    onClick={() => {
                        reloadData();
                        onOpenField(field);
                    }}
                >
                    <span className="binding-card-main">
                        {renderBindingFieldIcon(field, variant === "wide" ? 23 : 20)}
                        <span className="binding-card-copy">
                            <span className="binding-choice-label">{getBindingFieldLabel(field)}</span>
                            <span className="binding-choice-desc">{getBindingFieldDescription(field)}</span>
                        </span>
                    </span>
                    <span className="binding-choice-row">
                        <span className={valueClassName}>{display.text}</span>
                        <ChevronRight size={15} strokeWidth={1.7} className="binding-choice-chevron" />
                    </span>
                </button>
            );
        };

        return (
            <div className="binding-global-grid">
                <div className="binding-global-primary-row" data-count={primaryFields.length}>
                    {primaryFields.map(field => renderBindingCard(field, "large"))}
                </div>
                <div className="binding-global-compact-row" data-count={compactFields.length}>
                    {compactFields.map(field => renderBindingCard(field, "small"))}
                </div>
                {renderBindingCard("userIdentityId", "wide")}
            </div>
        );
    };

    const renderGlobalSlotCards = () => (
        renderBindingSlotCards(config.globalDefaults, "Not set", setActiveGlobalSheetField)
    );

    const renderCharacterSlotCards = () => (
        renderBindingSlotCards(currentSlot, inheritLabel, setActiveSlotSheetField)
    );

    // The four global-level base fields (text/image/preset/identity) don't offer "Not set":
    // leaving one blank only triggers a silent fallback, so we write the fallback value
    // straight into storage and drop the "not set" option -- what you see is what you get.
    const isRequiredGlobalField = (field: BindingField): boolean =>
        field === "apiConfigId" || field === "imageConfigId" || field === "presetId" || field === "userIdentityId";

    const renderGlobalPickerSheet = () => {
        if (!activeGlobalSheetField) return null;
        const field = activeGlobalSheetField;
        const label = getBindingFieldLabel(field);
        const options = getBindingFieldOptions(field);
        const isMulti = isMultiBindingField(field);
        const hideUnsetOption = isRequiredGlobalField(field);
        const selectedIds = isMulti ? (config.globalDefaults[field] || []).filter(id => options.some(item => item.id === id)) : [];
        const selectedValue = !isMulti ? config.globalDefaults[field] : undefined;

        const clearSelection = () => {
            updateGlobalSlot(field, undefined);
            if (!isMulti) setActiveGlobalSheetField(null);
        };

        const toggleMulti = (id: string) => {
            if (!isMulti) return;
            const next = selectedIds.includes(id)
                ? selectedIds.filter(item => item !== id)
                : [...selectedIds, id];
            updateGlobalSlot(field, next.length > 0 ? next : undefined);
        };

        return (
            <div className="modal-overlay" data-ui="modal" onClick={() => setActiveGlobalSheetField(null)}>
                <div
                    className="binding-picker-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Select ${label}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="binding-picker-header">
                        <button
                            type="button"
                            className="binding-picker-icon-btn"
                            onClick={() => setActiveGlobalSheetField(null)}
                            aria-label="Close"
                        >
                            <X size={17} />
                        </button>
                        <h3 className="binding-picker-title">Select {label}</h3>
                        {isMulti ? (
                            <button
                                type="button"
                                className="binding-picker-done-btn"
                                onClick={() => setActiveGlobalSheetField(null)}
                            >
                                Done
                            </button>
                        ) : (
                            <span className="binding-picker-header-spacer" />
                        )}
                    </div>
                    <div className="binding-picker-body">
                        <div className="binding-sheet-list">
                            {!hideUnsetOption && (
                                <button
                                    type="button"
                                    className="binding-sheet-option"
                                    data-selected={isMulti ? selectedIds.length === 0 : !selectedValue}
                                    onClick={clearSelection}
                                >
                                    <span className="binding-sheet-check">{(isMulti ? selectedIds.length === 0 : !selectedValue) && <Check size={15} />}</span>
                                    <span className="binding-sheet-option-text">Not set</span>
                                </button>
                            )}
                            {options.length === 0 ? (
                                <div className="binding-sheet-empty">No {label} available. Please create one on the corresponding settings page first.</div>
                            ) : (
                                options.map(option => {
                                    const selected = isMulti ? selectedIds.includes(option.id) : selectedValue === option.id;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            className="binding-sheet-option"
                                            data-selected={selected}
                                            aria-pressed={selected}
                                            onClick={() => {
                                                if (isMulti) {
                                                    toggleMulti(option.id);
                                                } else {
                                                    updateGlobalSlot(field, option.id);
                                                    setActiveGlobalSheetField(null);
                                                }
                                            }}
                                        >
                                            <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                            <span className="binding-sheet-option-text">{option.name}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderSlotPickerDialog = () => {
        if (!activeSlotSheetField) return null;
        const field = activeSlotSheetField;
        const label = getBindingFieldLabel(field);
        const options = getBindingFieldOptions(field);
        const isMulti = isMultiBindingField(field);
        const selectedIds = isMulti ? ((currentSlot[field as MultiBindingField] || []).filter(id => options.some(item => item.id === id))) : [];
        const selectedValue = !isMulti ? currentSlot[field as SingleBindingField] : undefined;
        const emptyLabel = level === "global" ? "Not set" : getInheritedFieldLabel(field, inheritLabel);

        const clearSelection = () => {
            handleUpdate(field, undefined);
            if (!isMulti) setActiveSlotSheetField(null);
        };

        const toggleMulti = (id: string) => {
            if (!isMulti) return;
            const next = selectedIds.includes(id)
                ? selectedIds.filter(item => item !== id)
                : [...selectedIds, id];
            handleUpdate(field, next.length > 0 ? next : undefined);
        };

        return (
            <div className="modal-overlay" data-ui="modal" onClick={() => setActiveSlotSheetField(null)}>
                <div
                    className="binding-picker-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Select ${label}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="binding-picker-header">
                        <button
                            type="button"
                            className="binding-picker-icon-btn"
                            onClick={() => setActiveSlotSheetField(null)}
                            aria-label="Close"
                        >
                            <X size={17} />
                        </button>
                        <h3 className="binding-picker-title">Select {label}</h3>
                        {isMulti ? (
                            <button
                                type="button"
                                className="binding-picker-done-btn"
                                onClick={() => setActiveSlotSheetField(null)}
                            >
                                Done
                            </button>
                        ) : (
                            <span className="binding-picker-header-spacer" />
                        )}
                    </div>
                    <div className="binding-picker-body">
                        <div className="binding-sheet-list">
                            {/* The global level's API/preset/identity fields don't offer "not set" (character/app level keeps "inherit from parent") */}
                            {!(level === "global" && isRequiredGlobalField(field)) && (
                                <button
                                    type="button"
                                    className="binding-sheet-option"
                                    data-selected={isMulti ? selectedIds.length === 0 : !selectedValue}
                                    onClick={clearSelection}
                                >
                                    <span className="binding-sheet-check">{(isMulti ? selectedIds.length === 0 : !selectedValue) && <Check size={15} />}</span>
                                    <span className="binding-sheet-option-text">{emptyLabel}</span>
                                </button>
                            )}
                            {options.length === 0 ? (
                                <div className="binding-sheet-empty">No {label} available. Please create one on the corresponding settings page first.</div>
                            ) : (
                                options.map(option => {
                                    const selected = isMulti ? selectedIds.includes(option.id) : selectedValue === option.id;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            className="binding-sheet-option"
                                            data-selected={selected}
                                            aria-pressed={selected}
                                            onClick={() => {
                                                if (isMulti) {
                                                    toggleMulti(option.id);
                                                } else {
                                                    handleUpdate(field, option.id);
                                                    setActiveSlotSheetField(null);
                                                }
                                            }}
                                        >
                                            <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                            <span className="binding-sheet-option-text">{option.name}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderAuxPickerDialog = () => {
        if (!activeAuxSheetField) return null;
        const field = activeAuxSheetField;
        const label = getAuxFieldLabel(field);
        const options = apiConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
        const selectedValue = config[field];

        return (
            <div className="modal-overlay" data-ui="modal" onClick={() => setActiveAuxSheetField(null)}>
                <div
                    className="binding-picker-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Select ${label}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="binding-picker-header">
                        <button
                            type="button"
                            className="binding-picker-icon-btn"
                            onClick={() => setActiveAuxSheetField(null)}
                            aria-label="Close"
                        >
                            <X size={17} />
                        </button>
                        <h3 className="binding-picker-title">Select {label}</h3>
                        <span className="binding-picker-header-spacer" />
                    </div>
                    <div className="binding-picker-body">
                        <div className="binding-sheet-list">
                            <button
                                type="button"
                                className="binding-sheet-option"
                                data-selected={!selectedValue}
                                onClick={() => {
                                    updateAuxField(field, undefined);
                                    setActiveAuxSheetField(null);
                                }}
                            >
                                <span className="binding-sheet-check">{!selectedValue && <Check size={15} />}</span>
                                <span className="binding-sheet-option-text">Inherit from global</span>
                            </button>
                            {options.length === 0 ? (
                                <div className="binding-sheet-empty">No API configs available. Please create one on the API settings page first.</div>
                            ) : (
                                options.map(option => {
                                    const selected = selectedValue === option.id;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            className="binding-sheet-option"
                                            data-selected={selected}
                                            aria-pressed={selected}
                                            onClick={() => {
                                                updateAuxField(field, option.id);
                                                setActiveAuxSheetField(null);
                                            }}
                                        >
                                            <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                            <span className="binding-sheet-option-text">{option.name}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderCharacterPickerDialog = () => {
        if (!showCharacterPicker) return null;
        return (
            <div className="modal-overlay" data-ui="modal" onClick={() => setShowCharacterPicker(false)}>
                <div
                    className="modal-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Select Character"
                    onClick={(event) => event.stopPropagation()}
                >
                    <span className="modal-header-title">Select Character</span>
                    {characters.length === 0 ? (
                        <span className="menu-desc">No characters yet. Please create one in the character library first.</span>
                    ) : (
                        <div className="chat-contact-list">
                            {characters.map(char => {
                                const configured = hasCharacterBinding(char.id);
                                const name = char.name || "Unnamed Character";
                                return (
                                    <button
                                        key={char.id}
                                        type="button"
                                        className="chat-contact-item binding-contact-item"
                                        onClick={() => openCharacterBinding(char.id)}
                                    >
                                        <span className="chat-contact-avatar">
                                            {char.avatar ? (
                                                <img src={char.avatar} alt="" />
                                            ) : (
                                                <span className="chat-contact-avatar-fallback">
                                                    {name.charAt(0)}
                                                </span>
                                            )}
                                        </span>
                                        <span className="chat-contact-name">{name}</span>
                                        {configured && <span className="binding-contact-badge" aria-label="Configured" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-col gap-[24px]">
            {/* Level 1: Global defaults + character action */}
            {level === "global" && (
                <>
                    <section className="flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-3">
                            <p className="settings-menu-section-title min-w-0">Global Defaults</p>
                            <button
                                type="button"
                                onClick={() => setShowCharacterPicker(true)}
                                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[18px] bg-black px-3 text-[calc(11px*var(--app-text-scale,1))] font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                            >
                                <UserPlus size={14} strokeWidth={1.8} />
                                Configure Bindings for Character
                            </button>
                        </div>
                        {renderGlobalSlotCards()}
                    </section>

                    <section className="flex flex-col gap-3">
                        <p className="settings-menu-section-title">Application Binding</p>
                        <div className="binding-aux-select">
                            <button
                                type="button"
                                className="binding-aux-trigger"
                                onClick={() => {
                                    setAppBindingScope("global");
                                    setSelectedCharId("");
                                    setSelectedAppId(null);
                                    setActiveSlotSheetField(null);
                                    setLevel("app-list");
                                }}
                            >
                                <span className="binding-choice-icon binding-choice-icon-inline" style={bindingAccentStyle(BINDING_ACCENTS.api)}>
                                    <Layers size={22} strokeWidth={1.8} />
                                </span>
                                <span className="binding-card-copy">
                                    <span className="binding-choice-label">Global App Bindings</span>
                                    <span className="binding-choice-desc">Set a text and image generation plan per app</span>
                                </span>
                                <span className="binding-choice-row">
                                    <span className="binding-choice-value">
                                        {(() => {
                                            const count = appOverrideEntries.filter(app => countOverrides(config.appDefaults?.[app.id], app.id) > 0).length;
                                            return count > 0 ? `${count} set` : "Not set";
                                        })()}
                                    </span>
                                    <ChevronRight size={15} strokeWidth={1.7} className="binding-choice-chevron" />
                                </span>
                            </button>
                        </div>
                    </section>

                    <section className="flex flex-col gap-3">
                        <p className="settings-menu-section-title">Auxiliary API</p>
                        <div className="flex flex-col gap-3">
                            {renderAuxSelect("memorySummaryApiConfigId", "Memory Summary API")}
                            {renderAuxSelect("embeddingApiConfigId", "Vector Recall API")}
                            {renderAuxSelect("mascotApiConfigId", "Mascot Assistant API")}
                            {renderAuxSelect("reasoningTranslateApiConfigId", "Chain-of-Thought Translation API")}
                        </div>
                    </section>
                </>
            )}
            {renderGlobalPickerSheet()}
            {renderSlotPickerDialog()}
            {renderAuxPickerDialog()}
            {renderCharacterPickerDialog()}

            {/* Level 2: Global APP list */}
            {level === "app-list" && (
                <section className="flex flex-col gap-3">
                    <p className="binding-priority-note">Priority order: character binding &gt; app binding &gt; global binding</p>
                    <div className="binding-app-grid">
                        {appOverrideEntries.map(app => {
                            const overrideCount = countOverrides(config.appDefaults?.[app.id], app.id);
                            return (
                                <button
                                    key={app.id}
                                    type="button"
                                    onClick={() => {
                                        setAppBindingScope("global");
                                        setSelectedCharId("");
                                        setSelectedAppId(app.id);
                                        setActiveSlotSheetField(null);
                                        setLevel("app");
                                    }}
                                    className="g-card binding-app-card"
                                    style={bindingAccentStyle(app.color)}
                                    aria-label={`${app.label} global app binding`}
                                >
                                    <span className="binding-app-icon">
                                        {app.iconDataUrl ? (
                                            <img src={app.iconDataUrl} alt="" className="binding-app-icon-image" />
                                        ) : (
                                            <IconGlyph id={app.iconId} className="binding-app-icon-glyph" />
                                        )}
                                    </span>
                                    <span className="binding-app-label">{app.label}</span>
                                    {overrideCount > 0 && <span className="binding-app-badge">{overrideCount}</span>}
                                </button>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* Level 2: Character binding details */}
            {level === "character" && (
                <>
                    <section className="flex flex-col gap-3">
                        <p className="settings-menu-section-title">Character Defaults</p>
                        {renderCharacterSlotCards()}
                    </section>

                    <section className="flex flex-col gap-3">
                        <p className="settings-menu-section-title">App Bindings</p>
                        <div className="binding-app-grid">
                            {appOverrideEntries.map(app => {
                                const appSlot = getCharacterBinding(config, selectedCharId).appOverrides[app.id];
                                const overrideCount = countOverrides(appSlot, app.id);
                                return (
                                    <button
                                        key={app.id}
                                        type="button"
                                        onClick={() => {
                                            setAppBindingScope("character");
                                            setSelectedAppId(app.id);
                                            setActiveSlotSheetField(null);
                                            setLevel("app");
                                        }}
                                        className="g-card binding-app-card"
                                        style={bindingAccentStyle(app.color)}
                                        aria-label={`${app.label} App Binding`}
                                    >
                                        <span className="binding-app-icon">
                                            {app.iconDataUrl ? (
                                                <img src={app.iconDataUrl} alt="" className="binding-app-icon-image" />
                                            ) : (
                                                <IconGlyph id={app.iconId} className="binding-app-icon-glyph" />
                                            )}
                                        </span>
                                        <span className="binding-app-label">
                                            {app.label}
                                        </span>
                                        {overrideCount > 0 && (
                                            <span className="binding-app-badge">
                                                {overrideCount}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                </>
            )}

            {/* Level 3: App binding */}
            {level === "app" && (
                <>
                    <section className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <p className="settings-menu-section-title">App Binding</p>
                            <p className="binding-priority-note">Priority order: character binding &gt; app binding &gt; global binding</p>
                        </div>
                        {renderBindingSlotCards(currentSlot, inheritLabel, setActiveSlotSheetField, {
                            includeRegex: canBindRegexInApp(selectedAppId),
                            includeVoice: false,
                        })}
                    </section>

                    <button
                        onClick={resetAppBinding}
                        className="ui-btn ui-btn-soft-danger flex justify-center"
                    >
                        <RotateCcw size={16} /> {appBindingScope === "global" ? "Reset This App's Binding" : "Reset This Character's App Binding"}
                    </button>
                </>
            )}
        </div>
    );
}
