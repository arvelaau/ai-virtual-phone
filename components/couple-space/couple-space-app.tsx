"use client";

import { useEffect, useMemo, useState } from "react";
import { Heart, Gift, Plus, Trash2, Check } from "lucide-react";

import { PageShell, Button, Input, Textarea, Select, EmptyState, GlassCard, Badge } from "@/components/ui";
import { loadCharacters } from "@/lib/character-storage";
import {
    addAnniversary,
    addWishlistItem,
    deleteAnniversary,
    deleteWishlistItem,
    fulfillWishlistItem,
    addReflection,
    deleteReflection,
    loadCoupleSpaceState,
    loadReflections,
    loadUpcomingAnniversaries,
    todayYmd,
} from "@/lib/couple-space-storage";
import {
    deleteCoupleSpaceProjectionEventsForAnniversary,
    deleteCoupleSpaceProjectionEventsForWish,
    formatAnniversaryDateLabel,
    recordAnniversaryAddedEvent,
    recordWishlistAddedEvent,
    recordWishlistFulfilledEvent,
    recordReflectionEvent,
    deleteCoupleSpaceProjectionEventsForReflection,
} from "@/lib/couple-space-memory";
import { loadGiftHistory, syncGiftProvenanceFromMessages } from "@/lib/gift-provenance";
import type { GiftProvenanceRecord } from "@/lib/gift-provenance";
import type { ReflectionEntry, UpcomingAnniversary, WishlistItem } from "@/lib/couple-space-types";

// Couple Space is per-character: one space per relationship, selected at the top.
//
// Storage CRUD and the projection recorders are called side by side here on purpose --
// couple-space-storage.ts must not import couple-space-memory.ts, or it stops being a leaf
// and closes an import cycle with llm-prompt-assembler (see CLAUDE.md). Note-wall does the
// same thing for the same reason.

type Props = {
    onClose: () => void;
    onNotice?: (text: string) => void;
};

function describeDaysUntil(daysUntil: number): string {
    if (daysUntil === 0) return "Today";
    if (daysUntil === 1) return "Tomorrow";
    if (daysUntil < 0) return `${Math.abs(daysUntil)} days ago`;
    return `In ${daysUntil} days`;
}

