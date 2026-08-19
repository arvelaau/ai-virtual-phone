"use client";

// House Special -- a mechanism's persistent panel.
//
// This is a different thing from the hook sandbox. A hook is a pure function that gets
// called, runs, and is done; this is something that stays on screen and keeps its own state,
// so it must persist and never be rebuilt -- reinserting it each turn would restart a player
// from the top, scroll a memory pane back to the beginning, and snap a tab strip back to the
// first tab.
//
// Placement is entirely the creator's: where it is drawn, how big, whether the app draws any
// shell or backing plate, are all percentage coordinates written by the material itself (see
// MixPanelLayout). The host keeps only two floors -- a panel may never be dragged off screen
// beyond recovery, and it may never sit above the app's own dialogs. Beyond that it does not
// interfere with layout.
//
// What it can do is still a whitelist: write its own storage, write remembered values, speak
// as the player, collapse or expand, move itself, resize itself, and report how tall its
// content is. Any message outside the whitelist is ignored.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
    MIX_PANEL_KEEP_IN,
    MIX_PANEL_MAX_Z,
    MIX_PANEL_MIN_H,
    MIX_PANEL_MIN_W,
    type MixPanelLayout,
    type MixState,
} from "@/lib/mixology/types";
import { normalizeMechanismStore, type MixMechanismStore } from "@/lib/mixology/mechanism-protocol";

/** The actions a panel may request -- just these */
type PanelCommand =
    | { name: "setStore"; store: unknown }
    | { name: "setState"; state: unknown }
    | { name: "say"; text: unknown }
    | { name: "setOpen"; open: unknown }
    | { name: "box"; box: unknown }
    | { name: "fit"; px: unknown }
    | { name: "design"; px: unknown }
    | { name: "flag"; key: unknown; on: unknown }
    | { name: "grab"; cx: unknown; cy: unknown }
    | { name: "drag"; cx: unknown; cy: unknown }
    | { name: "dragEnd" };

const MAX_SAY_LENGTH = 2_000;

type Box = { x: number; y: number; w: number; h: number };

function boxOf(layout: MixPanelLayout): Box {
    return { x: layout.x, y: layout.y, w: layout.w, h: layout.h };
}

function sameBox(a: Box | null, b: Box): boolean {
    return Boolean(a) && a!.x === b.x && a!.y === b.y && a!.w === b.w && a!.h === b.h;
}

/**
 * Clamp back into the usable range. Deliberately does NOT require the whole panel to stay on
 * screen -- an ornament half off the edge is legitimate layout; it only guarantees a
 * MIX_PANEL_KEEP_IN-sized piece survives, so anything dragged out can be dragged back.
 */
function clampBox(box: Box): Box {
    const w = Math.min(100, Math.max(MIX_PANEL_MIN_W, box.w));
    const h = Math.min(100, Math.max(MIX_PANEL_MIN_H, box.h));
    return {
        w,
        h,
        x: Math.min(100 - MIX_PANEL_KEEP_IN, Math.max(MIX_PANEL_KEEP_IN - w, box.x)),
        y: Math.min(100 - MIX_PANEL_KEEP_IN, Math.max(MIX_PANEL_KEEP_IN - h, box.y)),
    };
}

