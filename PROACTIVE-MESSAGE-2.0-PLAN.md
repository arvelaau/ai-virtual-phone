# Proactive Message 2.0 — Implementation Plan, and Three Feature Feasibility Analyses

Status: **planning only, nothing in this document has been built**. Written 2026-09-07 after auditing
the current codebase. Do not start Part 1 or any of Part 2 without an explicit go-ahead — several
items in both parts carry open decisions that are the user's to make, not a default to assume.

---

## Part 0 — What the codebase already has, and why it changes the plan

Before drafting the Cloudflare Worker design, the repo was searched for prior art. Two findings
reshape everything below:

### 0.1 `lib/weixin-cloud-sync.ts` already solves "assemble a full AI context outside the browser"
This file is **not mentioned anywhere in CLAUDE.md** (it postdates the note there that called the
WeChat cloud assistant "not ported"), but it exists and is a working precedent for exactly the hard
part of Proactive Message 2.0:

- `buildWeixinCloudRuntimeSnapshot(botId)` assembles a **self-contained JSON package** for one
  character: the character card, the bound API config (with the actual key), the bound preset,
  world books, regexes, voice config, user identity, memory config + memory entries, chat app
  settings, recent messages, and — the important part — an **already-assembled prompt**
  (`promptContext.llmMessages: LLMMessage[]`, produced by the same `assemblePromptPayload` the
  in-app chat engine uses) plus a `promptTemplate` with a slot token so new turns can be spliced in
  without re-running the whole assembler.
- That snapshot is uploaded to Supabase Storage (`cloud-backup/storage-client`), and a separate
  "local assistant" (a script or edge function the user runs, configured via
  `buildWeixinLocalAssistantConfigCode`) polls it, calls the LLM, and writes replies back.
- Replies come back through `parseAIResponse` (the same parser chat uses) and are merged into local
  chat storage via `upsertImportedChatMessage` — i.e. there is already a working "remote-generated
  message reconciles into local IndexedDB" path.

**Consequence for this plan:** Proactive Message 2.0 does not need to invent "how do I run a full
character's prompt outside the browser" — it needs to adapt this existing pattern to a different
transport (Cloudflare D1 + Worker instead of Supabase Storage + external poller) and a different
trigger (Cron Trigger instead of continuous polling by a script the user has to keep running).
Where reasonable, Part 1 below reuses the same shapes (`WeixinCloudRuntimeSnapshot`-style package,
`parseAIResponse`, the merge-into-local-storage pattern) rather than inventing new ones.

**Open question for the user:** the existing weixin path already requires the user to have Supabase
configured (`isCloudBackupConfigured`). Given that dependency already exists in the app, is
Cloudflare specifically wanted here because of its native Cron Trigger (Supabase's own scheduled
Edge Functions need `pg_cron`/`pg_net`, which is more setup than Cloudflare's one-line cron), or is
reusing Supabase (already integrated, already has a working snapshot/sync pattern) also acceptable?
This plan assumes **Cloudflare is wanted specifically for the built-in cron + the one-click deploy
UX shown in the reference screenshot**, and proceeds on that basis.

### 0.2 The current proactive-message logic (`lib/follow-up-service.ts`) is 100% client-timer-based
`chat_followup` / `chat_timed_wake` / `chat_period_care` already exist as preset entries, and the
decision logic ("has it been long enough, is this character eligible, what should the message say")
already exists in `follow-up-service.ts`. This is exactly what needs to be *ported*, not redesigned
from scratch — the LLM-facing side of proactive messaging is already built and tested; only its
"stay alive to fire the timer" assumption is what's broken on iOS.

### 0.3 No push infrastructure exists at all
No VAPID keys, no `pushManager.subscribe`, no `push` event listener in `public/sw.js`. Confirmed in
the prior analysis turn. This part is genuinely new.

---

## Part 1 — Proactive Message 2.0 (Option A: full parity, Worker generates real AI content)

### 1.1 Goal
A Cloudflare Worker, deployed to the **user's own Cloudflare account** via a one-click flow (paste
an API token; the app creates the D1 database, uploads the Worker script, writes secrets, and sets
the cron trigger — mirroring the reference screenshot), that:
- runs on a schedule independent of whether the PWA is open,
- decides, per character, whether a proactive message is due (porting the existing
  `follow-up-service.ts` timing rules),
