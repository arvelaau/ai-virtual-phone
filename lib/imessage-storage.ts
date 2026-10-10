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
