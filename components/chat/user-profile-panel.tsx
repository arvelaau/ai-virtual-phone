"use client";

import { useState, useEffect, type CSSProperties } from "react";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import {
    loadFollowUpConfig,
    saveFollowUpConfig,
    getDefaultFollowUpConfig,
    resolveUserIdentity,
} from "@/lib/settings-storage";
import { loadChatAppSettings, saveChatAppSettings } from "@/lib/chat-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import { getApiLogs, clearApiLogs, type DebugInfo } from "@/lib/chat-engine";
import type { FollowUpConfig } from "@/lib/settings-storage";
import { PageShell } from "@/components/ui/page-shell";
import { CHAT_APP_CSS_EXAMPLE } from "@/lib/css-examples";
import { Toggle } from "@/components/ui/form";
import { StickerManager } from "./sticker-manager";
import { ChatPluginManager } from "./chat-plugin-manager";
import { WalletPanel } from "./wallet-panel";
import { loadMomentsConfig, saveMomentsConfig, DEFAULT_MOMENTS_CONFIG, type MomentsInteractionConfig, getAllPosts } from "@/lib/moments-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { triggerImmediatePost } from "@/lib/moments-engine";
import type { Character } from "@/lib/character-types";
import { requestNotificationPermission } from "@/lib/browser-notification";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";
import { formatWalletAmount, getWalletBalance, loadWalletState, WALLET_UPDATED_EVENT } from "@/lib/wallet-storage";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import {
    Bell,
    ChevronRight,
    Clock,
    FileCode2,
    Heart,
    MessageSquare,
    MessageSquareDashed,
    Palette,
    Puzzle,
    Keyboard,
    Radio,
    RotateCcw,
    Send,
    SlidersHorizontal,
    Sticker,
    ThumbsUp,
    Trash2,
    User,
    type LucideIcon,
} from "lucide-react";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";

type UserProfilePanelProps = {
    onClose: () => void;
    className?: string;
};

const profileSettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function ProfileSettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="chat-info-icon" style={profileSettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

function ProfileSettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    valueLabel,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc?: string;
    value: number;
    valueLabel: string;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <div className="menu-item profile-slider-item">
            <div className="profile-slider-header">
                <ProfileSettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    {desc && <span className="menu-desc">{desc}</span>}
                </div>
                <span className="profile-slider-current">{valueLabel}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={event => onChange(Number(event.target.value))}
                className="ui-slider profile-settings-slider"
            />
        </div>
    );
}

function readBrowserNotificationPermissionHint(): string {
    if (typeof window === "undefined") return "Current browser permission: unknown (server-side render)";
    if (!("Notification" in window)) return "Current browser permission: Notification API not supported";
    const permission = Notification.permission;
    const secureHint = window.isSecureContext ? "" : "; not currently an HTTPS/secure context";
    const originHint = `Current site: ${window.location.origin}`;
    if (permission === "granted") return `${originHint}; browser permission: granted${secureHint}`;
    if (permission === "denied") return `${originHint}; browser permission: denied${secureHint}`;
    return `${originHint}; browser permission: not authorized (default)${secureHint}`;
}

function isBrowserNotificationGranted(): boolean {
    return typeof window !== "undefined"
        && "Notification" in window
        && Notification.permission === "granted";
}

/* ══════════════════════════════════════════
   Main export
   ══════════════════════════════════════════ */
