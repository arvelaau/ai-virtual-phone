// lib/mixology/storage.ts
// House Special — local persistence: the cabinet (materials), blends and sessions, all
// through kv-db.
// The factory materials (base spirit / glassware) are NOT kept in the cabinet: they are
// read straight from the factory by id, so everyone has them and they are always current.
// They show on the materials page as official entries, and at the bar they sit alongside
// cabinet materials in the slot picker.

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type {
    MixMaterial,
    MixMaterialKind,
    MixRecipe,
    MixSession,
    MixSlotEntry,
} from "./types";
import { MIX_SLOT_ORDER, mixSlotEntries, normalizeMixSlots } from "./types";
import {
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
    createBuiltinBase,
    createBuiltinGlass,
} from "./builtin";

const CABINET_KEY = "mixology_cabinet_v1";
const RECIPES_KEY = "mixology_recipes_v1";
const SESSIONS_KEY = "mixology_sessions_v1";
// Vestigial: declared and registered for kv migration, but never read or written. Kept
// because it still participates in backup/restore. See the note in builtin.ts — the
// version-refresh mechanism this belonged to no longer exists.
const BUILTIN_VERSION_KEY = "mixology_builtin_version_v1";
const PROFILE_KEY = "mixology_profile_v1";

registerKvMigration(CABINET_KEY);
registerKvMigration(RECIPES_KEY);
registerKvMigration(SESSIONS_KEY);
registerKvMigration(BUILTIN_VERSION_KEY);
registerKvMigration(PROFILE_KEY);

/** Factory materials cannot be deleted or renamed (their content is always the current
 *  factory version) */
export const MIX_BUILTIN_IDS: readonly string[] = [
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
];

export function isMixBuiltinId(id: string): boolean {
    return MIX_BUILTIN_IDS.includes(id);
}

/** Read the factory materials straight from the factory: never persisted, rebuilt on every
 *  call, so they follow the source automatically */
export function listMixBuiltins(kind?: MixMaterialKind): MixMaterial[] {
    const factory: MixMaterial[] = [createBuiltinBase(), createBuiltinGlass()];
    return kind ? factory.filter((m) => m.kind === kind) : factory;
}

export function getMixBuiltin(id: string): MixMaterial | null {
    if (!isMixBuiltinId(id)) return null;
    return listMixBuiltins().find((m) => m.id === id) ?? null;
}

function readJson<T>(key: string, fallback: T): T {
    const raw = kvGet(key);
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return (parsed ?? fallback) as T;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    kvSet(key, JSON.stringify(value));
}

// ---------- Creator profile ----------

/** The credit and avatar used when publishing to the materials / recipes pages. Both are
 *  optional; with no name, the cloud falls back to the account's display name. */
export type MixProfile = {
    name?: string;
    /** Avatar dataURL (a compressed thumbnail) */
    avatar?: string;
};

export function loadMixProfile(): MixProfile {
    const stored = readJson<MixProfile>(PROFILE_KEY, {});
    if (!stored || typeof stored !== "object") return {};
    return {
        name: typeof stored.name === "string" && stored.name.trim() ? stored.name.trim() : undefined,
        avatar: typeof stored.avatar === "string" && stored.avatar ? stored.avatar : undefined,
    };
}

export function saveMixProfile(profile: MixProfile): void {
    writeJson(PROFILE_KEY, {
        name: profile.name?.trim() || undefined,
        avatar: profile.avatar || undefined,
    });
}

// ---------- Cabinet (materials) ----------

export function loadMixCabinet(): MixMaterial[] {
    const stored = readJson<MixMaterial[]>(CABINET_KEY, []);
    const list = Array.isArray(stored) ? stored : [];
    // Migration: an older version planted the factory materials into the cabinet. They are
    // now read from the factory and shown on the materials page, so strip them out here.
    const next = list.filter((m) => !isMixBuiltinId(m.id));
    if (next.length !== list.length) writeJson(CABINET_KEY, next);
    return next;
}

export function listMixMaterials(kind: MixMaterialKind): MixMaterial[] {
    return loadMixCabinet()
        .filter((m) => m.kind === kind)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Slot candidates for the bar and for a session: factory materials first, then the cabinet */
export function listMixPickables(kind: MixMaterialKind): MixMaterial[] {
    return [...listMixBuiltins(kind), ...listMixMaterials(kind)];
}

export function getMixMaterial(id: string): MixMaterial | null {
    return getMixBuiltin(id) ?? loadMixCabinet().find((m) => m.id === id) ?? null;
}

/** Add a material or replace it wholesale (a matching id overwrites) */
export function saveMixMaterial(material: MixMaterial): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === material.id);
    const stamped = { ...material, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(CABINET_KEY, list);
}

/**
 * Bookkeeping after a successful push to the cloud: record publishedId and align
 * publishedAt with the current updatedAt.
 * This cannot go through saveMixMaterial, which re-stamps updatedAt — the material would
 * then permanently read as "has unpublished changes".
 */
export function markMixMaterialSynced(id: string, publishedId: string): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], publishedId, publishedAt: list[idx].updatedAt };
    writeJson(CABINET_KEY, list);
}

