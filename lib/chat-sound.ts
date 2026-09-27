"use client";

// Chat notification sounds: new message / send message / incoming call / outgoing call / hangup.
// Config priority: character-specific direct-chat sound (set on that chat's own info page)
// > global chat settings (ChatAppSettings.globalChatSounds).
// The audio source can be an uploaded file (IndexedDB asset) or an audio URL.

import { useEffect, useRef } from "react";
import {
    CHAT_MESSAGE_PUSHED_EVENT,
    findChatSessionById,
    getActiveChatSessionId,
    resolveChatSoundConfig,
    type ChatMessage,
    type ChatSession,
    type ChatSoundKind,
} from "./chat-storage";
import { getChatAudioFromIndexedDB } from "./chat-asset-storage";
import { isCallSystemContent } from "./call-tag-patterns";

/** Session context a sound resolution needs (just the `sounds` field). */
type SessionLike = Pick<ChatSession, "sounds"> | null | undefined;

// ── Audio source resolution ────────────────────────────────
// Every IndexedDB asset read opens the store, and a data URL can be sizeable: cache by asset id.

const dataUrlCache = new Map<string, string>();

async function resolveChatSoundSrc(kind: ChatSoundKind, session?: SessionLike): Promise<string | null> {
    const config = resolveChatSoundConfig(kind, session);
    if (!config.value) return null;
    if (config.sourceType === "url") return config.value;
    // Back-compat for older/hand-written configs: use a data: or http(s) address as-is.
    if (config.value.startsWith("data:") || /^https?:/i.test(config.value)) return config.value;
    const cached = dataUrlCache.get(config.value);
    if (cached) return cached;
    const dataUrl = await getChatAudioFromIndexedDB(config.value);
    if (!dataUrl) return null;
    dataUrlCache.set(config.value, dataUrl);
    return dataUrl;
}

/** Settings-page "preview": ignores the on/off toggle and plays as long as an audio source is configured (pass a session to preview that character's own sound). */
export async function previewChatSound(kind: ChatSoundKind, session?: SessionLike): Promise<void> {
    const src = await resolveChatSoundSrc(kind, session);
    if (!src) return;
    const audio = new Audio(src);
    audio.play().catch(() => { /* silently ignore if autoplay is blocked */ });
}

/** Plays a sound once (only if enabled and an audio source is configured; pass a session to prefer that character's own config). */
export async function playChatSoundOnce(kind: ChatSoundKind, session?: SessionLike): Promise<void> {
    const config = resolveChatSoundConfig(kind, session);
    if (!config.enabled || !config.value) return;
    const src = await resolveChatSoundSrc(kind, session);
    if (!src) return;
    const audio = new Audio(src);
    audio.play().catch(() => { /* silently ignore if autoplay is blocked */ });
}

// ── Looping ringtone (incoming/outgoing call waiting) ────────────────────────────────
// Only one loop is kept alive at a time: switching between the call banner and the call screen
// lets whichever started later take over from the earlier one; the stop function carries a
// token so it only ever stops the loop it itself started, never a later one.

type ActiveSoundLoop = { audio: HTMLAudioElement; token: object };
let activeSoundLoop: ActiveSoundLoop | null = null;
let soundLoopSeq = 0;

function stopActiveSoundLoop(): void {
    if (!activeSoundLoop) return;
    activeSoundLoop.audio.pause();
    activeSoundLoop = null;
}

/** Loops a sound (e.g. a ringtone); returns a stop function. Pass a session to prefer that character's own config. */
export function startChatSoundLoop(kind: ChatSoundKind, session?: SessionLike): () => void {
    const config = resolveChatSoundConfig(kind, session);
    if (!config.enabled || !config.value) return () => {};
    let cancelled = false;
    const token = {};
    const mySeq = ++soundLoopSeq;
    void resolveChatSoundSrc(kind, session).then(src => {
        if (cancelled || !src) return;
        // If async resolution finishes out of order, only the most-recently-started loop counts.
        if (mySeq !== soundLoopSeq) return;
        stopActiveSoundLoop();
        const audio = new Audio(src);
        audio.loop = true;
        activeSoundLoop = { audio, token };
        audio.play().catch(() => { /* silently ignore if autoplay is blocked */ });
    });
    return () => {
        cancelled = true;
        if (activeSoundLoop?.token === token) stopActiveSoundLoop();
    };
}

// ── Call-screen sound hook (ringtone / outgoing-wait tone / hangup sound) ──────────────

/**
 * Shared entry point for the call screens (voice/video/group):
 * - CONNECTING and the other party initiated -> loop the incoming-call ringtone; you initiated
 *   -> loop the outgoing-wait tone.
 * - callState becomes ENDED -> play the hangup sound right away; exiting without ever reaching
 *   ENDED (decline, back, switch session) plays it on unmount instead.
 * Passing a session prefers that character's own sound config.
 */
