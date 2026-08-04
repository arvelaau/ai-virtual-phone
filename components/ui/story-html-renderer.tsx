"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import { translateReasoningText } from "@/lib/reasoning-translate";

/** Standard HTML tags — anything not in this set gets stripped (content kept) */
const STANDARD_TAGS = new Set([
    "a","abbr","address","area","article","aside","audio","b","base","bdi","bdo",
    "blockquote","body","br","button","canvas","caption","cite","code","col",
    "colgroup","data","datalist","dd","del","details","dfn","dialog","div","dl",
    "dt","em","embed","fieldset","figcaption","figure","footer","form","h1","h2",
    "h3","h4","h5","h6","head","header","hgroup","hr","html","i","iframe","img",
    "input","ins","kbd","label","legend","li","link","main","map","mark","menu",
    "meta","meter","nav","noscript","object","ol","optgroup","option","output","p",
    "picture","pre","progress","q","rp","rt","ruby","s","samp","script","search",
    "section","select","slot","small","source","span","strong","style","sub",
    "summary","sup","table","tbody","td","template","textarea","tfoot","th",
    "thead","time","title","tr","track","u","ul","var","video","wbr",
    "svg","path","circle","rect","line","polyline","polygon","text","g","defs",
    "use","clippath","mask","filter","lineargradient","radialgradient","stop",
    "center","font","marquee","strike","tt","big",
]);

// ── Content splitting: separate ```html blocks from regular content ──

type Segment =
    | { type: "markdown"; content: string }
    | { type: "html-page"; content: string }
    | { type: "fold"; label: string; content: string };

/** Fold block: think/thinking (chain-of-thought) has a "Translate" button plus a Chinese/Original/Side-by-Side toggle; other fold tags (summary, custom, etc.) do not */
function StoryFoldBlock({ label, content, scopeClass, children }: {
    label: string;
    content: string;
    scopeClass: string;
    children: ReactNode;
}) {
    const canTranslate = /^(think|thinking)$/i.test(label.trim());
    const [translation, setTranslation] = useState<string | null>(null);
    const [translating, setTranslating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"both" | "zh" | "orig">("both");
    const handleTranslate = async (e: { preventDefault(): void; stopPropagation(): void }) => {
        e.preventDefault();
        e.stopPropagation();
        if (translating) return;
        setTranslating(true);
        setError(null);
        try {
            const result = await translateReasoningText(content);
            if (result.content) { setTranslation(result.content); setViewMode("both"); }
            else setError(result.error || "Translation failed, please try again");
        } catch {
            setError("Translation failed, please try again");
        } finally {
            setTranslating(false);
        }
    };
    const pickMode = (mode: "both" | "zh" | "orig") => (e: { preventDefault(): void; stopPropagation(): void }) => {
        e.preventDefault();
        e.stopPropagation();
        setViewMode(mode);
    };
    return (
        <details className="story-fold-block" data-fold-tag={label}>
            <summary>
                {label}
                {canTranslate && !translation && (
                    <button type="button" className="story-fold-translate-btn" onClick={handleTranslate}>
                        {translating ? "Translating…" : "Translate"}
                    </button>
                )}
                {canTranslate && translation && (
                    <span className="story-fold-view-switch">
                        {([["zh", "Chinese"], ["orig", "Original"], ["both", "Side-by-Side"]] as const).map(([mode, text]) => (
                            <button
                                key={mode}
                                type="button"
                                className="story-fold-translate-btn"
                                {...(viewMode === mode ? { "data-active": "" } : {})}
                                onClick={pickMode(mode)}
                            >{text}</button>
                        ))}
                    </span>
                )}
            </summary>
            <div className="story-fold-block__content">
                {error && <div className="story-fold-translate-error">{error}</div>}
                {translation && viewMode !== "orig" && (
                    <div className={viewMode === "both" ? "story-fold-translation" : undefined}>
                        <MarkdownSegment content={translation} scopeClass={scopeClass} />
                    </div>
                )}
                {(viewMode !== "zh" || !translation) && children}
            </div>
        </details>
    );
}

function splitContent(text: string): Segment[] {
    if (!text) return [];
    const segments: Segment[] = [];
    const foldRx = /<!--RHR-FOLD:([^>]+)-->\s*([\s\S]*?)\s*<!--\/RHR-FOLD-->/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = foldRx.exec(text)) !== null) {
        segments.push(...splitNonFoldContent(text.slice(lastIndex, match.index)));
        const content = match[2].trim();
        if (content) segments.push({ type: "fold", label: match[1] || "fold", content });
        lastIndex = match.index + match[0].length;
    }
    segments.push(...splitNonFoldContent(text.slice(lastIndex)));
    return segments;
}

