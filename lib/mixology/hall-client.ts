"use client";

// House Special -- the menu/hall client, talking to /api/mixology/*.
// On a self-hosted deployment with no Supabase configured those routes answer 503 /
// setupRequired, and the interface simply treats the hall as not open yet -- the same way the
// game hall already behaves here.

import { loadMixProfile } from "./storage";
import type { MixCondition, MixMaterial, MixMaterialKind } from "./types";

/** publishedId/publishedAt are local bookkeeping and must not travel with the content to the
 *  cloud, where somebody else would inherit them */
function stripLocalOnly(material: MixMaterial): MixMaterial {
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = material;
    return rest as MixMaterial;
}

/** The creator identity sent when publishing or updating (editable from the cabinet header;
 *  an empty name falls back to the account's display name) */
function authorFields(): { authorName: string; authorAvatar: string } {
    const profile = loadMixProfile();
    return { authorName: profile.name ?? "", authorAvatar: profile.avatar ?? "" };
}

export type MixHallType = "material" | "recipe";

export type MixHallEntryBase = {
    id: string;
    name: string;
    authorId: string;
    authorName: string;
    authorAvatar: string;
    cover: string;
    likeCount: number;
    saveCount: number;
    viewCount: number;
    commentCount: number;
    likedByMe?: boolean;
    savedByMe?: boolean;
    createdAt: string;
    updatedAt: string;
};

export type MixHallMaterial = MixHallEntryBase & {
    kind: MixMaterialKind;
    hook: string;
    tags: string[];
    /** Detail endpoint only: the full material JSON */
    payload?: MixMaterial | null;
};

/**
 * One material inside a published blend: a reference only, with the material itself living as
 * its own entry on the materials page.
 * builtin = a factory material (everyone has it locally, so no cloud entry is created); any
 * other id is a materials-page entry id (mxi_).
 * gone / material / authorName are filled in by the detail endpoint via a join.
 */
export type MixHallRecipePart = {
    id: string;
    kind: MixMaterialKind;
    name: string;
    /** A factory material: resolved from the local factory version on import */
    builtin?: boolean;
    /** Filled in by the detail endpoint: the matching materials entry has been unpublished or
     *  does not exist */
    gone?: boolean;
    /** Filled in by the detail endpoint: the entry's full material content (its id is the entry id) */
    material?: MixMaterial | null;
    /** Filled in by the detail endpoint: this material's author */
    authorName?: string;
    authorAvatar?: string;
    /** The condition the author set for this one (omitted = always applies) */
    when?: MixCondition;
};

export type MixHallRecipe = MixHallEntryBase & {
    intro: string;
    charName: string;
    partNames: string[];
    /** Detail endpoint only: the slot references, with cloud materials already joined in */
    parts?: MixHallRecipePart[];
};

export type MixHallComment = {
    id: string;
    targetType: MixHallType;
    targetId: string;
    parentId?: string;
    authorId: string;
    authorName: string;
    content: string;
    createdAt: string;
};

type HallListResponse = { ok: boolean; entries?: unknown[]; setupRequired?: boolean; error?: string };
type HallEntryResponse = { ok: boolean; entry?: unknown; error?: string };
type HallReactionResponse = { ok: boolean; liked?: boolean; saved?: boolean; likeCount?: number; saveCount?: number; error?: string };
type HallCommentsResponse = { ok: boolean; comments?: MixHallComment[]; comment?: MixHallComment; deletedIds?: string[]; error?: string };

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(input, { ...init, credentials: "include", signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
            throw new Error(data?.error || `HTTP ${response.status}`);
        }
        return data as T;
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
            throw new Error("The request timed out. Please try again shortly.");
        }
        throw err;
    } finally {
        window.clearTimeout(timeout);
    }
}

// -- listing / detail --

export async function fetchHallMaterials(kind?: MixMaterialKind, mine?: boolean): Promise<{ entries: MixHallMaterial[]; setupRequired: boolean }> {
    const query = `${kind ? `&kind=${kind}` : ""}${mine ? "&mine=1" : ""}`;
    const data = await fetchJson<HallListResponse>(`/api/mixology/hall?type=material${query}`, { cache: "no-store" });
    return { entries: (data.entries ?? []) as MixHallMaterial[], setupRequired: Boolean(data.setupRequired) };
}