- if due, assembles a real prompt and calls the LLM to generate an in-character message,
- delivers a Web Push notification to every subscribed device,
- and stores the generated message so the app can merge it into local chat history next time it's
  opened — so the notification and the chat thread agree, instead of the notification saying
  something the chat never shows.

### 1.2 Why "Option A" is a real scope jump from "just add push"
Sending a push notification is the easy 20%. The hard 80% is that the message content is an
**LLM generation that depends on data which today lives only in the browser's IndexedDB** (Dexie) —
character card, preset, world books, memory (core + long-term), recent short-term history, API
config with the actual provider key. None of that has ever left the device for chat/character data
in this app (Supabase is used for game-hall/black-market/mixology — all independent of chat data).
Shipping Option A means the character's context now also lives, in some form, on infrastructure the
user controls (their own Cloudflare account) — that is a real architectural line being crossed, even
though it stays under the user's own account rather than a third-party server.

### 1.3 Client-side pieces (Next.js app)

| # | Piece | Notes |
|---|---|---|
| 1 | `lib/proactive-cloud-sync.ts` (new) | Adapts `buildWeixinCloudRuntimeSnapshot` into a lighter package per character: character card, resolved preset text, world books, memory (core + a capped window of long-term), a capped recent short-term window, the bound API config, and the character's proactive-message settings (which of `chat_followup`/`chat_timed_wake`/`chat_period_care` are enabled, their intervals). No full chat history needed — proactive messages only need enough context to sound in-character, not the whole log. |
| 2 | VAPID key management UI | "Push Credentials (VAPID)" settings section: generate a keypair (public key ships to the client, private key becomes a Worker secret during deploy — never stored in the app's own local settings in plaintext beyond what's needed to complete the deploy flow). |
| 3 | Subscribe flow | "Instant Push" section: on user gesture, `Notification.requestPermission()` → `serviceWorker.ready` → `registration.pushManager.subscribe(...)`. Requires the app to already be installed to the Home Screen (see 1.6). The subscription object gets pushed to D1 via an authenticated call to the deployed Worker. |
| 4 | `public/sw.js` gains a `push` handler | `self.addEventListener("push", event => { const data = event.data.json(); event.waitUntil(self.registration.showNotification(data.title, {...})); })`. Additive to the existing cache-only service worker — does not change its caching behaviour. |
| 5 | One-click deploy modal | "Proactive Message 2.0" settings section, matching the reference screenshot: paste a scoped Cloudflare API Token (`Workers Scripts:Edit`, `D1:Edit`, `Account Settings:Read` — matches the token scopes actually needed) → the app calls Cloudflare's REST API (via a relay, since the browser can't call Cloudflare cross-origin without CORS support) to create the D1 database, upload the Worker script bundle, write secrets (VAPID private key, and per-character API keys pulled from the snapshot), and register the cron trigger. |
| 6 | Reverse-sync on app open | On launch (or resume from background), the app calls the Worker's HTTP endpoint for "messages generated since I was last open", and merges each into local chat storage the same way `weixin-cloud-sync.ts` merges inbound WeChat messages (`upsertImportedChatMessage`), then marks them delivered so the Worker can prune them from D1. |

### 1.4 Worker-side pieces (Cloudflare)

