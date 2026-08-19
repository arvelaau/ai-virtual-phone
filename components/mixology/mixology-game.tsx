"use client";

// House Special -- the session screen: the character's cover underneath with three scrims
// over it, the AI's prose full-width and unbubbled, the player's line in a bubble on the
// right, and the receipt as a full-width card. No tag badges anywhere, to keep it immersive.
// A garnish's CSS is injected into this screen's container through <style> (it targets the
// official .mix-* semantic classes).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, Copy, History, MoreHorizontal, Pencil, Plus, RotateCcw, Send, WandSparkles, X } from "lucide-react";
import { continueMix, editMixTurn, generateMixReply, mixTurnRawText, refreshMixOpening, regenerateMixTail, rerollMixReply, runMixSessionEnd, truncateMixAfterTurn } from "@/lib/mixology/engine";
import { getMixMaterial, getMixSession, listMixPickables, resolveMixRecipeMaterials, saveMixSession } from "@/lib/mixology/storage";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { buildMixConditionContext, pickActiveMixMaterials } from "@/lib/mixology/state";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_KIND_LABELS, MIX_SLOT_ORDER, mixEncoreRenderHtml, mixSlotEntries, type MixCharacterCard, type MixFilterRule, type MixMaterialKind, type MixMechanismMaterial, type MixSession, type MixSlotEntry, type MixState, type MixTurn } from "@/lib/mixology/types";
import { applyMixFilterRules, mixStreamText } from "@/lib/mixology/prose";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { KindGlyph, MixConfirm } from "./mixology-shared";
import { MixTicketFrame } from "./ticket-frame";
import { MixMechanismPanel } from "./mechanism-panel";

/** Which session is genuinely mounted. This is what tells a real exit apart from Strict
 *  Mode's double mount/unmount. */
/** Cap on simultaneously active panels: one iframe each, which on a phone eats memory and
 *  runs out of screen */
const MIX_PANEL_MAX = 3;

const liveMixGames = new Set<string>();

type GameProps = {
    sessionId: string;
    onBack: () => void;
    onToast: (message: string) => void;
};

function AssistantTurn({ turn, ticketHtml, encoreHtml, filterRules, state }: { turn: MixTurn; ticketHtml?: string; encoreHtml?: string; filterRules?: MixFilterRule[]; state?: MixState }) {
    // Display order: status panel before the prose, skit after -- the same order the model
    // writes them, so nothing needs rearranging.
    // The strainer's display-only mode takes effect here: storage is untouched and the
    // substitution happens before rendering, so it applies to historical messages at once.
    const shownText = applyMixFilterRules(turn.text, filterRules, "display");
    return (
        <>
            {ticketHtml && turn.ticketRaw ? (
                <div className="mix-ticket-wrap">
                    <MixTicketFrame html={ticketHtml} raw={turn.ticketRaw} state={state} />
                </div>
            ) : null}
            {shownText ? <MixProseView text={shownText} /> : null}
            {encoreHtml && turn.encoreRaw ? (
                <div className="mix-encore-turn">
                    <MixTicketFrame html={encoreHtml} raw={turn.encoreRaw} state={state} />
                </div>
            ) : null}
        </>
    );
}

/** The action row under each message: copy / rewind to here / edit */
function TurnActions({
    align,
    disabled,
    canRewind,
    onCopy,
    onRewind,
    onEdit,
}: {
    align: "left" | "right";
    disabled: boolean;
    canRewind: boolean;
    onCopy: () => void;
    onRewind: () => void;
    onEdit: () => void;
}) {
    return (
        <div className="mix-turn-actions" data-align={align}>
            <button type="button" className="mix-turn-act" onClick={onCopy} disabled={disabled} aria-label="Copy"><Copy size={13} /></button>
            {canRewind ? (
                <button type="button" className="mix-turn-act" onClick={onRewind} disabled={disabled} aria-label="Rewind to here"><History size={13} /></button>
            ) : null}
            <button type="button" className="mix-turn-act" onClick={onEdit} disabled={disabled} aria-label="Edit"><Pencil size={13} /></button>
        </div>
    );
}

