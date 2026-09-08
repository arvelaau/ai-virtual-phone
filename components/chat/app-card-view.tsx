"use client";

// components/chat/app-card-view.tsx
// Presentational core of a custom-app chat-directive card (a boarding-pass, a café menu --
// see PROACTIVE-MESSAGE-2.0-PLAN.md's sibling plan for the HTML-trigger feature). Extracted out
// of message-bubble.tsx's AppCardBubble so story mode and offline mode can render the exact
// same card chat already can, instead of a second/third copy of the iframe+srcDoc logic
// drifting from it over time -- the defect class this codebase has hit repeatedly (see
// CLAUDE.md's tool-executor / FETCH_RESULT_HEADER / prompt-sanitizer entries).
//
// Deliberately NOT tied to ChatMessage's shape: story's StoryMessage and offline's
// ChatOfflineTurn carry only a subset of what a live chat message's mediaData does (appId,
// appName, appCardLayout -- no per-message directive metadata, since neither mode routes
// through parseAIResponse). Callers compute their own fallback title/body from whatever fields
// they actually have and pass the rest through as plain props.

import { Blocks, Pin, PinOff, RefreshCw, X } from "lucide-react";
import { useState, type CSSProperties, type MouseEventHandler } from "react";
import { STUDIO_APP_ID } from "@/lib/card-studio-storage";
import { findMomentsPinTargetApp, pinAppCardToMoments, type AppCardPinSourceMode } from "@/lib/custom-app-moments-pin";

export type NormalizedAppCardLayout = {
    appLabel: string;
    title: string;
    subtitle: string;
    body: string;
    html: string;
    height: number;
    status: string;
    image: string;
    accentColor: string;
    background: string;
    openDisabled: boolean;
    sections: Array<{
        title: string;
        text: string;
        rows: Array<{ label: string; value: string }>;
        chips: string[];
    }>;
    actions: Array<{ label: string; style: string; disabled: boolean }>;
};

export function cardRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function cardText(value: unknown, max = 240): string {
    return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

export function cardTextArray(value: unknown, maxItems = 6): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => cardText(item, 80)).filter(Boolean).slice(0, maxItems);
}

export function cardNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function stripAppCardExecutableHtml(html: string): string {
    return html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
}

