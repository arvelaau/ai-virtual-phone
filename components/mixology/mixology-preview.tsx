"use client";

// House Special -- the workshop preview. Receipt / garnish / encore are the three kinds you
// have to SEE to judge, so they are tried on in place inside the editor: the receipt renders
// against sample data, the garnish is laid over sample prose, and the encore runs in its
// sandbox.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Play, X } from "lucide-react";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { MixTicketFrame } from "./ticket-frame";
import { scopeMixCss } from "@/lib/mixology/css-scope";

/** Sample prose for the garnish preview. It exercises all five prose markers, so an author
 *  can see every one of them styled at a glance. */
const GARNISH_SAMPLE = [
    "【The corner shop, ten minutes to closing】",
    "He squared off the last row of skewers, then looked up and saw you still standing in the doorway.",
    "「Did you bring an umbrella.」Not a question. A statement. *Every time. He knows the answer.*",
    "The rain outside had the whole street shining, ~and only this one light still awake~.",
].join("\n");

export type MixPreviewTarget =
    | { kind: "ticket"; html: string; raw: string }
    | { kind: "garnish"; css: string }
    | { kind: "encore"; html: string; raw?: string }
    | { kind: "canvas"; html: string; cover?: string };

/** The preview body: what "seeing it" means for each of the four kinds */
function MixPreviewBody({ target }: { target: MixPreviewTarget }) {
    return (
        <>
        {target.kind === "ticket" ? (
            target.raw.trim() ? (
                <>
                    <div className="mix-detail-label">Rendered with the preview sample data</div>
                    <div className="mix-ticket-wrap" style={{ marginTop: 8 }}>
                        <MixTicketFrame html={target.html} raw={target.raw} />
                    </div>
                </>
            ) : (
                <div className="mix-comment-empty">
                    Write a few sample lines under Preview sample data
                    <br />
                    and the receipt will render here.
                </div>
            )
        ) : null}

        {target.kind === "garnish" ? (
            <>
                <div className="mix-detail-label">Laid over the sample prose</div>
                {/* The try-on goes through the same caging, so what you see is what a session gets */}
                <div className="mix-garnish-stage mix-garnish-scope">
                    <style>{scopeMixCss(target.css)}</style>
                    <MixProseView text={GARNISH_SAMPLE} />
                    <div className="mix-user-turn">
                        <div className="mix-user-bubble">I held out the umbrella. 「Walk together?」</div>
                    </div>
                </div>
                <div className="mix-detail-label" style={{ marginTop: 14 }}>Official class names you can target</div>
                <div className="mix-detail-value" data-code="true">
                    {[
                        ".mix-prose    prose container (14px / line-height 1.75 by default)",
                        ".mix-para     ordinary paragraph (first line indented 2em; set text-indent: 0 to drop it)",
                        ".mix-scene    scene divider line (【】)",
                        ".mix-dialogue speech (「」)",
                        ".mix-thought  inner voice (* *)",
                        ".mix-accent   emphasis (~ ~)",
                        ".mix-narration narration",
                        ".mix-user-bubble the player's bubble",
                        ".mix-ticket-wrap the receipt frame",
                        "",
                        "body / html / :root  all mean the session screen itself",
                        "Styles only apply inside the session screen and cannot reach the rest of the app",
                    ].join("\n")}
                </div>
            </>
        ) : null}

        {target.kind === "canvas" ? (
            <>
                <div className="mix-detail-label">Laid over the cover scrim</div>
                <div
                    className="mix-canvas-stage"
                    style={target.cover ? { backgroundImage: `url(${target.cover})` } : undefined}
                >
                    <div className="mix-canvas-stage-body">
                        <MixRichText text={target.html} />
                    </div>
                </div>
            </>
        ) : null}

        {target.kind === "encore" ? (
            <>
                <div className="mix-detail-label">{target.raw?.trim() ? "Rendered with the preview sample data" : "The static sketch, running"}</div>
                <div style={{ marginTop: 8, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.03)" }}>
                    <MixTicketFrame html={target.html} raw={target.raw ?? ""} />
                </div>
            </>
        ) : null}
        </>
    );
}

/** A key standing in for "the content changed", used to debounce refreshes so the sandbox is
 *  not rebuilt on every keystroke */
function previewKey(target: MixPreviewTarget): string {
    switch (target.kind) {
        case "ticket": return `t${target.html}${target.raw}`;
        case "garnish": return `g${target.css}`;
        case "encore": return `e${target.html}${target.raw ?? ""}`;
        case "canvas": return `c${target.html}${target.cover ?? ""}`;
    }
}

/**
 * The in-place preview: one tap on the button opens it out below, rather than in a dialog.
 * A dialog covers the whole page, so an author editing and checking has to open and close it
 * over and over -- and it is easy not to notice it opened at all.
 */
export function MixPreviewInline({
    label,
    target,
    disabled,
}: {
    label: string;
    target: MixPreviewTarget;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    // Once open it stays visible, so rebuilding srcDoc on every keystroke would make the
    // iframe flicker constantly. Catch up 400ms after typing stops: still a live preview,
    // without the flicker.
    const [shown, setShown] = useState<MixPreviewTarget | null>(null);
    const latest = useRef(target);
    latest.current = target;
    const panelRef = useRef<HTMLDivElement | null>(null);
    const key = previewKey(target);

    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => setShown(latest.current), 400);
        return () => window.clearTimeout(timer);
    }, [open, key]);

    // The button may sit right at the bottom of the viewport, leaving what opened below the
    // fold -- which is "didn't notice it" all over again
    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => {
            panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 60);
        return () => window.clearTimeout(timer);
    }, [open]);

    // Collapse when the content is emptied, rather than leaving a blank panel behind
    useEffect(() => {
        if (disabled && open) setOpen(false);
    }, [disabled, open]);

    return (
        <div className="mix-preview-inline">
            <button
                type="button"
                className="mix-pill-btn"
                data-open={open ? "true" : undefined}
                aria-expanded={open}
                onClick={() => {
                    if (!open) setShown(latest.current);
                    setOpen((prev) => !prev);
                }}
                disabled={disabled}
            >
                <Play size={13} style={{ verticalAlign: "-2px" }} /> {label}
                <ChevronDown size={13} className="mix-preview-caret" style={{ verticalAlign: "-2px" }} />
            </button>
            {open && shown ? (
                <div className="mix-preview-panel" ref={panelRef}>
                    <MixPreviewBody target={shown} />
                </div>
            ) : null}
        </div>
    );
}