export async function fetchHallMaterial(id: string): Promise<MixHallMaterial> {
    const data = await fetchJson<HallEntryResponse>(`/api/mixology/hall?type=material&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!data.entry) throw new Error("Could not load the material's details");
    return data.entry as MixHallMaterial;
}

export async function fetchHallRecipes(mine?: boolean): Promise<{ entries: MixHallRecipe[]; setupRequired: boolean }> {
    const data = await fetchJson<HallListResponse>(`/api/mixology/hall?type=recipe${mine ? "&mine=1" : ""}`, { cache: "no-store" });
    return { entries: (data.entries ?? []) as MixHallRecipe[], setupRequired: Boolean(data.setupRequired) };
}

export async function fetchHallRecipe(id: string): Promise<MixHallRecipe> {
    const data = await fetchJson<HallEntryResponse>(`/api/mixology/hall?type=recipe&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!data.entry) throw new Error("Could not load the blend's details");
    return data.entry as MixHallRecipe;
}

// -- sharing --

export async function shareHallMaterial(material: MixMaterial): Promise<MixHallMaterial> {
    const data = await fetchJson<HallEntryResponse>("/api/mixology/hall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type: "material",
            kind: material.kind,
            name: material.name,
            hook: material.hook ?? "",
            cover: material.cover ?? "",
            tags: material.tags ?? [],
            payload: stripLocalOnly(material),
            ...authorFields(),
        }),
    });
    if (!data.entry) throw new Error("Sharing failed");
    return data.entry as MixHallMaterial;
}

/** Sharing a blend publishes the combination and its references; the material content itself
 *  comes from each entry on the materials page */
export type MixHallRecipeShareInput = {
    name: string;
    intro?: string;
    cover?: string;
    charName?: string;
    partNames: string[];
    parts: Array<Pick<MixHallRecipePart, "id" | "kind" | "name" | "builtin">>;
};

export async function shareHallRecipe(input: MixHallRecipeShareInput): Promise<MixHallRecipe> {
    const data = await fetchJson<HallEntryResponse>("/api/mixology/hall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "recipe", ...input, ...authorFields() }),
    });
    if (!data.entry) throw new Error("Sharing failed");
    return data.entry as MixHallRecipe;
}

/** Thrown when the published content has been taken down or is not yours, so the caller can
 *  clear the local publish link */
export class MixHallGoneError extends Error {}

async function putHall(body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch("/api/mixology/hall", {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
            if (data?.gone) throw new MixHallGoneError(data?.error || "This content has been taken down");
            throw new Error(data?.error || `HTTP ${response.status}`);
        }
        return (data as { entry?: unknown }).entry;
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw new Error("The request timed out. Please try again shortly.");
        throw err;
    } finally {
        window.clearTimeout(timeout);
    }
}

export async function updateHallMaterial(publishedId: string, material: MixMaterial): Promise<MixHallMaterial> {
    return await putHall({
        type: "material",
        id: publishedId,
        kind: material.kind,
        name: material.name,
        hook: material.hook ?? "",
        cover: material.cover ?? "",
        tags: material.tags ?? [],
        payload: stripLocalOnly(material),
        ...authorFields(),
    }) as MixHallMaterial;
}

export async function updateHallRecipe(publishedId: string, input: MixHallRecipeShareInput): Promise<MixHallRecipe> {
    return await putHall({
        type: "recipe",
        id: publishedId,
        ...input,
        ...authorFields(),
    }) as MixHallRecipe;
}

export async function removeHallEntry(type: MixHallType, id: string): Promise<void> {
    await fetchJson<{ ok: boolean }>("/api/mixology/hall", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id }),
    });
}

// -- social --

export async function toggleHallLike(type: MixHallType, id: string): Promise<{ liked: boolean; likeCount: number }> {
    const data = await fetchJson<HallReactionResponse>("/api/mixology/hall", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id, action: "toggle_like" }),
    });
    return { liked: Boolean(data.liked), likeCount: data.likeCount ?? 0 };
}

export async function markHallSaved(type: MixHallType, id: string): Promise<{ saveCount: number }> {
    const data = await fetchJson<HallReactionResponse>("/api/mixology/hall", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id, action: "save" }),
    });
    return { saveCount: data.saveCount ?? 0 };
}

export async function fetchHallComments(type: MixHallType, targetId: string): Promise<MixHallComment[]> {
    const data = await fetchJson<HallCommentsResponse>(
        `/api/mixology/comments?type=${type}&targetId=${encodeURIComponent(targetId)}`,
        { cache: "no-store" },
    );
    return data.comments ?? [];
}

export async function postHallComment(
    type: MixHallType,
    targetId: string,
    content: string,
    parentId?: string,
): Promise<MixHallComment> {
    const data = await fetchJson<HallCommentsResponse>("/api/mixology/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, targetId, content, parentId }),
    });
    if (!data.comment) throw new Error("Could not post the comment");
    return data.comment;
}

export async function deleteHallComment(commentId: string): Promise<string[]> {
    const data = await fetchJson<HallCommentsResponse>("/api/mixology/comments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentId }),
    });
    return data.deletedIds ?? [];
}
