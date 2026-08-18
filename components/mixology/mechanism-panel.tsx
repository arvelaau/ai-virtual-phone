"use client";

// House Special -- a mechanism's persistent panel.
//
// This is a different thing from the hook sandbox. A hook is a pure function that gets
// called, runs, and is done; this is something that stays on screen and keeps its own state,
// so it must persist and never be rebuilt -- reinserting it each turn would restart a player
// from the top, scroll a memory pane back to the beginning, and snap a tab strip back to the
// first tab.
//
// What it can do is a whitelist, and only these: write its own storage, write remembered
// values, speak as the player, and collapse or expand itself. Any message outside the
// whitelist is ignored.
// Placement is decided by the app and the panel only picks a dock -- otherwise three
// mechanisms together would paper over the screen and leave the input box unreachable.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { MIX_DOCK_LABELS, type MixDock, type MixState } from "@/lib/mixology/types";
import { normalizeMechanismStore, type MixMechanismStore } from "@/lib/mixology/mechanism-protocol";

/** The actions a panel may request -- just these */
type PanelCommand =
    | { name: "setStore"; store: unknown }
    | { name: "setState"; state: unknown }
    | { name: "say"; text: unknown }
    | { name: "setOpen"; open: unknown };

const MAX_SAY_LENGTH = 2_000;

function buildPanelDoc(html: string, state: MixState, store: MixMechanismStore): string {
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
    close: function(){ send("setOpen", { open: false }); }
  };
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
})();
</` + `script>`;
    const body = /<html[\s>]/i.test(html)
        ? html
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>`
          // A panel needs to show images and play audio, so this is a notch looser than the
          // hook sandbox -- but there is still no connect-src, so fetch / XHR / WebSocket
          // cannot get out.
          + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:"/>`
          + `<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:#f2f0f7;font-family:system-ui,-apple-system,sans-serif;font-size:12px}input,textarea,button,select{max-width:100%;font-family:inherit;font-size:inherit}</style>`
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
    dock,
    html,
    state,
    store,
    onStore,
    onState,
    onSay,
}: {
    materialId: string;
    name: string;
    dock: MixDock;
    html: string;
    state: MixState;
    store: MixMechanismStore;
    onStore: (materialId: string, store: MixMechanismStore) => void;
    onState: (state: MixState) => void;
    onSay: (text: string) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    // The floating button starts collapsed; every other dock starts expanded
    const [open, setOpen] = useState(dock !== "float");

    // srcDoc is only recomputed when the panel's code changes. state/store arrive by message
    // instead and must NOT be inputs here, or the iframe would reload on every value change --
    // which is the opposite of persistent.
    const srcDoc = useMemo(() => buildPanelDoc(html, state, store), [html]); // eslint-disable-line react-hooks/exhaustive-deps

    const post = useCallback((payload: Record<string, unknown>) => {
        try {
            frameRef.current?.contentWindow?.postMessage({ source: "mix-panel-host", ...payload }, "*");
        } catch {
            // If it cannot be handed in, let it go; the next sync will try again
        }
    }, []);

    useEffect(() => {
        post({ state, store });
    }, [state, store, post]);

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
                default:
                    // Anything outside the whitelist is ignored
                    break;
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [materialId, onStore, onState, onSay]);

    return (
        <div className="mix-panel" data-dock={dock} data-open={open ? "true" : undefined}>
            <button
                type="button"
                className="mix-panel-tab"
                onClick={() => setOpen((v) => !v)}
                aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
                title={`${name} · ${MIX_DOCK_LABELS[dock]}`}
            >
                <span className="mix-panel-tab-name">{name}</span>
                {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            </button>
            {open ? (
                <iframe
                    ref={frameRef}
                    className="mix-panel-frame"
                    title={name}
                    sandbox="allow-scripts"
                    srcDoc={srcDoc}
                />
            ) : null}
        </div>
    );
}
