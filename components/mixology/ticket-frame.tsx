"use client";

// House Special -- the receipt canvas: a receipt material's renderHtml runs inside a
// sandboxed iframe, and the AI's raw [StatusPanel] contents are injected through
// window.TICKET_RAW (for JS) and {{RAW}} (spliced straight into the template, escaped).
// The adaptive-height bridge is the same one the custom status bar uses. allow-scripts with
// no same-origin, so it cannot reach the host page or its data.

import { useEffect, useMemo, useRef, useState } from "react";
import type { MixState } from "@/lib/mixology/types";
import { createMixFrameHeightTracker, nextMixFrameHeight } from "@/lib/mixology/frame-height";

const FRAME_MIN_HEIGHT = 36;
/**
 * Receipts and encores are scrolling="no" as well, so anything past the height is cut. They
 * sit inline in the conversation every turn and should not run to a dozen screens the way an
 * opening canvas can, so the allowance is a notch smaller: it used to be 2000 (about two
 * screens), which even a slightly complex skit hits, so it is now 5000 (about five and a half).
 */
const FRAME_MAX_HEIGHT = 5000;

function escapeHtmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSrcDoc(html: string, raw: string, state?: MixState): string {
    const withRaw = html.split("{{RAW}}").join(escapeHtmlText(raw));
    const base = /<html[\s>]/i.test(withRaw)
        ? withRaw
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${withRaw}</body></html>`;
    // MIX_STATE holds this session's remembered values, so render code can draw a health bar
    // or switch palette from them without waiting for the AI to restate them every turn
    const inject = `<script>window.TICKET_RAW=${JSON.stringify(raw)};window.ENCORE_RAW=window.TICKET_RAW;window.MIX_STATE=${JSON.stringify(state ?? {})};</` + `script>`;
    return /<head[\s>]/i.test(base)
        ? base.replace(/<head([^>]*)>/i, `<head$1>${inject}`)
        : inject + base;
}

export function MixTicketFrame({ html, raw, state }: { html: string; raw: string; state?: MixState }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameId] = useState(() => `mtf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const [height, setHeight] = useState(FRAME_MIN_HEIGHT);
    const trackerRef = useRef(createMixFrameHeightTracker(FRAME_MIN_HEIGHT));

    const srcDoc = useMemo(() => {
        const doc = buildSrcDoc(html, raw, state);
        const bridge = `<script>(function(){
  var frameId=${JSON.stringify(frameId)};
  /* Measure from the content's bounding box only. scrollHeight grows with the iframe viewport,
     which forms the "taller every time you measure" feedback loop. */
  function measure(){var b=document.body;if(!b)return ${FRAME_MIN_HEIGHT};
    var cs=window.getComputedStyle(b);var mt=parseFloat(cs.marginTop)||0;var mb=parseFloat(cs.marginBottom)||0;
    var h=b.getBoundingClientRect().height+mt+mb;
    for(var i=0;i<b.children.length;i++){var c=b.children[i].getBoundingClientRect();if(c.width||c.height)h=Math.max(h,c.bottom+mb);}
    return Math.max(Math.ceil(h)+2,${FRAME_MIN_HEIGHT});}
  function send(){parent.postMessage({source:'mix-ticket-frame',type:'resize',id:frameId,height:measure()},'*');}
  function sched(){requestAnimationFrame(function(){send();requestAnimationFrame(send);});}
  window.addEventListener('load',sched);window.addEventListener('resize',sched);
  if(window.MutationObserver)new MutationObserver(sched).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});
  if(window.ResizeObserver&&document.body)new ResizeObserver(sched).observe(document.body);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(sched);
  setTimeout(send,60);setTimeout(send,400);setTimeout(send,1200);
})();</` + `script>`;
        return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${bridge}</body>`) : doc + bridge;
    }, [html, raw, state, frameId]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "mix-ticket-frame" || data.type !== "resize" || data.id !== frameId) return;
            const applied = nextMixFrameHeight(trackerRef.current, Number(data.height), {
                min: FRAME_MIN_HEIGHT,
                max: FRAME_MAX_HEIGHT,
            });
            if (applied !== null) setHeight(applied);
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [frameId]);

    return (
        <iframe
            ref={iframeRef}
            title="Receipt"
            sandbox="allow-scripts"
            scrolling="no"
            srcDoc={srcDoc}
            style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
        />
    );
}
