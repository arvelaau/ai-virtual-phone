"use client";

// House Special -- the app shell: the materials and blends pages (the online sharing pages),
// the bar (a per-slot carousel for mixing), the cabinet (material kinds as tags, in a masonry
// grid or a list), and sessions.
// Visually a dark bar: near-black, violet and amber gold. See styles/mixology.css.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    Archive,
    ChevronLeft,
    Copy,
    Download,
    GlassWater,
    ImageDown,
    Martini,
    MoreHorizontal,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Share2,
    SlidersHorizontal,
    Trash2,
    Upload,
    Users,
    Wine,
    X,
} from "lucide-react";
import {
    clearMixMaterialPublished,
    clearMixRecipePublished,
    deleteMixMaterial,
    deleteMixRecipe,
    deleteMixSession,
    getMixBuiltin,
    getMixMaterial,
    isMixBuiltinId,
    listMixPickables,
    loadMixCabinet,
    loadMixProfile,
    loadMixRecipes,
    loadMixSessions,
    markMixMaterialSynced,
    markMixRecipeSynced,
    saveMixMaterial,
    saveMixProfile,
    saveMixRecipe,
    type MixProfile,
} from "@/lib/mixology/storage";
import { runMixSessionStart, startMixSession } from "@/lib/mixology/engine";
import { disposeMixSandboxesForMaterial } from "@/lib/mixology/mechanism-runtime";
import { mixKindRunsActiveCode } from "@/lib/mixology/types";
import {
    createMixId,
    MIX_KIND_LABELS,
    MIX_KIND_SECTION_LABELS,
    MIX_SLOT_ORDER,
    mixCloudState,
    mixKindHasCover,
    type MixCharacterCard,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    type MixSession,
    MIX_SLOT_MAX,
    mixSlotEntries,
    mixSlotFirstId,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { fetchCurrentAccount } from "@/lib/account-client";
import { MixHallGoneError, shareHallMaterial, shareHallRecipe, updateHallMaterial, updateHallRecipe } from "@/lib/mixology/hall-client";
import { exportMixMaterial, exportMixMaterialPng, parseMixMaterialsFromJson, parseMixMaterialsFromPng } from "@/lib/mixology/transfer";
import { MixMaterialEditor } from "./mixology-editor";
import { MixologyGame } from "./mixology-game";
import { CommentThread, MixologyHall } from "./mixology-hall";
import { AuthorAvatar, KindGlyph, MatCard, MaterialDetail, MixConfirm, MixTagList, SealedNote, formatMixTime } from "./mixology-shared";
import { MixSlotEditor } from "./slot-editor";
import { describeMixCondition } from "@/lib/mixology/state";

/** Squash every avatar to a 192px JPEG dataURL, small enough to travel with a publication */
async function readAvatarFile(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the image"));
        reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not decode the image"));
        el.src = dataUrl;
    });
    const size = 192;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const scale = Math.max(size / img.width, size / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    canvas.getContext("2d")?.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
}

type MixTab = "menu" | "hall" | "bar" | "cabinet" | "games";

// -- main component --