export function UserProfilePanel({ onClose, className }: UserProfilePanelProps) {
    const [showFollowUpEditor, setShowFollowUpEditor] = useState(false);
    const [showApiLog, setShowApiLog] = useState(false);
    const [showStickerManager, setShowStickerManager] = useState(false);
    const [showPluginManager, setShowPluginManager] = useState(false);
    const [showCSSEditor, setShowCSSEditor] = useState(false);
    const [showMomentsSettings, setShowMomentsSettings] = useState(false);
    const [showWalletPanel, setShowWalletPanel] = useState(false);
    const [identity, setIdentity] = useState<UserIdentity | null>(null);
    const [notifEnabled, setNotifEnabled] = useState(false);
    const [notifHint, setNotifHint] = useState<string | null>(null);
    const [notifChecking, setNotifChecking] = useState(false);
    const [enterToSendEnabled, setEnterToSendEnabled] = useState(false);
    const [userStats, setUserStats] = useState({ chats: 0, moments: 0, visitors: 1234 });
    const [walletSummary, setWalletSummary] = useState(() => {
        const wallet = loadWalletState();
        return {
            totalLabel: formatWalletAmount(getWalletBalance(wallet)),
            cardCount: wallet.cards.length,
        };
    });

    useEffect(() => {
        setIdentity(resolveUserIdentity());
        const settings = loadChatAppSettings();
        const browserGranted = isBrowserNotificationGranted();
        setNotifEnabled(settings.browserNotificationsEnabled === true && browserGranted);
        setEnterToSendEnabled(settings.enterToSendEnabled === true);
        if (settings.browserNotificationsEnabled === true && !browserGranted) {
            setNotifHint(readBrowserNotificationPermissionHint());
        }
        const wallet = loadWalletState();
        setWalletSummary({
            totalLabel: formatWalletAmount(getWalletBalance(wallet)),
            cardCount: wallet.cards.length,
        });

        // Fetch dynamic user stats
        try {
            const contactsCount = loadChatContacts().length;
            const userPostsCount = getAllPosts().filter(p => p.authorType === "user").length;
            setUserStats({
                chats: contactsCount,
                moments: userPostsCount,
                visitors: 1234 + contactsCount * 17 + userPostsCount * 43 // simple deterministic mock equation
            });
        } catch (e) { }
    }, []);

    useEffect(() => {
        const syncWallet = () => {
            const wallet = loadWalletState();
            setWalletSummary({
                totalLabel: formatWalletAmount(getWalletBalance(wallet)),
                cardCount: wallet.cards.length,
            });
        };
        window.addEventListener(WALLET_UPDATED_EVENT, syncWallet);
        return () => window.removeEventListener(WALLET_UPDATED_EVENT, syncWallet);
    }, []);

    const handleNotificationToggle = async (enabled: boolean) => {
        if (notifChecking) return;

        if (!enabled) {
            setNotifEnabled(false);
            saveChatAppSettings({ ...loadChatAppSettings(), browserNotificationsEnabled: false });
            setNotifHint(`Turned off. ${readBrowserNotificationPermissionHint()}`);
            return;
        }

        setNotifChecking(true);
        setNotifHint("Checking browser notification permission...");
        try {
            const granted = await requestNotificationPermission();
            const permissionHint = readBrowserNotificationPermissionHint();
            if (granted && isBrowserNotificationGranted()) {
                setNotifEnabled(true);
                saveChatAppSettings({ ...loadChatAppSettings(), browserNotificationsEnabled: true });
                setNotifHint(permissionHint);
            } else {
                setNotifEnabled(false);
                saveChatAppSettings({ ...loadChatAppSettings(), browserNotificationsEnabled: false });
                setNotifHint(permissionHint);
            }
        } finally {
            setNotifChecking(false);
        }
    };

    const handleEnterToSendToggle = (enabled: boolean) => {
        setEnterToSendEnabled(enabled);
        saveChatAppSettings({ ...loadChatAppSettings(), enterToSendEnabled: enabled });
    };

    if (showFollowUpEditor) {
        return <FollowUpSettingsEditor onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); setShowFollowUpEditor(false); }} />;
    }
    if (showApiLog) {
        return <ApiLogViewer onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); setShowApiLog(false); }} />;
    }
    if (showCSSEditor) {
        return <ChatCSSEditor onBack={() => { setShowCSSEditor(false); }} />;
    }
    if (showStickerManager) {
        return <StickerManager onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); setShowStickerManager(false); }} />;
    }
    if (showPluginManager) {
        return <ChatPluginManager onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); setShowPluginManager(false); }} />;
    }
    if (showMomentsSettings) {
        return <InlineMomentsSettings onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); setShowMomentsSettings(false); }} />;
    }
    if (showWalletPanel) {
        return <WalletPanel onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); setShowWalletPanel(false); }} />;
    }

    return (
        <>
            <style>{`
                .user-profile-page-root {
                    background: var(--c-page-body-bg) !important;
                }
                .user-profile-page-root::before {
                    content: "";
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 300px;
                    pointer-events: none;
                    background: linear-gradient(135deg, color-mix(in srgb, #246bfd 12%, transparent) 0%, color-mix(in srgb, var(--c-success) 8%, transparent) 100%);
                    mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
                    -webkit-mask-image: linear-gradient(to bottom, black 50%, transparent 100%);
                    z-index: 0;
                }
                .user-profile-page-root .page-header {
                    background: transparent !important;
                    backdrop-filter: none !important;
                    -webkit-backdrop-filter: none !important;
                    border-bottom: none !important;
                    z-index: 30;
                }
                .user-profile-page-root > .page-body {
                    position: absolute;
                    top: calc(var(--page-header-safe-top, 48px) + var(--page-header-content-height, 54px));
                    left: 0;
                    right: 0;
                    bottom: 0;
                    padding-top: 0 !important;
                    background: transparent !important;
                }
                .user-profile-page-root .page-title {
                    display: none;
                }
            `}</style>
            <PageShell title="" onBack={onClose} className={`user-profile-page-root ${className || ""}`}>
                <div className="relative z-[1] w-full max-w-2xl mx-auto flex flex-col pb-8">
                    
                    {/* User Info & Stats Block */}
                    <div className="flex items-center gap-5 px-6 pt-2 pb-4">
                        {/* Avatar */}
                        <div className="relative shrink-0">
                            <div className="w-[84px] h-[84px] rounded-full overflow-hidden bg-[var(--c-card)] border-2 border-white/50 shadow-sm flex items-center justify-center relative"
                                 style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
                                {identity?.avatarUrl ? (
                                    <img src={identity.avatarUrl} alt="User Avatar" className="w-full h-full object-cover" />
                                ) : (
                                    <User size={38} color="var(--c-icon)" />
                                )}
                            </div>
                        </div>

                        {/* Info & Stats */}
                        <div className="flex flex-col flex-1 justify-center gap-2">
                            {/* Top Row: Name and Identity Badge */}
                            <div className="flex items-center justify-between w-full mb-0.5">
                                <div className="ts-22 font-bold text-[var(--c-text-title)] leading-none truncate">{identity?.name || "Identity not set"}</div>
                                <div className="flex items-center gap-1.5 ts-11 font-medium bg-black/5 dark:bg-white/10 px-2 py-0.5 rounded-full shrink-0 text-[var(--c-text)] opacity-80">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />
                                    Online
                                </div>
                            </div>

                            {/* Data Stats inline */}
                            <div className="flex items-center justify-between w-full ts-12 text-[var(--c-text-title)] font-medium mt-0.5">
                                <span className="opacity-80">Chatting <span className="font-bold opacity-100">{userStats.chats}</span></span>
                                <span className="opacity-20 text-[calc(10px*var(--app-text-scale,1))] transform scale-y-125">|</span>
                                <span className="opacity-80">Moments <span className="font-bold opacity-100">{userStats.moments}</span></span>
                                <span className="opacity-20 text-[calc(10px*var(--app-text-scale,1))] transform scale-y-125">|</span>
                                <span className="opacity-80">Visitors <span className="font-bold opacity-100">{userStats.visitors}</span></span>
                            </div>
                        </div>
                    </div>



                    <button
                        type="button"
                        className="mx-4 mb-4 rounded-2xl overflow-hidden text-left relative min-h-[132px] p-5 flex flex-col justify-between"
                        onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowWalletPanel(true); }}
                        style={{ background: "#eaf5ff", boxShadow: "0 8px 24px rgba(0,0,0,0.025)", border: "1px solid rgba(255,255,255,0.72)", color: "#172033" }}
                    >
                        <div className="relative flex items-start justify-between gap-4">
                            <div>
                                <div className="ts-11 font-semibold opacity-70 tracking-[0.18em] uppercase">Real Balance</div>
                                <div className="ts-30 font-semibold mt-2" style={{ fontFamily: "Georgia, serif" }}>{walletSummary.totalLabel}</div>
                            </div>
                            <span className="ts-11 font-semibold opacity-70 tracking-[0.18em] shrink-0" style={{ color: "#172033" }}>{walletSummary.cardCount} bank card(s)</span>
                        </div>
                        <div className="relative flex items-center justify-between gap-3">
                            <span className="ts-12 opacity-75">Balance Management · Bank Cards & Transactions</span>
                            <span className="h-8 px-3 rounded-full bg-white/70 border border-white/80 ts-12 font-semibold flex items-center gap-1" style={{ color: "#246bfd" }}>
                                View
                                <ChevronRight size={14} />
                            </span>
                        </div>
                    </button>

                    {/* Quick Features Row */}
                    <div className="mx-4 mb-4 bg-[var(--c-card)] rounded-2xl flex items-center justify-between p-4 px-6"
                         style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025)" }}>
                        <button className="flex flex-col items-center gap-2 flex-1" onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowMomentsSettings(true); }}>
                            <div className="w-[42px] h-[42px] rounded-[14px] bg-[color-mix(in_srgb,var(--c-warning)_15%,transparent)] text-[var(--c-warning)] flex items-center justify-center">
                                <Radio size={22} strokeWidth={2} />
                            </div>
                            <span className="ts-12 font-semibold text-[var(--c-text-title)]">Moments Interaction</span>
                        </button>
                        <button className="flex flex-col items-center gap-2 flex-1" onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowStickerManager(true); }}>
                            <div className="w-[42px] h-[42px] rounded-[14px] bg-[#10b981]/15 text-[#10b981] flex items-center justify-center">
                                <Sticker size={22} strokeWidth={2} />
                            </div>
                            <span className="ts-12 font-semibold text-[var(--c-text-title)]">Sticker Storage</span>
                        </button>
                        <button className="flex flex-col items-center gap-2 flex-1" onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowCSSEditor(true); }}>
                            <div className="w-[42px] h-[42px] rounded-[14px] bg-[color-mix(in_srgb,var(--c-danger)_15%,transparent)] text-[var(--c-danger)] flex items-center justify-center">
                                <Palette size={22} strokeWidth={2} />
                            </div>
                            <span className="ts-12 font-semibold text-[var(--c-text-title)]">Appearance CSS</span>
                        </button>
                    </div>

                    {/* Standard Settings List */}
                    <div className="mx-4 bg-[var(--c-card)] rounded-2xl px-4 py-1 flex flex-col"
                         style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025)" }}>
                        <button className="flex items-center gap-3 py-3.5 w-full border-b border-[color-mix(in_srgb,var(--c-card-border)_20%,transparent)]" onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowFollowUpEditor(true); }}>
                            <Send size={18} className="text-[var(--c-icon)] opacity-70" strokeWidth={1.25}/>
                            <div className="flex flex-col flex-1 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)]">Follow-Up Rules & Delay Control</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70">Set how often and how quickly characters send follow-up replies</span>
                            </div>
                            <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50" />
                        </button>
                        
                        <button className="flex items-center gap-3 py-3.5 w-full border-b border-[color-mix(in_srgb,var(--c-card-border)_20%,transparent)]" onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowApiLog(true); }}>
                            <FileCode2 size={18} className="text-[var(--c-icon)] opacity-70" strokeWidth={1.25}/>
                            <div className="flex flex-col flex-1 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)]">Underlying LLM Call Log</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70">View the raw data stream from LLM network communication</span>
                            </div>
                            <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50" />
                        </button>

                        <button className="flex items-center gap-3 py-3.5 w-full border-b border-[color-mix(in_srgb,var(--c-card-border)_20%,transparent)]" onClick={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true })); setShowPluginManager(true); }}>
                            <Puzzle size={18} className="text-[var(--c-icon)] opacity-70" strokeWidth={1.25}/>
                            <div className="flex flex-col flex-1 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)]">Extensions</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70">JS plugins can intercept the chat pipeline, inject prompts, and freely render UI</span>
                            </div>
                            <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50" />
                        </button>

                        <div className="flex items-center gap-3 py-3 w-full border-b border-[color-mix(in_srgb,var(--c-card-border)_20%,transparent)]">
                            <Keyboard size={18} className="text-[var(--c-icon)] opacity-70" strokeWidth={1.25}/>
                            <div className="flex flex-col flex-1 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)]">Send with Enter</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70">When on, Enter sends the message and Shift+Enter adds a new line</span>
                            </div>
                            <Toggle checked={enterToSendEnabled} onChange={handleEnterToSendToggle} />
                        </div>

                        <div className="flex items-center gap-3 py-3 w-full">
                            <Bell size={18} className="text-[var(--c-icon)] opacity-70" strokeWidth={1.25}/>
                            <div className="flex flex-col flex-1 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)]">Background Browser Notifications</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70">{notifHint || "Allow the page to show new-message banner alerts while in the background"}</span>
                            </div>
                            <Toggle checked={notifEnabled} disabled={notifChecking} onChange={handleNotificationToggle} />
                        </div>
                    </div>
                </div>
            </PageShell>
        </>
    );
}


