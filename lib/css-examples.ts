// lib/css-examples.ts
// Shared CSS examples — used by CSS editors AND Scroll's CSS skill.
// Curated top 30-50 most impactful selectors per location, with clear comments.

export const CHAT_SESSION_CSS_EXAMPLE = `/* ═══ Individual chat room CSS example ═══ */
/* Scope: affects only this chat room, nothing else. */

/* ── Colour variables ── */
:root {
  --c-header-bg: #FFFFFF;         /* title bar background */
  --c-page-body-bg: #FAFAFA;      /* message area background */

  --c-bubble-self: var(--c-action-blue, #246bfd); /* my bubble */
  --c-bubble-other: #FFFFFF;      /* their bubble */
  --c-text-title: #2C3440;        /* primary text */
  --c-text: #797E85;              /* secondary text */
  --c-icon: #A0A3A8;              /* ordinary icons */
  --c-icon-active: #4A4A4A;       /* accent */

  --c-input: #EBEBEB;
  --c-input-border: #DADBDF;
  --c-card: #FFFFFF;
  --c-card-border: #E0E0E0;
}

/* ── Chat room background ── */
.chat-room-wrapper {
  background: var(--c-page-body-bg);
  /* background: url("image-url") center/cover no-repeat; */
}

/* ── Title bar ── */
/* .page-header = the whole title bar including the safe area — change background or blur here */
/* .page-header-content = the row holding the buttons and title — change padding or layout here */
.page-header {
  background: color-mix(in srgb, var(--c-header-bg) 75%, transparent);
  backdrop-filter: blur(20px);
  /* to turn the blur off: backdrop-filter: none; background: var(--c-header-bg); */
}

.page-header-content {
  /* padding: 10px 14px; */
  /* gap: 8px; */
}

.page-title,
.page-back-btn {
  color: var(--c-text-title);
}

/* ── Message list ── */
.chat-scroll-anchored {
  padding: 16px 16px 24px;
}

.chat-msg-wrapper {
  gap: 8px;
}

.chat-sys-msg {
  color: var(--c-text);
}

/* injected system-instruction card */
.chat-system-instruction-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 8px;
  box-shadow: var(--chat-bubble-shadow);
}

.chat-system-instruction-title {
  color: var(--c-text-title);
  font-weight: 600;
}

.chat-system-instruction-body {
  color: var(--c-text);
  text-indent: 2em;
}

/* consecutive messages from the same person: tighten the spacing (optional) */
/*
.chat-msg-wrapper[data-consecutive] {
  margin-top: -12px !important;
}
*/
/* consecutive messages from the same person: hide the avatar (optional) */
/*
.chat-msg-wrapper[data-consecutive] .chat-msg-avatar {
  opacity: 0;
  pointer-events: none;
}
*/

/* ── iMessage bubble defaults ──
   The app now ships an iMessage-style bubble. Everything about it is a
   custom property, so you can retune it without rewriting any selector.
   Put these in :root to change them everywhere.
*/
/*
:root {
  --chat-bubble-radius: 18px;
  --chat-bubble-padding: 9px 12px;
  --chat-bubble-font-size: calc(13.5px * var(--app-text-scale, 1));
  --chat-bubble-line-height: 1.4;
  --chat-bubble-min-width: 45px;
  --chat-bubble-min-height: 36px;
  --chat-bubble-text-self: #ffffff;
  --chat-bubble-text-other: #1c1c1e;

  /* spacing inside a run vs. when the speaker changes */
  --chat-bubble-gap-consecutive: -6px;
  --chat-bubble-gap-speaker: 10px;

  /* the little tail. set display to none to switch tails off */
  --chat-bubble-tail-display: block;
  --chat-bubble-tail-size: 30px;
  --chat-bubble-tail-self: url("...");
  --chat-bubble-tail-other: url("...");

  /* hide avatars entirely with: none */
  --chat-avatar-display: flex;

  /* reply capsule floating above the bubble */
  --chat-quote-max-width: 200px;
  --chat-quote-font-size: 11px;
  --chat-quote-offset: 42px;
}
*/

/* The tail is drawn only on the LAST bubble of a consecutive run. That run
   end is marked by [data-run-end] on .chat-msg-wrapper, computed in
   chat-room.tsx — a CSS sibling selector cannot find it, because every
   message sits in its own flex container. [data-consecutive] marks the
   2nd..nth bubble of a run. */
/*
.chat-msg-wrapper[data-run-end] .chat-bubble-role-user::after { display: none; }
*/

/* ── Bubbles ── */
.chat-bubble-role-user {
  background: var(--c-bubble-self);
  color: #fff;
}

.chat-bubble-role-assistant {
  background: var(--c-bubble-other);
  color: var(--c-text-title);
  border-radius: 6px;
  padding: 10px 14px;
}

.chat-markdown {
  color: var(--c-text-title);
  font-size: calc(15px*var(--app-text-scale,1));
  line-height: 1.7;
}

/* spacing between paragraphs */
.chat-markdown p + p,
.chat-markdown-paragraph + .chat-markdown-paragraph {
  margin-top: 6px;
}

.chat-bubble-media {
  border-radius: 12px;
  overflow: visible;
}

/* ── Quote, edit and long-press menu ── */
.chat-quote-bar,
.chat-inline-edit-textarea {
  background: var(--c-input);
  border: 1px solid var(--c-input-border);
  border-radius: 8px;
}

.chat-inline-edit-btn-save {
  background: var(--c-icon-active);
  color: #ffffff;
}

.ctx-menu {
  background: #2c2c2c;
  border-radius: 8px;
}

.ctx-menu-btn {
  color: #ffffff;
}

.ctx-menu-btn-danger {
  color: #ff6b6b;
}

/* ── Input bar ── */
.chat-input-bar {
  background: color-mix(in srgb, var(--c-input) 55%, transparent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.chat-input-textarea {
  background: var(--c-input);
  border: 0.5px solid var(--c-input-border);
  color: var(--c-text-title);
  font-size: calc(15px*var(--app-text-scale,1));
}

.chat-input-actions {
  gap: 32px;
  justify-content: center;
}

/* ── Offline mode ── */
.chat-offline-toggle.chat-offline-active {
  color: var(--c-text-title);
}

.chat-offline-body {
  padding: 16px 8px 24px;
  gap: 12px;
}

.chat-offline-empty,
.chat-offline-time {
  color: var(--c-icon);
}

.chat-offline-turn {
  border-radius: 12px;
  background: color-mix(in srgb, var(--c-card) 56%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-card-border) 30%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.chat-offline-entry {
  padding: 10px 14px 10px 18px;
}

.chat-offline-entry + .chat-offline-entry {
  border-top: 1px solid color-mix(in srgb, var(--c-card-border) 22%, transparent);
}

.chat-offline-entry[data-role="user"]::before {
  background: color-mix(in srgb, var(--c-icon) 50%, transparent);
}

.chat-offline-entry[data-role="assistant"]::before {
  background: color-mix(in srgb, var(--c-text-title) 38%, transparent);
}

.chat-offline-label {
  border-radius: 4px;
  font-size: calc(11px*var(--app-text-scale,1));
  font-weight: 600;
}

.chat-offline-entry[data-role="user"] .chat-offline-label {
  color: var(--c-icon);
  background: color-mix(in srgb, var(--c-icon) 10%, transparent);
}

.chat-offline-entry[data-role="assistant"] .chat-offline-label {
  color: var(--c-text-title);
  background: color-mix(in srgb, var(--c-text-title) 7%, transparent);
}

.chat-offline-text {
  color: var(--c-text);
  font-size: calc(14.5px*var(--app-text-scale,1));
  line-height: 1.85;
}

.chat-offline-entry[data-role="assistant"] .chat-offline-text {
  color: var(--c-text-title);
}

.chat-offline-text[data-active] {
  background: color-mix(in srgb, var(--c-icon) 8%, transparent);
}

.chat-offline-summary-fold {
  background: color-mix(in srgb, var(--c-page-body-bg) 50%, transparent);
  border-radius: 6px;
}

.chat-offline-summary-fold > summary,
.chat-offline-summary-content,
.chat-offline-generating {
  color: var(--c-icon);
}

.chat-offline-summary-content {
  font-size: calc(13px*var(--app-text-scale,1));
  line-height: 1.8;
}

/* ── The plus menu and emoji panel (now rendered as an internal overlay) ── */
/* 
.chat-plus-menu,
.chat-emoji-panel-wrap {
  controlled inline; adjust the height directly if you need to.
}
*/

/* ── Voice bar ── */
.voice-msg-bubble {
  border-radius: 12px;
}

.voice-msg-icon {
  color: var(--c-icon-active);
}

.voice-msg-bar {
  background: var(--c-icon);
}

.voice-msg-bars[data-playing] .voice-msg-bar {
  background: var(--c-icon-active);
}

.voice-msg-dur {
  color: var(--c-text);
}

/* ── Inner monologue ── */
.chat-thought-card {
  background: linear-gradient(135deg, #fef9ef, #fdf3e0);
  border: 1px solid rgba(222,184,135,0.30);
  border-radius: 12px;
}

.chat-thought-title,
.chat-thought-sig {
  color: #c9a96e;
}

.chat-thought-body {
  color: #5a4a3a;
}

.chat-monologue-heart[data-active] {
  color: #e74c5e;
}

/* ── Card messages ── */
.chat-red-packet-card,
.chat-transfer-card,
.chat-html-inline,
.chat-music-share-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 14px;
}

.chat-red-packet-body {
  /* background: linear-gradient(135deg, #ff6a5f, #e8473f); */
}

.chat-transfer-body {
  /* background: linear-gradient(135deg, #ffb347, #ff8c2a); */
}

.ui-media-footer {
  background: var(--c-card);
  color: var(--c-text);
}

.ui-media-footer[data-status="declined"] {
  color: var(--c-icon);
}

.chat-html-inline-frame {
  max-height: min(36vh, 340px);
}

.chat-thought-card .chat-html-inline-frame {
  max-height: min(52vh, 420px);
}

.chat-msg-content-wrap[data-html="true"] {
  /* to let an HTML message run wider: max-width: 100% !important; */
}

.chat-music-share-title {
  color: var(--c-text-title);
}

.chat-music-share-artist {
  color: var(--c-text);
}

/* location card */
.chat-location-card {
  border-radius: 14px;
  overflow: hidden;
}

.chat-location-map {
  /* background: linear-gradient(135deg, #a7c7e7, #d8ecff); */
}

.chat-location-label {
  background: var(--c-input);
  color: var(--c-text);
}

/* sticker */
.chat-sticker {
  border-radius: 12px;
}

.chat-sticker-image img {
  width: 120px;
  height: 120px;
}

.chat-sticker-fallback {
  background: color-mix(in srgb, var(--c-icon) 10%, transparent);
  color: var(--c-text);
}

/* quoted message */
.chat-quote-preview {
  background: color-mix(in srgb, var(--c-icon) 10%, transparent);
  border-left-color: color-mix(in srgb, var(--c-icon) 35%, transparent);
  color: var(--c-icon);
}

/* file, image, audio and video attachments */
.chat-media-file-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 12px;
}

.chat-media-file-title {
  color: var(--c-text-title);
}

.chat-media-file-time,
.chat-media-file-save {
  color: var(--c-text);
}

.chat-media-file-play,
.chat-media-file-progress-fill {
  background: var(--c-icon-active);
}

/* gift card */
.chat-gift-card {
  background: #ffffff;
  border: none;
  border-radius: 0;
  overflow: visible;
  /* no shadow wanted? box-shadow: none; */
  box-shadow: 0 1px 4px rgba(0,0,0,0.025);
  margin: 2px 0 4px;
}

.chat-gift-card-body {
  background: #ffffff;
  overflow: visible;
}

.chat-gift-card-status {
  background: rgba(0,0,0,0.055);
  color: var(--c-text-title);
}

.chat-gift-card-title {
  color: var(--c-text-title);
  font-size: calc(24px*var(--app-text-scale,1));
}

.chat-gift-card-divider {
  background: rgba(0,0,0,0.12);
}

.chat-gift-card-footer {
  border-top: 1px solid rgba(0,0,0,0.12);
}

.chat-gift-card-cell-label,
.chat-gift-card-kicker,
.chat-gift-card-label,
.chat-gift-card-brand {
  color: var(--c-icon);
}

.chat-gift-card-cell-value,
.chat-gift-card-source {
  color: var(--c-text);
}

/* text photo card */
.chat-photo-card {
  background: #ffffff;
  border: none;
  border-radius: 0;
  overflow: visible;
  /* no shadow wanted? box-shadow: none; */
  box-shadow: 0 1px 4px rgba(0,0,0,0.025);
  margin: 2px 0 4px;
}

.chat-photo-card-placeholder {
  background: #ffffff;
}

.chat-photo-card-text {
  color: var(--c-text-title);
  font-family: Georgia, "Times New Roman", serif;
  font-size: calc(13px*var(--app-text-scale,1));
  font-style: italic;
  line-height: 1.35;
  text-align: center;
}

.chat-photo-card-image {
  background: #ffffff;
}

/* Real user-uploaded images use the .chat-photo-card--image modifier;
   the container sizes itself to the image, which keeps its aspect ratio uncropped */
.chat-photo-card--image {
  background: transparent;
  box-shadow: none;
}

.chat-photo-card--image .chat-photo-card-image {
  object-fit: contain;
}

/* Xiaohongshu share card */
.chat-xhs-share-card {
  background: #ffffff;
  border: none;
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.02);
}

.chat-xhs-share-title {
  color: var(--c-text-title);
}

.chat-xhs-share-head,
.chat-xhs-share-author,
.chat-xhs-share-desc {
  color: var(--c-text);
}

.chat-xhs-share-mark {
  background: #ff2442;
  color: #ffffff;
}

.chat-xhs-share-cover {
  border-radius: 6px;
}

.chat-xhs-share-tags span {
  color: #ff2442;
  background: #fff0f3;
}

/* payment card (WeChat scan-to-pay, Alipay and the like) */
.scan-pay-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 14px;
}
.scan-pay-title {
  color: var(--c-text-title);
}
.scan-pay-qr {
  border-radius: 8px;
}
.scan-pay-hint {
  color: var(--c-text);
}
.scan-pay-btn {
  border-radius: 999px;
}
.scan-pay-btn-primary {
  background: #07c160; /* the open-WeChat button (WeChat green by default) */
  color: #ffffff;
}

/* Custom app card (generated by a character via a rich-media directive; black-and-white dossier look) */
/* To change the ink colour throughout, edit --cac-ink alone — headings, figures, black tags and the primary button all follow */
.chat-app-card {
  --cac-ink: #141414;             /* primary ink: headings / figures / black tags / primary button */
  --cac-ink-soft: #3b3b3b;        /* body text and process blocks */
  --cac-ink-mute: #8c8c8c;        /* de-emphasised text: app name, subtitles */
  --cac-line: rgba(0,0,0,0.12);   /* dividers and small tag borders */
  --cac-dash: rgba(0,0,0,0.30);   /* dashed rule between blocks */
  background: #ffffff;            /* card background */
  border-color: rgba(0,0,0,0.06); /* card outline — raise 0.06 to make it crisper */
  /* want rounded corners? add border-radius: 12px; */
}
/* Headings are centred and uppercased by default; uncomment the line below to drop the uppercasing */
.chat-app-card-title {
  /* text-transform: none; */
}
/* To colour just the black tags and the primary button while the body stays ink, change these two */
.chat-app-card-section-title {
  background: var(--cac-ink);
  color: #ffffff;
}
.chat-app-card-actions button:last-child:not([data-style="danger"]) {
  background: var(--cac-ink);
  color: #ffffff;
}

/* ── State value panel ── */
.state-panel {
  background: color-mix(in srgb, var(--c-card) 70%, transparent);
  border-radius: 6px;
}

.state-bar-track {
  height: 6px;
  border-radius: 3px;
}

/* ── Advanced: custom fonts ── */
/* @import url("https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap"); */
/* * { font-family: "ZCOOL KuaiLe", sans-serif; } */
`;

