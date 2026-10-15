// lib/imessage-storage.ts
// Real-iMessage line-binding config persistence (browser-local).

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { IMessageLineBinding } from "./imessage-types";

const STORAGE_KEY = "imessage_lines_v1";
registerKvMigration(STORAGE_KEY);

export function loadIMessageLines(): IMessageLineBinding[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(STORAGE_KEY) : null;
        return raw ? (JSON.parse(raw) as IMessageLineBinding[]) : [];
    } catch {
        return [];
    }
}

function saveIMessageLines(lines: IMessageLineBinding[]): void {
    try {
        kvSet(STORAGE_KEY, JSON.stringify(lines));
    } catch { /* quota exceeded -- ignore */ }
}

export function addIMessageLine(line: Omit<IMessageLineBinding, "id" | "addedAt">): IMessageLineBinding {
    const newLine: IMessageLineBinding = {
        ...line,
        id: `imsgline_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        addedAt: new Date().toISOString(),
    };
    saveIMessageLines([...loadIMessageLines(), newLine]);
    return newLine;
}

export function updateIMessageLine(id: string, updates: Partial<Omit<IMessageLineBinding, "id" | "addedAt">>): void {
    const lines = loadIMessageLines();
    const idx = lines.findIndex(l => l.id === id);
    if (idx === -1) return;
    lines[idx] = { ...lines[idx], ...updates };
    saveIMessageLines(lines);
}

export function removeIMessageLine(id: string): void {
    saveIMessageLines(loadIMessageLines().filter(l => l.id !== id));
}

// ── what the app->iMessage mirror did, so a message that never arrived can be explained ──
const MIRROR_LOG_KEY = "imessage_mirror_log_v1";
const MIRROR_LOG_LIMIT = 15;
registerKvMigration(MIRROR_LOG_KEY);

export type IMessageMirrorLogEntry = {
    at: string;
    lineId: string;
    sent: boolean;
    /** A reason code (see describeMirrorOutcome in imessage-mirror.ts). */
    reason: string;
    /** Start of the message, for recognising it. */
    preview: string;
    /** What the server said, when it refused. */
    detail?: string;
};

export function loadIMessageMirrorLog(): IMessageMirrorLogEntry[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(MIRROR_LOG_KEY) : null;
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed as IMessageMirrorLogEntry[] : [];
    } catch {
        return [];
    }
}

export function recordIMessageMirror(entry: Omit<IMessageMirrorLogEntry, "at" | "preview"> & { text: string }): void {
    try {
        const { text, ...rest } = entry;
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 80);
        const next = [{ ...rest, at: new Date().toISOString(), preview }, ...loadIMessageMirrorLog()].slice(0, MIRROR_LOG_LIMIT);
        kvSet(MIRROR_LOG_KEY, JSON.stringify(next));
    } catch { /* a log must never break sending */ }
}