/* ══════════════════════════════════════════
   Chat CSS Editor (sub-page)
   ══════════════════════════════════════════ */
function ChatCSSEditor({ onBack }: { onBack: () => void }) {
    const [css, setCss] = useState(() => kvGet("chat-app-custom-css") || "");

    const handleApply = () => {
        const trimmed = css.trim();
        if (trimmed) kvSet("chat-app-custom-css", trimmed);
        else kvRemove("chat-app-custom-css");
        window.dispatchEvent(new CustomEvent("chat-app-css-updated"));
    };

    const handleClear = () => {
        setCss("");
        kvRemove("chat-app-custom-css");
        window.dispatchEvent(new CustomEvent("chat-app-css-updated"));
    };

    return (
        <PageShell title="Custom CSS" onBack={() => { window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false })); onBack(); }}>
            <div className="p-4 flex flex-col gap-3 flex-1">
                <div className="ts-12 text-[var(--c-text)] opacity-70">
                    Enter CSS here to customize chat page styles (contact list, Moments, default chat room style, etc.). CSS for an individual chat room takes priority.
                </div>
                <textarea
                    value={css}
                    onChange={(e) => setCss(e.target.value)}
                    placeholder="/* Enter CSS to customize the chat page style... */"
                    className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
                    style={{ minHeight: 280, resize: "none", scrollbarWidth: "none" }}
                />
                <div className="flex gap-2 items-center">
                    <CSSSchemeBar target="chat_app" currentCSS={css} onLoad={setCss} />
                    <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCss(CHAT_APP_CSS_EXAMPLE)}>Example</button>
                    <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={handleClear}>Clear</button>
                    <button type="button" className="ui-btn ui-btn-soft-action flex-1" onClick={handleApply}>Apply</button>
                </div>
            </div>
        </PageShell>
    );
}

