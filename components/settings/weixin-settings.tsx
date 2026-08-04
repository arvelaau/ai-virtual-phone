"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, Wifi, WifiOff, AlertCircle, MessageSquare, Loader2, RefreshCw, CloudUpload, Copy, Download, ChevronDown } from "lucide-react";
import QRCode from "qrcode";
import {
    loadWeixinBots,
    addExclusiveWeixinBot,
    updateWeixinBot,
    removeWeixinBot,
    loadKeepAlive,
    saveKeepAlive,
    type WeixinBotConfig,
} from "@/lib/weixin-storage";
import {
    isWeixinCloudSupabaseReady,
    buildWeixinLocalAssistantConfigCode,
    loadWeixinCloudSyncConfig,
    pullWeixinCloudMessagesFromCloud,
    saveWeixinCloudSyncConfig,
    syncAllWeixinBotRuntimesToCloud,
    syncWeixinBotRuntimeToCloud,
    type WeixinCloudSyncConfig,
} from "@/lib/weixin-cloud-sync";
import { getWeixinBotStatus } from "@/lib/use-weixin-bridge";
import { getLoginQrCode, pollQrCodeStatus, type QrLoginStatus } from "@/lib/weixin-bridge";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { Toggle, Select } from "@/components/ui/form";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import { Alert } from "@/components/ui/feedback";

type AddStep = "select-character" | "scanning" | "done";

const LOCAL_ASSISTANT_CARD_ASSETS = [
    "generic-red-packet-card-v1.png",
    "generic-transfer-card-v1.png",
    "generic-music-card-v1.png",
    "generic-photo-card-v1.png",
];

function formatCloudSyncBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCloudSyncTime(value?: string): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function buildLocalAssistantStartBat(): string {
    return [
        "@echo off",
        "setlocal",
        "cd /d \"%~dp0\"",
        "if exist \"runtime\\node.exe\" (",
        "  \"runtime\\node.exe\" assistant.mjs",
        "  pause",
        "  exit /b %errorlevel%",
        ")",
        "where node.exe >NUL 2>&1",
        "if errorlevel 1 (",
        "  echo Node.js was not found.",
        "  echo Please install Node.js 20+ or use the package with built-in runtime.",
        "  start \"\" \"https://nodejs.org/\"",
        "  pause",
        "  exit /b 1",
        ")",
        "node.exe assistant.mjs",
        "pause",
        "exit /b %errorlevel%",
        "",
    ].join("\r\n");
}

function buildLocalAssistantOnceBat(): string {
    return [
        "@echo off",
        "setlocal",
        "cd /d \"%~dp0\"",
        "if exist \"runtime\\node.exe\" (",
        "  \"runtime\\node.exe\" assistant.mjs --once",
        "  pause",
        "  exit /b %errorlevel%",
        ")",
        "where node.exe >NUL 2>&1",
        "if errorlevel 1 (",
        "  echo Node.js was not found.",
        "  echo Please install Node.js 20+ or use the package with built-in runtime.",
        "  start \"\" \"https://nodejs.org/\"",
        "  pause",
        "  exit /b 1",
        ")",
        "node.exe assistant.mjs --once",
        "pause",
        "exit /b %errorlevel%",
        "",
    ].join("\r\n");
}

function buildLocalAssistantReadme(): string {
    return `AI Phone WeChat Local Assistant

How to use:
1. Unzip this folder.
2. Double-click "Start Assistant.bat".
3. Keep this window open — while your computer is online, it will automatically poll WeChat and reply.

Test:
- Double-click "Test Once.bat" to poll only once, useful for checking that your config works.

Notes:
- config.txt is written automatically by the mini phone; you don't need to copy the config code manually.
- config.txt contains your private Supabase key — do not share this folder publicly.
- After changing characters, API, presets, world info, or memory, go back to the mini phone and re-download the local assistant package.
- If Node.js is not detected, please install Node.js 20+, or use the bundled-runtime version provided later.
`;
}

