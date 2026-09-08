"use client";

// components/studio/studio-app.tsx
// Studio -- author an AI-triggerable directive card (a boarding pass, a café menu) once, and
// it automatically reaches chat, story AND offline mode, since all three read the same merged
// directive list (lib/custom-app-chat-directives.ts's loadCustomAppChatDirectives()). See
// PROACTIVE-MESSAGE-2.0-PLAN.md's HTML-trigger-cards plan for why this is its own app rather
// than folded into an existing one, and why a Studio card is never written into the shared
// installed-apps store.
//
// The live preview below reuses AppCardView directly (the exact component chat/story/offline
// render a triggered card with) so what the author sees while typing is the real, sandboxed
// rendering -- not a guess at it. Passing appId={STUDIO_APP_ID} into the preview also means
// clicking it opens the same in-place detail popup a real trigger would, so the "click a
// Studio card -> see a summary, not a full app" behavior is dogfooded here too.

import { useMemo, useState } from "react";
import { IdCard, Plus, Trash2, Pencil } from "lucide-react";

import { PageShell, Button, Input, Textarea, EmptyState, GlassCard, Badge, MenuToggleRow } from "@/components/ui";
import { AppCardView } from "@/components/chat/app-card-view";
import {
    loadStudioCards,
    saveStudioCard,
    deleteStudioCard,
    STUDIO_APP_ID,
    type StudioCard,
    type StudioCardInput,
} from "@/lib/card-studio-storage";
import type { CustomAppCardScopeMode } from "@/lib/custom-app-types";

const ALL_SCOPE_MODES: CustomAppCardScopeMode[] = ["chat", "story", "offline"];
const SCOPE_MODE_LABELS: Record<CustomAppCardScopeMode, { label: string; desc: string }> = {
    chat: { label: "Chat", desc: "Trigger this card in live chat" },
    story: { label: "Story", desc: "Trigger this card in Story mode" },
    offline: { label: "Offline", desc: "Trigger this card in Offline mode" },
};

type Props = {
    onClose: () => void;
    onNotice?: (text: string) => void;
};

type Screen = { mode: "list" } | { mode: "edit"; id: string | null };

const EMPTY_DRAFT: StudioCardInput = {
    name: "",
    syntax: "",
    description: "",
    html: "",
    accentColor: "",
    height: 220,
    scope: undefined,
};

function draftFromCard(card: StudioCard): StudioCardInput {
    return {
        name: card.name,
        syntax: card.syntax,
        description: card.description,
        html: card.html,
        accentColor: card.accentColor ?? "",
        height: card.height ?? 220,
        scope: card.scope,
    };
}

