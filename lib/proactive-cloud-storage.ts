// lib/proactive-cloud-storage.ts
// Per-character opt-in flag for Proactive Message 2.0 cloud sync. See
// PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// Off by default for every character. This is the privacy gate: only an
// opted-in character's data (persona, memory, recent history, API key) is
// ever packaged and uploaded to the user's own Cloudflare account. Exposed
// in two places by design (confirmed with the user): a toggle inside that
// character's own chat settings panel (in-context, easy to find while
// chatting with them), and a summary list on the global Proactive Push
// settings page (so the whole opt-in surface can be audited from one place
// without opening every chat).

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const PROACTIVE_CLOUD_OPT_IN_KEY = "ai_phone_proactive_cloud_opt_in_v1";
registerKvMigration(PROACTIVE_CLOUD_OPT_IN_KEY);

type OptInMap = Record<string, boolean>;

function loadOptInMap(): OptInMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(PROACTIVE_CLOUD_OPT_IN_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const out: OptInMap = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (value === true) out[id] = true;
        }
        return out;
    } catch {
        return {};
    }
}

function saveOptInMap(map: OptInMap): void {
    if (typeof window === "undefined") return;
    kvSet(PROACTIVE_CLOUD_OPT_IN_KEY, JSON.stringify(map));
}

export function isProactiveCloudSyncEnabled(characterId: string): boolean {
    return loadOptInMap()[characterId] === true;
}

export function setProactiveCloudSyncEnabled(characterId: string, enabled: boolean): void {
    const map = loadOptInMap();
    if (enabled) {
        map[characterId] = true;
    } else {
        delete map[characterId];
    }
    saveOptInMap(map);
}

/** Every character currently opted in — for the settings-page audit list. */
export function getProactiveCloudSyncOptedInCharacterIds(): string[] {
    return Object.keys(loadOptInMap());
}