export const CHAT_APP_CSS_EXAMPLE = `/* ═══ Chat application CSS example ═══ */
/* Scope: every page of the chat app — messages, contacts, Moments, profile and the chat rooms. */
/* An individual chat room's CSS outranks this and can override anything here. */


/* ══════════════════════════
   1. Colour variables
   ══════════════════════════ */
.chat-app {
  --c-header-bg: #FFFFFF;         /* title bar background */
  --c-page-body-bg: #FAFAFA;      /* content area background */

  --c-bubble-self: var(--c-action-blue, #246bfd); /* my bubble */
  --c-bubble-other: #FFFFFF;      /* their bubble */
  --c-card: #FFFFFF;              /* card background */
  --c-card-border: #E0E0E0;       /* card border and dividers */
  --c-input: #EBEBEB;             /* input background */
  --c-input-border: #DADBDF;      /* input border */
  --c-text-title: #2C3440;        /* primary text */
  --c-text: #797E85;              /* secondary text */
  --c-icon: #A0A3A8;              /* ordinary icons */
  --c-icon-active: #4A4A4A;       /* accent */
}


/* ══════════════════════════
   2. Title bar (shared by every page, blurred by default)
   ══════════════════════════ */
/* .page-header = the whole title bar including the safe area — change background or blur here */
/* .page-header-content = the row holding the buttons and title — change padding or layout here */
.page-header {
  background: color-mix(in srgb, var(--c-header-bg) 75%, transparent);
  backdrop-filter: blur(20px);
  /* to turn the blur off: backdrop-filter: none; background: var(--c-header-bg); */
}

.page-header-content {
  /* padding: 10px 14px; */
  /* gap: 8px; */
}

.page-title,
.page-back-btn {
  color: var(--c-text-title);
}

.page-body {
  background: var(--c-page-body-bg);
}


/* ══════════════════════════
   3. Message list page
   ══════════════════════════ */
.chat-search-bar {
  background: var(--c-input);
  border: 1px solid var(--c-input-border);
  border-radius: 12px;
}

.chat-search-input {
  color: var(--c-text-title);
}

.chat-list-tab {
  color: var(--c-text);
}

.chat-list-tab.active {
  color: var(--c-text-title);
  font-weight: 600;
}

/* The message list is now borderless; adjust the contact and conversation rows here */
.contact-item {
  border-bottom: 0.5px solid var(--c-card-border);
}


/* ══════════════════════════
   4. Contacts page
   ══════════════════════════ */
.chat-contact-name,
.contact-name {
  color: var(--c-text-title);
}

.minimal-avatar-wrapper {
  border-radius: 8px;
}

.contact-letter-header {
  color: var(--c-text);
}


/* ══════════════════════════
   5. Shared interactive elements (buttons, pills, cards)
   ══════════════════════════ */
.ui-btn {
  /* box-shadow: 0 4px 14px ...; */
  /* border-radius: 12px; */
}

/* borderless pill */
.ui-chip {
  /* background: color-mix(in srgb, var(--c-icon) 15%, transparent); */
}

/* bottom tab bar */
.chat-tab-bar {
  background: color-mix(in srgb, var(--c-card) 55%, transparent);
  backdrop-filter: blur(20px) saturate(180%);
  border-top: 0.5px solid var(--c-card-border);
}

.chat-tab {
  color: var(--c-icon);
}

.chat-tab-active {
  color: var(--c-icon-active);
}

.chat-tab svg {
  stroke-width: 1.7;
}

.chat-tab-active svg {
  stroke-width: 1.8;
}


/* ══════════════════════════
   6. Chat rooms (the default style; an individual room's CSS can override it)
   ══════════════════════════ */
.chat-room-wrapper {
  background: var(--c-page-body-bg);
}

/* Change only the chat room's title bar, leaving the message list, contacts and other pages alone */
.chat-room-wrapper .page-header {
  /* background: rgba(0,0,0,0.3); */
  /* backdrop-filter: blur(30px); */
}

/* consecutive messages from the same person: tighten the spacing (optional) */
/*
.chat-msg-wrapper[data-consecutive] {
  margin-top: -12px !important;
}
*/
/* consecutive messages from the same person: hide the avatar (optional) */
/*
.chat-msg-wrapper[data-consecutive] .chat-msg-avatar {
  opacity: 0;
  pointer-events: none;
}
*/

.chat-bubble-role-user {
  background: var(--c-bubble-self);
  border-radius: 6px;
  padding: 10px 14px;
}

.chat-bubble-role-assistant {
  background: var(--c-bubble-other);
  border-radius: 6px;
  padding: 10px 14px;
}

.chat-bubble-media {
  overflow: visible;
}

/* injected system-instruction card */
.chat-system-instruction-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 8px;
  box-shadow: var(--chat-bubble-shadow);
}

.chat-system-instruction-title {
  color: var(--c-text-title);
  font-weight: 600;
}

.chat-system-instruction-body {
  color: var(--c-text);
  text-indent: 2em;
}

.chat-input-bar {
  background: color-mix(in srgb, var(--c-input) 55%, transparent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.chat-offline-toggle.chat-offline-active {
  color: var(--c-text-title);
}

.chat-offline-body {
  padding: 16px 8px 24px;
  gap: 12px;
}

.chat-offline-turn {
  border-radius: 12px;
  background: color-mix(in srgb, var(--c-card) 56%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-card-border) 30%, transparent);
}

.chat-offline-time,
.chat-offline-empty,
.chat-offline-summary-content,
.chat-offline-generating {
  color: var(--c-icon);
}

.chat-offline-label {
  border-radius: 4px;
  font-size: calc(11px*var(--app-text-scale,1));
}

.chat-offline-text {
  color: var(--c-text);
  font-size: calc(14.5px*var(--app-text-scale,1));
  line-height: 1.85;
}

.chat-offline-entry[data-role="assistant"] .chat-offline-text {
  color: var(--c-text-title);
}

.chat-offline-summary-fold {
  background: color-mix(in srgb, var(--c-page-body-bg) 50%, transparent);
  border-radius: 6px;
}


/* ══════════════════════════
   7. Chat card messages
   ══════════════════════════ */
.chat-html-inline,
.chat-music-share-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 14px;
}

.chat-html-inline-frame {
  max-height: min(36vh, 340px);
}

.chat-thought-card .chat-html-inline-frame {
  max-height: min(52vh, 420px);
}

/* gift card */
.chat-gift-card {
  background: #ffffff;
  border: none;
  border-radius: 0;
  overflow: visible;
  /* no shadow wanted? box-shadow: none; */
  box-shadow: 0 1px 4px rgba(0,0,0,0.025);
  margin: 2px 0 4px;
}

.chat-gift-card-body {
  background: #ffffff;
  overflow: visible;
}

.chat-gift-card-status {
  background: rgba(0,0,0,0.055);
  color: var(--c-text-title);
}

.chat-gift-card-title {
  color: var(--c-text-title);
  font-size: calc(24px*var(--app-text-scale,1));
}

.chat-gift-card-divider {
  background: rgba(0,0,0,0.12);
}

.chat-gift-card-footer {
  border-top: 1px solid rgba(0,0,0,0.12);
}

.chat-gift-card-cell-label,
.chat-gift-card-kicker,
.chat-gift-card-label,
.chat-gift-card-brand {
  color: var(--c-icon);
}

.chat-gift-card-cell-value,
.chat-gift-card-source {
  color: var(--c-text);
}

/* text photo card */
.chat-photo-card {
  background: #ffffff;
  border: none;
  border-radius: 0;
  overflow: visible;
  /* no shadow wanted? box-shadow: none; */
  box-shadow: 0 1px 4px rgba(0,0,0,0.025);
  margin: 2px 0 4px;
}

.chat-photo-card-placeholder {
  background: #ffffff;
}

.chat-photo-card-text {
  color: var(--c-text-title);
  font-family: Georgia, "Times New Roman", serif;
  font-size: calc(13px*var(--app-text-scale,1));
  font-style: italic;
  line-height: 1.35;
  text-align: center;
}

.chat-photo-card-image {
  background: #ffffff;
}

/* Real user-uploaded images use the .chat-photo-card--image modifier;
   the container sizes itself to the image, which keeps its aspect ratio uncropped */
.chat-photo-card--image {
  background: transparent;
  box-shadow: none;
}

.chat-photo-card--image .chat-photo-card-image {
  object-fit: contain;
}

/* Xiaohongshu share card */
.chat-xhs-share-card {
  background: #ffffff;
  border: none;
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.02);
}

.chat-xhs-share-title {
  color: var(--c-text-title);
}

.chat-xhs-share-head,
.chat-xhs-share-author,
.chat-xhs-share-desc {
  color: var(--c-text);
}

.chat-xhs-share-mark {
  background: #ff2442;
  color: #ffffff;
}

.chat-xhs-share-cover {
  border-radius: 6px;
}

.chat-xhs-share-tags span {
  color: #ff2442;
  background: #fff0f3;
}

/* payment card (WeChat scan-to-pay, Alipay and the like) */
.scan-pay-card {
  background: var(--c-card);
  border: 1px solid var(--c-card-border);
  border-radius: 14px;
}
.scan-pay-title {
  color: var(--c-text-title);
}
.scan-pay-qr {
  border-radius: 8px;
}
.scan-pay-hint {
  color: var(--c-text);
}
.scan-pay-btn {
  border-radius: 999px;
}
.scan-pay-btn-primary {
  background: #07c160; /* the open-WeChat button (WeChat green by default) */
  color: #ffffff;
}

/* Custom app card (generated by a character via a rich-media directive; black-and-white dossier look) */
/* To change the ink colour throughout, edit --cac-ink alone — headings, figures, black tags and the primary button all follow */
.chat-app-card {
  --cac-ink: #141414;             /* primary ink: headings / figures / black tags / primary button */
  --cac-ink-soft: #3b3b3b;        /* body text and process blocks */
  --cac-ink-mute: #8c8c8c;        /* de-emphasised text: app name, subtitles */
  --cac-line: rgba(0,0,0,0.12);   /* dividers and small tag borders */
  --cac-dash: rgba(0,0,0,0.30);   /* dashed rule between blocks */
  background: #ffffff;            /* card background */
  border-color: rgba(0,0,0,0.06); /* card outline — raise 0.06 to make it crisper */
  /* want rounded corners? add border-radius: 12px; */
}
/* Headings are centred and uppercased by default; uncomment the line below to drop the uppercasing */
.chat-app-card-title {
  /* text-transform: none; */
}
/* To colour just the black tags and the primary button while the body stays ink, change these two */
.chat-app-card-section-title {
  background: var(--cac-ink);
  color: #ffffff;
}
.chat-app-card-actions button:last-child:not([data-style="danger"]) {
  background: var(--cac-ink);
  color: #ffffff;
}


/* ══════════════════════════
   8. Moments page
   ══════════════════════════ */
.chat-app .moments-feed-page > .page-body {
  background: var(--c-page-body-bg);
}

.moments-feed-page:not(.is-scrolled) .page-header {
  background: transparent;
  backdrop-filter: none;
  border-bottom-color: transparent;
}

.feed-cover-shell {
  margin-bottom: 16px;
}

.feed-cover-bg {
  background: var(--c-input);
}

.feed-cover-image {
  object-fit: cover;
}

.feed-profile {
  /* padding-top sets the gap between the avatar and the top of the cover; usually keep room for the title bar safe area */
}

.feed-profile-avatar {
  border-color: var(--c-page-body-bg);
  background: var(--c-input);
}

.feed-profile-name {
  color: var(--c-text-title);
}

.feed-profile-stats,
.feed-profile-signature-text {
  color: var(--c-text);
}

.feed-profile-stat-value {
  color: var(--c-text-title);
}

.feed-notif-banner {
  background: color-mix(in srgb, var(--c-icon-active) 12%, var(--c-card));
  color: var(--c-icon-active);
}

.feed-post {
  background: transparent;
  /* background: var(--c-card); */
  border-color: var(--c-card-border);
}

.feed-post-author-name,
.feed-post-content {
  color: var(--c-text-title);
}

.feed-post-location {
  color: var(--c-icon);
}

.feed-post-like-btn,
.feed-post-comment-btn,
.feed-post-delete-btn {
  color: var(--c-icon-active);
}

.feed-like-summary {
  color: var(--c-text-title);
}

.feed-like-summary-icon {
  color: var(--c-icon);
}

.feed-comments {
  gap: 4px;
}

.feed-comment-avatar-root {
  width: 32px;
  height: 32px;
}

.feed-comment-avatar-child {
  width: 22px;
  height: 22px;
}

.feed-comment-author,
.feed-comment-reply-target {
  color: var(--c-text);
  opacity: 0.7;
}

.feed-comment-body,
.feed-comment-reply-prefix,
.feed-comment-reply-button {
  color: var(--c-text-title);
}

.feed-comment-time {
  color: var(--c-icon);
}

.feed-comment-replies {
  padding-left: 40px;
}

.feed-comment-input {
  background: var(--c-input);
}

.feed-comment-input-field {
  color: var(--c-text);
}

.feed-comment-input-send {
  color: var(--c-icon-active);
}

.feed-inline-translation-toggle {
  color: var(--c-icon-active);
}

.feed-inline-translation {
  color: var(--c-text-title);
}


/* ══════════════════════════
   9. Advanced: custom fonts
   ══════════════════════════ */
/* @import url("https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap"); */
/* .chat-app { font-family: "ZCOOL KuaiLe", sans-serif; } */
`;

