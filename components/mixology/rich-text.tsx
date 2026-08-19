"use client";

// House Special -- rich text rendering for an author's note or an opening line. Anything
// containing HTML tags goes into a sandboxed iframe (transparent background, floating over
// the cover scrim, with the layout left entirely to the author); plain text renders as-is.
// The adaptive-height bridge is the same one the receipt canvas uses. allow-scripts with no
// same-origin, so it cannot reach the host page or its data.

import { useEffect, useMemo, useRef, useState } from "react";
import { createMixFrameHeightTracker, nextMixFrameHeight } from "@/lib/mixology/frame-height";

/** Whether it contains HTML tags: if so render the author's own layout, otherwise fall back
 *  to the default text style */
export function mixTextHasHtml(text: string): boolean {
    return /<\/?[a-z][^>]*>/i.test(text);
}

const FRAME_MIN_HEIGHT = 24;
/**
 * Height ceiling. The iframe is scrolling="no", so its height has to equal the content height
 * and anything past it is simply cut off -- which makes this number "the tallest an opening
 * canvas may be". It used to be 2400 (about two and a half screens), which a complex canvas
 * -- several chapters, a full-bleed image, a cast list -- overshoots easily, and the part
 * below was then invisible in the app. Widened to 12000 (about thirteen screens).
 * A ceiling is still kept: if a canvas ever reports an absurd number (a scripting mistake,
 * a loop inflating it), the host must not try to lay out an element hundreds of thousands of
 * pixels tall.
 */
const FRAME_MAX_HEIGHT = 12000;

function RichFrame({ html, inert }: { html: string; inert?: boolean }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameId] = useState(() => `mrf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const [height, setHeight] = useState(FRAME_MIN_HEIGHT);
    const trackerRef = useRef(createMixFrameHeightTracker(FRAME_MIN_HEIGHT));
    const heightRef = useRef(FRAME_MIN_HEIGHT);

    const srcDoc = useMemo(() => {
        // Light text on a transparent background by default, so content is readable floating
        // over the dark cover scrim. An author can override all of it.
        const base = /<html[\s>]/i.test(html)
            ? html
            : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{margin:0;color:#f2f0f7;font:14px/1.8 system-ui,-apple-system,sans-serif;background:transparent;word-break:break-word}</style></head><body>${html}</body></html>`;
        const bridge = `<script>(function(){
  var frameId=${JSON.stringify(frameId)};
  function measure(){var b=document.body;if(!b)return ${FRAME_MIN_HEIGHT};var r=b.getBoundingClientRect();var h=r.height;
    for(var i=0;i<b.children.length;i++){var c=b.children[i].getBoundingClientRect();if(c.width||c.height)h=Math.max(h,c.bottom-r.top);}
    return Math.max(Math.ceil(h),${FRAME_MIN_HEIGHT});}
  function send(){parent.postMessage({source:'mix-rich-frame',type:'resize',id:frameId,height:measure()},'*');}
  function sched(){requestAnimationFrame(function(){send();requestAnimationFrame(send);});}
  window.addEventListener('load',sched);window.addEventListener('resize',sched);
  if(window.MutationObserver)new MutationObserver(sched).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});
  setTimeout(send,60);setTimeout(send,400);
})();</` + `script>`;
        return /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${bridge}</body>`) : base + bridge;
    }, [html, frameId]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "mix-rich-frame" || data.type !== "resize" || data.id !== frameId) return;
            const applied = nextMixFrameHeight(trackerRef.current, Number(data.height), {
                min: FRAME_MIN_HEIGHT,
                max: FRAME_MAX_HEIGHT,
            });
            // Do not re-render when the height did not actually change: animation inside the
            // canvas makes the MutationObserver report continuously.
            if (applied === null || applied === heightRef.current) return;
            heightRef.current = applied;
            setHeight(applied);
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [frameId]);

    return (
        <iframe
            ref={iframeRef}
            title="Rich text"
            sandbox="allow-scripts"
            scrolling="no"
            srcDoc={srcDoc}
            style={{
                width: "100%",
                height,
                border: 0,
                display: "block",
                background: "transparent",
                pointerEvents: inert ? "none" : "auto",
            }}
        />
    );
}

/**
 * inert: for use as a preview inside a button (choosing an opening line), letting the click
 * pass through to the wrapper.
 *
 * The canvas grows asynchronously: once measured, the bridge inside the iframe postMessages the
 * height out. A host that needs to hold a scroll position listens for that message directly --
 * see components/mixology/mixology-game.tsx.
 */
export function MixRichText({ text, inert }: { text: string; inert?: boolean }) {
    if (mixTextHasHtml(text)) return <RichFrame html={text} inert={inert} />;
    return <div className="mix-detail-value">{text}</div>;
}