export function useCallScreenSounds(opts: { initiator: "user" | "character"; callState: string; session?: SessionLike }): void {
    const hangupPlayedRef = useRef(false);
    // React strict mode (dev) does a fake unmount right at mount: an unmount within 300ms is not
    // treated as a real exit.
    const realMountRef = useRef(false);
    // The session object's reference may change during the call (message-preview refreshes,
    // etc.): read the latest config through a ref, kept out of the effect deps, so the ringtone
    // doesn't restart just because that reference changed.
    const sessionRef = useRef(opts.session);
    sessionRef.current = opts.session;

    useEffect(() => {
        if (opts.callState !== "CONNECTING") return;
        return startChatSoundLoop(opts.initiator === "character" ? "incomingCall" : "outgoingCall", sessionRef.current);
    }, [opts.callState, opts.initiator]);

    useEffect(() => {
        if (opts.callState === "ENDED" && !hangupPlayedRef.current) {
            hangupPlayedRef.current = true;
            void playChatSoundOnce("hangup", sessionRef.current);
        }
    }, [opts.callState]);

    useEffect(() => {
        const timer = setTimeout(() => { realMountRef.current = true; }, 300);
        return () => {
            clearTimeout(timer);
            if (realMountRef.current && !hangupPlayedRef.current) {
                hangupPlayedRef.current = true;
                void playChatSoundOnce("hangup", sessionRef.current);
            }
        };
    }, []);
}

// ── New-message / send-message sound listener ────────────────────────────────

// Assistant message kinds that must never trigger the new-message sound: internal tool-flow
// bookkeeping, the meeting-invite card, system instructions, group-admin notices, etc. (kept
// consistent with what the unread counter itself excludes).
const SILENT_ASSISTANT_MEDIA_TYPES = new Set([
    "tool_call",
    "tool_result",
    "tool_notice",
    "memory_write_request",
    "voice_call",
    "video_call",
    "system_instruction",
    "group_admin_notice",
]);

// Message sources with their own separate context, outside the chat app -- no chat sound plays for these.
const SILENT_ORIGINS = new Set(["reading_discuss", "story_floating_phone"]);

// The session currently open in the desktop mini chat window: counts as "actively chatting" too when "no sound while live-chatting" is on.
let miniChatSoundSessionId: string | null = null;

/** Maintained by the desktop shell: the session currently open in the mini chat window (pass null when it's closed). */
export function setMiniChatSoundSessionId(sessionId: string | null): void {
    miniChatSoundSessionId = sessionId;
}

function isSessionBeingWatched(sessionId: string): boolean {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
    return getActiveChatSessionId() === sessionId || miniChatSoundSessionId === sessionId;
}

// "Only notify once for several messages in a row": several consecutive messages from the same
// character within this window play the sound only once.
const BURST_NOTIFY_WINDOW_MS = 10_000;
const burstLastSoundAt = new Map<string, number>();

function getBurstKey(msg: ChatMessage): string {
    // Deduped by character in group chats; a direct-chat character message with no senderCharacterId is deduped by session instead.
    return msg.senderCharacterId || msg.sessionId;
}

/** Exported for the fixture; the module-private burst/watch state it reads is still exercised for real. */
export function shouldPlayNewMessageSound(msg: ChatMessage, muteActiveChat: boolean, notifyOnce: boolean): boolean {
    if (SILENT_ASSISTANT_MEDIA_TYPES.has(msg.mediaType || "")) return false;
    if (msg.origin && SILENT_ORIGINS.has(msg.origin)) return false;
    if (isCallSystemContent(msg.content)) return false;
    // A bubble that's purely a status-panel carrier (no text, no media) doesn't count as a "new message".
    if (!msg.content.trim() && !msg.mediaType) return false;
    // "No sound while live-chatting": muted while that chat is open (main chat room or the desktop mini window) and the page is visible.
    if (muteActiveChat && isSessionBeingWatched(msg.sessionId)) return false;
    if (notifyOnce) {
        const key = getBurstKey(msg);
        const last = burstLastSoundAt.get(key) ?? 0;
        if (Date.now() - last < BURST_NOTIFY_WINDOW_MS) return false;
    }
    return true;
}

/** Exported for the fixture. */
export function markBurstPlayed(msg: ChatMessage): void {
    burstLastSoundAt.set(getBurstKey(msg), Date.now());
}

/**
 * Installs the global chat-message sound listener (new-message + send-message sounds).
 * Each message resolves its config through its own session: that character's own config
 * (set on its direct-chat info page) beats the global chat settings.
 * Mount once on a persistent shell component; returns the teardown function.
 */
export function installChatSoundListener(): () => void {
    if (typeof window === "undefined") return () => {};

    const onPushed = (e: Event) => {
        const detail = (e as CustomEvent<{ message?: ChatMessage }>).detail;
        const msg = detail?.message;
        if (!msg) return; // Events with no message body (e.g. an import) play nothing.

        if (msg.role === "user") {
            // Send-message sound: plays when a user message is stored; skip system messages written by a call screen.
            if (msg.origin && SILENT_ORIGINS.has(msg.origin)) return;
            if (isCallSystemContent(msg.content)) return;
            void playChatSoundOnce("sendMessage", findChatSessionById(msg.sessionId));
            return;
        }

        if (msg.role === "assistant") {
            const session = findChatSessionById(msg.sessionId);
            const config = resolveChatSoundConfig("newMessage", session);
            if (!config.enabled || !config.value) return;
            if (!shouldPlayNewMessageSound(msg, config.muteActiveChat === true, config.notifyOncePerBurst === true)) return;
            markBurstPlayed(msg);
            void playChatSoundOnce("newMessage", session);
        }
    };

    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, onPushed);
    return () => window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, onPushed);
}