/* ══════════════════════════════════════════
   Follow-Up Settings Editor (sub-page)
   ══════════════════════════════════════════ */
function FollowUpSettingsEditor({ onBack }: { onBack: () => void }) {
    const defaults = getDefaultFollowUpConfig();
    const [config, setConfig] = useState<FollowUpConfig>(defaults);

    useEffect(() => {
        setConfig(loadFollowUpConfig());
    }, []);

    const updateConfig = (patch: Partial<FollowUpConfig>) => {
        const next = { ...config, ...patch };
        setConfig(next);
        saveFollowUpConfig(next);
    };

    const handleResetDefaults = () => {
        setConfig(defaults);
        saveFollowUpConfig(defaults);
    };

    return (
        <PageShell title="Follow-Up Settings" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu profile-settings-menu">
                <p className="menu-group-desc mx-2">
                    Delay calculation: anxiety={config.anxietyThreshold} → {config.anxietyMaxDelay}s, anxiety=100 → {config.anxietyMinDelay}s, linear interpolation in between. No follow-up when anxiety &lt; {config.anxietyThreshold}.
                </p>
                <div className="menu-group">
                    <div className="menu-item">
                        <ProfileSettingsIcon icon={SlidersHorizontal} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">Status Field Name</span>
                            <span className="menu-desc">Used to read the anxiety value from character status</span>
                        </div>
                        <div className="menu-right">
                            <input
                                value={config.anxietyFieldName}
                                onChange={e => updateConfig({ anxietyFieldName: e.target.value })}
                                className="w-[100px] text-right border-none outline-none ts-13 text-[var(--c-text)] bg-transparent"
                            />
                        </div>
                    </div>
                    <ProfileSettingsSliderItem
                        icon={Heart}
                        color={CONTENT_APP_ACCENTS.moments}
                        label="Anxiety Threshold"
                        desc={`Follow-up won't trigger below ${config.anxietyThreshold}`}
                        value={config.anxietyThreshold}
                        valueLabel={`${config.anxietyThreshold}%`}
                        min={0}
                        max={100}
                        step={5}
                        onChange={v => updateConfig({ anxietyThreshold: v })}
                    />
                    <ProfileSettingsSliderItem
                        icon={Clock}
                        color={CONTENT_APP_ACCENTS.calendar}
                        label="Minimum Wait"
                        desc="Used when anxiety = 100"
                        value={config.anxietyMinDelay}
                        valueLabel={`${config.anxietyMinDelay}s`}
                        min={5}
                        max={300}
                        step={5}
                        onChange={v => updateConfig({ anxietyMinDelay: v })}
                    />
                    <ProfileSettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.voice}
                        label="Maximum Wait"
                        desc="Used when anxiety = threshold"
                        value={config.anxietyMaxDelay}
                        valueLabel={`${config.anxietyMaxDelay}s`}
                        min={15}
                        max={600}
                        step={15}
                        onChange={v => updateConfig({ anxietyMaxDelay: v })}
                    />
                </div>

                {/* Reset button */}
                <div className="menu-group">
                    <button className="menu-item" onClick={handleResetDefaults}>
                        <ProfileSettingsIcon icon={RotateCcw} color={BINDING_ACCENTS.regex} />
                        <div className="menu-label-group"><span className="menu-label menu-label-danger">Reset to Default</span></div>
                    </button>
                </div>

            </div>
        </PageShell>
    );
}