/**
 * Remembered values: a strip under the top bar, tapped to see all of them.
 * With no values at all the strip does not exist, so a session with no receipt looks exactly
 * as it did before.
 */
function StateBar({ state }: { state: MixState }) {
    const [open, setOpen] = useState(false);
    const items = Object.entries(state);
    if (!items.length) return null;
    return (
        <div className="mix-state-bar" data-open={open ? "true" : undefined}>
            <button type="button" className="mix-state-strip" onClick={() => setOpen((v) => !v)}>
                {items.slice(0, 3).map(([name, value]) => (
                    <span className="mix-state-chip" key={name}>
                        <i>{name}</i>
                        <b>{String(value)}</b>
                    </span>
                ))}
                {items.length > 3 ? <span className="mix-state-more">+{items.length - 3}</span> : null}
            </button>
            {open ? (
                <div className="mix-state-panel">
                    {items.map(([name, value]) => (
                        <div className="mix-state-row" key={name}>
                            <span>{name}</span>
                            <b>{String(value)}</b>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function MixologyGame({ sessionId, onBack, onToast }: GameProps) {
    const [session, setSession] = useState<MixSession | null>(() => getMixSession(sessionId));
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    /**
     * The passage currently being written. The model calls back with a small piece at a time,
     * and re-rendering once per token is wasteful -- so it accumulates in a ref and is pushed
     * to the interface once per frame.
     */
    const [live, setLive] = useState("");
    const liveRef = useRef("");
    const liveFrameRef = useRef(0);
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    const [confirm, setConfirm] = useState<{ type: "rewind" | "edit"; turnId: string } | null>(null);
    const [recipeOpen, setRecipeOpen] = useState(false);
    const [slotPick, setSlotPick] = useState<MixMaterialKind | null>(null);
    const [wheelIndex, setWheelIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const wheelRef = useRef<HTMLDivElement | null>(null);
    /**
     * Where to rest the scroll: a session nobody has spoken in yet sits at the top of the
     * title page (an opening canvas is meant to be read from the start); one that has been
     * played sits on the latest message.
     * free = the user has scrolled themselves, so stop pulling them around.
     */
    const stickRef = useRef<"top" | "bottom" | "free">("bottom");

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

    // Cover / receipt render code / garnish CSS: fetched from the cabinet by slot at call time
    const assets = useMemo(() => {
        if (!session) return { cover: "", ticketHtml: undefined as string | undefined, garnishCss: "", encoreTurnHtml: undefined as string | undefined, encoreStaticHtml: "", canvasHtml: "", filterRules: undefined as MixFilterRule[] | undefined };
        // The render side honours conditions too -- a garnish that only applies at night, a
        // skit that only plays once the time comes, both hang on this step
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        const character = active.character?.[0] ?? null;
        const ticket = active.ticket?.[0] ?? null;
        const encore = active.encore?.[0] ?? null;
        // Garnishes and strainers stack: everything whose condition held is layered, or
        // chained, in order
        const garnishCss = (active.garnish ?? [])
            .map((m) => (m.kind === "garnish" ? m.css.trim() : ""))
            .filter(Boolean)
            .join("\n\n");
        const filterRules = (active.filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));
        const encoreMat = encore?.kind === "encore" ? encore : null;
        const encoreRender = encoreMat ? mixEncoreRenderHtml(encoreMat).trim() : "";
        const encoreHasContract = Boolean(encoreMat?.contract?.trim());
        return {
            cover: character?.cover ?? "",
            ticketHtml: ticket?.kind === "ticket" ? ticket.renderHtml : undefined,
            garnishCss,
            filterRules: filterRules.length ? filterRules : undefined,
            // With a contract it is an AI skit, rendered per turn; without one it is a static
            // sketch, pinned at the end of the conversation
            encoreTurnHtml: encoreHasContract && encoreRender ? encoreRender : undefined,
            encoreStaticHtml: !encoreHasContract ? encoreRender : "",
            // The opening canvas lies at the very top of the scroll area as the story's title
            // page, reachable by scrolling up.
            // Authors write {{user}} / {{char}} inside it, and the canvas goes into the iframe
            // verbatim without passing through prompt assembly -- so the macros are substituted
            // here, or the player would see a literal "{{user}}".
            canvasHtml: character?.kind === "character"
                ? applyMixMacros(
                    (character as MixCharacterCard).canvas?.trim() ?? "",
                    session.charName,
                    session.userName || MIX_DEFAULT_USER_NAME,
                    session.state,
                    { escapeHtml: true },
                )
                : "",
        };
    }, [session]);

    /**
     * Mechanisms whose condition held AND that have a dock: these are the panels meant to stay
     * pinned beside the screen.
     * Capped at 3 -- one iframe each, which on a phone eats memory and runs out of screen.
     */
    const panels = useMemo(() => {
        if (!session) return [] as MixMechanismMaterial[];
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        return (active.mechanism ?? [])
            .filter((m): m is MixMechanismMaterial => m.kind === "mechanism" && Boolean(m.dock) && Boolean(m.panelHtml?.trim()))
            .slice(0, MIX_PANEL_MAX);
    }, [session]);

    /** A panel writing its own storage */
    const handlePanelStore = useCallback((materialId: string, store: Record<string, string>) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        saveMixSession({ ...current, mechanismStore: { ...(current.mechanismStore ?? {}), [materialId]: store } });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** A panel writing remembered values */
    const handlePanelState = useCallback((patch: Record<string, string | number>) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        saveMixSession({ ...current, state: { ...(current.state ?? {}), ...patch } });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /**
     * Expose the remembered values as CSS variables on the session's root node, so a garnish
     * can use them directly:
     *   .mix-game { background: hsl(calc(var(--mix-state-affection) * 2) 40% 12%); }
     * Whitespace and quotes in a name become underscores, so an illegal custom property name
     * cannot be spelled.
     */
    const stateCssVars = useMemo(() => {
        const vars: Record<string, string> = {};
        for (const [name, value] of Object.entries(session?.state ?? {})) {
            const safe = name.trim().replace(/[\s"'\\;:{}()]/g, "_");
            if (safe) vars[`--mix-state-${safe}`] = String(value);
        }
        return vars as CSSProperties;
    }, [session?.state]);

    /** Scroll once, to wherever the resting point currently is */
    const applyStick = useCallback(() => {
        const el = scrollRef.current;
        if (!el || stickRef.current === "free") return;
        el.scrollTop = stickRef.current === "top" ? 0 : el.scrollHeight;
    }, []);

    /**
     * Choose the resting point ONCE on entering a session: one nobody has spoken in rests at the
     * top of the title page (an opening canvas is meant to be read from the start), one that has
     * been played rests on the latest message.
     * Keyed on sessionId alone -- it decides and then lets go, so scrolling (free) and speaking
     * (bottom) can both change it without this effect overwriting them again.
     * It used to also depend on busy and turns.length: sending flips busy true first, and the
     * user's turn is not stored until the before-pouring hook has run, so on that tick this read
     * "nobody has spoken" and yanked the player back to the title page.
     */
    useEffect(() => {
        const entered = getMixSession(sessionId);
        stickRef.current = (entered?.turns ?? []).some((turn) => turn.role === "user") ? "bottom" : "top";
        applyStick();
    }, [sessionId, applyStick]);

    /** Content grew (a new turn arrived, the generating state changed, streaming wrote more):
     *  settle again */
    useEffect(() => {
        applyStick();
    }, [session?.turns.length, busy, live, applyStick]);

    /**
     * Every sandboxed iframe in the scroll area -- the opening canvas, each turn's receipt and
     * skit, and the static sketch at the end -- measures itself inside and postMessages its
     * height out. At mount they are only tens of pixels tall, and when the real height arrives
     * the content below is pushed down while the scroll position stays put. Chrome compensates
     * via scroll anchoring; iOS Safari does not, so it ends up stranded in the middle -- neither
     * at the top nor the bottom.
     *
     * Listening for that message here is sturdier than hanging an onHeight callback off each
     * component: the receipt and skit frames never had one, and RichFrame's fired synchronously
     * straight after setHeight -- before React had committed the new height, so the scroll
     * settled against the OLD scrollHeight and achieved nothing.
     * Waiting two frames covers both the React commit and the browser's relayout.
     */
    useEffect(() => {
        const onFrameResize = (event: MessageEvent) => {
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.type !== "resize") return;
            if (data.source !== "mix-rich-frame" && data.source !== "mix-ticket-frame") return;
            requestAnimationFrame(() => requestAnimationFrame(applyStick));
        };
        window.addEventListener("message", onFrameResize);
        return () => window.removeEventListener("message", onFrameResize);
    }, [applyStick]);

    /** Once the user scrolls themselves, let go -- do not drag them back while the canvas grows */
    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el || stickRef.current === "free") return;
        const gapTop = el.scrollTop;
        const gapBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const stuck = stickRef.current === "top" ? gapTop <= 8 : gapBottom <= 8;
        if (!stuck) stickRef.current = "free";
    }, []);

    useEffect(() => () => abortRef.current?.abort(), []);

    // On entering: a session nobody has spoken in re-reads its opening line from the current
    // character card.
    // The opening is a message written into turns[0] when the session was created, so an author
    // who edits the card and comes back would otherwise never see the new one.
    // A session that has been played is left alone -- refreshMixOpening decides that itself --
    // because that is real history.
    useEffect(() => {
        const res = refreshMixOpening(sessionId);
        if (res?.changed) {
            setSession(res.session);
            onToast("The opening line now matches the latest version of the character card.");
        }
    }, [sessionId, onToast]);

    // On leaving: run the teardown hook once and dispose of every sandbox this session owns,
    // rather than leaving them attached to the page.
    // The check is deferred by a tick because Strict Mode in development does
    // mount -> immediately unmount -> mount again, and tearing down straight from the cleanup
    // function would close the session the instant it was entered.
    useEffect(() => {
        liveMixGames.add(sessionId);
        return () => {
            liveMixGames.delete(sessionId);
            window.setTimeout(() => {
                if (!liveMixGames.has(sessionId)) void runMixSessionEnd(sessionId);
            }, 0);
        };
    }, [sessionId]);

    if (!session) {
        return (
            <div className="mix-game">
                <div className="mix-game-header">
                    <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={20} /></button>
                    <div className="mix-game-title">This session does not exist</div>
                    <span style={{ width: 32 }} />
                </div>
            </div>
        );
    }

    const run = async (action: (signal: AbortSignal, commit: () => void, onDelta: (chunk: string) => void) => Promise<unknown>) => {
        if (busy) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        busyRef.current = true;
        const commit = () => setSession(getMixSession(sessionId));
        liveRef.current = "";
        setLive("");
        const onDelta = (chunk: string) => {
            liveRef.current += chunk;
            if (liveFrameRef.current) return;
            liveFrameRef.current = window.requestAnimationFrame(() => {
                liveFrameRef.current = 0;
                setLive(liveRef.current);
            });
        };
        try {
            const pending = action(controller.signal, commit, onDelta);
            // Redo and rewind store before their first await, so read back immediately and let the
            // interface move now. The SEND path stores later than this tick -- the before-pouring
            // hook is async -- so its refresh comes from the engine calling commit().
            commit();
            await pending;
            commit();
        } catch (error) {
            commit();
            const message = error instanceof Error ? error.message : "Generation failed. Please try again.";
            if (!controller.signal.aborted) onToast(message);
        } finally {
            if (liveFrameRef.current) {
                window.cancelAnimationFrame(liveFrameRef.current);
                liveFrameRef.current = 0;
            }
            liveRef.current = "";
            setLive("");
            busyRef.current = false;
            setBusy(false);
        }
    };

    const handleSend = () => {
        const text = input.trim();
        if (!text) return;
        setInput("");
        // Pin the resting point the moment they speak: the user's turn is not stored until the
        // before-pouring hook has run, and until then the interface still looks like nobody has
        // spoken -- without pinning, that yanks them back to the title page.
        stickRef.current = "bottom";
        void run((signal, commit, onDelta) => generateMixReply(sessionId, text, signal, commit, onDelta));
    };

    /** A panel speaking as the player. It takes exactly the same path as the input box; this
     *  is not a privileged channel. */
    const handlePanelSay = useCallback((text: string) => {
        if (busyRef.current) return;
        stickRef.current = "bottom";
        void run((signal, commit, onDelta) => generateMixReply(sessionId, text, signal, commit, onDelta));
    }, [sessionId]);

    const copyTurn = (turn: MixTurn) => {
        const done = () => onToast("Copied");
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(turn.text).then(done, () => onToast("Copy failed"));
            return;
        }
        const ta = document.createElement("textarea");
        ta.value = turn.text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch { onToast("Copy failed"); }
        document.body.removeChild(ta);
    };

    const laterCount = (turnId: string) => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        return idx < 0 ? 0 : session.turns.length - idx - 1;
    };

    const doRewind = (turnId: string) => {
        try {
            truncateMixAfterTurn(sessionId, turnId);
            setSession(getMixSession(sessionId));
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Rewind failed");
        }
    };

    const saveEdit = () => {
        if (!editing) return;
        const target = session.turns.find((t) => t.id === editing.id);
        setEditing(null);
        try {
            editMixTurn(sessionId, editing.id, editing.draft);
            setSession(getMixSession(sessionId));
        } catch (error) {
            onToast(error instanceof Error ? error.message : "Save failed");
            return;
        }
        // Editing a player line regenerates the reply straight away; editing a character reply
        // stops here
        if (target?.role === "user") {
            void run((signal, _commit, onDelta) => regenerateMixTail(sessionId, signal, onDelta));
        }
    };

    /**
     * Swap a material: edits this session's blend snapshot, taking effect on the next assembly.
     * Inside a session this is a quick single swap -- the whole slot becomes the one picked. To
     * stack materials or set conditions, go back to the bar and edit the blend.
     */
    const setSlot = (kind: MixMaterialKind, materialId: string | undefined) => {
        const slots = { ...session.recipe.slots };
        if (materialId) slots[kind] = [{ materialId }];
        else delete slots[kind];
        const updated: MixSession = { ...session, recipe: { ...session.recipe, slots }, updatedAt: Date.now() };
        saveMixSession(updated);
        setSession(getMixSession(sessionId));
        setSlotPick(null);
        onToast("Blend updated. It takes effect on the next turn.");
    };

    const lastTurn = session.turns[session.turns.length - 1];
    const canReroll = !busy && lastTurn?.role === "assistant" && session.turns.length > 1;

    return (
        <div className="mix-game mix-garnish-scope" style={stateCssVars}>
            {/* The garnish is the only shareable code that goes straight into the main document,
                so it is caged to this screen before injection */}
            {assets.garnishCss ? <style>{scopeMixCss(assets.garnishCss)}</style> : null}
            <div className="mix-game-bg" style={assets.cover ? { backgroundImage: `url(${assets.cover})` } : undefined} />
            <div className="mix-game-header">
                <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={20} /></button>
                <div className="mix-game-title">{session.charName}</div>
                <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(true)} disabled={busy} aria-label="Edit blend" title="Edit blend">
                    <MoreHorizontal size={20} />
                </button>
            </div>
            <StateBar state={session.state ?? {}} />
            <div className="mix-game-scroll" ref={scrollRef} onScroll={handleScroll}>
                {assets.canvasHtml ? (
                    <div className="mix-game-canvas">
                        <MixRichText text={assets.canvasHtml} />
                    </div>
                ) : null}
                {session.turns.map((turn, idx) => {
                    const isLast = idx === session.turns.length - 1;
                    const actions = (
                        <TurnActions
                            align={turn.role === "user" ? "right" : "left"}
                            disabled={busy}
                            canRewind={!isLast}
                            onCopy={() => copyTurn(turn)}
                            onRewind={() => setConfirm({ type: "rewind", turnId: turn.id })}
                            onEdit={() => setEditing({ id: turn.id, draft: mixTurnRawText(turn) })}
                            key={`act-${turn.id}`}
                        />
                    );
                    return turn.role === "user" ? (
                        <div className="mix-user-turn" data-with-actions="true" key={turn.id}>
                            <div className="mix-user-bubble">{turn.text}</div>
                            {actions}
                        </div>
                    ) : (
                        <div className="mix-assistant-turn" key={turn.id}>
                            <AssistantTurn turn={turn} ticketHtml={assets.ticketHtml} encoreHtml={assets.encoreTurnHtml} filterRules={assets.filterRules} state={turn.state} />
                            {actions}
                        </div>
                    );
                })}
                {busy ? (() => {
                    // The display-only strainer runs during streaming too, so what appears while
                    // writing matches what is stored afterwards
                    const shown = applyMixFilterRules(mixStreamText(live), assets.filterRules, "display");
                    return shown ? (
                        <div className="mix-live-turn">
                            <MixProseView text={shown} />
                        </div>
                    ) : (
                        <div className="mix-game-thinking" aria-label="Generating">
                            <span /><span /><span />
                        </div>
                    );
                })() : null}
                {assets.encoreStaticHtml ? (
                    <div className="mix-encore-inline">
                        <MixRichText text={assets.encoreStaticHtml} />
                    </div>
                ) : null}
            </div>
            {panels.length ? (
                <div className="mix-panel-layer">
                    {panels.map((material) => (
                        <MixMechanismPanel
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            dock={material.dock!}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                        />
                    ))}
                </div>
            ) : null}
            <div className="mix-game-inputbar">
                <button
                    type="button"
                    className="mix-icon-btn"
                    onClick={() => void run((signal, _commit, onDelta) => rerollMixReply(sessionId, signal, onDelta))}
                    disabled={!canReroll}
                    aria-label="Redo"
                    title="Redo"
                >
                    <RotateCcw size={18} />
                </button>
                <textarea
                    className="mix-game-input"
                    rows={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder={busy ? "Mixing…" : "Say something…"}
                    disabled={busy}
                />
                <button
                    type="button"
                    className="mix-icon-btn"
                    onClick={() => void run((signal, _commit, onDelta) => continueMix(sessionId, signal, onDelta))}
                    disabled={busy}
                    aria-label="Continue"
                    title="Continue"
                >
                    <WandSparkles size={18} />
                </button>
                <button type="button" className="mix-send-btn" onClick={handleSend} disabled={busy || !input.trim()} aria-label="Send">
                    <Send size={16} />
                </button>
            </div>

            {/* Edit blend: swap this session's slot materials */}
            {recipeOpen ? (
                <div className="mix-sheet-mask" onClick={() => setRecipeOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">Edit blend</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(false)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-struct-note">This changes only this session, takes effect on the next generation, and leaves what is already written untouched. The blend saved at the bar is unaffected.</div>
                            <div className="mix-bar-hint">Swipe to move between slots &middot; tap a slot to swap its material</div>
                            <div className="mix-wheel" ref={wheelRef} onScroll={handleWheelScroll}>
                                {MIX_SLOT_ORDER.map((kind) => {
                                    const stack = mixSlotEntries(session.recipe.slots, kind);
                                    const mat = stack[0] ? getMixMaterial(stack[0].materialId) : null;
                                    const extra = stack.length - 1;
                                    const locked = kind === "character";
                                    return (
                                        <div
                                            className="mix-slot"
                                            data-filled={mat ? "true" : undefined}
                                            data-locked={locked ? "true" : undefined}
                                            key={kind}
                                            onClick={() => { if (!locked) setSlotPick(kind); }}
                                        >
                                            <div className="mix-slot-kind">
                                                <b>{MIX_KIND_LABELS[kind]}</b>
                                                {locked ? <i>fixed for this session</i> : <i>may be empty</i>}
                                            </div>
                                            <div className="mix-slot-body">
                                                {mat ? (
                                                    <>
                                                        {mat.cover ? (
                                                            // eslint-disable-next-line @next/next/no-img-element
                                                            <img className="mix-slot-cover" src={mat.cover} alt={mat.name} />
                                                        ) : (
                                                            <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                        )}
                                                        <div className="mix-slot-name">{mat.name}{extra > 0 ? ` +${extra}` : ""}</div>
                                                        {mat.hook ? <div className="mix-slot-hook">{mat.hook}</div> : null}
                                                    </>
                                                ) : locked ? (
                                                    <>
                                                        <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                        <div className="mix-slot-name">{session.charName}</div>
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
                        </div>
                    </div>
                </div>
            ) : null}

            {slotPick ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPick(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">Choose a {MIX_KIND_LABELS[slotPick]}</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setSlotPick(null)} aria-label="Close"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-mat-list">
                                {mixSlotEntries(session.recipe.slots, slotPick).length ? (
                                    <div className="mix-mat-row" onClick={() => setSlot(slotPick, undefined)}>
                                        <div className="mix-mat-row-glyph"><X size={18} /></div>
                                        <div className="mix-mat-info">
                                            <div className="mix-mat-name"><span>Leave this one out &middot; clear the slot</span></div>
                                        </div>
                                    </div>
                                ) : null}
                                {listMixPickables(slotPick).map((m) => (
                                    <div className="mix-mat-row" data-kind={m.kind} onClick={() => setSlot(slotPick, m.id)} key={m.id}>
                                        <div className="mix-mat-row-glyph"><KindGlyph kind={m.kind} size={22} /></div>
                                        <div className="mix-mat-info">
                                            <div className="mix-mat-name">
                                                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                                                {mixSlotEntries(session.recipe.slots, slotPick).some((e: MixSlotEntry) => e.materialId === m.id) ? <span className="mix-mat-badge">current</span> : null}
                                            </div>
                                            {m.hook ? <div className="mix-mat-hook">{m.hook}</div> : null}
                                        </div>
                                    </div>
                                ))}
                                {listMixPickables(slotPick).length === 0 ? (
                                    <div className="mix-comment-empty">No {MIX_KIND_LABELS[slotPick]} in the cabinet yet &mdash; make one on the cabinet page.</div>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Edit message: a large dialog. On an assistant turn what is edited is the raw
                output, format blocks included. */}
            {editing ? (() => {
                const editingTurn = session.turns.find((t) => t.id === editing.id);
                return (
                    <div className="mix-sheet-mask" onClick={() => setEditing(null)}>
                        <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                            <div className="mix-sheet-head">
                                <div className="mix-sheet-title">Edit message</div>
                                <button type="button" className="mix-icon-btn" onClick={() => setEditing(null)} aria-label="Close"><X size={18} /></button>
                            </div>
                            <div className="mix-sheet-body">
                                {editingTurn?.role === "assistant" ? (
                                    <div className="mix-struct-note">
                                        This is the turn's <b>raw output</b> &mdash; the [StatusPanel] / [Skit] blocks are in here too.
                                        If the model dropped the format you can fix it by hand; saving re-parses and re-renders it.
                                    </div>
                                ) : null}
                                <textarea
                                    className="mix-textarea mix-edit-large"
                                    value={editing.draft}
                                    onChange={(e) => setEditing({ id: editing.id, draft: e.target.value })}
                                />
                                <div className="mix-turn-edit-actions">
                                    <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setEditing(null)}>Cancel</button>
                                    <button
                                        type="button"
                                        className="mix-pill-btn"
                                        onClick={() => {
                                            if (laterCount(editing.id) > 0) setConfirm({ type: "edit", turnId: editing.id });
                                            else saveEdit();
                                        }}
                                    >
                                        Save{editingTurn?.role === "user" ? " and regenerate" : ""}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })() : null}

            {confirm ? (
                <MixConfirm
                    title={confirm.type === "rewind" ? "Rewind to this message?" : "Save changes?"}
                    body={confirm.type === "rewind"
                        ? `The ${laterCount(confirm.turnId)} message(s) after this one will be deleted.`
                        : `Saving deletes the ${laterCount(confirm.turnId)} message(s) after this one${session.turns.find((t) => t.id === confirm.turnId)?.role === "user" ? ", and regenerates the reply" : ""}.`}
                    confirmText={confirm.type === "rewind" ? "Rewind" : "Save"}
                    tone="danger"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const target = confirm;
                        setConfirm(null);
                        if (target.type === "rewind") doRewind(target.turnId);
                        else saveEdit();
                    }}
                />
            ) : null}
        </div>
    );
}
