"use client";

// Shared UI for sound settings: the sound-kind list + the audio-source editor (file / URL / preview / clear).
// Shared by two settings pages: Global Chat Info (global sounds) and a direct chat's own info page (character-specific sounds).

import { useRef, useState } from "react";
import { AudioLines, MessageSquare, PhoneIncoming, PhoneOff, PhoneOutgoing, Play, Send, X, type LucideIcon } from "lucide-react";
import type { ChatSoundConfig, ChatSoundKind } from "@/lib/chat-storage";
import { saveChatAudioToIndexedDB } from "@/lib/chat-asset-storage";

export const SOUND_ITEMS: {
    kind: ChatSoundKind;
    icon: LucideIcon;
    label: string;
    desc: string;
}[] = [
    { kind: "newMessage", icon: MessageSquare, label: "New Message Sound", desc: "Plays when the character sends a new message" },
    { kind: "sendMessage", icon: Send, label: "Send Message Sound", desc: "Plays when you send a message" },
    { kind: "incomingCall", icon: PhoneIncoming, label: "Incoming Call Sound", desc: "Loops while an incoming call is waiting to be answered" },
    { kind: "outgoingCall", icon: PhoneOutgoing, label: "Outgoing Call Sound", desc: "Loops while a call is waiting to connect" },
    { kind: "hangup", icon: PhoneOff, label: "Hangup Sound", desc: "Plays when a call ends or is hung up" },
];

/**
 * Audio-source editor: pick an audio file / enter an audio URL / preview / clear.
 * Only responsible for editing the config it's given; it doesn't care whether that config
 * lives on the global settings or on a session.
 */
export function ChatSoundSourceEditor({ config, emptyHint, canPreview, onPatch, onPreview }: {
    config: ChatSoundConfig;
    /** Hint text shown when no audio is set (defaults to "No audio set"; a session page can pass a hint saying it follows the global audio). */
    emptyHint?: string;
    /** Whether the preview button is enabled (defaults to judging from config.value; a session page can allow preview when the global config already has audio set). */
    canPreview?: boolean;
    onPatch: (patch: Partial<ChatSoundConfig>) => void;
    onPreview: () => void;
}) {
    const [urlDraft, setUrlDraft] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const changeFile = async (file?: File) => {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { alert("Audio file is too large -- keep it under 8MB"); return; }
        try {
            const id = await saveChatAudioToIndexedDB(file);
            onPatch({ sourceType: "file", value: id });
        } catch { alert("Failed to save the audio file -- try a different file"); }
    };

    const applyUrl = () => {
        const url = urlDraft.trim();
        if (!url) return;
        if (!/^(https?:\/\/|data:audio)/i.test(url)) { alert("Enter an audio link starting with http(s)"); return; }
        onPatch({ sourceType: "url", value: url });
    };

    const hasSource = Boolean(config.value);
    const previewEnabled = canPreview === undefined ? hasSource : canPreview;
    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac"
                className="hidden"
                onChange={event => { void changeFile(event.target.files?.[0]); event.target.value = ""; }}
            />
            <div className="chat-sound-editor-row">
                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={() => fileInputRef.current?.click()}>
                    <AudioLines size={14} /> Choose Audio File
                </button>
                <span className="chat-sound-source">
                    {config.sourceType === "file" ? "Using an audio file" : config.sourceType === "url" ? "Using an audio URL" : (emptyHint || "No audio set")}
                </span>
                <div className="chat-sound-editor-actions">
                    <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" disabled={!previewEnabled} onClick={onPreview} aria-label="Preview" title="Preview"><Play size={14} /></button>
                    {hasSource ? (
                        <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => onPatch({ sourceType: undefined, value: undefined })} aria-label="Clear audio" title="Clear audio"><X size={14} /></button>
                    ) : null}
                </div>
            </div>
            <div className="chat-sound-editor-row">
                <span className="chat-sound-or">or</span>
                <input
                    className="ui-input flex-1 h-8 ts-12"
                    placeholder="Enter an audio URL (mp3 / wav, etc.)"
                    value={urlDraft || (config.sourceType === "url" ? config.value || "" : "")}
                    onChange={event => setUrlDraft(event.target.value)}
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <button className="ui-btn ui-btn-soft-action" onClick={applyUrl}>Use</button>
            </div>
        </>
    );
}