export const STORY_CSS_EXAMPLE = `/* ═══ Story mode styling example ═══ */
/* This CSS applies only to the current story session */

/* ══ Colour variables ══ */
:root {
  /* ── Page background ── */
  --c-story-bg-top: #fafafa;         /* gradient, top */
  --c-story-bg-mid: #f5f5f5;         /* gradient, middle */
  --c-story-bg-bottom: #f0f0f0;      /* gradient, bottom */
  --c-story-text: #3a3b3c;           /* body text */
  --c-story-text-light: #64748b;     /* secondary text */
  --c-story-heading: #1e293b;        /* headings */
  --c-story-sub: #94a3b8;            /* supporting text */

  /* ── Bubbles ── */
  --c-story-bubble-bg: rgba(255,255,255,0.8);   /* AI bubble background */
  --c-story-bubble-border: rgba(0,0,0,0.06);    /* AI bubble border */
  --c-story-bubble-user: rgba(0,0,0,0.04);      /* user bubble background */
  --c-story-text-user: #1e293b;                  /* user bubble text */

  /* ── Decoration ── */
  --c-story-ornament: rgba(148,163,184,0.15);    /* decorative elements */
  --c-story-ornament-soft: rgba(148,163,184,0.08);
  --c-story-accent: #64748b;                     /* accent */
  --c-story-accent-light: #e2e8f0;               /* light accent */

  /* ── Input area ── */
  --c-story-input-bar: rgba(255,255,255,0.9);    /* input bar background */
  --c-story-input-bar-focus: rgba(255,255,255,0.95);
  --c-story-input-border: rgba(0,0,0,0.08);      /* input bar outer edge */
  --c-story-input-inner: rgba(248,250,252,0.78); /* inner text field */
  --c-story-input-inner-focus: rgba(248,250,252,0.94);
  --c-story-send-bg-active: #0f172a;              /* send button, active */
  --c-story-send-color: #64748b;                  /* send button colour */

  /* ── Buttons and panels ── */
  --c-story-btn-bg: rgba(255,255,255,0.5);       /* button background */
  --c-story-btn-border: rgba(0,0,0,0.08);        /* button border */
  --c-story-panel: rgba(248,250,252,0.95);        /* panel background */
  --c-story-panel-active: rgba(241,245,249,0.8);
  --c-story-panel-border: rgba(0,0,0,0.06);

  /* ── Drawer and sidebar ── */
  --c-story-drawer-top: #f8fafc;                  /* drawer, top */
  --c-story-drawer-bottom: #f1f5f9;               /* drawer, bottom */
  --c-story-drawer-border: rgba(0,0,0,0.06);

  /* ── Code blocks ── */
  --c-story-code-bg: rgba(248,250,252,0.8);
  --c-story-code-color: #334155;

  /* ── Other ── */
  --c-story-fold-bg: rgba(248,250,252,0.6);       /* folded block background */
  --c-story-meta-bg: rgba(255,255,255,0.8);       /* metadata card background */
  --c-story-meta-border: rgba(0,0,0,0.06);
  --c-story-cover-bg: #f1f5f9;                    /* cover background */
  --c-story-cover-border: #fff;                   /* cover border */
  --c-story-placeholder: #94a3b8;                 /* placeholder colour */
  --c-story-quote: #475569;                       /* quote colour */
  --c-story-quote-bg: rgba(248,250,252,0.5);      /* quote background */
  --c-story-table-header-bg: rgba(248,250,252,0.8); /* table header background */
  --c-story-bold-highlight: rgba(148,163,184,0.2);  /* bold underline highlight */
  --c-story-overlay: rgba(0,0,0,0.2);             /* overlay */
  --c-story-css-box-bg: rgba(248,250,252,0.6);    /* CSS editor background */
  --story-font: serif;                            /* story font */
}

/* ══ The page overall ══ */
.story-app-shell {
  /* background: linear-gradient(160deg, var(--c-story-bg-top), var(--c-story-bg-mid), var(--c-story-bg-bottom)); */
  /* color: var(--c-story-text); */
}
.story-app-shell::before,
.story-app-shell::after {
  /* decorative halo */
  /* background: radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%); */
}

/* ══ Top title bar ══ */
/* .story-header = the whole title bar including the safe area — change the background here */
/* .story-header-content = the row holding the buttons and title — change padding or layout here */
.story-header {
  /* background: linear-gradient(180deg, var(--c-story-bg-top) 60%, transparent); */
}
.story-header-content {
  /* padding: 0 20px 14px; */
}
.story-header-center {
  /* color: var(--c-story-sub); */
  /* font-size: calc(12px*var(--app-text-scale,1)); */
}
.story-top-btn {
  /* border: 1px solid var(--c-story-btn-border); */
  /* background: var(--c-story-btn-bg); */
  /* color: var(--c-story-text); */
  /* border-radius: 10px; */
}

/* ══ Optional: floating transparent title bar template ══ */
/* To use it, uncomment the whole block below. Do not override .story-app-shell's position. */
/*
:root {
  --story-floating-header-height: 102px;
}

.story-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  width: auto;
  min-height: var(--story-floating-header-height);
  padding: 52px 20px 14px;
  box-sizing: border-box;
  z-index: 100;

  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;

  background: rgba(255,255,255,0.45);
  -webkit-backdrop-filter: blur(16px) saturate(120%);
  backdrop-filter: blur(16px) saturate(120%);
  border-bottom: 1px solid rgba(255,255,255,0.35);
}

.story-header-left {
  justify-content: flex-start;
}

.story-header-right {
  justify-content: flex-end;
  gap: 8px;
}

.story-stage {
  padding-top: calc(var(--story-floating-header-height) + 12px);
}

.story-row:first-of-type {
  margin-top: 0;
}
*/

/* ══ Message rows ══ */
.story-row {
  /* padding: 4px 16px; */
}
.story-row[data-role="assistant"] .story-bubble {
  /* background: var(--c-story-bubble-bg); */
  /* border: 1px solid var(--c-story-bubble-border); */
  /* border-radius: 12px; */
}
.story-row[data-role="user"] .story-bubble {
  /* background: var(--c-story-bubble-user); */
  /* border-radius: 12px; */
  /* color: var(--c-story-text-user); */
}

/* ══ Bubble header (character name + time) ══ */
.story-bubble-head {
  /* font-size: calc(11px*var(--app-text-scale,1)); */
  /* color: var(--c-story-sub); */
}

/* ══ Avatars ══ */
.story-avatar-wrap {
  /* width: 36px; height: 36px; */
  /* border-radius: 50%; */
}

/* ══ Rich text content ══ */
.story-richtext {
  /* font-family: var(--story-font); */
  /* font-size: calc(15px*var(--app-text-scale,1)); */
  /* line-height: 1.8; */
  /* color: var(--c-story-text); */
}
.story-richtext strong {
  /* color: var(--c-story-heading); */
  /* background: linear-gradient(transparent 65%, var(--c-story-ornament) 65%); */
}
.story-richtext em, .story-richtext i {
  /* font-family: var(--story-font); */
  /* color: var(--c-story-text-light); */
}
.story-richtext blockquote {
  /* border-left: 2px solid var(--c-story-accent-light); */
  /* color: var(--c-story-quote); */
  /* font-family: var(--story-font); */
}
.story-richtext :is(h1,h2,h3,h4) {
  /* font-family: var(--story-font); */
  /* color: var(--c-story-heading); */
}
.story-richtext h2 {
  /* text-align: center; */  /* centre chapter headings */
}
.story-richtext hr {
  /* border-color: var(--c-story-ornament); */
}
.story-richtext code {
  /* background: var(--c-story-code-bg); */
  /* color: var(--c-story-code-color); */
}
.story-richtext pre {
  /* background: var(--c-story-code-bg); */
  /* border-radius: 8px; */
}
.story-richtext img {
  /* border-radius: 8px; */
  /* max-width: 100%; */
}
.story-richtext table {
  /* border-color: var(--c-story-ornament); */
}

/* ══ Folded blocks (thinking / summary) ══ */
.story-fold-block {
  /* background: var(--c-story-fold-bg); */
  /* border-radius: 8px; */
}
.story-summary-fold {
  /* background: var(--c-story-fold-bg); */
  /* border-radius: 8px; */
}

/* ══ Bottom input area: outer frame + inner field + send button ══ */
.story-composer {
  /* background: var(--c-story-input-bar); */       /* outer frame background */
  /* border-color: var(--c-story-input-border); */  /* outer frame edge */
  /* border-radius: 18px; */
  /* padding: 6px; */
  /* box-shadow: 0 3px 8px rgba(0,0,0,0.02); */
}
.story-composer textarea {
  /* background: var(--c-story-input-inner); */      /* inner text field background */
  /* color: var(--c-story-text); */
  /* border-radius: 13px; */
  /* box-shadow: none; */
}
.story-composer:focus-within textarea {
  /* background: var(--c-story-input-inner-focus); */
}
.story-send-btn {
  /* background: linear-gradient(145deg, color-mix(in srgb, var(--c-story-send-bg-active) 88%, #64748b), var(--c-story-send-bg-active)); */
  /* color: var(--c-story-send-color); */
  /* border-radius: 12px; */
}

/* ══ Side drawer (character picker / settings) ══ */
.story-drawer {
  /* background: linear-gradient(var(--c-story-drawer-top), var(--c-story-drawer-bottom)); */
}
.story-drawer-overlay {
  /* background: rgba(0,0,0,0.3); */
}
.story-drawer-section {
  /* border-bottom: 1px solid var(--c-story-drawer-border); */
}
.story-drawer-eyebrow {
  /* color: var(--c-story-sub); */
  /* font-size: calc(11px*var(--app-text-scale,1)); */
}
.story-character-chip {
  /* border-radius: 10px; */
  /* background: var(--c-story-panel); */
}

/* ══ Metadata card (cover / blurb) ══ */
.story-meta {
  /* background: var(--c-story-meta-bg); */
  /* border: 1px solid var(--c-story-meta-border); */
  /* border-radius: 16px; */
}
.story-meta-title {
  /* font-family: var(--story-font); */
  /* color: var(--c-story-heading); */
}
.story-meta-desc {
  /* font-family: var(--story-font); */
  /* color: var(--c-story-text-light); */
}
.story-meta-cover {
  /* background: var(--c-story-cover-bg); */
  /* border-radius: 12px; */
}
.story-meta-tags {
  /* gap: 6px; */
}

/* ══ Empty states ══ */
.story-empty {
  /* color: var(--c-story-placeholder); */
}

/* ══ Context menu ══ */
.story-ctx-menu {
  /* background: var(--c-story-panel); */
  /* border-radius: 10px; */
}
.story-ctx-btn {
  /* color: var(--c-story-text); */
}
.story-ctx-btn-danger {
  /* color: var(--c-danger); */
}

/* ══ Inline editing ══ */
.story-inline-edit {
  /* background: var(--c-story-input-bar); */
  /* border-radius: 8px; */
}
.story-inline-edit-btn-save {
  /* background: var(--c-story-send-bg-active); */
  /* color: white; */
}

/* ══ Settings rows ══ */
.story-pref-row {
  /* padding: 10px 0; */
}

/* ══ CSS editor ══ */
.story-css-box {
  /* font-family: monospace; */
  /* background: var(--c-story-code-bg); */
}
`;