export function CoupleSpaceApp({ onClose, onNotice }: Props) {
    const characters = useMemo(() => loadCharacters(), []);
    const [characterId, setCharacterId] = useState<string>(() => characters[0]?.id ?? "");
    const [refreshKey, setRefreshKey] = useState(0);

    const [annTitle, setAnnTitle] = useState("");
    const [annDate, setAnnDate] = useState(() => todayYmd());
    const [wishTitle, setWishTitle] = useState("");
    const [wishFor, setWishFor] = useState<"character" | "user">("character");
    const [reflectionTitle, setReflectionTitle] = useState("");
    const [reflectionBody, setReflectionBody] = useState("");

    const characterName = characters.find(c => c.id === characterId)?.name ?? "";

    // Gift history is derived from chat messages; syncing on open keeps it current without
    // touching the send path. Idempotent, so repeating it is free.
    useEffect(() => {
        if (!characterId) return;
        syncGiftProvenanceFromMessages();
        setRefreshKey(key => key + 1);
    }, [characterId]);

    const upcoming: UpcomingAnniversary[] = useMemo(
        () => (characterId ? loadUpcomingAnniversaries(characterId) : []),
        [characterId, refreshKey],
    );
    const wishlist: WishlistItem[] = useMemo(
        () => (characterId ? loadCoupleSpaceState(characterId).wishlist : []),
        [characterId, refreshKey],
    );
    const reflections: ReflectionEntry[] = useMemo(
        () => (characterId ? loadReflections(characterId) : []),
        [characterId, refreshKey],
    );
    const gifts: GiftProvenanceRecord[] = useMemo(
        () => (characterId ? loadGiftHistory({ characterId, excludeGroup: true, limit: 20 }) : []),
        [characterId, refreshKey],
    );

    const bump = () => setRefreshKey(key => key + 1);

    const handleAddAnniversary = () => {
        if (!characterId || !annTitle.trim()) return;
        const created = addAnniversary(characterId, { title: annTitle, date: annDate });
        if (!created) {
            onNotice?.("Enter a title and a valid date.");
            return;
        }
        recordAnniversaryAddedEvent({ characterId, anniversary: created });
        setAnnTitle("");
        bump();
        onNotice?.("Anniversary saved");
    };

    const handleDeleteAnniversary = (id: string) => {
        if (!deleteAnniversary(characterId, id)) return;
        deleteCoupleSpaceProjectionEventsForAnniversary(characterId, id);
        bump();
    };

    const handleAddWish = () => {
        if (!characterId || !wishTitle.trim()) return;
        const created = addWishlistItem(characterId, { title: wishTitle, wantedBy: wishFor });
        if (!created) return;
        recordWishlistAddedEvent({ characterId, characterName, item: created });
        setWishTitle("");
        bump();
        onNotice?.("Added to the wishlist");
    };

    const handleFulfil = (id: string) => {
        const updated = fulfillWishlistItem(characterId, id);
        if (!updated) return;
        recordWishlistFulfilledEvent({ characterId, item: updated });
        bump();
    };

    const handleDeleteWish = (id: string) => {
        if (!deleteWishlistItem(characterId, id)) return;
        deleteCoupleSpaceProjectionEventsForWish(characterId, id);
        bump();
    };

    const handleAddReflection = () => {
        if (!characterId || !reflectionBody.trim()) return;
        const created = addReflection(characterId, { title: reflectionTitle, body: reflectionBody });
        if (!created) return;
        recordReflectionEvent({ characterId, characterName, reflection: created });
        setReflectionTitle("");
        setReflectionBody("");
        bump();
        onNotice?.("Reflection saved");
    };

    const handleDeleteReflection = (id: string) => {
        if (!deleteReflection(characterId, id)) return;
        deleteCoupleSpaceProjectionEventsForReflection(characterId, id);
        bump();
    };

    if (characters.length === 0) {
        return (
            <PageShell title="Couple Space" onBack={onClose}>
                <EmptyState icon={Heart} message="Create a character first, then come back to set up your Couple Space." />
            </PageShell>
        );
    }

    const wanted = wishlist.filter(item => item.status === "wanted");
    const fulfilled = wishlist.filter(item => item.status === "fulfilled");

    return (
        <PageShell title="Couple Space" onBack={onClose}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 4px 24px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 13, opacity: 0.75 }}>Relationship</span>
                    <Select value={characterId} onChange={event => setCharacterId(event.target.value)}>
                        {characters.map(character => (
                            <option key={character.id} value={character.id}>{character.name}</option>
                        ))}
                    </Select>
                </label>

                {/* ── Anniversaries ── */}
                <GlassCard>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px" }}>
                        <Heart size={18} strokeWidth={1.6} /> Anniversaries
                    </h3>
                    {upcoming.length === 0 ? (
                        <EmptyState icon={Heart} message="Add the dates that matter to the two of you." />
                    ) : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                            {upcoming.map(entry => (
                                <li key={entry.anniversary.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 500 }}>{entry.anniversary.title}</div>
                                        <div style={{ opacity: 0.7, fontSize: 13 }}>
                                            {formatAnniversaryDateLabel(entry.nextDate)}
                                            {typeof entry.yearsSince === "number" && entry.yearsSince > 0
                                                ? ` · ${entry.yearsSince} ${entry.yearsSince === 1 ? "year" : "years"}`
                                                : ""}
                                        </div>
                                    </div>
                                    <Badge>{describeDaysUntil(entry.daysUntil)}</Badge>
                                    <Button
                                        variant="ghost"
                                        aria-label={`Delete ${entry.anniversary.title}`}
                                        onClick={() => handleDeleteAnniversary(entry.anniversary.id)}
                                    >
                                        <Trash2 size={16} strokeWidth={1.6} />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <Input
                            placeholder="What are you marking?"
                            value={annTitle}
                            onChange={event => setAnnTitle(event.target.value)}
                        />
                        <Input type="date" value={annDate} onChange={event => setAnnDate(event.target.value)} />
                        <Button onClick={handleAddAnniversary} aria-label="Add anniversary">
                            <Plus size={16} strokeWidth={1.8} />
                        </Button>
                    </div>
                </GlassCard>

                {/* ── Wishlist ── */}
                <GlassCard>
                    <h3 style={{ margin: "0 0 12px" }}>Wishlist</h3>
                    {wanted.length === 0 ? (
                        <EmptyState message="Note things either of you would love." />
                    ) : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                            {wanted.map(item => (
                                <li key={item.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 500 }}>{item.title}</div>
                                        <div style={{ opacity: 0.7, fontSize: 13 }}>
                                            {item.wantedBy === "character" ? `For ${characterName || "them"}` : "For you"}
                                            {item.priceLabel ? ` · ${item.priceLabel}` : ""}
                                        </div>
                                    </div>
                                    <Button variant="ghost" aria-label={`Mark ${item.title} fulfilled`} onClick={() => handleFulfil(item.id)}>
                                        <Check size={16} strokeWidth={1.8} />
                                    </Button>
                                    <Button variant="ghost" aria-label={`Delete ${item.title}`} onClick={() => handleDeleteWish(item.id)}>
                                        <Trash2 size={16} strokeWidth={1.6} />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {fulfilled.length > 0 && (
                        <p style={{ opacity: 0.65, fontSize: 13, marginTop: 10 }}>
                            {fulfilled.length} already fulfilled.
                        </p>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <Input
                            placeholder="Add something to the list"
                            value={wishTitle}
                            onChange={event => setWishTitle(event.target.value)}
                        />
                        <Select value={wishFor} onChange={event => setWishFor(event.target.value as "character" | "user")}>
                            <option value="character">For them</option>
                            <option value="user">For me</option>
                        </Select>
                        <Button onClick={handleAddWish} aria-label="Add wish">
                            <Plus size={16} strokeWidth={1.8} />
                        </Button>
                    </div>
                </GlassCard>

                {/* ── Reflections ── */}
                <GlassCard>
                    <h3 style={{ margin: "0 0 12px" }}>Reflections</h3>
                    {reflections.length === 0 ? (
                        <EmptyState message="Write down what this relationship feels like. Reflections become part of what they remember." />
                    ) : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                            {reflections.map(entry => (
                                <li key={entry.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        {entry.title && <div style={{ fontWeight: 500 }}>{entry.title}</div>}
                                        {/* pre-wrap: reflections are multi-paragraph and the store keeps line breaks */}
                                        <div style={{ whiteSpace: "pre-wrap", opacity: 0.85, fontSize: 14 }}>{entry.body}</div>
                                        <div style={{ opacity: 0.55, fontSize: 12, marginTop: 4 }}>
                                            {entry.author === "character" ? characterName || "Them" : "You"} · {entry.createdAt.slice(0, 10)}
                                        </div>
                                    </div>
                                    <Button variant="ghost" aria-label="Delete reflection" onClick={() => handleDeleteReflection(entry.id)}>
                                        <Trash2 size={16} strokeWidth={1.6} />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                        <Input
                            placeholder="Title (optional)"
                            value={reflectionTitle}
                            onChange={event => setReflectionTitle(event.target.value)}
                        />
                        <Textarea
                            placeholder="What do you want to remember about this?"
                            rows={4}
                            value={reflectionBody}
                            onChange={event => setReflectionBody(event.target.value)}
                        />
                        <Button onClick={handleAddReflection}>Save reflection</Button>
                    </div>
                </GlassCard>

                {/* ── Gift history (read-only, derived from chat) ── */}
                <GlassCard>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px" }}>
                        <Gift size={18} strokeWidth={1.6} /> Gift history
                    </h3>
                    {gifts.length === 0 ? (
                        <EmptyState icon={Gift} message="Gifts sent in chat show up here automatically." />
                    ) : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                            {gifts.map(record => (
                                <li key={record.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 500 }}>{record.productName || "A gift"}</div>
                                        <div style={{ opacity: 0.7, fontSize: 13 }}>
                                            {record.direction === "user_to_character"
                                                ? `You gave ${characterName || "them"}`
                                                : `${characterName || "They"} gave you`}
                                            {record.priceLabel ? ` · ${record.priceLabel}` : ""}
                                        </div>
                                    </div>
                                    <span style={{ opacity: 0.6, fontSize: 12, whiteSpace: "nowrap" }}>
                                        {record.sentAt.slice(0, 10)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </GlassCard>
            </div>
        </PageShell>
    );
}