export function buildAppCardSrcDoc(html: string): string {
    const safeHtml = stripAppCardExecutableHtml(html);
    if (/<html[\s>]/i.test(safeHtml)) return safeHtml;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    *{box-sizing:border-box;}
  </style>
</head>
<body>${safeHtml}</body>
</html>`;
}

export function normalizeAppCardLayout(value: unknown): NormalizedAppCardLayout {
    const record = cardRecord(value);
    const sections = Array.isArray(record.sections) ? record.sections : [];
    const rows = Array.isArray(record.rows) ? [{ title: record.rowsTitle, rows: record.rows }] : [];
    const normalizedSections = [...sections, ...rows].map(item => {
        const section = cardRecord(item);
        const sectionRows = Array.isArray(section.rows) ? section.rows : [];
        return {
            title: cardText(section.title, 80),
            text: cardText(section.text ?? section.body, 500),
            rows: sectionRows.map(row => {
                const rowRecord = cardRecord(row);
                return {
                    label: cardText(rowRecord.label ?? rowRecord.name, 80),
                    value: cardText(rowRecord.value ?? rowRecord.text, 160),
                };
            }).filter(row => row.label || row.value).slice(0, 8),
            chips: cardTextArray(section.chips ?? section.tags),
        };
    }).filter(section => section.title || section.text || section.rows.length || section.chips.length).slice(0, 6);
    const actions = Array.isArray(record.actions) ? record.actions : [];
    return {
        appLabel: cardText(record.appLabel, 60),
        title: cardText(record.title, 100),
        subtitle: cardText(record.subtitle, 160),
        body: cardText(record.body ?? record.text, 1000),
        html: cardText(record.html, 20000),
        height: cardNumber(record.height ?? record.cardHeight, 220, 96, 520),
        status: cardText(record.status, 60),
        image: cardText(record.image ?? record.imageUrl, 2000),
        accentColor: cardText(record.accentColor, 40),
        background: cardText(record.background, 120),
        openDisabled: record.openDisabled === true || record.clickDisabled === true || record.disabled === true || record.clickable === false,
        sections: normalizedSections,
        actions: actions.map(item => {
            const action = cardRecord(item);
            return {
                label: cardText(action.label ?? action.text, 40),
                style: cardText(action.style, 30),
                disabled: action.disabled === true || action.enabled === false,
            };
        }).filter(action => action.label).slice(0, 3),
    };
}

/**
 * Context needed to offer a "Pin to Moments" action on this card. Omit entirely when the
 * caller has no sensible character/summary context (e.g. Studio's own editor preview) --
 * AppCardView still checks whether any app can even receive a pin before showing the button,
 * so passing this costs nothing when no target app is installed.
 */
export type AppCardPinContext = {
    sourceMode: AppCardPinSourceMode;
    characterId: string;
    characterName: string;
    /** The enclosing turn's own summary -- story's storySummary, offline's turn.summary, or
     *  (chat has no per-message summary) the message's own visible text, truncated by the caller. */
    summary: string;
    cardAppId?: string;
    cardAppName?: string;
    messageId?: string;
    sessionId?: string;
};

export type AppCardViewProps = {
    /** Raw appCardLayout blob off the message/turn -- normalized internally. */
    appCardLayout: unknown;
    /** Falls back to this when the layout has no appLabel of its own. */
    appName: string;
    /** Falls back to this when the layout has no title of its own. */
    fallbackTitle?: string;
    /** Falls back to this when the layout has no body of its own. */
    fallbackBody?: string;
    /** `chat-app-card-tone-<tone>` styling hook, sanitized. */
    tone?: string;
    /**
     * The directive's owning app id. When this equals STUDIO_APP_ID (a card authored in the
     * Studio app, not backed by a real installed custom app) a click opens an in-place detail
     * popup instead of calling `onOpen` -- there's no real app for Studio to hand off to.
     */
    appId?: string;
    /** Called on card click (or an action button click) unless the card/action is disabled. */
    onOpen: () => void;
    pinContext?: AppCardPinContext;
};

function StudioCardDetailSheet({ layout, title, appName, onClose }: {
    layout: NormalizedAppCardLayout;
    title: string;
    appName: string;
    onClose: () => void;
}) {
    return (
        <div className="chat-app-card-detail-overlay" onClick={onClose}>
            <div className="chat-app-card-detail-sheet" onClick={(event) => event.stopPropagation()}>
                <div className="chat-app-card-detail-head">
                    <span>{layout.appLabel || appName}</span>
                    <button type="button" className="chat-app-card-detail-close" aria-label="Close" onClick={onClose}>
                        <X size={16} strokeWidth={2} />
                    </button>
                </div>
                {layout.html ? (
                    <iframe
                        title={title}
                        className="chat-app-card-detail-frame"
                        sandbox=""
                        srcDoc={buildAppCardSrcDoc(layout.html)}
                    />
                ) : (
                    <div className="chat-app-card-detail-body">
                        <div className="chat-app-card-detail-title">{title}</div>
                        {layout.subtitle ? <div className="chat-app-card-detail-subtitle">{layout.subtitle}</div> : null}
                        {layout.body ? <p>{layout.body}</p> : null}
                        {layout.sections.map((section, index) => (
                            <div className="chat-app-card-detail-section" key={`${section.title || "section"}-${index}`}>
                                {section.title ? <div className="chat-app-card-detail-section-title">{section.title}</div> : null}
                                {section.text ? <p>{section.text}</p> : null}
                                {section.rows.map((row, rowIndex) => (
                                    <div className="chat-app-card-detail-row" key={`${row.label}-${rowIndex}`}>
                                        <span>{row.label}</span>
                                        <strong>{row.value}</strong>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export function AppCardView({ appCardLayout, appName, fallbackTitle, fallbackBody, tone, appId, onOpen, pinContext }: AppCardViewProps) {
    // There's no reliable way to detect "this iframe's HTML actually rendered wrong" --
    // malformed HTML/CSS still "succeeds" from the browser's own perspective, it just looks
    // broken. So instead of failure-detection, a manual reload is always available: bumping
    // this key unmounts and remounts the iframe, which re-runs its srcDoc from scratch. Fixes
    // transient rendering glitches (a race on first mount, a stuck sandboxed script); does NOT
    // call the LLM again or change the content -- the HTML itself is unchanged, only the iframe
    // is fresh. A genuinely bad card (the model wrote broken markup) needs a real regenerate of
    // the message/turn that produced it, same as any other AI output.
    const [reloadKey, setReloadKey] = useState(0);
    const [detailOpen, setDetailOpen] = useState(false);
    const [pinState, setPinState] = useState<"idle" | "pinned" | "error">("idle");
    const layout = normalizeAppCardLayout(appCardLayout);
    const title = layout.title || fallbackTitle || appName;
    const subtitle = layout.subtitle;
    const body = layout.body || fallbackBody || "";
    const toneClass = tone ? ` tone-${String(tone).replace(/[^a-z0-9_-]/gi, "")}` : "";
    const cardOpenDisabled = layout.openDisabled || (layout.actions.length > 0 && layout.actions.every(action => action.disabled));
    const isStudioCard = appId === STUDIO_APP_ID;
    const style = {
        ...(layout.accentColor ? { "--chat-app-card-accent": layout.accentColor } : {}),
        ...(layout.background ? { "--chat-app-card-bg": layout.background } : {}),
    } as CSSProperties;

    // A Studio-authored card has no real installed app behind it -- opening it means showing a
    // brief detail popup in place, never dispatching "open-app" (there's nothing to open).
    const handleOpen = () => {
        if (cardOpenDisabled) return;
        if (isStudioCard) { setDetailOpen(true); return; }
        onOpen();
    };

    const detailSheet = isStudioCard && detailOpen
        ? <StudioCardDetailSheet layout={layout} title={title} appName={appName} onClose={() => setDetailOpen(false)} />
        : null;

    // Checked on every render rather than memoized: findMomentsPinTargetApp is a cheap
    // synchronous kv lookup, and a card renders once per message anyway.
    const pinTarget = pinContext ? findMomentsPinTargetApp() : null;
    const handlePin: MouseEventHandler = (event) => {
        event.stopPropagation();
        if (!pinContext || !pinTarget || pinState !== "idle") return;
        const result = pinAppCardToMoments({
            characterId: pinContext.characterId,
            characterName: pinContext.characterName,
            sourceMode: pinContext.sourceMode,
            summary: pinContext.summary,
            appCardLayout: layout as unknown as Record<string, unknown>,
            cardAppId: pinContext.cardAppId,
            cardAppName: pinContext.cardAppName,
            messageId: pinContext.messageId,
            sessionId: pinContext.sessionId,
        });
        setPinState(result.ok ? "pinned" : "error");
        window.setTimeout(() => setPinState("idle"), 2200);
    };
    const pinButton = pinTarget ? (
        <button
            type="button"
            className="chat-app-custom-card-pin"
            aria-label={pinState === "pinned" ? "Pinned to Moments" : `Pin to ${pinTarget.name}'s Moments`}
            title={pinState === "pinned" ? "Pinned to Moments" : `Pin to ${pinTarget.name}'s Moments`}
            data-state={pinState}
            onClick={handlePin}
        >
            {pinState === "error" ? <PinOff size={13} strokeWidth={2} /> : <Pin size={13} strokeWidth={2} />}
        </button>
    ) : null;

    if (layout.html) {
        return (
            <>
            <div className={`chat-app-custom-card${toneClass}`} data-disabled={cardOpenDisabled || undefined} style={style} onClick={handleOpen}>
                <button
                    type="button"
                    className="chat-app-custom-card-reload"
                    aria-label="Reload card"
                    title="Reload card"
                    onClick={(event) => {
                        event.stopPropagation();
                        setReloadKey((value) => value + 1);
                    }}
                >
                    <RefreshCw size={13} strokeWidth={2} />
                </button>
                {pinButton}
                <iframe
                    key={reloadKey}
                    title={title}
                    className="chat-app-custom-card-frame"
                    sandbox=""
                    style={{ height: layout.height }}
                    srcDoc={buildAppCardSrcDoc(layout.html)}
                />
            </div>
            {detailSheet}
            </>
        );
    }

    return (
        <>
        <div className={`chat-app-card${toneClass}`} data-disabled={cardOpenDisabled || undefined} style={style} onClick={handleOpen}>
            <div className="chat-app-card-head">
                <span className="chat-app-card-icon" aria-hidden>
                    <Blocks size={18} strokeWidth={2} />
                </span>
                <span className="chat-app-card-name">{layout.appLabel || appName}</span>
                {layout.status ? <span className="chat-app-card-status">{layout.status}</span> : null}
                {pinButton}
            </div>
            {layout.image ? <img className="chat-app-card-image" src={layout.image} alt="" /> : null}
            <div className="chat-app-card-title">{title}</div>
            {subtitle ? <div className="chat-app-card-subtitle">{subtitle}</div> : null}
            {body ? <div className="chat-app-card-body">{body}</div> : null}
            {layout.sections.length > 0 ? (
                <div className="chat-app-card-sections">
                    {layout.sections.map((section, index) => (
                        <div className="chat-app-card-section" key={`${section.title || "section"}-${index}`}>
                            {section.title ? <div className="chat-app-card-section-title">{section.title}</div> : null}
                            {section.text ? <div className="chat-app-card-section-text">{section.text}</div> : null}
                            {section.rows.length > 0 ? (
                                <div className="chat-app-card-rows">
                                    {section.rows.map((row, rowIndex) => (
                                        <div className="chat-app-card-row" key={`${row.label}-${rowIndex}`}>
                                            <span>{row.label}</span>
                                            <strong>{row.value}</strong>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                            {section.chips.length > 0 ? (
                                <div className="chat-app-card-chips">
                                    {section.chips.map((chip, chipIndex) => <span key={`${chip}-${chipIndex}`}>{chip}</span>)}
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {layout.actions.length > 0 ? (
                <div className="chat-app-card-actions">
                    {layout.actions.map((action, index) => (
                        <button
                            type="button"
                            key={`${action.label}-${index}`}
                            data-style={action.style || "default"}
                            disabled={action.disabled}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (action.disabled) return;
                                handleOpen();
                            }}
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
        {detailSheet}
        </>
    );
}