export const VN_CSS_EXAMPLE = `/* ═══ Visual novel styling example ═══ */
/* Every colour is a variable, so changing a variable recolours everything */
/* The variables are defined on [data-vn-theme]; just override them here */

/* ══ All colour variables (overriding the current theme) ══ */
[data-vn-theme] {
  /* ── Page ── */
  /* --vn-bg: #08060e; */                          /* page background */
  /* --vn-font: "PingFang SC", system-ui; */       /* font */

  /* ── Dialogue box ── */
  /* --vn-box-bg: rgba(10, 8, 20, 0.75); */       /* dialogue box background */
  /* --vn-box-border: rgba(255, 255, 255, 0.15); */ /* dialogue box border */
  /* --vn-box-radius: 2px; */                      /* dialogue box corner radius */
  /* --vn-box-glow: 0 0 20px rgba(180,160,220,0.1); */ /* dialogue box glow */

  /* ── Name plate ── */
  /* --vn-name-bg: rgba(10, 8, 20, 0.75); */      /* name plate background */
  /* --vn-name-color: #ddd6e8; */                  /* name plate text */
  /* --vn-name-border: rgba(255, 255, 255, 0.1); */ /* name plate border */

  /* ── Dialogue text ── */
  /* --vn-text-color: rgba(255, 255, 255, 0.9); */ /* dialogue text */
  /* --vn-text-shadow: 0 1px 3px rgba(0,0,0,0.5); */ /* text shadow */
  /* --vn-text-size: 15px; */                      /* dialogue font size */
  /* --vn-narration-color: rgba(200,190,220,0.8); */ /* narration colour */

  /* ── Control buttons ── */
  /* --vn-control-bg: rgba(0, 0, 0, 0.3); */      /* button background */
  /* --vn-control-color: rgba(255,255,255,0.6); */ /* button icon */
  /* --vn-control-active: rgba(255,255,255,0.9); */ /* button, active */

  /* ── UI panels and dialogs ── */
  /* --vn-ui-panel: rgba(10, 8, 20, 0.88); */     /* panel background */
  /* --vn-ui-border: rgba(255,255,255,0.08); */    /* border */
  /* --vn-ui-text: rgba(255,255,255,0.65); */      /* primary text */
  /* --vn-ui-text-dim: rgba(255,255,255,0.3); */   /* secondary text */
  /* --vn-ui-text-bright: rgba(255,255,255,0.85); */ /* highlighted text */
  /* --vn-ui-accent: rgba(180,165,220,0.85); */    /* accent */
  /* --vn-ui-accent-dim: rgba(180,165,220,0.25); */ /* faint accent */
  /* --vn-ui-accent-bg: rgba(180,165,220,0.06); */ /* accent background */
  /* --vn-ui-input: rgba(255,255,255,0.04); */     /* input background */
  /* --vn-ui-input-border: rgba(255,255,255,0.1); */ /* input border */
  /* --vn-ui-input-text: rgba(255,255,255,0.8); */ /* input text */
  /* --vn-ui-overlay: rgba(0, 0, 0, 0.35); */     /* overlay */
  /* --vn-ui-danger: rgba(220,90,75,0.8); */       /* danger colour */
  /* --vn-ui-success: rgba(90,180,130,0.7); */     /* success colour */

  /* ── Tags ── */
  /* --vn-tag-dialogue: rgba(130,190,160,0.65); */ /* dialogue tag */
  /* --vn-tag-narration: rgba(180,165,220,0.65); */ /* narration tag */
  /* --vn-tag-scene: rgba(150,175,210,0.65); */    /* scene tag */

  /* ── Sliders ── */
  /* --vn-slider-track: rgba(255,255,255,0.12); */ /* slider track */
  /* --vn-slider-thumb: rgba(180,165,220,0.85); */ /* slider thumb */
}

/* ══ Dialogue box ══ */
.vn-dialogue-inner {
  /* background: var(--vn-box-bg); */
  /* border: 1px solid var(--vn-box-border); */
  /* border-radius: var(--vn-box-radius); */
  /* backdrop-filter: blur(10px); */
}

/* ══ Name plate ══ */
.vn-name {
  /* background: var(--vn-name-bg); */
  /* color: var(--vn-name-color); */
  /* letter-spacing: 0.1em; */
}

/* ══ Dialogue text ══ */
.vn-text {
  /* font-size: var(--vn-text-size); */
  /* color: var(--vn-text-color); */
  /* line-height: 1.9; */
}
.vn-text-narration {
  /* color: var(--vn-narration-color); */
}

/* ══ Control buttons ══ */
.vn-ctrl-btn {
  /* background: var(--vn-control-bg); */
  /* color: var(--vn-control-color); */
}
.vn-topbar-btn {
  /* color: var(--vn-control-color); */
}

/* ══ Input area ══ */
.vn-input-field {
  /* background: var(--vn-ui-input); */
  /* border: 1px solid var(--vn-ui-input-border); */
  /* color: var(--vn-ui-input-text); */
}
.vn-send-btn {
  /* background: var(--vn-ui-input-border); */
  /* color: var(--vn-ui-text); */
}
.vn-mode-btn {
  /* border: 1px solid var(--vn-ui-input-border); */
  /* color: var(--vn-ui-text-dim); */
}

/* ══ Choices ══ */
.vn-option-btn {
  /* border: 1px solid var(--vn-ui-input-border); */
  /* background: var(--vn-ui-input); */
  /* color: var(--vn-text-color); */
}

/* ══ Panels (history / beats / scenes) ══ */
.vn-history-panel,
.vn-beats-panel,
.vn-scene-picker {
  /* background: var(--vn-ui-panel); */
  /* border-left: 1px solid var(--vn-ui-border); */
}
.vn-history-speaker { /* color: var(--vn-ui-accent); */ }
.vn-history-text { /* color: var(--vn-ui-text); */ }

/* ══ Story beats ══ */
.vn-beat-item {
  /* border: 1px solid var(--vn-ui-input); */
}
.vn-beat-item[data-active="true"] {
  /* border-color: var(--vn-ui-accent-dim); */
  /* background: var(--vn-ui-accent-bg); */
}
.vn-beat-name { /* color: var(--vn-ui-text); */ }

/* ══ Context menu ══ */
.vn-ctx-menu {
  /* background: var(--vn-ui-panel); */
}
.vn-ctx-btn { /* color: var(--vn-ui-text); */ }
.vn-ctx-btn-danger { /* color: var(--vn-ui-danger); */ }

/* ══ Ending screen ══ */
.vn-end {
  /* background: var(--vn-ui-overlay); */
}
.vn-end-text { /* color: var(--vn-ui-text-dim); */ }
.vn-end-btn {
  /* border: 1px solid var(--vn-ui-border); */
  /* color: var(--vn-ui-text); */
}

/* ══ Sliders (in the layout panel) ══ */
.vn-shell .ui-slider {
  /* background: var(--vn-slider-track); */
}
.vn-shell .ui-slider::-webkit-slider-thumb {
  /* background: var(--vn-slider-thumb); */
}
.vn-shell .ui-slider-label {
  /* color: var(--vn-ui-text); */
}
.vn-shell .ui-slider-value {
  /* color: var(--vn-ui-text-dim); */
}

/* ═══════════════════════════════
   Character select page (.vns-*)
   ═══════════════════════════════ */

/* ══ Character select page overall ══ */
.vns-shell {
  /* background: var(--vn-bg); */
}

/* ══ Top bar ══ */
.vns-topbar {
  /* padding: 52px 16px 12px; */
}
.vns-back {
  /* color: var(--vn-control-color); */
}
.vns-title {
  /* color: var(--vn-ui-text-dim); */
  /* letter-spacing: 0.25em; */
}

/* ══ Character card strip ══ */
.vns-strips {
  /* gap: 4px; */
  /* padding: 80px 16px 20px; */
}
.vns-strip {
  /* width: 72px; */
  /* height: 55%; */
  /* border: 1px solid var(--vn-ui-border); */
}
.vns-strip[data-active="true"] {
  /* width: min(220px, 50vw); */
  /* border-color: var(--vn-ui-accent-dim); */
  /* box-shadow: 0 0 20px var(--vn-ui-accent-bg); */
}

/* ══ Character card background filter ══ */
.vns-strip:not([data-active="true"]) .vns-strip-bg {
  /* filter: brightness(0.4) saturate(0.6); */  /* dark theme */
  /* filter: brightness(0.85) saturate(0.8); */ /* light theme */
}
.vns-strip[data-active="true"] .vns-strip-bg {
  /* filter: brightness(0.7) saturate(0.9); */  /* dark theme */
  /* filter: brightness(1) saturate(1); */      /* light theme */
}

/* ══ Character name and subtitle ══ */
.vns-strip-name {
  /* color: rgba(255,255,255,0.9); */
  /* font-size: calc(16px*var(--app-text-scale,1)); */
}
.vns-strip-sub {
  /* color: rgba(255,255,255,0.45); */
}

/* ══ Enter button ══ */
.vns-enter {
  /* border: 1px solid var(--vn-ui-accent-dim); */
  /* background: var(--vn-ui-accent-bg); */
  /* color: var(--vn-ui-text-bright); */
  /* border-radius: 24px; */
}

/* ══ Empty states ══ */
.vns-empty {
  /* color: var(--vn-ui-text-dim); */
}

/* ══ Decorative halo ══ */
.vns-shell::before,
.vns-shell::after {
  /* opacity: 0; */  /* hide the decoration */
}

/* ═══════════════════════════════
   Star chart page (.vnc-*)
   ═══════════════════════════════ */

/* ══ Star chart page overall ══ */
.vnc-shell {
  /* background: var(--vn-bg); */
}

/* ══ Top bar ══ */
.vnc-btn {
  /* color: var(--vn-control-color); */
}
.vnc-char-name {
  /* color: var(--vn-ui-text); */
  /* letter-spacing: 0.12em; */
}
.vnc-char-sub {
  /* color: var(--vn-ui-text-dim); */
}

/* ══ Star chart paths ══ */
.vnc-path {
  /* stroke: var(--vn-ui-accent-dim); */
}
.vnc-path-glow {
  /* stroke: var(--vn-ui-border); */
}

/* ══ Star nodes ══ */
.vnc-star-ring {
  /* border: 1px solid var(--vn-ui-border); */
}
.vnc-star-ray {
  /* background: linear-gradient(90deg, transparent, var(--vn-ui-accent-dim), transparent); */
}

/* ══ Chapter titles ══ */
.vnc-chapter-title {
  /* color: var(--vn-ui-text-bright); */
  /* letter-spacing: 0.1em; */
}
.vnc-chapter-sub {
  /* color: var(--vn-ui-text-dim); */
}

/* ══ Action buttons (play / archive) ══ */
.vnc-action-btn {
  /* border: 1px solid var(--vn-ui-border); */
  /* background: var(--vn-ui-input); */
  /* color: var(--vn-ui-text-dim); */
}

/* ══ New chapter ══ */
.vnc-new {
  /* color: var(--vn-ui-text-dim); */
}
.vnc-new-dot {
  /* border: 1px dashed var(--vn-ui-border); */
}

/* ══ Star chart decoration (particles and nebulae) ══ */
.vnc-shell::before,
.vnc-shell::after {
  /* opacity: 0; */  /* hide the starfield decoration */
}
`;

