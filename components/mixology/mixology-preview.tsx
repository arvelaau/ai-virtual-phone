"use client";

// House Special -- the workshop preview. These are the kinds you have to SEE to judge, so
// they are tried on in place inside the editor: the receipt renders against sample data, the
// garnish is laid over sample prose, the encore runs in its sandbox, and a mechanism is set
// down on a fake session screen where its interface can be dragged and clicked and its hooks
// run once on the spot to see what comes back.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Play, X } from "lucide-react";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { MixTicketFrame } from "./ticket-frame";
import { MixMechanismPanel } from "./mechanism-panel";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_HOOK_LABELS, type MixHook } from "@/lib/mixology/mechanism-protocol";
import { disposeMixSandboxesForMaterial, runMixHook } from "@/lib/mixology/mechanism-runtime";
import type { MixPanelLayout, MixState } from "@/lib/mixology/types";

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
    | { kind: "canvas"; html: string; cover?: string }
    | { kind: "mechanism"; name: string; html: string; layout: MixPanelLayout; script: string };

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

        {target.kind === "mechanism" ? <MixMechanismStage target={target} /> : null}

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


/** The fake session used to try a mechanism out: the prose and the names are hardcoded, and
 *  exist only to give the panel a stage with realistic proportions */
const MECH_SAMPLE = [
    "[After closing]",
    "He turns the last glass upside down on the rack, without looking back.",
    "「You have been quiet today.」",
].join("\n");
const MECH_CHAR = "Cheng Jibai";
const MECH_USER = "A-Lan";
/** The sample text fed in when trying a hook */
const MECH_SAY = "I push the glass back. 「I do not feel like talking today.」";
const MECH_REPLY = "[The bar]\nHe does not answer, only dims the lights two notches.\n「Then sit.」";
/** The fake session id used for trying out: entirely separate from any real session's sandbox */
const MECH_SESSION = "mixpreview";
const MECH_MATERIAL = "mixpreview-mech";