export function MixologyApp({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<MixTab>("bar");
    const [cabinet, setCabinet] = useState<MixMaterial[]>(() => loadMixCabinet());
    const [recipes, setRecipes] = useState<MixRecipe[]>(() => loadMixRecipes());
    const [sessions, setSessions] = useState<MixSession[]>(() => loadMixSessions());
    const [cabinetKind, setCabinetKind] = useState<MixMaterialKind>("character");
    // Manual refresh for the materials/blends pages: the token makes the child refetch, and
    // loading spins the header icon
    const [hallReload, setHallReload] = useState(0);
    const [hallLoading, setHallLoading] = useState(false);
    // Hall (everything) vs my publications: the sliding toggle left of the header refresh,
    // shared by both online pages
    const [hallScope, setHallScope] = useState<"all" | "mine">("all");
    // The materials page's current tag. The state lives in the shell and the tag row renders
    // OUTSIDE the scroll container, so it is genuinely fixed and does not ride the rubber-band
    const [hallKind, setHallKind] = useState<MixMaterialKind>("character");
    // Your own account id, used by the cabinet detail's comment thread to decide which comments
    // you may delete
    const [myId, setMyId] = useState("");
    // Creator profile: the credit and avatar used when publishing to the materials or blends
    // page, editable from the cabinet header
    const [profile, setProfile] = useState<MixProfile>(() => loadMixProfile());
    const [profileOpen, setProfileOpen] = useState(false);
    const [profileName, setProfileName] = useState("");
    const [profileAvatar, setProfileAvatar] = useState("");
    const avatarFileRef = useRef<HTMLInputElement | null>(null);
    const [detail, setDetail] = useState<MixMaterial | null>(null);
    const [editor, setEditor] = useState<{ kind: MixMaterialKind; initial?: MixMaterial } | null>(null);
    const [barTab, setBarTab] = useState<"create" | "mine">("create");
    const [recipeMenu, setRecipeMenu] = useState<MixRecipe | null>(null);
    const [confirm, setConfirm] = useState<{
        title: string;
        body?: ReactNode;
        confirmText: string;
        tone?: "danger";
        run: () => void;
    } | null>(null);
    const [barSlots, setBarSlots] = useState<Partial<Record<MixMaterialKind, MixSlotEntry[]>>>({});
    const [slotPicker, setSlotPicker] = useState<MixMaterialKind | null>(null);
    const [slotEditor, setSlotEditor] = useState<MixMaterialKind | null>(null);
    const [nameSheetOpen, setNameSheetOpen] = useState(false);
    const [recipeName, setRecipeName] = useState("");
    const [openingPicker, setOpeningPicker] = useState<MixRecipe | null>(null);
    const [playing, setPlaying] = useState<string | null>(null);
    const [toast, setToast] = useState("");
    const [wheelIndex, setWheelIndex] = useState(0);
    const wheelRef = useRef<HTMLDivElement | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((message: string) => {
        setToast(message);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 2200);
    }, []);

    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    useEffect(() => {
        let cancelled = false;
        void fetchCurrentAccount()
            .then((res) => { if (!cancelled && res.account) setMyId(res.account.id); })
            .catch(() => { /* signed out, or self-hosted: browse anonymously */ });
        return () => { cancelled = true; };
    }, []);

    const refresh = useCallback(() => {
        setCabinet(loadMixCabinet());
        setRecipes(loadMixRecipes());
        setSessions(loadMixSessions());
    }, []);

    /**
     * Arriving from Edit on the materials page or the hall: that side has already pulled your
     * own work back down locally, so this switches to the cabinet, selects its tag, and opens
     * the editor directly -- still carrying the cloud link.
     */
    const openLocalEditor = useCallback((materialId: string) => {
        const material = getMixMaterial(materialId);
        if (!material) { showToast("Could not find that material."); return; }
        refresh();
        setTab("cabinet");
        setCabinetKind(material.kind);
        setEditor({ kind: material.kind, initial: material });
    }, [refresh, showToast]);

    const cabinetFiltered = useMemo(
        () => cabinet.filter((m) => m.kind === cabinetKind),
        [cabinet, cabinetKind],
    );

    /** The materials actually in each bar slot (a slot may stack several, taken in order) */
    const slotMaterials = useMemo(() => {
        const map: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
        for (const kind of MIX_SLOT_ORDER) {
            const list: MixMaterial[] = [];
            for (const entry of mixSlotEntries(barSlots, kind)) {
                const found = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
                if (found && found.kind === kind) list.push(found);
            }
            if (list.length) map[kind] = list;
        }
        return map;
    }, [barSlots, cabinet]);

    /** The items this blend's receipt ticked to remember -- these are the options a variable
     *  condition can choose from */
    const barVarNames = useMemo(() => {
        const names: string[] = [];
        for (const material of slotMaterials.ticket ?? []) {
            if (material.kind !== "ticket") continue;
            for (const item of material.vars ?? []) {
                const name = item.name.trim();
                if (name && !names.includes(name)) names.push(name);
            }
        }
        return names;
    }, [slotMaterials]);

    const handleWheelScroll = useCallback(() => {
        const el = wheelRef.current;
        if (!el) return;
        const center = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let bestDist = Infinity;
        Array.from(el.children).forEach((child, i) => {
            const c = child as HTMLElement;
            const mid = c.offsetLeft + c.offsetWidth / 2;
            const dist = Math.abs(mid - center);
            if (dist < bestDist) { bestDist = dist; best = i; }
        });
        setWheelIndex(best);
    }, []);

    const handleBrew = () => {
        if (!mixSlotEntries(barSlots, "character").length) {
            showToast("Pick a character card for the first slot first.");
            return;
        }
        const character = slotMaterials.character?.[0];
        setRecipeName(character ? `${character.name} Special` : "My blend");
        setNameSheetOpen(true);
    };

    const handleSaveRecipe = () => {
        const name = recipeName.trim();
        if (!name) {
            showToast("Give this blend a name.");
            return;
        }
        const recipe: MixRecipe = {
            id: createMixId("mixrec"),
            name,
            slots: { ...barSlots },
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveMixRecipe(recipe);
        setNameSheetOpen(false);
        setBarSlots({});
        refresh();
        setBarTab("mine");
        showToast(`"${name}" saved as a blend.`);
    };

    const handleStartRecipe = (recipe: MixRecipe) => {
        const characterId = mixSlotFirstId(recipe.slots, "character");
        const card = characterId ? getMixMaterial(characterId) : null;
        if (!card || card.kind !== "character") {
            showToast("This blend's character card is no longer in the cabinet.");
            return;
        }
        if (card.openings.length > 1) {
            setOpeningPicker(recipe);
            return;
        }
        startWithOpening(recipe, 0);
    };

    const startWithOpening = (recipe: MixRecipe, openingIndex: number) => {
        try {
            const session = startMixSession(recipe, { openingIndex });
            // The session-start hook runs in the background, initialising mechanism storage and
            // remembered values without holding up the navigation
            void runMixSessionStart(session.id);
            setOpeningPicker(null);
            refresh();
            setPlaying(session.id);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "Could not start the session");
        }
    };

    const [sharing, setSharing] = useState(false);
    const importFileRef = useRef<HTMLInputElement | null>(null);
    const editorFileRef = useRef<HTMLInputElement | null>(null);
    // Changing the key forces the editor to remount: each form field initialises from `initial`
    // once, at mount
    const [editorSeq, setEditorSeq] = useState(0);

    /**
     * The editor's upload-and-replace: the file's content replaces the form, but the identity
     * and cloud link stay with the original -- the id is unchanged, so saving overwrites the same
     * record, and a published listing still recognises it, so update overwrites rather than
     * publishing a second one.
     */
    const handleEditorReplace = async (file: File | undefined) => {
        if (!file || !editor) return;
        try {
            const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
            const materials = isPng
                ? parseMixMaterialsFromPng(await file.arrayBuffer())
                : parseMixMaterialsFromJson(await file.text());
            // The parser throws when it recognises nothing at all, so reaching here guarantees
            // materials is non-empty
            const picked = materials.find((m) => m.kind === editor.kind);
            if (!picked) {
                const kinds = [...new Set(materials.map((m) => MIX_KIND_LABELS[m.kind]))];
                showToast(`This file contains no ${MIX_KIND_LABELS[editor.kind]} \u2014 only ${kinds.join(", ")}.`);
                return;
            }
            const keep = editor.initial;
            setEditor({
                kind: editor.kind,
                initial: keep
                    ? {
                        ...picked,
                        id: keep.id,
                        createdAt: keep.createdAt,
                        publishedId: keep.publishedId,
                        publishedAt: keep.publishedAt,
                        author: keep.author,
                        authorAvatar: keep.authorAvatar,
                    } as MixMaterial
                    : picked,
            });
            setEditorSeq((n) => n + 1);
            showToast(`The form now holds "${picked.name}" \u2014 not saved yet.`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "Could not read the file");
        }
    };

    const handleImportFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
            const materials = isPng
                ? parseMixMaterialsFromPng(await file.arrayBuffer())
                : parseMixMaterialsFromJson(await file.text());
            materials.forEach(saveMixMaterial);
            refresh();
            showToast(materials.length > 1 ? `Imported ${materials.length} materials.` : `"${materials[0].name}" is in your cabinet.`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "Import failed");
        }
    };

    const handleShareMaterial = async (material: MixMaterial) => {
        if (sharing) return;
        setSharing(true);
        try {
            if (material.publishedId) {
                await updateHallMaterial(material.publishedId, material);
                markMixMaterialSynced(material.id, material.publishedId);
                refresh();
                showToast(`"${material.name}" updated on the materials page.`);
            } else {
                const entry = await shareHallMaterial(material);
                // Remember the online identity, so later local edits can be pushed as an update
                // rather than publishing a pile of cards with the same name
                markMixMaterialSynced(material.id, entry.id);
                refresh();
                showToast(`"${material.name}" shared to the materials page.`);
            }
        } catch (error) {
            if (error instanceof MixHallGoneError) {
                clearMixMaterialPublished(material.id);
                refresh();
                showToast("It has been taken down from the materials page; you can share it again.");
            } else {
                showToast(error instanceof Error ? error.message : "Sharing failed");
            }
        } finally {
            setSharing(false);
        }
    };

    /**
     * The plan for sharing a blend. A published blend stores only SLOT REFERENCES, and each
     * material's identity is its own entry on the materials page.
     * - factory materials: everyone has them locally, so they become a builtin reference and are
     *   never published;
     * - somebody else's material saved from the materials page (its id IS the online id):
     *   referenced directly;
     * - your own materials: unpublished ones must be published first (toPublish), and edited-
     *   but-unsynced ones must be pushed first (toSync);
     * - materials from an older "imported along with a blend" flow have no online entry at all
     *   and cannot be referenced (blockers).
     */
    const planShareRecipe = (recipe: MixRecipe) => {
        // Keep the entry-to-material pairing: order and conditions both have to travel with it
        const pairs = MIX_SLOT_ORDER
            .flatMap((k) => mixSlotEntries(recipe.slots, k)
                .map((entry) => {
                    const material = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
                    return material ? { entry, material } : null;
                }))
            .filter((pair): pair is { entry: MixSlotEntry; material: MixMaterial } => Boolean(pair));
        const materials = pairs.map((pair) => pair.material);
        const character = materials.find((m) => m.kind === "character");
        const own = materials.filter((m) => !isMixBuiltinId(m.id) && !m.imported);
        return {
            pairs,
            materials,
            character: character && character.kind === "character" ? character : null,
            toPublish: own.filter((m) => !m.publishedId),
            toSync: own.filter((m) => mixCloudState(m) === "dirty"),
            blockers: materials.filter((m) => m.imported && !m.id.startsWith("mxi_")),
        };
    };

    const handleShareRecipe = async (recipe: MixRecipe) => {
        if (sharing) return;
        const plan = planShareRecipe(recipe);
        if (!plan.character) {
            showToast("This blend has no character card, so it cannot be shared.");
            return;
        }
        setSharing(true);
        try {
            // Step one: push your own materials up -- publish the unpublished, sync the edited,
            // and republish anything the cloud has lost
            for (const material of plan.materials) {
                if (isMixBuiltinId(material.id) || material.imported) continue;
                if (!material.publishedId) {
                    const entry = await shareHallMaterial(material);
                    markMixMaterialSynced(material.id, entry.id);
                } else if (mixCloudState(material) === "dirty") {
                    try {
                        await updateHallMaterial(material.publishedId, material);
                        markMixMaterialSynced(material.id, material.publishedId);
                    } catch (error) {
                        if (!(error instanceof MixHallGoneError)) throw error;
                        const entry = await shareHallMaterial(material);
                        markMixMaterialSynced(material.id, entry.id);
                    }
                }
            }
            // Step two: take the fresh publishedId mapping and build the reference array
            const fresh = loadMixCabinet();
            // Order follows `pairs` (by slot, and top to bottom within a slot), with each one's
            // condition carried along
            const parts = plan.pairs.map(({ entry, material }) => {
                const when = entry.when;
                const base = isMixBuiltinId(material.id)
                    ? { id: material.id, kind: material.kind, name: material.name, builtin: true as const }
                    : material.imported
                        ? { id: material.id, kind: material.kind, name: material.name }
                        : { id: fresh.find((m) => m.id === material.id)?.publishedId ?? material.publishedId ?? material.id, kind: material.kind, name: material.name };
                return when ? { ...base, when } : base;
            });
            const character = plan.character;
            const input = {
                name: recipe.name,
                cover: character.cover ?? "",
                charName: character.charName,
                partNames: plan.materials.filter((m) => m.kind !== "character").map((m) => m.name).slice(0, 8),
                parts,
            };
            if (recipe.publishedId) {
                await updateHallRecipe(recipe.publishedId, input);
                markMixRecipeSynced(recipe.id, recipe.publishedId);
                refresh();
                showToast(`"${recipe.name}" updated on the blends page, with its materials synced.`);
            } else {
                const entry = await shareHallRecipe(input);
                markMixRecipeSynced(recipe.id, entry.id);
                refresh();
                showToast(`"${recipe.name}" shared to the blends page.`);
            }
        } catch (error) {
            if (error instanceof MixHallGoneError) {
                clearMixRecipePublished(recipe.id);
                refresh();
                showToast("It has been taken down from the blends page; you can share it again.");
            } else {
                refresh(); // some materials may have published successfully, so refresh the badges
                showToast(error instanceof Error ? error.message : "Sharing failed");
            }
        } finally {
            setSharing(false);
        }
    };

    const handleDeleteMaterial = (material: MixMaterial) => {
        if (!deleteMixMaterial(material.id)) {
            showToast("Factory materials cannot be deleted.");
            return;
        }
        setDetail(null);
        refresh();
        showToast(`"${material.name}" removed from your cabinet.`);
    };

    // -- the session screen takes over full screen --
    if (playing) {
        return (
            <div className="mixology-app">
                <MixologyGame
                    sessionId={playing}
                    onBack={() => { setPlaying(null); refresh(); }}
                    onToast={showToast}
                />
                {confirm ? (
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}

            {toast ? <div className="mix-toast">{toast}</div> : null}
            </div>
        );
    }

    const openingCardId = openingPicker ? mixSlotFirstId(openingPicker.slots, "character") : undefined;
    const openingCard = openingCardId ? getMixMaterial(openingCardId) : null;

    // The comment thread in the cabinet detail. Something you published yourself (it has a
    // publishedId) or saved whole from the materials page (imported, with the online id as its
    // id, prefixed mxi_) can be matched to an online entry. A material that arrived alongside a
    // blend carries the AUTHOR's local id, has no online entry, and so shows no thread.
    const detailHallId = detail
        ? detail.publishedId ?? (detail.imported && detail.id.startsWith("mxi_") ? detail.id : null)
        : null;

    return (
        <div className="mixology-app">
            <div className="mix-header">
                <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="Close"><ChevronLeft size={20} /></button>
                <div className="mix-header-title">House <em>Special</em></div>
                {tab === "cabinet" ? (
                    <>
                        <button
                            type="button"
                            className="mix-profile-chip"
                            onClick={() => {
                                setProfileName(profile.name ?? "");
                                setProfileAvatar(profile.avatar ?? "");
                                setProfileOpen(true);
                            }}
                            title="Creator profile: the credit and avatar used when publishing"
                        >
                            <AuthorAvatar name={profile.name || "Me"} avatar={profile.avatar} size={32} />
                            <span className="mix-profile-name">{profile.name || "Set a pen name"}</span>
                            <Pencil size={12} />
                        </button>
                        <button type="button" className="mix-icon-btn" onClick={() => importFileRef.current?.click()} aria-label="Import material" title="Import from file"><Upload size={17} /></button>
                    </>
                ) : null}
                {tab === "menu" || tab === "hall" ? (
                    <>
                        <div className="mix-scope-toggle" role="tablist" aria-label="Scope">
                            <button type="button" data-active={hallScope === "all" ? "true" : undefined} onClick={() => setHallScope("all")}>Hall</button>
                            <button type="button" data-active={hallScope === "mine" ? "true" : undefined} onClick={() => setHallScope("mine")}>Mine</button>
                        </div>
                        <button
                            type="button"
                            className="mix-icon-btn"
                            onClick={() => setHallReload((n) => n + 1)}
                            disabled={hallLoading}
                            aria-label="Refresh"
                            title="Refresh"
                        >
                            <RefreshCw size={17} className={hallLoading ? "mix-spin" : undefined} />
                        </button>
                    </>
                ) : null}
            </div>

            {/* The tag row sits outside the scroll container, so it is genuinely fixed and the
                rubber-band only affects the content below */}
            {tab === "menu" || tab === "cabinet" ? (
                <div className="mix-topbar">
                    <div className="mix-chip-row">
                        {MIX_SLOT_ORDER.map((kind) => {
                            const active = (tab === "menu" ? hallKind : cabinetKind) === kind;
                            return (
                                <button
                                    type="button"
                                    className="mix-chip"
                                    data-two-line="true"
                                    data-active={active ? "true" : undefined}
                                    onClick={() => (tab === "menu" ? setHallKind(kind) : setCabinetKind(kind))}
                                    key={kind}
                                >
                                    <span>{MIX_KIND_LABELS[kind]}</span>
                                    <small>{MIX_KIND_SECTION_LABELS[kind]}</small>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            <div className="mix-body" data-fill={tab === "bar" && barTab === "create" ? "true" : undefined}>
                {tab === "menu" ? (
                    <MixologyHall mode="menu" kind={hallKind} scope={hallScope} onToast={showToast} onImported={refresh} reloadToken={hallReload} onLoadingChange={setHallLoading} onEditLocal={openLocalEditor} />
                ) : null}

                {tab === "hall" ? (
                    <MixologyHall mode="hall" scope={hallScope} onToast={showToast} onImported={refresh} reloadToken={hallReload} onLoadingChange={setHallLoading} onEditLocal={openLocalEditor} />
                ) : null}

                {tab === "bar" ? (
                    <>
                        <div className="mix-subtabs">
                            <button type="button" data-active={barTab === "create" ? "true" : undefined} onClick={() => setBarTab("create")}>Build a blend</button>
                            <button type="button" data-active={barTab === "mine" ? "true" : undefined} onClick={() => setBarTab("mine")}>
                                My blends{recipes.length ? ` \u00b7 ${recipes.length}` : ""}
                            </button>
                        </div>
                    {barTab === "create" ? (
                    <div className="mix-bar-stage" data-centered="true">
                        <div className="mix-bar-hint">Swipe between slots &middot; tap a slot to choose a material &middot; up to 3 per slot</div>
                        <div className="mix-wheel" ref={wheelRef} onScroll={handleWheelScroll}>
                            {MIX_SLOT_ORDER.map((kind) => {
                                const stack = slotMaterials[kind] ?? [];
                                const chosen = stack[0];
                                const extra = stack.length - 1;
                                return (
                                    <div
                                        className="mix-slot"
                                        data-filled={chosen ? "true" : undefined}
                                        key={kind}
                                        // An empty slot goes straight to the picker, saving a tap.
                                        // A filled one opens that slot's editor, where materials can
                                        // be stacked, reordered and given conditions.
                                        onClick={() => (chosen ? setSlotEditor(kind) : setSlotPicker(kind))}
                                    >
                                        <div className="mix-slot-kind">
                                            <b>{MIX_KIND_LABELS[kind]}</b>
                                            {kind === "character"
                                                ? <i className="mix-slot-required">required</i>
                                                : <i>may be empty</i>}
                                        </div>
                                        <div className="mix-slot-body">
                                            {chosen ? (
                                                <>
                                                    {chosen.cover ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img className="mix-slot-cover" src={chosen.cover} alt={chosen.name} />
                                                    ) : (
                                                        <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                    )}
                                                    <div className="mix-slot-name">{chosen.name}{extra > 0 ? ` +${extra}` : ""}</div>
                                                    {stack.length > 1 ? (
                                                        <div className="mix-slot-stack">
                                                            {mixSlotEntries(barSlots, kind).map((entry, i) => {
                                                                const mat = stack[i];
                                                                if (!mat) return null;
                                                                return (
                                                                    <span className="mix-slot-stack-item" key={`${entry.materialId}-${i}`}>
                                                                        {mat.name}
                                                                        <i>{describeMixCondition(entry.when)}</i>
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : chosen.hook ? (
                                                        <div className="mix-slot-hook">{chosen.hook}</div>
                                                    ) : null}
                                                    {stack.length === 1 && mixSlotEntries(barSlots, kind)[0]?.when ? (
                                                        <div className="mix-slot-when">{describeMixCondition(mixSlotEntries(barSlots, kind)[0].when)}</div>
                                                    ) : null}
                                                </>
                                            ) : (
                                                <>
                                                    <div className="mix-slot-plus"><Plus size={26} /></div>
                                                    <div className="mix-slot-empty-text">Pick a {MIX_KIND_LABELS[kind]} from the cabinet</div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="mix-wheel-dots">
                            {MIX_SLOT_ORDER.map((kind, i) => (
                                <span className="mix-wheel-dot" data-active={i === wheelIndex ? "true" : undefined} key={kind} />
                            ))}
                        </div>
                        <button type="button" className="mix-brew-btn" onClick={handleBrew} disabled={!mixSlotEntries(barSlots, "character").length}>
                            <Martini size={17} />Mix
                        </button>
                    </div>
                    ) : recipes.length === 0 ? (
                            <div className="mix-empty" style={{ paddingTop: 70 }}>
                                <Wine size={32} strokeWidth={1.4} />
                                No blends saved yet \u2014
                                <br />
                                go to Build a blend, fill the slots, and press Mix.
                            </div>
                        ) : (
                            recipes.map((recipe) => {
                                const recipeCardId = mixSlotFirstId(recipe.slots, "character");
                                const card = recipeCardId ? cabinet.find((m) => m.id === recipeCardId) : null;
                                const parts = MIX_SLOT_ORDER
                                    .filter((k) => k !== "character")
                                    .flatMap((k) => mixSlotEntries(recipe.slots, k)
                                        .map((entry) => (getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId))?.name))
                                    .filter(Boolean);
                                // The blend's cloud badge. Either editing the combination yourself,
                                // or any of your own materials being unpublished or unsynced, counts
                                // as having unpublished changes.
                                const cloudBadge = (() => {
                                    if (recipe.imported || !recipe.publishedId) return null;
                                    const partsDirty = MIX_SLOT_ORDER.some((k) => mixSlotEntries(recipe.slots, k).some((entry) => {
                                        if (isMixBuiltinId(entry.materialId)) return false;
                                        const m = cabinet.find((x) => x.id === entry.materialId);
                                        return Boolean(m) && !m!.imported && mixCloudState(m!) !== "synced";
                                    }));
                                    return mixCloudState(recipe) === "dirty" || partsDirty ? "Unpublished changes" : "Published";
                                })();
                                return (
                                    <div className="mix-recipe-card" key={recipe.id}>
                                        {card?.cover ? <div className="mix-recipe-bg" style={{ backgroundImage: `url(${card.cover})` }} /> : null}
                                        <div className="mix-recipe-main">
                                            <div className="mix-recipe-name">
                                                {recipe.name}
                                                {cloudBadge ? <span className="mix-cloud-badge" data-dirty={cloudBadge === "Published" ? undefined : "true"}>{cloudBadge}</span> : null}
                                            </div>
                                            <div className="mix-recipe-parts">
                                                {card ? card.name : "(character card missing)"}
                                                {parts.length ? ` \u00b7 ${parts.join(" \u00b7 ")}` : " \u00b7 plain glass"}
                                            </div>
                                        </div>
                                        <div className="mix-recipe-actions">
                                            <button
                                                type="button"
                                                className="mix-round-btn"
                                                data-tone="gold"
                                                onClick={() => handleStartRecipe(recipe)}
                                                aria-label="Start a session"
                                                title="Start"
                                            >
                                                <Play size={17} fill="currentColor" />
                                            </button>
                                            <button
                                                type="button"
                                                className="mix-round-btn"
                                                onClick={() => setRecipeMenu(recipe)}
                                                aria-label="More"
                                                title="More"
                                            >
                                                <MoreHorizontal size={18} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </>
                ) : null}

                {tab === "cabinet" ? (
                    <>
                        {cabinetFiltered.length === 0 ? (
                            <div className="mix-empty">
                                <Archive size={32} strokeWidth={1.4} />
                                Nothing here yet \u2014
                                <br />
                                press + in the corner to make a {MIX_KIND_LABELS[cabinetKind]}.
                            </div>
                        ) : (
                            <div className={mixKindHasCover(cabinetKind) ? "mix-waterfall" : "mix-mat-list"}>
                                {cabinetFiltered.map((material) => (
                                    <MatCard
                                        kind={material.kind}
                                        name={material.name}
                                        hook={material.hook}
                                        tags={material.tags}
                                        cover={material.cover}
                                        badge={isMixBuiltinId(material.id)
                                            ? "Official"
                                            : material.imported || mixCloudState(material) === "local"
                                                ? undefined
                                                : mixCloudState(material) === "dirty" ? "Unpublished changes" : "Published"}
                                        author={!isMixBuiltinId(material.id) ? material.author : undefined}
                                        onClick={() => setDetail(material)}
                                        key={material.id}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                ) : null}

                {tab === "games" ? (
                    <>
                        <div className="mix-section-title" style={{ marginTop: 14 }}>Sessions<small>{sessions.length ? `${sessions.length}` : ""}</small></div>
                        {sessions.length === 0 ? (
                            <div className="mix-empty">
                                <Martini size={32} strokeWidth={1.4} />
                                No sessions yet \u2014
                                <br />
                                mix something at the bar and press Start.
                            </div>
                        ) : (
                            sessions.map((session) => {
                                const sessionCardId = mixSlotFirstId(session.recipe.slots, "character");
                                const card = sessionCardId ? cabinet.find((m) => m.id === sessionCardId) : null;
                                return (
                                    <div className="mix-session-row" key={session.id} onClick={() => setPlaying(session.id)}>
                                        {card?.cover ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img className="mix-session-ava" src={card.cover} alt={session.charName} />
                                        ) : (
                                            <div className="mix-session-ava-fallback">{session.charName.slice(0, 1)}</div>
                                        )}
                                        <div className="mix-session-info">
                                            <div className="mix-session-name">{session.charName} · {session.recipe.name}</div>
                                            <div className="mix-session-sub">{session.turns.length} messages &middot; {formatMixTime(session.updatedAt)}</div>
                                        </div>
                                        <button
                                            type="button"
                                            className="mix-icon-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setConfirm({
                                                    title: "Delete this session?",
                                                    body: <>All {session.turns.length} messages from &quot;{session.charName} &middot; {session.recipe.name}&quot; will go with it, and cannot be recovered.</>,
                                                    confirmText: "Delete",
                                                    tone: "danger",
                                                    run: () => { deleteMixSession(session.id); refresh(); },
                                                });
                                            }}
                                            aria-label="Delete session"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                );
                            })
                        )}
                    </>
                ) : null}
            </div>

            {/* The floating create button must sit outside the scroll container, or it drifts with
                the content once the list scrolls */}
            {tab === "cabinet" ? (
                <button
                    type="button"
                    className="mix-fab"
                    onClick={() => setEditor({ kind: cabinetKind })}
                    aria-label={`Make a ${MIX_KIND_LABELS[cabinetKind]}`}
                    title={`Make a ${MIX_KIND_LABELS[cabinetKind]}`}
                >
                    <Plus size={24} />
                </button>
            ) : null}

            <div className="mix-nav">
                <button type="button" className="mix-nav-btn" data-active={tab === "menu" ? "true" : undefined} onClick={() => setTab("menu")}>
                    <Wine size={19} strokeWidth={1.8} />Materials
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "hall" ? "true" : undefined} onClick={() => setTab("hall")}>
                    <Users size={19} strokeWidth={1.8} />Blends
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "bar" ? "true" : undefined} onClick={() => setTab("bar")}>
                    <Martini size={19} strokeWidth={1.8} />Bar
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "cabinet" ? "true" : undefined} onClick={() => setTab("cabinet")}>
                    <Archive size={19} strokeWidth={1.8} />Cabinet
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "games" ? "true" : undefined} onClick={() => setTab("games")}>
                    <GlassWater size={19} strokeWidth={1.8} />Sessions
                </button>
            </div>

            {/* Material detail */}
            {detail ? (
                <div className="mix-sheet-mask" onClick={() => setDetail(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        {detail.kind === "character" && detail.cover ? (
                            <div className="mix-sheet-backdrop" style={{ backgroundImage: `url(${detail.cover})` }} />
                        ) : null}
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {detail.name}
                                {isMixBuiltinId(detail.id) ? <span className="mix-mat-badge" style={{ marginLeft: 6 }}>Official</span> : null}
                                {!isMixBuiltinId(detail.id) && !detail.imported && mixCloudState(detail) !== "local" ? (
                                    <span className="mix-cloud-badge" data-dirty={mixCloudState(detail) === "dirty" ? "true" : undefined}>
                                        {mixCloudState(detail) === "dirty" ? "Unpublished changes" : "Published"}
                                    </span>
                                ) : null}
                            </div>
                            {!detail.imported ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => {
                                        // A duplicate is a NEW item with no cloud link: keep working
                                        // from the original without touching the published version
                                        const { publishedId: _p, publishedAt: _a, imported: _i, ...rest } = detail;
                                        const now = Date.now();
                                        const dup = { ...rest, id: createMixId("mixmat"), name: `${detail.name} copy`, createdAt: now, updatedAt: now } as MixMaterial;
                                        saveMixMaterial(dup);
                                        setDetail(null);
                                        refresh();
                                        showToast(`Duplicated as "${dup.name}", with no cloud link.`);
                                    }}
                                    aria-label="Duplicate (no cloud link)"
                                    title="Duplicate (no cloud link)"
                                >
                                    <Copy size={16} />
                                </button>
                            ) : null}
            {/* Somebody else's imported work, of any kind: it cannot be exported, edited or
                republished -- only deleted, or saved again from the materials page.
                Same rules as the app market. Only a character card has its body sealed
                (isSealedMaterial), but the action restrictions apply to every imported item. */}
                            {!detail.imported ? (
                                <>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => { void exportMixMaterial(detail).catch((err) => showToast(err instanceof Error ? err.message : "Export failed")); }}
                                        aria-label="Export JSON"
                                        title="Export JSON"
                                    >
                                        <Download size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => { void exportMixMaterialPng(detail).catch((err) => showToast(err instanceof Error ? err.message : "Export failed")); }}
                                        aria-label="Export PNG card"
                                        title="Export PNG card (the picture is the card)"
                                    >
                                        <ImageDown size={16} />
                                    </button>
                                </>
                            ) : null}
                            {!isMixBuiltinId(detail.id) && !detail.imported ? (
                                <>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setConfirm(detail.publishedId ? {
                                            title: "Update the version on the materials page?",
                                            body: <>This replaces what is on the materials page for &quot;{detail.name}&quot; with the current version.<br />Likes, saves and comments are all kept.</>,
                                            confirmText: "Update",
                                            run: () => { const t = detail; setDetail(null); void handleShareMaterial(t); },
                                        } : {
                                            title: mixKindRunsActiveCode(detail.kind) ? "Publish this mechanism?" : "Share to the materials page?",
                                            body: mixKindRunsActiveCode(detail.kind) ? (
                                                <>&quot;{detail.name}&quot; will appear on the materials page, and once somebody downloads it <b>its code runs every turn inside THEIR sessions</b> -- able to rewrite what they send, rewrite the prose they see, and speak as them.<br />Please make sure this code is your own and that you know exactly what it does.</>
                                            ) : (
                                                <>&quot;{detail.name}&quot; will appear on the materials page, where <b>anyone can read its full contents</b> and add it to their own cabinet.<br />If you would rather it stayed private, do not publish it.</>
                                            ),
                                            confirmText: "Share",
                                            run: () => { const t = detail; setDetail(null); void handleShareMaterial(t); },
                                        })}
                                        disabled={sharing}
                                        aria-label={detail.publishedId ? "Update the published version" : "Share to the materials page"}
                                        title={detail.publishedId ? "Update the published version" : "Share to the materials page"}
                                    >
                                        {detail.publishedId ? <RefreshCw size={16} /> : <Share2 size={16} />}
                                    </button>
                                    <button type="button" className="mix-icon-btn" onClick={() => { setEditor({ kind: detail.kind, initial: detail }); setDetail(null); }} aria-label="Edit"><Pencil size={16} /></button>
                                </>
                            ) : null}
                            {!isMixBuiltinId(detail.id) ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "Delete this material?",
                                        body: <>
                                            &quot;{detail.name}&quot; will be removed from your cabinet, and any blend using it will be missing something.
                                            <br />
                                            {detail.imported ? "You can save it again from the materials page later." : "This cannot be undone. It only deletes your local copy; a published version is unaffected."}
                                        </>,
                                        confirmText: "Delete",
                                        tone: "danger",
                                        run: () => handleDeleteMaterial(detail),
                                    })}
                                    aria-label="Delete"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetail(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ marginTop: 2 }}>
                                {detail.imported ? (
                                    <>
                                        <AuthorAvatar name={detail.author || "Anonymous bartender"} avatar={detail.authorAvatar} />
                                        <span className="mix-author-name">@{detail.author || "Anonymous bartender"}</span>
                                    </>
                                ) : (
                                    <>
                                        <AuthorAvatar name={profile.name || "Me"} avatar={profile.avatar} />
                                        <span className="mix-author-name">{profile.name || "Me"}</span>
                                        <span className="mix-mat-stats">Publishing uses your creator profile</span>
                                    </>
                                )}
                            </div>
                            {detail.cover && detail.kind !== "character" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={detail.cover} alt={detail.name} style={{ width: 96, height: 128, objectFit: "cover", borderRadius: 12, margin: "4px 0 12px" }} />
                            ) : null}
                            <MixTagList tags={detail.tags} />
                            {/* The same presentation as the materials page: opening a character card
                                shows its front page (canvas / hook), and the setting text is behind Edit */}
                            {detail.kind === "character" ? (
                                <SealedNote hook={detail.hook} canvas={(detail as MixCharacterCard).canvas} charName={(detail as MixCharacterCard).charName} />
                            ) : (
                                <MaterialDetail material={detail} />
                            )}
                            {detailHallId ? (
                                <CommentThread
                                    type="material"
                                    targetId={detailHallId}
                                    myId={myId}
                                    onToast={showToast}
                                    onCountChange={() => { /* the cabinet does not persist online comment counts */ }}
                                    requestConfirm={setConfirm}
                                />
                            ) : null}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Creator profile editor */}
            {profileOpen ? (
                <div className="mix-sheet-mask" onClick={() => setProfileOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">Creator profile</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setProfileOpen(false)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-struct-note" style={{ marginTop: 4 }}>
                                When you publish or update to the materials or blends page, the listing shows the avatar and pen name set here. Leave the pen name empty to use your account name.
                            </div>
                            <label className="mix-form-label">Avatar</label>
                            <div className="mix-cover-picker">
                                <AuthorAvatar name={profileName || profile.name || "Me"} avatar={profileAvatar} size={88} />
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <button type="button" className="mix-pill-btn" onClick={() => avatarFileRef.current?.click()}>Choose image</button>
                                    {profileAvatar ? (
                                        <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setProfileAvatar("")}>Remove</button>
                                    ) : null}
                                </div>
                                <input
                                    ref={avatarFileRef}
                                    type="file"
                                    accept="image/*"
                                    style={{ display: "none" }}
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (!file) return;
                                        void readAvatarFile(file)
                                            .then(setProfileAvatar)
                                            .catch(() => showToast("Could not read that avatar. Try a different image."));
                                    }}
                                />
                            </div>
                            <label className="mix-form-label">Pen name</label>
                            <input
                                className="mix-input"
                                value={profileName}
                                onChange={(e) => setProfileName(e.target.value)}
                                placeholder="The credit shown when publishing; empty uses your account name"
                                maxLength={24}
                            />
                            <div className="mix-form-footer">
                                <button type="button" className="mix-ghost-btn" onClick={() => setProfileOpen(false)}>Cancel</button>
                                <button
                                    type="button"
                                    className="mix-brew-btn"
                                    onClick={() => {
                                        const next: MixProfile = { name: profileName.trim() || undefined, avatar: profileAvatar || undefined };
                                        saveMixProfile(next);
                                        setProfile(next);
                                        setProfileOpen(false);
                                        showToast("Creator profile saved. Future publications and updates will use it.");
                                    }}
                                >
                                    Save
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Editor */}
            {editor ? (
                <div className="mix-sheet-mask">
                    <div className="mix-sheet" style={{ maxHeight: "92%" }}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{editor.initial ? "Edit " : "New "}{MIX_KIND_LABELS[editor.kind]}</div>
                            {/* Upload and replace: ask first when editing an existing item, since the
                                form already has content in it */}
                            <button
                                type="button"
                                className="mix-icon-btn"
                                onClick={() => {
                                    if (!editor.initial) { editorFileRef.current?.click(); return; }
                                    setConfirm({
                                        title: "Replace the form with a file?",
                                        body: <>This replaces everything currently filled in for &quot;{editor.initial.name}&quot; with the contents of a file (JSON or a PNG card).<br />Nothing is saved by the swap, so if it looks wrong you can simply close without saving.<br />The published link is kept, so saving and pressing update still overwrites the same listing.</>,
                                        confirmText: "Choose a file",
                                        run: () => editorFileRef.current?.click(),
                                    });
                                }}
                                aria-label="Upload and replace"
                                title="Replace the form from a file (JSON / PNG card)"
                            >
                                <Upload size={17} />
                            </button>
                            <button type="button" className="mix-icon-btn" onClick={() => setEditor(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <MixMaterialEditor
                                key={`${editor.kind}-${editorSeq}`}
                                kind={editor.kind}
                                initial={editor.initial}
                                onSave={(material) => {
                                    // The editor never handles the publish bookkeeping fields, so they
                                    // are carried back from the original on save and the cloud link is
                                    // not lost. updatedAt is re-stamped, so saving naturally moves the
                                    // item into the "unpublished changes" state.
                                    saveMixMaterial(editor.initial?.publishedId
                                        ? { ...material, publishedId: editor.initial.publishedId, publishedAt: editor.initial.publishedAt }
                                        : material);
                                    // After editing a mechanism, any running sandbox still holds the old
                                    // code -- dispose of it and let the next call rebuild
                                    if (material.kind === "mechanism") disposeMixSandboxesForMaterial(material.id);
                                    setEditor(null);
                                    refresh();
                                    showToast(`"${material.name}" is in your cabinet.`);
                                }}
                                onCancel={() => setEditor(null)}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Bar material picker */}
            {slotEditor ? (
                <MixSlotEditor
                    kind={slotEditor}
                    entries={mixSlotEntries(barSlots, slotEditor)}
                    resolve={(id) => getMixBuiltin(id) ?? cabinet.find((m) => m.id === id) ?? null}
                    varNames={barVarNames}
                    onChange={(next) => setBarSlots((prev) => {
                        const merged = { ...prev };
                        if (next.length) merged[slotEditor] = next;
                        else delete merged[slotEditor];
                        return merged;
                    })}
                    onPickMore={() => setSlotPicker(slotEditor)}
                    onClose={() => setSlotEditor(null)}
                />
            ) : null}

            {slotPicker ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPicker(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">Choose a {MIX_KIND_LABELS[slotPicker]}</div>
                            {slotPicker !== "character" && mixSlotEntries(barSlots, slotPicker).length ? (
                                <button
                                    type="button"
                                    className="mix-pill-btn"
                                    data-tone="ghost"
                                    onClick={() => {
                                        setBarSlots((prev) => {
                                            const next = { ...prev };
                                            delete next[slotPicker];
                                            return next;
                                        });
                                        setSlotPicker(null);
                                    }}
                                >
                                    Leave this one out
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setSlotPicker(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {listMixPickables(slotPicker).length === 0 ? (
                                <div className="mix-empty">
                                    <Archive size={30} strokeWidth={1.4} />
                                    No {MIX_KIND_LABELS[slotPicker]} in the cabinet yet \u2014
                                    <br />
                                    go to the cabinet and press + to make one.
                                </div>
                            ) : (
                                <div className={mixKindHasCover(slotPicker) ? "mix-waterfall" : "mix-mat-list"}>
                                    {listMixPickables(slotPicker).map((material) => (
                                        <MatCard
                                            kind={material.kind}
                                            name={material.name}
                                            hook={material.hook}
                                            tags={material.tags}
                                            cover={material.cover}
                                            badge={isMixBuiltinId(material.id) ? "Official" : undefined}
                                            onClick={() => {
                                                setBarSlots((prev) => {
                                                    const current = mixSlotEntries(prev, slotPicker);
                                                    // Already in this slot: do not add it twice. If the
                                                    // slot is full, replace the last one.
                                                    if (current.some((e) => e.materialId === material.id)) return prev;
                                                    const next = current.length >= MIX_SLOT_MAX
                                                        ? [...current.slice(0, MIX_SLOT_MAX - 1), { materialId: material.id }]
                                                        : [...current, { materialId: material.id }];
                                                    return { ...prev, [slotPicker]: next };
                                                });
                                                setSlotPicker(null);
                                            }}
                                            key={material.id}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Name and save the blend */}
            {nameSheetOpen ? (
                <div className="mix-sheet-mask" onClick={() => setNameSheetOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">Name this blend</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setNameSheetOpen(false)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <input className="mix-input" value={recipeName} onChange={(e) => setRecipeName(e.target.value)} placeholder="Blend name" />
                            <div className="mix-detail-label" style={{ margin: "12px 2px 6px" }}>What is in this one</div>
                            <div className="mix-detail-value">
                                {MIX_SLOT_ORDER.filter((k) => slotMaterials[k]?.length)
                                    .map((k) => `${MIX_KIND_LABELS[k]} · ${(slotMaterials[k] ?? []).map((m) => m.name).join(" + ")}`)
                                    .join("\n")}
                            </div>
                            <div className="mix-form-footer">
                                <button type="button" className="mix-ghost-btn" onClick={() => setNameSheetOpen(false)}>Not yet</button>
                                <button type="button" className="mix-brew-btn" onClick={handleSaveRecipe}>Save blend</button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Blend actions */}
            {recipeMenu ? (
                <div className="mix-sheet-mask" onClick={() => setRecipeMenu(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{recipeMenu.name}</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setRecipeMenu(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ margin: "2px 0 8px" }}>
                                {recipeMenu.imported ? (
                                    <>
                                        <AuthorAvatar name={recipeMenu.author || "Anonymous bartender"} avatar={recipeMenu.authorAvatar} />
                                        <span className="mix-author-name">@{recipeMenu.author || "Anonymous bartender"}</span>
                                    </>
                                ) : (
                                    <>
                                        <AuthorAvatar name={profile.name || "Me"} avatar={profile.avatar} />
                                        <span className="mix-author-name">{profile.name || "Me"}</span>
                                        <span className="mix-mat-stats">Publishing uses your creator profile</span>
                                    </>
                                )}
                            </div>
                            <button
                                type="button"
                                className="mix-action-row"
                                onClick={() => {
                                    setBarSlots({ ...recipeMenu.slots });
                                    setBarTab("create");
                                    setRecipeMenu(null);
                                    showToast("Loaded back onto the bar, ready to adjust.");
                                }}
                            >
                                <SlidersHorizontal size={17} />
                                <span>Load onto the bar<i>Put this blend's materials back in their slots, adjust, and save again</i></span>
                            </button>
                            {recipeMenu.imported ? null : (
                            <button
                                type="button"
                                className="mix-action-row"
                                onClick={() => {
                                    const { publishedId: _p, publishedAt: _a, imported: _i, ...rest } = recipeMenu;
                                    const now = Date.now();
                                    const dup: MixRecipe = { ...rest, id: createMixId("mixrec"), name: `${recipeMenu.name} copy`, createdAt: now, updatedAt: now };
                                    saveMixRecipe(dup);
                                    setRecipeMenu(null);
                                    refresh();
                                    showToast(`Duplicated as "${dup.name}", with no cloud link.`);
                                }}
                            >
                                <Copy size={17} />
                                <span>Duplicate blend<i>Make a new blend with no cloud link, and keep working from it</i></span>
                            </button>
                            )}
                            {recipeMenu.imported ? null : (
                            <button
                                type="button"
                                className="mix-action-row"
                                disabled={sharing}
                                onClick={() => {
                                    const target = recipeMenu;
                                    const plan = planShareRecipe(target);
                                    if (!plan.character) {
                                        showToast("This blend has no character card, so it cannot be shared.");
                                        return;
                                    }
                                    if (plan.blockers.length > 0) {
                                        showToast(`"${plan.blockers[0].name}" came in with an older blend import and has no online entry. Swap it for the version on the materials page, then share.`);
                                        return;
                                    }
                                    setRecipeMenu(null);
                                    const syncNotes = (
                                        <>
                                            {plan.toPublish.length > 0 ? (
                                                <><br /><b>{plan.toPublish.length} materials will be published to the materials page first</b> (their full contents become public and can be saved individually): {plan.toPublish.map((m) => m.name).join(", ")}.</>
                                            ) : null}
                                            {plan.toSync.length > 0 ? (
                                                <><br />Local edits to {plan.toSync.length} already-published materials will be synced: {plan.toSync.map((m) => m.name).join(", ")}.</>
                                            ) : null}
                                        </>
                                    );
                                    setConfirm(target.publishedId ? {
                                        title: "Update the version on the blends page?",
                                        body: <>This replaces the combination published for &quot;{target.name}&quot; with the current one.<br />Likes, saves and comments are all kept.{syncNotes}</>,
                                        confirmText: "Update",
                                        run: () => void handleShareRecipe(target),
                                    } : {
                                        title: "Share to the blends page?",
                                        body: <>What gets published for &quot;{target.name}&quot; is <b>the combination and its references</b>. The material content itself comes from each entry on the materials page, and anyone can import the whole thing with its materials in one step.{syncNotes}</>,
                                        confirmText: "Share",
                                        run: () => void handleShareRecipe(target),
                                    });
                                }}
                            >
                                {recipeMenu.publishedId ? <RefreshCw size={17} /> : <Share2 size={17} />}
                                <span>
                                    {recipeMenu.publishedId ? "Update the published version" : "Share to the blends page"}
                                    <i>{recipeMenu.publishedId ? "Replace the older version on the blends page with this one, keeping its social history" : "Publish it along with its materials, so others can import the whole thing"}</i>
                                </span>
                            </button>
                            )}
                            <button
                                type="button"
                                className="mix-action-row"
                                data-tone="danger"
                                onClick={() => {
                                    const target = recipeMenu;
                                    setRecipeMenu(null);
                                    setConfirm({
                                        title: "Delete this blend?",
                                        body: <>This deletes the combination &quot;{target.name}&quot; only; the materials inside it stay in your cabinet.</>,
                                        confirmText: "Delete",
                                        tone: "danger",
                                        run: () => {
                                            deleteMixRecipe(target.id);
                                            refresh();
                                            showToast("Blend poured away.");
                                        },
                                    });
                                }}
                            >
                                <Trash2 size={17} />
                                <span>Delete this blend<i>The materials stay in your cabinet; only the blend itself goes</i></span>
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Opening line picker */}
            {openingPicker && openingCard?.kind === "character" ? (
                <div className="mix-sheet-mask" onClick={() => setOpeningPicker(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">Choose an opening</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setOpeningPicker(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {(openingCard as MixCharacterCard).openings.map((opening, i) => (
                                <button type="button" className="mix-opening-option" key={i} onClick={() => startWithOpening(openingPicker, i)}>
                                    {opening.length > 120 ? `${opening.slice(0, 120)}…` : opening}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            ) : null}

            <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json,image/png,.png"
                style={{ display: "none" }}
                onChange={(e) => { void handleImportFile(e.target.files?.[0]); e.target.value = ""; }}
            />

            {/* The editor's upload-and-replace uses a separate input: it never saves to the
                cabinet, it only swaps the form */}
            <input
                ref={editorFileRef}
                type="file"
                accept="application/json,.json,image/png,.png"
                style={{ display: "none" }}
                onChange={(e) => { void handleEditorReplace(e.target.files?.[0]); e.target.value = ""; }}
            />

            {confirm ? (
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}

            {toast ? <div className="mix-toast">{toast}</div> : null}
        </div>
    );
}