function buildPanelDoc(html: string, state: MixState, store: MixMechanismStore, autoHeight: boolean): string {
    const bridge = `
<script>
(function(){
  "use strict";
  window.MIX_STATE = ${JSON.stringify(state)};
  window.MIX_STORE = ${JSON.stringify(store)};
  function send(name, extra){
    var msg = { source: "mix-panel", name: name };
    for (var k in extra) msg[k] = extra[k];
    try { parent.postMessage(msg, "*"); } catch (e) {}
  }
  // Every action a panel may request
  window.mix = {
    setStore: function(obj){ send("setStore", { store: obj }); },
    setState: function(obj){ send("setState", { state: obj }); },
    say: function(text){ send("say", { text: String(text == null ? "" : text) }); },
    open: function(){ send("setOpen", { open: true }); },
    close: function(){ send("setOpen", { open: false }); },
    // Move / resize itself: both percentages of the session screen, and the app clamps
    // anything out of range
    move: function(x, y){ send("box", { box: { x: x, y: y } }); },
    size: function(w, h){ send("box", { box: { w: w, h: h } }); },
    // Report how tall the content is, in pixels. Only useful with autoHeight in the placement.
    fit: function(px){ send("fit", { px: px }); },
    // Change the width to lay out against: collapsed into a small handle it wants to lay out
    // small, expanded into a whole phone it wants 390. One width baked into the placement is
    // not enough, so the interface switches between them itself.
    design: function(px){ send("design", { px: px }); },
    // These used to be switches in the editor. Every mechanism has a different shape, and a
    // row of switches only makes people think those are the only arrangements available, so
    // they are the interface's to declare too.
    drag: function(on){ send("flag", { key: "drag", on: on !== false }); },
    resize: function(on){ send("flag", { key: "resize", on: on !== false }); },
    chrome: function(on){ send("flag", { key: "chrome", on: on !== false }); },
    plate: function(on){ send("flag", { key: "plate", on: on !== false }); },
    z: function(n){ send("flag", { key: "z", on: n }); },
    // Start a drag from inside the interface: call this on pointerdown on your own title bar
    grab: startDrag
  };

  // Dragging started inside the interface. While a finger is down inside the iframe the whole
  // stream of move events is locked to the iframe and the host receives none of them, so this
  // listens for its own copy and reports it up.
  // What it reports is the coordinate WITHIN ITS OWN FRAME, not a screen coordinate -- the
  // sandbox is an opaque origin, so screenX in an iframe like this gives frame coordinates
  // rather than screen ones, and the two do not line up across frames.
  // Frame coordinates move along with the panel, and the host converts back using where the
  // frame currently sits on screen, which cancels out exactly.
  var lastDown = null, dragFrom = null, savedTouch = "", held = null;
  document.addEventListener("pointerdown", function(e){
    lastDown = { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target };
  }, true);
  function onDragMove(e){
    if (!dragFrom) return;
    send("drag", { cx: e.clientX, cy: e.clientY });
  }
  function onDragEnd(){
    if (!dragFrom) return;
    dragFrom = null;
    if (held) {
      try { held.el.releasePointerCapture(held.id); } catch (err) {}
      held = null;
    }
    document.documentElement.style.touchAction = savedTouch;
    document.removeEventListener("pointermove", onDragMove, true);
    document.removeEventListener("pointerup", onDragEnd, true);
    document.removeEventListener("pointercancel", onDragEnd, true);
    send("dragEnd", {});
  }
  function startDrag(){
    if (dragFrom || !lastDown) return;
    dragFrom = lastDown;
    // Once the pointer leaves this small piece of interface it no longer hits it and the
    // events stop -- so capture this pointer onto the element that was pressed. Captured, the
    // events keep coming back here even when the pointer runs outside the iframe.
    var el = lastDown.target;
    if (el && el.setPointerCapture) {
      try { el.setPointerCapture(lastDown.id); held = { el: el, id: lastDown.id }; } catch (err) { held = null; }
    }
    // A finger dragging must not scroll the page along with it
    savedTouch = document.documentElement.style.touchAction;
    document.documentElement.style.touchAction = "none";
    document.addEventListener("pointermove", onDragMove, true);
    document.addEventListener("pointerup", onDragEnd, true);
    document.addEventListener("pointercancel", onDragEnd, true);
    send("grab", { cx: dragFrom.x, cy: dragFrom.y });
  }
  // When the remembered values change the app pushes a fresh copy over; a panel can define
  // onMixSync to receive it
  window.addEventListener("message", function(event){
    var data = event.data;
    if (!data || data.source !== "mix-panel-host") return;
    window.MIX_STATE = data.state || {};
    window.MIX_STORE = data.store || {};
    if (typeof window.onMixSync === "function") {
      try { window.onMixSync(window.MIX_STATE, window.MIX_STORE); } catch (e) {}
    }
  });
  ${autoHeight ? `
  // With "height follows content" on, measure automatically so the author never has to call
  // mix.fit themselves
  var last = -1;
  function measure(){
    var b = document.body; if (!b) return;
    var r = b.getBoundingClientRect(); var px = r.height;
    for (var i = 0; i < b.children.length; i++) {
      var c = b.children[i].getBoundingClientRect();
      if (c.width || c.height) px = Math.max(px, c.bottom - r.top);
    }
    px = Math.ceil(px);
    if (px !== last) { last = px; send("fit", { px: px }); }
  }
  window.addEventListener("load", measure);
  window.addEventListener("resize", measure);
  if (window.MutationObserver) new MutationObserver(measure).observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
  setTimeout(measure, 60); setTimeout(measure, 400);
  ` : ""}
})();
</` + `script>`;
    const body = /<html[\s>]/i.test(html)
        ? html
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>`
          // A panel needs to show images and play audio, so this is a notch looser than the
          // hook sandbox -- but there is still no connect-src, so fetch / XHR / WebSocket
          // cannot get out.
          + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:"/>`
          // Give html/body full height: the panel's height is a fixed value handed down by the
          // host, so an author writing height:100% should fill it rather than collapse to the
          // content height -- without this line, "align to the bottom" and "fill a column"
          // both stop working
          + `<style>*{box-sizing:border-box}html,body{height:100%}html,body{margin:0;padding:0;background:transparent;color:#f2f0f7;font-family:system-ui,-apple-system,sans-serif;font-size:12px}input,textarea,button,select{max-width:100%;font-family:inherit;font-size:inherit}</style>`
          + `</head><body>${html}</body></html>`;
    // The bridge has to come BEFORE the author's code: put at the end of body, the panel's
    // first paint cannot read MIX_STATE and would show nothing until the first push arrived.
    return /<head[\s>]/i.test(body)
        ? body.replace(/<head([^>]*)>/i, `<head$1>${bridge}`)
        : bridge + body;
}