/* ══════════════════════════════════════════
   API Log Viewer (sub-page)
   ══════════════════════════════════════════ */
function ApiLogViewer({ onBack }: { onBack: () => void }) {
    const [logs, setLogs] = useState<DebugInfo[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    useEffect(() => {
        setLogs([...getApiLogs()].reverse());
    }, []);

    const handleClear = () => {
        clearApiLogs();
        setLogs([]);
    };

    const formatTime = (ts: string) => {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    };

    return (
        <PageShell title="Backend Log" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu">
                {logs.length === 0 ? (
                    <div className="ui-empty">
                        <span className="menu-desc">No API call records yet</span>
                    </div>
                ) : (
                    <>
                        <div className="flex flex-col gap-3">
                            {logs.map(log => {
                                const isOpen = expandedId === log.id;
                                return (
                                    <div key={log.id} className="menu-group">
                                        <button
                                            onClick={() => setExpandedId(isOpen ? null : log.id)}
                                            className="menu-item"
                                        >
                                            <div className="menu-label-group">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    {log.characterName && (
                                                        <span className="ts-11 font-semibold text-white bg-[var(--c-icon-active)] rounded-[4px] px-[6px] py-[1px] shrink-0">
                                                            {log.characterName}
                                                        </span>
                                                    )}
                                                    <span className="menu-label font-semibold">{formatTime(log.timestamp)}</span>
                                                    <span className="menu-desc">{log.messages.length} message(s)</span>
                                                </div>
                                                <div className="menu-desc mt-1 flex gap-3 flex-wrap">
                                                    {log.model && <span>Model: {log.model}</span>}
                                                    {log.usage && (
                                                        <span>Tokens: {log.usage.prompt_tokens ?? "—"} / {log.usage.completion_tokens ?? "—"} / {log.usage.total_tokens ?? "—"}</span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="menu-right">
                                                <ChevronRight
                                                    size={16}
                                                    className="ui-chevron-flip"
                                                    {...(isOpen ? { "data-open": "" } : {})}
                                                />
                                            </div>
                                        </button>

                                        {isOpen && (
                                            <div className="api-log-panel">
                                                <div className="font-bold px-1 pt-3 pb-2 text-[var(--c-warning)]">
                                                    Prompt ({log.messages.length} message(s))
                                                </div>
                                                {log.messages.map((m, i) => (
                                                    <div key={i} className="api-log-entry" data-role={m.role}>
                                                        <div className="flex items-center gap-[6px] mb-1 flex-wrap">
                                                            <span className="font-bold text-[var(--log-role-color)]">
                                                                [{i}] {m.role}
                                                            </span>
                                                            {(m as any).marker && (
                                                                <span className="api-log-marker">
                                                                    {(m as any).marker}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="whitespace-pre-wrap break-all leading-[1.4]">
                                                            {m.content}
                                                        </div>
                                                    </div>
                                                ))}
                                                <div className="font-bold mt-3 mb-[6px] text-[var(--c-danger)]">
                                                    Raw AI Response
                                                </div>
                                                <div className="api-log-response whitespace-pre-wrap break-all leading-[1.4]">
                                                    {log.rawResponse}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Clear button */}
                        <div className="menu-group mt-4">
                            <button className="menu-item" onClick={handleClear}>
                                <div className="menu-icon"><Trash2 size={18} color="var(--c-icon)" /></div>
                                <div className="menu-label-group"><span className="menu-label menu-label-danger">Clear Records</span></div>
                            </button>
                        </div>
                    </>
                )}

            </div>
        </PageShell>
    );
}

/* ══════════════════════════════════════════
   Inline Moments Interaction Settings (testing)
   ══════════════════════════════════════════ */
function InlineMomentsSettings({ onBack }: { onBack: () => void }) {
    const [config, setConfig] = useState<MomentsInteractionConfig>(loadMomentsConfig);
    const [editingBilingualPrompt, setEditingBilingualPrompt] = useState(false);
    const [bilingualPromptDraft, setBilingualPromptDraft] = useState(config.bilingualTranslationPrompt);
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [posting, setPosting] = useState(false);
    const [showAutoPostList, setShowAutoPostList] = useState(false);

    const contacts = loadChatContacts();
    const chars = loadCharacters();
    const enriched = contacts
        .map(c => ({ ...c, char: chars.find(ch => ch.id === c.characterId) }))
        .filter(c => c.char) as (typeof contacts[number] & { char: Character })[];

    const update = (patch: Partial<MomentsInteractionConfig>) => {
        const next = { ...config, ...patch };
        setConfig(next);
        saveMomentsConfig(next);
    };

    // 自动发帖角色开关：只拦调度发帖；评论/点赞/手动立即发帖不受影响
    const disabledAutoPostIds = new Set(config.autoPostDisabledCharacterIds);
    // 徽标只统计好友范围内被关闭的——生成配角会被预置进禁用名单但未必是好友
    const disabledContactCount = enriched.filter(c => disabledAutoPostIds.has(c.characterId)).length;
    const toggleAutoPost = (characterId: string, enabled: boolean) => {
        const next = new Set(config.autoPostDisabledCharacterIds);
        if (enabled) next.delete(characterId); else next.add(characterId);
        update({ autoPostDisabledCharacterIds: [...next] });
    };

    const openBilingualPromptEditor = () => {
        setBilingualPromptDraft(config.bilingualTranslationPrompt || DEFAULT_MOMENTS_CONFIG.bilingualTranslationPrompt);
        setEditingBilingualPrompt(true);
    };

    const saveBilingualPromptDraft = () => {
        update({ bilingualTranslationPrompt: bilingualPromptDraft });
        setEditingBilingualPrompt(false);
    };

    const toggleSelect = (charId: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(charId)) next.delete(charId); else next.add(charId);
            return next;
        });
    };

    const handleBatchPost = () => {
        if (selectedIds.size === 0 || posting) return;
        setPosting(true);
        setShowCharPicker(false);
        triggerImmediatePost([...selectedIds]);
        setSelectedIds(new Set());
    };

    useEffect(() => {
        const handler = () => setPosting(false);
        window.addEventListener("moments-immediate-post-done", handler);
        return () => window.removeEventListener("moments-immediate-post-done", handler);
    }, []);

    return (
        <PageShell title="Moments Interaction Settings" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu profile-settings-menu">
                <div className="menu-group">
                    <ProfileSettingsSliderItem
                        icon={Radio}
                        color={CONTENT_APP_ACCENTS.moments}
                        label="Minimum Post Interval"
                        desc={`${config.postIntervalMinHours}-${config.postIntervalMaxHours} hour range`}
                        value={config.postIntervalMinHours}
                        valueLabel={`${config.postIntervalMinHours}h`}
                        min={1}
                        max={48}
                        step={1}
                        onChange={v => update({ postIntervalMinHours: Math.min(v, config.postIntervalMaxHours) })}
                    />
                    <ProfileSettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.voice}
                        label="Maximum Post Interval"
                        desc="Upper limit on auto-post wait time"
                        value={config.postIntervalMaxHours}
                        valueLabel={`${config.postIntervalMaxHours}h`}
                        min={1}
                        max={72}
                        step={1}
                        onChange={v => update({ postIntervalMaxHours: Math.max(v, config.postIntervalMinHours) })}
                    />
                </div>

                <div className="menu-group">
                    <ProfileSettingsSliderItem
                        icon={MessageSquare}
                        color={CONTENT_APP_ACCENTS.chat}
                        label="First Comment Delay"
                        desc="Wait time before the first comment after posting"
                        value={config.firstCommentDelaySec}
                        valueLabel={`${config.firstCommentDelaySec}s`}
                        min={5}
                        max={600}
                        step={5}
                        onChange={v => update({ firstCommentDelaySec: v })}
                    />
                    <ProfileSettingsSliderItem
                        icon={MessageSquareDashed}
                        color={CONTENT_APP_ACCENTS.group_chat}
                        label="Subsequent Comment Interval"
                        desc="Wait time between consecutive comments"
                        value={config.commentGapSec}
                        valueLabel={`${config.commentGapSec}s`}
                        min={5}
                        max={300}
                        step={5}
                        onChange={v => update({ commentGapSec: v })}
                    />
                </div>

                <div className="menu-group">
                    <ProfileSettingsSliderItem
                        icon={MessageSquare}
                        color={BINDING_ACCENTS.api}
                        label="Comment Probability"
                        desc="Chance a character comments after seeing a post"
                        value={Math.round(config.commentProb * 100)}
                        valueLabel={`${Math.round(config.commentProb * 100)}%`}
                        min={0}
                        max={100}
                        step={5}
                        onChange={v => update({ commentProb: v / 100 })}
                    />
                    <ProfileSettingsSliderItem
                        icon={ThumbsUp}
                        color={CONTENT_APP_ACCENTS.shopping}
                        label="Like Probability"
                        desc="Chance a character likes after seeing a post"
                        value={Math.round(config.likeProb * 100)}
                        valueLabel={`${Math.round(config.likeProb * 100)}%`}
                        min={0}
                        max={100}
                        step={5}
                        onChange={v => update({ likeProb: v / 100 })}
                    />
                </div>

                <div className="menu-group">
                    <ProfileSettingsSliderItem
                        icon={Clock}
                        color={CONTENT_APP_ACCENTS.calendar}
                        label="NPC Interaction Delay"
                        desc="Delay before NPCs interact with Moments posts"
                        value={config.npcReactionDelayMin}
                        valueLabel={`${config.npcReactionDelayMin}min`}
                        min={1}
                        max={60}
                        step={1}
                        onChange={v => update({ npcReactionDelayMin: v })}
                    />
                    <ProfileSettingsSliderItem
                        icon={Bell}
                        color={BINDING_ACCENTS.embedding}
                        label="Character Reply-to-NPC Delay"
                        desc="Wait time before a character replies to an NPC comment"
                        value={config.replyDelaySec}
                        valueLabel={`${config.replyDelaySec}s`}
                        min={1}
                        max={30}
                        step={1}
                        onChange={v => update({ replyDelaySec: v })}
                    />
                </div>

                <div className="menu-group">
                    <div className="menu-item">
                        <ProfileSettingsIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.moments} />
                        <div className="menu-label-group">
                            <span className="menu-label">Moments Bilingual Translation</span>
                            <span className="menu-desc">Automatically attach a Chinese translation to foreign-language posts, comments, and replies</span>
                        </div>
                        <div className="menu-right">
                            <Toggle
                                checked={config.bilingualTranslationEnabled}
                                onChange={checked => update({ bilingualTranslationEnabled: checked })}
                            />
                        </div>
                    </div>
                    {config.bilingualTranslationEnabled && (
                        <>
                            <div className="menu-item">
                                <ProfileSettingsIcon icon={MessageSquareDashed} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group">
                                    <span className="menu-label">Collapse Chinese Translation</span>
                                    <span className="menu-desc">When off, the Chinese translation is expanded by default</span>
                                </div>
                                <div className="menu-right">
                                    <Toggle
                                        checked={config.collapseBilingualTranslation}
                                        onChange={checked => update({ collapseBilingualTranslation: checked })}
                                    />
                                </div>
                            </div>
                            <button className="menu-item" onClick={openBilingualPromptEditor}>
                                <ProfileSettingsIcon icon={FileCode2} color={BINDING_ACCENTS.api} />
                                <div className="menu-label-group">
                                    <span className="menu-label">Moments Bilingual Translation Prompt</span>
                                </div>
                                <div className="menu-right">
                                    <span className="menu-desc mr-1">
                                        {config.bilingualTranslationPrompt === DEFAULT_MOMENTS_CONFIG.bilingualTranslationPrompt ? "Default" : "Customized"}
                                    </span>
                                    <ChevronRight size={16} />
                                </div>
                            </button>
                        </>
                    )}
                </div>

                <div className="menu-group">
                    <div className="menu-item" onClick={() => setShowAutoPostList(!showAutoPostList)} style={{ cursor: "pointer" }}>
                        <ProfileSettingsIcon icon={Radio} color={CONTENT_APP_ACCENTS.moments} />
                        <div className="menu-label-group">
                            <span className="menu-label">Auto-Post Characters</span>
                            <span className="menu-desc">
                                {disabledContactCount > 0
                                    ? `Auto-posting disabled for ${disabledContactCount} character(s)`
                                    : "All friend characters will auto-post at intervals"}
                            </span>
                        </div>
                        <div className="menu-right">
                            <ChevronRight size={16} style={showAutoPostList ? { transform: "rotate(90deg)" } : undefined} />
                        </div>
                    </div>
                    {showAutoPostList && enriched.map(c => (
                        <div key={c.characterId} className="menu-item" style={{ cursor: "default" }}>
                            <div className="chat-contact-avatar" style={{ width: 32, height: 32 }}>
                                {c.char.avatar ? <img src={c.char.avatar} alt="" /> : <ChatFallbackAvatar />}
                            </div>
                            <div className="menu-label-group">
                                <span className="menu-label">{c.char.name}</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={!disabledAutoPostIds.has(c.characterId)}
                                    onChange={checked => toggleAutoPost(c.characterId, checked)}
                                />
                            </div>
                        </div>
                    ))}
                    {showAutoPostList && enriched.length === 0 && (
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <div className="menu-label-group"><span className="menu-desc">No friend characters yet</span></div>
                        </div>
                    )}
                </div>

                <div className="menu-group">
                    <div className="menu-item" onClick={() => setShowCharPicker(!showCharPicker)} style={{ cursor: "pointer" }}>
                        <ProfileSettingsIcon icon={Send} color={CONTENT_APP_ACCENTS.chat} />
                        <div className="menu-label-group">
                            <span className="menu-label">Post Now</span>
                            <span className="menu-desc">{posting ? "Posting..." : "Select characters to post to Moments immediately"}</span>
                        </div>
                        {showCharPicker && selectedIds.size > 0 && (
                            <button className="ui-btn ui-btn-success ts-12" style={{ padding: "4px 12px" }}
                                onClick={e => { e.stopPropagation(); handleBatchPost(); }}
                            >Post ({selectedIds.size})</button>
                        )}
                    </div>
                    {showCharPicker && (
                        <div className="chat-contact-list">
                            {enriched.map(c => (
                                <div key={c.characterId} className="chat-contact-item" onClick={() => toggleSelect(c.characterId)}>
                                    <div className="chat-contact-avatar"
                                        style={selectedIds.has(c.characterId) ? { outline: "3px solid var(--c-success)", outlineOffset: "2px" } : undefined}
                                    >
                                        {c.char.avatar ? (
                                            <img src={c.char.avatar} alt="" />
                                        ) : (
                                            <ChatFallbackAvatar />
                                        )}
                                    </div>
                                    <span className="chat-contact-name">{c.char.name}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="menu-group">
                    <button className="menu-item" onClick={() => { setConfig(DEFAULT_MOMENTS_CONFIG); saveMomentsConfig(DEFAULT_MOMENTS_CONFIG); }}>
                        <ProfileSettingsIcon icon={RotateCcw} color={BINDING_ACCENTS.regex} />
                        <div className="menu-label-group"><span className="menu-label menu-label-danger">Reset to Default</span></div>
                    </button>
                </div>

            </div>
            {editingBilingualPrompt && (
                <div className="modal-overlay">
                    <div className="modal-dialog chat-bilingual-prompt-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">Moments Bilingual Translation Prompt</div>
                        <textarea
                            className="ui-input chat-bilingual-prompt-textarea"
                            value={bilingualPromptDraft}
                            onChange={event => setBilingualPromptDraft(event.target.value)}
                        />
                        <div className="flex gap-3 w-full">
                            <button
                                onClick={() => setBilingualPromptDraft(DEFAULT_MOMENTS_CONFIG.bilingualTranslationPrompt)}
                                className="ui-btn ui-btn-outline flex-1"
                            >
                                Reset to Default
                            </button>
                            <button onClick={() => setEditingBilingualPrompt(false)} className="ui-btn ui-btn-ghost flex-1">
                                Cancel
                            </button>
                            <button onClick={saveBilingualPromptDraft} className="ui-btn ui-btn-success flex-1">
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PageShell>
    );
}