function splitNonFoldContent(text: string): Segment[] {
    const segments: Segment[] = [];
    const rx = /```html\s*\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rx.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before) segments.push({ type: "markdown", content: before });
        const html = match[1].trim();
        if (html) segments.push({ type: "html-page", content: html });
        lastIndex = match.index + match[0].length;
    }
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ type: "markdown", content: remaining });
    return segments;
}

// ── Markdown segment: marked + scoped HTML rendering ──

/** Scope CSS selectors inside <style> blocks to prevent leaking */
function scopeStyles(html: string, scopeClass: string): string {
    return html.replace(/<style>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
        // Prefix each CSS rule selector with the scope class
        const scoped = css.replace(
            /([^{}@/][^{}]*)\{/g,
            (ruleMatch: string, selector: string) => {
                const trimmed = selector.trim();
                if (!trimmed || trimmed.startsWith("@") || trimmed.startsWith("from") ||
                    trimmed.startsWith("to") || /^\d+%/.test(trimmed)) {
                    return ruleMatch;
                }
                const prefixed = trimmed.split(",").map(s => {
                    const st = s.trim();
                    if (!st) return st;
                    if (st === ":root") return `.${scopeClass}`;
                    return `.${scopeClass} ${st}`;
                }).join(", ");
                return `${prefixed} {`;
            }
        );
        return `<style>${scoped}</style>`;
    });
}

// Configure marked for chat-style line breaks.
marked.setOptions({
    breaks: true,      // line breaks → <br>
    gfm: true,         // GitHub Flavored Markdown (tables, strikethrough)
});

function MarkdownSegment({ content, scopeClass }: { content: string; scopeClass: string }) {
    const html = useMemo(() => {
        // 0. Pre-process:
        const preprocessed = content
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>/g, (match, tag) =>  // strip all non-standard HTML tags (keep content)
                STANDARD_TAGS.has(tag.toLowerCase()) ? match : "")
            .replace(/^[ \t]+/gm, "")                     // strip leading whitespace (prevents marked treating indented HTML as code blocks)
            .replace(/\n{3,}/g, "\n\n")                    // max 2 consecutive newlines
            .replace(/(>)\s*\n\n\s*(<)/g, "$1\n$2");       // remove blank lines between HTML tags

        // 1. Markdown → HTML
        const rawHtml = marked.parse(preprocessed, { async: false }) as string;

        // 2. Strip only <script> tags (security), keep everything else as-is
        //    No DOMPurify — regex-processed HTML is user-configured and trusted
        const clean = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

        // 3. Scope <style> blocks to prevent CSS leaking
        const scoped = scopeStyles(clean, scopeClass);

        // 4. Clean up whitespace artifacts
        const trimmed = scoped
            .replace(/(<\/div>|<\/details>|<\/table>|<\/p>)\s*(<br\s*\/?>)\s*/gi, "$1")
            .replace(/(<br\s*\/?>){3,}/gi, "<br>")
            .replace(/<p>\s*<\/p>/gi, "")
            .replace(/<p>\s*(<br\s*\/?>)\s*<\/p>/gi, "");

        return trimmed;
    }, [content, scopeClass]);

    return <div className={scopeClass} style={{ whiteSpace: "normal" }} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Inline action click delegate ──
// Catches clicks on elements with data-action attribute inside MarkdownSegments
function useActionDelegate(containerRef: React.RefObject<HTMLDivElement | null>, onAction?: (text: string) => void) {
    useEffect(() => {
        if (!onAction) return;
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: MouseEvent) => {
            const target = (e.target as HTMLElement).closest("[data-action]");
            if (target) {
                e.preventDefault();
                e.stopPropagation();
                const action = target.getAttribute("data-action");
                if (action) onAction(action);
            }
        };
        el.addEventListener("click", handler, true);
        return () => el.removeEventListener("click", handler, true);
    }, [containerRef, onAction]);
}

// ── HTML page segment: srcDoc iframe ──

interface HtmlPageProps {
    html: string;
    onOptionSelect?: (text: string) => void;
    htmlPageMode: "auto" | "contained";
}

function HtmlPageSegment({ html, onOptionSelect, htmlPageMode }: HtmlPageProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(0);
    const contained = htmlPageMode === "contained";

    const srcDoc = useMemo(() => {
        // Height bridging: reuses the "stable-by-construction" approach from the black-market
        // theater feature — getBoundingClientRect measures real content and can shrink back down;
        // MutationObserver + a bunch of events catch any change (custom buttons included);
        // body height = content height, and the parent changing the iframe height doesn't feed
        // back into the content → the measurement stays stable → naturally no feedback loop.
        // The iframe itself never scrolls internally (iOS's gesture support for scrolling inside
        // an iframe document is unreliable, and fixed/100vh elements in generated pages would make
        // the whole page unswipeable); in "contained" mode, scrolling is instead handled by the
        // outer same-document div. height:auto collapses the height:100vh commonly seen in
        // generated pages back down to content height, keeping measurement and gesture chaining correct.
        const bridge = `<style>html,body{overflow:hidden!important;height:auto!important;min-height:0!important}</style><script>(function(){function measure(){var d=document.documentElement;var b=document.body;if(!b)return 0;var br=b.getBoundingClientRect();var h=Math.max(br.height,b.scrollHeight||0,d?d.scrollHeight||0:0);for(var i=0;i<b.children.length;i++){var c=b.children[i];var r=c.getBoundingClientRect();if(r.width||r.height)h=Math.max(h,r.bottom-br.top,c.scrollHeight||0)}return Math.ceil(h)}function send(){window.parent.postMessage({type:"_rhr",h:measure()},"*")}function schedule(){requestAnimationFrame(function(){send();requestAnimationFrame(send)})}window.addEventListener("load",schedule);window.addEventListener("resize",schedule);document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("[data-action]");if(t){var a=t.getAttribute("data-action");if(a){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:"_rhr_opt",text:a},"*")}}schedule()},true);document.addEventListener("toggle",schedule,true);document.addEventListener("transitionend",schedule,true);document.addEventListener("animationend",schedule,true);if(window.MutationObserver)new MutationObserver(schedule).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});if(window.ResizeObserver){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}setTimeout(send,80);setTimeout(send,500);setTimeout(send,1600)})();<\/script>`;
        let h = html;
        // Convert basic markdown inside hidden data divs
        h = h.replace(
            /(<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/gi,
            (_m, open, content, close) => open + content
                .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.+?)\*/g, "<em>$1</em>")
            + close
        );
        // Patch template JS: .textContent → .innerHTML so <strong>/<em> tags are preserved
        h = h.replace(/\.textContent\.trim\(\)/g, ".innerHTML.trim()");
        if (h.includes("</body>")) h = h.replace("</body>", bridge + "</body>");
        else h = h + bridge;
        return h;
    }, [html, contained]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== "object") return;
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
            if (e.data.type === "_rhr" && typeof e.data.h === "number") {
                setHeight(Math.max(e.data.h, 50));
            }
            if (e.data.type === "_rhr_opt" && typeof e.data.text === "string") {
                onOptionSelect?.(e.data.text);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [onOptionSelect]);

    const frame = (
        <iframe
            ref={iframeRef}
            srcDoc={srcDoc}
            title="HTML content"
            style={{
                width: "100%",
                height,
                border: "none",
                display: "block",
                borderRadius: 12,
            }}
        />
    );

    if (!contained) return frame;

    // contained: the iframe expands to its full content height, and scrolling is delegated to
    // this same-document outer container (iframe-internal scroll gestures are unreliable on iOS,
    // while a same-document scroller is always reliable)
    return (
        <div style={{
            maxHeight: "min(68dvh, 560px)",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
            borderRadius: 12,
        }}>
            {frame}
        </div>
    );
}

// ── Main component ──

export interface StoryHtmlRendererProps {
    content: string;
    messageId: string;
    onOptionSelect?: (text: string) => void;
    htmlPageMode?: "auto" | "contained";
}

function StoryHtmlRendererInner({ content, messageId, onOptionSelect, htmlPageMode = "auto" }: StoryHtmlRendererProps) {
    const segments = useMemo(() => splitContent(content), [content]);
    const scopeClass = `smsg-${messageId.slice(-8)}`;
    const containerRef = useRef<HTMLDivElement>(null);
    useActionDelegate(containerRef, onOptionSelect);

    return (
        <div className="story-richtext" ref={containerRef}>
            {segments.map((seg, i) => {
                if (seg.type === "html-page") {
                    return <HtmlPageSegment key={`hp-${i}`} html={seg.content} onOptionSelect={onOptionSelect} htmlPageMode={htmlPageMode} />;
                }
                if (seg.type === "fold") {
                    return (
                        <StoryFoldBlock key={`fold-${i}`} label={seg.label} content={seg.content} scopeClass={scopeClass}>
                            {splitContent(seg.content).map((innerSeg, innerIndex) => {
                                if (innerSeg.type === "html-page") {
                                    return <HtmlPageSegment key={`fold-hp-${i}-${innerIndex}`} html={innerSeg.content} onOptionSelect={onOptionSelect} htmlPageMode={htmlPageMode} />;
                                }
                                if (innerSeg.type === "fold") {
                                    return (
                                        <StoryFoldBlock key={`fold-inner-${i}-${innerIndex}`} label={innerSeg.label} content={innerSeg.content} scopeClass={scopeClass}>
                                            <MarkdownSegment content={innerSeg.content} scopeClass={scopeClass} />
                                        </StoryFoldBlock>
                                    );
                                }
                                return <MarkdownSegment key={`fold-md-${i}-${innerIndex}`} content={innerSeg.content} scopeClass={scopeClass} />;
                            })}
                        </StoryFoldBlock>
                    );
                }
                return <MarkdownSegment key={`md-${i}`} content={seg.content} scopeClass={scopeClass} />;
            })}
        </div>
    );
}

export const StoryHtmlRenderer = memo(StoryHtmlRendererInner);
