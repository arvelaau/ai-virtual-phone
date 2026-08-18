"use client";

// House Special -- the online materials page and blends page:
// a two-column masonry grid / wide-card list, plus a detail sheet (save to cabinet, like,
// threaded comments).
// With no backend configured (a self-hosted deployment) or the tables not yet created, both
// are simply treated as "not open yet" and nothing about local play is disturbed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Heart, Inbox, Loader2, Pencil, Trash2, Wine, X } from "lucide-react";
import { fetchCurrentAccount } from "@/lib/account-client";
import {
    deleteHallComment,
    fetchHallComments,
    fetchHallMaterial,
    fetchHallMaterials,
    fetchHallRecipe,
    fetchHallRecipes,
    markHallSaved,
    postHallComment,
    removeHallEntry,
    toggleHallLike,
    type MixHallComment,
    type MixHallMaterial,
    type MixHallRecipe,
    type MixHallRecipePart,
    type MixHallType,
} from "@/lib/mixology/hall-client";
import {
    clearMixPublishedByCloudId,
    findMixMaterialByPublishedId,
    findMixRecipeByPublishedId,
    getMixMaterial,
    listMixBuiltins,
    markMixMaterialSynced,
    markMixRecipeSynced,
    saveMixMaterial,
    saveMixRecipe,
} from "@/lib/mixology/storage";
import {
    MIX_KIND_LABELS,
    mixKindHasCover,
    type MixCharacterCard,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    MIX_SLOT_MAX,
    mixKindRunsActiveCode,
    type MixCondition,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { AuthorAvatar, MatCard, MaterialDetail, MixConfirm, MixTagList, SealedNote } from "./mixology-shared";

type HallMode = "menu" | "hall";

function statsLine(entry: { likeCount: number; saveCount: number; commentCount: number }): string {
    return `\u2665 ${entry.likeCount} \u00b7 ${entry.saveCount} saved \u00b7 ${entry.commentCount} comments`;
}


// -- Comments, threaded --
// Used by the material and blend detail sheets, and exported for the cabinet detail view too,
// so a local material carrying a publishedId (or an imported one) shows the same thread.

export function CommentThread({
    type,
    targetId,
    myId,
    onToast,
    onCountChange,
    requestConfirm,
}: {
    type: MixHallType;
    targetId: string;
    myId: string;
    onToast: (message: string) => void;
    onCountChange: (delta: number) => void;
    requestConfirm: (payload: { title: string; body?: ReactNode; confirmText: string; tone?: "danger"; run: () => void }) => void;
}) {
    const [comments, setComments] = useState<MixHallComment[]>([]);
    const [loading, setLoading] = useState(true);
    const [input, setInput] = useState("");
    const [replyTo, setReplyTo] = useState<MixHallComment | null>(null);
    const [busy, setBusy] = useState(false);
    const [deletingIds, setDeletingIds] = useState<string[]>([]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchHallComments(type, targetId)
            .then((list) => { if (!cancelled) setComments(list); })
            .catch(() => { /* a failed comment load must not break the detail sheet */ })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [type, targetId]);

    const handlePost = async () => {
        const content = input.trim();
        if (!content || busy) return;
        setBusy(true);
        try {
            const comment = await postHallComment(type, targetId, content, replyTo?.id);
            setComments((prev) => [...prev, comment]);
            setInput("");
            setReplyTo(null);
            onCountChange(1);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Could not post the comment");
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (comment: MixHallComment) => {
        setDeletingIds((prev) => [...prev, comment.id]);
        try {
            const deletedIds = await deleteHallComment(comment.id);
            setComments((prev) => prev.filter((c) => !deletedIds.includes(c.id)));
            onCountChange(-deletedIds.length);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Delete failed");
        } finally {
            setDeletingIds((prev) => prev.filter((id) => id !== comment.id));
        }
    };

    const onConfirmDelete = (comment: MixHallComment) => {
        const hasReplies = comments.some((c) => c.parentId === comment.id);
        requestConfirm({
            title: "Delete this comment?",
            body: hasReplies ? <>The replies underneath it will be deleted too.</> : undefined,
            confirmText: "Delete",
            tone: "danger",
            run: () => void handleDelete(comment),
        });
    };

    const topLevel = comments.filter((c) => !c.parentId);
    const childrenOf = (id: string) => comments.filter((c) => c.parentId === id);
    const nameOf = (id?: string) => comments.find((c) => c.id === id)?.authorName;

    const renderComment = (comment: MixHallComment, depth: number) => {
        const deleting = deletingIds.includes(comment.id);
        return (
            <div className="mix-comment" data-depth={depth > 0 ? "1" : undefined} data-deleting={deleting ? "true" : undefined} key={comment.id}>
                <div className="mix-comment-head">
                    <span className="mix-comment-author">{comment.authorName}</span>
                    {depth > 0 && comment.parentId && nameOf(comment.parentId) ? (
                        <span className="mix-comment-replyto">replying to {nameOf(comment.parentId)}</span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <button type="button" className="mix-comment-op" onClick={() => setReplyTo(comment)} disabled={deleting}>Reply</button>
                    {comment.authorId === myId ? (
                        <button type="button" className="mix-comment-op" onClick={() => onConfirmDelete(comment)} disabled={deleting}>
                            {deleting ? <><Loader2 size={11} className="mix-spin" />Deleting</> : "Delete"}
                        </button>
                    ) : null}
                </div>
                <div className="mix-comment-content">{comment.content}</div>
                {childrenOf(comment.id).map((child) => renderComment(child, depth + 1))}
            </div>
        );
    };

    return (
        <div className="mix-comments">
            <div className="mix-detail-label" style={{ marginTop: 16 }}>Comments{comments.length ? ` \u00b7 ${comments.length}` : ""}</div>
            {loading ? (
                <div className="mix-comment-empty mix-loading-inline"><Loader2 size={14} className="mix-spin" />Loading comments…</div>
            ) : topLevel.length === 0 ? (
                <div className="mix-comment-empty">No comments yet &mdash; pull up a stool?</div>
            ) : (
                topLevel.map((comment) => renderComment(comment, 0))
            )}
            {replyTo ? (
                <div className="mix-comment-replying">
                    Replying to {replyTo.authorName}
                    <button type="button" className="mix-comment-op" onClick={() => setReplyTo(null)}>Cancel</button>
                </div>
            ) : null}
            <div className="mix-comment-inputrow">
                <input
                    className="mix-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handlePost(); }}
                    placeholder={replyTo ? `Reply to ${replyTo.authorName}…` : "Say something…"}
                    disabled={busy}
                />
                <button type="button" className="mix-pill-btn" onClick={() => void handlePost()} disabled={busy || !input.trim()}>
                    {busy ? <><Loader2 size={13} className="mix-spin" />Sending</> : "Send"}
                </button>
            </div>
        </div>
    );
}

// -- main component --

export function MixologyHall({
    mode,
    kind = "character",
    scope = "all",
    onToast,
    onImported,
    reloadToken = 0,
    onLoadingChange,
    onEditLocal,
}: {
    mode: HallMode;
    /** The materials page's current tag, driven by the shell's fixed tag row (menu mode) */
    kind?: MixMaterialKind;
    /** Hall (everything) vs my publications, driven by the header toggle */
    scope?: "all" | "mine";
    onToast: (message: string) => void;
    onImported: () => void;
    /** The parent's manual refresh token: any change to the number refetches */
    reloadToken?: number;
    /** Report fetch state back to the parent, which spins the header's refresh icon */
    onLoadingChange?: (loading: boolean) => void;
    /** Edit on your own published work: it has been pulled back locally, so ask the shell to
     *  jump to the cabinet and open this one's editor */
    onEditLocal?: (materialId: string) => void;
}) {
    const [materials, setMaterials] = useState<MixHallMaterial[]>([]);
    const [recipes, setRecipes] = useState<MixHallRecipe[]>([]);
    const [loading, setLoading] = useState(true);
    const [notReady, setNotReady] = useState<string | null>(null);
    const [detailMaterial, setDetailMaterial] = useState<MixHallMaterial | null>(null);
    const [detailRecipe, setDetailRecipe] = useState<MixHallRecipe | null>(null);
    // Factory material details, read locally and never from the cloud
    const [officialDetail, setOfficialDetail] = useState<MixMaterial | null>(null);
    const [busy, setBusy] = useState(false);
    const [likePending, setLikePending] = useState<string[]>([]);
    const [myId, setMyId] = useState("");
    // Sheet host: .mix-body is the scroll container (position:relative), so a sheet left inside
    // it anchors inset:0 to the SCROLL coordinate system -- once the list has scrolled, the
    // dialog no longer sits flush. Portal it to the app root instead.
    const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setOverlayHost(document.querySelector<HTMLElement>(".mixology-app")); }, []);
    const inOverlay = (node: ReactNode) => (overlayHost ? createPortal(node, overlayHost) : null);
    const [confirm, setConfirm] = useState<{
        title: string;
        body?: ReactNode;
        confirmText: string;
        tone?: "danger";
        run: () => void;
    } | null>(null);
    const mountedRef = useRef(true);
    // In-session cache of fetched listings (key = mode:kind:scope), so moving back and forth
    // between tags and scopes does not refetch. Invalidated wholesale by the header refresh
    // (reloadToken changing) or by an unpublish.
    const listCacheRef = useRef(new Map<string, { materials: MixHallMaterial[]; recipes: MixHallRecipe[]; notReady: string | null }>());
    const lastReloadRef = useRef(reloadToken);

    useEffect(() => {
        mountedRef.current = true;
        void fetchCurrentAccount()
            .then((res) => { if (mountedRef.current && res.account) setMyId(res.account.id); })
            .catch(() => { /* signed out, or self-hosted: browse anonymously */ });
        return () => { mountedRef.current = false; };
    }, []);

    const load = useCallback(async () => {
        if (lastReloadRef.current !== reloadToken) {
            listCacheRef.current.clear();
            lastReloadRef.current = reloadToken;
        }
        const cacheKey = `${mode}:${kind}:${scope}`;
        const cached = listCacheRef.current.get(cacheKey);
        if (cached) {
            setMaterials(cached.materials);
            setRecipes(cached.recipes);
            setNotReady(cached.notReady);
            setLoading(false);
            return;
        }
        setLoading(true);
        setNotReady(null);
        try {
            if (mode === "menu") {
                const { entries, setupRequired } = await fetchHallMaterials(kind, scope === "mine");
                if (!mountedRef.current) return;
                const notReadyText = setupRequired ? "The materials page is not open yet (the sharing tables have not been created)." : null;
                setMaterials(entries);
                if (notReadyText) setNotReady(notReadyText);
                listCacheRef.current.set(cacheKey, { materials: entries, recipes: [], notReady: notReadyText });
            } else {
                const { entries, setupRequired } = await fetchHallRecipes(scope === "mine");
                if (!mountedRef.current) return;
                const notReadyText = setupRequired ? "The blends page is not open yet (the sharing tables have not been created)." : null;
                setRecipes(entries);
                if (notReadyText) setNotReady(notReadyText);
                listCacheRef.current.set(cacheKey, { materials: [], recipes: entries, notReady: notReadyText });
            }
        } catch (error) {
            if (!mountedRef.current) return;
            const message = error instanceof Error ? error.message : "Cannot reach the back room right now.";
            const permanent = /missing_supabase_env/.test(message);
            const text = permanent ? "The materials and blends pages only run on the official site \u2014 a local deployment has no networked backend." : message;
            setNotReady(text);
            // Having no backend is permanent for the session, so cache it and a self-hosted
            // deployment stops re-hitting it on every tag change. A transient network error is
            // not cached, so the next switch retries automatically.
            if (permanent) listCacheRef.current.set(cacheKey, { materials: [], recipes: [], notReady: text });
        } finally {
            if (mountedRef.current) setLoading(false);
        }
        // reloadToken is only a trigger; its value never takes part in the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, kind, scope, reloadToken]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => { onLoadingChange?.(loading); }, [loading, onLoadingChange]);

    const patchEntry = (type: MixHallType, id: string, patch: Record<string, unknown>) => {
        if (type === "material") {
            setMaterials((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            setDetailMaterial((prev) => (prev?.id === id ? { ...prev, ...patch } as MixHallMaterial : prev));
        } else {
            setRecipes((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            setDetailRecipe((prev) => (prev?.id === id ? { ...prev, ...patch } as MixHallRecipe : prev));
        }
        // Write through the session cache, so a changed like/save/comment count does not revert
        // when you leave the tag and come back
        for (const cached of listCacheRef.current.values()) {
            if (type === "material") cached.materials = cached.materials.map((e) => (e.id === id ? { ...e, ...patch } as MixHallMaterial : e));
            else cached.recipes = cached.recipes.map((e) => (e.id === id ? { ...e, ...patch } as MixHallRecipe : e));
        }
    };

    const handleLike = async (type: MixHallType, id: string) => {
        const key = `${type}:${id}`;
        if (likePending.includes(key)) return;
        setLikePending((prev) => [...prev, key]);
        try {
            const { liked, likeCount } = await toggleHallLike(type, id);
            patchEntry(type, id, { likedByMe: liked, likeCount });
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Could not like this");
        } finally {
            setLikePending((prev) => prev.filter((k) => k !== key));
        }
    };

    const openMaterial = async (entry: MixHallMaterial) => {
        setDetailMaterial({ ...entry, payload: undefined });
        try {
            const full = await fetchHallMaterial(entry.id);
            setDetailMaterial((prev) => (prev?.id === entry.id ? full : prev));
        } catch (error) {
            setDetailMaterial(null);
            onToast(error instanceof Error ? error.message : "Could not load the details");
        }
    };

    const openRecipe = async (entry: MixHallRecipe) => {
        setDetailRecipe({ ...entry, parts: undefined });
        try {
            const full = await fetchHallRecipe(entry.id);
            setDetailRecipe((prev) => (prev?.id === entry.id ? full : prev));
        } catch (error) {
            setDetailRecipe(null);
            onToast(error instanceof Error ? error.message : "Could not load the details");
        }
    };

    /**
     * Pull your own published material back down locally.
     * The point is that WHAT COMES BACK IS YOUR OWN WORK, not somebody else's copy: it is not
     * marked imported and its publishedId is reconnected, so edit / export / update-listing all
     * keep working, and pressing update after an edit overwrites the same cloud entry rather
     * than publishing a second one.
     * Returns the local id, so the caller can open the editor on it.
     */
    const pullBackMaterial = (entry: MixHallMaterial): string | null => {
        const payload = entry.payload as MixMaterial | null | undefined;
        if (!payload) return null;
        // The cabinet already holds the original tied to this cloud entry: use that one rather
        // than pulling down a second material of the same name
        const linked = findMixMaterialByPublishedId(entry.id);
        if (linked) return linked.id;
        // Otherwise store it under the cloud entry's id. Using the entry id rather than a fresh
        // local one makes this step repeatable: a copy saved earlier as "somebody else's work"
        // (imported, with the entry id) is corrected in place, and any blend referencing that id
        // does not lose its link.
        const { publishedId: _p, publishedAt: _a, author: _au, authorAvatar: _av, imported: _i, ...rest } = payload;
        saveMixMaterial({ ...rest, id: entry.id } as MixMaterial);
        // saveMixMaterial re-stamps updatedAt, so realign publishedAt here -- otherwise something
        // just pulled back down immediately reads as having unpublished changes
        markMixMaterialSynced(entry.id, entry.id);
        return entry.id;
    };

    const importMaterial = async (entry: MixHallMaterial) => {
        if (!entry.payload || busy) return;
        // Your own publication takes the pull-back path, not the save path: saving would turn it
        // into somebody else's work and it could never be edited again
        if (myId && entry.authorId === myId) {
            const localId = pullBackMaterial(entry);
            if (!localId) return;
            onImported();
            onToast(`"${entry.name}" is back in your cabinet and ready to edit.`);
            return;
        }
        setBusy(true);
        try {
            const { saveCount } = await markHallSaved("material", entry.id);
            const { publishedId: _p, publishedAt: _a, ...rest } = entry.payload as MixMaterial;
            const material = { ...rest, id: entry.id, author: entry.authorName, authorAvatar: entry.authorAvatar || undefined, imported: true } as MixMaterial;
            saveMixMaterial(material);
            patchEntry("material", entry.id, { savedByMe: true, saveCount });
            onImported();
            onToast(`"${entry.name}" saved to your cabinet.`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Could not save it");
        } finally {
            setBusy(false);
        }
    };

    /** Edit: pull your own work back down first, then ask the shell to open the cabinet editor */
    const editOwnMaterial = async (entry: MixHallMaterial) => {
        if (busy) return;
        setBusy(true);
        try {
            // A listing row has no payload and only the detail response does. This is reached from
            // the detail sheet, but guard anyway.
            const full = entry.payload ? entry : await fetchHallMaterial(entry.id);
            const localId = pullBackMaterial(full);
            if (!localId) { onToast("Could not retrieve this material's content."); return; }
            onImported();
            setDetailMaterial(null);
            onEditLocal?.(localId);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Could not retrieve it");
        } finally {
            setBusy(false);
        }
    };

    /** Import a blend with its materials: cloud materials are stored under their entry id (the
     *  same identity the materials page uses), factory materials use the local factory version,
     *  and anything unpublished is skipped */
    const importRecipe = async (entry: MixHallRecipe) => {
        if (!entry.parts?.length || busy) return;
        const characterPart = entry.parts.find((p) => p.kind === "character");
        if (!characterPart || characterPart.gone || (!characterPart.builtin && !characterPart.material)) {
            onToast("The character card has been taken down, so this blend cannot be imported.");
            return;
        }
        // A blend of your own pulled back down must also be restored AS your own work, or deleting
        // the local copy would leave it uneditable forever
        const mine = Boolean(myId) && entry.authorId === myId;
        setBusy(true);
        try {
            const { saveCount } = mine ? { saveCount: entry.saveCount } : await markHallSaved("recipe", entry.id);
            const slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>> = {};
            // A slot may stack several, filled in the order the listing gives; the author's
            // conditions come across with them
            const pushSlot = (kind: MixMaterialKind, materialId: string, when?: MixCondition) => {
                const list = slots[kind] ?? [];
                if (list.length >= MIX_SLOT_MAX) return;
                list.push(when ? { materialId, when } : { materialId });
                slots[kind] = list;
            };
            let missing = 0;
            for (const part of entry.parts) {
                if (!part || !part.kind || !MIX_KIND_LABELS[part.kind]) continue;
                if (part.builtin) {
                    // Everyone has the factory materials locally, so point straight at them
                    pushSlot(part.kind, part.id, part.when);
                    continue;
                }
                if (part.gone || !part.material || typeof part.material !== "object") {
                    missing += 1;
                    continue;
                }
                // This material is already YOUR OWN in the cabinet -- either pulled back after you
                // published it, or written by you in the first place. Keep the original rather than
                // overwriting it with an imported copy, which would turn your own material into
                // somebody else's.
                const localSame = findMixMaterialByPublishedId(part.id) ?? getMixMaterial(part.id);
                if (localSame && !localSame.imported) {
                    pushSlot(part.kind, localSame.id, part.when);
                    continue;
                }
                const { publishedId: _p, publishedAt: _a, ...clean } = part.material;
                saveMixMaterial({ ...clean, id: part.id, kind: part.kind, author: part.authorName || entry.authorName, authorAvatar: part.authorAvatar || undefined, imported: true } as MixMaterial);
                pushSlot(part.kind, part.id, part.when);
                // Record a save against that material too, so its author sees the number. A failure
                // must not interrupt importing the rest of the blend.
                void markHallSaved("material", part.id).catch(() => { /* best effort */ });
            }
            // When the cabinet already holds the original tied to this cloud entry, overwrite it
            // rather than producing a second blend of the same name
            const linked = mine ? findMixRecipeByPublishedId(entry.id) : null;
            const recipe: MixRecipe = {
                id: linked?.id ?? entry.id,
                name: entry.name,
                slots,
                createdAt: linked?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                ...(mine ? {} : { author: entry.authorName, authorAvatar: entry.authorAvatar || undefined, imported: true }),
            };
            saveMixRecipe(recipe);
            // Your own blend: reconnect the cloud link so an edit can update that same entry
            // rather than publishing another
            if (mine) markMixRecipeSynced(recipe.id, entry.id);
            patchEntry("recipe", entry.id, mine ? {} : { savedByMe: true, saveCount });
            onImported();
            onToast(missing > 0
                ? `"${entry.name}" is ${mine ? "back at the bar" : "in your cabinet"}, but ${missing} of its materials have been taken down, so it will be missing something.`
                : mine
                    ? `"${entry.name}" is back at the bar and ready to edit.`
                    : `"${entry.name}" and its materials are in your cabinet \u2014 take a look at the bar.`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Import failed");
        } finally {
            setBusy(false);
        }
    };

    const handleRemove = async (type: MixHallType, id: string, name: string) => {
        if (busy) return;
        setBusy(true);
        onToast("Taking it down…");
        try {
            await removeHallEntry(type, id);
            if (type === "material") {
                setMaterials((prev) => prev.filter((e) => e.id !== id));
                setDetailMaterial(null);
            } else {
                setRecipes((prev) => prev.filter((e) => e.id !== id));
                setDetailRecipe(null);
            }
            // Keep local bookkeeping in step: clear the matching local item's publish link so the
            // published badge disappears at once
            clearMixPublishedByCloudId(type, id);
            // Taking something down changes the listing, so invalidate the session cache wholesale
            listCacheRef.current.clear();
            onImported();
            onToast(`"${name}" has been taken down.`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Could not take it down");
        } finally {
            setBusy(false);
        }
    };

    const likeButton = (type: MixHallType, entry: { id: string; likedByMe?: boolean; likeCount: number }) => (
        <button
            type="button"
            className="mix-like-btn"
            data-on={entry.likedByMe ? "true" : undefined}
            data-pending={likePending.includes(`${type}:${entry.id}`) ? "true" : undefined}
            onClick={() => void handleLike(type, entry.id)}
            disabled={likePending.includes(`${type}:${entry.id}`)}
            aria-label="Like"
        >
            <Heart size={15} fill={entry.likedByMe ? "currentColor" : "none"} />
            {entry.likeCount}
        </button>
    );

    // -- render --

    function renderBody() {
        if (loading) {
            return (
                <div className="mix-empty" style={{ paddingTop: 60 }}>
                    <Loader2 size={28} strokeWidth={1.6} className="mix-spin" />
                    The bartender is turning the lights on…
                </div>
            );
        }
        // Factory materials are pinned to the top of their tag on the materials page. They are
        // read locally, so they show even when the hall is closed or self-hosted.
        const official = mode === "menu" && scope === "all" ? listMixBuiltins(kind) : [];
        const officialCards = official.map((m) => (
            <MatCard
                kind={m.kind}
                name={m.name}
                hook={m.hook}
                tags={m.tags}
                cover={m.cover}
                badge="Official"
                onClick={() => setOfficialDetail(m)}
                key={m.id}
            />
        ));
        if (notReady) {
            return (
                <>
                    {official.length > 0 ? (
                        <div className={mixKindHasCover(kind) ? "mix-waterfall" : "mix-mat-list"}>{officialCards}</div>
                    ) : null}
                    <div className="mix-empty" style={{ paddingTop: official.length > 0 ? 24 : 60 }}>
                        <Wine size={36} strokeWidth={1.4} />
                        {notReady}
                        <br />
                        Your own bar and cabinet are unaffected \u2014 mix something yourself in the meantime.
                    </div>
                </>
            );
        }
        if (mode === "menu") {
            if (materials.length === 0 && official.length === 0) {
                return (
                    <div className="mix-empty">
                        <Inbox size={32} strokeWidth={1.4} />
                        {scope === "mine" ? `You have not published a ${MIX_KIND_LABELS[kind]} yet \u2014` : `Nobody has shared a ${MIX_KIND_LABELS[kind]} yet \u2014`}
                        <br />
                        open one of your own materials in the cabinet and choose Share to the materials page.
                    </div>
                );
            }
            return (
                <div className={mixKindHasCover(kind) ? "mix-waterfall" : "mix-mat-list"}>
                    {officialCards}
                    {materials.map((entry) => (
                        <MatCard
                            kind={entry.kind}
                            name={entry.name}
                            hook={entry.hook}
                            tags={entry.tags}
                            cover={entry.cover}
                            author={entry.authorName}
                            stats={statsLine(entry)}
                            onClick={() => void openMaterial(entry)}
                            key={entry.id}
                        />
                    ))}
                </div>
            );
        }
        if (recipes.length === 0) {
            return (
                <div className="mix-empty" style={{ paddingTop: 60 }}>
                    <Wine size={32} strokeWidth={1.4} />
                    {scope === "mine" ? "You have not shared a blend yet \u2014" : "Nobody has shared a blend yet \u2014"}
                    <br />
                    press Share on one of your own blends at the bar.
                </div>
            );
        }
        return (
            <div style={{ paddingTop: 14 }}>
                {recipes.map((entry) => (
                    <div className="mix-recipe-card" key={entry.id} onClick={() => void openRecipe(entry)}>
                        {entry.cover ? <div className="mix-recipe-bg" style={{ backgroundImage: `url(${entry.cover})` }} /> : null}
                        <div className="mix-recipe-main">
                            <div className="mix-recipe-name">{entry.name}</div>
                            <div className="mix-recipe-parts">
                                {entry.charName || "House Special"}
                                {entry.partNames.length ? ` · ${entry.partNames.join(" · ")}` : ""}
                            </div>
                            <div className="mix-mat-stats">
                                @{entry.authorName} &middot; {statsLine(entry)} &middot; {entry.viewCount} views
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <>
            {renderBody()}

            {/* Factory material detail: local content, with no like/comment/save -- it is already
                selectable in any bar slot */}
            {officialDetail ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setOfficialDetail(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {officialDetail.name}
                                <span className="mix-mat-badge" style={{ marginLeft: 6 }}>Official</span>
                            </div>
                            <button type="button" className="mix-icon-btn" onClick={() => setOfficialDetail(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-mat-stats" style={{ marginTop: 2 }}>
                                {MIX_KIND_LABELS[officialDetail.kind]} &middot; factory material &middot; already selectable in any bar slot, nothing to save
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <MixTagList tags={officialDetail.tags} />
                                <MaterialDetail material={officialDetail} />
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Material detail */}
            {detailMaterial ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setDetailMaterial(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        {detailMaterial.kind === "character" && detailMaterial.cover ? (
                            <div className="mix-sheet-backdrop" style={{ backgroundImage: `url(${detailMaterial.cover})` }} />
                        ) : null}
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{detailMaterial.name}</div>
                            {likeButton("material", detailMaterial)}
                            {/* Your own publication, editable at any time. It does not matter if the
                                local copy was deleted -- this pulls it back first, then opens the editor. */}
                            {detailMaterial.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => { void editOwnMaterial(detailMaterial); }}
                                    disabled={busy}
                                    aria-label="Edit"
                                    title="Retrieve locally and edit"
                                >
                                    <Pencil size={16} />
                                </button>
                            ) : null}
                            {detailMaterial.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "Take down from the materials page?",
                                        body: <>&quot;{detailMaterial.name}&quot; will be withdrawn from the materials page, so nobody else can see or take it.<br />Copies already in other people's cabinets are unaffected.</>,
                                        confirmText: "Take down",
                                        tone: "danger",
                                        run: () => void handleRemove("material", detailMaterial.id, detailMaterial.name),
                                    })}
                                    aria-label="Take down"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetailMaterial(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ marginTop: 4 }}>
                                <AuthorAvatar name={detailMaterial.authorName} avatar={detailMaterial.authorAvatar} />
                                <span className="mix-author-name">@{detailMaterial.authorName}</span>
                                <span className="mix-mat-stats">{MIX_KIND_LABELS[detailMaterial.kind]} &middot; {detailMaterial.viewCount} views &middot; {detailMaterial.commentCount} comments</span>
                            </div>
                            {detailMaterial.cover && detailMaterial.kind !== "character" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={detailMaterial.cover} alt={detailMaterial.name} style={{ width: 96, height: 128, objectFit: "cover", borderRadius: 12, margin: "10px 0 4px" }} />
                            ) : null}
                            {detailMaterial.payload ? (
                                <>
                                    <div style={{ marginTop: 8 }}>
                                        <MixTagList tags={detailMaterial.tags} />
                                        {detailMaterial.kind === "character"
                                            ? <SealedNote
                                                hook={detailMaterial.hook}
                                                canvas={(detailMaterial.payload as MixCharacterCard).canvas}
                                                charName={(detailMaterial.payload as MixCharacterCard).charName}
                                            />
                                            : <MaterialDetail material={detailMaterial.payload} />}
                                    </div>
                                    <button
                                        type="button"
                                        className="mix-brew-btn"
                                        onClick={() => {
                                            // No need to warn an author about their own mechanism
                                            if (!mixKindRunsActiveCode(detailMaterial.kind) || detailMaterial.authorId === myId) {
                                                void importMaterial(detailMaterial);
                                                return;
                                            }
                                            // A mechanism runs every turn inside your sessions, so
                                            // say plainly what is being installed before it is saved
                                            setConfirm({
                                                title: "This mechanism runs code",
                                                body: <>&quot;{detailMaterial.name}&quot; carries <b>code that runs every turn inside your sessions</b>: it can rewrite what you send, rewrite the prose you see, and speak as you.<br />The code runs in a sandbox with no network and no reach into the app itself, but it CAN see your conversation.<br />Only save it if you trust the author.</>,
                                                confirmText: "I understand, save it",
                                                run: () => void importMaterial(detailMaterial),
                                            });
                                        }}
                                        disabled={busy}
                                    >
                                        {busy ? <Loader2 size={16} className="mix-spin" /> : <CornerDownRight size={16} />}
                                        {busy
                                            ? "Working…"
                                            : detailMaterial.authorId === myId
                                                ? "Retrieve to cabinet"
                                                : detailMaterial.savedByMe ? "Save again" : "Add to cabinet"}
                                    </button>
                                </>
                            ) : (
                                <div className="mix-comment-empty mix-loading-inline"><Loader2 size={14} className="mix-spin" />Loading details…</div>
                            )}
                            <CommentThread
                                type="material"
                                targetId={detailMaterial.id}
                                myId={myId}
                                onToast={onToast}
                                onCountChange={(delta) => patchEntry("material", detailMaterial.id, { commentCount: Math.max(0, detailMaterial.commentCount + delta) })}
                                requestConfirm={setConfirm}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Blend detail */}
            {detailRecipe ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setDetailRecipe(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{detailRecipe.name}</div>
                            {likeButton("recipe", detailRecipe)}
                            {detailRecipe.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "Take down from the blends page?",
                                        body: <>&quot;{detailRecipe.name}&quot; will be withdrawn from the blends page, so nobody else can see or import it.<br />Copies already imported by other people are unaffected.</>,
                                        confirmText: "Take down",
                                        tone: "danger",
                                        run: () => void handleRemove("recipe", detailRecipe.id, detailRecipe.name),
                                    })}
                                    aria-label="Take down"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetailRecipe(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ marginTop: 4 }}>
                                <AuthorAvatar name={detailRecipe.authorName} avatar={detailRecipe.authorAvatar} />
                                <span className="mix-author-name">@{detailRecipe.authorName}</span>
                                <span className="mix-mat-stats">{detailRecipe.viewCount} views &middot; {detailRecipe.commentCount} comments</span>
                            </div>
                            {detailRecipe.intro ? <div className="mix-detail-value" style={{ marginTop: 10 }}>{detailRecipe.intro}</div> : null}
                            {detailRecipe.parts ? (() => {
                                const parts = detailRecipe.parts.filter((p): p is MixHallRecipePart => Boolean(p) && Boolean(p.kind) && Boolean(MIX_KIND_LABELS[p.kind]));
                                const goneCount = parts.filter((p) => p.gone).length;
                                const characterPart = parts.find((p) => p.kind === "character");
                                const characterOk = Boolean(characterPart && !characterPart.gone && (characterPart.builtin || characterPart.material));
                                const importable = parts.length - goneCount;
                                // A blend carrying mechanisms: the save confirmation has to spell
                                // that out separately
                                const mechanismCount = parts.filter((p) => !p.gone && mixKindRunsActiveCode(p.kind)).length;
                                return (
                                    <>
                                        <div className="mix-detail-label" style={{ marginTop: 12 }}>What is in this one</div>
                                        <div className="mix-detail-value">
                                            {parts
                                                .map((p) => `${MIX_KIND_LABELS[p.kind]} \u00b7 ${p.name}${p.builtin ? " (factory)" : p.gone ? " (taken down)" : p.authorName ? ` (@${p.authorName})` : ""}`)
                                                .join("\n")}
                                        </div>
                                        <button
                                            type="button"
                                            className="mix-brew-btn"
                                            onClick={() => setConfirm({
                                                title: "Import with its materials?",
                                                body: <>
                                                    This puts &quot;{detailRecipe.name}&quot; and the <b>{importable} materials</b> inside it into your cabinet (factory materials use your local copies), after which you can start a session from the bar.
                                                    {goneCount > 0 ? <><br />{goneCount} of its materials have been taken down, so it will be missing something.</> : null}
                                                    {mechanismCount > 0 ? (
                                                        <><br /><br />Of those, <b>{mechanismCount} are mechanisms</b>: they run code every turn inside your sessions, and can rewrite what you send, rewrite the prose you see, and speak as you. Only import if you trust the author.</>
                                                    ) : null}
                                                </>,
                                                confirmText: mechanismCount > 0 ? "I understand, import" : "Import",
                                                run: () => void importRecipe(detailRecipe),
                                            })}
                                            disabled={busy || !characterOk}
                                        >
                                            {busy ? <Loader2 size={16} className="mix-spin" /> : <CornerDownRight size={16} />}
                                            {busy ? "Working…" : !characterOk ? "Character card taken down \u2014 cannot import" : detailRecipe.savedByMe ? "Import again" : "Import with materials"}
                                        </button>
                                    </>
                                );
                            })() : (
                                <div className="mix-comment-empty mix-loading-inline"><Loader2 size={14} className="mix-spin" />Loading details…</div>
                            )}
                            <CommentThread
                                type="recipe"
                                targetId={detailRecipe.id}
                                myId={myId}
                                onToast={onToast}
                                onCountChange={(delta) => patchEntry("recipe", detailRecipe.id, { commentCount: Math.max(0, detailRecipe.commentCount + delta) })}
                                requestConfirm={setConfirm}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {confirm ? inOverlay(
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}
        </>
    );
}
