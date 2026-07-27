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
    return `AI Phone 微信本地助手

使用方法：
1. 解压这个文件夹。
2. 双击「启动助手.bat」。
3. 保持这个窗口打开，电脑在线时会自动轮询微信并回复。

测试：
- 双击「测试一次.bat」只轮询一次，适合检查配置是否正常。

注意：
- config.txt 已由小手机自动写入，不需要手动复制配置码。
- config.txt 包含你的 Supabase 私密密钥，不要公开分享这个文件夹。
- 角色、API、预设、世界书或记忆改动后，请回到小手机重新下载本地助手包。
- 如果提示未检测到 Node.js，请安装 Node.js 20+，或使用后续提供的内置运行时版本。
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

    // 添加流程
    const [addStep, setAddStep] = useState<AddStep | null>(null);
    const [newCharacterId, setNewCharacterId] = useState("");
    const [addError, setAddError] = useState("");

    // QR 码状态
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

    // 清理 QR 轮询
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
                text: `已同步「${result.snapshot.character.name}」运行包：${result.snapshot.stats.messageCount} 条消息，${formatCloudSyncBytes(result.bytes)}。`,
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
                setCloudSyncNotice({ ok: false, text: "没有可同步的已启用微信 Bot。" });
            } else {
                const totalBytes = results.reduce((sum, item) => sum + item.bytes, 0);
                setCloudSyncNotice({
                    ok: true,
                    text: `已同步当前微信运行包，共 ${formatCloudSyncBytes(totalBytes)}。`,
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
                text: `已拉取同步消息：新增 ${result.added}，跳过 ${result.skipped}${result.errors.length ? `，错误 ${result.errors.length}` : ""}。`,
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
                text: "已复制本地助手配置码。配置码包含 Supabase 私密密钥，请只粘贴到你自己的本地助手。",
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
                setCloudSyncNotice({ ok: false, text: "没有可同步的已启用微信 Bot。" });
                return;
            }

            const code = buildWeixinLocalAssistantConfigCode({ pollIntervalSeconds: 5 });
            const scriptRes = await fetch("/weixin-local-assistant/assistant.mjs", { cache: "no-store" });
            if (!scriptRes.ok) throw new Error("下载助手脚本失败，请重新部署后再试。");
            const assistantScript = await scriptRes.text();
            const JSZip = (await import("jszip")).default;
            const { downloadFile } = await import("@/lib/download-utils");
            const zip = new JSZip();
            zip.file("assistant.mjs", assistantScript);
            zip.file("config.txt", code);
            zip.file("启动助手.bat", buildLocalAssistantStartBat());
            zip.file("测试一次.bat", buildLocalAssistantOnceBat());
            zip.file("README.txt", buildLocalAssistantReadme());
            for (const fileName of LOCAL_ASSISTANT_CARD_ASSETS) {
                const assetPath = `/weixin-local-assistant/generated-cards/${fileName}`;
                const assetRes = await fetch(assetPath, { cache: "no-store" });
                if (!assetRes.ok) throw new Error(`下载助手卡片素材失败：${fileName}`);
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
                text: `已生成本地助手包，并同步运行包 ${formatCloudSyncBytes(totalBytes)}。解压后双击「启动助手.bat」即可运行。`,
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

    // 将 qrcode_img_content 转为可显示的 data URL
    const resolveQrImage = async (raw: string): Promise<string> => {
        // 已经是 data URI
        if (raw.startsWith("data:")) return raw;
        // 是 base64 图片数据（无前缀）
        if (!raw.startsWith("http") && raw.length > 100) return `data:image/png;base64,${raw}`;
        // 是 URL：需要生成二维码图片（用户用微信扫这个 URL）
        return QRCode.toDataURL(raw, { width: 280, margin: 2 });
    };

    // 开始扫码流程
    const startQrLogin = async () => {
        setAddError("");
        if (!newCharacterId) { setAddError("请选择角色"); return; }

        setAddStep("scanning");
        setQrStatus("loading");

        try {
            const qr = await getLoginQrCode();
            if (!qr.qrcode || !qr.qrcode_img_content) {
                throw new Error("获取二维码失败");
            }
            const imgUrl = await resolveQrImage(qr.qrcode_img_content);
            setQrImgUrl(imgUrl);
            setQrStatus("wait");

            // 开始轮询扫码状态
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
                        // 登录成功！保存 bot 配置
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
                        setAddError("二维码已过期，请重试");
                        setAddStep("select-character");
                        return;
                    }
                } catch {
                    // 单次轮询失败，继续
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setAddError(`登录失败: ${msg}`);
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
        if (cloudSyncConfig.enabled && bot?.enabled) return "本地助手同步：小手机负责同步消息，本地电脑负责自动回复";
        const s = getWeixinBotStatus(id);
        if (s.status === "running") return "运行中";
        if (s.status === "error") return s.message ?? "错误";
        return "已停止";
    };

    const boundCharacterIds = new Set(bots.map(b => b.characterId));
    const availableCharacters = characters.filter(
        c => !boundCharacterIds.has(c.id) || c.id === newCharacterId
    );
    const cloudSupabaseReady = isWeixinCloudSupabaseReady();

    const qrStatusText: Record<string, string> = {
        loading: "正在获取二维码…",
        wait: "请用微信扫描二维码",
        scaned: "已扫描，请在微信上确认登录",
        confirmed: "登录成功！",
        expired: "二维码已过期",
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
                        添加微信 Bot
                    </button>
                )}
            </div>

            {/* 保活开关 */}
            <div className="ui-group-card !flex-row !items-center">
                <div className="flex-1 flex flex-col gap-1">
                    <span className="menu-label font-medium">后台保活</span>
                    <span className="menu-desc !mt-0">切到后台时尽量保持网页运行，不依赖 Bot 是否启用</span>
                </div>
                <Toggle checked={keepAlive} onChange={v => { setKeepAlive(v); saveKeepAlive(v); notifyChange(); }} />
            </div>

            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><CloudUpload size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1">
                        <span className="menu-label font-medium">微信本地助手</span>
                        <span className="menu-desc !mt-0">
                            下载后在电脑上运行，小手机会自动和云端同步消息。
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
                                ? <><Loader2 size={16} className="animate-spin" /> 打包中…</>
                                : <><Download size={16} /> 下载本地助手包</>}
                        </button>
                        <span className="menu-desc !mt-0 text-center">上次同步：{cloudSyncConfig.lastSyncedAt ? formatCloudSyncTime(cloudSyncConfig.lastSyncedAt) : "尚未同步"}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="menu-desc !mt-0">
                            自动同步开启后，小手机打开或回到前台时会自动拉取微信消息；小手机里发出的消息也会自动写入云端。
                        </span>
                        <button
                            type="button"
                            className="flex h-11 w-full items-center justify-between rounded-[14px] border border-black/10 bg-black/[0.035] px-3 text-left text-[13px] font-semibold text-[var(--c-text)] transition-colors hover:bg-black/[0.055] active:scale-[0.99] focus:outline-none"
                            onClick={() => setShowLocalAssistantAdvanced(v => !v)}
                            aria-expanded={showLocalAssistantAdvanced}
                        >
                            <span>{showLocalAssistantAdvanced ? "收起高级选项" : "展开高级选项"}</span>
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
                                    ? <><Loader2 size={14} className="animate-spin" /> 同步中…</>
                                    : <><CloudUpload size={14} /> 同步运行包</>}
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline min-w-0 justify-center whitespace-nowrap !gap-1 !px-2 !text-[11px]"
                                disabled={!cloudSupabaseReady || Boolean(cloudSyncingId)}
                                onClick={() => void handlePullCloudMessages()}
                            >
                                {cloudSyncingId === "pull"
                                    ? <><Loader2 size={14} className="animate-spin" /> 拉取中…</>
                                    : "手动拉取消息"}
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline min-w-0 justify-center whitespace-nowrap !gap-1 !px-2 !text-[11px]"
                                disabled={!cloudSupabaseReady}
                                onClick={() => void handleCopyLocalAssistantConfig()}
                            >
                                <Copy size={14} />
                                复制配置码
                            </button>
                        </div>
                    )}
                    {!cloudSupabaseReady && (
                        <Alert variant="warning">请先到「数据管理」配置并测试 Supabase 云端备份。</Alert>
                    )}
                    {cloudSyncNotice && (
                        <Alert variant={cloudSyncNotice.ok ? "success" : "danger"}>{cloudSyncNotice.text}</Alert>
                    )}
                    <span className="menu-desc !mt-0">
                        运行包会包含微信 token、当前角色绑定的 API 配置和提示词快照，仅写入你自己的 Supabase 私有备份桶。角色、API、预设、世界书或记忆变更后，请重新下载或同步运行包。本地助手包和配置码包含 Supabase 私密密钥，不要公开分享。
                    </span>
                </div>
            </div>

            {/* Bot 列表 */}
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
                                        title="同步本地助手运行包"
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

            {/* 空状态 */}
            {bots.length === 0 && !addStep && (
                <div className="ui-empty mt-2">
                    <div className="ui-icon-circle"><MessageSquare size={24} /></div>
                    <span className="menu-label font-semibold">暂无微信 Bot</span>
                    <span className="menu-desc max-w-[240px]">通过 iLink 协议让 AI 角色以真实微信号回复消息。</span>
                    <button className="ui-btn ui-btn-primary" onClick={() => { setAddStep("select-character"); setAddError(""); }}>
                        <Plus size={16} /> 添加 Bot
                    </button>
                </div>
            )}

            {/* 添加弹窗 */}
            {addStep && (
                <ContentDialog
                    title={addStep === "done" ? "添加成功" : "添加微信 Bot"}
                    confirmLabel={addStep === "select-character" ? "扫码登录" : addStep === "done" ? "完成" : ""}
                    cancelLabel={addStep === "done" ? "" : "取消"}
                    onConfirm={() => {
                        if (addStep === "select-character") startQrLogin();
                        else cancelAdd();
                    }}
                    onCancel={cancelAdd}
                >
                    {addStep === "select-character" && (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">选择角色</label>
                                <Select value={newCharacterId} onChange={e => setNewCharacterId(e.target.value)}>
                                    <option value="">请选择…</option>
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
                                    <img src={qrImgUrl} alt="微信登录二维码" className="w-full h-full object-contain" />
                                ) : (
                                    <Loader2 size={28} className="animate-spin opacity-30" />
                                )}
                            </div>
                            <span className={`menu-desc !mt-0 ${qrStatus === "scaned" ? "text-amber-500 font-medium" : ""}`}>
                                {qrStatusText[qrStatus] ?? "等待中…"}
                            </span>
                            {qrStatus === "expired" && (
                                <button className="ui-btn flex items-center gap-1" onClick={startQrLogin}>
                                    <RefreshCw size={12} /> 刷新二维码
                                </button>
                            )}
                        </div>
                    )}
                    {addStep === "done" && (
                        <div className="flex flex-col items-center gap-2">
                            <span className="menu-label font-semibold text-green-500">登录成功！</span>
                            <span className="menu-desc">{characters.find(c => c.id === newCharacterId)?.name} 的微信 Bot 已启用</span>
                        </div>
                    )}
                </ContentDialog>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除此 Bot 配置？聊天记录不会删除。"
                    confirmLabel="确认删除"
                    icon={AlertCircle}
                    variant="danger"
                    onConfirm={() => { handleDelete(confirmDeleteId); setConfirmDeleteId(null); }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
