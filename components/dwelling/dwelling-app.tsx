"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, RefreshCw, Trash2, Wand2, X } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import type { DwellingLayout, DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";
import {
    loadDwellingLayout,
    saveDwellingLayout,
    clearDwellingData,
    saveItemHtml,
    loadAllItemHtmlForChar,
    loadDwellingImageEnabled,
    saveDwellingImageEnabled,
    collectRoomImageRefs,
} from "@/lib/dwelling-storage";
import { generateDwellingLayout, generateItemHtml, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { pinyin } from "pinyin-pro";
import { getDwellingImageAvailability, generateDwellingRoomImage, cancelDwellingRoomImage } from "@/lib/dwelling-image";
import { deleteMediaRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { RoomView, type DwellingRoomImageStatus } from "./room-view";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";

type DwellingAppProps = {
    onClose: () => void;
    visible?: boolean;
    onIdle?: () => void;
};

type CharState = {
    layout: DwellingLayout | null;
    isGenerating: boolean;
    error: string | null;
    loaded: boolean;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    /** roomId → image generation failure reason (if present, auto-retry stops; manual retry required) */
    imageErrors: Record<string, string>;
    /** Set of roomIds currently generating images */
    generatingImageRooms: Set<string>;
};

type ItemDetail = {
    roomId: string;
    roomName: string;
    furnitureId: string;
    furnitureLabel: string;
    furnitureIcon: string;
    itemId: string;
    itemName: string;
    itemPreview: string;
    html: string;
};

const charStates = new Map<string, CharState>();

function getCharState(charId: string): CharState {
    let s = charStates.get(charId);
    if (!s) { s = { layout: null, isGenerating: false, error: null, loaded: false, itemHtmlCache: {}, loadingItemKeys: new Set(), lastItemError: null, imageErrors: {}, generatingImageRooms: new Set() }; charStates.set(charId, s); }
    return s;
}

function itemKey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

/** mediaRef → object URL (session-level cache; images are few, so not proactively revoked) */
const roomImageUrls = new Map<string, string>();

/** Character name → uppercase pinyin (ghost text below the chip) */
const charEnCache = new Map<string, string>();
function charChipEn(name: string): string {
    let en = charEnCache.get(name);
    if (en === undefined) {
        try { en = pinyin(name, { toneType: "none" }).toUpperCase(); } catch { en = ""; }
        charEnCache.set(name, en);
    }
    return en;
}

export function DwellingApp({ onClose, visible, onIdle }: DwellingAppProps) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [activeCharId, setActiveCharId] = useState<string | null>(null);
    const [activeRoomIdx, setActiveRoomIdx] = useState(0);
    const [, forceUpdate] = useState(0);
    const rerender = () => forceUpdate(n => n + 1);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    const [itemDetail, setItemDetail] = useState<ItemDetail | null>(null);
    const [imageEnabled, setImageEnabled] = useState(true);
    const [imageConfigured, setImageConfigured] = useState(false);
    const activeCharIdRef = useRef<string | null>(null);
    const activeRoomIdxRef = useRef(0);

    useEffect(() => {
        setImageEnabled(loadDwellingImageEnabled());
        setImageConfigured(getDwellingImageAvailability().configured);
    }, []);

    useEffect(() => {
        // The user may have configured image generation in settings midway; re-check when returning to Dwelling
        if (visible) setImageConfigured(getDwellingImageAvailability().configured);
    }, [visible]);

    useEffect(() => {
        activeCharIdRef.current = activeCharId;
    }, [activeCharId]);

    useEffect(() => {
        activeRoomIdxRef.current = activeRoomIdx;
    }, [activeRoomIdx]);

    useEffect(() => {
        if (visible) {
            if (activeCharId) getCharState(activeCharId).error = null;
            rerender();
        }
    }, [visible, activeCharId]);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        if (chars.length === 1) setActiveCharId(chars[0].id);
        // Pre-load all characters' cached layouts + item HTML so ✓ shows immediately
        (async () => {
            for (const c of chars) {
                const cs = getCharState(c.id);
                if (cs.loaded) continue;
                const cached = await loadDwellingLayout(c.id);
                cs.loaded = true;
                if (cached) {
                    cs.layout = cached.layout;
                    cs.itemHtmlCache = loadAllItemHtmlForChar(c.id);
                }
            }
            rerender();
        })();
    }, []);

    useEffect(() => {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        cs.error = null;
        if (cs.loaded) { rerender(); return; }
        let cancelled = false;
        (async () => {
            const cached = await loadDwellingLayout(activeCharId);
            if (cancelled) return;
            cs.loaded = true;
            if (cached) {
                cs.layout = cached.layout;
                cs.itemHtmlCache = loadAllItemHtmlForChar(activeCharId);
            }
            rerender();
        })();
        return () => { cancelled = true; };
    }, [activeCharId]);

    const doGenerate = useCallback(async (charId: string, mode: DwellingRefreshMode = "full") => {
        const cs = getCharState(charId);
        cs.isGenerating = true;
        cs.error = null;
        if (mode === "full") {
            cs.layout = null;
            cs.itemHtmlCache = {};
        }
        rerender();

        const { layout: newLayout, error: genError } = await generateDwellingLayout(charId, mode);
        cs.isGenerating = false;
        if (!newLayout) {
            cs.error = genError || "Generation failed";
            rerender();
            if (!visible && onIdle) onIdle();
            return;
        }
        cs.layout = newLayout;
        cs.loaded = true;
        // Items mode: clear HTML cache for items with new IDs (changed items)
        if (mode === "items") {
            const newKeys = new Set<string>();
            for (const room of newLayout.rooms) {
                for (const f of room.furniture) {
                    for (const item of f.items) {
                        newKeys.add(itemKey(room.id, item.id));
                    }
                }
            }
            // Remove HTML cache entries that no longer exist (removed/changed items)
            for (const key of Object.keys(cs.itemHtmlCache)) {
                if (!newKeys.has(key)) delete cs.itemHtmlCache[key];
            }
        } else {
            cs.itemHtmlCache = {};
        }
        await saveDwellingLayout(charId, newLayout);
        rerender();
        if (!visible && onIdle) onIdle();
    }, [visible, onIdle]);

    async function handleRefresh(mode: DwellingRefreshMode) {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        setItemDetail(null);
        if (mode === "full") {
            for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
            cs.imageErrors = {};
            await clearDwellingData(activeCharId);
        }
        await doGenerate(activeCharId, mode);
    }

    async function handleDelete() {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
        await clearDwellingData(activeCharId);
        cs.layout = null;
        cs.itemHtmlCache = {};
        cs.error = null;
        cs.imageErrors = {};
        setActiveRoomIdx(0);
        setItemDetail(null);
        rerender();
    }

    // ── Room image generation ──
    const handleGenerateRoomImage = useCallback(async (charId: string, roomId: string) => {
        const cs = getCharState(charId);
        const layout = cs.layout;
        if (!layout) return;
        const room = layout.rooms.find(r => r.id === roomId);
        if (!room) return;
        if (cs.generatingImageRooms.has(roomId)) return;

        cs.generatingImageRooms.add(roomId);
        delete cs.imageErrors[roomId];
        rerender();

        const { assetId, error } = await generateDwellingRoomImage(charId, room);
        cs.generatingImageRooms.delete(roomId);

        // Layout was rebuilt/deleted during generation: discard this image
        if (cs.layout !== layout) {
            if (assetId) void deleteMediaRef(assetId);
            rerender();
            return;
        }

        if (assetId) {
            const old = room.imageAssetId;
            room.imageAssetId = assetId;
            if (old && old !== assetId) void deleteMediaRef(old);
            const url = await loadMediaObjectUrl(assetId);
            if (url) roomImageUrls.set(assetId, url);
            await saveDwellingLayout(charId, layout);
        } else {
            cs.imageErrors[roomId] = error || "Generation failed";
        }
        rerender();
    }, []);

    // Entering a room: resolve the URL if an image already exists; auto-generate if there's no image and generation is available
    const csForImage = activeCharId ? getCharState(activeCharId) : null;
    const roomForImage = csForImage?.layout?.rooms[activeRoomIdx] ?? null;
    useEffect(() => {
        if (visible === false) return;
        if (!activeCharId || !csForImage?.layout || !roomForImage) return;
        const cs = csForImage;
        const room = roomForImage;

        if (room.imageAssetId) {
            const ref = room.imageAssetId;
            if (roomImageUrls.has(ref)) return;
            let cancelled = false;
            (async () => {
                const url = await loadMediaObjectUrl(ref);
                if (cancelled) return;
                if (url) {
                    roomImageUrls.set(ref, url);
                } else if (cs.layout && cs.layout.rooms.includes(room)) {
                    // Media was lost: clear the reference, fall back to the ambient background, and allow regeneration
                    room.imageAssetId = undefined;
                    void saveDwellingLayout(activeCharId, cs.layout);
                }
                rerender();
            })();
            return () => { cancelled = true; };
        }

        if (imageEnabled && imageConfigured && !cs.generatingImageRooms.has(room.id) && !cs.imageErrors[room.id]) {
            void handleGenerateRoomImage(activeCharId, room.id);
        }
    }, [activeCharId, activeRoomIdx, imageEnabled, imageConfigured, visible, csForImage, roomForImage, handleGenerateRoomImage]);

    function openItemDetail(room: DwellingRoom, furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) {
        setItemDetail({
            roomId: room.id,
            roomName: room.name,
            furnitureId: furniture.id,
            furnitureLabel: furniture.label,
            furnitureIcon: furniture.icon,
            itemId: item.id,
            itemName: item.name,
            itemPreview: item.preview,
            html,
        });
    }

    // ── Explore single item (called from RoomView) ──
    async function handleExploreItem(charId: string, roomId: string, furniture: DwellingFurniture, item: DwellingFurnitureItem) {
        const cs = getCharState(charId);
        const room = cs.layout?.rooms.find(r => r.id === roomId);
        if (!room) return;

        const key = itemKey(roomId, item.id);
        if (cs.loadingItemKeys.has(key)) return; // already loading
        cs.loadingItemKeys.add(key);
        cs.lastItemError = null;
        rerender();

        const { html, error } = await generateItemHtml(charId, room.name, furniture.label, item.name, item.preview);

        cs.loadingItemKeys.delete(key);
        if (html) {
            cs.itemHtmlCache[key] = html;
            void saveItemHtml(charId, roomId, item.id, html);
            const currentRoom = activeCharIdRef.current === charId ? cs.layout?.rooms[activeRoomIdxRef.current] : null;
            if (currentRoom?.id === roomId) openItemDetail(room, furniture, item, html);
        }
        cs.lastItemError = error || null;
        rerender();
    }

    const cs = activeCharId ? getCharState(activeCharId) : null;
    const activeRoom = cs?.layout?.rooms[activeRoomIdx] ?? null;

    return (
        <div className="dwelling-app" data-haspicker={characters.length > 1 ? "true" : undefined}>
            <div className="dwelling-header">
                <button className="dw-back" onClick={onClose}><ChevronLeft size={18} /></button>
                <h1>Dwelling<span className="dw-title-en">DWELLING</span></h1>
            </div>

            {characters.length > 1 && (
                <div className="dwelling-char-picker">
                    {characters.map(c => {
                        const s = getCharState(c.id);
                        return (
                            <button key={c.id} className="dwelling-char-chip"
                                data-active={activeCharId === c.id ? "true" : undefined}
                                onClick={() => { setActiveCharId(c.id); setActiveRoomIdx(0); setItemDetail(null); }}>
                                <span className="dw-chip-zh">{c.name}{s.isGenerating ? " …" : s.layout ? " ✓" : ""}</span>
                                {charChipEn(c.name) && <span className="dw-chip-en">{charChipEn(c.name)}</span>}
                            </button>
                        );
                    })}
                </div>
            )}

            {!activeCharId && characters.length > 1 && (
                <div className="dwelling-empty"><span>Select a character to explore their dwelling</span></div>
            )}
            {characters.length === 0 && (
                <div className="dwelling-empty"><span>No characters yet, go create one</span></div>
            )}
            {cs?.isGenerating && !cs.layout && (
                <div className="dwelling-loading"><div className="dwelling-spinner" /><span className="dwelling-loading-text">Peeking into the room…</span></div>
            )}
            {cs?.isGenerating && cs.layout && (
                <div className="dwelling-loading-bar"><span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /><span>Refreshing…</span></div>
            )}
            {cs && (cs.error || cs.lastItemError) && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">{cs.error ? "Generation Failed" : "Exploration Failed"}</div>
                        <div className="dw-confirm-msg dw-error-msg">{cs.error || cs.lastItemError}</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }}>Got it</button>
                        </div>
                    </div>
                </div>
            )}
            {activeCharId && cs?.loaded && !cs.layout && !cs.isGenerating && (
                <div className="dwelling-empty">
                    <span>Their room hasn't been generated yet</span>
                    <button className="dwelling-generate-btn" onClick={() => doGenerate(activeCharId)}>
                        <Wand2 size={16} />Generate Room
                    </button>
                </div>
            )}

            {cs?.layout && (
                <div className="dwelling-room-tabs">
                    {cs.layout.rooms.map((room, idx) => (
                        <button key={room.id} className="dwelling-room-tab"
                            data-active={activeRoomIdx === idx ? "true" : undefined}
                            onClick={() => { setActiveRoomIdx(idx); setItemDetail(null); }}>
                            {room.name}
                            {room.en && <span className="dw-tab-en">{room.en}</span>}
                        </button>
                    ))}
                    <div className="dw-tabs-actions">
                        <button className="dw-tab-action" onClick={() => setShowRefreshConfirm(true)} disabled={cs.isGenerating} title="Regenerate">
                            <RefreshCw size={13} />
                        </button>
                        <button className="dw-tab-action dw-tab-action-danger" onClick={() => setShowDeleteConfirm(true)} disabled={cs.isGenerating} title="Delete Layout">
                            <Trash2 size={13} />
                        </button>
                    </div>
                </div>
            )}

            {activeRoom && cs && (() => {
                const assetUrl = activeRoom.imageAssetId ? roomImageUrls.get(activeRoom.imageAssetId) ?? null : null;
                let imageStatus: DwellingRoomImageStatus = "ambient";
                if (cs.generatingImageRooms.has(activeRoom.id)) imageStatus = "generating";
                else if (imageEnabled && assetUrl) imageStatus = "ready";
                else if (imageEnabled && imageConfigured && cs.imageErrors[activeRoom.id]) imageStatus = "failed";
                return (
                    <RoomView
                        room={activeRoom}
                        itemHtmlCache={cs.itemHtmlCache}
                        loadingItemKeys={cs.loadingItemKeys}
                        lastItemError={cs.lastItemError}
                        onExploreItem={(furniture, item) => handleExploreItem(activeCharId!, activeRoom.id, furniture, item)}
                        onOpenItem={(furniture, item, html) => openItemDetail(activeRoom, furniture, item, html)}
                        onMoveMarker={(furnitureId, marker) => {
                            if (!activeCharId || !cs.layout) return;
                            const roomIdx = cs.layout.rooms.indexOf(activeRoom);
                            if (roomIdx < 0) return;
                            // Immutable update: the room object gets a new reference so RoomView recalculates the marker layout right away
                            cs.layout.rooms[roomIdx] = {
                                ...activeRoom,
                                furniture: activeRoom.furniture.map(f => f.id === furnitureId ? { ...f, marker } : f),
                            };
                            void saveDwellingLayout(activeCharId, cs.layout);
                            rerender();
                        }}
                        imageUrl={imageEnabled ? assetUrl : null}
                        imageStatus={imageStatus}
                        imageError={cs.imageErrors[activeRoom.id] ?? null}
                        imageEnabled={imageEnabled}
                        imageConfigured={imageConfigured}
                        onToggleImage={() => {
                            const next = !imageEnabled;
                            setImageEnabled(next);
                            saveDwellingImageEnabled(next);
                            // Re-enabling the toggle is treated as wanting to retry: clear failure records so auto-generation triggers again
                            if (next) cs.imageErrors = {};
                        }}
                        onRetryImage={() => { if (activeCharId) void handleGenerateRoomImage(activeCharId, activeRoom.id); }}
                        onCancelImage={() => { if (activeCharId) cancelDwellingRoomImage(activeCharId, activeRoom.id); }}
                    />
                );
            })()}
            {itemDetail && (
                <div className="dwelling-detail-overlay" data-show="true">
                    <div className="dwelling-items-shade" onClick={() => setItemDetail(null)} />
                    <div className="dwelling-detail-card" role="dialog" aria-modal="true" aria-label={itemDetail.itemName}>
                        <div className="dwelling-items-header">
                            <div className="dwelling-detail-heading">
                                <div className="dwelling-detail-name">{itemDetail.itemName}</div>
                                <div className="dwelling-detail-location">{itemDetail.roomName} · {itemDetail.furnitureLabel}</div>
                            </div>
                            <button className="dwelling-items-close" onClick={() => setItemDetail(null)} aria-label="Close">
                                <X size={13} />
                            </button>
                        </div>
                        <div className="dwelling-detail-preview">{itemDetail.itemPreview}</div>
                        <div className="dwelling-detail-html">
                            <StoryHtmlRenderer
                                content={itemDetail.html}
                                messageId={`dw-detail-${itemDetail.roomId}-${itemDetail.furnitureId}-${itemDetail.itemId}`}
                                htmlPageMode="contained"
                            />
                        </div>
                    </div>
                </div>
            )}
            {/* Refresh confirm dialog */}
            {showRefreshConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowRefreshConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">Refresh Room</div>
                        <div className="dw-confirm-msg">Choose a refresh method</div>
                        <div className="dw-confirm-actions-col">
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("items"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>Refresh Items</strong>
                                    <small>Keep rooms and furniture, only update items</small>
                                </span>
                            </button>
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("full"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>Full Rebuild</strong>
                                    <small>Regenerate all rooms, furniture, and items</small>
                                </span>
                            </button>
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" style={{ marginTop: 4 }} onClick={() => setShowRefreshConfirm(false)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete confirm dialog */}
            {showDeleteConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowDeleteConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">Leave this place?</div>
                        <div className="dw-confirm-msg">Everything in the room will disappear<br />including items you've already explored</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowDeleteConfirm(false)}>Let Me Think</button>
                            <button className="dw-confirm-btn dw-confirm-btn-danger" onClick={() => { setShowDeleteConfirm(false); handleDelete(); }}>Wave Goodbye</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