// -- Prompt structure at a glance ------------------------------------------------------
// Shows an author which section of the prompt their material ends up in, and how it queues
// up against everything else.
//
// ⚠️ Every `section` below is a verbatim copy of a heading assembler.ts emits, and nothing
// reads one from the other. If they drift, this sheet tells an author their material lands
// in a section the prompt does not contain. _fx-mixology-prompt.mjs pins the pair.

const STRUCTURE_ROWS: { section: string; from: string; kind?: string }[] = [
    { section: "(fixed preamble)", from: "Built in: states that this is roleplay, and that later means higher priority" },
    { section: "# Roleplay rules", from: "Base spirit (stack several and each gets a ## titled with its name)", kind: "base" },
    { section: "# Character info", from: "Character card, one ## per box: name / basics / personality / appearance / background", kind: "character" },
    { section: "# User info", from: "Mask, one ## per box: name / user persona (only present if written)", kind: "persona" },
    { section: "# World & plot", from: "Character card, one ## per box: worldview / initial awareness of {{user}} / relationships & identity / current scene / extra setting", kind: "character" },
    { section: "# Prose style", from: "Flavor (stack several and each gets a ## titled with its name)", kind: "flavor" },
    { section: "# Output requirements", from: "Two ## entries: the built-in prose marker rules first, then the glassware content", kind: "glass" },
    { section: "# Status panel", from: "Format note first, then the receipt's Output contract as a ##; wrapper is [StatusPanel]...[/StatusPanel]", kind: "ticket" },
    { section: "# Skit", from: "Format note first, then the encore's Output contract as a ##; wrapper is [Skit]...[/Skit]", kind: "encore" },
    { section: "# Sample dialogue", from: "Character card: sample dialogue", kind: "character" },
    { section: "# Output format check", from: "The built-in closing checklist (appears when a status panel or skit is in play)" },
];

export function MixStructureSheet({ highlight, onClose }: { highlight?: string; onClose: () => void }) {
    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">Prompt structure</div>
                    <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
                </div>
                <div className="mix-sheet-body">
                    <div className="mix-struct-note">
                        <b>The box titles in the editor ARE the headings in the prompt.</b> A box you leave empty drops its whole block;
                        <code>{"{{char}}"}</code> / <code>{"{{user}}"}</code> in your text become the character's name and the name you set.
                        <br />
                        Also, <b>the bar words are only for you</b> -- base spirit, glassware and receipt never appear in the prompt.
                        What the model receives is always plain wording it understands immediately: &quot;Roleplay rules&quot;, &quot;Output requirements&quot;, &quot;Status panel&quot;.
                    </div>

                    <div className="mix-detail-label" style={{ marginTop: 14 }}>System prompt (everything before the chat history)</div>
                    <div className="mix-struct-list">
                        {STRUCTURE_ROWS.map((row) => (
                            <div className="mix-struct-row" data-on={highlight && row.kind === highlight ? "true" : undefined} key={row.section}>
                                <div className="mix-struct-section">{row.section}</div>
                                <div className="mix-struct-from">← {row.from}</div>
                            </div>
                        ))}
                    </div>

                    <div className="mix-struct-divider">[ chat history ]</div>

                    <div className="mix-struct-list">
                        <div className="mix-struct-row" data-on={highlight === "strength" ? "true" : undefined}>
                            <div className="mix-struct-section">[Highest priority requirements]</div>
                            <div className="mix-struct-from">&larr; Bitters (the only part placed after the history: closest to generation, hardest to forget)</div>
                        </div>
                    </div>

                    <div className="mix-struct-divider">[ this turn's generation ]</div>

                    <div className="mix-detail-label" style={{ marginTop: 16 }}>Parts that never enter the prompt</div>
                    <div className="mix-struct-note" data-on={highlight === "filter" ? "true" : undefined}>
                        The <b>garnish</b> CSS, the <b>receipt and encore</b> render code, the <b>opening canvas</b> and the <b>strainer</b> rules all run in the interface only, so none of them costs context however long you write them. The <b>opening line</b> is sent separately as the session's first character message, so it is not in the system prompt either.
                        On the strainer specifically: &quot;display only&quot; affects rendering alone, while &quot;enters context&quot; cleans before storing, so the history sent back to the model is clean too.
                    </div>
                </div>
            </div>
        </div>
    );
}