export function MixMechanismPanel({
    materialId,
    name,
    layout,
    html,
    state,
    store,
    onStore,
    onState,
    onSay,
    onBox,
}: {
    materialId: string;
    name: string;
    layout: MixPanelLayout;
    html: string;
    state: MixState;
    store: MixMechanismStore;
    onStore: (materialId: string, store: MixMechanismStore) => void;
    onState: (state: MixState) => void;
    onSay: (text: string) => void;
    /** Stored after the player drags or resizes; affects this session only */
    onBox: (materialId: string, box: Box) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    /** The piece actually given over to the interface (below the handle bar): scaling is
     *  computed against this, excluding any shell the app draws itself */
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(!layout.collapsed);
    const [box, setBox] = useState<Box>(() => clampBox(boxOf(layout)));
    /** The geometry last reported to the host: the same value is never reported twice, so it
     *  cannot stir up a re-render loop */
    const boxRef = useRef<Box | null>(null);
    /** With height following content, the pixel height the interface measured */
    const [fitPx, setFitPx] = useState(0);
    /** The layout width the interface asked for; without one, the placement's own value */
    const [designPx, setDesignPx] = useState<number | null>(null);
    /**
     * Host behaviour the interface asked for (whether it can be dragged, whether the app draws
     * a shell, and so on). Anything unasked for falls back to the placement -- old materials
     * carry on as before, new ones declare it all in code.
     */
    const [flags, setFlags] = useState<{ drag?: boolean; resize?: boolean; chrome?: boolean; plate?: boolean; z?: number }>({});
    /** Dragging / resizing right now: a transparent capture layer covers the screen for the
     *  duration, so events are not lost when the pointer runs outside the iframe */
    const [grabbing, setGrabbing] = useState<"" | "move" | "size">("");
    /** The drag in progress. `from` is the start point, and all coordinates are computed in
     *  the session-screen layer */
    const dragRef = useRef<{ mode: "move" | "size"; from: { x: number; y: number } | null; box: Box } | null>(null);
    /** A drag started inside the interface, on the sandbox path: with a finger, events are
     *  locked inside the iframe and the host receives none, so the panel has to report them */
    const frameDragRef = useRef<{ box: Box; layer: DOMRect; from: { x: number; y: number } } | null>(null);
    /** The panel's actual pixel size right now: needed to scale against the design width */
    const [size, setSize] = useState({ w: 0, h: 0 });

    // The interface decides; the placement is consulted only where it said nothing
    const chrome = (flags.chrome ?? (layout.chrome ?? "bar") === "bar") ? "bar" : "none";
    const plate = flags.plate ?? layout.plate !== false;
    const canDrag = flags.drag ?? layout.drag !== false;
    const canResize = flags.resize ?? layout.resize === true;
    const zIndex = Math.min(MIX_PANEL_MAX_Z, Math.max(0, flags.z ?? layout.z ?? 0));

    // Re-place against the new placement when the material has been edited and saved; a
    // position the player dragged to during the session arrives via `layout`
    useEffect(() => { setBox(clampBox(boxOf(layout))); }, [layout.x, layout.y, layout.w, layout.h]);

    // How big the panel actually is: it changes with the device, with dragging and with
    // resizing, so it has to be watched continuously
    useEffect(() => {
        const node = stageRef.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        const read = () => {
            const rect = node.getBoundingClientRect();
            setSize((prev) => (Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5
                ? prev
                : { w: rect.width, h: rect.height }));
        };
        read();
        const observer = new ResizeObserver(read);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    /**
     * The width the interface lays out against. With a design width set, it lays out at that
     * width and the whole thing is then scaled to the panel's real size -- a 390-wide phone
     * fits into a 180-wide panel by being scaled down, not by cramming the text together.
     */
    const designWidth = designPx === null ? layout.designWidth ?? 0 : designPx;
    const scale = designWidth && size.w > 0 ? size.w / designWidth : 1;

    // srcDoc is only recomputed when the panel's code changes. state/store arrive by message
    // instead and must NOT be inputs here, or the iframe would reload on every value change --
    // which is the opposite of persistent.
    const srcDoc = useMemo(
        () => buildPanelDoc(html, state, store, layout.autoHeight === true),
        [html, layout.autoHeight], // eslint-disable-line react-hooks/exhaustive-deps
    );

    const post = useCallback((payload: Record<string, unknown>) => {
        try {
            frameRef.current?.contentWindow?.postMessage({ source: "mix-panel-host", ...payload }, "*");
        } catch {
            // If it cannot be handed in, let it go; the next sync will try again
        }
    }, []);

    const syncedRef = useRef("");
    useEffect(() => {
        // Only push when the content actually changed. Pushing on every host re-render would
        // mean an interface that touches itself inside onMixSync (moving, writing storage)
        // loops straight back round, into a cycle that never settles.
        const snapshot = JSON.stringify({ state, store });
        if (snapshot === syncedRef.current) return;
        syncedRef.current = snapshot;
        post({ state, store });
    }, [state, store, post]);

    /** Apply one geometry change to the panel; only a finished drag (commit) is written to
     *  the session */
    const applyBox = useCallback((next: Box, commit: boolean) => {
        const clamped = clampBox(next);
        setBox((current) => (current.x === clamped.x && current.y === clamped.y
            && current.w === clamped.w && current.h === clamped.h ? current : clamped));
        // An unchanged value need not disturb the host -- an interface asking for the same
        // size over and over via mix.size is entirely normal
        if (commit && !sameBox(boxRef.current, clamped)) { boxRef.current = clamped; onBox(materialId, clamped); }
    }, [materialId, onBox]);

    // -- dragging and resizing --------------------------------------------
    // The moment a pointer goes down, a transparent layer covers the whole screen: an iframe
    // swallows any pointermove that lands on it, so dragging across one stutters. Only by
    // collecting the events on the host's own element does it stay smooth.
    const startGrab = useCallback((mode: "move" | "size", from?: { x: number; y: number }) => {
        dragRef.current = { mode, from: from ?? null, box };
        setGrabbing(mode);
    }, [box]);

    useEffect(() => {
        if (!grabbing) return;
        const layer = rootRef.current?.parentElement;
        const rect = layer?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) { setGrabbing(""); return; }

        const move = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            if (!drag.from) { drag.from = { x: event.clientX, y: event.clientY }; return; }
            const dx = (event.clientX - drag.from.x) / rect.width * 100;
            const dy = (event.clientY - drag.from.y) / rect.height * 100;
            if (drag.mode === "move") {
                applyBox({ ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }, false);
            } else {
                applyBox({ ...drag.box, w: drag.box.w + dx, h: drag.box.h + dy }, false);
            }
        };
        const stop = () => {
            dragRef.current = null;
            setGrabbing("");
            setBox((current) => {
                if (!sameBox(boxRef.current, current)) { boxRef.current = current; onBox(materialId, current); }
                return current;
            });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
        };
    }, [grabbing, applyBox, materialId, onBox]);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const data = event.data as (Record<string, unknown> & { source?: string }) | null;
            if (!data || data.source !== "mix-panel") return;
            const command = data as unknown as PanelCommand;
            switch (command.name) {
                case "setStore":
                    onStore(materialId, normalizeMechanismStore(command.store));
                    break;
                case "setState": {
                    // The same vetting as the hooks: numbers and short text only, everything else dropped
                    const raw = command.state;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
                    const patch: MixState = {};
                    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                        const name2 = key.trim().slice(0, 40);
                        if (!name2) continue;
                        if (typeof value === "number" && Number.isFinite(value)) patch[name2] = value;
                        else if (typeof value === "string" && value.trim()) patch[name2] = value.trim().slice(0, 200);
                        if (Object.keys(patch).length >= 50) break;
                    }
                    if (Object.keys(patch).length) onState(patch);
                    break;
                }
                case "say": {
                    const text = String(command.text ?? "").trim().slice(0, MAX_SAY_LENGTH);
                    if (text) onSay(text);
                    break;
                }
                case "setOpen":
                    setOpen(command.open !== false);
                    break;
                case "box": {
                    // The interface moving itself: numbers only, a missing dimension keeps its
                    // current value, and out-of-range is clamped as always
                    const raw = command.box;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) break;
                    const patch = raw as Record<string, unknown>;
                    setBox((current) => {
                        const pick = (key: keyof Box) => {
                            const value = Number(patch[key]);
                            return Number.isFinite(value) ? value : current[key];
                        };
                        const next = clampBox({ x: pick("x"), y: pick("y"), w: pick("w"), h: pick("h") });
                        if (sameBox(current, next)) return current;
                        if (!sameBox(boxRef.current, next)) { boxRef.current = next; onBox(materialId, next); }
                        return next;
                    });
                    break;
                }
                case "flag": {
                    const key = String(command.key ?? "");
                    if (key === "z") {
                        const n = Number(command.on);
                        if (Number.isFinite(n)) setFlags((prev) => ({ ...prev, z: Math.min(MIX_PANEL_MAX_Z, Math.max(0, Math.round(n))) }));
                        break;
                    }
                    if (key !== "drag" && key !== "resize" && key !== "chrome" && key !== "plate") break;
                    const on = command.on !== false;
                    setFlags((prev) => (prev[key] === on ? prev : { ...prev, [key]: on }));
                    break;
                }
                case "design": {
                    const px = Number(command.px);
                    // 0 means "do not lay out against a fixed width, just follow the panel"
                    if (!Number.isFinite(px)) break;
                    setDesignPx(px <= 0 ? 0 : Math.min(1600, Math.max(120, Math.round(px))));
                    break;
                }
                case "fit": {
                    const px = Number(command.px);
                    // Catch it at a ceiling: when an interface writes a height feedback loop,
                    // do not make the host lay out an element hundreds of thousands of pixels tall
                    if (Number.isFinite(px) && px >= 0) setFitPx(Math.min(4000, Math.ceil(px)));
                    break;
                }
                case "grab": {
                    if (!canDrag) break;
                    const layer = rootRef.current?.parentElement?.getBoundingClientRect();
                    const frame = frameRef.current?.getBoundingClientRect();
                    if (!layer?.width || !layer.height || !frame) break;
                    const cx = Number(command.cx);
                    const cy = Number(command.cy);
                    if (!Number.isFinite(cx) || !Number.isFinite(cy)) break;
                    // Convert the start point into the session-screen layer: where this frame's
                    // top-left sits, plus the coordinate within the frame
                    const from = { x: frame.left - layer.left + cx * scale, y: frame.top - layer.top + cy * scale };
                    // Both paths open at once: a mouse goes via the host (a capture layer
                    // collects the events), a finger via the sandbox (events are locked inside
                    // the iframe, so only it can report them). Both use the same start point
                    // and the same snapshot, so even arriving together they compute one position.
                    setBox((current) => {
                        frameDragRef.current = { box: current, layer, from };
                        dragRef.current = {
                            mode: "move",
                            from: { x: layer.left + from.x, y: layer.top + from.y },
                            box: current,
                        };
                        return current;
                    });
                    setGrabbing("move");
                    break;
                }
                case "drag": {
                    const drag = frameDragRef.current;
                    if (!drag) break;
                    const cx = Number(command.cx);
                    const cy = Number(command.cy);
                    const frame = frameRef.current?.getBoundingClientRect();
                    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !frame) break;
                    // The frame has already moved along with the panel, so "where the frame is
                    // now + the coordinate inside it" gives the pointer's real position, and
                    // the panel can never chase its own tail however far it moves
                    const nowX = frame.left - drag.layer.left + cx * scale;
                    const nowY = frame.top - drag.layer.top + cy * scale;
                    applyBox({
                        ...drag.box,
                        x: drag.box.x + (nowX - drag.from.x) / drag.layer.width * 100,
                        y: drag.box.y + (nowY - drag.from.y) / drag.layer.height * 100,
                    }, false);
                    break;
                }
                case "dragEnd":
                    if (!frameDragRef.current) break;
                    frameDragRef.current = null;
                    dragRef.current = null;
                    setGrabbing("");
                    setBox((current) => {
                        if (!sameBox(boxRef.current, current)) { boxRef.current = current; onBox(materialId, current); }
                        return current;
                    });
                    break;
                default:
                    // Anything outside the whitelist is ignored
                    break;
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [materialId, onStore, onState, onSay, onBox, canDrag, applyBox, scale]);

    const style: React.CSSProperties = {
        left: `${box.x}%`,
        top: `${box.y}%`,
        width: `${box.w}%`,
        zIndex,
    };
    if (!open && chrome === "bar") {
        // Collapsed there is only the handle left, and the height shrinks with it -- otherwise
        // an empty box stays behind, which is the same as not having collapsed at all
        style.height = "auto";
    } else if (layout.autoHeight) {
        // Height follows content: h degrades to a cap, with a little height before the
        // measurement arrives so a large block does not flash
        style.height = "auto";
        style.maxHeight = `${box.h}%`;
    } else {
        style.height = `${box.h}%`;
    }

    return (
        <div
            ref={rootRef}
            className="mix-panel"
            data-open={open ? "true" : undefined}
            data-plate={plate ? undefined : "false"}
            data-chrome={chrome}
            data-grabbing={grabbing || undefined}
            style={style}
        >
            {chrome === "bar" ? (
                <div
                    className="mix-panel-bar"
                    onPointerDown={(event) => {
                        if (!canDrag || event.button !== 0) return;
                        startGrab("move", { x: event.clientX, y: event.clientY });
                    }}
                >
                    <span className="mix-panel-tab-name">{name}</span>
                    <button
                        type="button"
                        className="mix-panel-fold"
                        onClick={() => setOpen((v) => !v)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
                    >
                        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                    </button>
                </div>
            ) : null}
            {open || chrome === "none" ? (
                <div
                    ref={stageRef}
                    className="mix-panel-stage"
                    style={layout.autoHeight && fitPx ? { flex: "0 0 auto", height: fitPx } : undefined}
                >
                    <iframe
                        ref={frameRef}
                        className="mix-panel-frame"
                        title={name}
                        sandbox="allow-scripts"
                        srcDoc={srcDoc}
                        style={
                            scale !== 1
                                ? {
                                    // Lay out at the design width, then scale the whole thing
                                    // back: everything inside the iframe believes it is on a
                                    // designWidth-wide screen, so the layout never distorts
                                    // with the panel's size
                                    width: designWidth,
                                    height: size.h > 0 ? size.h / scale : "100%",
                                    transform: `scale(${scale})`,
                                    transformOrigin: "top left",
                                }
                                : undefined
                        }
                    />
                </div>
            ) : null}
            {canResize && open ? (
                <div
                    className="mix-panel-grip"
                    aria-hidden="true"
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        startGrab("size", { x: event.clientX, y: event.clientY });
                    }}
                />
            ) : null}
            {/*
              * The transparent capture layer covering the screen during a drag. It has to hang
              * off body: the panel turns on backdrop-filter itself, which makes it the
              * containing block for fixed children, so a layer inside it would be clipped by
              * the panel.
              */}
            {grabbing && typeof document !== "undefined"
                ? createPortal(<div className="mix-panel-catch" data-mode={grabbing} aria-hidden="true" />, document.body)
                : null}
        </div>
    );
}