/**
 * Look up a local material by its cloud entry id.
 * Used when pulling your own published work back down: if the cabinet already holds the
 * original tied to that cloud entry, reuse it rather than pulling a second copy and ending
 * up with two materials of the same name.
 */
export function findMixMaterialByPublishedId(cloudId: string): MixMaterial | null {
    return loadMixCabinet().find((m) => m.publishedId === cloudId) ?? null;
}

/** Drop the local publish link when the cloud entry has been taken down or lost, returning
 *  the material to the "not published" state */
export function clearMixMaterialPublished(id: string): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = list[idx];
    list[idx] = rest as MixMaterial;
    writeJson(CABINET_KEY, list);
}

/** Delete a material (factory materials refuse). Returns whether anything was deleted. */
export function deleteMixMaterial(id: string): boolean {
    if (isMixBuiltinId(id)) return false;
    const list = loadMixCabinet();
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    writeJson(CABINET_KEY, next);
    return true;
}

// ---------- Blends ----------

/** Early data put one material per slot and stored the slot as a bare material id;
 *  normalize to the current shape (an ordered list) on read */
function migrateRecipeSlots<T extends { slots?: unknown }>(item: T): T {
    return { ...item, slots: normalizeMixSlots(item.slots as never) };
}

export function loadMixRecipes(): MixRecipe[] {
    const stored = readJson<MixRecipe[]>(RECIPES_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .map(migrateRecipeSlots)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixRecipe(id: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.id === id) ?? null;
}

export function saveMixRecipe(recipe: MixRecipe): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === recipe.id);
    const stamped = { ...recipe, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(RECIPES_KEY, list);
}

export function deleteMixRecipe(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    writeJson(RECIPES_KEY, list.filter((r) => r.id !== id));
}

/** As markMixMaterialSynced: bookkeeping after a blend syncs to the cloud */
export function markMixRecipeSynced(id: string, publishedId: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], publishedId, publishedAt: list[idx].updatedAt };
    writeJson(RECIPES_KEY, list);
}

/** As findMixMaterialByPublishedId: look up a local blend by its cloud entry id */
export function findMixRecipeByPublishedId(cloudId: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.publishedId === cloudId) ?? null;
}

/** Drop the local publish link when a cloud blend entry has been taken down or lost */
export function clearMixRecipePublished(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = list[idx];
    list[idx] = rest as MixRecipe;
    writeJson(RECIPES_KEY, list);
}

/**
 * Find the local item by cloud entry id and drop its publish link. Called after a
 * successful unpublish from "My publications", so the "published" badge disappears from the
 * cabinet and blend lists immediately instead of waiting to hit a 404 on the next update.
 */
export function clearMixPublishedByCloudId(type: "material" | "recipe", cloudId: string): void {
    if (type === "material") {
        const material = loadMixCabinet().find((m) => m.publishedId === cloudId);
        if (material) clearMixMaterialPublished(material.id);
    } else {
        const recipe = readJson<MixRecipe[]>(RECIPES_KEY, []).find((r) => r.publishedId === cloudId);
        if (recipe) clearMixRecipePublished(recipe.id);
    }
}

// ---------- Sessions ----------

export function loadMixSessions(): MixSession[] {
    const stored = readJson<MixSession[]>(SESSIONS_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        // A session stores the blend as it was at the start, so it needs the same migration
        .map((session) => ({ ...session, recipe: migrateRecipeSlots(session.recipe) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixSession(id: string): MixSession | null {
    return loadMixSessions().find((s) => s.id === id) ?? null;
}

export function saveMixSession(session: MixSession): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const idx = list.findIndex((s) => s.id === session.id);
    const stamped = { ...session, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(SESSIONS_KEY, list);
}

export function deleteMixSession(id: string): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    writeJson(SESSIONS_KEY, list.filter((s) => s.id !== id));
}

/**
 * Resolve a blend's slots to real materials (factory materials come from the factory). One
 * slot may stack several, and all of them come back in order; anything that cannot be found
 * (the material was deleted) is skipped silently and recorded in `missing`.
 * Conditions are NOT evaluated here — those depend on the live session, so the engine tests
 * them one by one just before assembly.
 */
export function resolveMixRecipeMaterials(
    recipe: MixRecipe,
): {
    materials: Partial<Record<MixMaterialKind, MixMaterial[]>>;
    entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>>;
    missing: MixMaterialKind[];
} {
    const cabinet = loadMixCabinet();
    const materials: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
    const entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>> = {};
    const missing: MixMaterialKind[] = [];
    for (const kind of MIX_SLOT_ORDER) {
        const slotEntries = mixSlotEntries(recipe.slots, kind);
        if (!slotEntries.length) continue;
        const resolved: { entry: MixSlotEntry; material: MixMaterial }[] = [];
        for (const entry of slotEntries) {
            const found = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
            if (found && found.kind === kind) resolved.push({ entry, material: found });
            else if (!missing.includes(kind)) missing.push(kind);
        }
        if (resolved.length) {
            entries[kind] = resolved;
            materials[kind] = resolved.map((r) => r.material);
        }
    }
    return { materials, entries, missing };
}
