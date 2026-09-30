// Voice/video incoming-call vibration: vibrates in a loop while a call is waiting to be
// answered, in place of a ringtone (the app never makes sound for it). Toggled from the chat
// home page's "Incoming call vibration" setting, on by default. iOS Safari does not support the
// Vibration API, so this module automatically degrades to a no-op -- callers don't need to care
// about the platform.

import { loadChatAppSettings } from "@/lib/chat-storage";

// One "buzz-buzz" pulse mimicking an incoming-call rhythm; repeats after the gap until stopped.
const PULSE_PATTERN = [500, 250, 500, 1400];
const PULSE_TOTAL = PULSE_PATTERN.reduce((sum, ms) => sum + ms, 0);

export function isCallVibrationEnabled(): boolean {
    return loadChatAppSettings().callVibrationEnabled !== false;
}

function vibrationSupported(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/**
 * Starts the incoming-call vibration loop and returns a function that stops it. Returns a
 * no-op when the setting is off or the platform doesn't support it.
 * The caller starts this while in the "waiting to be answered" state, and calls the returned
 * function to stop on answer/hangup/unmount.
 */
export function startIncomingCallVibration(): () => void {
    if (!vibrationSupported() || !isCallVibrationEnabled()) return () => {};
    try { navigator.vibrate(PULSE_PATTERN); } catch { return () => {}; }
    const timer = window.setInterval(() => {
        try { navigator.vibrate(PULSE_PATTERN); } catch { /* ignore */ }
    }, PULSE_TOTAL);
    return () => {
        window.clearInterval(timer);
        try { navigator.vibrate(0); } catch { /* ignore */ }
    };
}
