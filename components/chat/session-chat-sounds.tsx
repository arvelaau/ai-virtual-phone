"use client";

// Direct chat's own info page -> character-specific notification sounds.
// Each sound has three modes: follow global (default) / character-specific (this character
// uses its own audio) / off (this character plays none). Resolution rule lives in
// lib/chat-storage.ts's resolveChatSoundConfig: a field explicitly set on the session
// overrides the global value; everything else (audio source, sub-toggles) is inherited from global.

import { useState, type CSSProperties } from "react";
import { BellRing } from "lucide-react";
import {
    loadChatAppSettings,
    type ChatSession,
    type ChatSoundConfig,
    type ChatSoundKind,
    type ChatSoundsConfig,
} from "@/lib/chat-storage";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";
import { previewChatSound } from "@/lib/chat-sound";
import { Toggle } from "@/components/ui/form";
import { ChatSoundSourceEditor, SOUND_ITEMS } from "./chat-sound-editor";

type SoundMode = "inherit" | "custom" | "off";

function soundModeOf(config?: ChatSoundConfig): SoundMode {
    if (config?.enabled === true) return "custom";
    if (config?.enabled === false) return "off";
    return "inherit";
}

const MODE_OPTIONS: [SoundMode, string][] = [
    ["inherit", "Global"],
    ["custom", "Custom"],
    ["off", "Off"],
];

export function SessionChatSoundsSection({ session, accent, onUpdate }: {
    session: ChatSession;
    /** Icon circle color, matching the other rows on the chat-info page. */
    accent: string;
    onUpdate: (updates: Partial<ChatSession>) => void;
}) {
    const [sounds, setSounds] = useState<ChatSoundsConfig>(() => session.sounds || {});
    const globalSounds = loadChatAppSettings().globalChatSounds || {};

    const changeSound = (kind: ChatSoundKind, patch: Partial<ChatSoundConfig>) => {
        setSounds(current => {
            const next: ChatSoundsConfig = { ...current, [kind]: { ...current[kind], ...patch } };
            onUpdate({ sounds: next });
            return next;
        });
    };

    const setMode = (kind: ChatSoundKind, mode: SoundMode) => {
        if (mode === "inherit") {
            // Follow global: drop every override this session has for that sound.
            setSounds(current => {
                const next: ChatSoundsConfig = { ...current };
                delete next[kind];
                onUpdate({ sounds: next });
                return next;
            });
            return;
        }
        // "Off" only flips the toggle and keeps any configured audio, so switching back to
        // "custom" can keep using it.
        changeSound(kind, { enabled: mode === "custom" });
    };

    const clearSubToggle = (kind: ChatSoundKind, key: "muteActiveChat" | "notifyOncePerBurst") => {
        setSounds(current => {
            const own: ChatSoundConfig = { ...(current[kind] || {}) };
            delete own[key];
            const next: ChatSoundsConfig = { ...current, [kind]: own };
            onUpdate({ sounds: next });
            return next;
        });
    };

    // New-message sound "test popup": simulates a real new message from this character session
    // -- plays whichever sound actually applies to this character (character-specific beats
    // global) and shows the desktop notification banner.
    const testNewMessageNotice = () => {
        void previewChatSound("newMessage", session);
        dispatchChatMessageNotice({
            sessionId: session.id,
            body: "[Sound Test] Simulating an incoming new message",
            isTest: true,
        });
    };

    return (
        <div className="menu-group">
            {SOUND_ITEMS.map(({ kind, icon: Icon, label, desc }) => {
                const own: ChatSoundConfig = sounds[kind] || {};
                const globalConfig: ChatSoundConfig = globalSounds[kind] || {};
                const mode = soundModeOf(sounds[kind]);
                const globalOn = globalConfig.enabled === true && Boolean(globalConfig.value);
                return (
                    <div key={kind} className="chat-sound-block">
                        <div className="menu-item">
                            <span className="chat-info-icon" style={{ "--icon-color": accent } as CSSProperties}>
                                <Icon size={22} strokeWidth={1.75} />
                            </span>
                            <div className="menu-label-group">
                                <span className="menu-label">{label}</span>
                                <span className="menu-desc">
                                    {mode === "inherit"
                                        ? `Follows global (currently ${globalOn ? "on" : "off"})`
                                        : mode === "off"
                                            ? "This character plays no sound for this"
                                            : desc}
                                </span>
                            </div>
                            <div className="menu-right">
                                <div className="chat-sound-mode" role="group" aria-label={`${label} mode`}>
                                    {MODE_OPTIONS.map(([value, text]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            className={mode === value ? "is-active" : ""}
                                            onClick={() => setMode(kind, value)}
                                        >
                                            {text}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                        {mode === "custom" ? (
                            <div className="chat-sound-editor chat-sound-editor-session">
                                <ChatSoundSourceEditor
                                    config={own}
                                    emptyHint={globalConfig.value ? "Not set separately -- will use the global audio" : "No audio set"}
                                    canPreview={Boolean(own.value || globalConfig.value)}
                                    onPatch={patch => changeSound(kind, patch)}
                                    onPreview={() => void previewChatSound(kind, session)}
                                />
                                {kind === "newMessage" ? (
                                    <>
                                        <div className="chat-sound-subtoggles">
                                            <SubToggle
                                                label="No sound while live-chatting"
                                                desc="No sound plays for this character's new messages while that chat is open"
                                                checked={own.muteActiveChat ?? globalConfig.muteActiveChat ?? false}
                                                explicit={own.muteActiveChat !== undefined}
                                                onChange={checked => changeSound(kind, { muteActiveChat: checked })}
                                                onReset={() => clearSubToggle(kind, "muteActiveChat")}
                                            />
                                            <SubToggle
                                                label="Only notify once per burst"
                                                desc="Several messages in a row from this character play the sound only on the first one"
                                                checked={own.notifyOncePerBurst ?? globalConfig.notifyOncePerBurst ?? false}
                                                explicit={own.notifyOncePerBurst !== undefined}
                                                onChange={checked => changeSound(kind, { notifyOncePerBurst: checked })}
                                                onReset={() => clearSubToggle(kind, "notifyOncePerBurst")}
                                            />
                                        </div>
                                        {own.value || globalConfig.value ? (
                                            <div className="chat-sound-editor-row chat-sound-test-row">
                                                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={testNewMessageNotice}>
                                                    <BellRing size={14} /> Test Popup
                                                </button>
                                                <span className="chat-sound-source">Simulates a new message from this character: shows the notification banner and plays the sound</span>
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

/** New-message sound sub-toggle: shows the inherited global value when not set explicitly, with a one-click reset back to following global. */
function SubToggle({ label, desc, checked, explicit, onChange, onReset }: {
    label: string;
    desc: string;
    checked: boolean;
    explicit: boolean;
    onChange: (checked: boolean) => void;
    onReset: () => void;
}) {
    return (
        <div className="chat-sound-subtoggle">
            <div className="menu-label-group">
                <span className="menu-label">{label}</span>
                <span className="menu-desc">{desc}{explicit ? "" : " (following global)"}</span>
            </div>
            <div className="menu-right gap-2">
                {explicit ? (
                    <button type="button" className="chat-sound-subreset" onClick={onReset}>Follow global</button>
                ) : null}
                <Toggle checked={checked} onChange={onChange} />
            </div>
        </div>
    );
}
