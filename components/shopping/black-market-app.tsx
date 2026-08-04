"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronLeft,
  Copy,
  Eye,
  FileText,
  Pencil,
  Plus,
  MoreHorizontal,
  PenLine,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { kvGet, kvSet } from "@/lib/kv-db";

import {
  BLACK_MARKET_DAILY_CHECKIN_CREDITS,
  BLACK_MARKET_UPDATED_EVENT,
  copyBlackMarketTheaterToVault,
  discardBlackMarketSceneSession,
  deleteBlackMarketTheaterProjectionEvent,
  deleteBlackMarketOwnedTheater,
  formatShadowCredits,
  getBlackMarketCatalog,
  getBlackMarketSceneSession,
  appendBlackMarketSceneMessage,
  loadAllBlackMarketTheaterProjectionEntries,
  loadBlackMarketSceneSessions,
  loadBlackMarketState,
  startBlackMarketSceneSession,
  syncBlackMarketWallet,
  syncOwnedBlackMarketTheaterSnapshot,
  trimBlackMarketSceneMessagesFrom,
  updateBlackMarketSceneMessageAndTrimAfter,
} from "@/lib/black-market-storage";
import {
  expandBlackMarketMacros,
  generateBlackMarketSceneReply,
  summarizeAndRecordBlackMarketScene,
} from "@/lib/black-market-scene-engine";
import {
  checkInBlackMarketCloud,
  deleteBlackMarketTheater,
  fetchBlackMarketTheater,
  fetchPurchasedBlackMarketTheatersCloud,
  fetchBlackMarketTheaters,
  fetchBlackMarketWallet,
  publishBlackMarketTheater,
  purchaseBlackMarketTheaterCloud,
  updateBlackMarketTheater,
} from "@/lib/black-market-client";
import { useAccount } from "@/lib/account-context";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { BlackMarketOwnedTheater, BlackMarketRenderRule, BlackMarketSceneSession, BlackMarketState, BlackMarketTheaterProjectionEntry, BlackMarketTheaterTemplate } from "@/lib/black-market-types";

type BlackMarketAppProps = {
  onClose: () => void;
};

type BlackMarketTab = "market" | "vault" | "ledger" | "studio";
type BlackMarketStudioMode = "published" | "drafts" | "create";
type BlackMarketPreviewMode = "info" | "opening";
type BlackMarketSceneBusy = "reply" | "summary" | null;
type BlackMarketDeleteTarget =
  | { kind: "owned"; localId: string }
  | { kind: "published"; templateId: string };
type BlackMarketExternalCanvasRequest = "start" | "resume" | null;
type BlackMarketSceneConfirmAction = "return" | "archive" | "restart" | "summary";
type BlackMarketPublishChoice = {
  sourceTemplateId: string;
  sourceTemplateTitle: string;
};

type BlackMarketNotice = {
  id: number;
  tone: "success" | "error" | "info";
  text: string;
};

const MARKET_TABS: Array<{ id: BlackMarketTab; label: string }> = [
  { id: "market", label: "Market" },
  { id: "vault", label: "Vault" },
  { id: "ledger", label: "Ledger" },
  { id: "studio", label: "Studio" },
];

const BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT = 320;
const BLACK_MARKET_THEATER_FRAME_COLLAPSE_THRESHOLD = 900;
const BLACK_MARKET_THEATER_FRAME_COLLAPSED_HEIGHT = 620;
const BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT = 90;
const BLACK_MARKET_STUDIO_DRAFTS_KEY = "ai_phone_black_market_studio_drafts_v1";
const BLACK_MARKET_STUDIO_TEST_USER_SAMPLE = "What exactly are you trying to hide right now?";
const BLACK_MARKET_STUDIO_TEST_ASSISTANT_SAMPLE = `*He suddenly clenches his cuff, his breath catching for a beat.*

【秘密】I did know the answer all along — I just didn't want you to hear me admit it out loud.

\`\`\`html
<style>
  body{margin:0;background:#050608;color:#ecfdf5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px}
  .probe{border:1px solid rgba(0,255,102,.28);padding:12px;background:rgba(0,255,102,.06)}
  button{margin-top:10px;border:1px solid #00ff66;background:transparent;color:#00ff66;padding:8px 10px}
</style>
<div class="probe">
  <b>INTERACTION TEST</b>
  <p>This is an html canvas inside an ASSISTANT reply.</p>
  <button data-action="Keep pressing about this secret">Keep pressing</button>
</div>
\`\`\``;

type TheaterDraft = {
  title: string;
  codeName: string;
  subtitle: string;
  synopsis: string;
  storyText: string;
  tagsText: string;
  price: string;
  authorName: string;
  openingHtml: string;
  allowExternalControl: boolean;
  aiInstruction: string;
  outputContract: string;
  renderRulesText: string;
  renderCss: string;
  memorySummaryPrompt: string;
};

type BlackMarketStudioDraft = {
  id: string;
  title: string;
  draft: TheaterDraft;
  sourceTemplateId?: string;
  sourceTemplateTitle?: string;
  createdAt: string;
  updatedAt: string;
};

function formatBlackMarketDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function generateBlackMarketFileNumber(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const prefix = letters[Math.floor(Math.random() * letters.length)] || "X";
  const slot = Math.floor(Math.random() * 10);
  const suffix = Date.now().toString(36).slice(-3).toUpperCase();
  return `${prefix}${slot}-${suffix}`;
}

function getBlackMarketFileNumber(template: BlackMarketTheaterTemplate): string {
  return template.fileNumber?.trim() || "AUTO";
}

function isFullBlackMarketTheater(template: BlackMarketTheaterTemplate): boolean {
  return Boolean(template.openingHtml && template.aiInstruction);
}

function escapeSceneHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeRenderHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function sanitizeRenderCss(value: string): string {
  return value.replace(/<\/?style\b[^>]*>/gi, "").replace(/<\/?script\b[^>]*>/gi, "");
}

function preserveRenderedHtmlSegment(value: string): string {
  return escapeSceneHtml(value).replace(/\n/g, "<br />");
}

function restoreRenderedHtmlMarkers(html: string, renderedSegments: Array<{ marker: string; html: string }>): string {
  let restored = html;
  for (let pass = 0; pass <= renderedSegments.length; pass += 1) {
    let changed = false;
    for (const segment of renderedSegments) {
      if (!restored.includes(segment.marker)) continue;
      restored = restored.split(segment.marker).join(segment.html);
      changed = true;
    }
    if (!changed) break;
  }
  return restored.replace(/\uE000BM_RENDER_\d+\uE000/g, "");
}

type BlackMarketReplySegment =
  | { type: "text"; content: string }
  | { type: "html"; content: string };

function splitBlackMarketReplyContent(content: string): BlackMarketReplySegment[] {
  const segments: BlackMarketReplySegment[] = [];
  const regex = /```html[^\n]*\n([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: "text", content: before });
    const html = match[1]?.trim();
    if (html) segments.push({ type: "html", content: html });
    lastIndex = match.index + match[0].length;
  }

  const rest = content.slice(lastIndex);
  if (rest.trim()) segments.push({ type: "text", content: rest });
  return segments.length > 0 ? segments : [{ type: "text", content }];
}

function normalizeRegexFlags(flags: string): string {
  const unique = Array.from(new Set(flags.split("").filter(flag => "dgimsuvy".includes(flag))));
  if (!unique.includes("g")) unique.push("g");
  return unique.join("");
}

function createBlackMarketTheaterFrameSrcDoc(html: string, frameId: string): string {
  const body = html.trim();
  const base = /<html[\s>]/i.test(body)
    ? body
    : `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body>
${body}
</body>
</html>`;

  const bridge = `<style>
html,body{
  overflow:hidden!important;
  -webkit-overflow-scrolling:touch;
  min-height:0!important;
}
</style>
<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  function measureHeight(){
    var body = document.body;
    if (!body) return ${BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT};
    var bodyRect = body.getBoundingClientRect();
    var height = bodyRect.height;
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      var rect = child.getBoundingClientRect();
      if (rect.width || rect.height) height = Math.max(height, rect.bottom - bodyRect.top);
    }
    return Math.max(Math.ceil(height), ${BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT});
  }
  function sendHeight(){
    var height = measureHeight();
    parent.postMessage({ source: 'black-market-theater-frame', type: 'resize', id: frameId, height: height }, '*');
  }
  function scheduleHeight(){
    requestAnimationFrame(function(){
      sendHeight();
      requestAnimationFrame(sendHeight);
    });
  }
  var existing = window.Theater || {};
  window.Theater = Object.assign({
    startScene: function(payload){ parent.postMessage({ source:'black-market-theater', type:'startScene', payload: payload || {} }, '*'); },
    sendUserAction: function(text){ parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: text || '' }, '*'); },
    endScene: function(){ parent.postMessage({ source:'black-market-theater', type:'endScene' }, '*'); }
  }, existing);
  window.addEventListener('load', scheduleHeight);
  window.addEventListener('resize', scheduleHeight);
  document.addEventListener('click', scheduleHeight, true);
  document.addEventListener('toggle', scheduleHeight, true);
  document.addEventListener('transitionend', scheduleHeight, true);
  document.addEventListener('animationend', scheduleHeight, true);
  if (window.MutationObserver) {
    new MutationObserver(scheduleHeight).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleHeight);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  setTimeout(sendHeight, 80);
  setTimeout(sendHeight, 500);
  setTimeout(sendHeight, 1600);
})();
</script>`;

  return /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${bridge}</body>`) : `${base}${bridge}`;
}

function createBlackMarketReplyFrameSrcDoc(html: string, frameId: string): string {
  const body = html.trim();
  const base = /<html[\s>]/i.test(body)
    ? body
    : `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body>
${body}
</body>
</html>`;

  const bridge = `<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  function measureHeight(){
    var body = document.body;
    if (!body) return ${BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT};
    var bodyRect = body.getBoundingClientRect();
    var height = bodyRect.height;
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      var rect = child.getBoundingClientRect();
      if (rect.width || rect.height) height = Math.max(height, rect.bottom - bodyRect.top);
    }
    return Math.max(Math.ceil(height), ${BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT});
  }
  function sendHeight(){
    var height = measureHeight();
    parent.postMessage({ source: 'black-market-reply-canvas', type: 'resize', id: frameId, height: height }, '*');
  }
  function scheduleHeight(){
    requestAnimationFrame(function(){
      sendHeight();
      requestAnimationFrame(sendHeight);
    });
  }
  window.Theater = window.Theater || {
    startScene: function(payload){ parent.postMessage({ source:'black-market-theater', type:'startScene', payload: payload || {} }, '*'); },
    sendUserAction: function(text){ parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: text || '' }, '*'); },
    endScene: function(){ parent.postMessage({ source:'black-market-theater', type:'endScene' }, '*'); }
  };
  document.addEventListener('click', function(event){
    var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target) return;
    event.preventDefault();
    parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: target.getAttribute('data-action') || target.textContent || '' }, '*');
  }, true);
  window.addEventListener('load', scheduleHeight);
  window.addEventListener('resize', scheduleHeight);
  document.addEventListener('click', scheduleHeight, true);
  document.addEventListener('toggle', scheduleHeight, true);
  document.addEventListener('transitionend', scheduleHeight, true);
  document.addEventListener('animationend', scheduleHeight, true);
  if (window.MutationObserver) {
    new MutationObserver(scheduleHeight).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleHeight);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  setTimeout(sendHeight, 80);
  setTimeout(sendHeight, 500);
  setTimeout(sendHeight, 1600);
})();
</script>`;

  return /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${bridge}</body>`) : `${base}${bridge}`;
}

function BlackMarketTheaterHtmlFrame({
  html,
  title,
  allowExternalControl = false,
  collapsible = false,
}: {
  html: string;
  title: string;
  allowExternalControl?: boolean;
  collapsible?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameId] = useState(() => `bm_theater_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [height, setHeight] = useState(BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const srcDoc = useMemo(() => createBlackMarketTheaterFrameSrcDoc(html, frameId), [frameId, html]);
  const canCollapse = collapsible && height > BLACK_MARKET_THEATER_FRAME_COLLAPSE_THRESHOLD;
  const displayedHeight = canCollapse && collapsed
    ? Math.min(height, BLACK_MARKET_THEATER_FRAME_COLLAPSED_HEIGHT)
    : height;

  useEffect(() => {
    setCollapsed(false);
  }, [html]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      const isBridgeResize = record.source === "black-market-theater-frame" && record.type === "resize" && record.id === frameId;
      const isLegacyResize = record.source === "black-market-theater" && record.type === "resize";
      if (!isBridgeResize && !isLegacyResize) return;
      const nextHeight = Number(record.height);
      if (!Number.isFinite(nextHeight)) return;
      setHeight(Math.max(BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT, Math.round(nextHeight)));
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId]);

  return (
    <div className="cp-black-market-frame-wrap">
      <iframe
        ref={iframeRef}
        title={title}
        className="cp-black-market-preview-frame"
        sandbox={allowExternalControl ? "allow-scripts allow-same-origin" : "allow-scripts"}
        allow="autoplay"
        scrolling="no"
        srcDoc={srcDoc}
        style={{ height: displayedHeight, touchAction: "pan-y" }}
      />
      {canCollapse ? (
        <button
          type="button"
          className="cp-black-market-frame-toggle"
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? "Expand full opening" : "Collapse opening"}
        </button>
      ) : null}
    </div>
  );
}