export function StudioApp({ onClose, onNotice }: Props) {
    const [screen, setScreen] = useState<Screen>({ mode: "list" });
    const [refreshKey, setRefreshKey] = useState(0);
    const [draft, setDraft] = useState<StudioCardInput>(EMPTY_DRAFT);

    const cards = useMemo(() => loadStudioCards(), [refreshKey]);

    const bump = () => setRefreshKey(key => key + 1);

    const openNew = () => {
        setDraft(EMPTY_DRAFT);
        setScreen({ mode: "edit", id: null });
    };

    const openEdit = (card: StudioCard) => {
        setDraft(draftFromCard(card));
        setScreen({ mode: "edit", id: card.id });
    };

    const handleDelete = (card: StudioCard) => {
        if (!deleteStudioCard(card.id)) return;
        onNotice?.(`Deleted "${card.name}"`);
        bump();
    };

    const handleSave = () => {
        if (screen.mode !== "edit") return;
        const saved = saveStudioCard(draft, screen.id ?? undefined);
        if (!saved) {
            onNotice?.("Name and HTML are both required.");
            return;
        }
        onNotice?.(screen.id ? `Saved "${saved.name}"` : `Created "${saved.name}"`);
        bump();
        setScreen({ mode: "list" });
    };

    // Which surfaces this card is allowed to trigger on -- undefined/empty scope means
    // unrestricted (every mode checked), matching lib/custom-app-chat-directives.ts's own
    // directiveMatchesScope() reading of it.
    const effectiveScope = draft.scope && draft.scope.length > 0 ? draft.scope : ALL_SCOPE_MODES;
    const toggleScope = (mode: CustomAppCardScopeMode) => {
        setDraft(prev => {
            const current = prev.scope && prev.scope.length > 0 ? prev.scope : ALL_SCOPE_MODES;
            const isOn = current.includes(mode);
            if (isOn) {
                const next = current.filter(m => m !== mode);
                if (next.length === 0) return prev; // never allow a card scoped to nowhere
                return { ...prev, scope: next };
            }
            const next = [...current, mode];
            return { ...prev, scope: next.length === ALL_SCOPE_MODES.length ? undefined : next };
        });
    };

    if (screen.mode === "list") {
        return (
            <PageShell
                title="Studio"
                onBack={onClose}
                rightAction={
                    <Button variant="ghost" aria-label="New card" onClick={openNew}>
                        <Plus size={18} strokeWidth={1.8} />
                    </Button>
                }
            >
                <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 4px 24px" }}>
                    <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
                        Author a clickable card once and the character can trigger it in chat, story, and
                        offline mode -- all three read the same card list automatically.
                    </p>
                    {cards.length === 0 ? (
                        <EmptyState
                            icon={IdCard}
                            message="No cards yet. Create one to give the character something it can trigger -- a boarding pass, a menu, a receipt."
                            action={<Button onClick={openNew}>New card</Button>}
                        />
                    ) : (
                        <GlassCard>
                            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                                {cards.map(card => (
                                    <li key={card.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                                <span style={{ fontWeight: 500 }}>{card.name}</span>
                                                <Badge>{card.syntax}</Badge>
                                                {card.scope && card.scope.length > 0 ? (
                                                    <Badge>{card.scope.map(mode => SCOPE_MODE_LABELS[mode].label).join(" + ")}</Badge>
                                                ) : null}
                                            </div>
                                            {card.description ? (
                                                <div style={{ opacity: 0.65, fontSize: 12.5, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {card.description}
                                                </div>
                                            ) : null}
                                        </div>
                                        <Button variant="ghost" aria-label={`Edit ${card.name}`} onClick={() => openEdit(card)}>
                                            <Pencil size={16} strokeWidth={1.6} />
                                        </Button>
                                        <Button variant="ghost" aria-label={`Delete ${card.name}`} onClick={() => handleDelete(card)}>
                                            <Trash2 size={16} strokeWidth={1.6} />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </GlassCard>
                    )}
                </div>
            </PageShell>
        );
    }

    // ── Editor ──
    const previewLayout = {
        html: draft.html,
        accentColor: draft.accentColor || undefined,
        height: draft.height || 220,
    };

    return (
        <PageShell title={screen.id ? "Edit Card" : "New Card"} onBack={() => setScreen({ mode: "list" })}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 4px 24px" }}>
                <GlassCard>
                    <h3 style={{ margin: "0 0 12px" }}>Trigger</h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ fontSize: 12.5, opacity: 0.7 }}>Name</span>
                            <Input
                                placeholder="Boarding Pass"
                                value={draft.name}
                                onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
                            />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ fontSize: 12.5, opacity: 0.7 }}>
                                Trigger tag -- what the AI must write to show this card
                            </span>
                            <Input
                                placeholder={draft.name ? `[${draft.name.replace(/[^A-Za-z0-9]/g, "") || "Card"}]` : "[BoardingPass]"}
                                value={draft.syntax ?? ""}
                                onChange={event => setDraft(prev => ({ ...prev, syntax: event.target.value }))}
                            />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ fontSize: 12.5, opacity: 0.7 }}>
                                Instruction -- taught to the AI verbatim, so say when it should use this
                            </span>
                            <Textarea
                                placeholder="Use this when the two of you board a flight together, to show a boarding pass."
                                rows={3}
                                value={draft.description}
                                onChange={event => setDraft(prev => ({ ...prev, description: event.target.value }))}
                            />
                        </label>
                    </div>
                </GlassCard>

                <GlassCard>
                    <h3 style={{ margin: "0 0 4px" }}>Scope</h3>
                    <p style={{ fontSize: 12.5, opacity: 0.7, margin: "0 0 12px" }}>
                        Where this specific card is allowed to trigger. Uncheck a mode to keep this
                        design out of it -- a boarding pass might only make sense in Story, for example.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {ALL_SCOPE_MODES.map(mode => (
                            <MenuToggleRow
                                key={mode}
                                label={SCOPE_MODE_LABELS[mode].label}
                                desc={SCOPE_MODE_LABELS[mode].desc}
                                checked={effectiveScope.includes(mode)}
                                onChange={() => toggleScope(mode)}
                            />
                        ))}
                    </div>
                </GlassCard>

                <GlassCard>
                    <h3 style={{ margin: "0 0 12px" }}>Card HTML</h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <Textarea
                            placeholder={"<div style=\"padding:14px\">\n  <b>ATH → JTR</b>\n  <div>Seat 12A</div>\n</div>"}
                            rows={10}
                            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 }}
                            value={draft.html}
                            onChange={event => setDraft(prev => ({ ...prev, html: event.target.value }))}
                        />
                        <div style={{ display: "flex", gap: 8 }}>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                                <span style={{ fontSize: 12.5, opacity: 0.7 }}>Accent color (optional)</span>
                                <Input
                                    placeholder="#d98f9b"
                                    value={draft.accentColor ?? ""}
                                    onChange={event => setDraft(prev => ({ ...prev, accentColor: event.target.value }))}
                                />
                            </label>
                            <label style={{ display: "flex", flexDirection: "column", gap: 4, width: 110 }}>
                                <span style={{ fontSize: 12.5, opacity: 0.7 }}>Height (px)</span>
                                <Input
                                    type="number"
                                    value={String(draft.height ?? 220)}
                                    onChange={event => setDraft(prev => ({ ...prev, height: Number(event.target.value) || 220 }))}
                                />
                            </label>
                        </div>
                    </div>
                </GlassCard>

                <GlassCard>
                    <h3 style={{ margin: "0 0 12px" }}>Live preview</h3>
                    {draft.html.trim() ? (
                        <AppCardView
                            appCardLayout={previewLayout}
                            appName="Studio"
                            appId={STUDIO_APP_ID}
                            onOpen={() => {}}
                        />
                    ) : (
                        <EmptyState message="Write some HTML above to see it rendered here." />
                    )}
                </GlassCard>

                <Button onClick={handleSave}>{screen.id ? "Save changes" : "Create card"}</Button>
            </div>
        </PageShell>
    );
}