export const CALENDAR_CSS_EXAMPLE = `/* ══════════════════════════════════════════
   Calendar page custom styling — Night Sky theme
   Changes take effect as soon as you hit Save
   Clear everything and save to go back to the default
   ══════════════════════════════════════════ */

/* ━━ All colour variables ━━ */
.calendar-app-shell {
  /* the three background gradient stops */
  --c-calendar-bg-top: #0f0e1a;
  --c-calendar-bg-mid: #151228;
  --c-calendar-bg-bottom: #1a1530;
  /* decorative glow orbs */
  --c-calendar-orb-1: rgba(100, 60, 220, 0.5);
  --c-calendar-orb-2: rgba(220, 80, 160, 0.4);
  /* text */
  --c-calendar-text: #f0ecfa;
  --c-calendar-sub: #bdb2da;
  /* accent */
  --c-calendar-accent: #a78bfa;
  --c-calendar-accent-dim: rgba(167, 139, 250, 0.2);
  /* weekend colour */
  --c-calendar-weekend: #f472b6;
  /* buttons and actions */
  --c-calendar-action: #818cf8;
  /* dialog background gradient */
  --c-calendar-modal-pink: rgba(80, 50, 140, 0.4);
  --c-calendar-modal-blue: rgba(40, 30, 100, 0.4);
  /* panel background and border */
  /* glass layers (opacity steps) */
  --c-calendar-glass-1: rgba(255, 255, 255, 0.04);
  --c-calendar-glass-3: rgba(255, 255, 255, 0.06);
  --c-calendar-glass-4: rgba(255, 255, 255, 0.08);
  --c-calendar-glass-5: rgba(255, 255, 255, 0.1);
  --c-calendar-glass-55: rgba(255, 255, 255, 0.12);
  --c-calendar-glass-6: rgba(255, 255, 255, 0.14);
  --c-calendar-glass-7: rgba(255, 255, 255, 0.18);
  --c-calendar-glass-8: rgba(255, 255, 255, 0.22);
  --c-calendar-glass-85: rgba(255, 255, 255, 0.85);
  --c-calendar-glass-9: rgba(255, 255, 255, 0.9);
  --c-calendar-glass-full: #fff;
  /* shadows */
  --c-calendar-shadow-2: rgba(0, 0, 0, 0.08);
  --c-calendar-shadow-3: rgba(0, 0, 0, 0.12);
  --c-calendar-shadow-4: rgba(0, 0, 0, 0.15);
  --c-calendar-shadow-6: rgba(0, 0, 0, 0.2);
  --c-calendar-shadow-10: rgba(0, 0, 0, 0.3);
  --c-calendar-shadow-15: rgba(0, 0, 0, 0.4);
  /* overlay */
  /* schedule event palette */
  --c-calendar-event-blue: #818cf8;
  --c-calendar-event-green: #34d399;
  --c-calendar-event-amber: #fbbf24;
  --c-calendar-event-rose: #fb7185;
  --c-calendar-event-violet: #a78bfa;
  --c-calendar-event-teal: #2dd4bf;
  --c-calendar-event-slate: #94a3b8;
  --c-calendar-event-purple: #c084fc;
}

/* ━━ The page overall ━━ */
.calendar-app {
  /* swap the whole background here */
  /* background: linear-gradient(180deg, #0f0e1a, #1a1530); */
}

/* ━━ Top navigation bar ━━ */
.calendar-header {
  /* backdrop-filter: blur(20px); */
}
.calendar-header-eyebrow {
  /* letter-spacing: 2px; */
}
.calendar-header-action {
  /* opacity: 0.8; */
}

/* ━━ Character / user switcher ━━ */
.calendar-owner-strip {
  /* gap: 8px; */
}
.calendar-owner-chip {
  border-radius: 20px;
  /* box-shadow: 0 2px 12px rgba(167, 139, 250, 0.2); */
}

/* ━━ Weekday header row ━━ */
.calendar-week-header {
  /* padding: 12px 16px; */
}
.calendar-week-title {
  /* font-size: calc(15px*var(--app-text-scale,1)); */
}

/* ━━ Month grid ━━ */
.calendar-grid-shell {
  border-radius: 18px;
  /* box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); */
}
.calendar-grid-card {
  border-radius: 10px;
}
.calendar-grid-counter {
  /* font-size: calc(10px*var(--app-text-scale,1)); */
}

/* ━━ Schedule timeline ━━ */
.calendar-day-columns {
  /* gap: 2px; */
}
.calendar-day-column {
  /* min-width: 0; */
}
.calendar-event-block {
  border-radius: 8px;
  /* box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); */
}

/* ━━ Combined view ━━ */
.calendar-unified-grid {
  /* border-radius: 16px; */
}
.calendar-unified-row {
  /* padding: 8px 12px; */
}
.calendar-unified-cell {
  border-radius: 8px;
}

/* ━━ Hero card ━━ */
.calendar-hero {
  border-radius: 20px;
  /* box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3); */
}
.calendar-hero-kicker {
  /* font-size: calc(11px*var(--app-text-scale,1)); */
}
.calendar-hero-stat {
  color: #fff;
}
.calendar-hero-stat strong {
  background: linear-gradient(135deg, #c4b5fd, #f9a8d4);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

/* ━━ Settings card ━━ */
.calendar-setting-card {
  border-radius: 16px;
}
.calendar-setting-row {
  /* padding: 12px 16px; */
}

/* ━━ Floating button ━━ */
.calendar-fab {
  /* box-shadow: 0 4px 16px rgba(167, 139, 250, 0.3); */
}
.calendar-fab-primary {
  /* background: var(--c-calendar-action); */
}
.calendar-fab-secondary {
  /* opacity: 0.9; */
}

/* ━━ Edit dialog ━━ */
.calendar-edit-modal {
  border-radius: 24px;
  /* backdrop-filter: blur(5px) saturate(140%); */
}

/* ━━ Confirm dialog ━━ */
.calendar-confirm-dialog {
  /* max-width: 280px; */
}
.calendar-confirm-icon {
  /* opacity: 0.9; */
}
.calendar-confirm-title {
  /* font-size: calc(15px*var(--app-text-scale,1)); */
}`;