function renderSceneMessageHtml(content: string, template?: BlackMarketTheaterTemplate): string {
  let text = content;
  const renderedSegments: Array<{ marker: string; html: string }> = [];
  if (!template || template.renderRules.length === 0) return escapeSceneHtml(text).replace(/\n/g, "<br />");
  for (const rule of template.renderRules) {
    try {
      const regex = new RegExp(rule.pattern, normalizeRegexFlags(rule.flags));
      text = text.replace(regex, (...args: unknown[]) => {
        const full = String(args[0] ?? "");
        const hasNamedGroups = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
        const captureEnd = hasNamedGroups ? args.length - 3 : args.length - 2;
        const captures = args.slice(1, captureEnd).map(value => String(value ?? ""));
        const namedGroups = hasNamedGroups ? args[args.length - 1] as Record<string, unknown> : null;
        let output = rule.template || "<span>$&</span>";
        output = output.replace(/\$&/g, preserveRenderedHtmlSegment(full));
        captures.forEach((capture, index) => {
          output = output.replace(new RegExp(`\\$${index + 1}`, "g"), preserveRenderedHtmlSegment(capture));
        });
        if (namedGroups) {
          output = output.replace(/\$<([^>]+)>/g, (_match, name: string) => preserveRenderedHtmlSegment(String(namedGroups[name] ?? "")));
        }
        const marker = `\uE000BM_RENDER_${renderedSegments.length}\uE000`;
        renderedSegments.push({ marker, html: sanitizeRenderHtml(output) });
        return marker;
      });
    } catch {
      continue;
    }
  }
  const html = escapeSceneHtml(text).replace(/\n/g, "<br />");
  return restoreRenderedHtmlMarkers(html, renderedSegments);
}

function BlackMarketReplyHtmlFrame({ html, title, allowExternalControl = false }: { html: string; title: string; allowExternalControl?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameId] = useState(() => `bm_reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [height, setHeight] = useState(BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT);
  const srcDoc = useMemo(() => createBlackMarketReplyFrameSrcDoc(html, frameId), [frameId, html]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "black-market-reply-canvas" || record.type !== "resize" || record.id !== frameId) return;
      const nextHeight = Number(record.height);
      if (!Number.isFinite(nextHeight)) return;
      setHeight(Math.max(BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT, Math.round(nextHeight)));
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId]);

  return (
    <iframe
      ref={iframeRef}
      title={title}
      className="cp-black-market-reply-frame"
      sandbox={allowExternalControl ? "allow-scripts allow-same-origin" : "allow-scripts"}
      allow="autoplay"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}

function BlackMarketSceneMessageContent({
  content,
  template,
  characterName,
  userName,
  messageId,
  allowExternalControl = false,
}: {
  content: string;
  template: BlackMarketTheaterTemplate;
  characterName: string;
  userName: string;
  messageId: string;
  allowExternalControl?: boolean;
}) {
  const segments = useMemo(() => splitBlackMarketReplyContent(content), [content]);

  return (
    <div className="cp-black-market-scene-message-body">
      {segments.map((segment, index) => {
        if (segment.type === "html") {
          return (
            <BlackMarketReplyHtmlFrame
              key={`${messageId}-html-${index}`}
              title={`Scene reply canvas ${index + 1}`}
              html={expandBlackMarketMacros(segment.content, characterName, userName)}
              allowExternalControl={allowExternalControl}
            />
          );
        }
        return (
          <div
            key={`${messageId}-text-${index}`}
            className="cp-black-market-scene-text-segment"
            dangerouslySetInnerHTML={{ __html: renderSceneMessageHtml(segment.content, template) }}
          />
        );
      })}
    </div>
  );
}

function resolveOwnedTemplateIds(state: BlackMarketState): Set<string> {
  return new Set(state.ownedTheaters.map(item => item.remoteTemplateId));
}

function createStarterOpeningHtml(title = "Custom Night Archive", codeName = "CUSTOM_THEATER"): string {
  return String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;background:#050608;color:#ecfdf5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    body{min-height:100%;display:grid;place-items:center;padding:18px}
    .card{width:min(100%,360px);background:#080c0a;border:1px solid rgba(82,255,158,.22);padding:18px;box-shadow:0 22px 60px rgba(0,0,0,.42)}
    .label{font-size: calc(10px*var(--app-text-scale,1));color:#52ff9e;letter-spacing:.12em}
    h1{margin:9px 0 4px;font-size: calc(23px*var(--app-text-scale,1));line-height:1}
    p{margin:0;color:#a8b7b0;font:calc(13px*var(--app-text-scale,1))/1.7 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap}
    button{margin-top:16px;min-height:38px;border:0;background:#52ff9e;color:#050608;font:800 calc(12px*var(--app-text-scale,1)) ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 14px;cursor:pointer}
  </style>
</head>
<body>
  <main class="card">
    <div class="label">${codeName} // OPENING CANVAS</div>
    <h1>${title}</h1>
    <p>Write the opening story, buttons, animations, and interactions {{user}} sees after clicking "Unseal Archive" here.
You can use the {{char}} and {{user}} macros; they'll be replaced with the current character and the bound user persona name when actually unsealed.</p>
    <button onclick="Theater.startScene({custom:true})">Unseal Story</button>
  </main>
  <script>
    window.Theater = window.Theater || {
      startScene: function(payload){ parent.postMessage({ source:'black-market-theater', type:'startScene', payload: payload || {} }, '*'); },
      sendUserAction: function(text){ parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: text || '' }, '*'); },
      endScene: function(){ parent.postMessage({ source:'black-market-theater', type:'endScene' }, '*'); }
    };
    parent.postMessage({ source:'black-market-theater', type:'resize', height: document.documentElement.scrollHeight }, '*');
  </script>
</body>
</html>`;
}

function createDefaultDraft(): TheaterDraft {
  const defaultIntro = "Write a gripping archive intro: how the incident started, the opening situation, and why {{user}} gets pulled into it.";
  return {
    title: "Untitled Night Archive",
    codeName: "CUSTOM_THEATER",
    subtitle: "",
    synopsis: defaultIntro,
    storyText: defaultIntro,
    tagsText: "story,interactive,custom",
    price: "120",
    authorName: "Anonymous Seller",
    openingHtml: createStarterOpeningHtml(),
    allowExternalControl: false,
    aiInstruction: [
      "[Current Story Context] {{user}} just unsealed a custom night archive, and {{char}} has been drawn into this story. Continue the scene based on the opening.",
      "[State Lock] Within this night channel, you must follow the story rules set by the author — do not break character, do not explain the system.",
      "[Behavior] Combine your original persona, your relationship with the player, and the pressure of the current event to give a response with action, emotion, and forward momentum.",
      "[Next Action] Respond to what the player just said, and push the story forward to the next beat.",
    ].join("\n"),
    outputContract: "Wrap action descriptions in *asterisks*. Important psychological beats can be marked with 【失控】 or 【秘密】 for custom style rendering. When a full interactive reply is needed, you can output a ```html code block```, which will render as an independent reply canvas.",
    renderRulesText: JSON.stringify([
      {
        id: "stage",
        name: "Stage Action",
        pattern: "\\*([^*]{1,160})\\*",
        flags: "g",
        className: "bm-stage-action",
        template: "<span class=\"bm-stage-action\">$1</span>",
      },
      {
        id: "secret",
        name: "Secret Reveal",
        pattern: "【秘密】\\s*([\\s\\S]*?)(?=\\n?【(?:失控|秘密|反应)】|$)",
        flags: "g",
        className: "bm-secret-line",
        template: "<div class=\"bm-secret-line\">$1</div>",
      },
    ], null, 2),
    renderCss: [
      ".bm-stage-action{color:#6b7280;font-style:italic;}",
      ".bm-secret-line{margin:8px 0;padding:10px 12px;background:#111827;color:#f9fafb;font-size: calc(13px*var(--app-text-scale,1));line-height:1.55;}",
    ].join("\n"),
    memorySummaryPrompt: "Summarize the key events of this night channel session, the shifts in the character's attitude, and the important choices the player made, into a single short-term memory entry.",
  };
}

function createStudioDraftId(): string {
  return `bm_draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStudioDraftPayload(value: unknown): TheaterDraft {
  const fallback = createDefaultDraft();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return {
    title: String(record.title ?? fallback.title),
    codeName: String(record.codeName ?? fallback.codeName),
    subtitle: String(record.subtitle ?? fallback.subtitle),
    synopsis: String(record.synopsis ?? fallback.synopsis),
    storyText: String(record.storyText ?? fallback.storyText),
    tagsText: String(record.tagsText ?? fallback.tagsText),
    price: String(record.price ?? fallback.price),
    authorName: String(record.authorName ?? fallback.authorName),
    openingHtml: String(record.openingHtml ?? fallback.openingHtml),
    allowExternalControl: record.allowExternalControl === true,
    aiInstruction: String(record.aiInstruction ?? fallback.aiInstruction),
    outputContract: String(record.outputContract ?? fallback.outputContract),
    renderRulesText: String(record.renderRulesText ?? fallback.renderRulesText),
    renderCss: String(record.renderCss ?? fallback.renderCss),
    memorySummaryPrompt: String(record.memorySummaryPrompt ?? fallback.memorySummaryPrompt),
  };
}

function normalizeStudioDraftRecord(value: unknown): BlackMarketStudioDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  if (!id) return null;
  const draft = normalizeStudioDraftPayload(record.draft);
  const now = new Date().toISOString();
  return {
    id,
    title: String(record.title ?? draft.title ?? "Untitled Draft").trim() || "Untitled Draft",
    draft,
    sourceTemplateId: String(record.sourceTemplateId ?? "").trim() || undefined,
    sourceTemplateTitle: String(record.sourceTemplateTitle ?? "").trim() || undefined,
    createdAt: String(record.createdAt ?? now),
    updatedAt: String(record.updatedAt ?? now),
  };
}

function loadBlackMarketStudioDrafts(): BlackMarketStudioDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(kvGet(BLACK_MARKET_STUDIO_DRAFTS_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStudioDraftRecord)
      .filter((item): item is BlackMarketStudioDraft => Boolean(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function saveBlackMarketStudioDrafts(items: BlackMarketStudioDraft[]): BlackMarketStudioDraft[] {
  const next = items.slice(0, 80).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (typeof window !== "undefined") {
    kvSet(BLACK_MARKET_STUDIO_DRAFTS_KEY, JSON.stringify(next));
  }
  return next;
}

function createDraftFromTemplate(template: BlackMarketTheaterTemplate): TheaterDraft {
  return {
    title: template.title,
    codeName: template.codeName,
    subtitle: template.subtitle,
    synopsis: template.synopsis,
    storyText: template.storyText,
    tagsText: template.tags.join(","),
    price: String(template.price),
    authorName: template.authorName,
    openingHtml: template.openingHtml,
    allowExternalControl: template.allowExternalControl,
    aiInstruction: template.aiInstruction,
    outputContract: template.outputContract,
    renderRulesText: JSON.stringify(template.renderRules, null, 2),
    renderCss: template.renderCss,
    memorySummaryPrompt: template.memorySummaryPrompt,
  };
}

function parseDraftRenderRules(source: string): BlackMarketRenderRule[] {
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Render rules must be a JSON array.");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Render rule ${index + 1} has an invalid format.`);
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const pattern = String(record.pattern ?? "").trim();
    if (!id || !pattern) throw new Error(`Render rule ${index + 1} is missing an id or pattern.`);
    return {
      id,
      name: String(record.name ?? "Render Rule").trim().slice(0, 80),
      pattern,
      flags: String(record.flags ?? "g").trim().slice(0, 12) || "g",
      className: String(record.className ?? "bm-render-rule").trim().slice(0, 120) || "bm-render-rule",
      template: String(record.template ?? "<span>$&</span>").trim().slice(0, 2000) || "<span>$&</span>",
    };
  });
}

