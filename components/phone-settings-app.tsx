"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, createContext, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronRight, Clock, Database, FileText, Fingerprint, Globe, HardDrive, Image, Info, KeyRound, Layers, Link2, Loader2, LogOut, MessageSquare, Mic, SlidersHorizontal, UserCircle, Wrench, X } from "lucide-react";
import { ConfirmDialog } from "./ui/modal";
import { useAccount } from "@/lib/account-context";
import { changeAccountPassword } from "@/lib/account-client";
import { ApiSettings } from "./settings/api-settings";
import { VoiceSettings } from "./settings/voice-settings";
import { ImageGenerationSettings } from "./settings/image-generation-settings";
import { PresetManager } from "./settings/preset-manager";
import { WorldBookManager } from "./settings/worldbook-manager";
import { RegexManager } from "./settings/regex-manager";
import { DataManagement } from "./settings/data-management";
import { UserIdentitySettings } from "./settings/user-identity";
import { AboutDeclaration } from "./settings/about-declaration";
import { BindingManager } from "./settings/binding-manager";
import { WeixinSettings } from "./settings/weixin-settings";
import { ToolboxSettings } from "./settings/toolbox-settings";
import { ModerationCenter } from "./settings/moderation-center";
import { fetchIsAdmin } from "@/lib/moderation-client";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { PageShell } from "./ui/page-shell";
import { CardGrid, FeaturedCard, type CardItem, type FeaturedCardItem } from "./ui/card-grid";
import { Toggle } from "./ui/form";
import { loadChatAppSettings, saveChatAppSettings } from "@/lib/chat-storage";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";

export const SettingsContext = createContext<{
    setSubpageTitle: (title: string | null) => void;
    setOverrideBack: (action: (() => void) | null) => void;
    setSubpageRightAction: (page: string, action: ReactNode | null) => void;
}>({ setSubpageTitle: () => { }, setOverrideBack: () => { }, setSubpageRightAction: () => { } });

type SettingsPageProps = {
    onClose: () => void;
    onNotice: (msg: string) => void;
};

type SubPage =
    | "main"
    | "api"
    | "voice"
    | "imageGeneration"
    | "presets"
    | "worldbook"
    | "regex"
    | "data"
    | "binding"
    | "identity"
    | "weixin"
    | "toolbox"
    | "moderation"
    | "about";

const SETTINGS_MENU = [
    { id: "api", icon: HardDrive, label: "API Settings", desc: "LLM interface", iconColor: BINDING_ACCENTS.api },
    { id: "voice", icon: Mic, label: "Voice API", desc: "Voice synthesis", iconColor: BINDING_ACCENTS.voice },
    { id: "imageGeneration", icon: Image, label: "Image Generation API", desc: "Model, reference images & prompts", iconColor: CONTENT_APP_ACCENTS.moments },
    { id: "presets", icon: Fingerprint, label: "Presets", desc: "Character presets", iconColor: BINDING_ACCENTS.preset },
    { id: "worldbook", icon: Globe, label: "Worldbook", desc: "Worldview settings", iconColor: BINDING_ACCENTS.worldBook },
    { id: "regex", icon: Database, label: "Regex Rules", desc: "Text replacement", iconColor: BINDING_ACCENTS.regex },
    { id: "data", icon: Layers, label: "Data Management", desc: "Import & export", iconColor: BINDING_ACCENTS.api },
    { id: "binding", icon: Link2, label: "Config Bindings", desc: "Manage config binding relationships across global defaults, characters, and apps", iconColor: BINDING_ACCENTS.identity },
    { id: "weixin", icon: MessageSquare, label: "WeChat Integration", desc: "iLink Bot", iconColor: CONTENT_APP_ACCENTS.chat },
    { id: "toolbox", icon: Wrench, label: "Chat Toolbox", desc: "External tool calls", iconColor: BINDING_ACCENTS.voice },
    { id: "identity", icon: UserCircle, label: "User Identity", desc: "Personal info", iconColor: BINDING_ACCENTS.identity },
    { id: "about", icon: Info, label: "About & Disclaimer", desc: "Version & terms", iconColor: BINDING_ACCENTS.memory },
] as const;

const realtimeIconStyle = {
    "--icon-color": CONTENT_APP_ACCENTS.calendar,
} as CSSProperties;

const promptViewerIconStyle = {
    "--icon-color": BINDING_ACCENTS.preset,
} as CSSProperties;

const quickActionIconStyle = {
    "--icon-color": BINDING_ACCENTS.worldBook,
} as CSSProperties;

