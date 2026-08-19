"use client";

// House Special -- shared UI pieces: material cards, kind icons, detail field rendering.
// Used by both the cabinet (local) and the menu/hall (online), so the two share one visual
// language.

import type { ReactNode } from "react";
import {
    BookOpen,
    CircleUserRound,
    Cog,
    Feather,
    Filter,
    Flame,
    GlassWater,
    Music4,
    ReceiptText,
    Sparkles,
    UserRound,
} from "lucide-react";
import type { MixCharacterCard, MixMaterial, MixMaterialKind } from "@/lib/mixology/types";
import { MIX_DOCK_LABELS, MIX_KIND_LABELS, mixEncoreRenderHtml, mixKindHasCover, mixKindRunsActiveCode, normalizeMixTags } from "@/lib/mixology/types";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { MixRichText } from "./rich-text";

const KIND_ICONS: Record<MixMaterialKind, typeof UserRound> = {
    character: UserRound,
    persona: CircleUserRound,
    base: BookOpen,
    flavor: Feather,
    glass: GlassWater,
    strength: Flame,
    ticket: ReceiptText,
    garnish: Sparkles,
    encore: Music4,
    filter: Filter,
    mechanism: Cog,
};

export function KindGlyph({ kind, size = 26 }: { kind: MixMaterialKind; size?: number }) {
    const Icon = KIND_ICONS[kind];
    return <Icon size={size} strokeWidth={1.6} />;
}

/**
 * The author's small avatar, falling back to a disc with the first letter of the name. Shared
 * by the online detail view, the cabinet detail view and the creator profile entry point.
 * `name` must be given THE NAME ACTUALLY SHOWN NEXT TO IT ("Me" when you have not set a pen
 * name, "Anonymous bartender" when somebody else left theirs blank), or the letter on the disc
 * will not match the name beside it.
 */
export function AuthorAvatar({ name, avatar, size = 32 }: { name?: string; avatar?: string; size?: number }) {
    const display = (name ?? "").trim() || "Me";
    if (avatar) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img className="mix-avatar" src={avatar} alt={display} style={{ width: size, height: size }} />;
    }
    return <span className="mix-avatar-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}>{display.slice(0, 1)}</span>;
}

export function formatMixTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Tags on the card face: one line only, with anything that does not fit ellipsed away -- the
 * full set is in the detail dialog.
 * Inline spans rather than inline-block, because that is what lets text-overflow put the
 * ellipsis on a tag that is cut in half.
 */
function TagLine({ tags, className }: { tags?: string[]; className: string }) {
    // Normalize before rendering: imported JSON can contain anything, and dirty data must not
    // be able to break the card
    const list = normalizeMixTags(tags);
    if (!list.length) return null;
    return (
        <div className={className}>
            {list.map((tag) => (
                <span className="mix-tag" key={tag}>{tag}</span>
            ))}
        </div>
    );
}

/**
 * The full tag set in the detail dialog: wrapped out in full, never ellipsed.
 * No "Tags" subheading -- tags already look like tags, so a label line above them is just
 * clutter.
 */
export function MixTagList({ tags }: { tags?: string[] }) {
    const list = normalizeMixTags(tags);
    if (!list.length) return null;
    return (
        <div className="mix-detail-field">
            <div className="mix-tag-list">
                {list.map((tag) => (
                    <span className="mix-tag" key={tag}>{tag}</span>
                ))}
            </div>
        </div>
    );
}

/** The masonry card, shared by the local cabinet and the online menu (only online cards pass
 *  a stats row) */
export function MatCard({
    kind,
    name,
    hook,
    tags,
    cover,
    badge,
    author,
    stats,
    onClick,
}: {
    kind: MixMaterialKind;
    name: string;
    hook?: string;
    tags?: string[];
    cover?: string;
    badge?: string;
    author?: string;
    stats?: string;
    onClick: () => void;
}) {
    // The card shape follows the KIND alone, never whether a cover happens to exist --
    // otherwise the ones with images would be tall and the ones without short, and the two
    // columns would go ragged. The visual kinds (character card / receipt / garnish / encore)
    // are always poster-shaped, using a same-size placeholder face when there is no image, and
    // the text-only kinds (base / flavor / glassware / bitters) are always single-column bars.
    if (mixKindHasCover(kind)) {
        return (
            <div className="mix-mat-card" data-kind={kind} data-poster="true" onClick={onClick}>
                {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="mix-mat-cover" src={cover} alt={name} />
                ) : (
                    <div className="mix-poster-blank"><KindGlyph kind={kind} size={42} /></div>
                )}
                {author ? <div className="mix-poster-author">@{author}</div> : null}
                {badge ? <div className="mix-poster-badge">{badge}</div> : null}
                <div className="mix-poster-veil">
                    <div className="mix-poster-name">{name}</div>
                    {hook ? <div className="mix-poster-hook">{hook}</div> : null}
                    <TagLine tags={tags} className="mix-poster-tags" />
                    {stats ? <div className="mix-poster-stats">{stats}</div> : null}
                </div>
            </div>
        );
    }

    return (
        <div className="mix-mat-row" data-kind={kind} onClick={onClick}>
            <div className="mix-mat-row-glyph"><KindGlyph kind={kind} size={22} /></div>
            <div className="mix-mat-info">
                <div className="mix-mat-name">
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                    {badge ? <span className="mix-mat-badge">{badge}</span> : null}
                    {/* Kinds that run code: make that visible before anyone opens it */}
                    {mixKindRunsActiveCode(kind) ? <span className="mix-mat-badge" data-tone="code">Runs code</span> : null}
                </div>
                {hook ? <div className="mix-mat-hook">{hook}</div> : null}
                <TagLine tags={tags} className="mix-mat-tags" />
                {author || stats ? (
                    <div className="mix-mat-author">{[author ? `@${author}` : null, stats].filter(Boolean).join(" · ")}</div>
                ) : null}
            </div>
        </div>
    );
}

