"use client";

// 聊天插件管理页：安装（粘贴/选文件）/ 启停 / 设置 / 卸载 / 错误日志 / 安全模式。
// 入口：聊天设置 →「扩展插件」。UI 使用 app 统一的 page-menu / menu-group / menu-item 设计语言。
// 方案 B（无沙箱直接执行）：安装非官方来源插件前给一次明确的风险确认。

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, FileText, Puzzle, ScrollText, Settings2, Download } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle, Textarea } from "@/components/ui/form";
import type { ChatPluginSettingField, InstalledChatPlugin } from "@/lib/chat-plugin-types";
import {
    CHAT_PLUGINS_CHANGED_EVENT,
    CHAT_PLUGIN_ERROR_EVENT,
    clearChatPluginErrors,
    loadChatPluginErrors,
    loadChatPlugins,
    setChatPluginEnabled,
    uninstallChatPlugin,
    updateChatPluginSettings,
} from "@/lib/chat-plugin-storage";
import { installChatPluginFromCode } from "@/lib/chat-plugin-loader";
import { getChatPluginRuntime, isChatPluginSafeMode, setChatPluginSafeMode } from "@/lib/chat-plugin-runtime";
import { ChatPluginSlot } from "@/components/chat/chat-plugin-slot";
import { CHAT_PLUGIN_FULL_DOC, CHAT_PLUGIN_EXAMPLE_MOOD } from "@/lib/chat-plugin-docs";

const INSTALL_WARNING = "Plugins have the same capabilities as the app itself (including access to your API configuration and all chat data). Only install plugins from sources you trust. Confirm installation?";

function iconWrap(color: string) {
    return { background: `color-mix(in srgb, ${color} 15%, transparent)`, color } as const;
}