function createDraftPreviewTemplate(draft: TheaterDraft, renderRules: BlackMarketRenderRule[]): BlackMarketTheaterTemplate {
  return {
    id: "draft_preview",
    title: draft.title || "Test Night Archive",
    codeName: draft.codeName || "DRAFT_PREVIEW",
    fileNumber: "AUTO",
    subtitle: draft.subtitle,
    synopsis: draft.synopsis,
    storyText: draft.storyText,
    tags: draft.tagsText.split(/[,\s，、]+/).map(item => item.trim()).filter(Boolean).slice(0, 8),
    rarity: "common",
    glyph: "◆",
    price: Number(draft.price) || 0,
    authorId: "draft_preview",
    authorName: draft.authorName || "Anonymous Seller",
    source: "local",
    version: 1,
    durationTurns: 8,
    allowExternalControl: draft.allowExternalControl,
    openingHtml: draft.openingHtml,
    aiInstruction: draft.aiInstruction,
    outputContract: draft.outputContract,
    renderRules,
    renderCss: draft.renderCss,
    memorySummaryPrompt: draft.memorySummaryPrompt,
    purchaseCount: 0,
    rating: 0,
    createdAt: "",
    updatedAt: "",
  };
}

export function BlackMarketApp({ onClose }: BlackMarketAppProps) {
  const { account } = useAccount();
  const [state, setState] = useState<BlackMarketState>(() => loadBlackMarketState());
  const [theaterRecords, setTheaterRecords] = useState<BlackMarketTheaterProjectionEntry[]>(() => loadAllBlackMarketTheaterProjectionEntries());
  const [selectedTab, setSelectedTab] = useState<BlackMarketTab>("market");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedTemplateMode, setSelectedTemplateMode] = useState<BlackMarketPreviewMode>("info");
  const [notice, setNotice] = useState<BlackMarketNotice | null>(null);
  const [communityTheaters, setCommunityTheaters] = useState<BlackMarketTheaterTemplate[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState<"sync" | "checkin" | "purchase" | null>(null);
  const [studioMode, setStudioMode] = useState<BlackMarketStudioMode>("published");
  const defaultDraft = useMemo(() => createDefaultDraft(), []);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [studioDrafts, setStudioDrafts] = useState<BlackMarketStudioDraft[]>(() => loadBlackMarketStudioDrafts());
  const [draft, setDraft] = useState<TheaterDraft>(() => createDefaultDraft());
  const [publishing, setPublishing] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BlackMarketDeleteTarget | null>(null);
  const [publishChoice, setPublishChoice] = useState<BlackMarketPublishChoice | null>(null);
  const [recordMenuId, setRecordMenuId] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [terminalTime, setTerminalTime] = useState("00:00:00");
  const [latency, setLatency] = useState(147);
  const [launchOwnedId, setLaunchOwnedId] = useState<string | null>(null);
  const [launchCharacterId, setLaunchCharacterId] = useState("");
  const [activeScene, setActiveScene] = useState<BlackMarketSceneSession | null>(null);
  const [externalCanvasAllowed, setExternalCanvasAllowed] = useState(false);
  const [externalCanvasRequest, setExternalCanvasRequest] = useState<BlackMarketExternalCanvasRequest>(null);
  const [sceneConfirmAction, setSceneConfirmAction] = useState<BlackMarketSceneConfirmAction | null>(null);
  const [sceneInput, setSceneInput] = useState("");
  const [editingSceneMessageId, setEditingSceneMessageId] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState<BlackMarketSceneBusy>(null);
  const [studioTestUserMessage, setStudioTestUserMessage] = useState(BLACK_MARKET_STUDIO_TEST_USER_SAMPLE);
  const [studioTestAssistantMessage, setStudioTestAssistantMessage] = useState(BLACK_MARKET_STUDIO_TEST_ASSISTANT_SAMPLE);
  const fullTheaterRequestsRef = useRef<Record<string, Promise<BlackMarketTheaterTemplate>>>({});

  const builtinCatalog = useMemo(() => getBlackMarketCatalog(), []);
  const characters = useMemo(() => loadCharacters(), []);
  const catalog = useMemo(() => {
    const seen = new Set<string>();
    return [...communityTheaters, ...builtinCatalog].filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [builtinCatalog, communityTheaters]);
  const ownedTemplateIds = useMemo(() => resolveOwnedTemplateIds(state), [state]);
  const publishedTheaters = useMemo(
    () => communityTheaters.filter(item => item.authorId === account.id || item.authorId === "local_user"),
    [account.id, communityTheaters],
  );
  const selectedTemplate = useMemo(
    () => catalog.find(item => item.id === selectedTemplateId) ?? null,
    [catalog, selectedTemplateId],
  );
  const launchOwnedTheater = useMemo(
    () => state.ownedTheaters.find(item => item.localId === launchOwnedId) ?? null,
    [launchOwnedId, state.ownedTheaters],
  );
  const selectedOwnedTheater = useMemo(
    () => selectedTemplate ? state.ownedTheaters.find(item => item.remoteTemplateId === selectedTemplate.id) ?? null : null,
    [selectedTemplate, state.ownedTheaters],
  );
  const pendingDeleteOwned = useMemo(
    () => deleteTarget?.kind === "owned"
      ? state.ownedTheaters.find(item => item.localId === deleteTarget.localId) ?? null
      : null,
    [deleteTarget, state.ownedTheaters],
  );
  const pendingDeletePublished = useMemo(
    () => deleteTarget?.kind === "published"
      ? communityTheaters.find(item => item.id === deleteTarget.templateId) ?? null
      : null,
    [deleteTarget, communityTheaters],
  );
  const launchCharacter = useMemo(
    () => characters.find(item => item.id === launchCharacterId) ?? null,
    [characters, launchCharacterId],
  );
  const editingTemplate = useMemo(
    () => editingTemplateId ? communityTheaters.find(item => item.id === editingTemplateId) ?? null : null,
    [communityTheaters, editingTemplateId],
  );
  const editingStudioDraft = useMemo(
    () => editingDraftId ? studioDrafts.find(item => item.id === editingDraftId) ?? null : null,
    [editingDraftId, studioDrafts],
  );
  const publishChoiceSourceTemplate = useMemo(
    () => publishChoice ? communityTheaters.find(item => item.id === publishChoice.sourceTemplateId) ?? null : null,
    [communityTheaters, publishChoice],
  );
  const resumableLaunchScene = useMemo(() => {
    if (!launchOwnedTheater || !launchCharacterId) return null;
    return loadBlackMarketSceneSessions().find(session =>
      session.localTheaterId === launchOwnedTheater.localId
      && session.characterId === launchCharacterId
      && session.status === "active"
    ) ?? null;
  }, [launchCharacterId, launchOwnedTheater, state]);
  const launchActiveCharacterIds = useMemo(() => {
    if (!launchOwnedTheater) return new Set<string>();
    return new Set(loadBlackMarketSceneSessions()
      .filter(session => session.localTheaterId === launchOwnedTheater.localId && session.status === "active")
      .map(session => session.characterId));
  }, [launchOwnedTheater, state]);
  const draftPreviewRenderRules = useMemo(() => {
    try {
      return parseDraftRenderRules(draft.renderRulesText);
    } catch {
      return [];
    }
  }, [draft.renderRulesText]);
  const draftPreviewTemplate = useMemo(
    () => createDraftPreviewTemplate(draft, draftPreviewRenderRules),
    [draft, draftPreviewRenderRules],
  );

  useEffect(() => {
    const syncState = () => {
      setState(loadBlackMarketState());
      setTheaterRecords(loadAllBlackMarketTheaterProjectionEntries());
    };
    window.addEventListener(BLACK_MARKET_UPDATED_EVENT, syncState);
    return () => window.removeEventListener(BLACK_MARKET_UPDATED_EVENT, syncState);
  }, []);

  useEffect(() => {
    if (!recordMenuId) return undefined;
    const closeRecordMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cp-black-market-record-menu")) return;
      setRecordMenuId(null);
    };
    document.addEventListener("pointerdown", closeRecordMenu);
    return () => document.removeEventListener("pointerdown", closeRecordMenu);
  }, [recordMenuId]);

  useEffect(() => {
    void loadCommunityTheaters();
  }, []);

  useEffect(() => {
    let active = true;
    setWalletBusy("sync");
    Promise.all([fetchBlackMarketWallet(), fetchPurchasedBlackMarketTheatersCloud()])
      .then(([wallet, purchasedTheaters]) => {
        if (!active) return;
        syncBlackMarketWallet(wallet);
        const added = copyPurchasedTheatersToVault(purchasedTheaters);
        if (added > 0) {
          setNotice({ id: Date.now(), tone: "info", text: `Restored ${added} previously purchased night archives` });
        }
      })
      .catch(err => {
        if (!active) return;
        const message = err instanceof Error ? err.message : "Black market wallet sync failed";
        setNotice({ id: Date.now(), tone: "error", text: message });
      })
      .finally(() => {
        if (active) setWalletBusy(null);
      });
    return () => {
      active = false;
    };
  }, [account.id]);

  useEffect(() => {
    const tick = () => {
      const date = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      setTerminalTime(`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLatency(118 + Math.floor(Math.random() * 74));
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "black-market-theater") return;
      if (record.type === "resize") return;
      if (record.type === "startScene") {
        setNotice({ id: Date.now(), tone: "info", text: activeScene ? "The opening canvas is ready — enter your action." : "Please select a character and enter the scene first." });
      }
      if (record.type === "sendUserAction") {
        const text = String(record.text ?? "").trim();
        if (text) {
          if (activeScene) {
            void handleSceneSubmit(text);
          } else {
            setSceneInput(text);
            setNotice({ id: Date.now(), tone: "info", text: "Canvas action captured — please select a character to enter the scene first." });
          }
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [activeScene, sceneBusy, sceneInput]);

  function showNotice(tone: BlackMarketNotice["tone"], text: string): void {
    setNotice({ id: Date.now(), tone, text });
  }

  async function ensureFullTheaterTemplate(template: BlackMarketTheaterTemplate): Promise<BlackMarketTheaterTemplate> {
    if (template.source !== "community" || isFullBlackMarketTheater(template)) return template;
    const current = communityTheaters.find(item => item.id === template.id);
    if (current && isFullBlackMarketTheater(current)) return current;
    let request = fullTheaterRequestsRef.current[template.id];
    if (!request) {
      request = fetchBlackMarketTheater(template.id).finally(() => {
        delete fullTheaterRequestsRef.current[template.id];
      });
      fullTheaterRequestsRef.current[template.id] = request;
    }
    const fullTemplate = await request;
    setCommunityTheaters(currentTheaters => [fullTemplate, ...currentTheaters.filter(item => item.id !== fullTemplate.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return fullTemplate;
  }

  function copyPurchasedTheatersToVault(theaters: BlackMarketTheaterTemplate[]): number {
    const known = new Set(loadBlackMarketState().ownedTheaters.map(item => item.remoteTemplateId));
    let added = 0;
    for (const theater of theaters) {
      if (known.has(theater.id)) continue;
      const result = copyBlackMarketTheaterToVault(theater);
      if (result.ok) {
        known.add(theater.id);
        added += 1;
      }
    }
    setState(loadBlackMarketState());
    return added;
  }

  async function restorePurchasedTheatersFromCloud(): Promise<number> {
    const purchased = await fetchPurchasedBlackMarketTheatersCloud();
    return copyPurchasedTheatersToVault(purchased);
  }

  function closeTemplatePreview(): void {
    setSelectedTemplateId(null);
    setSelectedTemplateMode("info");
  }

  function openTemplateInfo(templateId: string): void {
    setSelectedTemplateMode("info");
    setSelectedTemplateId(templateId);
    const template = catalog.find(item => item.id === templateId);
    if (template && template.source === "community" && !isFullBlackMarketTheater(template)) {
      void ensureFullTheaterTemplate(template).catch(err => {
        showNotice("error", err instanceof Error ? err.message : "Failed to load night archive details");
      });
    }
  }

  function resolveSceneUserName(character?: Character | null): string {
    if (!character) return "User";
    return resolveUserIdentity(character.id, "shopping")?.name?.trim()
      || resolveUserIdentity(character.id, "chat")?.name?.trim()
      || "User";
  }

  function expandForNeutralPreview(text: string): string {
    return expandBlackMarketMacros(text, "Character", "User");
  }

  function isOwnPublishedTemplate(template: BlackMarketTheaterTemplate): boolean {
    return template.authorId === account.id || template.authorId === "local_user";
  }

  function requiresExternalCanvasPermission(item?: BlackMarketOwnedTheater | null): boolean {
    return item?.templateSnapshot.allowExternalControl === true;
  }

  function openSceneLauncher(item: BlackMarketOwnedTheater): void {
    const existing = loadBlackMarketSceneSessions().find(session =>
      session.localTheaterId === item.localId && session.status === "active"
    );
    setLaunchOwnedId(item.localId);
    setLaunchCharacterId(existing?.characterId || characters[0]?.id || "");
    setExternalCanvasAllowed(false);
    setExternalCanvasRequest(null);
    setActiveScene(null);
    setSceneInput("");
    setSelectedTemplateId(null);
    setSelectedTemplateMode("info");
  }

  function closeSceneLayer(): void {
    setLaunchOwnedId(null);
    setActiveScene(null);
    setExternalCanvasAllowed(false);
    setExternalCanvasRequest(null);
    setSceneConfirmAction(null);
    setSceneInput("");
    setSceneBusy(null);
  }

  function getSceneConfirmMeta(action: BlackMarketSceneConfirmAction): { code: string; title: string; body: string; hint: string; confirmLabel: string; danger?: boolean } {
    if (action === "return") {
      return {
        code: "RETURN_TO_MARKET",
        title: "Return to the market?",
        body: "This closes the current scene window. Any unfinished scene session is kept and can be resumed later from the vault.",
        hint: "This will not write to short-term memory, and will not delete your current progress.",
        confirmLabel: "Confirm Return",
      };
    }
    if (action === "archive") {
      return {
        code: "SAVE_FOR_LATER",
        title: "Continue later?",
        body: "This stashes the current scene and returns to the market. You can resume it later from the vault.",
        hint: "The current conversation log will be kept in the local scene session.",
        confirmLabel: "Confirm Save",
      };
    }
    if (action === "restart") {
      return {
        code: "RESTART_SCENE",
        title: "Start over?",
        body: "This discards the current unfinished scene session and reloads the opening.",
        hint: "Summaries already written to short-term memory won't be deleted; any story not yet summarized will be cleared.",
        confirmLabel: "Confirm Restart",
        danger: true,
      };
    }
    return {
      code: "WRITE_MEMORY",
      title: "End and write to memory?",
      body: "This will generate a summary from the current scene log and write it to that character's short-term memory.",
      hint: "Once written, this scene will be marked as ended.",
      confirmLabel: "Confirm Write",
    };
  }

  function requestSceneConfirm(action: BlackMarketSceneConfirmAction): void {
    if (!activeScene) return;
    if (action === "restart" && (sceneBusy || activeScene.status === "ended")) return;
    if (action === "summary" && (sceneBusy || activeScene.status === "ended" || activeScene.messages.length === 0)) return;
    setSceneConfirmAction(action);
  }

  function cancelSceneConfirm(): void {
    setSceneConfirmAction(null);
  }

  function confirmSceneAction(): void {
    const action = sceneConfirmAction;
    if (!action) return;
    setSceneConfirmAction(null);
    if (action === "return" || action === "archive") {
      closeSceneLayer();
      return;
    }
    if (action === "restart") {
      handleSceneRestart();
      return;
    }
    void handleSceneSummary();
  }

  function expandForScene(text: string): string {
    const characterName = activeScene?.characterName || launchCharacter?.name || "Character";
    const userName = activeScene?.userName || resolveSceneUserName(launchCharacter);
    return expandBlackMarketMacros(text, characterName, userName);
  }

  function activateSceneFromLauncher(): void {
    if (!launchOwnedTheater) return;
    if (!launchCharacter) {
      showNotice("error", "Please select a character first.");
      return;
    }
    if (resumableLaunchScene) {
      setActiveScene(resumableLaunchScene);
      showNotice("info", "Resumed the unfinished scene");
      return;
    }
    const result = startBlackMarketSceneSession({
      localTheaterId: launchOwnedTheater.localId,
      characterId: launchCharacter.id,
      characterName: launchCharacter.name,
      userName: resolveSceneUserName(launchCharacter),
    });
    setState(result.state);
    if (!result.ok || !result.session) {
      showNotice("error", result.error || "Unseal failed");
      return;
    }
    setActiveScene(result.session);
    showNotice("success", "Scene unsealed");
  }

  function startSceneFromLauncher(): void {
    if (!launchOwnedTheater) return;
    if (!launchCharacter) {
      showNotice("error", "Please select a character first.");
      return;
    }
    if (requiresExternalCanvasPermission(launchOwnedTheater) && !externalCanvasAllowed) {
      setExternalCanvasRequest(resumableLaunchScene ? "resume" : "start");
      return;
    }
    activateSceneFromLauncher();
  }

  function confirmExternalCanvasRequest(): void {
    setExternalCanvasAllowed(true);
    setExternalCanvasRequest(null);
    activateSceneFromLauncher();
  }

  function cancelExternalCanvasRequest(): void {
    setExternalCanvasRequest(null);
    showNotice("info", "Advanced canvas unseal cancelled");
  }

  async function copySceneMessage(content: string): Promise<void> {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      showNotice("success", "Copied");
    } catch {
      showNotice("error", "Copy failed");
    }
  }

  function beginEditSceneUserMessage(message: BlackMarketSceneSession["messages"][number]): void {
    if (!activeScene || activeScene.status !== "active" || message.role !== "user" || sceneBusy) return;
    setEditingSceneMessageId(message.id);
    setSceneInput(message.content);
    showNotice("info", "Send after editing to rewrite the story from this point on.");
  }

  async function requestSceneReply(submittedSessionId: string, content: string): Promise<void> {
    setSceneBusy("reply");
    setSceneInput("");
    try {
      const result = await generateBlackMarketSceneReply(submittedSessionId, content);
      setActiveScene(result.session);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "Story generation failed");
      const restored = getBlackMarketSceneSession(submittedSessionId);
      if (restored) setActiveScene(restored);
    } finally {
      setSceneBusy(null);
    }
  }

  async function handleSceneSubmit(text?: string): Promise<void> {
    const content = (text ?? sceneInput).trim();
    if (!activeScene || activeScene.status !== "active" || !content || sceneBusy) return;
    const submittedSessionId = activeScene.id;

    const editingId = text === undefined ? editingSceneMessageId : null;
    if (editingId) {
      const target = activeScene.messages.find(message => message.id === editingId && message.role === "user");
      if (!target) {
        setEditingSceneMessageId(null);
        showNotice("error", "Couldn't find the action to edit.");
        return;
      }
      const updated = updateBlackMarketSceneMessageAndTrimAfter(submittedSessionId, editingId, content);
      if (updated) setActiveScene(updated);
      setEditingSceneMessageId(null);
      await requestSceneReply(submittedSessionId, content);
      return;
    }

    const withUser = appendBlackMarketSceneMessage(submittedSessionId, "user", content);
    if (withUser) setActiveScene(withUser);
    setEditingSceneMessageId(null);
    await requestSceneReply(submittedSessionId, content);
  }

  async function retrySceneFromAssistantMessage(message: BlackMarketSceneSession["messages"][number]): Promise<void> {
    if (!activeScene || activeScene.status !== "active" || message.role !== "assistant" || sceneBusy) return;
    const targetIndex = activeScene.messages.findIndex(item => item.id === message.id);
    if (targetIndex < 0) return;
    const previousUser = [...activeScene.messages.slice(0, targetIndex)].reverse().find(item => item.role === "user");
    if (!previousUser) {
      showNotice("error", "Couldn't find an action to retry from.");
      return;
    }
    const trimmed = trimBlackMarketSceneMessagesFrom(activeScene.id, message.id);
    if (trimmed) setActiveScene(trimmed);
    setEditingSceneMessageId(null);
    await requestSceneReply(activeScene.id, previousUser.content);
  }

  async function retrySceneFromUserMessage(message: BlackMarketSceneSession["messages"][number]): Promise<void> {
    if (!activeScene || activeScene.status !== "active" || message.role !== "user" || sceneBusy) return;
    const isLastMessage = activeScene.messages[activeScene.messages.length - 1]?.id === message.id;
    if (!isLastMessage) return;
    const trimmed = updateBlackMarketSceneMessageAndTrimAfter(activeScene.id, message.id, message.content);
    if (trimmed) setActiveScene(trimmed);
    setEditingSceneMessageId(null);
    await requestSceneReply(activeScene.id, message.content);
  }

  async function handleSceneSummary(): Promise<void> {
    if (!activeScene || sceneBusy) return;
    setSceneBusy("summary");
    try {
      const result = await summarizeAndRecordBlackMarketScene(activeScene.id);
      setActiveScene(result.session);
      showNotice("success", "Scene summary written to short-term memory");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "Memory summarization failed");
    } finally {
      setSceneBusy(null);
    }
  }

  function handleSceneRestart(): void {
    if (!activeScene || sceneBusy || activeScene.status === "ended") return;
    const previous = activeScene;
    const discarded = discardBlackMarketSceneSession(previous.id);
    const result = startBlackMarketSceneSession({
      localTheaterId: previous.localTheaterId,
      characterId: previous.characterId,
      characterName: previous.characterName,
      userName: previous.userName,
    });
    setState(result.state || discarded.state);
    setSceneInput("");
    setSceneBusy(null);
    if (!result.ok || !result.session) {
      setActiveScene(null);
      showNotice("error", result.error || "Restart failed");
      return;
    }
    setActiveScene(result.session);
    showNotice("success", "Restarted — the scene log was discarded");
  }

  function handleDeleteOwned(item: BlackMarketOwnedTheater): void {
    const result = deleteBlackMarketOwnedTheater(item.localId);
    setState(result.state);
    if (!result.ok) {
      showNotice("error", result.error || "Delete failed");
      return;
    }
    if (launchOwnedId === item.localId) closeSceneLayer();
    setDeleteTarget(null);
    showNotice("success", "Removed from vault");
  }

  function handleDeleteTheaterRecord(entry: BlackMarketTheaterProjectionEntry): void {
    const result = deleteBlackMarketTheaterProjectionEvent(entry.id);
    setRecordMenuId(null);
    setTheaterRecords(loadAllBlackMarketTheaterProjectionEntries());
    if (!result.ok) {
      showNotice("error", result.error || "Delete failed");
      return;
    }
    showNotice("success", "Scene memory entry deleted");
  }

  function closeDeleteConfirm(): void {
    if (deletingTemplateId) return;
    setDeleteTarget(null);
  }

  function confirmDeleteTarget(): void {
    if (deleteTarget?.kind === "owned" && pendingDeleteOwned) {
      handleDeleteOwned(pendingDeleteOwned);
      return;
    }
    if (deleteTarget?.kind === "published" && pendingDeletePublished) {
      void handleDeletePublished(pendingDeletePublished);
      return;
    }
    setDeleteTarget(null);
  }

  async function loadCommunityTheaters(showResult = false): Promise<void> {
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const theaters = await fetchBlackMarketTheaters();
      setCommunityTheaters(theaters);
      if (showResult) showNotice("success", theaters.length > 0 ? `Synced ${theaters.length} night archives` : "The shared market is currently empty");
    } catch (err) {
      const message = err instanceof Error ? err.message : "The shared market is temporarily unavailable";
      setCommunityError(message);
      if (showResult) showNotice("error", message);
    } finally {
      setCommunityLoading(false);
    }
  }

  async function handleCheckin(): Promise<void> {
    if (walletBusy) return;
    setWalletBusy("checkin");
    try {
      const wallet = await checkInBlackMarketCloud();
      setState(syncBlackMarketWallet(wallet));
      showNotice("success", `Check-in successful, +${BLACK_MARKET_DAILY_CHECKIN_CREDITS} SC`);
    } catch (err) {
      showNotice("info", err instanceof Error ? err.message : "You've already checked in today.");
    } finally {
      setWalletBusy(null);
    }
  }

  function handleOperatorTalk(): void {
    showNotice("info", "Creator broker interaction coming soon");
  }

  async function handlePurchase(template: BlackMarketTheaterTemplate): Promise<void> {
    if (walletBusy) return;
    if (state.ownedTheaters.some(item => item.remoteTemplateId === template.id)) {
      showNotice("info", "Already in your vault.");
      return;
    }
    setWalletBusy("purchase");
    try {
      const fullTemplate = await ensureFullTheaterTemplate(template);
      // Built-in / local theaters are not in the cloud catalog (the cloud
      // purchase RPC would return theater_not_found), and they are operator
      // freebies — copy them straight into the vault at no cost.
      if (template.source !== "community") {
        const localResult = copyBlackMarketTheaterToVault(fullTemplate);
        if (!localResult.ok) {
          showNotice("error", localResult.error ?? "Claim failed");
          return;
        }
        setState(localResult.state);
        setSelectedTab("vault");
        showNotice("success", "Added to vault for free");
        return;
      }
      const result = await purchaseBlackMarketTheaterCloud(template.id);
      const copied = copyBlackMarketTheaterToVault({
        ...fullTemplate,
        purchaseCount: fullTemplate.purchaseCount + 1,
      });
      const next = syncBlackMarketWallet(result.wallet);
      setState(next);
      if (copied.ok) {
        setCommunityTheaters(current => current.map(item => item.id === template.id ? { ...item, purchaseCount: item.purchaseCount + 1 } : item));
      }
      setSelectedTab("vault");
      showNotice("success", "Copied into vault");
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Purchase failed";
      if (message.includes("已经收入暗柜")) {
        let restored = 0;
        try {
          restored = await restorePurchasedTheatersFromCloud();
        } catch {
          restored = 0;
        }
        const fullTemplate = await ensureFullTheaterTemplate(template);
        const copied = restored > 0 ? { ok: true, state: loadBlackMarketState() } : copyBlackMarketTheaterToVault(fullTemplate);
        try {
          const wallet = await fetchBlackMarketWallet();
          setState(syncBlackMarketWallet(wallet));
        } catch {
          setState(copied.state);
        }
        if (copied.ok || restored > 0) {
          setSelectedTab("vault");
          showNotice("info", "Restored to vault from purchase history.");
          return;
        }
      }
      showNotice("error", message);
    } finally {
      setWalletBusy(null);
    }
  }

  async function handleOwnTemplateUnseal(template: BlackMarketTheaterTemplate): Promise<void> {
    const existing = state.ownedTheaters.find(item => item.remoteTemplateId === template.id);
    if (existing) {
      openSceneLauncher(existing);
      return;
    }
    let fullTemplate = template;
    try {
      fullTemplate = await ensureFullTheaterTemplate(template);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "Failed to load night archive details");
      return;
    }
    const result = copyBlackMarketTheaterToVault(fullTemplate);
    setState(result.state);
    if (result.ok && result.ownedTheater) {
      showNotice("success", "Copied into vault");
      openSceneLauncher(result.ownedTheater);
      return;
    }
    showNotice("error", result.error ?? "Unseal failed");
  }

  async function handleTemplatePrimaryAction(template: BlackMarketTheaterTemplate): Promise<void> {
    if (isOwnPublishedTemplate(template)) {
      await handleOwnTemplateUnseal(template);
      return;
    }
    await handlePurchase(template);
  }

  function updateDraft<K extends keyof TheaterDraft>(key: K, value: TheaterDraft[K]): void {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function clearDraftSampleOnFocus<K extends keyof TheaterDraft>(key: K): void {
    if (editingTemplateId) return;
    const sample = defaultDraft[key];
    setDraft(current => current[key] === sample ? { ...current, [key]: "" } as TheaterDraft : current);
  }

  function clearDraftDescriptionOnFocus(): void {
    if (editingTemplateId) return;
    setDraft(current => (
      current.synopsis === defaultDraft.synopsis || current.storyText === defaultDraft.storyText
        ? { ...current, synopsis: "", storyText: "" }
        : current
    ));
  }

  function updateDraftDescription(value: string): void {
    setDraft(current => ({
      ...current,
      synopsis: value.trim().slice(0, 180),
      storyText: value,
    }));
  }

  function resetDraft(): void {
    setEditingTemplateId(null);
    setEditingDraftId(null);
    setDraft(createDefaultDraft());
    setPreviewNonce(value => value + 1);
  }

  async function beginEditPublished(template: BlackMarketTheaterTemplate): Promise<void> {
    let fullTemplate = template;
    try {
      fullTemplate = await ensureFullTheaterTemplate(template);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "Failed to load night archive details");
      return;
    }
    setEditingTemplateId(fullTemplate.id);
    setEditingDraftId(null);
    setDraft(createDraftFromTemplate(fullTemplate));
    setStudioMode("create");
    setPreviewNonce(value => value + 1);
  }

  function beginEditStudioDraft(item: BlackMarketStudioDraft): void {
    setEditingTemplateId(null);
    setEditingDraftId(item.id);
    setDraft(item.draft);
    setStudioMode("create");
    setPreviewNonce(value => value + 1);
  }

  function handleSaveStudioDraft(): void {
    const now = new Date().toISOString();
    const id = editingDraftId || createStudioDraftId();
    const title = draft.title.trim() || "Untitled Draft";
    const existingDraft = editingDraftId ? studioDrafts.find(item => item.id === editingDraftId) : null;
    const sourceTemplateId = editingTemplate?.id || existingDraft?.sourceTemplateId;
    const sourceTemplateTitle = editingTemplate?.title || existingDraft?.sourceTemplateTitle;
    setStudioDrafts(current => {
      const existing = current.find(item => item.id === id);
      return saveBlackMarketStudioDrafts([
        {
          id,
          title,
          draft,
          sourceTemplateId,
          sourceTemplateTitle,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        },
        ...current.filter(item => item.id !== id),
      ]);
    });
    if (editingTemplate?.id) {
      setEditingTemplateId(null);
      setEditingDraftId(id);
    }
    showNotice("success", "Draft saved");
  }

  function handleDeleteStudioDraft(id: string): void {
    setStudioDrafts(current => saveBlackMarketStudioDrafts(current.filter(item => item.id !== id)));
    if (editingDraftId === id) {
      setEditingDraftId(null);
    }
    showNotice("info", "Draft deleted");
  }

  function getEditingDraftPublishSource(): BlackMarketPublishChoice | null {
    const currentDraft = editingStudioDraft;
    const sourceTemplateId = currentDraft?.sourceTemplateId?.trim();
    if (!editingDraftId || !currentDraft || !sourceTemplateId) return null;
    return {
      sourceTemplateId,
      sourceTemplateTitle: currentDraft.sourceTemplateTitle?.trim() || currentDraft.title || "Original published archive",
    };
  }

  function buildDraftTemplate(existing?: BlackMarketTheaterTemplate | null): BlackMarketTheaterTemplate {
    const title = draft.title.trim();
    const openingHtml = draft.openingHtml.trim();
    const aiInstruction = draft.aiInstruction.trim();
    if (!title) throw new Error("Item title cannot be empty.");
    if (!openingHtml) throw new Error("Opening canvas cannot be empty.");
    if (!aiInstruction) throw new Error("Story instructions cannot be empty.");
    const now = new Date().toISOString();
    return {
      id: existing?.id || `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      codeName: draft.codeName.trim() || "CUSTOM_THEATER",
      fileNumber: existing?.fileNumber?.trim() || generateBlackMarketFileNumber(),
      subtitle: draft.subtitle.trim() || draft.synopsis.trim().slice(0, 56),
      synopsis: draft.synopsis.trim() || draft.storyText.trim().slice(0, 180),
      storyText: draft.storyText.trim() || draft.synopsis.trim(),
      tags: draft.tagsText.split(/[,\s，、]+/).map(tag => tag.trim()).filter(Boolean).slice(0, 8),
      rarity: "common",
      glyph: "◆",
      price: Math.min(500, Math.max(0, Math.round(Number(draft.price) || 0))),
      authorId: existing?.authorId || account.id,
      authorName: draft.authorName.trim() || account.displayName || "Anonymous Seller",
      source: "community",
      version: existing ? existing.version + 1 : 1,
      durationTurns: 8,
      allowExternalControl: draft.allowExternalControl,
      openingHtml,
      aiInstruction,
      outputContract: draft.outputContract.trim(),
      renderRules: parseDraftRenderRules(draft.renderRulesText),
      renderCss: draft.renderCss.trim(),
      memorySummaryPrompt: draft.memorySummaryPrompt.trim(),
      purchaseCount: existing?.purchaseCount ?? 0,
      rating: existing?.rating ?? 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  async function publishCurrentDraft(mode: "auto" | "new" | "overwrite-source" = "auto"): Promise<void> {
    setPublishing(true);
    try {
      const sourceTemplate = mode === "overwrite-source" && publishChoice
        ? communityTheaters.find(item => item.id === publishChoice.sourceTemplateId) ?? null
        : null;
      if (mode === "overwrite-source" && !sourceTemplate) {
        throw new Error("Couldn't find the original published archive. Refresh the shared market, or publish it as a new archive instead.");
      }
      const existingTemplate = mode === "new" ? null : editingTemplate ?? sourceTemplate;
      const template = buildDraftTemplate(existingTemplate);
      const published = existingTemplate
        ? await updateBlackMarketTheater(template)
        : await publishBlackMarketTheater(template);
      const snapshotSync = existingTemplate
        ? syncOwnedBlackMarketTheaterSnapshot(published)
        : null;
      if (snapshotSync?.updatedCount) {
        setState(snapshotSync.state);
      }
      if (editingDraftId) {
        setStudioDrafts(current => saveBlackMarketStudioDrafts(current.filter(item => item.id !== editingDraftId)));
        setEditingDraftId(null);
      }
      setCommunityTheaters(current => [published, ...current.filter(item => item.id !== published.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setSelectedTab("studio");
      setSelectedTemplateId(published.id);
      setEditingTemplateId(null);
      setStudioMode("published");
      setPublishChoice(null);
      showNotice(
        "success",
        existingTemplate
          ? snapshotSync?.updatedCount
            ? `Night archive changes synced, and ${snapshotSync.updatedCount} vault copies updated`
            : "Night archive changes synced"
          : "Night archive sent to the black market",
      );
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  async function handlePublishDraft(): Promise<void> {
    if (!editingTemplate) {
      const source = getEditingDraftPublishSource();
      if (source) {
        setPublishChoice(source);
        return;
      }
    }
    await publishCurrentDraft("auto");
  }

  function closePublishChoice(): void {
    if (publishing) return;
    setPublishChoice(null);
  }

  async function handleDeletePublished(template: BlackMarketTheaterTemplate): Promise<void> {
    if (deletingTemplateId) return;
    setDeletingTemplateId(template.id);
    try {
      await deleteBlackMarketTheater({ id: template.id, authorId: template.authorId });
      setCommunityTheaters(current => current.filter(item => item.id !== template.id));
      if (selectedTemplateId === template.id) setSelectedTemplateId(null);
      if (editingTemplateId === template.id) resetDraft();
      setDeleteTarget(null);
      showNotice("success", "Removed from the shared market");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingTemplateId(null);
    }
  }

  function renderMarketCard(template: BlackMarketTheaterTemplate) {
    const owned = ownedTemplateIds.has(template.id);
    const own = isOwnPublishedTemplate(template);
    return (
      <article key={template.id} className="cp-black-market-card">
        <div className="cp-black-market-card-top">
          <span className="cp-black-market-id">{getBlackMarketFileNumber(template)}</span>
        </div>
        <div className="cp-black-market-card-title">
          <div>
            <strong>{template.title}</strong>
            <em>SELLER · {template.authorName.trim() || "Anonymous Seller"}</em>
          </div>
        </div>
        <div className="cp-black-market-card-divider" />
        <p>{expandForNeutralPreview(template.synopsis)}</p>
        <div className="cp-black-market-tags">
          {template.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}
        </div>
        <div className="cp-black-market-card-actions">
          <button type="button" onClick={() => openTemplateInfo(template.id)}>
            <Eye size={15} />
            INFO
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => own ? void handleOwnTemplateUnseal(template) : void handlePurchase(template)}
            disabled={(owned && !own) || walletBusy === "purchase"}
          >
            {own ? <Play size={15} /> : owned ? <Check size={15} /> : <Copy size={15} />}
            {own ? "UNSEAL" : owned ? "OWNED" : template.source === "community" ? `BUY · ${formatShadowCredits(template.price)}` : "FREE"}
          </button>
        </div>
      </article>
    );
  }

  function renderOwnedCard(item: BlackMarketOwnedTheater) {
    const template = item.templateSnapshot;
    return (
      <article key={item.localId} className="cp-black-market-owned-card">
        <div>
          <span>VAULT ITEM</span>
          <strong>{template.title}</strong>
          <p>{expandForNeutralPreview(template.subtitle || template.synopsis)}</p>
        </div>
        <div className="cp-black-market-owned-meta">
          <span>{getBlackMarketFileNumber(template)}</span>
          <span>{formatBlackMarketDate(item.purchasedAt)}</span>
          <span>{item.useCount > 0 ? `Unsealed ${item.useCount} times` : "Not yet unsealed"}</span>
        </div>
        <div className="cp-black-market-owned-actions">
          <button type="button" onClick={() => openTemplateInfo(template.id)}>INFO</button>
          <button type="button" className="is-primary" onClick={() => openSceneLauncher(item)}>UNSEAL</button>
          <button type="button" className="is-danger" onClick={() => setDeleteTarget({ kind: "owned", localId: item.localId })}>DELETE</button>
        </div>
      </article>
    );
  }

  function renderTheaterRecord(entry: BlackMarketTheaterProjectionEntry) {
    const character = characters.find(item => item.id === entry.characterId);
    const menuOpen = recordMenuId === entry.id;
    return (
      <article key={entry.id} className="cp-black-market-record-card">
        <div className="cp-black-market-record-main">
          <span>THEATER MEMORY</span>
          <strong>{entry.theaterTitle || "Untitled Scene"}</strong>
          <p>{entry.content}</p>
          <div className="cp-black-market-record-meta">
            <span>{character?.name || entry.characterId}</span>
            <span>{formatBlackMarketDate(entry.timestamp)}</span>
          </div>
        </div>
        <div className="cp-black-market-record-menu">
          <button
            type="button"
            aria-label={`${entry.theaterTitle || "Scene"} record actions`}
            onClick={() => setRecordMenuId(menuOpen ? null : entry.id)}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen ? (
            <div className="cp-black-market-record-pop">
              <button type="button" onClick={() => handleDeleteTheaterRecord(entry)}>
                DELETE
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const pendingDeleteTitle = pendingDeleteOwned?.templateSnapshot.title || pendingDeletePublished?.title || "";
  const pendingDeleteBusy = deleteTarget?.kind === "published" && pendingDeletePublished
    ? deletingTemplateId === pendingDeletePublished.id
    : false;
  const sceneConfirmMeta = sceneConfirmAction ? getSceneConfirmMeta(sceneConfirmAction) : null;

  return (
    <div className="cp-black-market-root">
      <div className="cp-black-market-noise" />
      <div className="cp-black-market-scanlines" />

      <header className="cp-black-market-header">
        <button type="button" aria-label="Back to shopping" onClick={onClose}>
          <ChevronLeft size={22} strokeWidth={2.5} />
        </button>
        <div>
          <span>STYGIAN CHANNEL</span>
          <strong>BLACK MARKET</strong>
        </div>
        <button
          type="button"
          aria-label="Refresh black market theaters"
          onClick={() => void loadCommunityTheaters(true)}
          disabled={communityLoading}
        >
          <RefreshCw size={18} strokeWidth={2.4} className={communityLoading ? "cp-spin" : ""} />
        </button>
      </header>

      <main className="cp-black-market-scroll">
        <section className="cp-black-market-statusbar" aria-label="Black market connection status">
          <span className="cp-black-market-led" />
          <span className="is-green">CONNECTED</span>
          <span>·</span>
          <span>TOR://night-channel.onion</span>
          <b>{terminalTime}</b>
          <span>·</span>
          <span>{latency}ms</span>
        </section>

        <div className="cp-black-market-warning">△ THIS SESSION IS BEING MONITORED △</div>

        <section className="cp-black-market-title-block">
          <div className="cp-black-market-title-prefix">v2.4.1 // STYGIAN · NIGHT CHANNEL · SANDBOX</div>
          <h1 className="cp-black-market-brand" data-text="BLACK MARKET">BLACK MARKET</h1>
          <div className="cp-black-market-title-sub">── // ACCESS GRANTED · WELCOME BACK ──────</div>
        </section>

        <section className="cp-black-market-operator">
          <span className="cp-black-market-corner is-tl" />
          <span className="cp-black-market-corner is-tr" />
          <span className="cp-black-market-corner is-bl" />
          <span className="cp-black-market-corner is-br" />
          <div className="cp-black-market-camera" aria-hidden="true">
            <span className="cp-black-market-camera-rec">● REC</span>
            <span className="cp-black-market-camera-sig">SIG -72dB</span>
            <span className="cp-black-market-camera-id">OPERATOR_03 / {terminalTime}</span>
          </div>
          <div className="cp-black-market-operator-info">
            <div className="cp-black-market-operator-label">OPERATOR_03</div>
            <div className="cp-black-market-operator-status">{communityLoading ? "Calibrating shared signal." : communityError ? "Signal unstable." : "Say your first thought."}</div>
            <div className="cp-black-market-operator-meta">
              <span>· Role&nbsp;&nbsp;<b>Creator Broker</b></span>
              <span>· Trust&nbsp;&nbsp;<b>★★☆☆☆</b></span>
              <span>· True Source&nbsp;&nbsp;<i>████████</i></span>
            </div>
            <div className="cp-black-market-operator-actions">
              <button type="button" className="cp-black-market-talk-btn" onClick={handleOperatorTalk}>
                {"// TALK ->"}
              </button>
              <button type="button" className="cp-black-market-sync-btn" onClick={() => void loadCommunityTheaters(true)} disabled={communityLoading}>
                {communityLoading ? "// SYNCING" : "// REFRESH MARKET ->"}
              </button>
            </div>
          </div>
          {communityError ? <div className="cp-black-market-sync-error">{communityError}</div> : null}
        </section>

        <section className="cp-black-market-wallet">
          <div>
            <span>WALLET</span>
            <strong>{formatShadowCredits(state.wallet.balance)}</strong>
            <em>SHADOW CREDITS · ENCRYPTED ✓</em>
          </div>
          <button type="button" onClick={() => void handleCheckin()} disabled={walletBusy === "sync" || walletBusy === "checkin"}>
            {walletBusy === "sync" ? "SYNCING" : walletBusy === "checkin" ? "CHECKING" : `+${BLACK_MARKET_DAILY_CHECKIN_CREDITS} DAILY`}
          </button>
        </section>

        <nav className="cp-black-market-tabs" aria-label="Black market navigation">
          {MARKET_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={selectedTab === tab.id ? "is-active" : ""}
              onClick={() => setSelectedTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="cp-black-market-inventory-head">
          <span>──[ INVENTORY · {selectedTab === "market" ? catalog.length : selectedTab === "vault" ? state.ownedTheaters.length : selectedTab === "ledger" ? state.wallet.transactions.length : 1} ENTRIES ]</span>
          <b>[{selectedTab.toUpperCase()}]</b>
        </div>

        {selectedTab === "market" ? (
          <section className="cp-black-market-grid">
            {catalog.map(renderMarketCard)}
          </section>
        ) : null}

        {selectedTab === "vault" ? (
          <section className="cp-black-market-list">
            <div className="cp-black-market-section-head">
              <Archive size={16} />
              <span>Local Vault</span>
              <b>{state.ownedTheaters.length}</b>
            </div>
            {state.ownedTheaters.length === 0 ? (
              <div className="cp-black-market-empty">The vault has no night archives to unseal yet.</div>
            ) : state.ownedTheaters.map(renderOwnedCard)}
            <div className="cp-black-market-section-head cp-black-market-record-head">
              <FileText size={16} />
              <span>Recent Records</span>
              <b>{theaterRecords.length}</b>
            </div>
            {theaterRecords.length === 0 ? (
              <div className="cp-black-market-empty cp-black-market-record-empty">No scene playback records</div>
            ) : (
              <div className="cp-black-market-record-list" aria-label="Scene playback records">
                {theaterRecords.slice(0, 20).map(renderTheaterRecord)}
              </div>
            )}
          </section>
        ) : null}

        {selectedTab === "ledger" ? (
          <section className="cp-black-market-list">
            <div className="cp-black-market-section-head">
              <FileText size={16} />
              <span>Shadow Credits Ledger</span>
              <b>{state.wallet.transactions.length}</b>
            </div>
            {state.wallet.transactions.map(transaction => (
              <article key={transaction.id} className="cp-black-market-ledger-row">
                <div>
                  <strong>{transaction.title}</strong>
                  <span>{transaction.detail}</span>
                  <time>{formatBlackMarketDate(transaction.createdAt)}</time>
                </div>
                <b className={transaction.amount >= 0 ? "is-plus" : "is-minus"}>
                  {transaction.amount >= 0 ? "+" : ""}{transaction.amount} SC
                </b>
              </article>
            ))}
          </section>
        ) : null}

        {selectedTab === "studio" ? (
          <section className="cp-black-market-studio">
            <div className="cp-black-market-section-head">
              <PenLine size={16} />
              <span>Night Archive Workshop</span>
              <b>{publishedTheaters.length} PUBLISHED · {studioDrafts.length} DRAFTS</b>
            </div>

            <div className="cp-black-market-studio-tabs" role="tablist" aria-label="Publishing management">
              <button
                type="button"
                role="tab"
                aria-selected={studioMode === "published"}
                className={studioMode === "published" ? "is-active" : ""}
                onClick={() => setStudioMode("published")}
              >
                Published
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={studioMode === "create"}
                className={studioMode === "create" ? "is-active" : ""}
                onClick={() => setStudioMode("create")}
              >
                Create & Publish
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={studioMode === "drafts"}
                className={studioMode === "drafts" ? "is-active" : ""}
                onClick={() => setStudioMode("drafts")}
              >
                Drafts
              </button>
            </div>

            {studioMode === "published" ? (
              <div className="cp-black-market-studio-panel">
                <h3>My Shared Archives</h3>
                <p className="cp-black-market-studio-hint">This shows the night archives this device has published to the cloud shared market. Editing or deleting only affects the shared market — local copies already purchased are unaffected.</p>
                {publishedTheaters.length === 0 ? (
                  <div className="cp-black-market-empty">You haven't published any night archives yet.</div>
                ) : (
                  <div className="cp-black-market-published-list">
                    {publishedTheaters.map(template => (
                      <article key={template.id} className="cp-black-market-published-card">
                        <div>
                          <span>{getBlackMarketFileNumber(template)}</span>
                          <strong>{template.title}</strong>
                          <p>{expandForNeutralPreview(template.subtitle || template.synopsis || template.storyText)}</p>
                          <time>{formatBlackMarketDate(template.updatedAt)}</time>
                        </div>
                        <div className="cp-black-market-published-actions">
                          <button type="button" onClick={() => openTemplateInfo(template.id)}>
                            <Eye size={14} />
                            INFO
                          </button>
                          <button type="button" onClick={() => void beginEditPublished(template)}>
                            <Pencil size={14} />
                            MODIFY
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            disabled={deletingTemplateId === template.id}
                            onClick={() => setDeleteTarget({ kind: "published", templateId: template.id })}
                          >
                            <Trash2 size={14} />
                            {deletingTemplateId === template.id ? "DELETING" : "DELETE"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {studioMode === "drafts" ? (
              <div className="cp-black-market-studio-panel">
                <h3>Drafts</h3>
                <p className="cp-black-market-studio-hint">Drafts are only saved on this device and won't enter the shared market.</p>
                {studioDrafts.length === 0 ? (
                  <div className="cp-black-market-empty">You haven't saved any drafts yet.</div>
                ) : (
                  <div className="cp-black-market-published-list">
                    {studioDrafts.map(item => (
                      <article key={item.id} className="cp-black-market-published-card">
                        <div>
                          <span>{item.sourceTemplateId ? "Source Draft" : "Draft"}</span>
                          <strong>{item.title}</strong>
                          <p>{item.sourceTemplateId ? `Source: ${item.sourceTemplateTitle || "Published archive"}` : item.draft.subtitle || item.draft.synopsis || item.draft.storyText}</p>
                          <time>{formatBlackMarketDate(item.updatedAt)}</time>
                        </div>
                        <div className="cp-black-market-published-actions">
                          <button type="button" onClick={() => beginEditStudioDraft(item)}>
                            <Pencil size={14} />
                            EDIT
                          </button>
                          <button type="button" className="is-danger" onClick={() => handleDeleteStudioDraft(item.id)}>
                            <Trash2 size={14} />
                            DELETE
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {studioMode === "create" ? (
              <>
                {editingTemplate ? (
                  <div className="cp-black-market-editing-banner">
                    <span>Editing</span>
                    <strong>{editingTemplate.title}</strong>
                    <button type="button" onClick={resetDraft}>Cancel Edit</button>
                  </div>
                ) : null}
                {editingDraftId && !editingTemplate ? (
                  <div className="cp-black-market-editing-banner">
                    <span>{editingStudioDraft?.sourceTemplateId ? "Source Draft" : "Editing Draft"}</span>
                    <strong>{editingStudioDraft?.title || "Untitled Draft"}</strong>
                    <button type="button" onClick={resetDraft}>Exit Draft</button>
                  </div>
                ) : null}

                <div className="cp-black-market-studio-panel">
                  <h3>Archive Details</h3>
                  <p className="cp-black-market-studio-hint">Just fill in the title and description users will see; the internal file number is handled automatically, and the publisher nickname can be set separately each time.</p>
                  <label>
                    Archive Name
                    <input value={draft.title} onFocus={() => clearDraftSampleOnFocus("title")} onChange={event => updateDraft("title", event.target.value)} />
                  </label>
                  <label>
                    Publisher Nickname
                    <input
                      value={draft.authorName}
                      maxLength={40}
                      placeholder="e.g. Anonymous Seller / Night Archive Curator"
                      onFocus={() => clearDraftSampleOnFocus("authorName")}
                      onChange={event => updateDraft("authorName", event.target.value)}
                    />
                  </label>
                  <div className="cp-black-market-nickname-actions" aria-label="Publisher nickname shortcuts">
                    <button type="button" onClick={() => updateDraft("authorName", account.displayName || "Anonymous Seller")}>Use Account Name</button>
                    <button type="button" onClick={() => updateDraft("authorName", "Anonymous Seller")}>Anonymous Seller</button>
                  </div>
                  <label>
                    Archive Description
                    <textarea value={draft.storyText || draft.synopsis} onFocus={clearDraftDescriptionOnFocus} onChange={event => updateDraftDescription(event.target.value)} rows={5} />
                  </label>
                  <div className="cp-black-market-studio-row">
                    <label>
                      Listing Tags
                      <input value={draft.tagsText} onFocus={() => clearDraftSampleOnFocus("tagsText")} onChange={event => updateDraft("tagsText", event.target.value)} />
                    </label>
                    <label>
                      Price
                      <input inputMode="numeric" value={draft.price} onFocus={() => clearDraftSampleOnFocus("price")} onChange={event => updateDraft("price", event.target.value)} />
                    </label>
                  </div>
                </div>

                <div className="cp-black-market-studio-panel">
                  <h3>Opening Canvas</h3>
                  <p className="cp-black-market-studio-hint">Available macros: {"{{char}}"} = the unsealing character's name, {"{{user}}"} = the user persona name bound to that character. Replaced automatically at runtime.</p>
                  <label className="cp-black-market-studio-check">
                    <input
                      type="checkbox"
                      checked={draft.allowExternalControl}
                      onChange={event => updateDraft("allowExternalControl", event.target.checked)}
                    />
                    <span>
                      <strong>Enable Advanced Free Canvas</strong>
                      <em>Allows the scene code to communicate same-origin with the outer page, for effects like a fixed music bar, sidebar, or global overlay. Recipients see a risk confirmation every time before unsealing.</em>
                    </span>
                  </label>
                  <textarea value={draft.openingHtml} onFocus={() => clearDraftSampleOnFocus("openingHtml")} onChange={event => updateDraft("openingHtml", event.target.value)} rows={12} spellCheck={false} />
                </div>

                <div className="cp-black-market-studio-panel">
                  <h3>Story Instructions</h3>
                  <p className="cp-black-market-studio-hint">Story instructions, the output contract, and the memory summary prompt also support {"{{char}}"} and {"{{user}}"}.</p>
                  <textarea value={draft.aiInstruction} onFocus={() => clearDraftSampleOnFocus("aiInstruction")} onChange={event => updateDraft("aiInstruction", event.target.value)} rows={10} />
                  <label>
                    Output Contract
                    <textarea value={draft.outputContract} onFocus={() => clearDraftSampleOnFocus("outputContract")} onChange={event => updateDraft("outputContract", event.target.value)} rows={4} />
                  </label>
                  <p className="cp-black-market-studio-hint">AI replies support regular regex rendering, and can also output a ```html code block``` as an independent reply canvas. Inside the canvas, you can use Theater.sendUserAction(&quot;text&quot;) or data-action buttons to feed a choice back into the scene.</p>
                  <details className="cp-black-market-studio-advanced">
                    <summary>Advanced Render Settings</summary>
                    <label>
                      Regex Rules (JSON)
                      <textarea value={draft.renderRulesText} onFocus={() => clearDraftSampleOnFocus("renderRulesText")} onChange={event => updateDraft("renderRulesText", event.target.value)} rows={8} spellCheck={false} />
                    </label>
                    <label>
                      Render CSS
                      <textarea value={draft.renderCss} onFocus={() => clearDraftSampleOnFocus("renderCss")} onChange={event => updateDraft("renderCss", event.target.value)} rows={5} spellCheck={false} />
                    </label>
                    <label>
                      Memory Summary Prompt
                      <textarea value={draft.memorySummaryPrompt} onFocus={() => clearDraftSampleOnFocus("memorySummaryPrompt")} onChange={event => updateDraft("memorySummaryPrompt", event.target.value)} rows={4} />
                    </label>
                  </details>
                </div>

                <div className="cp-black-market-studio-panel">
                  <h3>Test Run</h3>
                  <BlackMarketTheaterHtmlFrame
                    key={previewNonce}
                    title="Custom night archive test canvas"
                    html={expandForNeutralPreview(draft.openingHtml)}
                    allowExternalControl={draft.allowExternalControl}
                  />
                  <div className="cp-black-market-studio-test">
                    <div className="cp-black-market-studio-test-head">
                      <h3>Output Contract Test</h3>
                      <span>LOCAL_RENDER_ONLY</span>
                    </div>
                    <p className="cp-black-market-studio-hint">This doesn't call the API. After manually entering USER and ASSISTANT text, it renders instantly using the current regex rules JSON, render CSS, and ```html code block``` logic.</p>
                    <div className="cp-black-market-studio-test-grid">
                      <label>
                        USER Test Message
                        <textarea
                          value={studioTestUserMessage}
                          onChange={event => setStudioTestUserMessage(event.target.value)}
                          onFocus={() => {
                            if (studioTestUserMessage === BLACK_MARKET_STUDIO_TEST_USER_SAMPLE) setStudioTestUserMessage("");
                          }}
                          rows={8}
                          spellCheck={false}
                        />
                      </label>
                      <label>
                        ASSISTANT Test Message
                        <textarea
                          value={studioTestAssistantMessage}
                          onChange={event => setStudioTestAssistantMessage(event.target.value)}
                          onFocus={() => {
                            if (studioTestAssistantMessage === BLACK_MARKET_STUDIO_TEST_ASSISTANT_SAMPLE) setStudioTestAssistantMessage("");
                          }}
                          rows={8}
                          spellCheck={false}
                        />
                      </label>
                    </div>
                    {draft.renderCss ? <style>{sanitizeRenderCss(draft.renderCss)}</style> : null}
                    <div className="cp-black-market-scene-log cp-black-market-studio-render-preview" aria-label="Output contract render preview">
                      {studioTestUserMessage.trim() ? (
                        <article className="cp-black-market-scene-message is-user">
                          <span>USER</span>
                          <BlackMarketSceneMessageContent
                            content={studioTestUserMessage}
                            template={draftPreviewTemplate}
                            characterName="Character"
                            userName="User"
                            messageId="studio-test-user"
                          />
                        </article>
                      ) : null}
                      {studioTestAssistantMessage.trim() ? (
                        <article className="cp-black-market-scene-message is-assistant">
                          <span>ASSISTANT</span>
                          <BlackMarketSceneMessageContent
                            content={studioTestAssistantMessage}
                            template={draftPreviewTemplate}
                            characterName="Character"
                            userName="User"
                            messageId="studio-test-assistant"
                          />
                        </article>
                      ) : null}
                      {!studioTestUserMessage.trim() && !studioTestAssistantMessage.trim() ? (
                        <p className="cp-black-market-scene-empty">Enter a test message to see the final rendering of the output contract here.</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="cp-black-market-studio-actions">
                    <button type="button" onClick={resetDraft}>
                      <Plus size={14} />
                      New
                    </button>
                    <button type="button" onClick={handleSaveStudioDraft}>
                      <FileText size={14} />
                      Save Draft
                    </button>
                    <button type="button" onClick={() => setPreviewNonce(value => value + 1)}>
                      <Play size={14} />
                      Refresh Preview
                    </button>
                    <button type="button" className="is-primary" disabled={publishing} onClick={() => void handlePublishDraft()}>
                      <Send size={14} />
                      {publishing ? "Syncing" : editingTemplate ? "Save Changes" : editingStudioDraft?.sourceTemplateId ? "Choose Publish Method" : "Publish"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        ) : null}
      </main>

      {notice ? (
        <div key={notice.id} className={`cp-black-market-toast cp-black-market-toast--${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      {publishChoice ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={closePublishChoice}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card" role="dialog" aria-modal="true" aria-label="Choose publish method" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>Publish Method</span>
                <strong>This draft comes from a published archive</strong>
              </div>
              <button type="button" onClick={closePublishChoice}>Close</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">{publishChoice.sourceTemplateTitle}</div>
              <p>Choose whether to overwrite the original archive with this draft, or publish it as a new night archive.</p>
              <span>{publishChoiceSourceTemplate ? "Overwriting updates the original archive; publishing as new keeps the original archive unchanged." : "The original archive can't be found in the current list, so it can only be published as a new archive; refresh the shared market to try overwriting again."}</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" disabled={publishing} onClick={() => void publishCurrentDraft("new")}>
                Publish as New Archive
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={publishing || !publishChoiceSourceTemplate}
                onClick={() => void publishCurrentDraft("overwrite-source")}
              >
                Overwrite Original Archive
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {sceneConfirmMeta ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={cancelSceneConfirm}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card" role="dialog" aria-modal="true" aria-label={sceneConfirmMeta.title} onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>SCENE ACTION</span>
                <strong>{sceneConfirmMeta.title}</strong>
              </div>
              <button type="button" onClick={cancelSceneConfirm}>Close</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">{sceneConfirmMeta.code}</div>
              <p>{sceneConfirmMeta.body}</p>
              <span>{sceneConfirmMeta.hint}</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" onClick={cancelSceneConfirm}>Cancel</button>
              <button
                type="button"
                className={sceneConfirmMeta.danger ? "is-danger" : "is-primary"}
                onClick={confirmSceneAction}
              >
                {sceneConfirmMeta.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={closeDeleteConfirm}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card" role="dialog" aria-modal="true" aria-label="Confirm delete" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>{deleteTarget.kind === "owned" ? "DELETE VAULT ITEM" : "DELETE MARKET FILE"}</span>
                <strong>{pendingDeleteTitle || "Unknown archive"}</strong>
              </div>
              <button type="button" disabled={pendingDeleteBusy} onClick={closeDeleteConfirm}>Close</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">CONFIRM_PURGE</div>
              <p>
                {deleteTarget.kind === "owned"
                  ? "This deletes the item from your local vault and discards any linked unfinished scene session. Story summaries already written to short-term memory can be deleted separately from the vault's recent records."
                  : "This deletes the published archive from the shared market. Copies already purchased into local vaults are unaffected."}
              </p>
              <span>This action does not refund Shadow Credits.</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" disabled={pendingDeleteBusy} onClick={closeDeleteConfirm}>Cancel</button>
              <button type="button" className="is-danger" disabled={pendingDeleteBusy} onClick={confirmDeleteTarget}>
                {pendingDeleteBusy ? "DELETING" : "Confirm Delete"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {externalCanvasRequest && launchOwnedTheater ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={cancelExternalCanvasRequest}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card cp-black-market-external-card" role="dialog" aria-modal="true" aria-label="Confirm advanced free canvas" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>ADVANCED CANVAS</span>
                <strong>{launchOwnedTheater.templateSnapshot.title}</strong>
              </div>
              <button type="button" onClick={cancelExternalCanvasRequest}>Close</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">EXTERNAL_CONTROL_REQUEST</div>
              <p>This scene uses an advanced free canvas, which may control the current page display, play audio, or access local page data. Only unseal works from authors you trust. Allow it?</p>
              <span>This authorization only applies to the currently open scene; you'll be asked again the next time you open it.</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" onClick={cancelExternalCanvasRequest}>Cancel</button>
              <button type="button" className="is-primary" onClick={confirmExternalCanvasRequest}>
                Allow & Unseal
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {selectedTemplate ? (
        <div className="cp-black-market-modal" role="presentation" onClick={closeTemplatePreview}>
          <section className="cp-black-market-modal-card" role="dialog" aria-modal="true" aria-label="Night archive preview" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>{selectedTemplateMode === "opening" ? "Opening Canvas" : "Night Archive"}</span>
                <strong>{selectedTemplate.title}</strong>
              </div>
              <button type="button" onClick={closeTemplatePreview}>Close</button>
            </div>
            {selectedTemplateMode === "opening" ? (
              <BlackMarketTheaterHtmlFrame
                title={`${selectedTemplate.title} opening canvas`}
                html={expandForNeutralPreview(selectedTemplate.openingHtml)}
              />
            ) : (
              <>
                <section className="cp-black-market-info-flat" aria-label="Night archive info">
                  <div className="cp-black-market-info-meta">
                    <span>{getBlackMarketFileNumber(selectedTemplate)}</span>
                    <span>{selectedTemplate.tags.slice(0, 3).join(" / ") || "Uncategorized"}</span>
                  </div>
                  <p className="cp-black-market-file-intro">{expandForNeutralPreview(selectedTemplate.storyText || selectedTemplate.synopsis)}</p>
                  <div className="cp-black-market-file-actions">
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => selectedOwnedTheater ? openSceneLauncher(selectedOwnedTheater) : void handleTemplatePrimaryAction(selectedTemplate)}
                      disabled={!selectedOwnedTheater && !isOwnPublishedTemplate(selectedTemplate) && walletBusy === "purchase"}
                    >
                      {selectedOwnedTheater || isOwnPublishedTemplate(selectedTemplate) ? "Unseal Archive" : selectedTemplate.source === "community" ? `Buy · ${formatShadowCredits(selectedTemplate.price)}` : "Claim Free"}
                    </button>
                    <button type="button" onClick={closeTemplatePreview}>Take a Look First</button>
                  </div>
                  <div className="cp-black-market-file-hint">{selectedOwnedTheater || isOwnPublishedTemplate(selectedTemplate) ? "Unsealing enters an independent scene and won't be written to normal chat." : selectedTemplate.source === "community" ? "After purchase it will be copied to your vault, then choose a character to unseal." : "After claiming for free it will be copied to your vault, then choose a character to unseal."}</div>
                </section>
              </>
            )}
            {selectedTemplateMode === "opening" ? (
              <div className="cp-black-market-modal-actions">
                <button type="button" onClick={() => setSelectedTemplateMode("info")}>Back to Archive</button>
                <button
                  type="button"
                  className="is-primary"
                  disabled={(ownedTemplateIds.has(selectedTemplate.id) && !isOwnPublishedTemplate(selectedTemplate)) || walletBusy === "purchase"}
                  onClick={() => void handleTemplatePrimaryAction(selectedTemplate)}
                >
                  {isOwnPublishedTemplate(selectedTemplate) ? "Unseal Archive" : ownedTemplateIds.has(selectedTemplate.id) ? "Owned" : selectedTemplate.source === "community" ? `Buy · ${formatShadowCredits(selectedTemplate.price)}` : "Claim Free"}
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {launchOwnedTheater ? (
        <div className={`cp-black-market-modal${activeScene ? " cp-black-market-scene-modal" : ""}`} role="presentation" onClick={closeSceneLayer}>
          <section className={`cp-black-market-modal-card cp-black-market-scene-card${activeScene ? " cp-black-market-scene-session-card" : ""}`} role="dialog" aria-modal="true" aria-label="Unseal scene" onClick={event => event.stopPropagation()}>
            {!activeScene ? (
              <>
                <div className="cp-black-market-modal-head">
                  <div>
                    <span>SELECT TARGET</span>
                    <strong>{launchOwnedTheater.templateSnapshot.title}</strong>
                  </div>
                  <button type="button" onClick={closeSceneLayer}>Close</button>
                </div>
                <p className="cp-black-market-modal-copy">Choose a character to enter an independent scene. The story won't be written to normal chat, and you can choose to summarize it into short-term memory when it ends.</p>
                <div className="cp-black-market-character-grid">
                  {characters.length === 0 ? (
                    <div className="cp-black-market-empty">No characters available yet.</div>
                  ) : characters.map(char => {
                    const canResume = launchActiveCharacterIds.has(char.id);
                    return (
                      <button
                        key={char.id}
                        type="button"
                        className={launchCharacterId === char.id ? "is-active" : ""}
                        onClick={() => setLaunchCharacterId(char.id)}
                      >
                        <span>{char.avatar ? <img src={char.avatar} alt="" /> : char.name.slice(0, 1)}</span>
                        <strong>{char.name}</strong>
                        <em>{resolveSceneUserName(char)}{canResume ? " · Resumable" : " · New"}</em>
                      </button>
                    );
                  })}
                </div>
                <div className="cp-black-market-modal-actions">
                  <button type="button" onClick={closeSceneLayer}>Cancel</button>
                  <button type="button" className="is-primary" disabled={!launchCharacter} onClick={startSceneFromLauncher}>
                    {resumableLaunchScene ? "Resume Scene" : "Enter Opening"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {launchOwnedTheater.templateSnapshot.renderCss ? (
                  <style>{sanitizeRenderCss(launchOwnedTheater.templateSnapshot.renderCss)}</style>
                ) : null}
                <div className="cp-black-market-scene-toolbar" aria-label="Scene actions">
                  <div className="cp-black-market-scene-toolbar-group">
                    <button type="button" aria-label="Return to market" onClick={() => requestSceneConfirm("return")}>
                      <ChevronLeft size={20} strokeWidth={2.5} />
                    </button>
                    <button type="button" aria-label="Save for later" onClick={() => requestSceneConfirm("archive")}>
                      <Archive size={18} strokeWidth={2.35} />
                    </button>
                  </div>
                  <div className="cp-black-market-scene-toolbar-group">
                    <button
                      type="button"
                      aria-label="Restart scene"
                      disabled={activeScene.status === "ended" || sceneBusy !== null}
                      onClick={() => requestSceneConfirm("restart")}
                    >
                      <RotateCcw size={18} strokeWidth={2.35} />
                    </button>
                    <button
                      type="button"
                      aria-label="End and write to memory"
                      disabled={activeScene.status === "ended" || sceneBusy !== null || activeScene.messages.length === 0}
                      onClick={() => requestSceneConfirm("summary")}
                    >
                      <FileText size={18} strokeWidth={2.35} className={sceneBusy === "summary" ? "cp-spin" : ""} />
                    </button>
                  </div>
                </div>
                <div className="cp-black-market-scene-flow">
                  {externalCanvasAllowed && launchOwnedTheater.templateSnapshot.allowExternalControl ? (
                    <div id="black-market-creator-layer" className="cp-black-market-creator-layer" />
                  ) : null}
                  <BlackMarketTheaterHtmlFrame
                    key={activeScene.id}
                    title={`${launchOwnedTheater.templateSnapshot.title} opening canvas`}
                    html={expandForScene(launchOwnedTheater.templateSnapshot.openingHtml)}
                    allowExternalControl={externalCanvasAllowed && launchOwnedTheater.templateSnapshot.allowExternalControl}
                    collapsible
                  />
                  <div className="cp-black-market-scene-log">
                    {activeScene.messages.length === 0 ? (
                      <p className="cp-black-market-scene-empty">The opening has loaded. Type your first line or action to let the character pick up the story.</p>
                    ) : activeScene.messages.map(message => {
                      const isLastMessage = activeScene.messages[activeScene.messages.length - 1]?.id === message.id;
                      const canMutateScene = activeScene.status === "active" && sceneBusy === null;
                      const canRetryAssistant = canMutateScene && message.role === "assistant";
                      const canRetryUser = canMutateScene && message.role === "user" && isLastMessage;
                      return (
                        <article key={message.id} className={`cp-black-market-scene-message is-${message.role}`}>
                          <div className="cp-black-market-scene-message-head">
                            <span>{message.role === "assistant" ? activeScene.characterName : activeScene.userName}</span>
                            <span className="cp-black-market-scene-message-actions" aria-label="Message actions">
                              <button
                                type="button"
                                onClick={() => void copySceneMessage(message.content)}
                                aria-label="Copy original text"
                                title="Copy"
                              >
                                <Copy size={12} />
                              </button>
                              {message.role === "user" ? (
                                <button
                                  type="button"
                                  onClick={() => beginEditSceneUserMessage(message)}
                                  disabled={!canMutateScene}
                                  aria-label="Edit and resend"
                                  title="Edit"
                                >
                                  <Pencil size={12} />
                                </button>
                              ) : null}
                              {canRetryAssistant ? (
                                <button
                                  type="button"
                                  onClick={() => void retrySceneFromAssistantMessage(message)}
                                  aria-label="Retry from here"
                                  title="Retry from here"
                                >
                                  <RotateCcw size={12} />
                                </button>
                              ) : null}
                              {canRetryUser ? (
                                <button
                                  type="button"
                                  onClick={() => void retrySceneFromUserMessage(message)}
                                  aria-label="Regenerate"
                                  title="Regenerate"
                                >
                                  <RotateCcw size={12} />
                                </button>
                              ) : null}
                            </span>
                          </div>
                          <BlackMarketSceneMessageContent
                            content={message.content}
                            template={launchOwnedTheater.templateSnapshot}
                            characterName={activeScene.characterName}
                            userName={activeScene.userName}
                            messageId={message.id}
                            allowExternalControl={externalCanvasAllowed && launchOwnedTheater.templateSnapshot.allowExternalControl}
                          />
                        </article>
                      );
                    })}
                    {sceneBusy === "reply" ? (
                      <article className="cp-black-market-scene-message is-assistant is-thinking" aria-live="polite">
                        <span>{activeScene.characterName}</span>
                        <div className="cp-black-market-thinking-text">
                          Thinking
                          <i aria-hidden="true" />
                          <i aria-hidden="true" />
                          <i aria-hidden="true" />
                        </div>
                      </article>
                    ) : null}
                  </div>
                  {activeScene.summary ? (
                    <div className="cp-black-market-scene-summary">
                      <span>RECENT_THEATER</span>
                      <p>{activeScene.summary}</p>
                    </div>
                  ) : null}
                </div>
                {activeScene.status === "active" ? (
                  <div className="cp-black-market-scene-input-wrap">
                    {editingSceneMessageId ? (
                      <div className="cp-black-market-scene-editing">
                        <span>Editing a past action</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSceneMessageId(null);
                            setSceneInput("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                    <div className="cp-black-market-scene-input">
                      <textarea
                        value={sceneInput}
                        onChange={event => setSceneInput(event.target.value)}
                        rows={3}
                        placeholder={editingSceneMessageId ? "Send after editing to rewrite what follows..." : "Type your action, line, or choice..."}
                        disabled={sceneBusy !== null}
                      />
                      <button type="button" className="is-primary" disabled={!sceneInput.trim() || sceneBusy !== null} onClick={() => void handleSceneSubmit()}>
                        {sceneBusy === "reply" ? "Generating" : editingSceneMessageId ? "Rewrite" : "Send"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