/** The confirm dialog: every irreversible or outward-facing action -- share, delete,
 *  unpublish -- goes through it */
export function MixConfirm({
    title,
    body,
    confirmText = "Confirm",
    tone,
    onConfirm,
    onCancel,
}: {
    title: string;
    body?: ReactNode;
    confirmText?: string;
    tone?: "danger";
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="mix-confirm-mask" onClick={onCancel}>
            <div className="mix-confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
                <div className="mix-confirm-title">{title}</div>
                {body ? <div className="mix-confirm-body">{body}</div> : null}
                <div className="mix-confirm-actions">
                    <button type="button" className="mix-confirm-btn" onClick={onCancel}>Cancel</button>
                    <button type="button" className="mix-confirm-btn" data-tone={tone ?? "primary"} onClick={onConfirm}>{confirmText}</button>
                </div>
            </div>
        </div>
    );
}

/**
 * Whether a material is sealed. Only somebody else's CHARACTER CARD, installed from the menu
 * or the hall, needs its body hidden.
 * Base spirits, flavors and output formats are craft -- the community is better off being able
 * to read each other's -- so those are always shown in full.
 */
export function isSealedMaterial(material: { kind: string; imported?: boolean }): boolean {
    return Boolean(material.imported) && material.kind === "character";
}

/**
 * Somebody else's character card: the setting text is not opened out, leaving only the two
 * fields the author wrote for readers. Same rule as the app market and the game hall.
 */
export function SealedNote({ hook, canvas, charName }: { hook?: string; canvas?: string; charName?: string }) {
    if (canvas?.trim()) {
        // A detail page has no session, so {{user}} has no name to step into -- fall back to
        // the default
        const filled = applyMixMacros(canvas, charName ?? "", MIX_DEFAULT_USER_NAME, undefined, { escapeHtml: true });
        return <div className="mix-canvas-block"><MixRichText text={filled} /></div>;
    }
    return <DetailField label="Hook" value={hook} />;
}

export function DetailField({ label, value, code }: { label: string; value?: string; code?: boolean }) {
    if (!value?.trim()) return null;
    return (
        <div className="mix-detail-field">
            <div className="mix-detail-label">{label}</div>
            <div className="mix-detail-value" data-code={code ? "true" : undefined}>{value}</div>
        </div>
    );
}

export function MaterialDetail({ material }: { material: MixMaterial }) {
    if (material.kind === "character") {
        const card = material as MixCharacterCard;
        return (
            <>
                <DetailField label="Hook" value={card.hook} />
                <DetailField label="Basics" value={card.baseInfo} />
                <DetailField label="Personality" value={card.personality} />
                <DetailField label="Appearance" value={card.appearance} />
                <DetailField label="Background" value={card.background} />
                <DetailField label="Worldview" value={card.worldview} />
                <DetailField label="Initial awareness of {{user}}" value={card.cognition} />
                <DetailField label="Relationships & identity" value={card.relations} />
                <DetailField label="Current scene" value={card.plot} />
                <DetailField label="Extra setting" value={card.extra} />
                <DetailField label="Opening lines" value={card.openings.map((o, i) => `${card.openings.length > 1 ? `(${i + 1}) ` : ""}${o}`).join("\n\n")} />
            </>
        );
    }
    if (material.kind === "persona") {
        return (
            <>
                <DetailField label="Hook" value={material.hook} />
                <DetailField label="Your name" value={material.userName} />
                <DetailField label="User persona" value={material.content} />
            </>
        );
    }
    if (material.kind === "ticket") {
        return (
            <>
                <DetailField label="Hook" value={material.hook} />
                <DetailField label="Output contract" value={material.contract} />
                <DetailField label="Render code" value={material.renderHtml} code />
            </>
        );
    }
    if (material.kind === "garnish") {
        return (
            <>
                <DetailField label="Hook" value={material.hook} />
                <DetailField label="Garnish CSS" value={material.css} code />
            </>
        );
    }
    if (material.kind === "encore") {
        return (
            <>
                <DetailField label="Hook" value={material.hook} />
                <DetailField label="Output contract" value={material.contract} />
                <DetailField label="Render code" value={mixEncoreRenderHtml(material)} code />
            </>
        );
    }
    if (material.kind === "filter") {
        return (
            <>
                <DetailField label="Hook" value={material.hook} />
                <DetailField
                    label={`Cleanup rules · ${material.rules.length}`}
                    value={material.rules
                        .map((r, i) => `${i + 1}. (${r.mode === "display" ? "display only" : "enters context"}) /${r.find}/ -> ${r.replace || "(delete)"}`)
                        .join("\n")}
                    code
                />
            </>
        );
    }
    if (material.kind === "mechanism") {
        return (
            <>
                <DetailField label="Hook" value={material.hook} />
                <DetailField label="Hook logic" value={material.script} code />
                {material.dock ? <DetailField label="Persistent panel" value={`Docked: ${MIX_DOCK_LABELS[material.dock]}`} /> : null}
                <DetailField label="Panel code" value={material.panelHtml} code />
            </>
        );
    }
    return (
        <>
            <DetailField label="Hook" value={material.hook} />
            <DetailField label={`${MIX_KIND_LABELS[material.kind]} content`} value={material.content} />
        </>
    );
}