export function ChatPluginManager({ onBack }: { onBack: () => void }) {
    const [plugins, setPlugins] = useState<InstalledChatPlugin[]>(() => loadChatPlugins());
    const [errors, setErrors] = useState(() => loadChatPluginErrors());
    const [safeMode, setSafeMode] = useState(() => isChatPluginSafeMode());
    const [showImport, setShowImport] = useState(false);
    const [showGuide, setShowGuide] = useState(false);
    const [showErrors, setShowErrors] = useState(false);
    const [importText, setImportText] = useState("");
    const [installing, setInstalling] = useState(false);
    const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [settingsOpenId, setSettingsOpenId] = useState<string | null>(null);
    const [docCopied, setDocCopied] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [runtimeState, setRuntimeState] = useState<{ started: boolean; activeIds: string[] }>({ started: false, activeIds: [] });

    useEffect(() => {
        const sync = () => {
            const runtime = getChatPluginRuntime();
            setRuntimeState({ started: runtime.isStarted(), activeIds: runtime.activePluginIds() });
        };
        sync();
        const timer = window.setInterval(sync, 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const refresh = () => setPlugins(loadChatPlugins());
        const refreshErrors = () => setErrors(loadChatPluginErrors());
        window.addEventListener(CHAT_PLUGINS_CHANGED_EVENT, refresh);
        window.addEventListener(CHAT_PLUGIN_ERROR_EVENT, refreshErrors);
        return () => {
            window.removeEventListener(CHAT_PLUGINS_CHANGED_EVENT, refresh);
            window.removeEventListener(CHAT_PLUGIN_ERROR_EVENT, refreshErrors);
        };
    }, []);

    const handleCopyDoc = async () => {
        try {
            await navigator.clipboard.writeText(CHAT_PLUGIN_FULL_DOC);
            setDocCopied(true);
            setTimeout(() => setDocCopied(false), 2000);
        } catch {
            setDocCopied(false);
        }
    };

    const handleInstall = async (code: string) => {
        if (!window.confirm(INSTALL_WARNING)) return;
        setInstalling(true);
        try {
            const result = await installChatPluginFromCode(code);
            if (result.ok) {
                setHint({ ok: true, text: `Installed "${result.name}"` });
                setImportText("");
            } else {
                setHint({ ok: false, text: result.error || "Installation failed" });
            }
        } finally {
            setInstalling(false);
        }
    };

    const handlePickFile = () => fileInputRef.current?.click();

    const handleFileChosen = async (file: File | undefined) => {
        if (!file) return;
        const text = await file.text();
        await handleInstall(text);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleDelete = (id: string) => {
        if (confirmDeleteId !== id) {
            setConfirmDeleteId(id);
            return;
        }
        uninstallChatPlugin(id);
        setConfirmDeleteId(null);
    };

    const pluginErrors = (pluginId: string) => errors.filter(e => e.pluginId === pluginId && e.level === "error").length;
    const statusText = safeMode
        ? "Safe mode · all plugins unloaded"
        : runtimeState.started
            ? `Runtime started · ${runtimeState.activeIds.length} plugin(s) running`
            : "Runtime starting…";
    const statusColor = safeMode ? "#f59e0b" : runtimeState.started ? "var(--c-success)" : "var(--c-icon)";

    return (
        <PageShell title="Plugins" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu" style={{ paddingBottom: 40 }}>

                {/* 安全模式 */}
                {safeMode && (
                    <div className="menu-group">
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <div className="menu-icon" style={iconWrap("#f59e0b")}>
                                <AlertTriangle size={17} strokeWidth={1.8} />
                            </div>
                            <div className="menu-label-group">
                                <span className="menu-label">Safe Mode Enabled</span>
                                <span className="menu-desc">All plugins have been skipped. Disable the problematic plugin first, then exit safe mode.</span>
                            </div>
                        </div>
                        <button
                            className="menu-item"
                            onClick={() => { setChatPluginSafeMode(false); setSafeMode(false); setHint({ ok: true, text: "Exited safe mode. Plugins will reload after refreshing the page" }); }}
                        >
                            <div className="menu-label-group"><span className="menu-label" style={{ color: "#f59e0b" }}>Exit Safe Mode (applies after refresh)</span></div>
                            <div className="menu-right"><ChevronRight size={16} /></div>
                        </button>
                    </div>
                )}

                {/* 已安装插件 */}
                <div>
                    <div className="settings-menu-section-title">Installed Plugins</div>
                    <span className="menu-desc" style={{ margin: "6px 8px 12px", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor, flex: "0 0 auto" }} />
                        {statusText}
                    </span>

                    {plugins.length === 0 ? (
                        <div className="menu-group">
                            <div className="ui-empty">
                                <Puzzle size={30} strokeWidth={1.2} />
                                <div>
                                    <div style={{ color: "var(--c-text-title)" }}>No plugins installed yet</div>
                                    <div style={{ marginTop: 4, opacity: 0.8 }}>Plugins can intercept the chat pipeline, inject prompts, and freely render UI — how you use them is up to you</div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            {plugins.map(p => {
                                const errorCount = pluginErrors(p.manifest.id);
                                const hasSettings = (p.manifest.settings?.length ?? 0) > 0;
                                const settingsOpen = settingsOpenId === p.manifest.id;
                                const running = p.enabled && !safeMode && runtimeState.activeIds.includes(p.manifest.id);
                                const notRunning = p.enabled && !safeMode && !running;
                                return (
                                    <div className="menu-group" key={p.manifest.id}>
                                        {/* 头部 */}
                                        <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                                            <div className="menu-icon" style={iconWrap("#8b5cf6")}>
                                                <Puzzle size={17} strokeWidth={1.6} />
                                            </div>
                                            <div className="menu-label-group">
                                                <span className="menu-label" style={{ fontWeight: 600 }}>
                                                    {p.manifest.name}
                                                    {p.manifest.version && <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>v{p.manifest.version}</span>}
                                                    {running && <span style={{ color: "var(--c-success)", fontWeight: 400, marginLeft: 6 }}>Running</span>}
                                                    {notRunning && <span style={{ color: "var(--c-danger)", fontWeight: 400, marginLeft: 6 }}>Not running</span>}
                                                    {errorCount > 0 && <span style={{ color: "var(--c-danger)", fontWeight: 400, marginLeft: 6 }}>{errorCount} error(s)</span>}
                                                </span>
                                                {p.manifest.description && <span className="menu-desc">{p.manifest.description}</span>}
                                                {!!p.manifest.permissions?.length && <span className="menu-desc" style={{ opacity: 0.6 }}>Declared use: {p.manifest.permissions.join(", ")}</span>}
                                            </div>
                                            <div className="menu-right" style={{ gap: 8 }}>
                                                {hasSettings && (
                                                    <button
                                                        className="ui-btn ui-btn-ghost"
                                                        style={{ padding: 6 }}
                                                        onClick={() => setSettingsOpenId(settingsOpen ? null : p.manifest.id)}
                                                        aria-label="Plugin settings"
                                                    >
                                                        <Settings2 size={17} strokeWidth={1.6} />
                                                    </button>
                                                )}
                                                <Toggle checked={p.enabled} onChange={(v: boolean) => setChatPluginEnabled(p.manifest.id, v)} />
                                            </div>
                                        </div>

                                        {/* 静态设置表单 */}
                                        {settingsOpen && hasSettings && (
                                            <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid color-mix(in srgb, var(--c-card-border) 20%, transparent)" }}>
                                                {p.manifest.settings!.map(field => (
                                                    <PluginSettingRow
                                                        key={`${field.key}:${String(p.settings?.[field.key] ?? "")}`}
                                                        field={field}
                                                        value={p.settings?.[field.key]}
                                                        onChange={(value) => updateChatPluginSettings(p.manifest.id, { [field.key]: value })}
                                                    />
                                                ))}
                                            </div>
                                        )}

                                        {/* 插件自绘设置区（settings.section 坑位）——归属到本插件卡片 */}
                                        <ChatPluginSlot
                                            name="settings.section"
                                            pluginId={p.manifest.id}
                                            className="chat-plugin-settings-section"
                                        />

                                        {/* 底部：作者 + 卸载 */}
                                        <div className="menu-item" style={{ cursor: "default" }}>
                                            <div className="menu-label-group">
                                                <span className="menu-desc">{p.manifest.author ? `Author: ${p.manifest.author}` : "JavaScript plugin"}</span>
                                            </div>
                                            <div className="menu-right">
                                                <button
                                                    className={`ui-btn ${confirmDeleteId === p.manifest.id ? "ui-btn-danger" : "ui-btn-ghost"}`}
                                                    style={{ padding: "6px 12px", color: confirmDeleteId === p.manifest.id ? undefined : "var(--c-danger)" }}
                                                    onClick={() => handleDelete(p.manifest.id)}
                                                    onBlur={() => setConfirmDeleteId(null)}
                                                >
                                                    {confirmDeleteId === p.manifest.id ? "Confirm Uninstall" : "Uninstall"}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 安装 */}
                <div>
                    <div className="settings-menu-section-title">Install Plugin</div>
                    <div className="menu-group" style={{ marginTop: 10 }}>
                        <button className="menu-item" onClick={() => { setShowImport(v => !v); setHint(null); }}>
                            <div className="menu-icon" style={iconWrap("#38bdf8")}>
                                <Download size={17} strokeWidth={1.6} />
                            </div>
                            <div className="menu-label-group"><span className="menu-label">Import Plugin</span><span className="menu-desc">Paste source code or choose a .js file</span></div>
                            <div className="menu-right">{showImport ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
                        </button>
                        {showImport && (
                            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                                <Textarea
                                    value={importText}
                                    onChange={e => setImportText(e.target.value)}
                                    placeholder="Paste plugin JS source code (an ES Module exporting default { manifest, setup })…"
                                    style={{ height: 150, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
                                />
                                {hint && <div style={{ fontSize: 12, color: hint.ok ? "var(--c-success)" : "var(--c-danger)" }}>{hint.text}</div>}
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    <button className="ui-btn ui-btn-primary" style={{ flex: 1, minWidth: 120 }} disabled={!importText.trim() || installing} onClick={() => handleInstall(importText)}>
                                        {installing ? "Installing…" : "Install"}
                                    </button>
                                    <button className="ui-btn ui-btn-outline" onClick={handlePickFile}>Choose .js File</button>
                                    <button className="ui-btn ui-btn-outline" onClick={() => setImportText(CHAT_PLUGIN_EXAMPLE_MOOD)}>Fill in Example</button>
                                </div>
                                <input ref={fileInputRef} type="file" accept=".js,.mjs,text/javascript" className="hidden" onChange={e => { void handleFileChosen(e.target.files?.[0]); }} />
                                <p className="menu-desc" style={{ lineHeight: 1.6 }}>
                                    Plugins run in the same environment as the app, with full capabilities (including your API configuration and chat data). Only install plugins from sources you trust;
                                    if something goes wrong, add <code>?plugin-safe-mode=1</code> to the URL to skip loading all plugins.
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* 运行日志 */}
                <div>
                    <div className="settings-menu-section-title">Run Log</div>
                    <div className="menu-group" style={{ marginTop: 10 }}>
                        <button className="menu-item" onClick={() => setShowErrors(v => !v)}>
                            <div className="menu-icon" style={iconWrap("#94a3b8")}>
                                <ScrollText size={17} strokeWidth={1.6} />
                            </div>
                            <div className="menu-label-group"><span className="menu-label">Run Log</span></div>
                            <div className="menu-right">
                                {errors.length > 0 && <span className="menu-desc mr-1">{errors.length} entries</span>}
                                {showErrors ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </div>
                        </button>
                        {showErrors && (
                            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                                {errors.length === 0 ? (
                                    <span className="menu-desc">No logs yet</span>
                                ) : (
                                    <>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 256, overflowY: "auto" }}>
                                            {[...errors].reverse().map((e, i) => (
                                                <div key={i} style={{ fontSize: 11, lineHeight: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: e.level === "error" ? "var(--c-danger)" : "var(--c-text)", opacity: e.level === "error" ? 1 : 0.65 }}>
                                                    <span style={{ opacity: 0.6 }}>{e.at.slice(5, 19).replace("T", " ")}</span>
                                                    {" "}[{e.pluginId}] {e.where}: {e.message}
                                                </div>
                                            ))}
                                        </div>
                                        <button className="ui-btn ui-btn-ghost" style={{ alignSelf: "flex-start", padding: "6px 12px" }} onClick={() => clearChatPluginErrors()}>Clear Log</button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* 制作说明 */}
                <div>
                    <div className="settings-menu-section-title">Developer Guide</div>
                    <div className="menu-group" style={{ marginTop: 10 }}>
                        <button className="menu-item" onClick={() => setShowGuide(v => !v)}>
                            <div className="menu-icon" style={iconWrap("#f472b6")}>
                                <FileText size={17} strokeWidth={1.6} />
                            </div>
                            <div className="menu-label-group"><span className="menu-label">Developer Docs</span><span className="menu-desc">Copy this to an AI to write a plugin for you</span></div>
                            <div className="menu-right">{showGuide ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
                        </button>
                        {showGuide && (
                            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                                <p className="menu-desc" style={{ lineHeight: 1.6 }}>
                                    Don't know how to code? Send this full document to any AI, describe the plugin you want, and have it generate the plugin code to install here.
                                    Reinstalling with the same id is treated as an upgrade (settings are kept); plugin errors are automatically logged, and a plugin that fails 5 times in a row is automatically disabled.
                                </p>
                                <textarea
                                    className="ui-textarea"
                                    value={CHAT_PLUGIN_FULL_DOC}
                                    rows={18}
                                    readOnly
                                    spellCheck={false}
                                    aria-label="Full plugin developer documentation"
                                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, lineHeight: 1.55 }}
                                />
                                <button className="ui-btn ui-btn-primary" onClick={handleCopyDoc}>{docCopied ? "Copied ✓" : "Copy All"}</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </PageShell>
    );
}

function PluginSettingRow({ field, value, onChange }: {
    field: ChatPluginSettingField;
    value: unknown;
    onChange: (value: string | number | boolean) => void;
}) {
    const current = value !== undefined ? value : field.default;
    if (field.type === "boolean") {
        return (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="menu-label-group">
                    <span className="menu-label">{field.label}</span>
                    {field.description && <span className="menu-desc">{field.description}</span>}
                </div>
                <Toggle checked={current === true} onChange={(v: boolean) => onChange(v)} />
            </div>
        );
    }
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="menu-label">{field.label}</span>
            {field.description && <span className="menu-desc">{field.description}</span>}
            {field.type === "text" && (
                <input className="ui-input" type="text" defaultValue={typeof current === "string" ? current : ""} onBlur={e => onChange(e.target.value)} />
            )}
            {field.type === "number" && (
                <input className="ui-input" type="number" style={{ width: 140 }} defaultValue={typeof current === "number" ? current : 0} onBlur={e => onChange(Number(e.target.value) || 0)} />
            )}
            {field.type === "select" && (
                <select className="ui-select" value={typeof current === "string" ? current : ""} onChange={e => onChange(e.target.value)}>
                    {(field.options ?? []).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
            )}
        </div>
    );
}