function short(value: string, max = 220): string {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * Trying a mechanism out.
 * The top half is a stage drawn to the session screen's proportions, with the panel landing on
 * it by its own placement -- draggable, clickable, and with mix.setStore / mix.say genuinely
 * handled, so the author can see exactly where it lands and how big it is.
 * The bottom half runs the hooks: a sample payload goes into the sandbox and whatever comes
 * back is laid out as-is.
 * The storage is shared -- write it in a hook and the interface sees it immediately, which is
 * exactly how the two halves of a mechanism work together.
 */
function MixMechanismStage({ target }: { target: Extract<MixPreviewTarget, { kind: "mechanism" }> }) {
    /**
     * The stage is drawn to the session screen's real aspect ratio. Hardcode a ratio and the
     * same percentage placement lands somewhere different here than it does in a session --
     * which is where most "the preview does not match the real thing" comes from.
     */
    const shellRef = useRef<HTMLDivElement | null>(null);
    const [ratio, setRatio] = useState("9 / 19.5");
    useEffect(() => {
        const app = shellRef.current?.closest(".mixology-app") ?? (typeof document !== "undefined" ? document.querySelector(".mixology-app") : null);
        const rect = app?.getBoundingClientRect();
        if (rect?.width && rect.height) setRatio(`${Math.round(rect.width)} / ${Math.round(rect.height)}`);
    }, []);
    const [store, setStore] = useState<Record<string, string>>({});
    const [state, setState] = useState<MixState>({});
    const [box, setBox] = useState<Partial<MixPanelLayout> | null>(null);
    const [said, setSaid] = useState<string[]>([]);
    const [turn, setTurn] = useState(0);
    const [running, setRunning] = useState<MixHook | "">("");
    const [result, setResult] = useState<{ hook: MixHook; lines: string[] } | null>(null);

    // Code changed: drop the old sandbox, or what runs is still the previous version
    useEffect(() => {
        disposeMixSandboxesForMaterial(MECH_MATERIAL);
        return () => disposeMixSandboxesForMaterial(MECH_MATERIAL);
    }, [target.script]);

    const layout = useMemo(() => ({ ...target.layout, ...(box ?? {}) }), [target.layout, box]);

    const fire = useCallback(async (hook: MixHook) => {
        if (!target.script.trim()) return;
        setRunning(hook);
        const payload = {
            hook,
            turnCount: turn,
            state,
            store,
            charName: MECH_CHAR,
            userName: MECH_USER,
            text: hook === "beforeSend" ? MECH_SAY : hook === "afterReply" ? MECH_REPLY : undefined,
            ticketRaw: hook === "afterReply" ? "Warmth: 61\nPlace: the bar" : undefined,
            encoreRaw: undefined,
        };
        const out = await runMixHook(MECH_SESSION, MECH_MATERIAL, target.script, hook, payload);
        const lines: string[] = [];
        if (typeof out.text === "string") lines.push(`Prose rewritten\n${short(out.text, 400)}`);
        if (out.note) lines.push(`Passing note - ${out.note.length} chars\n${short(out.note, 600)}`);
        if (out.state) lines.push(`Remembered values - ${Object.entries(out.state).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        if (out.store) {
            lines.push(`Storage - ${Object.entries(out.store).map(([k, v]) => `${k} (${v.length} chars)`).join(", ") || "cleared"}`);
            setStore(out.store);
        }
        if (out.state) setState((prev) => ({ ...prev, ...out.state }));
        if (!lines.length) lines.push("Nothing returned.");
        setResult({ hook, lines });
        setRunning("");
        if (hook === "afterReply") setTurn((n) => n + 1);
    }, [target.script, turn, state, store]);

    const hasPanel = target.html.trim().length > 0;

    return (
        <>
            {hasPanel ? (
            <>
            <div className="mix-detail-label">Interface</div>
            <div className="mix-mech-stage" ref={shellRef} style={{ aspectRatio: ratio }}>
                <div className="mix-mech-bar">{MECH_CHAR}</div>
                <div className="mix-mech-prose"><MixProseView text={MECH_SAMPLE} /></div>
                <div className="mix-mech-input" />
                <div className="mix-panel-layer">
                    {target.html.trim() ? (
                        <MixMechanismPanel
                            materialId={MECH_MATERIAL}
                            name={target.name || "Mechanism"}
                            layout={layout}
                            html={target.html}
                            state={state}
                            store={store}
                            onStore={(_id, next) => setStore(next)}
                            onState={(patch) => setState((prev) => ({ ...prev, ...patch }))}
                            onSay={(text) => setSaid((prev) => [...prev.slice(-2), text])}
                            onBox={(_id, next) => setBox(next)}
                        />
                    ) : null}
                </div>
            </div>
            {box ? (
                <div className="mix-mech-hint">
                    Dragged &middot; <button type="button" className="mix-mech-reset" onClick={() => setBox(null)}>put back</button>
                </div>
            ) : null}
            </>
            ) : null}

            <div className="mix-detail-label" style={hasPanel ? { marginTop: 14 } : undefined}>Hooks &middot; turn {turn}</div>
            <div className="mix-dock-row">
                {(Object.keys(MIX_HOOK_LABELS) as MixHook[]).map((hook) => (
                    <button
                        type="button"
                        className="mix-dock-chip"
                        key={hook}
                        disabled={!target.script.trim() || Boolean(running)}
                        data-on={result?.hook === hook ? "true" : undefined}
                        onClick={() => void fire(hook)}
                    >
                        {running === hook ? "running..." : MIX_HOOK_LABELS[hook]}
                    </button>
                ))}
                <button type="button" className="mix-dock-chip" onClick={() => { setStore({}); setState({}); setSaid([]); setTurn(0); setResult(null); }}>
                    Reset
                </button>
            </div>
            {!target.script.trim() ? <div className="mix-mech-hint">No hook logic written.</div> : null}
            {result ? (
                <div className="mix-detail-value" data-code="true">
                    {result.lines.join("\n\n")}
                </div>
            ) : null}

            {Object.keys(store).length || Object.keys(state).length || said.length ? (
                <>
                    <div className="mix-detail-label" style={{ marginTop: 14 }}>Current state</div>
                    <div className="mix-detail-value" data-code="true">
                        {[
                            `Storage - ${Object.keys(store).length ? Object.entries(store).map(([k, v]) => `${k} = ${short(v, 90)}`).join("\n     ") : "empty"}`,
                            `Remembered values - ${Object.keys(state).length ? Object.entries(state).map(([k, v]) => `${k}=${v}`).join(", ") : "empty"}`,
                            said.length ? `The interface said - ${said.map((t) => short(t, 90)).join("\n     ")}` : "",
                        ].filter(Boolean).join("\n")}
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
        case "mechanism": return `m${target.html}${target.script}${JSON.stringify(target.layout)}`;
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