const accountIconStyle = {
    "--icon-color": BINDING_ACCENTS.identity,
} as CSSProperties;

const passwordIconStyle = {
    "--icon-color": BINDING_ACCENTS.api,
} as CSSProperties;

const logoutIconStyle = {
    "--icon-color": "var(--c-danger)",
} as CSSProperties;

export function PhoneSettingsApp({ onClose, onNotice }: SettingsPageProps) {
    const [currentPage, setCurrentPage] = useState<SubPage>("main");
    const [subpageTitle, setSubpageTitle] = useState<string | null>(null);
    const [subpageRightActions, setSubpageRightActions] = useState<Record<string, ReactNode>>({});
    const [overrideBack, setOverrideBack] = useState<(() => void) | null>(null);
    const [timeAware, setTimeAware] = useState(true);
    const [promptViewerEnabled, setPromptViewerEnabled] = useState(false);
    const [quickActionEnabled, setQuickActionEnabled] = useState(false);
    const pageBodyRef = useRef<HTMLDivElement | null>(null);

    // ── 账号：显示当前登录 / 修改密码 / 退出登录 ──
    const selfHostedMode = isSelfHostedModeEnabled();
    const { account, logout } = useAccount();
    const [pwdModalOpen, setPwdModalOpen] = useState(false);
    const [oldPwd, setOldPwd] = useState("");
    const [newPwd, setNewPwd] = useState("");
    const [confirmPwd, setConfirmPwd] = useState("");
    const [pwdBusy, setPwdBusy] = useState(false);
    const [pwdError, setPwdError] = useState("");
    const [confirmLogout, setConfirmLogout] = useState(false);
    const [accountSheetOpen, setAccountSheetOpen] = useState(false);

    // ── 管理中心入口：仅 role=admin 的账号可见 ──
    const [isAdmin, setIsAdmin] = useState(false);
    useEffect(() => {
        if (selfHostedMode || !account) return;
        let cancelled = false;
        void fetchIsAdmin().then(result => { if (!cancelled) setIsAdmin(result); });
        return () => { cancelled = true; };
    }, [selfHostedMode, account]);

    const closePwdModal = () => {
        if (pwdBusy) return;
        setPwdModalOpen(false);
        setOldPwd("");
        setNewPwd("");
        setConfirmPwd("");
        setPwdError("");
    };

    const handleChangePassword = async () => {
        if (pwdBusy) return;
        if (!oldPwd || !newPwd) { setPwdError("Please enter your current and new password."); return; }
        if (newPwd.length < 6) { setPwdError("New password must be at least 6 characters."); return; }
        if (newPwd !== confirmPwd) { setPwdError("The new passwords you entered don't match."); return; }
        setPwdBusy(true);
        setPwdError("");
        try {
            const result = await changeAccountPassword({ oldPassword: oldPwd, newPassword: newPwd });
            if (!result.ok) { setPwdError(result.error || "Failed to change password."); return; }
            setPwdModalOpen(false);
            setOldPwd("");
            setNewPwd("");
            setConfirmPwd("");
            onNotice("Password changed");
        } finally {
            setPwdBusy(false);
        }
    };

    const handleCopyUsername = () => {
        if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(account.username).then(() => onNotice("Username copied"));
        } else {
            onNotice(`Username: ${account.username}`);
        }
    };

    const defaultTitle = currentPage === "main"
        ? "Settings"
        : currentPage === "api" || currentPage === "voice" || currentPage === "imageGeneration" || currentPage === "presets" || currentPage === "worldbook" || currentPage === "regex" || currentPage === "identity"
            ? ""
            : currentPage === "moderation"
                ? "Moderation Center"
                : SETTINGS_MENU.find(m => m.id === currentPage)?.label || "Settings";
    const title = subpageTitle || defaultTitle;

    const setSubpageRightAction = useCallback((page: string, action: ReactNode | null) => {
        setSubpageRightActions(prev => {
            if (action === null) {
                const next = { ...prev };
                delete next[page];
                return next;
            }
            return { ...prev, [page]: action };
        });
    }, []);

    const handleBack = () => {
        if (overrideBack) {
            overrideBack();
        } else if (currentPage !== "main") {
            setCurrentPage("main");
            setSubpageTitle(null);
            setOverrideBack(null);
        } else {
            onClose();
        }
    };

    const makeCardItem = (item: typeof SETTINGS_MENU[number]): CardItem => ({
        id: item.id,
        icon: item.icon,
        label: item.label,
        desc: item.desc,
        iconColor: item.iconColor,
        onClick: () => setCurrentPage(item.id as SubPage),
    });

    const handleTimeAwareChange = useCallback((next: boolean) => {
        setTimeAware(next);
        saveChatAppSettings({ ...loadChatAppSettings(), timeAware: next });
        onNotice(next ? "Global real-time awareness enabled" : "Global real-time awareness disabled");
    }, [onNotice]);

    const handlePromptViewerChange = useCallback((next: boolean) => {
        setPromptViewerEnabled(next);
        saveChatAppSettings({ ...loadChatAppSettings(), promptViewerEnabled: next });
        onNotice(next ? "Prompt viewer enabled" : "Prompt viewer disabled");
    }, [onNotice]);

    const handleQuickActionChange = useCallback((next: boolean) => {
        setQuickActionEnabled(next);
        saveChatAppSettings({ ...loadChatAppSettings(), quickActionEnabled: next });
        onNotice(next ? "Quick actions enabled" : "Quick actions disabled");
    }, [onNotice]);

    const imageGenerationItem = SETTINGS_MENU.find(i => i.id === "imageGeneration")!;
    const imageGenerationFeaturedItem: FeaturedCardItem = {
        id: imageGenerationItem.id,
        icon: imageGenerationItem.icon,
        label: imageGenerationItem.label,
        desc: imageGenerationItem.desc,
        iconColor: imageGenerationItem.iconColor,
        onClick: () => setCurrentPage("imageGeneration"),
    };

    const bindingItem = SETTINGS_MENU.find(i => i.id === "binding")!;
    const bindingFeaturedItem: FeaturedCardItem = {
        id: bindingItem.id,
        icon: bindingItem.icon,
        label: bindingItem.label,
        desc: bindingItem.desc,
        iconColor: bindingItem.iconColor,
        onClick: () => setCurrentPage("binding"),
    };

    const renderSubPage = () => {
        switch (currentPage) {
            case "api":
                return <ApiSettings />;
            case "voice":
                return <VoiceSettings />;
            case "imageGeneration":
                return <ImageGenerationSettings />;
            case "presets":
                return <PresetManager isActive />;
            case "worldbook":
                return <WorldBookManager isActive />;
            case "regex":
                return <RegexManager isActive />;
            case "data":
                return <DataManagement onNotice={onNotice} />;
            case "binding":
                return <BindingManager />;
            case "weixin":
                return <WeixinSettings />;
            case "toolbox":
                return <ToolboxSettings />;
            case "moderation":
                return <ModerationCenter onNotice={onNotice} />;
            case "identity":
                return <UserIdentitySettings />;
            case "about":
                return <AboutDeclaration />;
            default:
                return null;
        }
    };

    useLayoutEffect(() => {
        pageBodyRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }, [currentPage]);

    // Check for pending mascot navigation mode on mount (stored by desktop-shell)
    useEffect(() => {
        const pending = sessionStorage.getItem("mascot-settings-mode");
        if (pending) {
            sessionStorage.removeItem("mascot-settings-mode");
            if (SETTINGS_MENU.some(m => m.id === pending)) {
                setCurrentPage(pending as SubPage);
            }
        }
    }, []);

    useEffect(() => {
        const settings = loadChatAppSettings();
        setTimeAware(settings.timeAware !== false);
        setPromptViewerEnabled(settings.promptViewerEnabled === true);
        setQuickActionEnabled(settings.quickActionEnabled === true);
    }, []);

    // Listen for mascot navigation mode (e.g. jump to worldbook/regex tab)
    useEffect(() => {
        const onMode = (e: Event) => {
            const { mode } = (e as CustomEvent).detail ?? {};
            if (mode && SETTINGS_MENU.some(m => m.id === mode)) {
                setCurrentPage(mode as SubPage);
            }
        };
        window.addEventListener("mascot-navigate-mode", onMode);
        return () => window.removeEventListener("mascot-navigate-mode", onMode);
    }, []);

    // Listen for internal settings tab navigation (e.g. mascot "修改绑定" button)
    useEffect(() => {
        const onNav = (e: Event) => {
            const { page } = (e as CustomEvent).detail ?? {};
            if (page) setCurrentPage(page as SubPage);
        };
        window.addEventListener("settings-navigate", onNav);
        return () => window.removeEventListener("settings-navigate", onNav);
    }, []);

    return (
        <SettingsContext.Provider value={{ setSubpageTitle, setOverrideBack, setSubpageRightAction }}>
            <PageShell title={title} onBack={handleBack} rightAction={currentPage !== "main" ? subpageRightActions[currentPage] : undefined} bodyRef={pageBodyRef}>
                {currentPage === "main" && (
                    <div className="page-menu settings-main-menu">
                        {!selfHostedMode && (
                            <button type="button" className="settings-account-card" onClick={() => setAccountSheetOpen(true)}>
                                <span className="settings-account-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
                                <span className="settings-account-copy">
                                    <span className="settings-account-name">{account.displayName || account.username}</span>
                                    <span className="settings-account-sub">Account, password & login</span>
                                </span>
                                <ChevronRight size={18} className="settings-account-chevron" />
                            </button>
                        )}
                        <CardGrid
                            label="API Config"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["api", "voice"].includes(item.id)).map(makeCardItem)}
                        />
                        <div className="settings-data-rules-section">
                            <h3 className="settings-menu-section-title">Data & Rules</h3>
                            <div className="mt-[10px] flex flex-col gap-3">
                                <CardGrid
                                    items={SETTINGS_MENU.filter(item => ["presets", "worldbook", "regex", "data"].includes(item.id)).map(makeCardItem)}
                                />
                                <FeaturedCard item={bindingFeaturedItem} />
                            </div>
                        </div>
                        <div className="settings-image-generation-section">
                            <h3 className="settings-menu-section-title">Image Generation</h3>
                            <div className="mt-[10px]">
                                <FeaturedCard item={imageGenerationFeaturedItem} />
                            </div>
                        </div>
                        <CardGrid
                            label="Connections"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["weixin", "toolbox"].includes(item.id)).map(makeCardItem)}
                        />
                        <div className="settings-realtime-section">
                            <h3 className="settings-menu-section-title">Realtime</h3>
                            <div className="app-card card-featured settings-toggle-card">
                                <span className="card-icon" style={realtimeIconStyle}>
                                    <Clock size={22} strokeWidth={1.75} />
                                </span>
                                <div className="card-featured-body">
                                    <div className="card-featured-label">Real-Time Awareness</div>
                                    <div className="card-featured-desc">Controls whether timestamps are injected into the global history event stream</div>
                                </div>
                                <Toggle checked={timeAware} onChange={handleTimeAwareChange} className="settings-toggle-control" />
                            </div>
                        </div>
                        {isAdmin ? (
                            <div className="settings-moderation-section">
                                <h3 className="settings-menu-section-title">Moderation</h3>
                                <div className="app-card card-featured settings-toggle-card" role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setCurrentPage("moderation")}>
                                    <span className="card-icon" style={accountIconStyle}>
                                        <SlidersHorizontal size={22} strokeWidth={1.75} />
                                    </span>
                                    <div className="card-featured-body">
                                        <div className="card-featured-label">Moderation Center</div>
                                        <div className="card-featured-desc">Report queue, app review & user bans</div>
                                    </div>
                                    <ChevronRight size={18} className="settings-account-chevron" />
                                </div>
                            </div>
                        ) : null}
                        <div className="settings-tools-section">
                            <h3 className="settings-menu-section-title">Tools</h3>
                            <div className="menu-group settings-tools-menu">
                                <div className="menu-item settings-tools-menu-item">
                                    <span className="card-icon" style={promptViewerIconStyle}>
                                        <FileText size={22} strokeWidth={1.75} />
                                    </span>
                                    <span className="settings-tools-menu-copy">
                                        <span className="menu-label appearance-menu-item-label">Prompt Viewer</span>
                                        <span className="menu-desc settings-tools-menu-desc">Shows a floating button to view the current prompt when enabled</span>
                                    </span>
                                    <span className="menu-right settings-tools-menu-toggle">
                                        <Toggle checked={promptViewerEnabled} onChange={handlePromptViewerChange} className="settings-toggle-control" />
                                    </span>
                                </div>
                                <div className="menu-item settings-tools-menu-item">
                                    <span className="card-icon" style={quickActionIconStyle}>
                                        <SlidersHorizontal size={22} strokeWidth={1.75} />
                                    </span>
                                    <span className="settings-tools-menu-copy">
                                        <span className="menu-label appearance-menu-item-label">Quick Actions</span>
                                        <span className="menu-desc settings-tools-menu-desc">Quickly switch API and worldbook</span>
                                    </span>
                                    <span className="menu-right settings-tools-menu-toggle">
                                        <Toggle checked={quickActionEnabled} onChange={handleQuickActionChange} className="settings-toggle-control" />
                                    </span>
                                </div>
                            </div>
                        </div>
                        <CardGrid
                            label="User"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["identity", "about"].includes(item.id)).map(makeCardItem)}
                        />
                        {accountSheetOpen && (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setAccountSheetOpen(false)}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={() => setAccountSheetOpen(false)}><X size={18} /></button>
                                        <h3 className="modal-title">Account</h3>
                                        <span style={{ width: 44 }} />
                                    </div>
                                    <div className="modal-body modal-body-tight" data-ui="modal-body">
                                        <div className="menu-group">
                                            <div className="menu-item settings-tools-menu-item">
                                                <span className="card-icon" style={accountIconStyle}>
                                                    <UserCircle size={22} strokeWidth={1.75} />
                                                </span>
                                                <span className="settings-tools-menu-copy">
                                                    <span className="menu-label appearance-menu-item-label">Current Account</span>
                                                    <span className="menu-desc settings-tools-menu-desc">@{account.username}</span>
                                                </span>
                                                <span className="menu-right">
                                                    <button className="ui-btn ui-btn-outline py-1 px-3 ts-12" style={{ whiteSpace: "nowrap" }} onClick={handleCopyUsername}>Copy</button>
                                                </span>
                                            </div>
                                            <button type="button" className="menu-item settings-tools-menu-item w-full text-left" onClick={() => { setAccountSheetOpen(false); setPwdModalOpen(true); }}>
                                                <span className="card-icon" style={passwordIconStyle}>
                                                    <KeyRound size={22} strokeWidth={1.75} />
                                                </span>
                                                <span className="settings-tools-menu-copy">
                                                    <span className="menu-label appearance-menu-item-label">Change Password</span>
                                                    <span className="menu-desc settings-tools-menu-desc">Requires verifying your current password</span>
                                                </span>
                                                <span className="menu-right"><ChevronRight size={17} className="settings-account-chevron" /></span>
                                            </button>
                                            <button type="button" className="menu-item settings-tools-menu-item w-full text-left" onClick={() => { setAccountSheetOpen(false); setConfirmLogout(true); }}>
                                                <span className="card-icon" style={logoutIconStyle}>
                                                    <LogOut size={22} strokeWidth={1.75} />
                                                </span>
                                                <span className="settings-tools-menu-copy">
                                                    <span className="menu-label appearance-menu-item-label" style={{ color: "var(--c-danger)" }}>Log Out</span>
                                                    <span className="menu-desc settings-tools-menu-desc">You'll need to re-enter your username and password after logging out</span>
                                                </span>
                                                <span className="menu-right"><ChevronRight size={17} className="settings-account-chevron" /></span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {pwdModalOpen && (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={closePwdModal}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={closePwdModal} disabled={pwdBusy}><X size={18} /></button>
                                        <h3 className="modal-title">Change Password</h3>
                                        <button className="modal-header-btn modal-header-btn-action" onClick={() => void handleChangePassword()} disabled={pwdBusy}>
                                            {pwdBusy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                                        </button>
                                    </div>
                                    <div className="modal-body" data-ui="modal-body">
                                        <div className="flex flex-col gap-3 px-1">
                                            <input type="password" className="ui-input" placeholder="Current password" autoComplete="current-password"
                                                value={oldPwd} onChange={event => setOldPwd(event.target.value)} />
                                            <input type="password" className="ui-input" placeholder="New password (at least 6 characters)" autoComplete="new-password"
                                                value={newPwd} onChange={event => setNewPwd(event.target.value)} />
                                            <input type="password" className="ui-input" placeholder="Confirm new password" autoComplete="new-password"
                                                value={confirmPwd} onChange={event => setConfirmPwd(event.target.value)} />
                                            {pwdError ? <p className="ts-12" style={{ color: "var(--c-danger)" }}>{pwdError}</p> : null}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {confirmLogout && (
                            <ConfirmDialog
                                title="Log Out"
                                message={`Current account: @${account.username}. You'll need to re-enter your username and password to log back in. Passwords cannot be recovered, so make sure you remember it.`}
                                icon={LogOut}
                                variant="danger"
                                confirmLabel="Log Out"
                                onConfirm={() => { setConfirmLogout(false); void logout(); }}
                                onCancel={() => setConfirmLogout(false)}
                            />
                        )}
                    </div>
                )}

                {currentPage !== "main" && (
                    <div className="block min-h-full p-4 pb-8 box-border">
                        {renderSubPage()}
                    </div>
                )}
            </PageShell>
        </SettingsContext.Provider>
    );
}