export function WeixinSettings() {
    const [bots, setBots] = useState<WeixinBotConfig[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [statusTick, setStatusTick] = useState(0);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [keepAlive, setKeepAlive] = useState(false);
    const [cloudSyncConfig, setCloudSyncConfig] = useState<WeixinCloudSyncConfig>(loadWeixinCloudSyncConfig);
    const [cloudSyncingId, setCloudSyncingId] = useState<string | null>(null);
    const [cloudSyncNotice, setCloudSyncNotice] = useState<{ ok: boolean; text: string } | null>(null);
    const [showLocalAssistantAdvanced, setShowLocalAssistantAdvanced] = useState(false);

    // Add flow
    const [addStep, setAddStep] = useState<AddStep | null>(null);
    const [newCharacterId, setNewCharacterId] = useState("");
    const [addError, setAddError] = useState("");

    // QR code state
    const [qrImgUrl, setQrImgUrl] = useState("");
    const [qrStatus, setQrStatus] = useState<QrLoginStatus | "loading">("loading");
    const qrAbort = useRef<AbortController | null>(null);

    useEffect(() => {
        setBots(loadWeixinBots());
        setCharacters(loadCharacters());
        setKeepAlive(loadKeepAlive());
        setCloudSyncConfig(loadWeixinCloudSyncConfig());
    }, []);

    useEffect(() => {
        const refresh = () => {
            setBots(loadWeixinBots());
            setStatusTick(t => t + 1);
        };
        window.addEventListener("weixin-status-changed", refresh);
        window.addEventListener("weixin-config-changed", refresh);
        return () => {
            window.removeEventListener("weixin-status-changed", refresh);
            window.removeEventListener("weixin-config-changed", refresh);
        };
    }, []);

    // Clean up QR polling
    useEffect(() => {
        return () => { qrAbort.current?.abort(); };
    }, []);

    const notifyChange = () => {
        window.dispatchEvent(new CustomEvent("weixin-config-changed"));
    };

    const updateCloudSyncConfig = (patch: Partial<WeixinCloudSyncConfig>) => {
        const next = { ...cloudSyncConfig, ...patch };
        setCloudSyncConfig(next);
        saveWeixinCloudSyncConfig(next);
    };

    const handleSyncRuntime = async (botId: string) => {
        if (cloudSyncingId) return;
        setCloudSyncNotice(null);
        setCloudSyncingId(botId);
        try {
            const result = await syncWeixinBotRuntimeToCloud(botId);
            setCloudSyncConfig(loadWeixinCloudSyncConfig());
            setCloudSyncNotice({
                ok: true,
                text: `Synced "${result.snapshot.character.name}" runtime package: ${result.snapshot.stats.messageCount} messages, ${formatCloudSyncBytes(result.bytes)}.`,
            });
        } catch (err) {
            setCloudSyncNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudSyncingId(null);
        }
    };

    const handleSyncAllRuntimes = async () => {
        if (cloudSyncingId) return;
        setCloudSyncNotice(null);
        setCloudSyncingId("all");
        try {
            const results = await syncAllWeixinBotRuntimesToCloud();
            setCloudSyncConfig(loadWeixinCloudSyncConfig());
            if (results.length === 0) {
                setCloudSyncNotice({ ok: false, text: "No enabled WeChat bots to sync." });
            } else {
                const totalBytes = results.reduce((sum, item) => sum + item.bytes, 0);
                setCloudSyncNotice({
                    ok: true,
                    text: `Synced current WeChat runtime packages, total ${formatCloudSyncBytes(totalBytes)}.`,
                });
            }
        } catch (err) {
            setCloudSyncNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudSyncingId(null);
        }
    };

    const handlePullCloudMessages = async () => {
        if (cloudSyncingId) return;
        setCloudSyncNotice(null);
        setCloudSyncingId("pull");
        try {
            const result = await pullWeixinCloudMessagesFromCloud();
            setCloudSyncNotice({
                ok: result.errors.length === 0,
                text: `Pulled synced messages: ${result.added} added, ${result.skipped} skipped${result.errors.length ? `, ${result.errors.length} errors` : ""}.`,
            });
            for (const sessionId of result.sessionIds) {
                window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId } }));
            }
        } catch (err) {
            setCloudSyncNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudSyncingId(null);
        }
    };

    const handleCopyLocalAssistantConfig = async () => {
        setCloudSyncNotice(null);
        try {
            const code = buildWeixinLocalAssistantConfigCode({ pollIntervalSeconds: 5 });
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(code);
            } else {
                const input = document.createElement("textarea");
                input.value = code;
                input.style.position = "fixed";
                input.style.opacity = "0";
                document.body.appendChild(input);
                input.focus();
                input.select();
                document.execCommand("copy");
                document.body.removeChild(input);
            }
            setCloudSyncNotice({
                ok: true,
                text: "Local assistant config code copied. The config code contains your private Supabase key — only paste it into your own local assistant.",
            });
        } catch (err) {
            setCloudSyncNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        }
    };

    const handleDownloadLocalAssistantPackage = async () => {
        if (cloudSyncingId) return;
        setCloudSyncNotice(null);
        setCloudSyncingId("package");
        try {
            const results = await syncAllWeixinBotRuntimesToCloud();
            if (results.length === 0) {
                setCloudSyncNotice({ ok: false, text: "No enabled WeChat bots to sync." });
                return;
            }

            const code = buildWeixinLocalAssistantConfigCode({ pollIntervalSeconds: 5 });
            const scriptRes = await fetch("/weixin-local-assistant/assistant.mjs", { cache: "no-store" });
            if (!scriptRes.ok) throw new Error("Failed to download assistant script. Please redeploy and try again.");
            const assistantScript = await scriptRes.text();
            const JSZip = (await import("jszip")).default;
            const { downloadFile } = await import("@/lib/download-utils");
            const zip = new JSZip();
            zip.file("assistant.mjs", assistantScript);
            zip.file("config.txt", code);
            zip.file("Start Assistant.bat", buildLocalAssistantStartBat());
            zip.file("Test Once.bat", buildLocalAssistantOnceBat());
            zip.file("README.txt", buildLocalAssistantReadme());
            for (const fileName of LOCAL_ASSISTANT_CARD_ASSETS) {
                const assetPath = `/weixin-local-assistant/generated-cards/${fileName}`;
                const assetRes = await fetch(assetPath, { cache: "no-store" });
                if (!assetRes.ok) throw new Error(`Failed to download assistant card asset: ${fileName}`);
                zip.file(`generated-cards/${fileName}`, await assetRes.arrayBuffer(), {
                    binary: true,
                    compression: "STORE",
                });
            }
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
            await downloadFile(blob, `ai-phone-weixin-local-assistant-${new Date().toISOString().slice(0, 10)}.zip`);
            const totalBytes = results.reduce((sum, item) => sum + item.bytes, 0);
            setCloudSyncConfig(loadWeixinCloudSyncConfig());
            setCloudSyncNotice({
                ok: true,
                text: `Local assistant package generated, and runtime package synced (${formatCloudSyncBytes(totalBytes)}). Unzip and double-click "Start Assistant.bat" to run.`,
            });
        } catch (err) {
            setCloudSyncNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudSyncingId(null);
        }
    };

    const handleToggle = (id: string, enabled: boolean) => {
        updateWeixinBot(id, { enabled });
        setBots(loadWeixinBots());
        notifyChange();
    };

    const handleDelete = (id: string) => {
        removeWeixinBot(id);
        setBots(loadWeixinBots());
        notifyChange();
    };

    const cancelAdd = () => {
        qrAbort.current?.abort();
        setAddStep(null);
        setNewCharacterId("");
        setAddError("");
        setQrImgUrl("");
        setQrStatus("loading");
    };

    // Convert qrcode_img_content into a displayable data URL
    const resolveQrImage = async (raw: string): Promise<string> => {
        // Already a data URI
        if (raw.startsWith("data:")) return raw;
        // Base64 image data (no prefix)
        if (!raw.startsWith("http") && raw.length > 100) return `data:image/png;base64,${raw}`;
        // It's a URL: generate a QR code image (user scans this URL with WeChat)
        return QRCode.toDataURL(raw, { width: 280, margin: 2 });
    };

    // Start the QR login flow
    const startQrLogin = async () => {
        setAddError("");
        if (!newCharacterId) { setAddError("Please select a character"); return; }

        setAddStep("scanning");
        setQrStatus("loading");

        try {
            const qr = await getLoginQrCode();
            if (!qr.qrcode || !qr.qrcode_img_content) {
                throw new Error("Failed to get QR code");
            }
            const imgUrl = await resolveQrImage(qr.qrcode_img_content);
            setQrImgUrl(imgUrl);
            setQrStatus("wait");

            // Start polling QR scan status
            qrAbort.current?.abort();
            const ctrl = new AbortController();
            qrAbort.current = ctrl;

            while (!ctrl.signal.aborted) {
                await new Promise(r => setTimeout(r, 2000));
                if (ctrl.signal.aborted) break;

                try {
                    const status = await pollQrCodeStatus(qr.qrcode);
                    setQrStatus(status.status);

                    if (status.status === "confirmed" && status.bot_token) {
                        // Login succeeded! Save the bot config
                        const char = characters.find(c => c.id === newCharacterId);
                        addExclusiveWeixinBot({
                            characterId: newCharacterId,
                            botToken: status.bot_token,
                            enabled: true,
                            nickname: char?.name,
                        });
                        setBots(loadWeixinBots());
                        notifyChange();
                        setAddStep("done");
                        return;
                    }

                    if (status.status === "expired") {
                        setAddError("QR code expired, please try again");
                        setAddStep("select-character");
                        return;
                    }
                } catch {
                    // Single poll attempt failed, keep going
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setAddError(`Login failed: ${msg}`);
            setAddStep("select-character");
        }
    };

    const statusDot = (id: string) => {
        void statusTick;
        const s = getWeixinBotStatus(id);
        if (s.status === "running") return <Wifi size={14} className="text-green-500" />;
        if (s.status === "error") return <AlertCircle size={14} className="text-red-500" />;
        return <WifiOff size={14} className="text-[var(--c-text-muted)]" />;
    };

    const statusLabel = (id: string) => {
        void statusTick;
        const bot = bots.find(item => item.id === id);
        if (cloudSyncConfig.enabled && bot?.enabled) return "Local assistant sync: the mini phone syncs messages, the local computer handles auto-replies";
        const s = getWeixinBotStatus(id);
        if (s.status === "running") return "Running";
        if (s.status === "error") return s.message ?? "Error";
        return "Stopped";
    };

    const boundCharacterIds = new Set(bots.map(b => b.characterId));
    const availableCharacters = characters.filter(
        c => !boundCharacterIds.has(c.id) || c.id === newCharacterId
    );
    const cloudSupabaseReady = isWeixinCloudSupabaseReady();

    const qrStatusText: Record<string, string> = {
        loading: "Getting QR code…",
        wait: "Scan the QR code with WeChat",
        scaned: "Scanned — please confirm login in WeChat",
        confirmed: "Login successful!",
        expired: "QR code expired",
    };

    return (
        <div className="flex flex-col gap-[24px] h-full">
            <div className="flex justify-between items-center gap-3">
                <p className="settings-menu-section-title">WeChat Bots</p>
                {!addStep && (
                    <button
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[18px] bg-black px-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                        onClick={() => { setAddStep("select-character"); setAddError(""); }}
                    >
                        <Plus size={14} strokeWidth={1.8} />
                        Add WeChat Bot
                    </button>
                )}
            </div>

            {/* Keep-alive toggle */}
            <div className="ui-group-card !flex-row !items-center">
                <div className="flex-1 flex flex-col gap-1">
                    <span className="menu-label font-medium">Keep Alive in Background</span>
                    <span className="menu-desc !mt-0">Try to keep the page running when switched to background, regardless of whether any bot is enabled</span>
                </div>
                <Toggle checked={keepAlive} onChange={v => { setKeepAlive(v); saveKeepAlive(v); notifyChange(); }} />
            </div>

            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><CloudUpload size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1">
                        <span className="menu-label font-medium">WeChat Local Assistant</span>
                        <span className="menu-desc !mt-0">
                            Download and run it on your computer — the mini phone will automatically sync messages with the cloud.
                        </span>
                    </div>
                    <Toggle
                        checked={cloudSyncConfig.enabled}
                        onChange={v => updateCloudSyncConfig({ enabled: v })}
                    />
                </div>

                <div className="flex flex-col gap-3 mt-4">
                    <div className="flex flex-col gap-1.5">
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full justify-center"
                            disabled={!cloudSupabaseReady || Boolean(cloudSyncingId)}
                            onClick={() => void handleDownloadLocalAssistantPackage()}
                        >
                            {cloudSyncingId === "package"
                                ? <><Loader2 size={16} className="animate-spin" /> Packaging…</>
                                : <><Download size={16} /> Download Local Assistant Package</>}
                        </button>
                        <span className="menu-desc !mt-0 text-center">Last synced: {cloudSyncConfig.lastSyncedAt ? formatCloudSyncTime(cloudSyncConfig.lastSyncedAt) : "Not synced yet"}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="menu-desc !mt-0">
                            When auto-sync is on, the mini phone automatically pulls WeChat messages when opened or brought to the foreground; messages sent from the mini phone are also automatically written to the cloud.
                        </span>
                        <button
                            type="button"
                            className="flex h-11 w-full items-center justify-between rounded-[14px] border border-black/10 bg-black/[0.035] px-3 text-left text-[13px] font-semibold text-[var(--c-text)] transition-colors hover:bg-black/[0.055] active:scale-[0.99] focus:outline-none"
                            onClick={() => setShowLocalAssistantAdvanced(v => !v)}
                            aria-expanded={showLocalAssistantAdvanced}
                        >
                            <span>{showLocalAssistantAdvanced ? "Hide Advanced Options" : "Show Advanced Options"}</span>
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/80 shadow-sm">
                                <ChevronDown
                                    size={17}
                                    className={`transition-transform ${showLocalAssistantAdvanced ? "rotate-180" : ""}`}
                                />
                            </span>
                        </button>
                    </div>
                    {showLocalAssistantAdvanced && (
                        <div className="grid grid-cols-3 gap-2 rounded-[18px] bg-black/[0.03] p-3">
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline min-w-0 justify-center whitespace-nowrap !gap-1 !px-2 !text-[11px]"
                                disabled={!cloudSupabaseReady || Boolean(cloudSyncingId)}
                                onClick={() => void handleSyncAllRuntimes()}
                            >
                                {cloudSyncingId === "all"
                                    ? <><Loader2 size={14} className="animate-spin" /> Syncing…</>
                                    : <><CloudUpload size={14} /> Sync Runtime Package</>}
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline min-w-0 justify-center whitespace-nowrap !gap-1 !px-2 !text-[11px]"
                                disabled={!cloudSupabaseReady || Boolean(cloudSyncingId)}
                                onClick={() => void handlePullCloudMessages()}
                            >
                                {cloudSyncingId === "pull"
                                    ? <><Loader2 size={14} className="animate-spin" /> Pulling…</>
                                    : "Manually Pull Messages"}
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline min-w-0 justify-center whitespace-nowrap !gap-1 !px-2 !text-[11px]"
                                disabled={!cloudSupabaseReady}
                                onClick={() => void handleCopyLocalAssistantConfig()}
                            >
                                <Copy size={14} />
                                Copy Config Code
                            </button>
                        </div>
                    )}
                    {!cloudSupabaseReady && (
                        <Alert variant="warning">Please configure and test Supabase cloud backup in "Data Management" first.</Alert>
                    )}
                    {cloudSyncNotice && (
                        <Alert variant={cloudSyncNotice.ok ? "success" : "danger"}>{cloudSyncNotice.text}</Alert>
                    )}
                    <span className="menu-desc !mt-0">
                        The runtime package includes the WeChat token, the API config bound to the current character, and a prompt snapshot — it is only written to your own private Supabase backup bucket. After changing characters, API, presets, world info, or memory, please re-download or re-sync the runtime package. The local assistant package and config code contain your private Supabase key — do not share them publicly.
                    </span>
                </div>
            </div>

            {/* Bot list */}
            {bots.length > 0 && (
                <div className="flex flex-col gap-2">
                    {bots.map(bot => {
                        const char = characters.find(c => c.id === bot.characterId);
                        const status = getWeixinBotStatus(bot.id);
                        return (
                            <div key={bot.id} className="ui-group-card !flex-row !items-center">
                                <div className="flex-1 flex flex-col gap-1">
                                    <div className="flex items-center gap-[6px]">
                                        {statusDot(bot.id)}
                                        <span className="menu-label">{char?.name ?? bot.nickname ?? bot.characterId}</span>
                                    </div>
                                    <span className={`menu-desc !mt-0 ${status.status === "running" ? "text-green-500" : status.status === "error" ? "text-red-500" : ""}`}>
                                        {statusLabel(bot.id)}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                    <button
                                        className="ui-link-btn"
                                        data-variant="muted"
                                        onClick={() => void handleSyncRuntime(bot.id)}
                                        disabled={!cloudSupabaseReady || Boolean(cloudSyncingId)}
                                        title="Sync local assistant runtime package"
                                    >
                                        {cloudSyncingId === bot.id ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} />}
                                    </button>
                                    <button className="ui-link-btn" data-variant="muted" onClick={() => setConfirmDeleteId(bot.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                    <Toggle checked={bot.enabled} onChange={v => handleToggle(bot.id, v)} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Empty state */}
            {bots.length === 0 && !addStep && (
                <div className="ui-empty mt-2">
                    <div className="ui-icon-circle"><MessageSquare size={24} /></div>
                    <span className="menu-label font-semibold">No WeChat Bots Yet</span>
                    <span className="menu-desc max-w-[240px]">Use the iLink protocol to let AI characters reply as a real WeChat account.</span>
                    <button className="ui-btn ui-btn-primary" onClick={() => { setAddStep("select-character"); setAddError(""); }}>
                        <Plus size={16} /> Add Bot
                    </button>
                </div>
            )}

            {/* Add dialog */}
            {addStep && (
                <ContentDialog
                    title={addStep === "done" ? "Added Successfully" : "Add WeChat Bot"}
                    confirmLabel={addStep === "select-character" ? "Scan to Log In" : addStep === "done" ? "Done" : ""}
                    cancelLabel={addStep === "done" ? "" : "Cancel"}
                    onConfirm={() => {
                        if (addStep === "select-character") startQrLogin();
                        else cancelAdd();
                    }}
                    onCancel={cancelAdd}
                >
                    {addStep === "select-character" && (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">Select Character</label>
                                <Select value={newCharacterId} onChange={e => setNewCharacterId(e.target.value)}>
                                    <option value="">Please select…</option>
                                    {availableCharacters.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
                                </Select>
                            </div>
                            {addError && <Alert variant="danger">{addError}</Alert>}
                        </div>
                    )}
                    {addStep === "scanning" && (
                        <div className="flex flex-col items-center gap-3">
                            <span className="menu-label font-semibold">{characters.find(c => c.id === newCharacterId)?.name}</span>
                            <div className="w-48 h-48 rounded-lg bg-white flex items-center justify-center overflow-hidden">
                                {qrImgUrl ? (
                                    <img src={qrImgUrl} alt="WeChat login QR code" className="w-full h-full object-contain" />
                                ) : (
                                    <Loader2 size={28} className="animate-spin opacity-30" />
                                )}
                            </div>
                            <span className={`menu-desc !mt-0 ${qrStatus === "scaned" ? "text-amber-500 font-medium" : ""}`}>
                                {qrStatusText[qrStatus] ?? "Waiting…"}
                            </span>
                            {qrStatus === "expired" && (
                                <button className="ui-btn flex items-center gap-1" onClick={startQrLogin}>
                                    <RefreshCw size={12} /> Refresh QR Code
                                </button>
                            )}
                        </div>
                    )}
                    {addStep === "done" && (
                        <div className="flex flex-col items-center gap-2">
                            <span className="menu-label font-semibold text-green-500">Login successful!</span>
                            <span className="menu-desc">WeChat bot for {characters.find(c => c.id === newCharacterId)?.name} is now enabled</span>
                        </div>
                    )}
                </ContentDialog>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="Confirm Delete?"
                    message="Delete this bot configuration? Chat history will not be deleted."
                    confirmLabel="Confirm Delete"
                    icon={AlertCircle}
                    variant="danger"
                    onConfirm={() => { handleDelete(confirmDeleteId); setConfirmDeleteId(null); }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
