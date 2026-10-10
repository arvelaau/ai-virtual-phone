// Standalone config for "auto-trigger a reply when the keyboard is dismissed".
// Deliberately not folded into settings-storage: the whole feature is this new file
// plus a handful of pure insertions elsewhere, independent of the main settings file,
// and behaves identically to the original when fully switched off.
//
// Both the toggle and the wait duration are stored per chat window (sessionId): the
// settings page is already scoped to a single chat, so "flip it here, it only applies
// to this chat" and "on for this character, off for that one" fall out naturally.
const CONFIG_KEY = "float_keyboard_auto_send_v1";

export interface KeyboardAutoSendConfig {
    /** Per-session toggle. Default = off (no change to any existing behavior). key = sessionId. */
    sessionEnabled: Record<string, boolean>;
    /** Per-session wait duration (ms). Falls back to DEFAULT_DEBOUNCE_MS. key = sessionId. */
    sessionDebounceMs: Record<string, number>;
}

export const MIN_AUTO_SEND_DEBOUNCE_MS = 0;
export const MAX_AUTO_SEND_DEBOUNCE_MS = 30_000;
export const DEFAULT_DEBOUNCE_MS = 1000;

const DEFAULT_CONFIG: KeyboardAutoSendConfig = {
    sessionEnabled: {},
    sessionDebounceMs: {},
};

export function normalizeDebounceMs(value: unknown, fallback = DEFAULT_DEBOUNCE_MS): number {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(MIN_AUTO_SEND_DEBOUNCE_MS, Math.min(MAX_AUTO_SEND_DEBOUNCE_MS, Math.round(raw)));
}

export function loadKeyboardAutoSendConfig(): KeyboardAutoSendConfig {
    if (typeof window === "undefined") return { sessionEnabled: {}, sessionDebounceMs: {} };
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return { sessionEnabled: {}, sessionDebounceMs: {} };
        const saved = JSON.parse(raw) as Partial<KeyboardAutoSendConfig>;
        const enabledMap: Record<string, boolean> = {};
        if (saved.sessionEnabled && typeof saved.sessionEnabled === "object") {
            for (const [key, value] of Object.entries(saved.sessionEnabled)) {
                if (typeof value === "boolean") enabledMap[key] = value;
            }
        }
        const debounceMap: Record<string, number> = {};
        if (saved.sessionDebounceMs && typeof saved.sessionDebounceMs === "object") {
            for (const [key, value] of Object.entries(saved.sessionDebounceMs)) {
                const ms = Number(value);
                if (Number.isFinite(ms)) debounceMap[key] = normalizeDebounceMs(ms);
            }
        }
        return { sessionEnabled: enabledMap, sessionDebounceMs: debounceMap };
    } catch {
        return { sessionEnabled: {}, sessionDebounceMs: {} };
    }
}

function saveConfig(config: KeyboardAutoSendConfig): void {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* ignore */ }
}

/** Whether this session has keyboard-dismiss auto-trigger enabled (default off). */
export function isKeyboardAutoSendEnabled(sessionId: string): boolean {
    return loadKeyboardAutoSendConfig().sessionEnabled[sessionId] === true;
}

export function setSessionKeyboardAutoSendEnabled(sessionId: string, enabled: boolean): void {
    const config = loadKeyboardAutoSendConfig();
    const enabledMap = { ...config.sessionEnabled };
    if (enabled) enabledMap[sessionId] = true;
    else delete enabledMap[sessionId];
    saveConfig({ ...config, sessionEnabled: enabledMap });
}

/** The wait duration in effect for this session: the stored value, or the 1-second default. */
export function getKeyboardAutoSendDebounceMs(sessionId?: string): number {
    const config = loadKeyboardAutoSendConfig();
    if (sessionId && sessionId in config.sessionDebounceMs) {
        return config.sessionDebounceMs[sessionId];
    }
    return DEFAULT_DEBOUNCE_MS;
}

/** Writes this session's wait duration; pass null to clear it and fall back to the default. */
export function setSessionKeyboardAutoSendDebounce(sessionId: string, ms: number | null): void {
    const config = loadKeyboardAutoSendConfig();
    const debounceMap = { ...config.sessionDebounceMs };
    if (ms === null) {
        delete debounceMap[sessionId];
    } else {
        debounceMap[sessionId] = normalizeDebounceMs(ms);
    }
    saveConfig({ ...config, sessionDebounceMs: debounceMap });
}