| # | Piece | Notes |
|---|---|---|
| 1 | D1 schema | `subscriptions` (endpoint, p256dh, auth, characterId, lastSeenAt), `character_snapshots` (characterId, JSON blob per 1.3.1, updatedAt), `proactive_state` (characterId, lastMessageAt, nextCheckDueAt — mirrors what `follow-up-service.ts` currently tracks client-side), `pending_messages` (characterId, content, createdAt, delivered flag). |
| 2 | Cron Trigger handler | Runs every N minutes (Cloudflare cron minimum granularity is 1 minute; a 5–15 minute cadence is plenty for "proactive message" use). For each character with a due `nextCheckDueAt`, decide whether to fire — porting the same eligibility rules `follow-up-service.ts` already uses (quiet hours, per-mode enable flags, elapsed time thresholds). |
| 3 | Prompt assembly in the Worker | Cannot reuse `assemblePromptPayload` directly (it's written against browser-only storage modules) — needs a **trimmed reimplementation** that takes the stored snapshot and produces the same `LLMMessage[]` shape the existing `chat_followup`/`chat_timed_wake`/`chat_period_care` preset entries expect. This is the single largest and riskiest piece of new code in this plan (see 1.7). |
| 4 | LLM call | Standard HTTP call to the character's bound provider, using the API key delivered as a Worker secret at deploy time (or stored per-character in D1 if multiple characters use different providers — needs a decision, see 1.8). |
| 5 | Response parsing | Reuse the parsing logic from `lib/rich-message-parser.ts`'s `parseAIResponse` conceptually — either port a trimmed copy into the Worker bundle, or (cleaner) keep it as shared logic if the build can target both environments. Needed so the generated text is cleaned the same way the client would clean it (strip `<think>`, strip action tags not relevant to a push context, etc.). |
| 6 | Web Push send | Encrypt the notification payload (`aes128gcm`) and sign a VAPID JWT using the Workers **WebCrypto API** (`crypto.subtle`) — proven to work in the Workers runtime; existing libraries such as `@block65/webcrypto-web-push` do this without needing Node's `crypto` module. POST to each subscribed endpoint. |
| 7 | Write to `pending_messages` | So the reverse-sync in 1.3.6 has something to pull. |

### 1.5 Deploy-flow implementation notes
The one-click flow in the reference screenshot is a real, provable pattern: Cloudflare's REST API
supports programmatic D1 database creation, Worker script upload (`PUT
/accounts/:id/workers/scripts/:name`), secret writes (`PUT .../secrets`), and Cron Trigger
configuration (`PUT .../schedules`), all under a token scoped to exactly the three permissions shown
in the screenshot. Because browsers can't call `api.cloudflare.com` directly (no CORS on that API),
this needs a thin relay — a Next.js API route (`app/api/cloudflare-deploy/route.ts`) that receives
the pasted token from the client, makes the Cloudflare API calls server-side, and never persists the
token itself (matches the reference screenshot's own disclosure text about the token being "relayed
once through this site's network proxy Worker").

### 1.6 The iOS constraint, restated (applies regardless of Worker design)
Push only works once the PWA is added to the Home Screen (standalone mode — already satisfied by
this app's `manifest.json`), on iOS 16.4+, and only after the user grants notification permission
from inside the installed PWA. No part of this plan can route around that; it's an Apple platform
rule, not an implementation gap.

### 1.7 Biggest open risk: reimplementing prompt assembly outside the browser
`llm-prompt-assembler.ts` and `builtin-preset.ts` are large, and per CLAUDE.md's own history, this
project has repeatedly found subtle desyncs whenever a protocol or prompt-building rule got
duplicated across two places (`tool-executor`/`FETCH_RESULT_HEADER`, the `[InnerThoughts]` sanitizer
gap, etc. — recorded throughout CLAUDE.md as "one side moved, one consumer left behind"). Writing a
second, Worker-side prompt assembler is exactly that risk pattern, deliberately taken on. Two ways
to reduce it:
- **Narrow scope aggressively.** A proactive message only ever uses three specific preset entries
  (`chat_followup`, `chat_timed_wake`, `chat_period_care`), which are short and don't need world
  book activation search, memory retrieval scoring, or most of the assembler's surface. A
  purpose-built, much smaller Worker-side builder for just these three entries is far safer than
  trying to port the general assembler.
- **Keep the "canonical" version client-side.** The Worker's output only ever becomes a *pending*
  chat message; the client re-validates/re-renders it through the real `parseAIResponse` on merge
  (1.3.6), so a Worker-side parsing bug degrades to "an odd-looking pending message," not silent
  data corruption.

### 1.8 Other open decisions (need the user's input before implementation starts)
1. **Per-character granularity.** Sync every character with proactive messaging enabled, or only
   ones the user explicitly opts in (recommended — keeps the D1 footprint and the "how much of my
   character context is on Cloudflare" surface as small as possible)?
2. **API key handling.** Store the provider API key as one Worker secret (simplest, but means every
   character shares one provider/key) or per-character in D1 (more flexible, but means provider
   keys sit in a database rather than a secret store — needs its own encryption-at-rest story)?
3. **Snapshot freshness.** Re-sync a character's snapshot to D1 on every edit (persona, memory,
   preset), on a timer, or only via a manual "sync now" button? Stale snapshots mean the Worker
   generates messages from an outdated persona/memory.
4. **Message frequency defaults**, mirrored from whatever `follow-up-service.ts` uses today, or
   reconsidered for a cron-driven (rather than continuously-running) checker.
5. **Fallback for users who don't deploy a Worker.** Existing `follow-up-service.ts` behaviour
   (fires when the app happens to be open) should probably stay as the default/free path, with
   Cloudflare deployment as an opt-in upgrade — not a replacement.

### 1.9 Suggested phase order
1. Push plumbing only (VAPID, subscribe flow, `sw.js` push handler, a trivial test endpoint that
   pushes a static string) — proves the iOS delivery path end-to-end before any AI logic is added.
2. D1 schema + one-click deploy flow, still with the trivial test endpoint.
3. Snapshot sync (adapt `weixin-cloud-sync.ts`'s pattern) + the narrow Worker-side prompt builder
   for just the three follow-up preset entries, tested against canned data before wiring to cron.
4. Cron handler + real LLM call + Web Push send.
5. Reverse-sync into local chat storage.
6. Polish: quiet hours, per-character opt-in UI, snapshot re-sync triggers.

---

## Part 2 — Three additional feature requests: feasibility analysis only (nothing to build yet)

### 2.1 HTML rendering triggered by content (coffee receipt, a "drawn" self-portrait, etc.)

**Finding: the rendering infrastructure for this already exists in all three modes the user asked
about.** This is a prompting gap, not an engineering one.

- `components/chat/message-bubble.tsx` already parses ` ```html ` fenced code blocks (and
  auto-detects raw HTML containing `<script>`/`<style>` even without fencing) out of any assistant
  message, and renders them in a sandboxed `<iframe>` with an auto-resizing inline card plus a
  fullscreen escape hatch (`HtmlPreviewCard` / `HtmlFullscreenModal` / `buildChatHtmlDocument`).
- **Offline mode already renders through the same component** — `chat-room.tsx` passes
  `htmlFrameVariant="offline"` into it, which only disables the fullscreen expand (`allowFullscreen
  = variant !== "offline"`), keeping the inline card.
- **Story mode has its own but structurally identical renderer**, `components/ui/story-html-renderer.tsx`
  (`StoryHtmlRenderer`), wired into `story-app-base.tsx`, parsing the same ` ```html ` fence
  convention.

So all three modes the user named can already display a self-contained HTML "artifact" the moment
the model outputs one in the right fence. **What's missing is that nothing currently teaches the
model to do this for general creative purposes.** The only existing precedent is one narrow preset
entry, `dwelling_item_detail` (`lib/builtin-preset.ts:4002`), which teaches exactly this pattern —
*"Output format: a ```html code block containing one complete, self-contained HTML page with inline
CSS and optionally JS"* — but only for Dwelling's "examine an object" feature; `chat_output_format`,
`chat_offline_format`, and `story_output_format` never mention this option at all.

#### Correction after user follow-up: the render path is not as deterministic as "infra already exists" implies
Right to push back on this. There is a real variable sitting between "model outputs a fence" and
"user sees a live iframe": **user-configurable display regex.** `chat-room.tsx`'s
`getMessageDisplayContent()` runs every assistant message through `applyDisplayRegex` (from
`lib/llm-prompt-assembler.ts`, driven by whatever the user has configured in Regex Manager) *before*
that text ever reaches `message-bubble.tsx`'s fence/HTML detection. Two concrete failure directions:
- A broad user-authored display rule (e.g. one that strips code fences, or does markdown cleanup,
  or targets backtick-delimited blocks for an unrelated reason) can silently eat a ` ```html ` block
  before the detector ever sees it — the model did the right thing, the regex undid it.
  Never a crash, never an error — it just quietly renders as plain text or vanishes.
- Less likely but possible: a user rule that happens to *produce* something shaped like an HTML
  fence (or the raw-detect heuristic's `<script>`+`<style>` signature) as a side effect could
  trigger the iframe render path on content nobody intended to be rendered.
So "the infrastructure exists" is correct for *baseline* behaviour, but it is not immune to whatever
regex rules a given user happens to have installed — that has to be treated as a real input to this
feature, not an edge case to ignore.

**Verdict: yes, still straightforward to add**, by extending the existing teaching pattern (copy the
shape of `dwelling_item_detail`'s instruction block) into the relevant chat/offline/story preset
entries, with guidance on *when* it's appropriate (a receipt, a ticket, a hand-styled card, an
ASCII/CSS "sketch" — not routine conversational replies) so the model doesn't overuse it. No parser
or protocol work needed — this is a Track-1/prose-only preset change. But per the correction above,
it needs a render-side safety net, not just a teaching change (see the toggle design below).

#### Toggle design (per user decision: expose this per mode, not as one global switch)
Two independent layers, and both are needed — they protect against different failure modes:

| Layer | What it controls | Why it's needed |
|---|---|---|
| **A — Teaching toggle** (preset-side) | Whether the model is *taught* the ` ```html ` pattern at all, for a given surface. | Maps cleanly onto existing structure: `chat_output_format`, `chat_offline_format` and `story_output_format` are **already separate preset entries** (offline is a distinct tag-scoped entry even though it's the same app/binding as chat, not a separate top-level app) — so "on for chat, off for offline, on for story" is just "include or omit this block per entry," no new plumbing required. |
| **B — Render toggle** (display-side, in `message-bubble.tsx` / `story-html-renderer.tsx`) | Whether a *detected* fence actually renders as a live sandboxed iframe, or falls back to an inert, syntax-highlighted code block. | This is the one that actually answers the regex concern above. Layer A only controls what the model is told to do — it can't stop a stray regex from interfering, and it can't stop a model that free-lances the pattern from having seen it elsewhere in context/history even when not taught. Layer B is a hard gate that runs regardless of *why* an html-shaped block showed up. |

Recommend shipping both, independently switchable per mode (chat / offline / story), with B
defaulting to **on** whenever A is on for that mode (so turning on the feature "just works") but
overridable on its own — e.g. a user who wants to keep the render safety net off entirely, or on
even in a mode where the model isn't being taught to use it, can do that. Also worth a small
Regex Manager UI note warning that a broad code-fence-stripping rule can interfere with this
feature, since that's a real interaction between two independently-editable settings.

**Still worth clarifying before writing the prompt text:**
- "gambarin aku dong" (draw me) — is a CSS/HTML "artistic rendering" (ASCII art, generative CSS
  shapes, a stylised card) actually what's wanted, or would the user expect the app's existing
  **image generation** capability (a real generated image) for that specific phrase? Worth deciding
  which trigger maps to which mechanism, since both now technically exist in the app and a model
  that's taught both might pick either one inconsistently.

### 2.2 An "idle / busy" AI state that replies with a short deflection, then a real reply later

**Finding: no such mechanic exists anywhere in the codebase today.** `lib/mascot-state.ts` only
tracks the desktop mascot widget's UI animation state (`widget`/`floating`/etc.) — unrelated to a
character's in-chat availability. There is no `chat_status_region`-style feature either (that's an
upstream, never-ported concept per CLAUDE.md).

**Closest existing building blocks, and how they'd combine:**
- The **calendar/schedule system** (`currentSchedule`, `lib/calendar-engine.ts`) already models what
  a character is doing at a given time. "Busy" could be *derived* automatically from whether the
  current time falls inside a scheduled item, rather than invented as a separate flag — this is
  attractive because it means "busy" is consistent with what the character's schedule already says,
  but it only works well for characters that actually have calendar data populated.
- **`lib/follow-up-service.ts`'s delay/timer machinery** is the right shape for "the real reply
  fires later" — it already knows how to schedule a delayed, context-aware generation.
- **This is the same delivery problem as Part 1.** A deferred "real" reply that must still arrive
  even if the user has closed the app is exactly what Proactive Message 2.0's Worker+push pipeline
  is for. Building "busy mode" *before* Option A exists means the deferred reply only works while
  the app happens to stay open — the same iOS limitation that motivated this whole conversation.

**Proposed shape** (not committed to — needs a design decision): user sends a message while the
character is "busy" → a **cheap, short, in-character deflection** is generated immediately (this
should be a lightweight prompt path, not the full context-heavy generation, both for speed and so
it doesn't defeat the "busy" illusion by being a deep reply) → the real, fully-contextual reply is
scheduled for some time later, using the same delivery path as a proactive message.

**Verdict: feasible, but it is a genuinely new subsystem, not a prompt tweak** — needs (a) a busy/
free state per character with an "until when," (b) a separate lightweight prompt for the deflection
reply, and (c) a deferred-generation trigger. Recommend sequencing this **after** Part 1, so it can
reuse Option A's "generate and notify even while the app is closed" pipeline instead of duplicating
a smaller version of the same problem.

**Open question for the user:** should "busy" be fully automatic (derived from the character's own
calendar schedule) or an explicit toggle either the user or the AI (via a tool call) sets? Automatic
is more elegant but depends on every character having a populated schedule; a manual toggle is
simpler to ship first.

### 2.3 A movie/book review app (à la the reference screenshot)

**Reference behaviour**: search or manually add a film/book (auto-fetched cover/poster/basic info),
keep a personal "viewing journal" per title, discuss it with a chosen character in two modes
(spoiler-safe "watching along" vs. unrestricted "already seen it"), and have the character post its
own independent rating/review — despite never having "watched" anything — informed by what the user
has shared plus (ideally) real published reviews for context.

**Closest existing patterns in this codebase to build from:**
- `components/interview/interview-magazine-app.tsx` + `lib/interview-magazine-engine.ts` is the best
  structural precedent for "a character produces independent, structured commentary about something
  external, separate from the user's own input" — the review-generation half of this feature should
  follow that shape rather than being invented from scratch.
- `diary`/`note-wall` is the right precedent for "user and character both post entries to a shared
  board."
- Star ratings / tag-driven feed UI can borrow presentation patterns already used in `xiaohongshu`.

**What's genuinely new, piece by piece:**

| Piece | Feasibility | Notes |
|---|---|---|
| Auto-fetch movie metadata + poster | Yes, straightforward | Needs a new external integration — TMDB's API is the standard choice (free, requires the user register their own API key, mirroring how other external services are already configured in Settings). A new proxy route (`app/api/media-lookup/route.ts`) is needed since TMDB should be called server-side. |
| Auto-fetch book metadata + cover | Yes, straightforward, easier than movies | Open Library / Google Books APIs are fully public, no registration needed for basic lookups. |
| Manual entry + custom cover upload | Yes, trivial | Mirrors existing custom-avatar/custom-sticker upload patterns already in the app. |
| Per-title viewing journal | Yes, trivial | Mirrors the existing diary/note-wall storage shape (a new Dexie table + `lib/*-storage.ts`). |
| Two discussion modes (spoiler-safe vs. free) | Yes, moderate | New preset-entry pair (structurally similar to `reading_annotation`/`reading_discuss`), gated on a user-set "have I finished this" flag per title. |
| Character posts its own rating/review without having watched it | Yes, with an honest framing | The review must be explicitly grounded in what the character *can* actually know: the metadata/synopsis, and whatever the user has shared in the journal/discussion — this is not a technical limitation, it's the correct in-character framing ("I haven't seen it, but from what you've told me...") and should be written into the generation prompt as such. |
| Grounding the character's take in *real* published reviews (e.g. Letterboxd) | Yes, but **not** via open-ended MCP web search — see below | Redesigned after user feedback; see the dedicated subsection. |

#### Correction after user follow-up: open-ended MCP search is the wrong primary mechanism
The concern raised is valid and is exactly the right failure mode to worry about: an MCP web-search
tool call is **free-form** — the model picks the query, picks how many results to read, and picks
which of several same-titled or similarly-titled works those results actually describe. More sources
pulled in autonomously means more chances the AI anchors on the wrong edition, the wrong year's
remake, a same-named book vs. film, or a mixed bag of opinions about different things that all
happen to share a title. That risk scales *with* how open-ended the retrieval is, not despite it —
so "more sources, automatically" is a real regression from "one confirmed source," not an
improvement.

**Redesigned approach — disambiguate once, structurally, then lock it:**
1. **The disambiguation problem is already solved by the metadata-lookup step, and should never be
   re-solved by a free-text search later.** TMDB returns a stable numeric movie ID; Open Library /
   Google Books return a stable work ID or ISBN. Whichever record the user picked (or confirmed) when
   adding the title to their archive *is* the disambiguated identity — title, year, director/author
   all come from that one exact ID. Nothing downstream should ever re-derive "which film is this"
   from a loose query again.
2. **Review grounding, if built, should be a single deterministic fetch keyed by that same ID** —
   e.g. TMDB's own (sparse) review endpoint for that exact movie ID, or a structured
   description/editorial-review field on that exact Open Library/Google Books record — done **once**
   when the title is added (or via an explicit "refresh" button), then **cached** alongside the
   journal entry. The character's generation always reads from that one cached, ID-locked snippet;
   it never re-searches per message. This is what actually answers the concern: bounding the source
   to a fixed count (one, tied to a fixed ID) instead of letting retrieval fan out.
3. **The cached snippet should be shown to the user before it's ever used in generation** — a small
   "here's what we found for this title, edit or clear it if it's wrong" step. That catches a bad
   match at the one point it's cheap to catch, instead of it silently poisoning every future
   discussion of that title.
4. **MCP-based open web search stays available, but demoted to an explicit, user-invoked action**
   (e.g. a "look up more opinions" button), never something the AI decides to do on its own mid
   conversation. When invoked, the query passed to the tool should be **pre-built from the locked
   title+year+director/author**, not composed freely by the model — and results should go through
   the same "show before use" confirmation as step 3, rather than being folded straight into context.

This reframes "grounded in real reviews" from a fuzzy, autonomous, multi-source retrieval feature
into a small, deterministic, cache-once, user-verifiable lookup — with open search demoted to an
optional, human-gated extra rather than the primary mechanism.

**Verdict: yes, fully feasible, no hard blockers** — but it is the largest of the three asks, roughly
comparable in scope to an existing full app like `diary` or `reading`. No part of it requires
anything not already proven elsewhere in this codebase, except the external metadata lookups, which
are a small, well-understood integration.

**Open question for the user:** is the ID-locked cached-snippet grounding (step 2 above) wanted for
v1, or is skipping real-review grounding entirely for v1 (character reviews based only on
metadata + the user's own journal/discussion) preferred, with the MCP-based opinion lookup as a
later, fully opt-in addition?

---

## Part 3 — Suggested sequencing across all four items

Because 2.2 (busy mode) explicitly wants the same "generate and deliver even while the app is
closed" capability that Part 1 builds, and 2.1/2.3 are fully independent of everything else:

1. **2.1 (creative HTML teaching)** — smallest possible change (prompt text only), ship first,
   independent of everything else.
2. **2.3 (movie/book review app)** — fully independent, can be built in parallel with anything else,
   good isolated win, no dependency on Part 1.
3. **Part 1 (Proactive Message 2.0)** — the substantial one; do this before 2.2.
4. **2.2 (busy/idle mode)** — build once Part 1's delivery pipeline exists, so the deferred "real"
   reply can reuse it instead of re-solving the same problem at smaller scale.

Nothing above has been implemented. Each numbered open question in Parts 1 and 2 needs an answer
before its corresponding piece is started.