export const MUSIC_CSS_EXAMPLE = `/* ══════════════════════════════════════════
   Music page custom styling — Aurora Purple Night theme
   (for the new Lumen interface)
   Changes take effect as soon as you hit Save
   Clear everything and save to go back to the default
   ══════════════════════════════════════════ */

/* ━━ All colour variables ━━
   Note: the desktop floating bubble (.music-float) and the chat mini-window
   (.mini-app-window) keep their own light palette and ignore these variables */
.music-app,
.music-player {
  /* Page base colour */
  --c-music-bg: #0c0a1a;
  /* Background gradient · 5 layers */
  --c-music-bg-mint: rgba(100, 60, 220, 0.35);
  --c-music-bg-cream: rgba(180, 80, 200, 0.2);
  --c-music-bg-lime: rgba(60, 120, 255, 0.2);
  --c-music-bg-mint-dim: rgba(80, 40, 180, 0.25);
  --c-music-bg-center: rgba(60, 40, 200, 0.3);
  /* Full-screen player background glow */
  --c-music-bg-glow: rgba(140, 80, 255, 0.15);
  --c-music-bg-mist: rgba(80, 40, 160, 0.15);
  /* Glass panel / border / opaque dialog / very faint accents */
  --c-music-surface: rgba(255, 255, 255, 0.06);
  --c-music-surface-solid: rgba(255, 255, 255, 0.12);
  --c-music-panel: rgba(26, 20, 46, 0.96);
  --c-music-glass-dim: rgba(255, 255, 255, 0.06);
  /* Text / secondary text / pure white */
  --c-music-white: #ffffff;
  --c-music-text: #e0d8f0;
  --c-music-accent: #b49de8;
  --c-music-accent-dim: rgba(180, 157, 232, 0.12);
  /* Primary accent (like heart / play all / chart numbers) */
  --c-music-primary: #c86bff;
  --c-music-primary-dim: rgba(200, 107, 255, 0.14);
  /* Glowing-lyric moonlight / halo / overlay / like heart */
  --c-music-glowtext: #ead8ff;
  --c-music-gold: rgba(210, 170, 255, 0.4);
  --c-music-overlay: rgba(0, 0, 0, 0.5);
  --c-music-liked: #ff5c8a;
}

/* ━━ Page shell ━━ */
.music-app {
  /* Tip: prefer Settings -> App page background for a background image;
     you can also force one here: */
  /* background-image: linear-gradient(135deg, #0c0a1a, #1a1030) !important; */
}

/* ━━ Bottom area (tab bar + play bar are one sheet of glass) ━━ */
.music-bottom-dock {
  background: rgba(16, 10, 30, 0.45);
  backdrop-filter: blur(28px) saturate(160%);
}
.music-tabbar-item {
  font-size: calc(9.9px*var(--app-text-scale,1));
}
.music-tabbar-item[data-active] svg {
  /* Glow colour of the selected tab icon */
  color: var(--c-music-primary);
  filter: drop-shadow(0 0 6px rgba(200, 107, 255, 0.5));
}
.music-now-bar-title {
  font-size: calc(11.7px*var(--app-text-scale,1));
}
/* Bird decorations */
.music-bird {
  /* opacity: 0; */ /* hide the birds */
  /* filter: hue-rotate(180deg); */ /* recolour */
}

/* ━━ Home ━━ */
.music-greet-hello {
  font-size: calc(19.8px*var(--app-text-scale,1));
  letter-spacing: 0.02em;
}
.music-search-pill {
  border-radius: 12px;
}
.music-daily-card {
  border-radius: 18px;
  /* height: 128px; */
}
.music-daily-title {
  font-size: calc(16.2px*var(--app-text-scale,1));
}
.music-rail-cover {
  border-radius: 14px;
}
.music-rail-count {
  /* Play-count badge */
  background: rgba(20, 8, 40, 0.5);
}
.music-chart-card {
  border-radius: 16px;
  background: var(--c-music-surface);
  border: 1px solid var(--c-music-surface-solid);
}
.music-chart-track em {
  /* Colour of the top three chart numbers */
  color: var(--c-music-primary);
}
.music-hot-rank[data-top] {
  color: var(--c-music-primary);
}

/* ━━ Track list (flat rows) ━━ */
.music-song {
  border-radius: 14px;
  padding: 10px 10px;
}
.music-song-title {
  font-size: calc(13.5px*var(--app-text-scale,1));
  letter-spacing: 0.3px;
}
.music-song-artist {
  font-size: calc(11px*var(--app-text-scale,1));
}
/* Currently playing row */
.music-song[data-playing] {
  background: var(--c-music-primary-dim);
}
.music-song[data-playing] .music-song-title {
  color: var(--c-music-primary);
}

/* ━━ Playlist detail ━━ */
.music-pl-hero-cover {
  border-radius: 16px;
}
.music-pl-hero-name {
  font-size: calc(14.4px*var(--app-text-scale,1));
}
.music-pl-hero-tags span {
  /* Tag pills */
}
.music-playlist-play-all {
  /* Play-all button gradient */
  background: linear-gradient(120deg, #a44bff, #ff5cd0);
  box-shadow: 0 8px 20px rgba(180, 80, 255, 0.3);
}
.music-pl-chip {
  /* Save pill */
  border-radius: 999px;
}

/* ━━ Full-screen player (modern cover mode) ━━ */
/* Colour blobs sampled from the cover: override to pin a fixed colour */
.mp-blob-1 { /* background: rgba(140, 80, 255, 0.5) !important; */ }
.mp-blob-2 { /* background: rgba(255, 92, 208, 0.35) !important; */ }
.mp-blob-3 { /* background: rgba(60, 120, 255, 0.3) !important; */ }
.mp-cover {
  border-radius: 24px;
  /* max-width: 276px; */
}
.mp-song {
  font-size: calc(17px*var(--app-text-scale,1));
}
.mp-lyric-peek {
  /* Lyric preview row at the bottom of cover mode */
}

/* ━━ Glowing lyrics ━━ */
.mp-lyric-line {
  font-size: calc(15.3px*var(--app-text-scale,1));
  letter-spacing: 0.08em;
}
.mp-lyric-line[data-active] {
  font-size: calc(18.9px*var(--app-text-scale,1));
  /* Glow colour (three halo layers) */
  text-shadow:
    0 0 10px rgba(240, 220, 255, 0.9),
    0 0 30px rgba(200, 140, 255, 0.6),
    0 0 66px rgba(160, 80, 255, 0.35);
}

/* ━━ Waveform progress bar ━━ */
.mp-wave i {
  /* Unplayed waveform */
  background: rgba(200, 170, 255, 0.18);
}
.mp-wave i[data-lit] {
  /* Played waveform */
  background: rgba(240, 220, 255, 0.85);
  box-shadow: 0 0 6px rgba(220, 180, 255, 0.7);
}
.mp-wave i[data-head] {
  /* Playhead */
  box-shadow: 0 0 10px rgba(240, 220, 255, 0.95), 0 0 20px rgba(200, 120, 255, 0.7);
}

/* ━━ Playback controls ━━ */
.mp-ctrl-play {
  width: 64px;
  height: 64px;
  /* background: #fff; color: #1a1030; */
  box-shadow: 0 10px 30px rgba(200, 140, 255, 0.2);
}
.mp-social-btn {
  /* Like / share pills */
  border-radius: 999px;
}
.mp-social-btn[data-liked] {
  color: var(--c-music-liked);
}

/* ━━ Vinyl mode (toggled by the disc button, top right) ━━ */
.music-player-vinyl {
  /* width: 240px; height: 240px; */
}
.music-player-vinyl-glow {
  /* Halo behind the record */
  background: radial-gradient(circle,
    rgba(180, 120, 255, 0.35) 0%, transparent 60%);
}
.music-player-tonearm {
  /* transform: rotate(-25deg); */ /* resting angle */
}

/* ━━ Artist page ━━ */
.mart-name {
  font-size: calc(21.6px*var(--app-text-scale,1));
}
.mart-song-idx[data-top] {
  color: var(--c-music-primary);
}

/* ━━ Mine · weekly report card ━━ */
.music-week-card {
  border-radius: 18px;
  /* background: linear-gradient(140deg, #241a3d, #16102a 70%); */
}
.music-week-bar i {
  /* Bar chart colour */
  background: linear-gradient(180deg, rgba(230, 210, 255, 0.9), rgba(180, 130, 255, 0.45));
}

/* ━━ Search ━━ */
.music-search-bar {
  border-radius: 20px;
}
.music-search-input {
  font-size: calc(14px*var(--app-text-scale,1));
}

/* ━━ Empty states / floating button ━━ */
.music-empty {
  opacity: 0.4;
}
.music-fab-add {
  border-radius: 50%;
  box-shadow: 0 4px 20px rgba(140, 80, 255, 0.3);
}

/* ━━ Dialogs / drawers (base colour comes from --c-music-panel) ━━ */
.music-settings-modal-dialog {
  border-radius: 24px;
}
.music-playlist-picker {
  /* border-radius: 20px 20px 0 0; */
}
.music-queue-drawer {
  /* width: 75%; */
}
.music-queue-item[data-current] {
  /* background: var(--c-music-accent-dim); */
}
`;

