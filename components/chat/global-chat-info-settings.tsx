"use client";

import { useEffect, useRef, useState } from "react";
import { BellRing, ChevronRight, Code, Image as ImageIcon, RotateCcw, User, X } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Toggle } from "@/components/ui/form";
import {
    MAX_VISION_IMAGE_PROMPT_LIMIT,
    getActiveChatSessionId,
    loadChatAppSettings,
    loadChatSessions,
    normalizeVisionImagePromptLimit,
    saveChatAppSettings,
    saveChatSessions,
    type ChatSoundConfig,
    type ChatSoundKind,
    type ChatSoundsConfig,
} from "@/lib/chat-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";
import { ChatSoundSourceEditor, SOUND_ITEMS } from "./chat-sound-editor";
import { previewChatSound } from "@/lib/chat-sound";
import { CHAT_SESSION_CSS_EXAMPLE } from "@/lib/css-examples";
import { fileToUserAvatarDataUrl } from "@/lib/user-avatar-image";

function saveSettings(patch: Record<string, unknown>) {
    saveChatAppSettings({ ...loadChatAppSettings(), ...patch });
}

// ── Notification-sounds section ──────────────────────────────────────

function ChatSoundsSection() {
    const [sounds, setSounds] = useState<ChatSoundsConfig>(() => loadChatAppSettings().globalChatSounds || {});

    const changeSound = (kind: ChatSoundKind, patch: Partial<ChatSoundConfig>) => {
        setSounds(current => {
            const next: ChatSoundsConfig = { ...current, [kind]: { ...current[kind], ...patch } };
            saveChatAppSettings({ ...loadChatAppSettings(), globalChatSounds: next });
            return next;
        });
    };

    // New-message sound "test popup": simulates a real new message -- plays the sound + shows
    // the desktop notification banner. The banner picks whichever session was most recently
    // active (preferring one that isn't the one currently open); tapping the banner jumps into
    // that chat.
    const testNewMessageNotice = () => {
        void previewChatSound("newMessage");
        const sessions = loadChatSessions()
            .slice()
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        const activeId = getActiveChatSessionId();
        const target = sessions.find(s => s.id !== activeId) || sessions[0];
        if (!target) { alert("There are no chat sessions yet -- say something to a character first, then test the popup"); return; }
        dispatchChatMessageNotice({
            sessionId: target.id,
            body: "[Sound Test] Simulating an incoming new message",
            isTest: true,
        });
    };

    return (
        <div className="menu-group">
            {SOUND_ITEMS.map(({ kind, icon: Icon, label, desc }) => {
                const config: ChatSoundConfig = sounds[kind] || {};
                const enabled = config.enabled === true;
                return (
                    <div key={kind} className="chat-sound-block">
                        <div className="menu-item">
                            <Icon size={20} className="text-[var(--c-icon)]" />
                            <div className="menu-label-group"><span className="menu-label">{label}</span><span className="menu-desc">{desc}</span></div>
                            <div className="menu-right">
                                <Toggle checked={enabled} onChange={checked => changeSound(kind, { enabled: checked })} />
                            </div>
                        </div>
                        {enabled ? (
                            <div className="chat-sound-editor">
                                <ChatSoundSourceEditor
                                    config={config}
                                    onPatch={patch => changeSound(kind, patch)}
                                    onPreview={() => void previewChatSound(kind)}
                                />
                                {kind === "newMessage" ? (
                                    <>
                                        <div className="chat-sound-subtoggles">
                                            <div className="chat-sound-subtoggle">
                                                <div className="menu-label-group"><span className="menu-label">No sound while live-chatting</span><span className="menu-desc">No sound plays for a character's new messages while that chat is open</span></div>
                                                <Toggle checked={config.muteActiveChat === true} onChange={checked => changeSound(kind, { muteActiveChat: checked })} />
                                            </div>
                                            <div className="chat-sound-subtoggle">
                                                <div className="menu-label-group"><span className="menu-label">Only notify once per burst</span><span className="menu-desc">Several messages in a row from the same character play the sound only on the first one</span></div>
                                                <Toggle checked={config.notifyOncePerBurst === true} onChange={checked => changeSound(kind, { notifyOncePerBurst: checked })} />
                                            </div>
                                        </div>
                                        {config.value ? (
                                            <div className="chat-sound-editor-row chat-sound-test-row">
                                                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={testNewMessageNotice}>
                                                    <BellRing size={14} /> Test Popup
                                                </button>
                                                <span className="chat-sound-source">Simulates a new message: shows the notification banner and plays the sound</span>
                                            </div>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

export function GlobalChatInfoSettings({ onBack }: { onBack: () => void }) {
    const initial = loadChatAppSettings();
    const [avatar, setAvatar] = useState(initial.globalChatUserAvatar || "");
    const [background, setBackground] = useState(initial.globalChatBackgroundImage || "");
    const [backgroundPreview, setBackgroundPreview] = useState("");
    const [customCSS, setCustomCSS] = useState(initial.globalChatCustomCSS || "");
    const [visionLimit, setVisionLimit] = useState(() => normalizeVisionImagePromptLimit(initial.globalVisionImagePromptLimit));
    const [editingCSS, setEditingCSS] = useState(false);
    const [draftCSS, setDraftCSS] = useState(customCSS);
    const avatarInputRef = useRef<HTMLInputElement>(null);
    const backgroundInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let cancelled = false;
        if (!background) { setBackgroundPreview(""); return; }
        if (background.startsWith("data:") || background.startsWith("http")) {
            setBackgroundPreview(background);
            return;
        }
        void getChatImageFromIndexedDB(background).then(url => {
            if (!cancelled) setBackgroundPreview(url || "");
        });
        return () => { cancelled = true; };
    }, [background]);

    const changeAvatar = async (file?: File) => {
        if (!file) return;
        try {
            const value = await fileToUserAvatarDataUrl(file);
            setAvatar(value);
            saveSettings({ globalChatUserAvatar: value });
        } catch { alert("Failed to process the avatar image -- try a different one"); }
    };

    const changeBackground = async (file?: File) => {
        if (!file) return;
        try {
            const id = await saveChatImageToIndexedDB(file);
            setBackground(id);
            saveSettings({ globalChatBackgroundImage: id });
        } catch { alert("Failed to save the background image -- try a different one"); }
    };

    const changeVisionLimit = (value: unknown) => {
        const next = normalizeVisionImagePromptLimit(value);
        setVisionLimit(next);
        saveSettings({ globalVisionImagePromptLimit: next });
    };

    // Restore all characters to default: clears every session's own chat-room CSS, so all of
    // them fall back to the global chat-room CSS / homepage appearance CSS. Dispatches
    // chat-session-css-updated per session so any open chat room (including the desktop mini
    // window) picks it up immediately.
    const resetAllSessionCSS = () => {
        const sessions = loadChatSessions();
        const withCSS = sessions.filter(s => (s.customCSS || "").trim());
        if (!withCSS.length) { alert("Every chat is already following the global style -- nothing to restore"); return; }
        if (!window.confirm(`This clears the individual CSS on ${withCSS.length} direct/group chat(s), restoring the default style for all of them (the global chat-room CSS is unaffected). Continue?`)) return;
        saveChatSessions(sessions.map(s => (s.customCSS || "").trim() ? { ...s, customCSS: "" } : s));
        for (const s of withCSS) {
            window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: s.id, css: "" } }));
        }
        alert(`Restored the default style for ${withCSS.length} chat(s)`);
    };

    if (editingCSS) {
        return (
            <PageShell title="Global Chat-Room CSS" onBack={() => setEditingCSS(false)} className="absolute inset-0 z-[110]">
                <div className="theme-section-page">
                    <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">Applies to every direct and group chat; a per-session CSS override beats this, and the homepage "Appearance CSS" has the lowest priority.</p>
                    <textarea className="ui-textarea font-mono ts-13 leading-relaxed flex-1" style={{ minHeight: 320, resize: "none" }} value={draftCSS} onChange={event => setDraftCSS(event.target.value)} spellCheck={false} placeholder={CHAT_SESSION_CSS_EXAMPLE} />
                    <div className="flex gap-2 mt-3 items-center">
                        <CSSSchemeBar target="chat_session" currentCSS={draftCSS} onLoad={setDraftCSS} />
                        <button className="ui-btn ui-btn-outline flex-1" onClick={() => setDraftCSS(CHAT_SESSION_CSS_EXAMPLE)}>Example</button>
                        <button className="ui-btn ui-btn-outline flex-1" onClick={() => setDraftCSS("")}>Clear</button>
                        <button className="ui-btn ui-btn-soft-action flex-1" onClick={() => { setCustomCSS(draftCSS); saveSettings({ globalChatCustomCSS: draftCSS }); setEditingCSS(false); }}>Apply</button>
                    </div>
                </div>
            </PageShell>
        );
    }

    return (
        <PageShell title="Global Chat Info" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu chat-info-menu">
                <div className="px-4 pb-2 ts-12 text-[var(--c-text)] opacity-65">A per-session setting takes priority over these; these only change the chat room, never your homepage profile.</div>
                <div className="menu-group">
                    <div className="menu-item cursor-pointer" role="button" tabIndex={0} onClick={() => avatarInputRef.current?.click()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") avatarInputRef.current?.click(); }}>
                        <User size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">User Avatar</span><span className="menu-desc">Default for every direct and group chat</span></div>
                        <div className="menu-right gap-2">
                            {avatar ? <img src={avatar} className="h-9 w-9 rounded-full object-cover" alt="Global chat avatar" /> : <span className="menu-desc">Follows your profile</span>}
                            {avatar && <button aria-label="Clear the global chat avatar" onClick={event => { event.stopPropagation(); setAvatar(""); saveSettings({ globalChatUserAvatar: "" }); }}><X size={15} /></button>}
                            <ChevronRight size={16} />
                        </div>
                    </div>
                    <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={event => { void changeAvatar(event.target.files?.[0]); event.target.value = ""; }} />
                    <div className="menu-item cursor-pointer" role="button" tabIndex={0} onClick={() => backgroundInputRef.current?.click()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") backgroundInputRef.current?.click(); }}>
                        <ImageIcon size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">Chat Background</span><span className="menu-desc">Default for every direct and group chat</span></div>
                        <div className="menu-right gap-2">
                            {backgroundPreview ? <img src={backgroundPreview} className="h-9 w-9 rounded-lg object-cover" alt="Global chat background" /> : <span className="menu-desc">Not set</span>}
                            {background && <button aria-label="Clear the global chat background" onClick={event => { event.stopPropagation(); setBackground(""); saveSettings({ globalChatBackgroundImage: "" }); }}><X size={15} /></button>}
                            <ChevronRight size={16} />
                        </div>
                    </div>
                    <input ref={backgroundInputRef} type="file" accept="image/*" className="hidden" onChange={event => { void changeBackground(event.target.files?.[0]); event.target.value = ""; }} />
                    <button className="menu-item" onClick={() => { setDraftCSS(customCSS); setEditingCSS(true); }}>
                        <Code size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">Chat-Room Custom CSS</span><span className="menu-desc">Shares its saved schemes with a single chat's own CSS</span></div>
                        <div className="menu-right"><span className="menu-desc mr-1">{customCSS ? "Set" : "Not set"}</span><ChevronRight size={16} /></div>
                    </button>
                    <button className="menu-item" onClick={resetAllSessionCSS}>
                        <RotateCcw size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">Restore All Characters to Default</span><span className="menu-desc">Clears every direct/group chat's own CSS, switching them back to the global style</span></div>
                        <div className="menu-right" />
                    </button>
                    <div className="menu-item">
                        <ImageIcon size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">Recent Images Sent to Model</span><span className="menu-desc">Default vision-context count for every direct and group chat</span></div>
                        <div className="menu-right gap-2">
                            <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => changeVisionLimit(visionLimit - 1)} disabled={visionLimit <= 0}>-</button>
                            <input type="number" min={0} max={MAX_VISION_IMAGE_PROMPT_LIMIT} value={visionLimit} onChange={event => changeVisionLimit(event.target.value)} className="ui-input h-8 w-14 text-center" />
                            <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => changeVisionLimit(visionLimit + 1)} disabled={visionLimit >= MAX_VISION_IMAGE_PROMPT_LIMIT}>+</button>
                        </div>
                    </div>
                </div>
                <div className="px-4 pt-3 pb-2 ts-12 font-medium text-[var(--c-text-title)] opacity-80">Notification Sounds</div>
                <ChatSoundsSection />
            </div>
        </PageShell>
    );
}