export const GLOBAL_CSS_EXAMPLE = `/* === Global CSS selector examples === */
/* This lists only the globally stable selectors. It avoids app-specific class names and does not rely on global variables. */
/* Uncomment the properties you want, then hit Apply. Global CSS affects every page, so keep your selectors as narrow as you can. */

/* === Page structure === */
[data-ui="phone-screen"] {
  /* background: #f7f7f8; */
  /* color: #222222; */
}

[data-ui="header"] {
  /* background: rgba(255, 255, 255, 0.86); */
  /* backdrop-filter: blur(18px); */
  /* -webkit-backdrop-filter: blur(18px); */
  /* border-bottom: 1px solid rgba(0, 0, 0, 0.08); */
}

[data-ui="body"] {
  /* background: #f5f5f6; */
  /* padding-left: 14px; */
  /* padding-right: 14px; */
}

[data-ui="nav"] {
  /* background: rgba(255, 255, 255, 0.82); */
  /* backdrop-filter: blur(18px); */
  /* -webkit-backdrop-filter: blur(18px); */
}

[data-ui="input"] {
  /* background: rgba(255, 255, 255, 0.9); */
  /* border-top: 1px solid rgba(0, 0, 0, 0.08); */
}

/* === Shared page shell === */
.page-shell {
  /* background: #f5f5f6; */
}

.page-header {
  /* background: rgba(255, 255, 255, 0.88); */
  /* border-bottom: 1px solid rgba(0, 0, 0, 0.08); */
}

.page-header-content {
  /* padding-left: 14px; */
  /* padding-right: 14px; */
}

.page-title {
  /* color: #222222; */
  /* font-weight: 600; */
}

.page-body {
  /* background: transparent; */
}

/* === Shared cards and lists === */
[data-ui="card"],
.app-card,
.ui-entry-card,
.ui-list-card,
.ui-config-card,
.ui-collapsible {
  /* background: rgba(255, 255, 255, 0.78); */
  /* border: 1px solid rgba(0, 0, 0, 0.08); */
  /* border-radius: 14px; */
  /* box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06); */
}

/* === Shared buttons === */
.ui-btn {
  /* border-radius: 10px; */
  /* min-height: 38px; */
  /* font-weight: 500; */
}

.ui-btn-primary {
  /* background: #2f7cf6; */
  /* color: #ffffff; */
}

.ui-btn-outline {
  /* background: rgba(255, 255, 255, 0.64); */
  /* border-color: rgba(0, 0, 0, 0.12); */
  /* color: #222222; */
}

.ui-btn-soft-action,
.ui-btn-ghost {
  /* color: #2f7cf6; */
}

.ui-btn-danger {
  /* background: #ff3b30; */
  /* color: #ffffff; */
}

/* === Shared form controls === */
.ui-input,
.ui-textarea,
.ui-select {
  /* background: rgba(255, 255, 255, 0.86); */
  /* border: 1px solid rgba(0, 0, 0, 0.12); */
  /* border-radius: 10px; */
  /* color: #222222; */
}

.ui-input:focus,
.ui-textarea:focus,
.ui-select:focus {
  /* border-color: #2f7cf6; */
  /* box-shadow: 0 0 0 3px rgba(47, 124, 246, 0.14); */
}

[data-ui="slider"],
.ui-slider {
  /* accent-color: #2f7cf6; */
}

[data-ui="toggle"],
.ui-toggle {
  /* background: rgba(0, 0, 0, 0.18); */
}

.ui-toggle[data-checked] {
  /* background: #2f7cf6; */
}

.ui-toggle-knob {
  /* background: #ffffff; */
}

/* === Tags, badges and avatars === */
.ui-badge,
.ui-status-tag,
.ui-tag,
.ui-chip {
  /* border-radius: 999px; */
  /* background: rgba(0, 0, 0, 0.06); */
  /* color: #333333; */
}

.ui-chip[data-selected] {
  /* background: #2f7cf6; */
  /* color: #ffffff; */
}

.ui-avatar {
  /* border-radius: 12px; */
  /* border: 1px solid rgba(255, 255, 255, 0.8); */
}

.ui-alert {
  /* background: rgba(255, 149, 0, 0.12); */
  /* border: 1px solid rgba(255, 149, 0, 0.22); */
  /* border-radius: 12px; */
}

/* === Menus === */
[data-ui="menu"],
.menu-group {
  /* background: rgba(255, 255, 255, 0.82); */
  /* border: 1px solid rgba(0, 0, 0, 0.08); */
  /* border-radius: 14px; */
}

.menu-item {
  /* min-height: 46px; */
  /* padding: 12px 14px; */
}

.menu-label {
  /* color: #222222; */
}

.menu-desc {
  /* color: #777777; */
}

/* === Dialogs === */
[data-ui="modal"] {
  /* background: rgba(0, 0, 0, 0.42); */
}

[data-ui="modal-dialog"],
[data-ui="modal-sheet"],
[data-ui="modal-expand"] {
  /* background: #ffffff; */
  /* border: 1px solid rgba(0, 0, 0, 0.08); */
  /* border-radius: 18px; */
  /* box-shadow: 0 20px 60px rgba(0, 0, 0, 0.22); */
}

[data-ui="modal-header"] {
  /* border-bottom: 1px solid rgba(0, 0, 0, 0.08); */
}

[data-ui="modal-body"] {
  /* padding: 16px; */
}

[data-ui="modal-footer"] {
  /* gap: 10px; */
}

/* === Progress bars === */
[data-ui="progress"],
.ui-progress-track {
  /* height: 4px; */
  /* background: rgba(0, 0, 0, 0.1); */
  /* border-radius: 999px; */
}

.ui-progress-fill {
  /* background: #2f7cf6; */
}

/* === Message bubbles: only applies on pages that have these semantic nodes === */
[data-ui="bubble-user"],
[data-ui="bubble-bot"] {
  /* border-radius: 18px; */
  /* box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08); */
}

[data-ui="bubble-user"] {
  /* background: #2f7cf6; */
  /* color: #ffffff; */
}

[data-ui="bubble-bot"] {
  /* background: #ffffff; */
  /* color: #222222; */
}

/* === Examples of narrowing with combinators === */
[data-ui="modal"] .ui-btn {
  /* border-radius: 12px; */
}

[data-ui="body"] [data-ui="card"] {
  /* margin-bottom: 10px; */
}
`;
