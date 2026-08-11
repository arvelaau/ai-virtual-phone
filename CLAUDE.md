# Chinese → English UI Translation — Handoff

## Project
Next.js "AI virtual phone" app at this repo root. Originally all UI text is in Chinese; translating to English, folder by folder, reviewing diffs as we go. Git was just initialized here with a baseline commit (`6a067d4`) that already includes the finished `components/chat/` translation below — so `git diff` will only show changes made *after* this point.

## Two categories of Chinese text (different handling)
1. **UI TEXT** — labels, titles, placeholders, alt/aria-label, toasts — in `.tsx` files under `components/` and `app/`. Translate freely.
2. **AI PROMPT/PROTOCOL TEXT** — do **NOT** touch without asking first.
   ⚠️ **This list was incomplete until the 2026-07-29 audit** (see the AUDIT section near the end) — ~25 more prompt-building files were found, mostly `lib/*-engine.ts`. Treat the audit list as authoritative; the entries below are just the ones discovered earliest.
   - `lib/builtin-preset.ts`, `lib/mascot-prompts.ts`, `lib/custom-app-creator-guide.ts`, `lib/tool-executor.ts`, `lib/cocreate-tools.ts` (character/system prompts — changes AI personality/behavior)
   - `lib/memory-types.ts` — **discovered while working on `components/memory/memory-bank-page.tsx`**: exports `DEFAULT_SUMMARIZATION_PROMPT`/`DEFAULT_CORE_MEMORY_PROMPT`, literal multi-paragraph Chinese AI system prompts (e.g. `` `你是一个记忆整理助手。根据以下事件记录...` ``) that instruct the AI how to summarize chat history into memory entries. Not touched (out of scope, `.ts` not `.tsx`), but add to the ask-first list since it's functionally identical to the other protected prompt files.
   - `lib/rich-message-parser.ts`, `lib/group-admin.ts` — **discovered during this work**: these define/parse a literal-Chinese bracket-tag protocol the AI is taught to output (e.g. `[A将B移出了群聊]`, `[A领取了B的红包]`, `[我向X发起了语音通话]`, `[转账:金额:留言]`, `[代付请求:...]`, `[A拍了拍B]`) to trigger real actions: group kick/mute/admin/transfer-ownership, red envelopes, transfers, payment requests, call start/end/decline/cancel, pat-on-shoulder. Regexes match the **exact Chinese substrings**. Translating any of it breaks the feature unless the regexes and the system prompt teaching the AI this format are updated in lockstep. **User decision so far: skip these entirely for this pass.** Any UI file that constructs or matches these same strings (chat bubbles rendering transfer/red-envelope/call/group-notice content, wallet/call screens) must also leave those specific strings in Chinese — this came up constantly in `components/chat/` and will keep coming up elsewhere (e.g. likely in `components/dwelling/`, wallet/shopping-adjacent files, anything with calls or group chat).

Rule of thumb for every file: if a Chinese string is wrapped in `[...]`, assigned to a `content:` field of a message/session object, passed to a message-adding function, or matched/compared against message content — leave it and report it. Static labels for the same actions (button/menu text) are safe to translate.

**Standing rule (user decision, 2026-07-27): `notifyMascotPageContext({ label: "..." })` calls — translate the `label` field.** This value gets embedded directly into the mascot AI's prompt via `lib/mascot-engine.ts:530,604` (`` `当前页面：${context.label}（${context.mode}）` `` — "Current page: X"). No technical/matching risk (nothing parses it back), but it is literally AI-prompt content, so flag each occurrence in this progress log for later review alongside the real protected AI-prompt files. All known call sites (6 total, `desktop-shell.tsx` only references it in a comment):
- `components/chat/phone-chat-app.tsx:127-130,139-142` — **NOT YET translated** (this file was completed in an earlier session before this rule existed — `label: "聊天 · ${...}"` / `"聊天 · ${...AI助手}"` still Chinese). **Needs revisiting** for consistency once the AI-prompt-protected-files phase starts.
- `components/phone-character-app.tsx:1726-1729,1759` — **done**, translated to `` `Character Edit · ${name || "New Character"}` `` and `"Desktop"`.
- `components/settings/worldbook-manager.tsx:121-124,128-131,140` — labels `` `世界书 · ${book.name}` ``, `"世界书列表"`, `"桌面"`.
- `components/settings/regex-manager.tsx:134-137,146` — labels `` `正则编辑 · ${activeGroup.name}` `` / `"正则编辑"`, `"桌面"`.
- `components/settings/preset-manager.tsx:214-217,221-224,233` — **done**, translated to `` `Preset · ${preset.name}` ``, `"Preset List"`, `"Desktop"`.
Translate each as its file comes up in the folder-by-folder pass; note it in that file's progress entry below.

**Extended pattern found in `components/game/` and `components/shopping/`**: the same "leave it and report" rule also applies to two more shapes, beyond the chat action-tag protocol above:
- **Cross-file data-matching constants** — a Chinese string literal defined/compared in one `.tsx` file that must exactly equal a default value or tag written by a different file (`lib/*-storage.ts`, `app/api/**/route.ts`, even SQL schema defaults). Example: `components/game/game-hub-app.tsx`'s `GAME_ALLOWED_TAGS` array (`"推荐"`, `"休闲"`, etc.) matches literal tag data in `lib/game-builtins.ts`; `"本机玩家"`/`"匿名作者"`/`"匿名玩家"`/`"匿名"` equality checks match defaults written by `lib/game-storage.ts` and `app/api/game-hall/games/route.ts`; `result.error === "已经安装过这个游戏。"` matches a literal error string from `lib/game-storage.ts`. Translating only the `.tsx` side desyncs the comparison. Leave these and report; only safe to translate once the producing file(s) are translated in lockstep.
- **File-local bracket-tag rendering systems** — not every `【...】`/`[...]` bracket tag is the app-wide chat protocol; some files have their own self-contained regex-based tag system for AI-generated content (found in `components/shopping/black-market-app.tsx`: `【秘密】`/`【失控】`/`【反应】` tags used by `renderRulesText`'s matching regex and the `outputContract` sample text that teaches the AI this format). Same handling: leave the bracket tokens themselves, translate all surrounding descriptive/narrative text, report the file:line.

## Scope note (open question, not yet decided)
`app/api/**/route.ts` files (backend route handlers, ~420 Chinese occurrences across 43 files) are `.ts` not `.tsx` — out of scope for the current ".tsx UI text" pass per the original instruction. Some of their Chinese strings are user-facing API error messages that reach the UI; others are server-only logs. Ask the user whether/when to handle these, don't assume.

Same applies to a handful of `.ts` files that happen to live under `components/` (not `lib/`): `components/world-builder/scene-store.ts` (49), `model-optimize.ts` (14), `scene-db.ts` (7), `model-db.ts` (4), `thumbnail-generator.ts` (2), and `components/debug-prompt-registry.ts` (10). Out of scope for the same reason (not `.tsx`), left untouched.

## Progress so far
`components/chat/` (32 files) — **done**, ~1024 strings translated, `npm run build` passes. Per-file breakdown and full list of intentionally-skipped protocol strings is in this session's transcript — re-derive via `git show 6a067d4 --stat` if needed, or just grep for `[\x{4e00}-\x{9fff}]` (ripgrep unicode range) to see what's left (should only be protocol tags + code comments).

`components/game/game-hub-app.tsx` — **done**, 262/275 Chinese lines translated, `npm run build` passes. 13 lines intentionally left in Chinese: `GAME_ALLOWED_TAGS` constant + its reuses (lines 128, 317, 321, 691, 750, 1268) and `本机玩家`/`匿名作者`/`匿名玩家`/`匿名` equality checks (lines 240, 241, 663, 1317, 1393, 1590) + one error-string match (line 1099) — all cross-file data-matching constants, see extended pattern note above.

`components/shopping/black-market-app.tsx` — **done**, ~90 strings translated, `npm run build` passes. 4 lines intentionally left in Chinese: error-message match at line 1473 (`已经收入暗柜`, matches `lib/black-market-storage.ts`/`lib/server/black-market-cloud.ts`) and the `【秘密】`/`【失控】`/`【反应】` bracket-tag system at lines 104, 637, 650 — see extended pattern note above.

`components/cocreate/cocreate-app.tsx` — **done**, 258→12 Chinese occurrences (11 lines), `npm run build` passes. This file imports `COCREATE_TOOL_DEFINITIONS` from protected `lib/cocreate-tools.ts`, so it has a real producer/consumer content-matching pair local to itself — a "tool is running" status detector. Left in Chinese: consumer checks at lines 332-333 (`content.startsWith("动作结果返回："/"正在执行：")`), 1928/2025/2118 (`authorName?.includes("正在")`), 1962 (`/^正在(调用|执行)/`), 2050/2143 (`content.includes("正在执行")`); and the producer strings that feed them at lines 1328 (`"正在创作剧本..."` authorName), 1347 (`` `正在调用 ${name}…` `` content), 1439 (regex re-parsing that same string), 1355 (`"切换"`/`/切换到第/` matching a tool name + notice template literally defined in `lib/cocreate-tools.ts:1221`). Good example of the "extended pattern" above: a whole producer→consumer chain within one otherwise-translatable file, tied to a protected lib file's literal string constants.

`components/xiaohongshu/xiaohongshu-app.tsx` — **done**, ~190 strings translated, `npm run build` passes. Left in Chinese (data-parsing/content-matching, not UI labels): `parseCompactCountLabel`/`parseNotificationCountFromText` regexes matching `万`/`千`/`等...人` compact-count templates (lines 171,176-177,182,943); `formatNotificationPreview`'s regex stripping `(评论了你的笔记|回复了你)` from `notice.text` (line 966) — producer of that text not found in this file, likely backend/AI-generated, out of scope; `getGenderClassName` + profile gender-edit buttons matching `女`/`男`/`♀`/`♂` against a data field (lines 343,346,3281,3289). **One override**: the sub-agent also left `text: \`${account.name} 关注了你\`` (line 1174, a locally-constructed "followed you" notification) in Chinese out of caution, but a full-repo grep confirmed that exact string has zero other references/matches anywhere — it's pure display text rendered as-is via `notice.text`, not part of any protocol chain — so I translated it directly to `followed you` after verifying. Lesson: the "leave content: fields alone" rule is for fields that round-trip through matching logic elsewhere; a content-like field with a confirmed zero-match grep should still be translated, don't over-apply the rule by field-name-shape alone. Also note: `formatCount()` (line 158-161) was changed to always emit `w`/`k` suffixes instead of `万`/`千` for large numbers — safe because `parseCompactCountLabel` already accepted `w`/`W` as an alias, so round-tripping still works.

`components/app-market/app-market-app.tsx` — **done**, ~130+ strings translated, `npm run build` passes. No protocol/content-matching exceptions — this file's Chinese was 100% UI text or code comments (21 comment-lines left untouched, out of scope per rule 1). `CUSTOM_APP_CREATOR_GUIDE_MD` (from protected `lib/custom-app-creator-guide.ts`) is only referenced as a variable, not touched. Minor: a full-width `，` separator joining translated text with still-Chinese `registrationText` (from out-of-scope `lib/custom-app-registration.ts`) was changed to `, ` for readability around the `installApp` notice.

`components/settings/toolbox-settings.tsx` — **done**, ~189 strings translated, `npm run build` passes, zero Chinese characters remain in the file. No protocol/content-matching exceptions. Imports `discoverMcpTools`/`startMcpOAuth` from protected `lib/tool-executor.ts` as functions only, untouched. Translated illustrative template-placeholder examples (`{{参数名}}`→`{{paramName}}`, `{{steps.名称.data}}`→`{{steps.name.data}}`) — verified safe: the actual template engine (`lib/internal-capability-storage.ts`, out of scope) matches the generic `{{...}}` syntax, not these specific Chinese example words, which only exist as illustrative text in both files.

`components/map/map-view.tsx` — **done**, ~145 strings translated, `npm run build` passes. This is the UI for an AI-driven "DM" (Dungeon Master) text-adventure engine (`lib/map-rpg-engine.ts`, out of scope), so it's dense with cross-file content-matching — left in Chinese: regex parsing AI-generated `actionText` for `说：「」`/`做：` markers (lines 526-527, producer at 1104-1107); `who`/`specifiedWho === "你"` and `"玩家"` fallback matching the AI `moveTo`/`statCheck.who` field convention (lines 182,440,523,772,946,1035,1050,1121,1185); `debugLog.type` discriminators matching literal `dmLog(...)` tags from `lib/map-rpg-engine.ts` (`"DM场景·发送"`, `"DM裁决·发送"`, `"DM结局·发送"`, `"配置"`, etc. — lines 2559-2565,2577,2729-2730); companion-action sentinels `"跟随队伍"`/`"沉默不动"` (lines 595,1159,1206) and `statNameMap` (力量/体质/敏捷/智力/感知/魅力/运气, line 664) and side-quest status `"已完成"`/`"未触发"` (line 426), all confirmed matched/read by `lib/map-rpg-engine.ts`.
**Flagged for later review**: lines 965 and 1194 are not UI text and not matched anywhere — they're instruction/fallback strings embedded in prompt content sent TO the AI (`exitReactionInstruction` telling a companion NPC how to react to the player leaving; a fallback `action` value in a `Declaration` object). No technical risk (nothing parses them back), but they shape what the AI reads, same risk category as the protected character/system-prompt files. **User decision (2026-07-27): translate now (no technical blocker), but re-evaluate consistency/tone once the actual AI PROMPT/PROTOCOL TEXT files (`lib/builtin-preset.ts` etc.) are tackled** — don't forget these two spots when that phase starts.

`components/shopping/shopping-app.tsx` — **done**, ~65 strings translated, `npm run build` passes. Two protocol categories converge in this file: (1) the documented chat bracket-tag protocol — line 906 `label: "代付请求"` inside a `pushChatMessage(...)` call, exact match to `lib/rich-message-parser.ts:102` (the app-wide `[代付请求:...]` payment-request tag); (2) a shipping/order `statusLabel` system matched/duplicated across THREE out-of-scope lib files (`lib/shopping-gift-utils.ts:52` regex `/已到货|已签收|已完成/`, `lib/shopping-payment-request.ts:100-103,175` duplicate timeline constants, `lib/weixin-bridge.ts:421` `"待代付"` status) — left in Chinese: lines 252-255 (`已下单`/`已发货`/`配送中`/`已到货` timeline labels), 274/369 (`待发货` fallback), 876 (`待代付`), 1442/1621 (`=== "已到货"` comparisons). Everything else describing the same "代付" (pay-on-behalf) feature in plain UI (buttons, aria-labels, toasts, order-detail text) was translated normally — confirmed via grep those aren't matched anywhere. Also confirmed `order.note` (line 877) has no exact-match consumer anywhere in the repo (only ever rendered as free text or fuzzy-searched) — translated.

`components/phone-character-app.tsx` — **done**, ~130+ strings translated, zero Chinese remains, `npm run build` passes. No protocol/content-matching exceptions (checked `CHAR_BLOCKED_FIELDS` comparison — that's an English constant from `lib/character-storage.ts`, unrelated). Both `notifyMascotPageContext` labels translated per the new standing rule above.

`components/settings/voice-settings.tsx` — **done**, ~124 strings translated across two sub-agent sessions (first one dropped mid-task on an API connection error at ~76/124 lines remaining — resumed via `SendMessage` to the same agent, which picked up cleanly with no rework/duplication), `npm run build` passes. Left in Chinese (functional, not display text): `MINIMAX_PREVIEW_TEXT` dictionary (lines 96-137) — a language→native-sample-sentence map sent directly to the TTS API to preview each voice, e.g. `Chinese: "你好，很高兴认识你。..."`, `"Chinese,Yue": "大家好，我而家用紧粤语..."` (line 97-98), plus every other language's own native sentence (French in French, Japanese in Japanese, etc., untouched already). Translating the Chinese entries would make a "preview Mandarin voice" action speak English instead — same underlying principle as the protocol-string rule (functional content consumed elsewhere) even though it's not a bracket-tag/field-match case.

`components/memory/memory-bank-page.tsx` — **done**, ~50+ strings translated, `npm run build` passes. Discovered `lib/memory-types.ts` exports real AI system prompts (`DEFAULT_SUMMARIZATION_PROMPT`/`DEFAULT_CORE_MEMORY_PROMPT`) — added to the protected-files list above. This `.tsx` file only references them by identifier (fallback values / equality checks), never echoes the actual prompt paragraph text, so nothing needed to be left in Chinese here. Remaining Chinese (6 lines) is all developer comments, out of scope.

`components/diary/note-wall-app.tsx` — **done**, 105 strings translated, zero Chinese remains, `npm run build` passes. No protocol/content-matching exceptions — `FONT_LABELS` display text (喜脉/小纸条/汇文) is keyed by plain-ASCII font IDs (`huangyou`/`shangshangqian`/`huiwen`) that drive actual matching, so the Chinese was pure display text.

`components/settings/preset-manager.tsx` — **done**, ~90+ strings translated, `npm run build` passes, all 3 `notifyMascotPageContext` labels translated. Two cross-file protocol blocks confirmed and left in Chinese: (1) `MARKER_NAMES` dict (lines 64-70,73) — marker labels like `"◇ 用户人设"`/`"◇ 世界书（角色前）"` matched via `matchMarkerByName()` against `prompt.name`, with the exact same strings hardcoded in protected `lib/builtin-preset.ts` (as `name:` fields) and referenced in `lib/mascot-prompts.ts`/`lib/mascot-tools.ts`; (2) `MASCOT_PRESET_STORAGE_TOOL_NAMES` set (lines 86-93) — tool-call names like `"创建剧情预设"`/`"克隆内置预设"` compared via `.has(field)`, matching literal mascot-tool `name:` values in `lib/mascot-tools.ts`.

`components/calendar-app.tsx` — **done**, ~90 strings translated, `npm run build` passes. No protocol/content-matching exceptions. One line left untouched by design: line 183 code comment `// Listen for live CSS updates from 小卷` — "小卷" is the mascot's proper name, consistent with the same pattern already left alone in `components/phone-theme-app.tsx:913`.

**Batched small files (<15 Chinese-containing lines each) — 38 files across 4 parallel sub-agents, all done, `npm run build` passes for the combined set:**
- Batch 1 (9 checkphone pages: bilingual-text, debug-error-card, instagram/notes/reddit/shopping/telegram/x/youtube-page) — left in Chinese: data-parsing regexes matching AI-generated content from `lib/checkphone-engine.ts` (`checkphone-x-page.tsx:73,148,149` — placeholder-handle/join-date parsing; `checkphone-youtube-page.tsx:104-106,114` — duration-unit/finished-watching parsing; `checkphone-shopping-page.tsx:90` — currency-symbol stripping).
- Batch 2 (world-builder/ImportModal+ModelPalette+SceneSaveLoadModal, reading-app, reading-pdf-viewer, vn-chapters, character/relation-dialogs) — `ImportModal.tsx`/`ModelPalette.tsx` category sentinels (`"导入"`→`"Import"`, `"自定义"`→`"Custom"`, `"全部"`→`"All"`) confirmed self-contained and translated consistently on both definition and comparison sides. `vn-chapters.tsx`: removed the now-dead `numberToChinese()` helper and simplified chapter titles from `第N章` to `Chapter N` — confirmed zero other references repo-wide before removing.
- Batch 3 (settings/about-declaration+preset-list+prompt-modal+regex-list+worldbook-list, ui/css-import-button+css-scheme-picker+form+modal+page-shell+story-html-renderer) — no protocol exceptions, all pure UI chrome.
- Batch 4 (android-fullscreen, chat-plugin-bootstrap, diary-app, icon-glyph, main-app, map-renderer, map-text-stream, music/mini-app-window+music-player, phone-placeholder-app, phone-resources-app) — `main-app.tsx:54-56` font paths (`/fonts/字体/MISANS-*.woff2`, written as `字体` unicode escapes) left untouched — confirmed via `styles/widgets.css` this is a real on-disk directory name loaded by `@font-face`, translating would 404 the fonts. `music-player.tsx`'s `musicToast` producer/consumer pair (self-contained, "加载音乐中..." → "Loading music...") translated consistently. `map-text-stream.tsx`'s `ADVENTURE_THEMES` names confirmed consumed only by array index elsewhere, safe to translate.

One bug already hit and fixed: a sub-agent once wrote smart/curly quotes (`"` `"`) instead of straight `"` as JSX attribute delimiters, breaking the build. After any batch of edits, always run `npm run build` and grep the touched files for `[\u201c\u201d]` before moving on.

`components/settings/data-management.tsx` \u2014 **done**, ~140+ strings translated, zero Chinese remains, `npm run build` passes.

**Process change (user decision, 2026-07-28):** starting this round, dispatch one large file solo + several medium files (<50 Chinese lines) as parallel batches, every turn \u2014 don't ask per-file, only ask when a genuine protocol-string judgment call needs a decision. Report progress per batch.

`components/phone-theme-app.tsx` \u2014 **done**, ~95 strings translated, `npm run build` passes. Gotcha: ~15 strings were written as JS `\uXXXX` escape sequences instead of literal Chinese characters, so they didn't show up in the initial `[\u4e00-\u9fff]` grep \u2014 caught via a supplementary `\u[4-9a-f][0-9a-f]{3}` (CJK-range only) grep; **use this escape-sequence grep on every file from now on, not just the CJK-literal grep**, since a plain smart-quote/Chinese-literal check would have missed this. Left in Chinese: line 914 comment `// ... \u5c0f\u5377 ...` (mascot name), same precedent as `calendar-app.tsx`.

**Batch A (6 files)** \u2014 `checkphone-takeout-page.tsx`, `vn-player.tsx`, `memory-timeline.tsx`, `settings/image-generation-settings.tsx`, `checkphone-douyin-page.tsx`, `settings/user-identity.tsx`, all done, `npm run build` passes. Heavy protocol findings:
- `checkphone-takeout-page.tsx`: `TAKEOUT_TABS` (\u7f8e\u98df/\u996e\u54c1/\u5546\u8d85/\u836f\u54c1/\u5176\u4ed6) is an exact duplicate of `CHECKPHONE_TAKEOUT_CATEGORIES` in `lib/checkphone-engine.ts`; `"\u5168\u90e8"` filter sentinel; `order.status === "\u5df2\u5b8c\u6210"/"\u5df2\u53d6\u6d88"` (status parsed from AI content via `fields["\u72b6\u6001"]`) plus their echoing display strings \u2014 all left in Chinese.
- `checkphone-douyin-page.tsx`: `formatProfileHandle`'s `"\u6296\u97f3\u53f7"` prefix-check (both `.startsWith()` and template literal) \u2014 matches `lib/builtin-preset.ts`'s taught AI output format and `lib/checkphone-engine.ts:3404`'s `profileFields["\u6296\u97f3\u53f7"]` parser. Left in Chinese.
- `memory-timeline.tsx` \u2014 the densest protocol file found yet: bracket-tag regexes matching `[\u79c1\u804a...]`, `[\u7fa4\u804a\u300c...\u300d...]`, `[\u670b\u53cb\u5708...]`+`\u53d1\u4e86\u4e00\u6761\u52a8\u6001`, `[\u7167\u7247:...]`, `[\u8868\u60c5:...]`, `[\u97f3\u4e50\u5206\u4eab:...]`, `\u56de\u590d`-prefix, plus tag-comparison literals `\u804a\u5929`/`\u7fa4\u804a`/`\u5267\u60c5`/`\u6f2b\u5377`/`\u5192\u9669`/`\u7ebf\u4e0b`/`\u4e8b\u4ef6`/`\u5185\u5fc3`/`\u5c0f\u5267\u573a`/`\u68a6\u5883`/`\u8dd1\u56e2\u6e38\u620f`/`\u5c0f\u6e38\u620f`/`\u65e5\u8bb0`/`\u4fbf\u7b7e\u5899`/`\u5c0f\u7ea2\u4e66`/`\u67e5\u624b\u673a`/`\u8bbf\u8c08`/`\u5171\u521b`/`\u8bc4\u8bba`/`\u8868\u60c5\u5305`/`\u56fe\u7247`/`\u8bed\u97f3`/`\u89c6\u9891`/`\u7ea2\u5305`/`\u8f6c\u8d26`/`\u4f4d\u7f6e`/`\u97f3\u4e50` (all inside content-stripping/tag-matching regexes) \u2014 this is the app-wide chat/memory bracket-tag protocol, all left in Chinese; only their *display-label* counterparts (badges shown to the user, not the comparison target) were translated where the two were distinguishable.
- `user-identity.tsx` \u2014 **new cross-file exception**: the gender value `"\u4fdd\u5bc6"` (undisclosed) is compared via `!==` in `lib/llm-prompt-assembler.ts:314`, `lib/calendar-engine.ts:49`, `lib/custom-app-host-api.ts:638` to decide whether to include gender in AI prompts. Left `"\u4fdd\u5bc6"` in Chinese (both `DEFAULT_IDENTITIES` and the `<select>` option value) with an inline comment explaining why; translated its *display label* to "Prefer not to say" and translated the non-compared `\u7537`/`\u5973`/`\u5176\u4ed6` to `Male`/`Female`/`Other` normally.

**Batch B (6 files)** \u2014 `reading/reading-shelf.tsx`, `vn/vn-asset-page.tsx`, `dwelling/room-view.tsx`, `dwelling/dwelling-app.tsx`, `checkphone/checkphone-steam-page.tsx`, `vn/vn-select.tsx`, all done, `npm run build` passes, zero Chinese remains in any of the 6. No protocol exceptions \u2014 `dwelling/` was checked extra carefully per the CLAUDE.md flag (likely spot for transfer/red-envelope/call protocol content) but found clean, pure room/furniture/exploration UI copy. `vn-select.tsx` translated local "\u6f2b\u5377" (Visual Novel feature name) occurrences to "Visual Novel" \u2014 verified via diff these are plain descriptive UI strings ("Manage sprites...", button labels), unrelated to `memory-timeline.tsx`'s `tag === "\u6f2b\u5377"` comparison (different producer, no cross-file conflict). Self-contained `busy` state sentinel system (9 labels set via a local `runAction(label, ...)` helper, compared elsewhere in the same file) translated consistently on both producer and consumer sides. This session hit the API-disconnect issue twice now (also happened on `voice-settings.tsx`) \u2014 second time it left behind smart/curly quotes mid-edit (the actual gotcha, not just lost progress); caught via the standard smart-quote grep, fixed manually before resuming the agent via `SendMessage`. **Takeaway: after any agent reports a `failed`/disconnect status, always grep for smart quotes before resuming \u2014 don't assume a disconnect only means "incomplete," it can also mean "malformed."**

## Milestone: `components/` (excluding `chat/`) is effectively DONE as of round 3 (2026-07-28)
Live re-check (`rg -c "[\x{4e00}-\x{9fff}]" components --glob '!components/chat/**'`) shows the highest remaining counts are all either (a) `.ts` files, out of scope per the scope note above (`world-builder/scene-store.ts`:49, `model-optimize.ts`:14, `debug-prompt-registry.ts`:10, `scene-db.ts`:7, `model-db.ts`:4, `thumbnail-generator.ts`:2), or (b) already-translated files showing only their documented intentional protocol leftovers (`checkphone-chat-page.tsx`:38, `map-view.tsx`:34, `memory-timeline.tsx`:30, `app-market-app.tsx`:21, `widget-renderer.tsx`:16, and ~25 more files each ≤14 lines — all previously logged above). **No `.tsx` file under `components/` (excluding `chat/`) has unaddressed Chinese UI text left.**

## `app/**/*.tsx` — DONE (2026-07-28)
All 5 files (`verify/page.tsx`, `verify/admin/page.tsx`, `app-market/admin/page.tsx`, `verify/verification-applications-closed.tsx`, `characters/page.tsx`) translated in one batch, zero Chinese remains in any of them, `npm run build` passes. No protocol/content-matching exceptions — these are admin/verification pages with no chat-protocol or AI-content-parsing involvement.

## MILESTONE: the entire planned `.tsx` UI-text scope (`components/` excluding `chat/`'s pending mascot label, plus `app/`) is now complete.
Everything under "Still open / not yet done" below is what remains before this project is fully wrapped.

## PHASE 2 (started 2026-07-28): the protected AI PROMPT/PROTOCOL files
Split into two tracks by user decision:
- **Track 1 — prose/instruction text**: translate the explanatory paragraphs, rules, role descriptions and tone guidance inside the protected files, while leaving every bracket-tag token and every regex-matched literal in Chinese. Low risk, build-verifiable. **Running now.**
- **Track 2 — the protocol tokens themselves**: user chose a **backward-compatible dual-recognition migration** (parsers accept Chinese legacy **and** English going forward; producers switch to English; old stored history must keep rendering, never rewritten). Full inventory (~50 tag variants / 10 families), file matrix and phased work order live in **`PROTOCOL-MIGRATION-PLAN.md`** at the repo root. **Awaiting user review before any protocol edit.**

### Track 2 progress
**Phase A1 — `lib/rich-message-parser.ts` dual-recognition: DONE.** Purely additive; `npm run build` + `npx tsc --noEmit` both clean (zero errors in this file). Every tag now accepts a legacy Chinese token **and** a going-forward English token:
- Alias consts at the top (`T_RED_PACKET`, `T_TRANSFER`, `T_PAYMENT_REQUEST`, `T_GIFT`, `T_CONTACT_CARD`, `T_PHOTO`, `T_LOCATION`, `T_STICKER`, `T_QUOTE`, `T_MUSIC`, `T_MUSIC_SHARE`, `T_VOICE_NOTE`) + exported `BLOCK_TAG_STATUS_PANEL` / `BLOCK_TAG_INNER`.
- Sentence-form tags (poke, calls, accept/decline, group-admin) got an English alternation **inside the same regex, preserving capture order** — `build()` bodies read `(m[2] || m[3])` where the two languages capture into different slots. Chinese branches are textually unchanged.
- Mute is the exception: English forms are **separate array entries** rather than merged, so the number/unit capture arity stays identical on both sides. Verified `[A muted B: 30 minutes]` cannot collide with `[A muted B for 30 minutes]` (name captures exclude colons).
- `parseMuteMinutes` now also understands `day(s)`/`hour(s)`; Chinese `天`/`小时` comparisons kept first and unchanged.
- `extractBracketBlock` takes `string | string[]` and uses a **backreference** so `[状态栏]…[/StatusPanel]` is correctly rejected.
- `useReferenceImage` accepts `使用参考图` or `WithRef` (case-insensitive).
- The `[引用:…]` / `[表情包:…]` preprocessing regexes in `parseAIResponse` were converted to `new RegExp` with the alias consts too — easy to miss, they live outside `RICH_PATTERNS`.

**Verification method worth reusing:** `node_modules/.bin/jiti` is present, so the real `.ts` parser can be imported and exercised from a plain Node script without a test runner. A 45-case fixture (one Chinese + one English input per tag, asserting identical `mediaType` and `mediaData` fields, plus the mismatched-block-alias rejection) passed **45/45**. Recreate it any time from the case table in `PROTOCOL-MIGRATION-PLAN.md`; extend it at each later phase.

**Phase A4 — guard lists: DONE.** `npm run build` clean, 11/11 fixture.
- `lib/state-value-parser.ts` `RICH_MEDIA_NAMES` gained the 12 English tag names. Needed because the state-value regex `\[name:number\]` would otherwise eat numeric-payload tags like `[Sticker:11]` / `[Music:5]` exactly as it would have eaten `[表情包:11]`. Verified both languages are skipped and that a genuine `[好感度:72]` still parses.
- `lib/custom-app-chat-directives.ts` `BUILTIN_DIRECTIVE_LABELS` gained all 19 English names so a user custom-app can't register a label that shadows a built-in tag.
- **Small pre-existing gap fixed while there**: `名片` (contact card) was a built-in rich pattern but was **missing from the reserved list**, so a custom app could register it. Added `名片` + `ContactCard`. Effective behaviour barely changes (on an index tie `findBuiltInRichCandidate` already won over the custom-app candidate, so such a directive was registered-but-shadowed); this just makes it an explicit rejection at registration time instead. Flagging in case any existing user app registered `名片`.
- Residual, unchanged from before: both guards are **case-sensitive exact matches**, so `transfer` (lowercase) still isn't reserved — same as the pre-existing Chinese behaviour, not a regression.

**Phase A2 — `lib/action-parser.ts`: DONE.** 19/19 fixture + 21/21 A1/A4 regression, build clean. This one needed more than regex work, because the tag name is a **runtime discriminator**, not just a match:
- `ActionTag.type` feeds `switch (action.type)` in the dispatcher, and `collectActionBlocks` builds the closing tag from it (`[/${type}]`). So "accept English" had to separate **matched alias** from **canonical type**.
- Solution: `parseActionHeader` now returns both — `type` = **canonical Chinese** (so the switch and every downstream consumer are untouched) and `rawTag` = the alias as actually written (used to build the closing tag). `rawTag` is destructured off before the object is pushed, so the exported `ActionTag` shape is unchanged.
- Confirmed first via grep that `ActionTag.type` is consumed **only inside this file** — `chat-engine`, `group-chat-engine`, `moments-engine`, `chat-room.tsx` only use `cleanText` and pass `actions` opaquely to `dispatchActions`. That's why the canonical-Chinese approach costs zero external edits.
- Aliases: 朋友圈=Moments, 群消息=GroupMessage, 评论=Comment, 回复=Reply, 消息=Message, 私信=DirectMessage. Matching is by `startsWith` on a flat list **sorted longest-first**, which is what stops `消息` shadowing `群消息` (and `Message` shadowing `GroupMessage`/`DirectMessage`). Stable sort ⇒ original Chinese ordering preserved exactly. All three shadowing cases are covered by the fixture.
- Open/close must use the **same** alias — `[Moments]…[/朋友圈]` does not pair (fixture-checked).
- `KNOWN_ACTION_TAGS` (empty-shell filter) gained the 6 English names + `AddFriend`; it uses a backreference so open/close still have to match.
- Note `dispatchMomentsPost` re-wraps content as `[朋友圈]…[/朋友圈]` for `parseMomentPostResponse` (in `lib/moments-engine.ts`, out of scope) — correct as-is, because `action.type` is canonical Chinese.

**Phase A3 — `lib/text-tool-protocol.ts`: DONE.** Trivial by comparison: two regexes gained an English alternative — `获取指令|获取工具` → also `FetchTool`, and `执行动作|工具调用` → also `CallTool`. Fixture covers both Chinese aliases and the English form producing identical spans/output, plus a negative case (`[note]` left untouched).

**Phase A is now complete** (A1, A2, A3, A4). Every parser accepts both languages; nothing emits English yet, so there is still zero user-visible change.

**Phase B — read side bilingual: DONE.** 18/18 call fixture + 14/14 A-regression, build clean.

New shared module **`lib/call-tag-patterns.ts`** is now the single source of truth for reading call system-message tags. It existed because `chat-storage.ts` (`getChatMessagePreview`) and `chat-room.tsx` (`formatSysMsgForUI`) had **two parallel copies** of the same five regexes — exactly the "missed a site" failure mode this migration is built to avoid.

Key design decision — **matchers normalise back to the canonical Chinese label**. If they simply accepted English, `[I started a voice call with X]` would yield `callType = "voice call"` and flow into the existing Chinese display template, producing mixed-language output like `你向X发起了voice call`. Instead every matcher returns `callType` as the canonical Chinese string regardless of input language, so all display templates work untouched and output is byte-identical to before. Same "canonical internal value" pattern used in A2.

**A real protocol asymmetry the fixture caught** (would have been a silent bug): for *initiate*, group-ness lives in the **target** (`target === 群聊`, call type has **no** `群` prefix — `group-call-screen.tsx:154` emits `[我向群聊发起了语音通话]`), but hangup/reject/cancel put `群` **on the call type** (`[我挂断了群语音通话]`). The first English matcher wrongly applied the `群` prefix for initiate; now the call type is always built ungrouped there and group-ness is normalised into the target. Documented in the module.

Sites updated:
- `lib/chat-storage.ts` — both call paths in `getChatMessagePreview` (the `msg.role === "system"` branch and the role-agnostic one) now use the shared matchers.
- `components/chat/chat-room.tsx` — `CALL_SYS_RE`/`isCallSysMsg`/`canCarryFoldedPanel` now use `isCallSystemContent`; `formatSysMsgForUI` switched from `.replace(regex, cb)` to matcher + `replaceRaw` (a literal-safe replace, since `String.replace` would interpret `$&`/`$1` in the replacement — fixture-guarded).
- `components/chat/message-bubble.tsx` — `normalizeTextBubbleContent`'s four marker-stripping patterns gained English aliases (`Music`/`MusicShare`, ` poked `, `FetchTool`, `CallTool`).
- **`voice-call-screen.tsx:166` and `video-call-screen.tsx:272`** — two extra read sites the plan had missed: remount-dedupe guards doing `lastMsg.content.includes("发起了语音通话")`. Left un-bilingual, these would have double-inserted a call system message once producers emit English.

**Scope correction:** `lib/llm-prompt-assembler.ts` was listed as B4 but is **write-side only** — it builds tags from `mediaData` via a `switch (mediaType)` and never parses them. Moved to Phase C. `chat-message-list.tsx` also turned out to have no protocol reads. A repo-wide sweep for read-side matching found nothing else.

**Verification tip:** `jiti` needs `{ jsx: true }` to load `.tsx` files — that's how `message-bubble.tsx` is exercised directly instead of testing a copy of its regexes.

**Still Chinese, by design:** the call *display* strings themselves (`你向X发起了语音通话`, `你挂断了…`) are still Chinese in both `chat-storage.ts` and `chat-room.tsx`. That is Phase-1 UI text deliberately deferred, and it is **independent of this migration** (terminal render text, never re-parsed — verified). Translating it is a standalone cleanup that can be done at any time; doing it during Phase B would have made a matching regression indistinguishable from a rendering one.

**Phase C1 — `lib/group-admin.ts` producer flipped to English: CODE DONE, awaiting manual smoke test.** 27/27 round-trip fixture, build + tsc clean.

Only `buildGroupAdminBracketText` was flipped — that is the protocol producer, consumed by `lib/llm-prompt-assembler.ts:1386` and `lib/short-term-assembler.ts:211` to build **AI prompt context**. `buildGroupAdminNoticeText` (the user-visible notice text used by `chat-room.tsx` and `chat-settings-panel.tsx`) was deliberately left in Chinese — it is display text, same deferred-UI category as the call display strings.

**Consequence worth knowing:** the bracket text is *not stored*; it is regenerated from `mediaData` on every prompt build. So **existing** group-admin messages also start appearing as English tags in AI context — which is what we want (one consistent language in context), and is safe because the legacy Chinese forms stay permanently parseable.

Added `formatMuteDurationLabelEn()` — unit words constrained to what the parser accepts (`minute(s)`/`hour(s)`/`day(s)`), with correct singular/plural.

`transfer_owner` where actor === target emits `[X reclaimed group ownership]`; as in the Chinese original this is deliberately **not** a protocol action (no parser pattern matches it), just a factual statement for context.

**Round-trip fixture** is the strongest automated check available here: for all 7 actions × mute durations it runs producer → `parseAIResponse` → asserts `mediaType`/`adminAction`/`adminActorName`/`adminTargetName`/`adminMuteMinutes`, and separately re-asserts that all 8 legacy Chinese forms still parse. That mechanically proves producer/parser agreement; only in-app rendering needs a human.

**Expected observable change from C1: none in the UI.** Display text is unchanged; only the AI's context changes. During the C→D window the AI is still *taught* Chinese while seeing English tags in history — harmless, since both are parsed (it may start mimicking English, which is fine and in fact the goal).

**C1 manual smoke test: PASSED** (2026-07-29). Debug prompt panel confirmed English tags in AI context (`[User removed John Logan from the group]`); in-chat notice stayed Chinese as designed.

**Phase C2 — call tags (family 2) flipped to English: CODE DONE, awaiting manual smoke test.** 37/37 round-trip fixture, build + tsc clean.

**Builders added to `lib/call-tag-patterns.ts`** (`buildCallInitiateTag`, `buildCallInitiateGroupTag`, `buildCallInitiateNoTargetTag`, `buildCallHangupTag`, `buildCallRejectTag`, `buildCallCancelTag`). Every producer now goes through them — no hand-written tags anywhere — so emitted wording can't drift from what the matchers accept. Same lesson as Phase B's duplicated regexes.

**The plan under-counted this family.** It listed "call screens + desktop-shell"; the actual sweep found **15 producer sites across 7 files**, including three the plan missed:
- `lib/follow-up-service.ts:645-647` — AI-triggered call, writes a *stored* system message (both `content` and `rawResponseText`).
- `lib/short-term-assembler.ts:360` — regenerates the tag for prompt context.
- `components/chat/chat-room.tsx:4175,4178` — regenerates it when building prompt parts.

Those last two are regenerated-not-stored, like the C1 group-admin case, so old call messages also start showing as English in AI context. Correct and intended.

Sites flipped: `voice-call-screen.tsx` (initiate/hangup/reject/cancel), `video-call-screen.tsx` (same four), `group-call-screen.tsx` (same four, group variants), `desktop-shell.tsx` (group initiate, 1:1 initiate, reject), plus the three above. The two stale `// must stay in Chinese, do not translate` comments in `desktop-shell.tsx` were replaced with "always build via `lib/call-tag-patterns.ts`".

**Fixture covers** all 6 builders → detector; 12 builder→matcher round trips asserting the canonical **Chinese** `callType` is still what comes back (so display templates are untouched); duration survival; that initiate tags still produce `voice_call`/`video_call` mediaType while the no-target form deliberately does not (mirroring Chinese behaviour); and 7 legacy Chinese forms still parsing.

**Expected observable change: none in the UI.** Call bubbles/previews still render Chinese display text; only the stored tag and AI context change.

**C2 manual smoke test: PASSED** (2026-07-29). 1:1 and group calls normal, notices still Chinese, no duplicate system messages, duration visible.

**Phase C3 — rich-media tags flipped to English: CODE DONE, awaiting manual smoke test.** 48/48 round-trip fixture, build + tsc clean.

**New module `lib/rich-tag-builders.ts`** — the write-side counterpart to `rich-message-parser.ts`. The same tag formats had been hand-written in **three** places (`llm-prompt-assembler.ts` once, `short-term-assembler.ts` twice, with subtly different conditionals — e.g. the group block emits the 3-arg red packet, the 1:1 block never does). All producers now route through the builders, and each call site keeps its original conditional so behaviour is preserved exactly.

Covered: red packet (2/3-arg), transfer (1:1/group), gift, contact card, voice note, location, sticker, quote, music, music share, poke (group + self), photo (`WithRef`/`NoRef`), the 6 bare accept/decline tags, the 6 group accept/decline forms with claimer+owner, and the `[StatusPanel]`/`[InnerThoughts]` block builders.

**Deliberate scope line — tag NAMES only.** Default payload labels (`恭喜发财`, `转账`, `礼物`, `联系人`, `语音消息`, `表情`, `贴纸`, `未知歌曲`) stay Chinese for now, so output like `[RedPacket:100:恭喜发财]` is expected and valid (the parser treats the label as free text). Those are *content* — `恭喜发财` is a culturally specific red-envelope blessing — so their wording deserves a deliberate decision rather than a mechanical rename. That is Phase C4.

**Read-side gap that C3 itself created, found by the post-edit sweep:** `replacePhotoDirectiveDescription` (`lib/chat-storage.ts:1688`) rewrites a photo tag inside **already-stored** text when the user edits an image description. It only matched `[照片:…]`, so once producers emit `[Photo:…]` it would have silently stopped working — no error, the edit just wouldn't apply. Now matches both **and rewrites back in whichever language it found**, so editing an old message can't silently switch its tag language. Same treatment for `checkphone-engine.ts:938`'s sticker-label read.

**Left alone, on purpose:**
- `MEDIA_PREVIEW_MAP` (`chat-storage.ts:273-281`) — `[红包]`, `[转账]` etc. are argument-less **display previews**, never parsed. Worth knowing they *do* reach an AI: `checkphone-engine.ts:930,942` feeds them into the checkphone prompt as descriptive text. Still display-category (deferred UI text), not protocol.
- `custom-sticker-storage.ts:260` `getCustomStickerExample` — returns `[表情包:name]` as a **format example shown to the AI**. That is teaching-layer content, so it flips in Phase D together with `builtin-preset.ts`; flipping it now would just make the teaching internally inconsistent.
- `chat-room.tsx:4218` poke — `${sender} 拍了拍 ${target}` with no brackets is stored natural-language display text, not a tag.

**C3 manual smoke test: PASSED** (2026-07-29). Media/red-packet/transfer normal; photo-description edit correctly regenerated with the new description (confirming the `replacePhotoDirectiveDescription` fix); red-packet blessings that the AI actually wrote stayed Chinese, as expected.

### The reported "`Transfer` label turns into `留言`" bug — diagnosis, not a Phase-1 miss
Worth recording because the intuitive fix would have been wrong. A repo-wide search found **`留言` in zero UI files**. The UI is correct: `message-bubble.tsx:690,1697` render `{d?.label || "Transfer"}`. The Chinese came from two different places:
1. **`留言` literally** — `lib/builtin-preset.ts:407` teaches the AI `【格式】[转账:金额:留言]`, where `金额`/`留言` are *placeholders* ("amount"/"message"). The model sometimes copies the placeholder word verbatim instead of substituting a real note, so `mediaData.label` becomes the literal string `留言` and the UI faithfully renders it. **Fixable only in Phase D**, by translating the teaching prompt.
2. **`转账` as the label** — the parser's own default when the AI sends an empty note (`[转账:100:]`). **Fixed in C4 below.**

There was no UI string to fix. Lesson: when Chinese shows up in the UI at this stage of the project, check whether it is *AI-authored content* before assuming a missed translation.

**Phase C4 — default payload labels: CODE DONE, awaiting manual smoke test.** 18/18 fixture, build + tsc clean.

**No wording decision was needed after all** — Phase 1 had already shipped English fallbacks in `message-bubble.tsx`, so C4 just mirrors them exactly, and a message's stored label now matches what the UI would have displayed anyway. Constants live in `lib/rich-tag-builders.ts` with the source line noted next to each: `Best wishes and good fortune` (red packet), `Transfer`, `Payment Request`, `Gift`, `A Thoughtful Gift`, `Contact`, `Voice Message`, `Location`, `Sticker`, `Unknown Song`, `Image`, plus `Character Gift` for the gift merchant label (no UI precedent; distinguished from the shopping-order case).

Also flipped the custom-app directive defaults in `rich-message-parser.ts`: `待确认`→`Pending`, `查看`→`View`, and the `参数N` arg labels → `argN`. **`{{参数N}}` remains registered as a token alias forever** (marked LEGACY in the code) — installed custom apps may still use it in their card templates.

`shopping-app.tsx:906` now imports `DEFAULT_PAYMENT_REQUEST_LABEL` instead of hard-coding the string, so the user-initiated and AI-initiated payment-request paths cannot drift apart.

Old messages keep whatever Chinese label they were stored with — the field is free text, so they render fine.

**C4 manual smoke test: PASSED** (2026-07-29).

**Phase D1a — the tag CONTRACTS in `builtin-preset.ts`: CODE DONE, awaiting manual smoke test.** 99/99 contract fixture + 9/9 moments fixture, build + tsc clean.

D was split rather than done in one pass: **D1a = the tag contracts** (mechanically verifiable, and what actually fixes the `留言` leak), **D1b = the remaining prose** (~2296 Chinese lines, for sub-agents), **D2 = mascot files**.

Translated: the 1:1 rich-media block (20 contracts), the group block (17), group-admin (7), the `[InnerThoughts]` block contract, and 3 Moments photo contracts. Also added an explicit line telling the model the lowercase words after a colon are **placeholders to replace, never to output literally** — a direct countermeasure to the `留言` bug.

**The verification approach that made this safe:** a fixture that (a) asserts each expected template literally appears in `builtin-preset.ts`, (b) feeds a concrete instance of it through `parseAIResponse` and asserts the right `mediaType`, (c) asserts the old Chinese contracts are **gone from the teaching**, and (d) asserts they still **parse**. That is a mechanical proof of teaching↔parser agreement, which no amount of reading could give.

**It immediately earned its keep — twice:**
1. It found 4 photo contracts I had missed, in the Moments/group-Moments blocks (different feature sections, easy to miss by eye).
2. Chasing those revealed **`lib/moments-engine.ts:1155-1164` has its own independent photo/block parser** that Phase A never touched. Teaching `[Photo:...]` while that parser only knew `[照片:...]` would have silently broken Moments photos. It is now bilingual (verified, including a mixed-language case), and was fixed **before** the teaching changed.

**Deliberately NOT changed — state value names** (`好感度`/`占有欲`/`焦虑值`, line ~380). These look like ordinary placeholders but are **not**: `mergeStateValues` merges by name, so renaming them would fork every character's existing state — the old Chinese-named values would freeze and new English-named ones would start from scratch. That is a data migration, not a translation. Left alone and flagged.

**Expected observable change: this is the first phase where AI behaviour genuinely shifts** — the model is now taught English tags. Since parsers accept both, worst case is cosmetic.

**Next: D1b** (remaining `builtin-preset.ts` prose — safe for sub-agents, no protocol risk left in it) then **D2** (`mascot-prompts.ts`, `mascot-tools.ts`, `custom-sticker-storage.ts:260`). Note `mascot-tools.ts` tool names are **code identifiers** matched by `preset-manager.tsx:86-93` — a separate rename track, not tag protocol.

---

## AUDIT (2026-07-29): the protected list was incomplete, and output language is a separate problem
Triggered by D1a smoke-test findings: AI-written transfer notes came back as `零花钱`, and a Moments caption as `出来浪啦～天气超好！`.

### Finding 1 — output language is NOT fixed by translating prompts
The app has a **bilingual output system** (`lib/bilingual-prompt-defaults.ts`, injected via `{{chatBilingualInstruction}}`, `{{momentsBilingualInstruction}}`, … at ~8 sites in `builtin-preset.ts`) whose entire design assumes **Chinese is the base language**:
- `"This rule only applies to non-Chinese output; Chinese text should be output normally"`
- `"（仅非中文角色使用，中文角色忽略此规则）"`
- output shape `原文|简体中文译文` — i.e. non-Chinese gets a **Chinese translation appended**.

So the system actively tells the model that Chinese output is the normal case needing no annotation. On top of that, character personas and chat history are user data and usually Chinese, and an LLM mirrors the language of the *content* far more strongly than the language of the *instructions*.

**Conclusion: no amount of prompt translation will make the model reply in English.** It needs (a) an explicit output-language instruction, and (b) the bilingual system inverted or made configurable, since as written it is an English→Chinese annotation feature. Both are **product decisions**, not translation work — do not silently bolt an "always respond in English" line into `builtin-preset.ts`; it would fight the bilingual rules injected right next to it.

### Finding 2 — ~25 prompt-building files were never on the protected list
Rule 2 only ever listed 8 files. The real set of files that ship Chinese instructions to an LLM (ordered by Chinese-line count):
```
checkphone-engine.ts 1166   internal-capability-storage.ts 582   map-rpg-engine.ts 363
css-examples.ts 360         xiaohongshu-engine.ts 231            xiaohongshu-types.ts 150
game-creator-guide.ts 137   interview-magazine-engine.ts 120     black-market-builtins.ts 108
shopping-engine.ts 100      chat-plugin-docs.ts 99               npc-generator.ts 83
chat-engine.ts 83           cocreate-engine.ts 79                builtin-phone-workflows.ts 78
group-chat-engine.ts 69     moments-engine.ts 66                 mascot-engine.ts 63
tool-prompt.ts 61           bilingual-prompt-defaults.ts 55      reading-engine.ts 26
calendar-engine.ts 24       black-market-scene-engine.ts 22      vn-engine.ts 9
story-engine.ts 6
```
**All of these are hereby added to the protected / Track-1 list.** Confirmed example: `moments-engine.ts:309,1498` sends `content: "请发一条朋友圈。"` as the user turn — which is why Moments captions come back Chinese regardless of `builtin-preset.ts`.

### Decisions taken 2026-07-29 (both implemented, build clean)
**Bilingual injection disabled app-wide.** `resolveBilingualPrompt` in `lib/bilingual-prompt-defaults.ts` is the single choke point for every bilingual path (chat, group, offline, moments, xiaohongshu, checkphone, adventure), so a `BILINGUAL_INJECTION_ENABLED = false` constant there kills all of them at once — including any user-saved custom bilingual prompt. Nothing was deleted; flip the constant back to restore. The prompt constants are kept. **If bilingual is ever wanted again it must be rewritten with the target language as a parameter** — as written it hardcodes "translate into Simplified Chinese".

**Global output-language rule added.** New preset entry `output_language_rule` in `lib/builtin-preset.ts`, registered first in `prompt_order`. It deliberately has **no `tags`**, which matters: the assembler only filters entries that *have* tags (`entryTags && !entryTags.every(...)` in `lib/llm-prompt-assembler.ts:799`), so an untagged entry reaches **every** surface — chat, group, offline, moments, xiaohongshu, checkphone, story, VN, adventure. That is why one entry is enough instead of editing ~19 injection sites. It also explicitly tells the model to keep reading other-language input normally, not to append translations, and not to touch structural markers.

These two had to land together — the old bilingual rules would have directly contradicted the new English instruction.

### ⚠️ The first D3 risk ranking was WRONG — corrected below
The original audit regex only looked for **method calls** against a Chinese literal (`.match(`, `.includes(`, …). It missed **`===` / `!==` comparisons** and **object lookups by Chinese key** (`fields["状态"]`), which are just as much a local parser. `calendar-engine.ts` was ranked "0 parsers, safe" and in fact had two: `parts[4] === "无"` and `identity.gender !== "保密"`.

Corrected detector (use this one):
```
rg -c '((match|test|replace|includes|startsWith|endsWith|split|indexOf)\([^)]*[\x{4e00}-\x{9fff}]|[!=]==\s*"[^"]*[\x{4e00}-\x{9fff}]|\[\s*"[^"]*[\x{4e00}-\x{9fff}][^"]*"\s*\])' <file>
```
Re-ranked (old → corrected): shopping-engine **0 → 15**, xiaohongshu-engine **1 → 38**, map-rpg-engine **2 → 20**, checkphone-engine **26 → 456**, cocreate-engine 0 → 2, npc-generator 0 → 1, group-chat-engine 6 → 8.

**Genuinely zero-parser files** (safe for straight prose translation): `story-engine.ts` (6), `vn-engine.ts` (9), `black-market-scene-engine.ts` (22), `tool-prompt.ts` (61), `interview-magazine-engine.ts` (120). — **all five now done.** Note that two of the five (`tool-prompt`, `interview-magazine`) still turned out to have coupling the file-local detector could not see: cross-file consumers and a KV-stored default respectively. "Zero parsers" ≠ "no lockstep".

`lib/cocreate-engine.ts` — **done**, build + tsc clean. Only two CJK strings remain, both deliberate: a comment naming the legacy close tag, and `[A-Za-z一-龥_]` in `peekStreamActionName`, which is a character class for **tool names** (still Chinese — that is the separate tool-name track). Archive/memory prompts parse ASCII XML tags (`chapter_summary`, `archive_note`, `memory_entry`), so no protocol change was needed there. `{{自己}}` in the memory prompt was verified **not** to be a real macro (absent from `macro-engine.ts`), so it was translated as plain prose. Both `simpleLLMCall` sites got a local output-language rule.

`lib/mascot-engine.ts` — **done**, 18/18 fixture, tsc exit 0. Three CJK strings remain, all deliberate: the mascot's name `小卷` (see below) and a comment documenting that `toolDisplayName` is still Chinese.

**The one real protocol string was a cross-file producer/parser pair, and it IS persisted.** `mascot-engine.ts:214` detected synthetic tool-result messages with `startsWith("以下是系统处理结果：")`, while the header had **two** producers: `mascot-engine.ts:135` and `tool-executor.ts:4219 formatToolResults` — the latter shared with `chat-engine` and `group-chat-engine`. Because that header is written into saved chat history, dual recognition here is a genuine migration, not just robustness (unlike `npc-generator.ts`, whose tags never persist). Now `tool-executor.ts` exports `TOOL_RESULT_HEADER` / `TOOL_RESULT_HEADER_LEGACY` / `TOOL_RESULT_HEADERS`; both producers emit the English form and the parser tests both.

Both protocol paths call `sendLLMToolStreamRequest` with a **null preset** (line ~641), so `output_language_rule` never reaches the mascot — and its persona prompt (`mascot-prompts.ts`, still Chinese, D2 pending) would otherwise steer every reply. Added `MASCOT_OUTPUT_LANGUAGE_RULE`, appended **after** the persona in both system prompts.

**Mascot name `小卷` deliberately NOT renamed.** It appears in 22 places across 11 files including `mascot-prompts.ts` and `mascot-tools.ts`, both still pending. Renaming it here alone would fork the mascot's identity across files — do it as one coordinated change when those two land.

`lib/desktop-config.ts` — **done** (opportunistic, outside D3): the `ICONS` registry supplying **home-screen app labels**. All 25 translated, 0 CJK, tsc clean. Note this is a *different* map from `CONTENT_APP_LABELS` in `settings-types.ts` (still Chinese, feeds only Binding Manager) — the two are easily confused because the label sets overlap. Labels here are display-only; comparisons everywhere use `icon.id`. One cosmetic side effect: `desktop-shell.tsx:3900` uses `customApp?.name || icon.label` as the `CustomAppGlyph` seed, so any app falling through to that generated-glyph branch will draw a different glyph than before.

### 🆕 NEW AREA FOUND (2026-07-29, user-reported): Widget Picker names — untouched by Phase 1
Every widget name and description in the Widget Picker is still Chinese (`AI助手`, `音乐播放器`, `在场摘录`, `情话便签`, `微空间动态`, the whole `自由 · …` freestyle set…). Phase 1 swept `.tsx` under `components/`, so this `.ts` registry was never covered — the same blind spot that hid `desktop-config.ts` and `CONTENT_APP_LABELS`.

**Scope: `lib/widget-types.ts` only — 31 catalog entries, 26 CJK lines.** Audited and **safe for straight translation**:
- `name`/`desc` are never compared anywhere; all logic keys off `type`.
- Saved layouts persist `type` + `id`, never `name` (`widget-storage.ts:19-21`), and `widget-storage.ts:35` migrates `fortune` → `interviewMagazine`, confirming `type` is the stable key.
- The group heading "Standard Kit" (`desktop-shell.tsx:4063`) is already English.

**⚠️ Two things in `components/widgets/widget-renderer.tsx` that must NOT be translated** (16 CJK lines, all in these two groups):
1. **Lines 181-555: asset filenames** — `/widgets/19老橙子素材.png` and 12 siblings. **All 13 files exist on disk with those exact Chinese names** (`public/widgets/`). Renaming the string without renaming the files breaks every freestyle widget image. If ever renamed, it is a coordinated file+code change, not a translation.
2. **Lines 1950-1961: deliberate decorative Japanese** — `光と影の交差点・1998`, `記憶の破片`, `夢を見ている`, styled with `fontFamily: "Noto Sans JP"`. This is design content in a Y2K-style widget, not UI text. Leave it.

### The mascot is a WIDGET first, not a floating icon (not a bug)
`mascot-float.tsx:1035` is `if (state === "widget") return null;`, and `mascot-state.ts:8` initialises `_state = "widget"`. The only transition to `"floating"` is `activateMascot()`, called from `widget-renderer.tsx:1360` when the user clicks the **mascot widget**. So with no mascot widget placed on the home screen, `MascotFloat` legitimately renders nothing and there is no way to summon it. Add the widget via the Widget Picker. Worth recording because "the mascot disappeared" looks exactly like a regression and is not one.

### Operational rule: do NOT run `npm run build` while the dev server is running
Production build writes to the same `.next/` the dev server serves from, replacing dev chunks with prod-hashed ones. The HTML still renders (so the splash looks normal) but **4 of 6 JS chunks and the stylesheet 404**, React never hydrates, `setHydrated(true)` never runs, and the splash enter button stays `disabled` forever. This was diagnosed the hard way after it broke the app twice. Compounding it, four orphaned `local-next-server.mjs --dev` processes were found alive but not listening — they kept rewriting `.next` after each cleanup. Recovery: kill **all** node processes for this project, `rm -rf .next`, start exactly one dev server, then hard-reload the browser (the service worker in `public/sw.js` is cache-first for `/_next/static/`).

`npx tsc --noEmit` gives the same type signal without touching `.next` — use it for verification instead.

`lib/widget-types.ts` — **done**: all 31 Widget Picker entries (`name` + `desc`) translated, 0 CJK, tsc clean. The two landmines in `widget-renderer.tsx` were verified untouched afterwards (13 asset filenames, 3 decorative Japanese strings).

`lib/chat-engine.ts` — **done**, 17/17 fixture, tsc exit 0. 83 CJK lines → 4, and those 4 are deliberate: the legacy recognition patterns inside `formatNativeUsageGuide` (`获取指令`, `执行动作指令`, `示例：`, and the legacy header), which must stay because `tool.usageGuide` is user data.

**Found a producer left behind by the tool-prompt phase.** `FETCH_RESULT_HEADER` was introduced then and the *consumer* (`formatNativeUsageGuide`, lines 1545-1548) was made bilingual — but three producers still emitted the Chinese header directly: `chat-engine.ts:2349` and `group-chat-engine.ts:866,877`. They now build from the constant, and both files import it. Same lesson as the `tool-executor` regression: **changing a protocol string means auditing every producer AND every consumer, not the one you happened to be editing.**

Two other cross-file strings translated in lockstep because they are produced in more than one place:
- `展开「X」动作说明` (native loader display name) — 5 sites in `chat-engine.ts`; display-only, never compared.
- `[对方没有回复你的消息…]` silence nudge — 4 sites in `chat-engine.ts` **plus 2 in `follow-up-service.ts`**; synthetic injection, never parsed. All 6 moved together.

`chat-engine.ts` reaches `assemblePromptPayload` and passes no null presets, so it needs no local language rule.

### 🚨 The `[InnerThoughts]` leak — why 1:1 leaked inner monologue and group chat did not
User reported inner thoughts leaking into visible 1:1 messages while **group chat with the same model was clean**, which disproved a "the model won't stop thinking" theory. The real cause was ours:

| path | taught tag | source |
|---|---|---|
| 1:1 | `[InnerThoughts]…[/InnerThoughts]` | `builtin-preset.ts:427` (translated earlier) |
| group | `[内心]…[/内心]` | `builtin-preset.ts:1022` (still Chinese) |

`lib/prompt-sanitizer.ts` — which strips these blocks **before a message is fed back into the prompt** — matched Chinese only. So in 1:1 the `[InnerThoughts]` block was never stripped, got replayed to the model as if spoken aloud, and the model started echoing its own monologue. Group chat was clean purely because its preset still emitted the tag the sanitizer knew. **Third instance of the same bug class** (after `tool-executor` and the `FETCH_RESULT_HEADER` producers): one side of a protocol moved to English, one consumer left behind.

Fix: `prompt-sanitizer` now builds its regexes from the bilingual `BLOCK_TAG_INNER` / `BLOCK_TAG_STATUS_PANEL` (`[状态栏]`/`[StatusPanel]` had the identical bug). The regex uses a backreference so `[内心]…[/InnerThoughts]` is not treated as a matched pair.

**Import-cycle trap avoided:** those constants live in `rich-message-parser`, but importing them there from `prompt-sanitizer` closes a cycle (`prompt-sanitizer` → `rich-message-parser` → `action-parser` → `follow-up-service` → `chat-engine` → `prompt-sanitizer`), which leaves the arrays `undefined` at module-init. They were moved to a new **leaf module `lib/block-tags.ts` with no imports**, re-exported from `rich-message-parser` for existing callers. Any future shared constant between these layers must go there, not into a parser module.

Note this stops the leak going forward only — already-polluted 1:1 history still contains the leaked text until it scrolls out of the context window.

### 🚨 THE REAL 1:1 LEAK: the model writes literal `<think>` into content, and nothing stripped it
Settled by hard evidence the user supplied — a browser console warning:
> `The tag <think> is unrecognized in this browser … at MarkdownTextContent (message-bubble.tsx:510)`

That proves literal `<think>…</think>` **text** reached ReactMarkdown (which runs with `rehypeRaw`, so raw tags hit the DOM). MiniMax M2 writes its reasoning inline in the content string, not only through the separate `reasoning_content` field.

**Correction to an earlier entry in this file:** I wrote that reasoning handling was "correct and symmetric" and treated it as ruled out. That was true of the *API field* only and was too broad a claim — it did not cover a model emitting literal tags inside content. Worse, an earlier pass had already observed that `<think>` stripping exists in `checkphone-json-repair`, `dwelling-engine`, `interview-magazine-engine` and `vn-parser` but **not** in `rich-message-parser`, and did not follow that up.

**Why group chat never showed it — incidental, not deliberate.** `parseGroupChatResponse` (`group-chat-engine.ts:143-152`) only appends a line to a segment once a `[Name]:` prefix has been seen; any line *before* the first prefix has `currentName === null` and is silently discarded. A `<think>` block at the top of the response is therefore dropped for free. The 1:1 path has no such gate.

Fix: `stripReasoningTags()` added to the leaf module `lib/block-tags.ts` and called from
1. `parseAIResponse` — **before** the ```html / `<style>` protection step, otherwise a reasoning block containing markup gets captured as a "real" HTML block and preserved;
2. `stripStateAndInnerForPrompt` — so leaked reasoning is not replayed to the model as if it had been spoken.

Handles `<think>`/`<thinking>`, attributes, any case, multiple blocks, an **unclosed opener** (cut-off stream → drop to end) and a **stray closer** (opener arrived in an earlier chunk). Does not touch `<thinker>`, the word "think", or unrelated angle brackets. 24/24 fixture including an end-to-end `parseAIResponse` assertion that state values and `[InnerThoughts]` extraction still work.

**User smoke test: PASSED (2026-08-01).** Generated a real Moments post — no `<think>` leak into the saved caption.

One insertion point covers every consumer: `chat-room`, `chat-storage`, `follow-up-service` and `weixin-bridge` all route through `parseAIResponse`.

### Contributing factor: a chain-of-thought instruction only 1:1 received
Found on the third pass, after the user pointed out that a *different app* using the same MiniMax M2 model does not leak — which correctly ruled out "the model can't disable thinking" as an explanation.

`chat_immersion_instruction` (tags `["chat","text"]`, so **1:1 only**) contained:
> `在你的思维链中，必须以{{char}}第一人称思考，做出符合其人设及现实逻辑的反应。`
> *("In your chain of thought, you must think in {{char}}'s first person…")*

`思维链` ("chain of thought") appeared in **exactly one place in the entire preset** — that line. **Group chat has no immersion entry at all**, so it never received it. That is the whole asymmetry: on a model whose reasoning cannot be switched off, instructing it to *think in first person as the character* turns the reasoning stream into in-character prose, indistinguishable from an inner monologue, which then surfaces as a stray bubble.

Rewritten to keep the in-character interiority but route it into `[InnerThoughts]` and forbid writing out a reasoning process. Entry fully translated.

**Two supporting changes in the same pass** (user-requested):
1. The 1:1 state-value instruction was calculation-flavoured — *"adjust in real time with this round's emotional swings (range 0-100)"* — while group's is declarative (*"inherit from current_state, updated by this round's interaction"*). Aligned to the group phrasing and added `【Rule】Output the final numbers only`, since a calculation framing invites the model to narrate the arithmetic.
2. Mixed-language section markers fixed: `【格式】`/`【示例】` → `【Format】`/`【Example】` (the surrounding entry already used `【Format】` 21×). Verified these markers are prompt-only and parsed nowhere.
3. Added a global `【No visible reasoning】` line to the output-structure block.

`BUILTIN_PRESET_VERSION` → **265**. 20/20 fixture. Only CJK left in the 1:1 surface is the three state-value names.

**Ruled out on evidence this pass** (worth not re-investigating): reasoning-field handling is correct and symmetric. `parseProviderResponse` (`llm-provider-adapter.ts:727`) pulls reasoning from the separate `reasoning_content`/`reasoning`/`thinking` fields and routes it to the `onReasoning` callback; the `<think>` prepend in `chat-engine.ts:926,1234` is gated on `includeReasoning`, which **only `story-engine.ts:156` sets**. Neither chat path folds reasoning into content.

### Earlier finding: the prompt also contradicted itself
The `prompt-sanitizer` fix was necessary but **was not the root cause**. User re-tested on a 100% fresh install with brand-new characters and zero history — the leak still happened on the first reply, which rules out history feedback entirely. Group chat, same model and same base preset, stayed clean.

The structural difference: **a preset "surface" is every enabled entry sharing a tag set, and the 1:1 surface disagreed with itself.**

| entry (both tagged `["chat","text"]`, so always sent together) | taught |
|---|---|
| `chat_output_format:427` — the 【Format】 spec | `[InnerThoughts]…[/InnerThoughts]` |
| `chat_optional_actions:925` — the 【完整示例】 worked example | `[内心]…[/内心]` |

The model saw the spec say one thing and the concrete example say another. Models weight worked examples heavily, and when the two conflict some output comes back **untagged entirely** — which then falls through the double-newline splitter and renders as a separate bubble. That is exactly the reported symptom. Group chat had no conflict after its own fix, which is why it was clean.

**A second, worse defect in the same entry:** `chat_optional_actions:902-905` opened with `[朋友圈]` and closed with `[/Moments]`. `action-parser` matches the closing tag against the opening `rawTag`, so that block could never parse — a half-applied translation that silently broke Moments posting from 1:1 chat.

Fixed both; `BUILTIN_PRESET_VERSION` → **263**; 29/29 fixture.

**New fixture concept worth reusing — "surface self-consistency".** Instead of checking one file, it reconstructs what the model actually receives (all enabled entries sharing a tag set, concatenated) and asserts:
1. the spec and the worked example teach the same tag,
2. no opener/closer language mismatch for any tag pair,
3. every taught bracket tag is one a parser accepts,
4. a taught block actually round-trips through `parseActionTags`,
5. state-value names survive.

**Lesson: translating a preset entry in isolation is unsafe.** Entries are assembled by tag, so the unit of correctness is the tag set, not the entry. Always translate every entry sharing a tag set together, and check the worked example — it is the part the model imitates.

### Group chat preset (`group_chat_format` + `group_chat_optional_actions`) — done
`BUILTIN_PRESET_VERSION` → **262**. 28/28 fixture, tsc clean. These are the two entries that govern normal group text chat, and they share tags `["group_chat","text"]`, so they are always injected together and had to move together — translating only the block the user pointed at would have taught `[CharacterName]:` and `[角色名]:` in the same prompt.

Moved to the English aliases every parser already accepts: `[CharacterName]:`, `[InnerThoughts]`, `[MusicShare]`, `[Moments]`, `[Comment]`, `[Reply]`, `[DirectMessage]`, `[Quote]`, `[A poked B]`. Verified against `action-parser`'s `ACTION_TAG_ALIASES` and `rich-message-parser`'s `alt()` pairs before changing anything. `{{当前日程}}` → `{{currentSchedule}}` (macro-engine already accepted both).

**`[好感度:X][占有欲:X][焦虑值:X]` deliberately NOT renamed** — `mergeStateValues` merges by name, so renaming forks every character's stored state. The fixture asserts they survive.

Still Chinese and untouched (different tags, so never co-injected with text chat): `group_voice_call_format` (voice), `group_video_call_format` (video), `group_chat_offline_format` (offline), `group_spectator_context`.

`lib/group-chat-engine.ts` — **done**, 20/20 fixture, tsc exit 0. 65 CJK lines → 7, all deliberate (legacy alternations in the financial stripper plus the `"无"` legacy schedule fallback). No preset bypass: every call passes a real preset and uses `assembleGroupPromptPayload`, so it receives `output_language_rule`.

**Three local parsers, and two were already broken by earlier translation work:**

1. **`stripGroupFinancialActionsForMetadataRepair` (lines 78-81) was Chinese-only** while the group preset — which I translated the day before — now teaches `[A claimed the red envelope from B]` etc. That function decides whether a block is metadata-only (`strip(text) === ""`) so it can be merged into the next block. With the English tag unmatched the test never returned `""`, the merge never happened, and the state/inner block rendered as a **stray bubble**. Now bilingual, mirroring `rich-message-parser:300-326`. **Fifth instance of "producer moved, consumer left behind".**
   - Also added payment-request stripping, which was missing entirely and caused the same failed merge. That is a deliberate behaviour fix, not a translation.
2. **The schedule sentinel was checking a value that is no longer produced.** Line 412 filtered `item.schedule !== "无"`, but `getCurrentCalendarScheduleForPrompt` returns **`"none"`** (`calendar-storage.ts:224,234`) since the calendar work. So `"none"` passed the filter and was injected into group prompts as if it were a real schedule (`Alice: none; Bob: none`). Now filters `NO_SCHEDULE` with the legacy `"无"` kept as a fallback. **Sixth instance** — this one caused by my own earlier calendar translation.
3. The sticker sentinel (`：无`) had its producer and consumer in the same function; both moved to a shared `NO_STICKERS` constant.

Fixture tests behaviour rather than strings: it runs all nine financial-tag variants through the real `parseGroupChatResponse` and asserts each produces **one** bubble, and it calls `getCurrentCalendarScheduleForPrompt` to confirm the sentinel the engine filters is the one the calendar actually emits.

**Still Chinese in the group feature** (different tags, never co-injected with text chat, so they only affect those modes): `group_voice_call_format`, `group_video_call_format`, `group_chat_offline_format`, `group_spectator_context` in `builtin-preset.ts`. Group voice/video/offline output will still be Chinese until those are done.

**Next up: `reading-engine.ts` (4).**, `chat-engine.ts` (3), `reading-engine.ts` (4), `group-chat-engine.ts` (8), `shopping-engine.ts` (15), `moments-engine.ts` (16), `map-rpg-engine.ts` (20), `xiaohongshu-engine.ts` (38), and `checkphone-engine.ts` (456) last. Add `brief-persona.ts`, `core-memory-builder.ts`, `chat-plugin-runtime.ts` and `reasoning-translate.ts` to the queue — the `simpleLLMCall` audit surfaced them and they were never on the D3 list.

### 🚨 REGRESSION SHIPPED IN THE `tool-prompt.ts` PHASE — found and fixed 2026-07-29
`tool-prompt.ts` was changed to teach `[FetchTool:…]` / `[CallTool:…]`, but **`lib/tool-executor.ts` could not parse either name.** Its two entry points hardcoded Chinese-only alternations:
```ts
parseToolFetches   : /…(?:获取指令|获取工具)[:：]…/g     // no FetchTool
parseToolCallAt    : /^(.*?)\s*(?:执行动作|工具调用)\s*[:：]\s*(.+)$/   // no CallTool
```
Meanwhile `text-tool-protocol.ts` (display stripping) *did* accept the English names. Net effect: a `[CallTool:…]` directive was **stripped from the visible reply and then silently never executed** — the worst possible failure mode, since nothing errors.

**Why the 14/14 tool-prompt fixture missed it:** it validated the teaching against the *stripping* parser, not the *executing* parser. A fixture that only proves "the template is recognized" proves nothing about which consumer recognized it. **Any future protocol change must assert against the parser that ACTS on the directive.**

Fix: `text-tool-protocol.ts` now exports `FETCH_DIRECTIVE_NAMES` / `ACTION_DIRECTIVE_NAMES` as the single source of truth, and all seven copies build their regexes from those. Six files were still Chinese-only and are now aligned: `tool-executor.ts`, `cocreate-engine.ts`, `cocreate-tools.ts`, `group-chat-engine.ts`, `mascot-engine.ts`, `notewall-utils.ts`. Covered by a 31/31 fixture that checks execution-parser recognition, stripping/execution agreement, that no file still hardcodes the alternation, and that no `${…}` was left inside a regex *literal* (where it would never interpolate).

**Process rule added:** when a protocol name changes, grep for **every** parser of that protocol, not just the one you changed. `rg '获取指令|执行动作|CallTool|FetchTool' -g '*.ts' -g '*.tsx'`.

### ⚠️ Detector gap #3: `matchAll` — the corrected detector is STILL incomplete
`npc-generator.ts` was ranked "1 parser", and that one hit was a false positive (`tags: ["配角"]`, a value being *written*). Its real parser is line 234:
```ts
const blocks = [...text.matchAll(/\[配角\]([\s\S]*?)\[\/配角\]/g)].map(m => m[1]);
```
The pattern `(match|test|replace|…)\(` requires `(` immediately after `match`, so **`matchAll(` never matches**. Same trap would hide `replaceAll(`. Use this instead:
```
rg -c '((match|matchAll|test|replace|replaceAll|includes|startsWith|endsWith|split|indexOf)\([^)]*[\x{4e00}-\x{9fff}]|[!=]==\s*"[^"]*[\x{4e00}-\x{9fff}]|\[\s*"[^"]*[\x{4e00}-\x{9fff}][^"]*"\s*\])' <file>
```
**The ranking numbers for every not-yet-done file are therefore still lower bounds.** Re-run the detector per file rather than trusting the table.

`lib/npc-generator.ts` — **done**, 24/24 fixture, build + tsc clean. Protocol tags `[配角]`/`[名字]`/`[人设]`/`[性格]`/`[简介]`/`[关系]`/`[反向关系]` → `[Supporting]`/`[Name]`/`[Persona]`/`[Personality]`/`[Brief]`/`[Relation]`/`[ReverseRelation]`, with the Chinese kept as accepted aliases in `extractTag`. **These tags are never persisted** — they exist for exactly one LLM round-trip (taught → emitted → parsed into an object) — so dual recognition here is robustness against a Chinese-persona model, not a data migration. Fixture covers the non-obvious case that `[ReverseRelation]` is not swallowed by `[Relation]`'s regex.

Uses `simpleLLMCall`, so a local output-language rule was added (see the bypass section above). `tags: ["配角"]` → `["Supporting"]` on newly generated NPCs — verified nothing anywhere compares that tag; existing NPCs keep their `配角` chip, a cosmetic fork consistent with the accepted "old stored data keeps rendering" tradeoff.

### 🚨 CRITICAL (2026-07-29): none of Phase D has actually been reaching the app
`lib/settings-storage.ts:164 loadPresets()` only refreshes the user's stored copy of the built-in preset when `existingBuiltin.builtInVersion < BUILTIN_PRESET_VERSION`. **`BUILTIN_PRESET_VERSION` is still 257 — it was never bumped during Phase D.**

Consequence: every edit to `lib/builtin-preset.ts` (all of D1a's tag contracts, the calendar block, and the new `output_language_rule`) has been sitting in source code while the running app kept using the **old Chinese snapshot saved in the user's storage**.

This also means **the D1a smoke test validated nothing about the new teaching** — tags rendered fine because the model was still being taught the *Chinese* contracts, which the Phase-A bilingual parsers happily accept. The "pass" was real but measured the old path.

The fix is to bump `BUILTIN_PRESET_VERSION`, but note the warning on that line: bumping **overwrites the user's built-in-preset copy with factory content, losing manual edits** to it (`preserveCustomAppPresetPrompts` only rescues custom-app prompt entries). That is a user-data decision, so it must be asked, not assumed.

**Process rule going forward: any change to `lib/builtin-preset.ts` requires a `BUILTIN_PRESET_VERSION` bump to take effect, and any smoke test of a preset change is meaningless without it.**

### Output-language investigation — CLOSED (2026-07-29)
Experiment B (a **brand-new character** with an English persona, not just a new chat) generated a fully English schedule, while an old character with Chinese-contaminated history did not. Hypothesis confirmed: **the residue is injected context, not the persona.**

Worth recording why "just make a new chat" would NOT have tested this: calendar generation is keyed to the **character**, not a chat session. `resolveCalendarAssemblerInput` passes `history: []` but `prepareShortTermContext` internally calls `loadNativeTimeline(characterId)` and pulls memories via `retrieveCoreMemoriesForPrompt` / `retrieveMemoriesForPrompt` — all per-character and cross-app. A fresh session changes none of that.

Fix applied: `output_language_rule` hardened with an explicit clause that **injected context is not a language reference** — history, short-term event streams, core/long-term memories and stored schedules are information about *what happened*, never an example of *how to write*; and no language mixing within a field. `BUILTIN_PRESET_VERSION` bumped to **259** so it actually ships.

### D3 progress
`lib/story-engine.ts`, `lib/vn-engine.ts`, `lib/black-market-scene-engine.ts` — **done**, build + tsc clean, zero Chinese remaining in all three.
- `vn-engine.ts` had a real trap: `DEFAULT_VN_SUMMARY_PROMPT` explicitly ordered *"用200字以内的中文总结"* — an instruction to summarize **in Chinese**. Any character using the default VN summary prompt would have kept producing Chinese memories no matter what the global rule said. Now English, ~150 words. (User-saved `vnSummaryPrompt` still shadows it — same defaults-shadowing caveat as `memory-types.ts`.)
- `black-market-scene-engine.ts`: translated the `【Scene Directive】`/`【Output Contract】` section headings only. **The `outputContract` body is template DATA from `lib/black-market-builtins.ts` and still carries the `【秘密】`/`【失控】`/`【反应】` tags that `components/shopping/black-market-app.tsx` regex-matches** — left untouched, with an inline note so nobody "finishes the job" and breaks it.
- Error messages now point at `Settings -> Binding Manager -> <App>`.

`lib/tool-prompt.ts` — **done**, zero Chinese, 14/14 fixture, build + tsc clean, `BUILTIN_PRESET_VERSION` → **260**. Now teaches `[FetchTool:actionCategory]` / `[CallTool:actionName(paramsJSON)]` (and the `["CharacterName"…]` group forms).

Marked "zero local parsers", and it was — but it had **three coupled consumers outside itself** that the file-local audit could not see:
1. **`lib/chat-engine.ts:1540 formatNativeUsageGuide`** — strips the exact header string `tool-prompt.ts` *produces*, then rewrites `获取指令`/`执行动作指令` for native tool-calling. Translating the producer alone would have silently stopped the header being stripped. Now handles both languages, because **`tool.usageGuide` is user data** and existing guides are still Chinese. The header is now an exported constant `FETCH_RESULT_HEADER` so the pair can't drift again.
2. **`components/chat/chat-room.tsx:2588 stripEditableToolTags`** — a **second copy** of `message-bubble.tsx`'s directive-stripping regexes. Phase B made the message-bubble copy bilingual and missed this one entirely; leaked directives would have rendered as raw text in the editable-message path.
3. `lib/builtin-preset.ts:1441,1480` — the note-wall examples still taught `[执行动作:…]`, contradicting the new `tool-prompt.ts` teaching. Unified to `[CallTool:…]`.

**Tool NAMES deliberately left Chinese** (`发送便签`, `发送便签评论`): they are identifiers registered in `lib/internal-capability-storage.ts` and matched exactly, so `[CallTool:发送便签({…})]` is the correct intermediate state. Verified by fixture that an English directive + Chinese tool name still parses. Renaming them is the separate tool-name track.

**Lesson: "zero local parsers" only means the file does not parse its own output.** A producer can still be coupled to a consumer in another file. Before translating any prompt-producing file, also grep for *its output strings* being consumed elsewhere — not just for parsers inside it.

`lib/interview-magazine-engine.ts` — **done**, zero Chinese, 25/25 fixture, build + tsc clean. Translated together with its lockstep partner `components/interview/interview-magazine-app.tsx` (the 5 `phase:` values left Chinese in Phase 1) plus `lib/interview-magazine-types.ts` and `lib/interview-magazine-storage.ts`. Confirmed `phase` is only ever interpolated into `Current interview stage: ${phase}` and **never compared**, so this was a coherence lockstep, not exact-match.

Two more explicit *output-in-Chinese* orders found, same class as the `vn-engine.ts` trap: the magazine-column spec said `以主编视角将采访实录整理成中文杂志专栏` and `title：4-10 字中文主标题`, and the memory-summary default demanded `80-180 个中文字`. All three were forcing Chinese output regardless of the global rule. **That makes three engines in a row — assume every prompt file has one until grepped for `中文`.**

**The real finding: a versioned-default mechanism that is not called a version.** `loadInterviewHostPrompt()` (`interview-magazine-storage.ts:94`) upgrades a stored prompt only if it byte-matches one of four *superseded* defaults (`LEGACY`/`GENERIC`/`SINGLE`/`PRIOR_DEFAULT`) — the same problem `BUILTIN_PRESET_VERSION` solves, done as a recognition list. Consequences handled:
1. The old Chinese default was frozen as `INTERVIEW_MAGAZINE_CN_DEFAULT_HOST_PROMPT` and added to that list; without this, anyone who ever opened the prompt editor and hit save would be locked on the Chinese prompt forever.
2. **All five superseded constants interpolated `INTERVIEW_MAGAZINE_HOST_NAME`.** Renaming the host (`陈未明` → `Chen Weiming`) would have silently rewritten every one of them, so none would match what is actually in the user's KV store, breaking all four *pre-existing* migrations at once. They now interpolate a frozen module-local `LEGACY_HOST_NAME` instead, with a comment saying why they must never be "cleaned up".
3. `loadInterviewMemoryPrompt()` had **no** recognition list at all — a stored Chinese memory prompt could never be upgraded. Added the same handling.

**Rule this generalizes to:** when a default prompt is stored in KV, translating the constant is only half the change — the old literal must be preserved as a recognized superseded value, and anything the old literal *interpolated* must be frozen too.

**Follow-up from the smoke test — the guest-answer prompt was in a different file entirely.** Host output was English but the *guest* answers came out Chinese, and the next host question followed them. Two independent causes:

1. **`lib/builtin-preset.ts:4071`** — the guest answer instruction is not in the engine at all. It is the preset entry `interview_character_answer` (the only `interview_magazine`-tagged entry), reached via `assemblePromptPayload`, and it ordered `回答长度控制在 60-160 个中文字`. A *specific, later* instruction beats the global `output_language_rule` every time — same shape as the `vn-engine.ts` trap. Now English, "roughly 40-110 words". `BUILTIN_PRESET_VERSION` → **261**.
2. **The host path never sees `output_language_rule` at all.** `callHostJson` (`interview-magazine-engine.ts:410`) calls `sendLLMRequest` with **`null` as the preset**, bypassing the assembler — so the host's only language signal was the transcript, and it mirrored the Chinese answers. Added a local `HOST_OUTPUT_LANGUAGE_RULE` in `buildHostSystemPrompt` so the host path is self-sufficient (it also covers opening, follow-up, and column generation, which all route through that builder).

**⚠️ New mandatory check for every remaining engine: does the prompt actually reach the preset assembler?** If not, none of the global preset rules — including `output_language_rule` — apply, and the language rule must be restated locally. There are **two** ways to bypass it:

1. `sendLLMRequest(config, null, …)` — preset argument is `null`. Found in `interview-magazine-engine.ts` (fixed), `shopping-engine.ts` (2), `xiaohongshu-engine.ts` (2).
2. **`simpleLLMCall(config, messages, options)` — takes no preset at all.** This is the much bigger surface and the null-preset grep does not find it. **12 files** use it: `black-market-scene-engine`, `brief-persona`, `chat-plugin-runtime`, `cocreate-engine`, `core-memory-builder`, `custom-app-host-api`, `map-rpg-engine`, `npc-generator`, `memory-summarizer`, `reasoning-translate`, `vn-engine`, plus `api-helpers` itself. Several were never on the D3 list at all.

```
rg -l 'simpleLLMCall|sendLLMRequest\(' -g '*.ts' lib/
```
Treat "does this file reach `assemblePromptPayload`?" as the real question — not "does it pass null".

Also removed `formatChineseOrdinalNumber` + `CHINESE_DIGITS` from `interview-magazine-app.tsx` — verified dead code (not exported, zero references). `INTERVIEW_MAGAZINE_TITLE_CN = "在场"` deliberately kept: its name declares it is the Chinese title, and it is currently unused.

**Black Market cannot be smoke-tested through the UI** — the `TALK` button on OPERATOR_03 is a genuine stub (`handleOperatorTalk` → `"Creator broker interaction coming soon"`, `black-market-app.tsx:1431`), and the real scene path (`activateSceneFromLauncher` → `startBlackMarketSceneSession`) needs an *owned* theater, which requires the `/api/black-market/*` cloud endpoints — all returning 503 without Supabase config. Neither is related to the translation work.

Covered instead by a **9/9 static fixture** (recreate from this description if needed): it asserts the engine interpolates `outputContract` verbatim and never `.replace()`s it, that no render marker exists in engine *code* (comments stripped before checking), that only the two headings were translated, that the Studio default contract still declares the markers, and — the real assertion — it extracts the **actual stored render-rule regex from source**, unescapes it as the JS parser would, and runs it against a realistic AI reply, checking both a mixed reply and one with English prose around the markers.

**Correction to an earlier note in this file:** the `【秘密】/【失控】/【反应】` markers do **not** come from `lib/black-market-builtins.ts` — that file uses entirely different conventions (`【正文】`, `〔…〕`) and contains none of them (fixture-verified). They are the default seeded by the **Studio template editor** in `components/shopping/black-market-app.tsx` (~637 contract, ~650 `renderRulesText`), i.e. per-template user data. The inline comment in `black-market-scene-engine.ts` was corrected to say this.

**New UI-text gap found (not fixed, out of D3 scope):** `CONTENT_APP_LABELS` in `lib/settings-types.ts:192-210` is the source of the app names shown in Binding Manager and still Chinese (`剧情`, `购物`, `漫卷`…) — another `.ts` file Phase 1's `.tsx`-only sweep never covered. Verified safe to translate later: it is pure display, and the similar-looking literals compared in `components/memory/memory-timeline.tsx:414-416` come from that file's own `tagSet.add("聊天")` calls, **not** from this map.
`lib/calendar-engine.ts` — **done**, build + tsc clean. Found the same producer/parser pair as `moments-engine.ts`: `builtin-preset.ts:1341` taught `地点不确定时写"无"` while `calendar-engine.ts:101` did `parts[4] === "无"`. Parser made bilingual **first** (accepts `无`, `none`, `n/a`, `-`, `—`), then the teaching block translated. Also translated the synthetic-user persona builder (`Occupation:`/`Age:`/`Gender:`), the trigger instruction, and all user-facing errors. `保密` kept — cross-file sentinel compared in `llm-prompt-assembler.ts` and `custom-app-host-api.ts`.

`lib/reading-engine.ts` — **done** (2026-08-01), full migration, 77/77 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **266**.

The risk table rated this "medium-high, 4 local parsers" and that was right: the file owns a **complete protocol of its own**, taught by two preset entries (`reading_annotation`, `reading_discuss`).

| what | legacy | now taught |
|---|---|---|
| annotation block | `[批注:N]…[/批注]` | `[Annotation:N]…[/Annotation]` |
| "nothing worth saying" sentinel | `[无批注]` | `[NoAnnotation]` |
| add action | `【新增批注 段落=N】content` | `[AddAnnotation paragraph=N]content` |
| delete action | `【删除批注 ID=x】` | `[DeleteAnnotation id=x]` |
| edit action | `【修改批注 ID=x】content` | `[EditAnnotation id=x]content` |

All five matchers accept both languages. Three decisions worth knowing:

1. **The brackets are part of the protocol, and they changed.** The legacy action tail is wrapped in full-width `【】`; the English teaching uses ASCII `[]`, because that is what a model writing English reaches for. Both bracket pairs are accepted for **both** languages, so a half-migrated model (English verb, Chinese brackets) still parses. This is the one place the migration is not a pure token swap.
2. **Open/close aliases are deliberately NOT pinned.** `[Annotation:1]…[/批注]` parses. Pinning them with a backreference is exactly what leaked the chat block tags on 2026-07-31 (see that section) — same mistake, avoided up front here.
3. **`isDiscussActionLine` and the three action parsers are now built from shared regex fragments.** They were four independent literals. The classifier decides which trailing lines form the action tail and the parsers decide what those lines mean, so any drift between them silently drops actions — same coupling class as the `tool-prompt.ts` producer/consumer lesson.

**Why the Chinese half is temporary here, unlike the chat protocol.** None of these tags is persisted: every match becomes a plain `content` string on a `ReadingAnnotation` / `ReadingDiscussAction` before it reaches storage. There is no stored history to stay compatible with, so the Chinese aliases are pure robustness against a model that still thinks in Chinese and can be dropped once the English teaching has been in the field. Recorded so nobody later treats them as load-bearing the way the chat tags are.

**Producers flipped in lockstep**: `formatAnnotationHistory`, `formatBatchAnnotationHistory`, `formatAnnotationActionContext`. Nothing parses these back — they are context *sent* to the model — but they deliberately mirror the taught shapes and the model copies the shape it sees. `formatAnnotationActionContext` also moved `ID=/段落=/角色=/内容=` to `id=/paragraph=/character=/content=`, so the ids the model is told to copy are presented exactly as the teaching spells them.

**One behaviour-preserving refactor**: the `[Annotation:N]` parse loop was lifted out of `generateAnnotationBatch` into exported `parseAnnotationBlocks()` / `isNoAnnotationResponse()`. `generateAnnotationBatch` needs characters, a bound API config and localStorage, so the protocol parser was unreachable from a fixture; extracting it makes the coverage behavioural instead of scraping regexes out of source. Target lookup stayed in the caller.

**Also translated**: all user-facing errors (now pointing at `Settings -> Binding Manager -> Reading`), the `阅读:` / `阅读对话:` preview labels, and the `用户` / `默认预设` fallbacks — verified first that `"用户"` is compared nowhere in the repo.

**Deliberately NOT done — an unclosed `[Annotation:1]` with no closer is still dropped.** Same failure class as the 2026-07-31 chat leak, but the consequence is inverted: in chat an unterminated tag *leaks* as a visible bubble; here it silently *loses* the annotation. Adding an end-of-line fallback would start saving annotations that are dropped today, i.e. a behaviour change, and this task was scoped as pure tag migration. Worth doing as its own change — the fixture already pins the residue as a negative control.

**Fixture (77/77, `_fx-reading.mjs`, deleted after use — recreate from this)**: both languages for all five tags; mixed aliases in both directions; mixed brackets in both directions; full-width `：` on both tag names; case-insensitivity; multi-action tails with blank lines between entries; `lastIndex` non-leakage across calls (the block regex is `g` and is deliberately rebuilt per call). Negative controls: `[The Hobbit]` untouched, an unclosed block not captured, an action-looking line in the *middle* of a reply not treated as a tail, `[Photo:NoRef:…]` not mistaken for an action, `$`-anchoring on delete. Plus teaching-side assertions — the exact strings taught in `builtin-preset.ts` are fed back through the parsers, and both entries are asserted to contain zero CJK.

**Fixture bug worth recording, because it will recur.** The first version located the preset entries with `indexOf('identifier: "reading_annotation"')` — which finds the **prompt_order toggle list** near the top of the file (`{ identifier: "reading_annotation", enabled: true }`), not the definition ~180k characters later. Slicing from there spans most of the file, so a `content: [` sanity guard still passed and the "no legacy tag left" assertions passed **vacuously**. Now matched structurally (`identifier` + `name` + the closing `].join("\n")`) with a size guard and a "these two entries are distinct" check. **Any fixture that greps `builtin-preset.ts` by identifier needs this** — the toggle list shadows every entry in the file.

**Adjacent, not touched**: `DEFAULT_READING_BILINGUAL_PROMPT` (`lib/bilingual-prompt-defaults.ts:61-68`) is Chinese and spells out the legacy tag shapes explicitly. It is currently unreachable — `resolveBilingualPrompt` returns `""` while `BILINGUAL_INJECTION_ENABLED` is false — so it cannot contradict the new teaching today. It belongs with the rest of the bilingual defaults if that family is ever revived.

`lib/shopping-engine.ts` — **done** (2026-08-01), 61/61 fixture, `npx tsc --noEmit` exit 0. Corrected detector re-run rather than trusting the old number: **15 hits**, matching the corrected ranking.

**No "output in Chinese" order** (the `vn-engine`/`interview-magazine`/`calendar` trap) — grepped for `中文`, zero hits. But it has the *other* failure from that same investigation: **both entry points bypass the preset**, `sendLLMRequest(config, null, …)` at `:300` and `:340`, so `output_language_rule` never reaches them and the only language signal was the prompt itself. Added a local `SHOPPING_OUTPUT_LANGUAGE_RULE` into both prompts, same fix as `interview-magazine-engine.ts`'s `HOST_OUTPUT_LANGUAGE_RULE`.

**The important finding: the prompts are STORED, so translating the constants alone reaches nobody.** `shopping-storage.ts:createDefaultShoppingState()` writes `DEFAULT_SHOPPING_REFRESH_PROMPT` / `DEFAULT_SHOPPING_SEARCH_PROMPT` into the saved state, so every user who has ever opened the shopping app is pinned to the default that was current then. This is the `loadInterviewHostPrompt()` mechanism again, and the existing handling was **worse** than interview-magazine's:
- `normalizeRefreshPrompt` had only a *content sniff* for one superseded revision (`#最近浏览1`), not a byte-match list.
- `normalizeSearchPrompt` had **no recognition at all** — precisely the `loadInterviewMemoryPrompt()` gap.

Both now carry `SUPERSEDED_*_PROMPTS` lists containing new frozen exports `SHOPPING_CN_DEFAULT_REFRESH_PROMPT` / `SHOPPING_CN_DEFAULT_SEARCH_PROMPT`.

**And the trap inside that fix**: the Chinese refresh default interpolated `SHOPPING_RECOMMENDATION_CATEGORIES`, so translating the category titles would have silently rewritten the frozen constant and it would no longer match what is in anyone's KV store — byte-for-byte the `INTERVIEW_MAGAZINE_HOST_NAME` failure. The frozen constant now interpolates a module-local `LEGACY_CN_CATEGORY_LINES`, and the fixture asserts it still contains `数码好物：小设备…` and contains **no** English category title.

**Protocol, all made bilingual before the teaching was touched:**

| what | legacy | now taught | file:line |
|---|---|---|---|
| block heading | `#推荐N` | `#RecommendationN` | `:305` |
| search heading | `#搜索结果N` | `#SearchResultN` | `:306` |
| 7 field tags | `[分类][名称][店铺][价格][说明][详情][图标]` | `[Category][Name][Shop][Price][Blurb][Detail][Icon]` | `:308-316` |
| 6 category titles | `数码好物` … | `Tech & Gadgets` … | `:8-15`, legacy map `:24-29` |

Field reads went through a `pickField` helper (`:319`) with a case-insensitive second pass, because a model writing English produces `[name]` about as often as `[Name]`. The heading regex (`:340`) gained `\s*` before the number and the `i` flag for the same reason — `#Recommendation 1` reads natural in English where the Chinese form never had a space.

**Cross-file consumer found, exactly the desync the brief warned about**: `shopping-storage.ts:69 normalizeCategory` matches a **stored** catalog's `category.title` against `SHOPPING_RECOMMENDATION_CATEGORIES` — the only place outside this engine that does. Rather than duplicate the alias list, `findShoppingCategoryByTitle()` is now exported and used by both. A pre-migration catalog therefore still re-links to its template. `title` itself is deliberately left as stored, so an old catalog renders exactly as generated until the user refreshes.

**Deliberately left Chinese, verified consistent, NOT part of this file**: the order/shipping `statusLabel` vocabulary (`已发货`, `已到货`, `待发货`, `待代付`, `已拒绝代付`). `shopping-engine.ts` never produces it. It is a self-contained cluster across four files — producers in `shopping-app.tsx:254,256,275,370,877` and a **duplicated copy of the same timeline builder** in `shopping-payment-request.ts:101,103,175,190`, consumed by `shopping-app.tsx:1446,1625` (`=== "已到货"`), `shopping-gift-utils.ts:52` (`/已到货|已签收|已完成/`) and `checkphone-engine.ts:6118` (`/待|配送|运输|收货/`). Currently coherent, so nothing is broken. Two reasons not to touch it here: the duplicated builder is a drift hazard that deserves consolidating first, and `checkphone-engine.ts` shares the vocabulary and is last in the queue.

Also left: `{{搜索词}}` in `applySearchPromptTemplate` (`:286`) — a user who customised the search prompt pre-migration may still have that placeholder stored; `{{query}}`/`{{keyword}}` were already accepted alongside it.

Translated: all 8 user-facing errors (now pointing at `Settings -> Binding Manager -> Global config`), `characterName` `购物App`/`购物搜索` → `Shopping App`/`Shopping Search`, `presetName` `(无预设)` → `(no preset)`, the preview's fallback query `礼物` → `gift`, and the produced `搜索：${query}` tag label → `Search: ${query}` (verified nothing compares a shopping product's `tagLabel`).

`parseShoppingCatalog` / `parseShoppingSearchResult` are now exported — pure functions that were otherwise only reachable behind a network call.

**Fixture (61/61, `_fx-shopping.mjs`, deleted — recreate from this).** The round trip is real rather than hand-written: it **lifts the `#Recommendation1` block straight out of `DEFAULT_SHOPPING_REFRESH_PROMPT`**, substitutes real values into it, and parses that — so rewording the teaching without the parser fails the test. Plus legacy Chinese blocks, half-migrated blocks (English heading + Chinese tags and the reverse), lowercase tags with a spaced heading, all 6 English and all 6 legacy category titles, `Search: query` fallback, and negative controls (prose, missing required fields, and a forbidden `#Orders1` heading not being harvested). **Verified non-vacuous**: dropping `推荐` and `分类` from the alias lists takes it to 55/61 with exactly the six dual-recognition assertions failing.

`lib/group-chat-engine.ts` — **done** (2026-08-02), 47/47 fixture, `npx tsc --noEmit` exit 0.

**It was almost finished already.** The risk table said 69 Chinese lines / 6 local-parser hits; the re-run detector found **7 hits, six of which were already bilingual** (the financial-action strippers, done during the `[InnerThoughts]` work), and the whole file was down to **7 Chinese lines**. Phases A2/C1/C3 plus the InnerThoughts fix had eaten most of it. Re-running the detector rather than trusting the table is what showed this.

No `中文` output order. All four `sendLLMRequest` calls (`:811`, `:960`, `:1030`, `:1068`) pass a real preset — **no bypass**, so `output_language_rule` does reach this file. Nothing to restate locally.

**The plain CJK grep was not enough here.** Full-width punctuation (`：` U+FF1A, `；` U+FF1B, `、` U+3001) sits *outside* the `\x{4e00}-\x{9fff}` ideograph range, so the standard sweep reports a file as clean while it still emits Chinese-styled separators. Five sites found with a second pass over `\x{3000}-\x{303f}` and `\x{ff00}-\x{ffef}`:
- `:427` schedule context — `${name}：${schedule}` joined by `；` → `: ` / `; `
- `:468` `memberNames.join("、")` → `", "`
- `:715`, `:929` tool-notice joins `；` → `"; "` (these reach the UI via `onToolNotice`, and the 1:1 path at `chat-engine.ts:2095` already used `", "` — so the group path was the odd one out)
- `:210`, `:211` `[:：]` inside the tool-directive regexes — **kept**, deliberate dual-recognition.

**Add this second pass to the standard sweep for every remaining file.**

**Lockstep partner fixed**: `llm-prompt-assembler.ts:2187` computes the *fallback* for the same `memberNames` value and also joined with `、`, so `{{char}}` would have read differently depending on which caller built the payload. Now `", "` with a comment pointing at the engine.

**Left Chinese, deliberately**: `:425` `item.schedule !== "无"`. `getCurrentCalendarScheduleForPrompt` returns `"none"` today (`calendar-storage.ts:224,234`), so this only catches a schedule stored before that change — same reasoning as `calendar-engine.ts:107`. Not widened to calendar-engine's fuller sentinel list (`n/a`, `-`, `—`): that list is for the *location* field, whereas this value is either `"none"` or real content.

**Fixture (47/47, `_fx-group.mjs`, deleted — recreate from this)**: drives all 6 financial actions × both languages through the real `parseGroupChatResponse` and asserts the metadata-merge gate closes (one bubble, real message preserved); plus regressions — two speakers stay two bubbles, an unknown speaker's segment is dropped whole without leaking into the previous bubble, no-prefix fallback, prose that merely *mentions* a red envelope is not swallowed as metadata, and cross-character turns never merge (the gate requires the same `characterId` — my first fixture expected 1 bubble here and was simply wrong). Then source rules: no *unexplained* Chinese (stated as a rule, not a hardcoded count, so comments don't break it), all 6 strippers still carry an English alternative, zero stray full-width separators outside the two `[:：]` classes, and the assembler's fallback separator matches. **Verified non-vacuous**: deleting one English alternative gives 44/47, and the failure output reproduces the original symptom — the metadata block surfacing as a raw `[InnerThoughts]…` bubble.

**⚠️ KNOWN ISSUE, deliberately deferred (user decision, 2026-08-02): group chat + Native Tool Calling drops action tags.** The group native-tool-calling path passes raw `result.content` to `onNativeToolAssistantTurn` (`:613`), while 1:1 passes `afterActionStrip` and dispatches actions first (`chat-engine.ts:2074`), and the group NON-native path calls `parseActionTags` + `dispatchActions` per segment (`:983`). So in **group + native tool calling only**, action tags emitted during a tool round are neither dispatched nor stripped.

**Not to be fixed for now** — the user rarely uses that combination, so the exposure is low, and correct handling needs per-character attribution before dispatch; getting it wrong double-fires side-effecting actions (transfers, red packets). Recorded here so it is not silently forgotten. Revisit only on an explicit go-ahead. This file is otherwise done.

### Manual smoke tests — all PASSED (2026-08-02, user-confirmed)
Reading annotation generate, Reading Discuss add/delete/edit, the duplicate-key fix, the Scope column, Binding Manager app names, and Shopping refresh + search. That closes the pending verification on `reading-engine.ts`, the annotation-cache aliasing fix, the four label maps, and `shopping-engine.ts`.

`lib/moments-engine.ts` + its 6 preset entries — **done** (2026-08-02), 59/59 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **267**.

Detector re-run: **16 hits**, matching the corrected ranking. No `中文` output order. Reaches `assemblePromptPayload` at 7 sites and the single `sendLLMRequest` (`callLLM`) takes a real preset — **no bypass**, nothing to restate locally.

**Protocol, made bilingual before any teaching changed** (all now built from alias constants at `:441-475`, so the parsers cannot drift from each other):

| what | legacy | now taught |
|---|---|---|
| NPC like block | `[NPC点赞]…[/NPC点赞]` | `[NPCLikes]…[/NPCLikes]` |
| NPC comment block | `[NPC评论]…[/NPC评论]` | `[NPCComments]…[/NPCComments]` |
| threaded comment line | `昵称 回复 目标：内容` | `Name replying to Target: content` |
| inline / leading reply | `[回复 昵称]` | `[Reply Name]` |
| comment wrapper | `[评论]…[/评论]` | `[Comment]…[/Comment]` |
| "nothing to say" | `[不回复]` | `[NoReply]` |
| post block, photo | already bilingual | unchanged |

The reply closer keeps its pre-existing tolerance for stray brackets (`[/回复）]`, now also `[/Reply)]`).

**The subtle one — the snapshot IS the format the model copies.** `buildMomentUiSnapshot` renders the whole post and comment section back to the model, and `formatMomentCommentLine` emits exactly the line shape the model then imitates inside `[NPCComments]`. Its connector had to flip in lockstep with `REPLY_CONNECTOR`, or the model would be shown `A replying to B: …` while the parser only accepted `A 回复 B：…`. The fixture pins this by **extracting the produced connector out of source and feeding it through the parser regex**. Snapshot labels translated too (`发帖人:`→`Author:`, `正文:`→`Text:`, `点赞:`→`Likes:`, `评论区:`→`Comments:`, `本次新互动:`→`New interactions this round:`, and the `<朋友圈界面快照>` wrapper → `<moments_ui_snapshot>`; verified no caller passes `snapshotTitle`, so the open/close pair stays matched).

**`getUserName`'s fallback became `"User"`, not a literal translation of `我`.** That name is written into the snapshot *and* compared against what the model writes back (`resolveNpcReplyTarget`, `normalizeIdentityName`). `llm-prompt-assembler.ts` defaults `{{user}}` to `"User"`, so a model with no configured identity reaches for that word — `"Me"` would have silently broken NPC-reply targeting.

**Preset entries translated** (all six): `moments_post`, `moments_comment`, `moments_npc_reaction`, `moments_reply`, `moments_npc_reply`, `moments_optional_actions`. Each gained the PLACEHOLDER warning. `moments_reply` was already **half-migrated and self-contradictory** — its `【Format】` said `[Reply …][/Reply]` while its worked example said `[回复 …][/回复]`. `moments_optional_actions` now mirrors the already-English `chat_optional_actions` (`[Message]`, `[GroupMessage "groupName"]`), which `action-parser.ts` has accepted since Phase A2.

**Kept Chinese, deliberately**: the `[,，]` like separator and the dual `indexOf(":")`/`indexOf("：")` colon scan — both are dual-recognition, not untranslated text.

**Fixture (59/59, `_fx-moments.mjs`, deleted — recreate from this).** The comment/like parsers are module-private and sit behind network calls, so the fixture **rebuilds their regexes from the engine's own alias constants read out of source** — a reworded alias changes the test rather than escaping it. `parseMomentPostResponse` is exported and tested directly. Covers both languages per tag, mixed open/close aliases, both comma widths, the producer→parser connector lockstep, `[NoReply]` vs. the prose "no reply needed", and that **the worked example inside the teaching parses through the real regexes**. Also asserts all six preset entries are CJK-free and the version bump landed. **Verified non-vacuous**: dropping `NPC点赞` and `回复` from the alias constants gives 54/59 with exactly the five legacy assertions failing.

**Two fixture bugs found and fixed rather than loosened**: the "no unexplained Chinese" rule initially flagged the `=== "使用参考图"` dual-recognition compare and the `NO_REPLY_RE` regex literal, because the allow-list only recognised `new RegExp` and `.match(`-style lines. It also caught **a real miss**: `previewMomentsNpcReplyPrompt` had a second `"(未绑定)"` on `result.apiConfig` that the bulk replace never touched.

`lib/map-rpg-engine.ts` — **PARTIALLY done** (2026-08-02). 89/89 fixture, `npx tsc --noEmit` exit 0. **Do not treat this file as finished** — see "what is left" below.

Detector re-run: 20 hits, matching the ranking — but that count badly understates the file. The full sweep found **363 Chinese lines out of 1584**, in five big default prompts plus context builders. The parser-hit count is a poor proxy for prompt-heavy engines; measure Chinese lines too.

**Priority-1 trap found and removed** (`world-gen prompt, old :144`): `引用词语/对话一律用中文引号「」，不要用英文引号` — "always use Chinese quotation marks 「」, never English quotes". A hard order to write Chinese, exactly the `vn-engine.ts` / `interview-magazine-engine.ts` class. **That makes it four engines in a row.**

**Preset bypass, worse than usual**: six `simpleLLMCall` sites (no preset argument at all) versus two `sendLLMRequest` calls that do pass a preset. So most of this engine never sees `output_language_rule`. Added a local `MAP_OUTPUT_LANGUAGE_RULE` and interpolated it into each default prompt as it is translated.

**No versioned-defaults trap here, unlike shopping.** `getActivePrompt` does `loadDMPrompts()[key]?.trim() || defaultVal`, and `loadDMPrompts` returns `""` for anything unset (`map-storage.ts:297`) — the defaults are never written into KV. So translating the constants reaches everyone who has not customised. A user who *has* customised keeps their own Chinese prompt, which is correct (it is their text) **and is the reason the Chinese parser aliases here must be permanent rather than a migration window**.

**World-skeleton parser — done, fully bilingual.** All ~30 tag names now go through a `worldField(f, ...aliases)` helper with a case-insensitive second pass:

| | legacy | now taught |
|---|---|---|
| region name / code | `[中文名]` `[英文名]` | `[Name]` `[CodeName]` |
| node | `[名称]` `[节点名]` | `[Name]` |
| NPC | `[NPC名]` `[NPC性格]` `[NPC角色]` | `[NPCName]` `[NPCPersonality]` `[NPCRole]` |
| quest | `[任务id]` `[任务标题]` `[任务简介]` | `[QuestId]` `[QuestTitle]` `[QuestBrief]` |
| encounter | `[偶遇id]` `[偶遇简介]` `[偶遇情绪]` | `[EncounterId]` `[EncounterBrief]` `[EncounterMood]` |
| capital | `[主城NPC名]` … | `[CapitalNPCName]` … |
| geography etc. | `[地理]` `[河流数]` `[邻接]` | `[Geography]` `[RiverCount]` `[AdjacentTo]` |
| sections | `#区域N` `#主线` `#档案` | `#RegionN` `#MainQuest` `#Dossier` |
| stages | `[阶段N地点/简介/解锁]` | `[StageNLocation/Brief/Unlock]` |
| dossier | `[隐藏真相][反转][结局][伏笔N][NPC秘密:名]` | `[HiddenTruth][PlotTwist][Endgame][ForeshadowingN][NPCSecret:Name]` |

**`l1_name_cn` / `l1_name_en` are NOT a translation artefact** — they are the two-line region label the map renderer draws (`map-renderer.tsx:346,350`: display name above, stylised code name below, with `DOMAIN n` / `NODE // n` fallbacks in `map-engine.ts:1515`). The pair is preserved. Only the *taught tag names* became language-neutral; the TS field names keep their historical `_cn`/`_en` suffixes, since renaming them would ripple through `map-types.ts` and `map-engine.ts` for no behavioural gain.

**The scene/resolve/ending prompts emit JSON with English keys** (`narration`, `npc_lines`, `choices`, `gained`, `move_to`, `world_events`, …), so their protocol was never Chinese — only the surrounding prose and the example values were. No parser work needed there, which is why those prompts are pure translation.

**Fixture (89/89, `_fx-map.mjs`, deleted — recreate from this).** This file cannot be smoke-tested by hand in this install, so the fixture carries the whole load. Its core move: it **slices the worked example straight out of `DEFAULT_WORLD_GEN_PROMPT` and parses that** — the exact text the model is shown, through the exact parser that reads its answer, so rewording one without the other stops producing a world. Then a full legacy-Chinese skeleton, half-migrated input (Chinese tag + English tag in one region), lowercase tags, multi-line field folding, adjacency splitting on all three comma widths, markdown-fence stripping, and negative controls (prose yields no regions, an empty `[NPCSecret:]` is dropped, a bare node gets no npc/quest/encounter keys). Plus: both translated prompts state the language rule, carry a PLACEHOLDER warning, contain no CJK, no longer contain `「`, and the scene prompt still declares all 11 JSON protocol keys. **Verified non-vacuous**: removing `中文名`/`名称` and `NPC秘密` from the alias lists gives 86/89 with exactly the three legacy assertions failing.

`parseWorldTagged` is now exported for that fixture — pure, and otherwise only reachable behind a network call.

#### ⚠️ DELIBERATELY DEFERRED (user decision, 2026-08-02) — ~258 Chinese lines left
**Do not pick this up as "unfinished work" without being asked.** The user does not use the Adventure/RPG feature at all, so the remaining translation buys nothing today and the manual check suggested below was skipped for the same reason. The file is parked in a deliberately safe state, not abandoned mid-edit. Resume only if there is spare time or the feature starts being used.
Translated so far: `DEFAULT_WORLD_GEN_PROMPT` (`:143`) and `DEFAULT_DM_SCENE_PROMPT` (`:615`), plus the whole world parser.

**Still Chinese, still to do:**
- `DEFAULT_DM_RESOLVE_PROMPT` (`:1192`) — the action-resolution phase
- `DEFAULT_DM_ENDING_PROMPT` (`:1559`)
- `DEFAULT_ADVENTURE_SUMMARY_PROMPT` (`:1618`)
- the DM context builders (region/journal/progress blocks) and the remaining user-facing prose

Each still needs `MAP_OUTPUT_LANGUAGE_RULE` interpolated, since they all reach the model via `simpleLLMCall`. **The file is in a consistent, working state meanwhile** — parsers accept both languages, JSON keys were always English, and `tsc` is clean — but output will be mixed (English world skeleton and scene narration, Chinese resolution/ending text) until the rest is done.

`lib/xiaohongshu-engine.ts` — **parsers done, prose/teaching NOT** (2026-08-02). 74/74 fixture, `npx tsc --noEmit` exit 0.

Detector re-run: 38 hits, matching the ranking. **231 Chinese lines out of 1828**, scattered thin across ~80 clusters rather than concentrated in big prompt blocks. No `中文` output order. Two preset bypasses confirmed (`sendLLMRequest(config, null, …)` at `:1057` and `:1249`) — those still need a local language rule.

**All six exported parsers are now bilingual**, and the whole file reads fields through one alias mechanism instead of indexing `fields["中文"]` directly. `metricField(fields, names[])` already existed for the numeric fields, so the change was to extend it (plus a case-insensitive second pass) and add a `textField` counterpart, then convert every read.

Five separate parser families, all converted: note blocks, NPC reaction, more-comments, DM reply, character activity/reaction. Tag names: `[正文][标题][作者][图标][标签][视频描述][图片描述]` → `[Body][Title][Author][Icon][Tags][VideoDescription][ImageDescription]`; numbered families `点赞用户N/收藏用户N/关注用户N` → `LikedByN/SavedByN/FollowedByN`; `评论N作者/内容/回复对象/回复评论ID` → `CommentNAuthor/Text/ReplyTo/ReplyToId`; `延伸N…` → `ExtraN…`; block titles (`#首页笔记`, `#视频`, `#附近笔记`, `#私信`, `#用户笔记互动`, `#发帖`) all gained English alternatives.

**Two real bugs that only appear once output is English** — both found by the fixture, neither a translation slip:

1. **`parseTags` shredded multi-word tags.** It split on `[,，、#\s]+`, whitespace included. Chinese tags have no spaces so this never mattered; `"rainy day"` became two tags. Now whitespace is used **only when no explicit separator is present** — a comma/`、`/`#` wins when there is one, so both conventions keep working.
2. **The reply-target placeholder guard was Chinese-only.** `parseXiaohongshuNpcMoreComments` rejects a model that echoes the instruction instead of a real id (`被回复`, `候选`, `评论id`). The English equivalents were missing, so `"the real comment id"` would have been stored as an actual `replyToCommentId`. Added, and written whitespace-tolerantly (`real\s*comment\s*id`) — my first attempt used `realcommentid` and the fixture caught that it never fires on real text.

**Fixture (74/74, `_fx-xhs.mjs`, deleted — recreate from this)**: full English and full legacy-Chinese payloads through all six exported parsers, asserting counts, titles, authors, icons, tags, likers, comments, thread items, DM senders, note-type detection and `feedScope`; plus lowercase tags, the placeholder-echo guard, an allow-list rejection (a comment on a disallowed noteId is dropped), a video block not being double-counted as a home note, and prose/empty negative controls. **Verified non-vacuous**: removing the Chinese aliases from `F_BODY` and `RE_EXTRA_AUTHOR_KEY` gives 71/74 with exactly the three legacy assertions failing.

#### ⚠️ What is left in this file
Still Chinese: the ~230 lines of prose (block-format instructions built in this file, user-facing strings, defaults) and the **5 xiaohongshu preset entries** in `builtin-preset.ts` (`xiaohongshu_bilingual_text`, `_character_activity`, `_user_post_reaction`, `_comment_reply`, `_mention_reply`). The two null-preset call sites still need `MAP`-style local language rules. **The file is consistent and working meanwhile** — parsers accept both languages, `tsc` clean — but the model is still *taught* Chinese, so output stays Chinese until the teaching is flipped. Parsers first was the right order; the teaching flip is the remaining half.

### D3 risk ranking (superseded — see corrected ranking above)
Every engine was checked for its **own** Chinese-literal parsing, since `moments-engine.ts` proved Phase A did not cover feature-local parsers. Count = regex/`match`/`replace`/`includes` calls against a Chinese literal:

| engine | zh lines | local-parser hits | risk |
|---|---|---|---|
| story-engine, vn-engine, black-market-scene-engine, calendar-engine | 6 / 9 / 22 / 24 | **0** | safe |
| cocreate-engine, npc-generator, shopping-engine, interview-magazine-engine, tool-prompt | 61–120 | **0** | safe |
| mascot-engine, chat-engine, xiaohongshu-engine, map-rpg-engine | 63–363 | 1–3 | medium |
| reading-engine, group-chat-engine | 26 / 69 | 4 / 6 | medium-high |
| moments-engine | 66 | 15 | high (already made bilingual in D1a) |
| **checkphone-engine** | **1166** | **26** | **highest — do last** |

Order to work in: the zero-parser files first (pure prose, no lockstep), then medium, then `checkphone-engine.ts` alone at the end.

### Remaining work before Phase D can be called done
- **D1b**: ✅ **DONE** (6 batches, 2026-08-06).
- **D2**: ✅ **DONE** (2026-08-06) — `mascot-prompts.ts` + `mascot-tools.ts` + the `小卷` rename.
- **D3**: the ~25 engine files — the big one left. `checkphone-engine.ts` alone is 1166 lines and stays last.

**Next up, in order:** `checkphone_*` (26 preset entries, 1406 lines) must move together with `checkphone-engine.ts`; the `map-rpg-engine.ts` remainder (~258, deferred — user does not use Adventure); the `xiaohongshu-engine.ts` prose (~230, its parsers and teaching are already done); `css-asset-tools.ts` (~92, never on any list); `lib/macro-engine.ts:247` + `lib/chat-time.ts:1` Chinese weekday formatting; and the `[系统指令]` / `[事件 …]` short-term labels, which need dual recognition rather than a straight translation.
Roughly **~7500 Chinese lines total**, i.e. Phase D is only ~5% done, not nearly finished. Each engine needs the same treatment as `moments-engine.ts` did: check for a feature-local parser before touching its taught formats.

## PHASE D1b (started 2026-08-06) — `builtin-preset.ts` prose

### 🚨 Scope correction: "~1980 lines, no protocol risk, safe for parallel sub-agents" was wrong on all three counts
A per-entry CJK count (script below) breaks the 1977 remaining lines down as:

| group | CJK lines | verdict |
|---|---|---|
| `checkphone_*` (26 entries) | **1406 (71%)** | **NOT D1b.** This is the teaching side of `checkphone-engine.ts` — 456 local-parser hits, explicitly last in the queue. Flipping the teaching while the engine still parses Chinese desyncs the biggest engine in the repo from its own prompt. Must move together with that engine. |
| `xiaohongshu_*` (5 entries) | 172 | Ready, but it is a **protocol flip**, not prose: `xiaohongshu-engine.ts`'s six parsers were already made bilingual (2026-08-02), and the teaching flip is the documented remaining half. Needs a fixture, not a prose pass. |
| `adventure_react` | 29 | Deferred with `map-rpg-engine.ts` (user does not use Adventure). |
| marker entries (`personaDescription`, `charDescription`, …) | 1 each | **Never translate** — `◇ 用户人设` family, matched by `preset-manager.tsx:64-70` `matchMarkerByName()`. |
| state value names in `chat_*`/`group_chat_*` | 1-3 each | **Never rename** — `mergeStateValues` merges by name. |
| everything else | **~400** | the genuine D1b prose. |

**Parallel sub-agents are also not usable here**, for a plain mechanical reason: every batch edits *the same file*. The standing rule "never let two agents touch the same file concurrently" applies, and concurrent `Edit` calls on one file either fail the stale-read check or clobber each other. D1b runs sequentially — batch, fixture, `tsc`, commit, next batch.

Re-derive the breakdown any time:
```
node -e "const fs=require('fs');const L=fs.readFileSync('lib/builtin-preset.ts','utf8').split(/\r?\n/);const d=[];L.forEach((l,i)=>{const m=l.match(/^\s{16}identifier:\s*\"([a-z_0-9]+)\"/i);if(m)d.push({id:m[1],start:i})});d.forEach((x,k)=>x.end=k+1<d.length?d[k+1].start:L.length);const c=/[一-鿿]/;d.forEach(x=>{let n=0;for(let i=x.start;i<x.end;i++)if(c.test(L[i]))n++;if(n)console.log(String(n).padStart(5),(x.start+1)+'-'+x.end,x.id)})"
```

### D1b batch 1 — call / offline / spectator surfaces: **DONE** (2026-08-06)
73/73 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **269**.

Entries: `chat_offline_format`, `chat_voice_format`, `chat_video_format`, `group_voice_call_format`, `group_video_call_format`, `group_chat_offline_format`, `group_spectator_context` (~122 CJK lines).

Protocol audit done first, and it came back clean:
- **`[角色名]:` → `[CharacterName]:`** — the group call screens call `generateGroupChatCompletion` (`group-call-screen.tsx:215`, `appTags: ["group_chat", isVideo ? "video" : "voice"]`), i.e. the **same** `parseGroupChatResponse` that already serves the English `group_chat_format`. The parser matches `/^\[([^\]\n]{1,32})\]:\s*/` and then checks the name against the roster, so the taught token is a placeholder, not a literal. Example speakers aligned to `Xiao Qi` / `Bai Yu`, matching `group_chat_optional_actions`.
- **Offline XML is ASCII already** — `parseOfflineResponse` (`chat-offline-storage.ts:210`) only ever reads `content` / `summary` / the configured `summaryTag`. Nothing Chinese to migrate.
- **Kept Chinese on purpose**: `[好感度:X]` in the two "do not output these tags" lists. The other tags in those lists were moved to the English names the parsers already accept (`[InnerThoughts]`, `[Sticker:…]`), so the prohibition names what is actually taught elsewhere.

**Fixture (73/73, `_fx-d1b1.mjs`, deleted — recreate from this)**: entry definitions located **structurally** (the `indexOf('identifier: "x"')` trap hits the `prompt_order` toggle list, which makes "legacy string is gone" pass vacuously); no CJK beyond the state names, per entry; no stray full-width punctuation outside the deliberate `【…】` markers; the worked example is **extracted out of each group-call entry and run through the real `parseGroupChatResponse`**, asserting 3 turns and correct roster resolution, with the deliberate "wrong example" line dropped as a negative sample; the offline example is extracted, has `{{offlineSummaryTag}}` resolved the way the assembler would, and is run through the real `parseOfflineResponse`; plus an unknown-speaker negative control, the version bump, and — importantly — that all 7 entries keep their exact `tags` arrays, since these surfaces are selected by tag and a wrong tag silently swaps which format a call screen gets. **Verified non-vacuous**: putting one Chinese example line back gives 72/73 with exactly the CJK assertion failing.

### D1b batch 2 — story + visual novel: **DONE** (2026-08-06)
35/35 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **270**. Entries: `story_output_format`, `vn_output_format`, `vn_story_beats` (~64 CJK lines).

**The VN protocol was already ASCII** — `<scene bg="…" sprite="…">`, the `|` dialogue separator, `<options>"a"|"b"</options>` — so only the *placeholder words* around it were Chinese (`场景名`, `角色名|"台词"`, `选项A`). `parseVnResponse`'s dialogue regex (`vn-parser.ts:66`) already accepts straight `"`, curly `""` and corner `「」` quotes, so the English template parses unchanged. Same for story: `parseStoryResponse` reads ASCII `<content>` / `<summary>` (tag configurable via `preset.story_summary_tag`).

**One consequential side fix**: `{{vnScenes}}` / `{{vnSprites}}` fall back to `"暂无"` when nothing is configured (`macro-engine.ts:169-170`), which would have landed a Chinese word inside the freshly-English VN prompt. Verified compared nowhere repo-wide, so translated to `"none yet"`. **The other 11 `暂无*` fallbacks in that file are the same category and still pending** (notewall, diary, xiaohongshu, interview, cocreate — several of whose features are already translated, so they leak mixed language today). `{{currentSchedule}}`'s `"无"` fallback on the line just above them is **not** in that category: it is a real sentinel, compared in `group-chat-engine.ts:425` and `calendar-engine.ts:107`.

**Flagged, not changed**: `vn-parser.ts:126,149` default the VN speaker to `"我"` when no name is passed. Both call sites (`vn-player.tsx:538,658`) do pass `userName`, so it is a dead fallback in practice.

**Fixture (35/35, `_fx-d1b2.mjs`, deleted — recreate from this)**: the VN template is **extracted out of the entry and run through the real `parseVnResponse`**, asserting 3 frames (one per non-empty *line*, not per `<scene>`), bg/sprite inheritance across frames, speaker split off the pipe, and that an apostrophe survives; plus the taught `<options>` syntax parsing into two choices, a narration negative control (same line without the pipe), the story summary round trip with a missing-`<summary>` negative control, the macro fallback rendering English, no CJK beyond state names, no stray full-width punctuation outside `【…】`, the version bump, and unchanged `tags` arrays. **Verified non-vacuous**: swapping the template's `|` for `：` and putting one Chinese line back gives 32/35, failing the CJK check, the full-width check *and* the parser-level dialogue assertion.


### D1b batch 3 — calendar / diary / note wall / add-friend / cocreate: **DONE** (2026-08-06)
68/68 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **271**. Entries: `calendar_plan_generation` (name only — its body was already English), `diary_entry_generation`, `diary_notewall_generation`, `diary_notewall_reply`, `add_friend_prompt`, `cocreate_write`, `cocreate_discuss`, `cocreate_tools_write`, `cocreate_tools_read` (~98 CJK lines).

**Tool NAMES deliberately still Chinese**, and the fixture asserts each one is a real registered identifier so nobody "finishes the job": `发送便签` / `发送便签评论` (`internal-capability-storage.ts:504,509`, matched exactly by `notewall-utils.ts:425,468` and switched on in `tool-executor.ts:1575,1577`) and the cocreate actions `追加` / `编辑` / `删除` / `查看` (`cocreate-tools.ts:42-45`). Each is now glossed in the prose (`the 「追加」 (append) action`) so an English-reading model still knows what it does. Diary/note-wall JSON keys and enum values were already ASCII.

**`add_friend_prompt` needed a parser migration first, not just translation.** `friend-request-engine.ts` — a prompt/protocol file that was never on any list — had a Chinese-only parser: `/\[添加好友\]…/` and a bare `text.includes("放弃")`. Made bilingual before the teaching flipped to `[AddFriend]` / `【Instruction】Abandon`. Three notes:
- The abandon branch is **anchored to a directive-shaped line** (`^…【Instruction】? (Abandon|Give up)`), not a substring test. `放弃` was distinctive enough to test loosely; "give up" is an ordinary English phrase that appears naturally inside a plea ("I'm not going to give up on us"). Fixture covers exactly that case.
- Its **fallback path was stripping `[内心]…[/内心]` Chinese-only**, so once the preset began teaching `[InnerThoughts]`, a leaked monologue would have been sent to the user as the friend-request message. Now built from the shared bilingual `BLOCK_TAG_INNER` via `closedBlockRegex`.
- `parseAddFriendResponse` is now exported for the fixture (pure; otherwise only reachable behind a network call).

### 🚨 REGRESSION FOUND WHILE VERIFYING BATCH 3: five regexes silently stopped matching
Not a translation bug — a **JS escaping bug introduced by this project's own `tool-prompt.ts` phase**, when regex *literals* were converted to `new RegExp(\`template literal\`)` so they could interpolate `FETCH_DIRECTIVE_NAMES` / `ACTION_DIRECTIVE_NAMES`. **The backslashes were not doubled.** In a template literal an unrecognised escape loses its backslash, so `\s` becomes `s` and `[\s\S]` becomes `[sS]`. The regex still compiles and still runs — it just stops matching. Nothing throws.

Broken, and now fixed:

| file | function | effect while broken |
|---|---|---|
| `tool-executor.ts:246` | `parseToolFetches` | **broken** — returned `[]`, so `[FetchTool:…]` was never recognised |
| `notewall-utils.ts:393` | `parseNoteWallToolCalls` | **broken** — every AI-written note/comment fell through to the raw-text fallback, storing the whole `[CallTool:发送便签({…})]` string as the note body |
| `mascot-engine.ts:316,345,513` | protocol start / tool-name peek / display strip | **broken** by static analysis: `[[^\[\]]` collapsed to the class `{[, ^}` followed by a literal `]`, which no real directive matches. Not testable behaviourally — those functions are module-private |
| `tool-executor.ts:305` | `parseToolCallAt` | **NOT actually broken.** `\s*`→`s*` was harmless here because the preceding `(.*?)` absorbs the difference, so `[CallTool:…]` kept working throughout. Fixed anyway (latently wrong), but it had no user-visible impact |

**Correction to a claim I made before measuring**: I first reported all five sites as broken. A before/after run against `ebc45e8` disproved that for `parseToolCallAt` — see the table. The lesson is the obvious one: run the pre-fix code against the fixture before describing impact, rather than inferring it from the diff.

The `tool-executor` pair is the worst of these and is the **exact failure mode CLAUDE.md already warned about** in the tool-prompt entry: `text-tool-protocol.ts` still *strips* the directive from the visible reply, so a broken execution parser means the directive silently vanishes and never runs, with no error anywhere. Confirmed against the baseline commit — `git show 6a067d4:lib/notewall-utils.ts` has the working regex *literal*.

**Guard added to the fixture, and it is worth keeping in every future protocol fixture**: a repo-wide scan of `lib/` and `components/` for `` new RegExp(`…`) `` containing a single backslash before a regex-only metacharacter (`\s \S \d \w \b \[ \] \( \) \. \* \+ \? \^ \$ \{ \} \| \/ \-`), excluding real string escapes (`\\ \u \x \n \t \` `). It found **three sites beyond the two I set out to fix**.

**Fixture (68/68, `_fx-d1b3.mjs`, deleted — recreate from this)**: the note-wall directives are **lifted out of the teaching text itself** (undoing TS-level `\'` / `\\` escaping first), given concrete values, and run through the real `parseNoteWallActionContent` / `parseNoteWallReplyContent`, asserting a genuine parse rather than the raw-text fallback (which is distinguished by `authorName === ""` and `body` containing `CallTool`); a reply to a noteId outside the allow-list is dropped; both taught add-friend directives plus both legacy Chinese forms plus a mixed-alias pair round-trip; leaked `[InnerThoughts]` and `[内心]` are both stripped; "give up" inside a message body does not abandon; `parseToolFetches` / `parseToolCalls` recognise English **and** legacy Chinese directives and the call is removed from the visible text; every entry keeps its `tags`, and `add_friend_prompt` keeps `role: "user"` (it is sent as a turn, not as system context). **Non-vacuity was observed live rather than simulated**: before the regex fix the run was 52/57 with the note assertions failing and the failure output showing the raw directive stored as the note body.

### D1b batch 4 — dwelling: **DONE** (2026-08-06)
56/56 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **272**. Entries: `dwelling_layout`, `dwelling_layout_items`, `dwelling_item_detail` (~51 CJK lines). **Zero CJK remains** — no exception applies to this batch.

The protocol was already ASCII: JSON keys (`rooms`/`id`/`name`/`en`/`description`/`imagePrompt`/`furniture`/`icon`/`label`/`position`/`marker`/`items`/`preview`) and the nine `position` values. `dwelling-engine.ts` has **no** Chinese-literal parser (corrected detector: 0 hits) — its Chinese was confined to error strings and preview fallbacks.

**`name` + `en` is a deliberate PAIR, not redundancy.** `room-view.tsx:320,382` and `dwelling-app.tsx:403` render `.en` as a separate stylised sub-label beneath the name — the same two-line device as the map's `l1_name_cn` / `l1_name_en`. Collapsing them now that `name` is English too would silently drop a visual element, so the teaching still asks for both (`name` = the name, `en` = the same name in capitals). Fixture pins it.

Two small consequential edits outside the preset:
- `dwelling-engine.ts:353-356` — the Prompt Viewer preview placeholders (`房间`/`家具`/`物品`/`物品外观与细节`) are interpolated straight into `dwelling_item_detail`; verified compared nowhere, so translated to keep the previewed prompt from being half English.
- The item-detail page's font stack was reordered to `Georgia, "Songti SC", "Noto Serif SC", serif` (Latin serif first, CJK kept as fallback) so a dwelling generated before the translation still renders its Chinese text properly.

**Fixture (56/56, `_fx-d1b4.mjs`, deleted — recreate from this)**: zero CJK and zero full-width punctuation per entry; the taught JSON template is **extracted from the entry and `JSON.parse`d**, then every key the engine and renderer read is asserted present at each nesting level (a reworded template that renames a key produces an unusable layout with no error); the nine taught `position` values are checked against `dwelling-engine.ts`'s own map **and** each is run through the real `resolveFurnitureMarker`, with an invented position as a negative control; the preview fallbacks are asserted CJK-free; version bump and `tags` unchanged. **Verified non-vacuous**: restoring one Chinese template line and renaming one position gives 53/56, failing exactly the CJK, full-width and position-lockstep assertions.

### D1b batch 5 — the xiaohongshu TEACHING flip: **DONE** (2026-08-06)
56/56 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **273**. All 5 entries (`xiaohongshu_bilingual_text`, `_character_activity`, `_user_post_reaction`, `_comment_reply`, `_mention_reply`, ~172 CJK lines). This closes the half left open on 2026-08-02: the parsers were made bilingual then, and the model is now finally *taught* the English field names.

Field names flipped to the aliases the parsers already accept: `[NoteId] [Text] [Likes] [Saves] [FollowedAuthor] [Type] [Title] [Body] [Icon] [Tags] [CommentCount] [ImageDescription] [VideoDescription] [LikedByN] [SavedByN] [CommentNAuthor/Text/ReplyTo] [ExtraNAuthor/Text/ReplyTo]`, block headings `#CommentN` / `#Post1` / `#Interaction` / `#Reply`, thread sentinels `MainComment` / `ExtraN`, and booleans `yes` / `no` (already in `parseBoolean`'s list).

**Two more Chinese-only reads had to be fixed first** — the 2026-08-02 pass had claimed the whole file went through one alias mechanism, and both of these escaped it:
1. **The thread reply sentinels** (`appendCharacterThreadToNote`): `/^主评论$/` and `/^延伸(\d+)$/`. `MainComment` has a benign fallback — an unrecognised target also lands on the main comment — but an unrecognised **`ExtraN`** reference silently **re-parents a nested reply to the top level**, i.e. a flattened thread in the UI with no error. Both now bilingual; the capture arity change (`m[1] ?? m[2]`) is handled.
2. **`parseXiaohongshuCharacterMentionReply` indexed `fields["内容"] ?? fields["评论"]` directly**, bypassing `textField` — the one field read the alias conversion missed. It only *appeared* to work because the block-title lookup falls back to `blocks[0]`. Its title regex was Chinese-only too.

**A real mistake caught by writing the fixture, before commit**: I first taught `[Body]` in `xiaohongshu_comment_reply`. That entry is parsed by `parseXiaohongshuCharacterReaction` (`:1382`), whose field list is `F_COMMENT_TEXT` = `Comment|Text|评论|内容` — **no `Body`**. Only `_mention_reply` uses `F_REPLY_BODY`. Both now teach `[Text]`, which is in both lists. **Lesson: two entries that look identical can be read by different parsers; check `appTags` → parser before choosing a field name.**

**Preset bypass closed**: the NPC paths (`generateXiaohongshuNpcFeed`, `generateXiaohongshuNpcDmReply`) call `sendLLMRequest` with a **null preset**, so `output_language_rule` never reached them. Added `XIAOHONGSHU_NPC_OUTPUT_LANGUAGE_RULE` inside `buildXiaohongshuNpcPrompt` — the shared choke point for both — so it also applies when the user has a **stored** Chinese `npcFeedPrompt` / `npcDmReplyPrompt`, which translating the defaults never could.

**Known and pinned, not a regression**: `[Type]Note or Video` contains the substring "video", so a model that echoes the placeholder verbatim (the `留言` bug) yields a *video* note. The Chinese original had exactly the same shape (`笔记或视频` contains `视频`). The fixture pins the behaviour rather than pretending it does not exist.

**Fixture (56/56, `_fx-d1b5.mjs`, deleted — recreate from this)**: the **"Output format" template is extracted out of each entry** and driven through the real parser for that entry's tags, with concrete substitutions — 3 comments bound to the allow-list, booleans, extras, post title/body/type/metrics/tags/nicknames, and `[Comment2ReplyTo]Comment1` resolving to comment 1's actual id; `[Type]Video` flipping the note type; comments on an unknown noteId dropped. Then `appendCharacterThreadToNote` (newly exported) is driven directly to prove `Extra1`, `延伸1` and `MainComment` each resolve to the right parent, with an unrecognised target as the negative control. Plus full legacy-Chinese payloads through both reaction and mention parsers, no CJK outside code comments, the bilingual sentinels present in source, no `fields["内容"]` index remaining, the NPC language rule wired into the shared builder, version bump and unchanged `tags`. **Verified non-vacuous**: reverting the `ExtraN` reference to Chinese-only gives 54/56, and the failure output shows both replies flattened onto `main_1` — the exact silent symptom.

**Still Chinese in this feature** (unchanged by this batch): ~230 lines of prose inside `xiaohongshu-engine.ts` itself — the context builders (`formatNpcFeedUserContext`, the feed/DM context formatters, `[类型]视频/图文` producers at `:943,982,1023`) and the `DEFAULT_XIAOHONGSHU_*` prompt constants. Those are context *sent* to the model, not parsed back, so they are safe to leave for now — but the model does mimic the shapes it is shown, so they belong in the same follow-up.

### D1b batch 6 — follow-up surfaces, and a live surface-consistency conflict: **DONE** (2026-08-06)
45/45 fixture, `npx tsc --noEmit` exit 0, `BUILTIN_PRESET_VERSION` → **274**. Entries: `chat_followup`, `chat_timed_wake`, `chat_period_care`, plus the `chat_tools` / `group_chat_tools` display names (~15 CJK lines). These were missed in the earlier passes because their line counts are tiny.

**They were not merely untranslated — they were contradicting the spec.** `chat_followup` and `chat_timed_wake` each end with a worked "if you stay quiet, output exactly this" block that taught `[内心]…[/内心]`, while `chat_output_format` teaches `[InnerThoughts]`. Their tags differ (`["chat","followup"]` vs `["chat","text"]`), which is why an entry-by-entry scan misses it — but **`follow-up-service.ts:329` sends `appTags: ["chat","text","followup"]`**, so both are active on the same surface. That is exactly the spec-vs-worked-example conflict documented above as the cause of the original 1:1 `[InnerThoughts]` leak: models weight the concrete example heavily, and when the two disagree some output comes back untagged and renders as a stray bubble. Same for `["chat","text","timed_wake"]` (`:384`) and `["chat","text","period_care"]` (`:443`).

Not *broken* before this (the parsers are bilingual, so `[内心]` still parsed) — but it was the known precondition for the leak.

**Fixture (45/45, `_fx-d1b6.mjs`, deleted — recreate from this)**: reconstructs each of the three real surfaces the way the assembler does — every enabled entry whose `tags` are a subset of the surface's `appTags`, plus untagged entries like `output_language_rule` and `persona_style_authority` — and asserts the surface teaches `[InnerThoughts]`, **never `[内心]` alongside it**, and still carries the state value names. Then the taught silence block is extracted from the entry and run through the real `parseAIResponse`, asserting it leaves **no visible bubble text**, that the monologue is extracted rather than leaked, and that all three state values parse; the legacy Chinese form is asserted to still parse. Plus a negative control that the follow-up entry does not bleed into the plain `["chat","text"]` surface, and unchanged `tags` and `role: "user"`. **Verified non-vacuous**: restoring the `[内心]` worked example gives 40/45, failing the surface-consistency assertion by name.

### D1b is COMPLETE (2026-08-06)
Remaining Chinese in `lib/builtin-preset.ts` is **1481 lines, and every line of it is deliberate**:

| what | lines | why it stays |
|---|---|---|
| `checkphone_*` (26 entries) | **1406** | teaching side of `checkphone-engine.ts`; moves with that engine, last in the queue |
| `adventure_react` | 29 | deferred with `map-rpg-engine.ts` (user does not use Adventure) |
| state value names | ~12 | `mergeStateValues` merges by name — renaming forks every character's stored state |
| marker entry names (`◇ 用户人设` family) | 11 | matched by `preset-manager.tsx:64-70` `matchMarkerByName()` |
| tool names (`发送便签`, `追加`/`编辑`/`删除`/`查看`) | 6 | registered identifiers, matched exactly; separate rename track |
| one explanatory code comment | 1 | mine, in `xiaohongshu_comment_reply` |

Re-verify with the per-entry script above; anything appearing outside those six rows is new work.

## PHASE D2 (started 2026-08-06) — the mascot files

### D2 batch 7 — the `小卷` → **Scroll** rename: **DONE**
18 sites across 11 files, one commit, `tsc` clean. Name derived from the original (卷 = scroll/roll), which also matches the app's paper-and-journal aesthetic, and is gender-neutral so it does not fight the "cool guy" persona. To change it later: it is now a plain-ASCII token, so a single repo-wide replace of `Scroll` is enough — but check the word is not used in an unrelated sense first.

It had to move as one change: the name reaches the model through the **persona prompt**, through **tool descriptions** (`mascot-tools.ts:537,548,549`), and through a debug label (`mascot-engine.ts:655`, verified display-only — `characterName` is compared nowhere). Renaming a subset forks the mascot's identity between files.

**Stale cross-reference fixed on the way**: `css-asset-tools.ts:1099` told the user to enable a setting spelled `「允许小卷上传图床」`, but the UI has read **"Allow the mascot to upload to image hosting"** since the Phase 1 sweep — so the instruction pointed at a label that does not exist. All three `css-asset-tools` messages naming the mascot are now English and point at the real label. Their `name:` fields stay Chinese (tool identifiers matched by `mascot-tools.ts`). Note `css-asset-tools.ts` still has ~92 Chinese lines and was never on any list — **add it to the queue**.

## Mascot now reads the user's configured gender (2026-08-07) — behaviour change, not translation
`de9a75c`. 48/48 fixture, **`_fx-mascot-identity.mjs` kept in the repo**.

**Before**: `MASCOT_PERSONA` hardcoded `用户是女性`, prescribed feminine endearments and forbade masculine forms of address. D2 translated that away behaviour-preservingly, which left the mascot merely *neutral* — it still ignored the gender the user had actually configured.

**After**: a rule appended to **both** mascot system prompts (text and native), right after the persona, derived from Settings → User Identity:
- `Male` / `Female` / `Other` → states it, tells the model to address the user accordingly and treat it as fact from their own settings
- `保密`, empty, whitespace, or **no identity at all** → says the user has not disclosed it, forbids assuming or inferring one (including from their name), and offers they/them

**Built at prompt time, deliberately NOT baked into `MASCOT_PERSONA`.** The persona is **stored in kv** as `mascot-settings.personaPrompt`, so editing the constant reaches nobody who has ever opened the mascot settings, and is overwritten on the next persona edit. Same reasoning and same placement as `MASCOT_OUTPUT_LANGUAGE_RULE` — after the persona, because a custom persona could otherwise contradict it.

Split into a pure `formatMascotUserIdentityRule(gender)` plus a thin resolver, because the resolver reads kv-backed storage a fixture cannot drive without standing up the whole persistence layer. The first attempt tried to shim `localStorage` and silently fell through to the undisclosed branch for every case — the split is what made the behaviour testable.

**⚠️ CORRECTION to a long-standing note in this file**: it claimed `custom-app-host-api.ts` compares against the `保密` sentinel. **It does not.** A repo-wide grep finds the sentinel only in `llm-prompt-assembler.ts`, `calendar-engine.ts`, `components/settings/user-identity.tsx`, and now `mascot-engine.ts`.

## PHASE D3 (started 2026-08-07)
Items are independent, so each gets its own commit and its own CLAUDE.md entry as it lands.

### `lib/css-asset-tools.ts` — **DONE** (`981d452`)
80 strings; 95 CJK lines → 0 beyond deliberate keeps. `tsc` clean.

Audit first, and it was the cleanest file in a long while: **zero local parsers** by the corrected detector, and **no "output in Chinese" order** — the first D3 file in a run of five engines without that trap.

Kept Chinese and **verified rather than assumed**: the 10 `ToolResult` `name:` fields, which echo mascot tool identifiers. Each was checked against `mascot-tools.ts` — all 10 registered, 0 unregistered. `KIND_LABELS` values *were* safe to translate, because the schema enum keys are ASCII (`bubble`/`icon`/`texture`/`background`/`misc`) and only the display labels were Chinese.

### `lib/xiaohongshu-engine.ts` prose — **DONE** (`11813b9`)
112 strings; 205 CJK lines → 87, all deliberate. `tsc` clean.

Confirmed first that the earlier half really was finished: all 5 xiaohongshu preset entries have **0 CJK lines** in their content, and `XIAOHONGSHU_NPC_OUTPUT_LANGUAGE_RULE` is wired into `buildXiaohongshuNpcPrompt`, closing both null-preset bypasses.

**The substantive part was the context builders, not loose prose.** They showed the model `[笔记ID]`, `[标题]`, `[正文]`, `[作者]`, `[点赞]`, `#笔记` while the teaching (flipped in `2352e63`) says `[NoteId]`, `[Title]`, `[Body]`, `[Author]`, `[Likes]`, `#Note`. Nothing broke — the parsers take both — but the context was quietly teaching the legacy names, and **a model copies the shapes it is shown**. Same lesson as `moments-engine`'s snapshot connector.

Kept Chinese, each verified load-bearing: every parser alias list and regex alternation; `isVisionUnsupportedError`'s keyword list and `/参数|格式|不支持|请求体/`, which match error text returned **by the provider** (genuinely Chinese for some Chinese APIs); and the comments documenting which legacy spellings the aliases accept.

### xiaohongshu notification texts — **DONE** (`bf172f8`), consumers first
31/31 fixture, **`_fx-xhs-notif.mjs` kept in the repo**. The deferral recorded below is now closed; kept for the reasoning.

Order mattered and was followed: **consumers made bilingual first, producers flipped second.** Notifications already stored carry the legacy Chinese wording and nothing rewrites them, so the reverse order would have broken counts and previews for existing data.

Both readers now share two constants so they cannot drift: `NOTIFICATION_COUNT_RE` = `(?:等\s*|\s+and\s+)(N)\s*(?:人|people)` and `NOTIFICATION_ACTOR_RE`, the same clause anchored at the start.

**Wording decision worth keeping**: the count is the **total** in both languages — `等N人` includes the named actors — so the English form is `and N people`, **not** `and N others`. "others" reads better but would have silently shifted the number by however many names are shown.

Two things fixed in passing:
- `notice.actorName` was interpolated into a `RegExp` **unescaped**, so a name containing `(` or `+` would throw or mis-strip. Now escaped, and the fixture drives a name full of metacharacters.
- `评论了你的笔记` / `回复了你` turned out to have **no producer anywhere** — that strip is purely defensive. Left in place and extended rather than removed.

#### 🚨 (CLOSED by `bf172f8`) xiaohongshu notification texts were a live producer/consumer pair
**Do not translate these without doing the consumers first.** `xiaohongshu-engine.ts` produces notification `text:` fields (`赞了你的笔记`, `收藏了你的笔记`, and the `等${count}人` compact-count template at `:1543,1552`). Three consumers parse them in `components/xiaohongshu/xiaohongshu-app.tsx`:
- `:182` `parseNotificationCountFromText` — `/等\s*([0-9]…)\s*人/` for the count
- `:943` — `/^(.+?)等\s*[0-9]…\s*人/` to extract the actor name
- `:966` — strips `^${actorName}\s*(评论了你的笔记|回复了你)[:：]?\s*`

Translating the producer alone breaks notification counts and previews **silently**. Make the three consumers bilingual first, then flip. Its own change.

### `[系统指令]` / `[事件 …]` timeline labels — **DONE** (`995e606`)
7 sites across 5 files: `chat-storage.ts` (preview map + preview builder), `short-term-assembler.ts` (the `sender` field and the timeline entry), and the three `[事件 …]` projection builders in `chat-offline-storage.ts`, `story-storage.ts` and `vn-storage.ts`.

**⚠️ CORRECTION to how this item was queued.** It was recorded as needing dual recognition — consumers bilingual first, then flip producers — because the labels are "read by the model". They are, but **that is not the same as being parsed**, and the queue note conflated the two. Two greps settle it:
- **No consumer matches either label.** Searching `match|test|replace|includes|startsWith|indexOf|split` against `系统指令` or `[事件` returns nothing.
- **Neither label is persisted.** Both are rebuilt at prompt-assembly time from stored source data (`msg.content`, `turn.summary`) inside the loader and assembler functions, so no saved history carries the old spelling.

With no parser and no stored data, dual recognition would have added an alias list nothing could ever consult. Straight translation was correct.

**Generalises, and worth keeping**: *"the model reads it"* justifies **translating** a string; only *"code matches it"* justifies **dual recognition**. Check for a parser before assuming the heavier treatment.

Left alone: two CSS comments in `css-examples.ts` (its own item, 360 CJK lines) and one code comment in `llm-provider-adapter.ts`.

### `lib/macro-engine.ts` — **DONE** (`9acae21`)
21 strings. This is the one found while debugging Bug 2: `{{time}}` and `{{weekday}}` expanded to `2026年8月5日10:12` / `星期三` inside `<chat_output_format>` on **every** chat prompt. Now "7 August 2026 05:55" and "Friday". Verified nothing parses either back — they expand into prompt text only.

`{{currentSchedule}}`'s fallback moved `无` → `none`, which is consistent rather than a guess: `calendar-storage` already returns `"none"`, `group-chat-engine.ts:78` defines `NO_SCHEDULE = "none"` and its filter at `:430` accepts that **and** the legacy `"无"`, and `calendar-engine.ts:107` accepts `无|none|n/a|-|—`.

**`当前日程` stays as a macro ALIAS forever** — presets saved before the migration may still contain `{{当前日程}}`. Verified it still resolves.

### 🚨 `lib/chat-time.ts` is NOT independent — it moves with checkphone
Queued alongside `macro-engine.ts` as a small 4-line item. It is not: **`checkphone-assets-page.tsx:104` parses `formatChatUiTime`'s output** —
```
if (label.startsWith("昨天 ") || label.includes("月") || label.includes("年") || label.startsWith("星期"))
```
`formatChatUiTime` is imported by five checkphone pages plus `checkphone-engine.ts`. Translating its `WEEKDAY_NAMES` or its `M月D日` / `Y年M月D日` formats would silently break that classifier. **It must move in the same change as `checkphone_*` + `checkphone-engine.ts`.** Moved to the checkphone bundle.

## ✅✅ CHECKPHONE BUNDLE COMPLETE (2026-08-07) — Steps 1, 1b, 1c, 2, 3, 4 all done
**This closes Phase D and the whole `.tsx`+`.ts` translation project.** `BUILTIN_PRESET_VERSION` **278**. `tsc` 0 errors; `_fx-checkphone-fields.mjs` **131/131**, `_fx-checkphone-blocks.mjs` **372/372**.

The bundle was ~2603 CJK lines across 5 files plus 11 UI pages, and it needed **six** steps rather than the four originally planned — Steps 1b and 1c were both discovered *after* the preceding step was declared finished.

| step | what | commits |
|---|---|---|
| 1 | bilingual **field lookup**, 423 static call sites | `a6138c0` |
| 1b | bilingual **block headings**, 35 match sites | `2f616c4` |
| 1c | bilingual **indexed field names** + 6 late-found headings | `22c7d10` |
| 2 | flip all **26 preset entries**, version → 276 | `e7b1035` … `62e60c5` |
| 3 | the **11 UI pages + `chat-time.ts`**, version → 277 | `9419284`, `91f0120`, `80479ba` |
| 4 | **engine prose**, version → 278 | `0f6cb25`, `4f56fca`, `161d36e` |

### The one lesson worth carrying forward
**Scope every protocol migration from the TEACHING, not from a source grep.** Steps 1 and 1b were both scoped by grepping the engine for match sites, and both came back incomplete — because a grep can only find the shapes you already know to look for. Step 1c came from doing the opposite: extract every token the 26 preset entries actually *teach*, then check each resolves. That found two whole families in one pass.

Shapes a source grep provably missed: a label in a **default parameter** (`= /^##\s*照片(\d+)\s*$/gm`), a parameter named `heading` instead of `label`, names built as **template literals** (`fields[\`消息${n}正文\`]`), and hand-written **index scanners** (`key.match(/^评论(\d+)作者$/)`).

### Four protocol layers, not one
Each was found only after the previous was declared done:
1. **field names** — `[标题]` → `[Title]`
2. **block headings** — `#历史记录` → `#History`
3. **indexed field names** — `[消息1正文]` → `[Message1Body]`
4. **field VALUES** — `[Type]发帖`, `[Status]已完成`, `[CommentNReplyTo]评论1`

Layer 4 is the one `pickField` cannot help with, because the key is the *value*. Most were already bilingual from the original author (`cash`/`savings`, `incoming`/`outgoing`, `yes`/`true`, `k`/`w`). The ones that were not, and would each have failed **silently**:
- `DOUBAN_ACTIVITY_TYPE_MAP` — every activity would have collapsed to the `post` fallback
- `parseNotesPinned` (`=== "是"`) — every note silently unpinned
- **the comment reply-target** `评论N` — three parsers each with their own copy; every threaded reply would have flattened to top level
- `CheckPhoneAssetAccentLabel` — a stored, rendered badge

### `DELIBERATE_CJK` is now empty — all four exceptions resolved
Each existed only because its consumer had not moved yet, and each was closed by moving the consumer **first**:

| exception | closed in | how |
|---|---|---|
| email `M月D日` | 3b | `parseEmailTimeLabel` reads both, teaching → `3 Apr 14:32` |
| takeout `已完成`/`已取消` | 3b | `describeTakeoutOrderStatus` reads both |
| weibo `本人` | 3b | the badge test reads both |
| chat `[真实会话]` family | 4a | engine builder + entry prose in one change |

**Two cases that looked like they needed an exception and did not**, worth remembering as the counter-pattern: takeout's five **category values** (the heading capture is normalised back to Chinese by `canonicalBlockLabel`, so `order.category` never changes) and music's `分钟`/`最近偏爱` (parsed by the page, but never *taught* — they are the UI's own default and the engine's fallback). **A consumer matching a Chinese string is not sufficient reason to keep it.**

### Step 3 caught a regression Step 3a had introduced
Translating `chat-time.ts` changed the labels it emits, and `checkphone-engine.ts:1429` feeds those into a real conversation's `timeLabel`, which `checkphone-chat-page.tsx` **ranks**. That parser knew only the Chinese shapes, so real conversations were sorting on a fallback. **The fixtures would never have caught it** — they cover the preset protocol, not that page's date heuristics. It surfaced only from tracing consumers before editing.

`getAssetActivityTimeLabel` was rewritten to test the bare-`HH:mm` **shape** rather than enumerate qualifier words, so that pair cannot come apart again.

### What is still Chinese in the bundle, permanently and on purpose
The identifier layer Steps 1/1b/1c deliberately built: the alias tables; every `pickField` / `pickIndexedField` / `blockLabelPattern` / `canonicalBlockLabel` **key argument**; `CHECKPHONE_TAKEOUT_CATEGORIES` (the takeout storage key); `sectionName` type annotations; the douyin section map keys; `ASSET_ACCENT_LABELS`' legacy half; the `消息${idx}text` tolerances; and every parser alternation that accepts both languages. Plus `CHECKPHONE_APP_SPECS[].label`, which is the app's own identifier — prompt context now reads the parallel `englishLabel` instead.

### The version gate, one more time
`BUILTIN_PRESET_VERSION` was bumped **three times** across Steps 2-4 (276, 277, 278), because `builtin-preset.ts` changed in each. `loadPresets()` only refreshes when `builtInVersion < BUILTIN_PRESET_VERSION`, so **any preset edit without a bump is dead code**. The fixture now derives this assertion from the entry tracker, so it cannot be forgotten again.

## 🔍 CHECKPHONE BUNDLE — FULL AUDIT (2026-08-07), execution NOT started
Requested before any translation, given the size. **Read this before touching anything in the bundle.**

### Scope: ~2603 CJK lines across 5 files, plus 11 UI pages
| file | CJK | total |
|---|---|---|
| `builtin-preset.ts` `checkphone_*` (26 entries) | **1406** | — |
| `lib/checkphone-engine.ts` | **1166** | 8096 |
| `lib/checkphone-config.ts` | 24 | 1317 |
| `lib/chat-time.ts` | 4 | 34 |
| `lib/checkphone-storage.ts` | 3 | 235 |
| 11 `components/checkphone/*.tsx` | 65 | — |

### Finding 1 — 482 detector hits, the highest in the project by a wide margin
For comparison: `xiaohongshu-engine` had 38, `map-rpg-engine` 20, `shopping-engine` 15. **Of the 482, 398 are direct `fields["中文"]` / `profileFields["中文"]` index reads, across 154 distinct Chinese field names.** The most-used: `时间` (27), `图标` (20), `标题` (19), `正文` (15), `类型` (11), `名称` (11), `感受` (10), `昵称` (9).

### Finding 2 — there is NO alias mechanism to extend
This is the crucial difference from every engine done so far. `xiaohongshu-engine` already had `metricField` / `textField`, so making it bilingual meant *extending* a helper. `checkphone-engine` has **zero** such helpers (`grep 'function (textField|metricField|pickField)'` → 0) and indexes `fields` directly at all 398 sites.

**So this is not a translation job — it is a parser architecture change**, and it must be treated as one.

### Finding 3 — the good news
- **Zero "output in Chinese" orders** (`grep 中文` → 0). No `vn-engine` / `interview-magazine` / `calendar` / `map-rpg` trap here.
- `checkphone-config.ts` and `checkphone-storage.ts` have **0 local parsers**; their handful of CJK lines are safe prose.
- `checkphone-json-repair.ts` is already clean.

### Finding 4 — cross-file consumers that must move in lockstep
- **`chat-time.ts`** — `checkphone-assets-page.tsx:104` parses `formatChatUiTime`'s output (`startsWith("昨天 ")`, `includes("月")`, `startsWith("星期")`). Already documented above.
- **11 checkphone UI pages** still hold Chinese, and per the Phase 1 log these are *deliberate* producer/consumer exceptions, not misses: `checkphone-chat-page.tsx` (38 — date/sticker/count parsing, `真实会话`), `takeout-page` (9 — `TAKEOUT_TABS` mirroring `CHECKPHONE_TAKEOUT_CATEGORIES`, `已完成`/`已取消` status), `youtube` (4), `x` (3), `music` (3 — `分钟`/`最近偏爱` regexes), `bilibili` (2 — `看到哪了`), `assets` (2), `weibo` (1 — `身份`/`本人`), `shopping` (1), `email` (1 — date regex), `douyin` (1 — `抖音号`).
- **`CHECKPHONE_APP_SPECS[app].label`** is the checkphone AI's own vocabulary — interpolated into prompts at `checkphone-engine.ts:426-430,1214` and parsed back. The scope-label work already routed the UI to `englishLabel` instead precisely to avoid touching it. `formatCheckPhoneOptionalPoolText()` also reads `.label`.

### Finding 5 — 24 `simpleLLMCall` / `sendLLMRequest` call sites
Each needs the null-preset check before any teaching flip, per the standing rule.

### ✅ STEP 1 DONE (`a6138c0`) — bilingual field lookup, 423 call sites
31/31, **`_fx-checkphone-fields.mjs` kept in the repo**. `tsc` clean. **No teaching change; deliberately invisible to the user.**

**The design choice that made it tractable**: not 154 named constants, but **one alias table keyed by the legacy Chinese name**, which doubles as the internal identifier. Each site went `fields["标题"]` → `pickField(fields, "标题")` — a single mechanical transform, trivially reviewable diff, and **no half-converted state was ever possible** because the conversion ran as one atomic pass.

`pickField` does two passes, mirroring `xiaohongshu-engine`'s `textField`: exact match, then a case-insensitive sweep (a model writing English produces `[title]` as often as `[Title]`). An unknown key falls back to reading that name directly, so a missing table entry can never silently return `undefined`.

**Two conversion details worth knowing if this is ever redone:**
- The first regex also matched property accesses, rewriting `entry.fields["X"]` into `entry.pickField(fields, "X")`. `tsc` caught it instantly; redone with the receiver captured — **162 of the 423 sites carry an `entry.` / `photo.` prefix.**
- Three sites stopped narrowing afterwards, because `x ? x.replace(...)` no longer refers to one expression once both halves are calls. Fixed by hand; the `类型` one collapsed to `(pickField(...) ?? "").trim() || "service"`, exactly the original semantics.

**The fixture asserts Step 2 has NOT happened**, so it fails if the teaching is flipped without updating it. Non-vacuity both ways: dropping the Chinese alias from `标题` → 28/31; dropping the English alias from `名称` → 29/31.

### ✅ STEP 1b DONE (`2f616c4`) — bilingual block headings, 35 match sites
39/39, **`_fx-checkphone-blocks.mjs` kept in the repo**. `tsc` clean. `_fx-checkphone-fields.mjs` still 31/31. **No teaching change; deliberately invisible to the user.** Section below records what Step 1b was for; this entry records how it landed.

**63 headings** in `CHECKPHONE_BLOCK_ALIASES`, same shape as the field table — legacy Chinese as the KEY so it doubles as the canonical internal value, English first in the value array.

**The scope count grew twice during execution.** The plan below says "3 parameterised extractors"; there are **5** — two more take the `^##` **sub-block** form (`:4915`, `:5950`) and were missed by a `replace_all` that only targeted `^#`. The fixture caught it via a "no parameterised extractor interpolates the raw label" assertion, which is exactly the kind of source-level guard worth writing for a mechanical conversion: it counts what is left, not what was changed.

**`canonicalBlockLabel()` is what kept the diff small.** 8 sites read the heading back out of a capture group and compare it — cast to `CheckPhoneTakeoutCategory` at the takeout parser (`:1821`), `=== "帖子"` in the X parser (`:2767`), and others. Normalising any accepted spelling back to the Chinese one means **zero downstream comparisons changed**. Same "normalise to canonical" trick as `lib/call-tag-patterns.ts`.

**`blockLabelPattern()` emits aliases longest-first, and that is load-bearing**, not tidiness: without it `精选` shadows `精选动态`, and the highlights section parses as the featured section with a stray `动态` left in the body. Fixture pins this case explicitly.

**Latent bug fixed for free**: `extractShoppingTopLevelBlocks` and `extractMusicBlocks` interpolated the label into a regex **raw, unescaped**. Everything now routes through `blockLabelPattern()`, which escapes.

**Non-vacuity control**: dropping the English alias from two headings (`推荐`, `购物车`) gives **33/39**, failing exactly the six English-path assertions including the end-to-end `parseShoppingBlockPayload` run. Worth noting *which* assertion catches it — **not** "all N headings match in English" (with the alias gone, the "English" name *is* the Chinese one, so it trivially matches) but **"English heading names carry no CJK"**. Both assertions are needed; either alone is vacuous under a plausible break.

**`String.replace` `$` hazard bit twice in this step** (already recorded elsewhere in this file, repeated because it cost a restore each time): the replacement string interprets `$&`, `` $` ``, `$'`, `$1`. The block text being inserted *contained* `"\\$&"` inside `escapeForRegex`, which got expanded to the anchor text and silently produced `value.replace(/…/g, "\\// ── Bilingual field lookup ─")`. **Use `split`/`join` for any programmatic source insertion, never `String.replace`.**

### 🚨 STEP 1 WAS INCOMPLETE — Step 1b is required before ANY teaching flip
Found while opening `checkphone_browser` to translate it. **Step 1 made *field* reads bilingual but not *block headings*.** The taught format has two protocol layers:
```
#历史记录          <- block heading  (NOT covered by Step 1)
##记录1            <- sub-block      (NOT covered by Step 1)
[标题]... [网址]...  <- fields         (covered by Step 1 ✅)
```
Flipping a heading to `#History` today makes block extraction stop matching — **silently**, yielding an empty list rather than an error.

**Corrected scope (my first count of "28 in 3 extractors" was wrong):**
- **3 parameterised extractors**, identical shape `^#\s*${label}(\d+)\s*$` — `extractTopLevelTaggedBlocks` (`:1648`), `extractShoppingTopLevelBlocks` (`:6117`), `extractMusicBlocks` (`:6382`). 27 distinct labels passed in as string literals.
- **26 inline block regexes** with the label baked into the pattern. These are the ones the first count missed.
- **35 block-regex sites, ~55 distinct labels** once deduped.

**Labels appearing in BOTH layers — they must share one alias or the two layers contradict each other:** `订单`, `收藏`, `帖子`, `视频`, `喜欢`, `动态`.

**The 26 inline sites** (line numbers as of `8cf829f`): `1465 备忘录`, `1546 邮件`, `1674 (美食|饮品|商超|药品|其他)`, `1688 ##订单`, `1907 (最近在玩|愿望单|游戏库)`, `1923 ##游戏`, `2154 (观看记录|收藏)`, `2166 ##视频`, `2347 (Posts|Comments|发帖|评论)`, `2612 (帖子|回复|媒体|喜欢)`, `2636 ##(帖子|回复|媒体|喜欢)`, `2901 ##(视频|频道)`, `2918 (观看记录|稍后观看|赞过的视频|赞过视频|订阅)`, `3167 ##精选(?:动态)?`, `3197 #帖子`, `3201 #精选动态`, `3224 ##帖子`, `3588 (作品|喜欢|收藏)`, `3712 ##帖子`, `4078 会话`, `4944 相簿`, `4972 ##相簿`, `5593 账户`, `5594 流水`, `5829 (最近通话|联系人|常用联系人|语音信箱)`, `5888 ##线程`.

**Plan as originally written** (kept for the record; executed in `2f616c4`, with the corrections noted in the STEP 1b DONE entry above — notably 5 parameterised extractors, not 3, and 63 labels, not ~55):
1. `CHECKPHONE_BLOCK_ALIASES` keyed by the legacy Chinese label, English first — same shape as `CHECKPHONE_FIELD_ALIASES`.
2. `blockLabelPattern(legacy)` returning an escaped alternation. Drop it into all 3 parameterised extractors — **and note two of the three do not escape the label today** (`extractShoppingTopLevelBlocks`, `extractMusicBlocks` interpolate `${label}` raw, unlike `extractTopLevelTaggedBlocks` which escapes). The helper fixes that for free; do not lose it.
3. Convert the 26 inline sites individually — they cannot take one global regex like Step 1 did, because their alternation shapes vary.
4. Fixture: both languages for all ~55 labels through the real exported parsers, plus non-vacuity both ways.

**Why this must be complete before Step 2**: a half-bilingual block layer means blocks reached through the un-converted path stop parsing the moment the teaching flips, with no error. Same failure class as the `tool-executor` / `FETCH_RESULT_HEADER` / `prompt-sanitizer` regressions.

### ✅ STEP 1c DONE (`22c7d10`) — indexed field names + 6 late-found headings
`_fx-checkphone-fields.mjs` 50/50, `_fx-checkphone-blocks.mjs` 57/57, `tsc` clean. **Still no teaching change.**

**How it was found, and why that method matters.** Step 1 and Step 1b were both scoped by *grepping the source*. Step 1c came from doing the opposite: extracting every heading and every bracket token that the 26 preset entries actually **teach**, then checking each one resolves through the alias tables. That found two whole families the source greps had missed. **Do this audit first on any future protocol migration** — the teaching is the specification, and a source grep can only find the sites you already know how to describe.

**1. Indexed field names — the bigger gap.** A second family of names is assembled per row rather than written as a literal:
```
fields[`消息${n}正文`]      [消息1正文] [评论2作者] [商品3图标] [歌曲1]
```
Step 1 converted the 423 **static** reads; these are **template literals**, so its regex could not see them. 48 reads across 28 shapes and 4 prefixes (`消息`/`评论`/`商品`/`歌曲`), plus **9 hand-written index scanners** (`key.match(/^评论(\d+)作者$/)`).

New `pickIndexedField(fields, prefix, n, suffix)` and `indexedFieldNumbers(fields, prefix, suffixes[])` assemble candidates from prefix-alias × index × suffix-alias, with the same case-insensitive second pass as `pickField`.

**The scanners were the dangerous half.** Chinese-only, they return an **empty list** the moment the model writes `[Message1Body]` — every row vanishes, no error anywhere. The fixture's non-vacuity run reproduces it exactly: telegram comes back with `n: 0` messages.

Six suffixes that only ever occur *inside* an indexed name were absent from the field table and are now in it (`回复`, `引用标题`, `引用正文`, `语音时长`, `语音转写`, `发送方`); the table goes **154 → 160**. Two naming collisions had to be resolved: `回复` → `InReplyTo` (since `回复对象` already owns `ReplyTo`) and `留言` → `VoicemailEntry` (since `语音信箱` already owns `Voicemail`).

**2. Six block headings Step 1b missed** — `历史记录`, `收藏夹`, `记录`, `照片`, `留言`, `通话`. `extractBrowserSection` is a **sixth** parameterised extractor, and it takes its label in a parameter named **`heading`, not `label`**, so the Step-1b conversion regex skipped it silently. It now routes through `blockLabelPattern()`, which also replaces its own hand-rolled escaping.

**Same receiver bug as Step 1 recurred** — the conversion regex rewrote `entry.fields[…]` into `entry.pickIndexedField(fields, …)`. `tsc` caught it instantly. If this conversion is ever redone, capture the receiver.

Five more block parsers were exported (`browser`, `phone`, `telegram`, `messages`, `photos`) so the fixtures drive real code instead of copies of its regexes.

### ✅ STEP 2 COMPLETE (2026-08-07) — all 26 entries flipped, `BUILTIN_PRESET_VERSION` → **276**
Final commit `62e60c5`. `tsc` 0 errors; `_fx-checkphone-fields.mjs` **135/135**, `_fx-checkphone-blocks.mjs` **372/372**; reverse audit reports 26 FLIPPED, 0 pending, 0 unresolved.

Run in batches: `e7b1035` (5) → `9e881a0` (5) → `35284dd` (3) → `52cb3a0` (3) → `ef8a235` (2) → `9bd5dae` (2) → `1bc8b9c` (1) → `e5a0550` (2) → `62e60c5` (2 + bump).

**The bump is what actually shipped any of it.** Every flipped entry was dead code until now — `loadPresets()` only refreshes when `builtInVersion < BUILTIN_PRESET_VERSION`. This is the same trap recorded earlier in this file for Phase D; worth re-reading before any future preset work.

**`_fx-checkphone-taught.mjs` is the shared REVERSE AUDIT and per-entry tracker**, consumed by both fixtures. It walks the 26 entries, extracts every protocol token they actually TEACH, and resolves each against the engine's alias tables — headings, plain fields and indexed names in one pass. Asserts both directions: a flipped entry teaches only resolvable names and carries no unexplained CJK; a pending entry still teaches legacy Chinese, so the tracker cannot go stale by omission. **The "Step 2 not finished" assertion is derived from the tracker**, so completing the 26th entry flipped it to demand the bump automatically — no hand-editing, nothing to forget.

**A fourth protocol layer surfaced mid-run: field VALUES.** `pickField` cannot help there — the key is the value, not the field name. Most were already bilingual from the original author (`cash`/`savings`, `incoming`/`outgoing`, `yes`/`true`, `group`/`direct`, `k`/`w`). The ones that were not:
- `DOUBAN_ACTIVITY_TYPE_MAP` — Chinese-only discriminator; would have collapsed every activity to the `post` fallback. Now keyed on the enum names (already English) with English words and every legacy spelling accepted.
- `parseNotesPinned` tested `=== "是"` only — the `[Pinned]yes/no` this migration teaches would have left every note silently unpinned.
- `CheckPhoneAssetAccentLabel` — a stored, rendered badge; union widened to accept both, default `备用` → `Backup`.
- **The comment reply-target `评论N`** — three parsers each carried their own Chinese-only `/^评论(\d+)$/` (douyin, chat moments, and the shared social one behind weibo + instagram). Teaching `Comment1` would have **silently flattened every threaded reply**. All three now call one exported `parseCommentReplyTargetNumber`.

**Two more parser gaps found the same way** (both after Steps 1/1b/1c were declared done): `parsePhotoEntryBlocks` baked its label into a **default parameter** rather than interpolating `${label}`, so no source grep for the interpolation shape could see it; and `parsePhoneSectionBlocks` compared the **raw** heading capture against a Chinese literal, so an English `#RecentCalls` would have matched no section.

**One UI guard moved in lockstep, deliberately** — `isXExampleHandle` (`checkphone-x-page.tsx:72`) rejects a handle the model copied out of the placeholder, and its patterns were Chinese-only. Flipping the teaching without it would have left the guard matching nothing. That is a guard kept in step with its teaching, **not** the Step 3 translation of that page.

**xiaohongshu's ten `#` prose headings are gone.** In this format a line starting with `#` IS protocol syntax, so a prose section title invites the model to imitate it and emit a block heading that parses as nothing. Standing rule for any flipped entry: no bare `#` line may survive as prose.

#### Remaining CJK in the checkphone entries — 4 documented exceptions, all deliberate
Each lives in `DELIBERATE_CJK` with its consumer, and the fixture asserts it is still **PRESENT**, so a later cleanup cannot quietly delete one and desync it.

| entry | kept | consumer |
|---|---|---|
| email | `M月D日 HH:mm` | `checkphone-email-page.tsx` date regex |
| takeout | `已送达`/`已完成`/`已取消` | `checkphone-takeout-page.tsx:382` |
| weibo | `本人` | `checkphone-weibo-page.tsx:250` |
| chat | `[真实会话]` family | blocks the ENGINE injects, `checkphone-engine.ts:1553` |

**Two non-exceptions worth keeping recorded**, because both looked like they needed one and did not:
- **takeout's five category values** — the page does match them, but the category comes from the block-heading capture, which `canonicalBlockLabel` normalises back to Chinese. `order.category` stays `美食` whether the model writes `#美食1` or `#Food1`.
- **music's `分钟` / `最近偏爱`** — the page parses both, but the entry teaches a bare number and a plain name, so neither is ever *taught*. They are the UI's own default suffix and the engine's fallback.

**The lesson those two encode:** a consumer matching a Chinese string is not sufficient reason to keep it. Check whether the entry actually **teaches** that string, and whether the value reaching the consumer is normalised on the way. Both times the answer was no.

### Step 2 progress — 1 of 26 entries (`8cf829f`)
`checkphone_manifest` only, flipped ahead of Step 1b because it is **the one checkphone entry parsed as JSON** (`normalizeManifest` reads `record.optionalAppIds` / `record.topAppIds`, both ASCII) rather than through the block-and-field format. Everything it names — the app ids — was already ASCII; the Chinese was a parenthetical gloss.

**`BUILTIN_PRESET_VERSION` deliberately still 275.** It waits until all 26 entries are done so the app never sees a half-flipped preset. Per-entry status tracking in `_fx-checkphone-fields.mjs`, and flipping its "Step 2 not started" assertion, both belong to the final batch.

### Remaining order — do NOT translate first
1. **Build the alias mechanism.** Add a `pickField(fields, names[])` helper with a case-insensitive second pass, exactly like `xiaohongshu-engine`'s. Convert all 398 index reads to bilingual lookups. **No teaching change, zero user-visible change** — this is the safety net everything else stands on.
2. **Flip the 26 preset entries.** Only after step 1 is proven, since the parsers must accept English before the model is told to write it.
3. **The 11 UI pages + `chat-time.ts`**, in one lockstep change with their engine-side producers.
4. **Engine prose** (errors, context builders, comments) — safe once 1-3 land.

Step 1 alone is the largest single mechanical change in this project. It should be its own commit with its own fixture, and the fixture must drive real payloads through the exported parsers in both languages before step 2 begins.

### ✅ `lib/css-examples.ts` — **DONE** (`6f322ba`, `ce91260`, `39c0d42`)
359 CJK → **0**. All seven exported templates translated across three commits: GLOBAL + CALENDAR + MUSIC, then CHAT_SESSION + CHAT_APP, then STORY + VN.

Purely CSS comments throughout, exactly as the audit predicted — no selector, property or value was touched, and the CSS is byte-identical apart from comment text. These templates are what the user sees in the six CSS editors and what the mascot reads as the `读取CSS` selector reference.

Worth knowing for similar files: CHAT_SESSION and CHAT_APP share a lot of comment vocabulary, so finishing the first took the second from 55 down to 22 for free.

### `lib/css-examples.ts` — audit (kept for reference)
359 CJK lines. Audit result: **zero protocol risk.** The corrected detector finds **0 local parsers**, there is no "output in Chinese" order, and — checked line by line — **every Chinese string sits inside a CSS comment**; no selector, property or value is affected. Seven exported templates (`CHAT_SESSION_`, `CHAT_APP_`, `STORY_`, `VN_`, `CALENDAR_`, `MUSIC_`, `GLOBAL_CSS_EXAMPLE`) consumed by `mascot-tools.ts` (the 读取CSS reference) and six UI components. Safe for a straight mechanical pass whenever there is budget for 359 lines.

### ✅ PHASE D2 IS COMPLETE (2026-08-06)
Both files done, `npx tsc --noEmit` exit 0 at every step, and a **permanent fixture is committed**: `_fx-mascot-tools.mjs` (202/202) — the first fixture in this project kept in the repo rather than deleted. Run it with `node _fx-mascot-tools.mjs`.

| commit | what |
|---|---|
| `f6f6df0` | the `小卷` → **Scroll** rename, 18 sites / 11 files, one change |
| `abc9d7a` | `mascot-prompts.ts` — persona, character card, regex spec |
| `28bc439` | `mascot-tools.ts` — pack surface + bilingual pack labels |
| `7337598` | `mascot-tools.ts` — the rest (291 strings), file done |
| `0d101bb` | `WORLDBOOK_PROMPT` |
| `726c452` | `PRESET_PROMPT` |
| `4ecaba0` | `GENERAL_PRESET_PROMPT` |
| `fe1e5b3` | `CSS_PROMPT` + `PAGE_GREETINGS`, file done |

#### What still contains Chinese, and why — do NOT "finish the job"
`mascot-prompts.ts` is at **68 CJK lines**, `mascot-tools.ts` at ~55, and every one is load-bearing:
- **The 43 mascot tool names** — the identifiers `executeMascotTool` switches on, and `preset-manager.tsx:86-93` `MASCOT_PRESET_STORAGE_TOOL_NAMES` matches 6 of them.
- **The 10 `◇` marker names** — matched by `preset-manager.tsx:64-70` `matchMarkerByName()`, and written verbatim by the mascot when it creates a preset marker entry. They appear twice in `PRESET_PROMPT` (list + worked example) and in shorthand in `GENERAL_PRESET_PROMPT` (`◇ 世界书（角色前/后）`, `◇ 核心记忆 / 长期记忆 / [短期记忆]` — the original's own combined form, confirmed against git HEAD).
- **The 7 `legacyLabel` values** — pack labels are a live protocol token (see below).
- **State value names** (`好感度`/`占有欲`/`焦虑值`) — `mergeStateValues` merges by name.
- **Two legacy-tag notes** — `REGEX_PROMPT` and `GENERAL_PRESET_PROMPT` tell the user that `[状态栏]`/`[内心]` are still parsed, so old content can be styled.
- **Two `[^\w一-鿿]` character classes** — they *permit* CJK in generated identifiers.
- **`resolveRegexTags`' `has("群聊")` / `has("剧情")` / `has("故事")` / `has("线下")`** — they accept Chinese input typed by the user.

#### The pack `label` was a live protocol token, not a display string
Nearly missed. The model types it in `[FetchTool:<label>]` and `mascot-chat-store.ts:450` resolves it via `findPackageByLabel`. Labels got the standard dual-recognition treatment — a new `legacyLabel` field on `MascotToolPackage`, and a lookup accepting either, case-insensitively and trim-tolerantly (the model types these by hand), returning `undefined` for a non-string since the value comes straight from model output.

**And a second consumer was about to be left behind** — the recurring failure of this project. `buildMascotPackageSchemaPrompt` ran its **own** `p.label === packageLabel` comparison instead of calling the helper, so a legacy fetch would have silently returned "no such pack". Now routed through `findPackageByLabel`.

#### 🚨 Three invented tool names, all pre-existing, all fixed
These prompts told the model to call tools that **do not exist**. Any model following them literally would have called nothing:

| prompt | taught | actually registered |
|---|---|---|
| `PRESET_PROMPT` | `创建预设(...)` | `创建剧情预设` (`mascot-tools.ts:679`) |
| `GENERAL_PRESET_PROMPT` | `创建预设({type:"general", prompts:[]})` | `克隆内置预设`, which takes only name + description (`:389`) |
| `CSS_PROMPT` | `追加CSS(...)` | **nothing** — and the same block's own workflow says "there are only 3 tools: 读取CSS / 覆写CSS / 清除CSS" |

None was introduced by the translation. Worth a standing habit: **when translating a prompt that names a tool, check the name against the registry** — a bogus one is invisible until a user reports "the mascot said it did it but nothing happened".

#### The `标签名用中文` trap — 5th engine, handled differently
`WORLDBOOK_PROMPT` ordered the model to use **Chinese XML tag names** inside world book entry content. Same family as the `vn-engine` / `interview-magazine` / `calendar` / `map-rpg` traps, but it constrained *structure*, not prose.

Verified first that **nothing parses world book content** — the assembler only macro-expands it, runs the user's own regexes over it, and joins it in (`llm-prompt-assembler.ts:459,893,1051,2020`). So the constraint had no technical basis.

**User decision: removed rather than inverted.** The spec now asks for "descriptive tag names that fit the entry's subject", naming no language at all, so the model follows `output_language_rule` without locking the file to English forever. Existing Chinese world books keep rendering — their content is only ever text.

#### Method note that cost a restore
The first attempt at `WORLDBOOK_PROMPT` generated the replacement through a script with **nested template literals**. The escaping layers collided and turned the literal `\n` inside the JSON output example into real newlines, splitting a single-line JSON example across lines. Restored from backup and redone by writing the block as a **plain text file** and splicing it in — no escaping layers at all. Every subsequent block used that method. **`PRESET_PROMPT` has literal `\n` in its CoT template entries too**, so this is not a one-off hazard.

#### Behaviour changes worth knowing
- `<!-- 思考开始 -->` / `<!-- 思考结束 -->` → `<!-- thinking start -->` / `<!-- thinking end -->`. Verified parsed nowhere — HTML comments the model writes as a visual boundary. Presets already created keep whatever they stored.
- `GENERAL_PRESET_PROMPT` now teaches `[StatusPanel]` / `[InnerThoughts]` with a legacy note, and its fold-regex examples use English field names (`Location` / `Wearing` / `State`) to match what the model now writes.
- `MASCOT_PERSONA` hardcoded `用户是女性` and prescribed feminine endearments, contradicting `user-identity.tsx` where gender is configurable and includes `保密`. Translated behaviour-preservingly ("address the user warmly and affectionately; never use blokey forms of address"), which drops the gender assertion while keeping the register. **Making the persona actually read the configured identity is a separate change, not done.**

### D2 batch 8 — `mascot-prompts.ts`, first half: **PARTIAL, and deliberately so**
532 → **394** CJK lines. Done: `MASCOT_PERSONA`, `CHARACTER_CARD_PROMPT` (0 left), `REGEX_PROMPT` (10 left, all deliberate). 31/31 fixture, `tsc` exit 0.

**`REGEX_PROMPT` was the load-bearing one and is why this file is not just prose.** The mascot *writes the user's regex rules*. It was teaching `[状态栏]` / `[内心]`, but the preset now makes the AI emit `[StatusPanel]` / `[InnerThoughts]` — so every regex the mascot wrote would have silently failed to fire. Now teaches the English tags, with an explicit legacy note that both forms are still parsed and a `/\[(?:StatusPanel|状态栏)\]/` pattern for styling old messages too. The fixture extracts the taught story-mode regex **out of the prompt text and runs it** against a real block, and asserts the legacy spellings appear *only* inside that note.

**Three Chinese families deliberately survive**, and the fixture asserts each is a real identifier rather than a missed line: state value names (`mergeStateValues` merges by name), the legacy block tags inside the note, and the three regex tool names (`创建正则组`, `添加正则规则`, `更新正则规则` — verified present in `mascot-tools.ts`).

**Verified unparsed, so kept as pure formatting**: the `■` section markers and `【…】` subsections in the character-card spec — grep found no consumer anywhere. Fixture pins that they survive, since the card's readability depends on the model using them.

**Finding worth a decision (NOT changed — behaviour, not translation).** `MASCOT_PERSONA` hardcoded `用户是女性` and prescribed feminine endearments while forbidding masculine ones. That contradicts `components/settings/user-identity.tsx`, where gender is user-configurable and includes `保密` (prefer not to say). I translated it behaviour-preservingly as "address the user warmly and affectionately; never use blokey forms of address" — which drops the explicit gender assertion while keeping the register the original intended. **If you want the mascot to actually respect the configured identity, that is a separate change**: the persona would need to read from the identity system rather than assert a gender.

#### Still to do in `mascot-prompts.ts` (394 lines)
`WORLDBOOK_PROMPT` 69, `PRESET_PROMPT` 135, `GENERAL_PRESET_PROMPT` 108, `CSS_PROMPT` 62, `PAGE_GREETINGS` 8, plus two stray header comments. **Two known constraints for whoever continues:**
1. `PRESET_PROMPT` (~lines 337-346 and 416-424) lists the **marker names** `◇ 用户人设`, `◇ 世界书（角色前）`, `◇ 角色描述`, `◇ 角色性格`, `◇ 角色关系`, `◇ 世界书（角色后）`, `◇ 日程`, `◇ 核心记忆`, `◇ 长期记忆`, `◇ [短期记忆]`. These are the exact strings in `builtin-preset.ts` and are matched by `preset-manager.tsx:64-70` `matchMarkerByName()`. **Never translate them** — the mascot creates preset entries with those literal names.
2. The preset-tool names `创建剧情预设`, `克隆内置预设`, `复制预设`, `添加预设条目`, `更新预设条目`, `更新预设信息` are matched by `preset-manager.tsx:86-93` `MASCOT_PRESET_STORAGE_TOOL_NAMES`. Same rule.
3. `WORLDBOOK_PROMPT:242,285` carry an explicit **"output in Chinese" order** (`标签名用中文` — world book entry content should use Chinese XML tag names). That is the fifth engine in a row with that trap. Those XML tags are free text injected into prompts and parsed nowhere, so flipping them to English is safe.

## UPSTREAM (2026-08-06) — remote added, and what has been ported

Upstream is `https://github.com/xiaolongbao0709/ai-virtual-phone`, added as remote **`upstream`** with its **push URL disabled** (`push = DISABLED_no_push`). Fetch-only; nothing has ever been merged or rebased.

**Our repo shares NO history with it** (this is a local `git init`), so `merge-base` is empty and there are no commit ranges — only tree diffs. **And most of the raw diff is CRLF noise**: `llm-prompt-assembler.ts` shows 3702 changed lines but has *zero* real changes. Always compare with `--ignore-cr-at-eol`:
```
git diff --shortstat --ignore-cr-at-eol 6a067d4 upstream/main
```
Real divergence from our baseline: **129 files, +23024 / −5191**, 149 commits, 29 new files, 0 deleted.

**Do not merge.** With unrelated histories plus CRLF noise, a merge conflicts in ~39 files where most are byte-identical. Cherry-pick by hand instead.

`upstream/test` vs `upstream/main` is only **11 files / 432 lines**, all mobile/tablet shell work that exists **only in `test`** (`lib/mobile-shell.ts`, `phone-shell.css`, `layout.tsx`) — detecting real phones when the browser lies about the viewport. Note both branches carry **duplicated parallel histories** (same messages, different hashes), so never take both.

### Ported so far
| what | commit | notes |
|---|---|---|
| **DIY desktop widget tools** (upstream `b41da23`) | `ef13953` | 7 mascot tools + `WIDGET_PROMPT`. Touched **5** files, not the 2 the diff summary suggested — `mascot-events.ts`, `desktop-shell.tsx` and `mascot-float.tsx` are required or the tools write to storage but the desktop never refreshes and preview never opens. All our infrastructure already existed. Translated on the way in; tool NAMES kept Chinese per this project's pattern. 56/56 fixture. |
| **Zero-width chars saved as empty bubbles** | `f61f34c` | `isInvisibleOrWhitespaceOnly()` in `rich-message-parser.ts`. Zero-width chars are **not** deleted (U+200D joins composite emoji) — they only count as blank when deciding emptiness. |
| **3 Moments anti-hallucination rules** | `f5860a4` | Written into our English entries. Version bump deferred at the time; **activated in `275`**. |
| **Store the post first, attach the photo after** | `1976054` | `attachMomentPhotoInBackground`. **Architecture check done first, as asked:** our UI needed no change — `moment-post-card`'s retry affordance keys off `photoDescription && !photoUrl`, not the status field, so a `"pending"` post already renders a working retry button. The only required change was widening the type union, which had only `"failed" | "generated"`. |

**`BUILTIN_PRESET_VERSION` is now 275**, bumped to activate the three Moments rules. Bumped ahead of "after D2" deliberately: nothing left in D2 touched `builtin-preset.ts` (`mascot-tools.ts` and `mascot-prompts.ts` are not part of the preset), so no second bump was coming from that work.

### ✅ Story mode: the FULL 2026-08-02 paper/document redesign — **PORTED** (2026-08-07)
Six commits: `a03cb90`, `5fff72d`, `6ca0e18`, `d543813`, `550bde5`, `35f4dda`. ~930 lines across `styles/story.css`, `components/story/story-app-base.tsx`, `components/ui/story-html-renderer.tsx`. `tsc` 0 errors and CSS braces balanced at every step; **zero CJK in both `.tsx` files throughout**.

| cluster | what |
|---|---|
| 1 tokens | `--story-font` + `--story-paper-shadow{,-soft}`; flat white default |
| 2 long card | header floats, `.story-stage-inner` becomes the paper, reading card flattened onto it |
| 3 message header | `.story-msg-head/-meta/-name/-time`, square avatars |
| 4 bubbles/folds/composer | bubble transparent + justified; folds become footnotes between dotted rules; composer flush to the bottom edge |
| 5a renderer | serif iframe fallback + vh feedback lock |
| 5b drawer | three-column avatar grid, borderless panel |

**Ported by hand, never cherry-picked** — histories are unrelated and both `.tsx` files were translated in Phase 1, so context lines differ everywhere. Chinese comments were translated on the way in.

#### The recurring trap: four user-facing toggles upstream deleted
Upstream removed the avatar / timestamp / bubble switches (`be899cc`) and the drawer message preview. **We had all of them working**, backed by persisted prefs in `lib/story-storage.ts`. Porting the JSX as written would have silently deleted them and orphaned their stored fields. Resolution, per decision:

| toggle | outcome |
|---|---|
| `hideAvatar`, `hideTimestamp` | **kept working.** Upstream's structure is flexbox, so hiding the avatar just drops a flex child. The head renders only when it has content — which is also why the outer gate could not stay the avatar-only test it was. |
| `hideBubble` | **left as a deliberate no-op.** With the bubble flattened, the rule sets what the base rule already does. Kept with an explanatory comment rather than deleted; a dead control is recoverable, a deleted feature is not. |
| drawer message preview | **removed by decision** — no room in a three-column grid, visual consistency prioritised. `getStoryPreview` is NOT dead; it still backs `currentPreview`. |

#### Coupled sets — porting any one alone breaks the layout
- **The long card**: header `relative→absolute`, stage padding `12px 16px 168px → 0 14px 0`, `.story-stage-inner` gains the paper background and header-height top padding. The floating header is what lets the paper run beneath it; either half alone leaves a gap or slides content under the bar.
- **The message header**: `.story-row` had to go `row → column` (the header is now *above* the bubble), and the bare `[data-role="user"] { flex-direction: row-reverse }` had to be **deleted** — it would have overridden the column stacking entirely.
- **Fold blocks**: our `▸` marker used `summary::before`, the same pseudo-element upstream's left dotted rule needs. Whole block replaced rather than patched, or two rules fight over `::before`.
- **Composer**: a `@media` override pinned `left/right: 20px` and would have re-inset the now-edge-to-edge bar on wide screens.

#### Things removed because they became incoherent
Night-theme overrides for `.story-top-btn` and `.story-meta` (both flat now, so a night-only shadow contradicts the paper look), and `.story-meta::before`, the washi-tape strip that pinned the reading card — with the card flattened into the sheet, the tape pins nothing.

#### The renderer delta was three things, two of them traps
Two hunks looked like real changes and were **comment-only** — our English against upstream's Chinese, byte-identical code, in the two regions edited during the polish port. Taking them would have put Chinese back into a Phase-1 file. The two genuine features:
- **`serifIframeFallback`** — an iframe cannot inherit `--story-font`, which only became visible once cluster 1 made the page serif. Verified `public/fonts/interview/noto-serif-sc.woff2` exists and is already referenced by `styles/fonts.css` before porting. Opt-in per caller: story passes it, `dwelling-app` deliberately does not.
- **A vh feedback lock** — genuinely different from the ratchet fix below. The ratchet came from *our* measurement including `documentElement.scrollHeight`; this starts in the generated page's CSS, where `100vh` resolves against the iframe's own viewport and grows with it. No measurement change can break that cycle, so both are needed.

#### A correction worth keeping
I reported that upstream had deleted the "Rebuild Render Cache" button, from a grep for the exact class string `story-character-chip justify-center` returning 0. **They kept it** — they moved it to `.story-tool-btn`. The grep matched the class string, not the control. The correction produced the better fix: our button moved too, so `.story-character-chip` now has exactly one user. The grid rules are still scoped to `.story-character-list > .story-character-chip` anyway — it costs nothing and stops the grid reaching anything that reuses the class later.

### Story-mode polish fixes — **PORTED** (2026-08-07)
Five fixes, five commits: `90a33f7`, `93e253a`, `8035f12`, `746b4d7`, `1d14573`. `tsc` 0 errors throughout.

**Audit first, and it came back clean:** 3 files only (`components/ui/story-html-renderer.tsx`, `components/story/story-app-base.tsx`, `styles/story.css`). **`lib/story-engine.ts` is not touched by any of them**, so there was no collision with the fully-translated engine.

| fix | upstream | note |
|---|---|---|
| iframe height ratchet | `7929e87` | `documentElement.scrollHeight` was in the max — but the parent sizes the iframe from what we report, so that value reflects the IFRAME, not the content. Once it grew it never shrank. Plus a zero-width guard. |
| collapsed content lazy-mount | `55d6f68` | Same root cause from the other side: a collapsed `<details>` gives an iframe zero width, so it measures garbage. `hasOpened` is one-way, so collapsing again does not force a re-measure. |
| first-line indent | `041abc5` + `9ff361e` + `1cd1593` | **Three commits, not the two the brief listed.** |
| auto-scroll after retry | `f16f1c2` | Shorter content makes the browser clamp scroll to the new bottom, which reads as jumping upward. |
| fallback cover | `13162a0` + `3bcacca` + `dcac2fe` | Three successive refinements of one element; only the final state ported. |

**Two audit findings worth keeping:**
1. **We never had the BASE first-line indent.** `styles/story.css` contained no `text-indent` at all, so porting only the two refinements the brief named would have added rules with nothing to refine. Had to pull `041abc5` in as well. *Check that a refinement's base exists before porting the refinement.*
2. **Ported by hand, never cherry-picked.** Histories are unrelated and both `.tsx` files were translated in Phase 1, so context lines differ everywhere. The one part copied byte-for-byte is the iframe bridge script, which is generated-page code rather than app source.

**Deliberately not taken while in these files:** upstream's `margin 0.6em → 1.1em` and `line-height 1.68 → 1.78` (`db637e5`), and the cross-session generation-state fix (`3330405`) that `f16f1c2`'s context sits on — our `handleStoryRetry` uses `setIsGenerating` where upstream uses `markGenerating(sessionId, …)`. The scroll fix is independent of it.

**One translation decision:** upstream's empty-name cover fallback is the character `书`. Since every user-facing string in the repo is now English, that became an open-book emoji — same meaning, no Chinese glyph reintroduced, and the element is `aria-hidden` anyway.

**Still Chinese:** `styles/story.css` has 30 CJK lines of pre-existing comments in parts this port did not touch.

### Not ported (decide per feature; each is a Chinese-language feature port that would then need translating)
`工坊` / Workshop app (12 `lib/qa-*.ts` + `phone-qa-app.tsx` + docs — docs Q&A plus a **GitHub agent that reads and edits code**), the WeChat cloud assistant (Supabase edge function + local scripts + a polling-traffic fix), the `夜光 Lumen` music overhaul (~40 commits), local test modes for Game Hall and Black Market theater, and a run of story-mode polish fixes.

## PHASE D2 batch 9 — `mascot-tools.ts`: **PARTIAL** (2026-08-06)
96/96 fixture, `tsc` exit 0. Done: **the whole pack surface** — every pack label, pack description and sub-tool description, plus the compact tool list that is injected into the system prompt every turn. That is what the model actually reads, so it was taken first.

**The pack `label` turned out to be a live protocol token, not a display string.** The model types it in `[FetchTool:<label>]` and `mascot-chat-store.ts:450` resolves it via `findPackageByLabel`. So labels got the standard dual-recognition treatment: a new `legacyLabel` field on `MascotToolPackage` holds the pre-translation Chinese name, and the lookup accepts either, case-insensitively and trim-tolerantly (the model types these by hand).

**And a second consumer was about to be left behind** — the classic failure of this project. `buildMascotPackageSchemaPrompt` did its **own** `p.label === packageLabel` comparison rather than calling the helper, so a legacy fetch would have silently returned "no such pack". It now routes through `findPackageByLabel`. The fixture's non-vacuity control removes one `legacyLabel` and that consumer fails by name.

Also hardened: `findPackageByLabel` now returns `undefined` for a non-string, since the value comes straight from model output.

The compact tool list now teaches `[FetchTool:…]` / `[CallTool:…]` (matching the rest of the app) and says explicitly that action names must be typed exactly as shown, Chinese characters included. The fixture runs the worked navigate example through the **real execution parser**, and asserts every advertised pack name round-trips through the lookup.

#### Still to do in `mascot-tools.ts` — ~309 lines
Schema `description:` fields and code comments, spread thin across ~60 sections. **No protocol risk left in them**: the corrected detector finds 2 hits and both are `name.replace(/[^\w一-鿿]/g, "")` character classes that *permit* CJK in generated ids (they must stay), and the single `中文` hit is a code comment. Tool names, the `◇` marker names and the `legacyLabel` values stay Chinese.

`mascot-prompts.ts` still has its own **394** lines outstanding (see D2 batch 8 above). **D2 is not finished.**

### Track 1 progress
`lib/custom-app-creator-guide.ts` — **done**, ~520 strings translated, `npm run build` passes, zero smart quotes / zero CJK escapes. (Agent hit a session usage limit mid-file at ~26%; resumed via `SendMessage` after verifying no smart-quote damage — the completed portion was intact.) Notes:
- **4 markdown anchor links** re-derived in lockstep with their retitled headings; all 4 verified to resolve to a heading that still exists.
- **1 ASCII architecture diagram** re-padded (Chinese is double-width, English single-width) — verified all 8 lines are exactly 50 columns with connectors column-aligned.
- **2 lines deliberately left in Chinese**, both confirmed real runtime tokens rather than doc examples: line 241 `[朋友圈]...[/朋友圈]` (parsed by `lib/action-parser.ts`, taught at `lib/builtin-preset.ts:644` — will become bilingual in Phase A2) and line 500 `[图片]` (literal degradation text emitted by `lib/llm-provider-adapter.ts:226,357` when a model lacks vision), the latter given an inline English gloss so the reader still understands it.
- Judgment call worth knowing: the `{{参数1}}` placeholder alias was **dropped** in favour of documenting `{{arg1}}` / `{{1}}` / syntax-derived names. Verified against `lib/rich-message-parser.ts:467-483`, which registers `arg1`, `参数1`, `1` **and** labels derived from the app author's own `syntax` string — so the translated examples still work because they match the translated `syntax`.

`lib/memory-types.ts` — **done**, `npm run build` passes. Both AI system prompts (`DEFAULT_SUMMARIZATION_PROMPT`, `DEFAULT_CORE_MEMORY_PROMPT`) translated; zero Chinese remains. Verified safe first: no bracket tags, output is stored as free-form summary text and never parsed/matched, only `{{char}}`/`{{earliest}}`/`{{latest}}`/`{{events}}` placeholders needed preserving (confirmed intact). Two notes: (a) `字` (Chinese characters) → `words` for the length limits — token budgets are 100k so the slightly longer English output is harmless, but it's a tunable; (b) **the `DEFAULT_CORE_MEMORY_PROMPT` requirement list looks like it lost its `包含：`/`排除：` section headers upstream** — items 7-11 (ordinary chitchat, mood swings, temporary conflicts, ordinary preferences, anything speculative) are clearly meant to be *excluded* but are listed identically to the include items. Translated faithfully at first, then **restructured on user instruction** — see next paragraph.

**Intentional AI-behaviour change (user-approved, 2026-07-28), not a literal translation:** `DEFAULT_CORE_MEMORY_PROMPT` in `lib/memory-types.ts` was restructured from one flat `要求：` list into three explicit sections — `Goal:` / `Include:` / `Exclude:` / `Format:`. The original Chinese listed the five "must exclude" items (ordinary chitchat, general mood swings, temporary conflicts/ambiguity, ordinary preferences, anything speculative) with the exact same bullet formatting as the "must include" relationship-milestone items, with no header distinguishing them — almost certainly a lost `包含：`/`排除：` pair upstream. The new English version makes the include/exclude split explicit. **This changes what the model is told to do**, so it is a deliberate fix rather than a translation, and core-memory output may differ from the original Chinese build. Revert to a flat list if that turns out to be unwanted.

## 🚨 BUG (2026-07-31, user-reported): Gemini native tool calling was 400-ing on every request

Not a translation bug — an unrelated pre-existing defect surfaced while the user tested Google + "Enable Native Tool Calling". Google returned:

```
Invalid JSON payload received. Unknown name "additionalProperties"
at 'tools[0].function_declarations[1].parameters': Cannot find field.
```

**Cause.** `buildGeminiRequest` (`lib/llm-provider-adapter.ts`) passed `tool.parameters` to `functionDeclarations` after only `stringifyToolSchemaEnums()`, which normalizes `enum` values and nothing else. Our tool schemas are authored for **OpenAI-style** function calling, where `additionalProperties: false` is idiomatic — 41 occurrences across the built-in tools alone (`chat-engine.ts`, `cocreate-tools.ts`, `mascot-tools.ts`, `internal-capability-storage.ts`, `builtin-phone-workflows.ts`). Gemini's function-calling schema is a **small subset of OpenAPI**, and an unknown keyword is a hard 400, not something it ignores. So native tool calling was broken for Google in *every* app, not just chat.

**Fix.** New Gemini-only sanitizer `toGeminiFunctionParameters()` = strip unsupported keys, then run the existing enum helper. Called from exactly one place (the `functionDeclarations` map — verified the only `functionDeclarations` construction site in the repo). `stringifyEnumValues`/`stringifyToolSchemaEnums` were **not** touched: the OpenAI-compatible path shares them and must keep `additionalProperties`.

**The non-obvious part.** A naive recursive "delete every key named `additionalProperties`" is wrong: inside a `properties` map the keys are **caller-defined parameter names**, so a tool with a parameter genuinely called `additionalProperties` would lose a real parameter. The walk is schema-aware — it recurses into `properties` values but never treats their keys as keywords. This matters because `parseNativeToolSchema` (`chat-engine.ts:1531`) `JSON.parse`s **user-authored** schema text and passes it through unvalidated, so arbitrary key names really can appear.

**Verified**: 14/14 fixture driving the real `buildProviderRequest` with real tool definitions (41 mascot + cocreate tools, plus `buildNativeChatTools` output for both the 1:1 and the group/`actorNames` shape, which is the exact `function_declarations[1]` the error named). Includes a **negative control** — OpenRouter + a gemini-named model routes through the OpenAI path using the old helper alone, and `additionalProperties` still survives there, proving the helper never stripped it and the assertions aren't vacuous. Also asserts the sanitizer is pure (caller's schema not mutated). `npx tsc --noEmit` exit 0.

**Not verified by me**: no live Google API call was made — no key, and it's a paid outbound request. The user's smoke test is the real confirmation.

**User smoke test: PASSED (2026-08-01, reported 2026-08-01).** Google + native tool calling, group chat, sending a location tool call — worked without the 400 error.

**Known remaining gap (deliberate).** Only `additionalProperties` and `$schema` are stripped. A keyword survey of all 41 built-in tool schemas found **no other** unsupported keyword (`type`/`description`/`properties`/`required`/`enum`/`items` only), so the built-ins are fully covered. But user-authored schemas could contain `oneOf`/`allOf`/`const`/`$ref`/`exclusiveMinimum`/etc., which Gemini also rejects. These were **not** added because stripping is not always the right repair — dropping `$ref` in particular yields a silently empty schema, which is worse than a 400. Extend `GEMINI_UNSUPPORTED_SCHEMA_KEYS` only for keywords where deletion is genuinely lossless.

## 🚨 THE `[InnerThoughts]` LEAK, FINAL ROOT CAUSE (2026-07-31): the model omits the closing tag

The group-chat bubble read exactly `[InnerThoughts]Easiest request ever. Let's get it done immediately.` — **note the missing `[/InnerThoughts]`**. That is the whole bug, and it was reproduced byte-for-byte before any change was made.

`extractBracketBlock` (rich-message-parser) and `stripStateAndInnerForPrompt` (prompt-sanitizer) both matched **closed pairs only**: `\[(tag)\][\s\S]*?\[\/\1\]`. An opener whose closer never arrived matched nothing, so the raw tag text fell straight through as ordinary visible content — and, in group chat, also defeated the metadata-merge gate in `parseGroupChatResponse`, which fires only when the stripper reduces a block to `""`.

**Why native tool calling made it show up.** The assistant turn is cut short by the tool call, so a truncated/unclosed block is far likelier. It is *not* Gemini-specific and not tool-specific — location+transfer was just the trigger the user happened to hit.

**This was already a known failure mode elsewhere in the same codebase, twice:**
- `stripReasoningTags` has `REASONING_OPEN_RE` for an unclosed `<think>` (block-tags.ts:28).
- `parseActionTags` has an explicit "AI omitted `[/TAG]` — take content to end of text" fallback (action-parser.ts:194).

Only the block tags lacked it. Fixed in `lib/block-tags.ts` with three shared builders — `closedBlockRegex` / `unclosedBlockRegex` / `orphanCloserRegex` — now used by **both** rich-message-parser and prompt-sanitizer, so the read side and the prompt-replay side can no longer disagree about what a block is.

**Boundary choice for an unclosed block: to end of LINE, not end of text.** The taught format puts the block on its own line with the message body on the next (`builtin-preset.ts:439`, `:1034`), so end-of-line removes the leak without ever swallowing a real reply. `stripReasoningTags` uses end-of-text for `<think>`, which is right there and wrong here — a group turn routinely has the message body after the block. Known residue: a genuinely multi-line unclosed block still leaks line 2 onward. Deliberate; guessing a longer span risks deleting real messages.

**Second real bug found in the same code.** The old regex pinned open/close together with a backreference, so `[InnerThoughts]…[/内心]` leaked. The comment justified this as stopping `[状态栏]…[/StatusPanel]`, but that is a mixed alias of the *same* block and should match. Cross-BLOCK matching was never possible anyway — each regex is built from one block's own alias list. Backreference dropped; mixed aliases now accepted, which matters precisely because we are mid-migration (preset teaches English, saved history holds Chinese).

**Verified**: 16/16 fixture through the real `parseGroupChatResponse` → `parseAIResponse` chain, asserting *visible bubbles* rather than regex internals — including that `[InnerThoughts]…\nTransfer sent!` still shows "Transfer sent!", that `[The Hobbit]` is untouched, that the metadata-merge gate now closes, and that the prompt-replay stripper agrees with the display parser on every shape. `tsc` exit 0.

### ⚠️ Adjacent bug found while investigating — NOT fixed, needs a decision
The **group** native-tool-calling path passes **raw** `result.content` to `onNativeToolAssistantTurn` (`group-chat-engine.ts:613`), while the **1:1** path passes `afterActionStrip` (`chat-engine.ts:2074`) and dispatches actions first. The group *non-native* path also calls `parseActionTags` + `dispatchActions` per segment (`group-chat-engine.ts:983`). So in **group + native tool calling only**, action tags emitted during a tool round are neither dispatched nor stripped. Not fixed here because doing it right needs per-character attribution before dispatch, and getting it wrong double-fires side-effecting actions.

## `<think>` leak in Moments and Diary — fixed (2026-07-31)

`stripReasoningTags` was only wired into the **chat display** path (`parseAIResponse`). Moments and Diary never go through it, so a literal `<think>` block was saved into the stored content.

- **Diary** (`diary-entry-utils.ts`, in `parseDiaryEntryContent`): worst case of the two. The block sits in front of the JSON, so `parseJsonLike` fails and the fallback branch stores the **entire raw string** — reasoning included — as the diary body. Stripping before parsing turns a leak into a no-op.
- **Moments** (`moments-engine.ts`, on `callLLM`'s return): the single choke point — verified there is exactly one `sendLLMRequest` call in the file, and the fixture asserts that stays true.

**Not done at the shared choke point, on purpose.** `sendLLMRequest` would fix every consumer at once, but it **deliberately emits `<think>`** when `includeReasoning` is set (`chat-engine.ts:926`, used by `story-engine.ts:156`), and `mascot-prompts.ts:196` documents a user-facing pattern of hiding `<think>` at the display layer while *retaining* it at the prompt layer. Stripping centrally would interact with both. Worth revisiting as a deliberate consolidation — note that four engines already carry their own private copy of this regex (`checkphone-json-repair.ts:16`, `dwelling-engine.ts:168`, `interview-magazine-engine.ts:90`, `vn-parser.ts:31`), which is the real signal that this belongs in one place.

**Coverage caveat**: the Diary fix is tested behaviourally end-to-end; the Moments fix is a wiring assertion (the stripper itself is tested behaviourally, but `callLLM` is module-private and needs a network call). Treat Moments as the weaker of the two until smoke-tested.

## 🚨 BUG (2026-08-01, user-reported): React duplicate key in Reading Discuss — the annotation cache was handed out by reference

Warning seen while testing add → delete → edit in reading discuss: `Encountered two children with the same key, ra_1785592732458_c8q0b9`.

**Not an id collision.** `ra_${Date.now()}_${Math.random().toString(36).slice(2,8)}` is effectively collision-proof, and the id shape identifies the source precisely: 6 random chars = `applyDiscussActions` (`generateAnnotationBatch` uses `slice(2,6)`, 4 chars). It was one annotation appearing **twice**, not two annotations sharing an id.

**Root cause, in `lib/reading-storage.ts`:**
- `loadAnnotations` returned `_annotationsCache.get(key)!` — **the cache array itself**, not a copy.
- `reading-viewer.tsx:552` puts that array straight into React state, so *state and cache were the same array instance*.
- `saveAnnotation` then did `cached.push(annotation)` — mutating that array **in place**.

So in `applyDiscussActions`: `nextAnnotations = annotations` (= the cache array) → `await saveAnnotation(annotation)` pushes into it → the following `[...nextAnnotations, annotation]` appends the *same* annotation a second time. Duplicate id, duplicate React key.

**Why the batch path never showed it**: `executeBatchAnnotation` uses `saveAnnotations` (plural), which **replaces** the cache entry with a fresh `toArray()` result instead of pushing, and merges into state via a Map keyed by id. Two independent reasons it was immune — which is why the bug looked flow-specific.

**Fixed at the source**, so every consumer benefits rather than just this call site:
- `loadAnnotations` returns `[...cached]`. The cache is now genuinely private.
- `saveAnnotation` rebuilds the array instead of mutating it, matching `deleteAnnotation`, which already did.

Kept as defence in depth (with corrected comments — the originals blamed a race): the id-keyed upsert in `applyDiscussActions`, and the `seenAnnotationIds` guard in the TXT token builder, which matters because the paged renderer keys annotation tokens by `annotation.id` (`reading-viewer.tsx:315`; the other render path at :372 keys by index and was never affected).

**One hardening, no proof it was reachable**: the PDF branch of the annotation-load effect mapped over `chapters` directly, so two chapter entries sharing an `index` would load the same rows twice and `flat()` them into duplicate ids. Now dedupes indexes first — the pattern `loadExistingAnnotationsForItems` (:570) already used.

**Fixture (26/26, `_fx-annots.mjs` + `_fx-dexie-stub.mjs`, deleted after use).** `fake-indexeddb` is not a dependency, so the fixture aliases `dexie` (via jiti's `alias`) to a ~40-line in-memory stub and runs the **real** `reading-storage.ts` — the bug is entirely in that file's cache logic, which the stub leaves untouched. **Verified non-vacuous by reverting both lines and re-running: 12/26, and the reported duplicate id `ra_1785592732458_c8q0b9` appears in the failure output byte-for-byte.** Covers: no mutation of a previously handed-out array by `saveAnnotation`/`deleteAnnotation`/`saveAnnotations`; two loads returning equal-but-distinct arrays; a caller mutating its copy not corrupting the cache; the full add→delete→edit sequence; re-saving an existing id updating rather than appending; plus a control that proves the fixture can observe aliasing at all.

**Generalises beyond Reading**: any `load*` that returns a module-level cache by reference has this shape. `_booksCache`, `_chaptersCache`, `_progressCache` in the same file are worth the same audit — not done here.

## Preset editor "Scope" column still shows Chinese — NOT a stale preset snapshot (2026-08-01)

Reported as `阅读 · 讨论` still showing for the (correctly renamed) `▸ Reading · Discussion` entry, with a strong hypothesis that `loadPresets()` had not refreshed to `BUILTIN_PRESET_VERSION` 266.

**That hypothesis is disproved by the report itself**: the entry *name* already read "Reading · Discussion", which is the v266 string. If the snapshot were stale the name would still be `▸ 阅读·讨论`. **The version bump did reach the app; `loadPresets()` is fine.**

The Scope column is rendered from **`lib/content-tag-utils.ts`**, a static label map that has nothing to do with the preset snapshot: `CONTENT_SCOPE_TAG_GROUPS` (reading group label `阅读`, minors `标注` / `讨论`, lines 172-181) plus `EXTRA_TAG_LABELS` (lines 8-48), composed by `getTagsLabel` into `${group.label} · ${minor.label}`. It falls through to `CONTENT_APP_LABELS` (`settings-types.ts`) and `getCheckPhonePromptSecondaryTagLabel` (`checkphone-config.ts`) for anything it doesn't define.

**Safe to translate whenever wanted**: every consumer (`preset-manager.tsx`, `regex-manager.tsx`, `custom-app-tag-profiles.ts`) uses these strings for display only — all matching goes through the `tags` arrays via `areTagsEqual`/`getTagProfileId`, never through a label. Note `preset-manager.tsx:50` already returns `"General"`, which is why the panel currently looks half-translated. The `["朋友圈","NPC回复"]` entry in `LEGACY_TAG_MIGRATIONS` (:218) is a **tag**, not a label — it must stay Chinese.

**Lesson**: "translated string still shows Chinese in the UI" is not automatically a preset-version problem. Check whether the string is even *from* the preset — a label composed by a separate map fails in exactly the same way and no version bump will ever fix it.

### Fixed the same day (user chose the full scope): all four label maps translated

`content-tag-utils.ts` (`EXTRA_TAG_LABELS` + every `CONTENT_SCOPE_TAG_GROUPS` label), `settings-types.ts` (`CONTENT_APP_LABELS` — the deferral noted earlier in this file is now closed), `custom-app-tag-profiles.ts` (4 stragglers: `通用`, `通用（所有功能）`, `自定义 APP`), and the scope-facing part of `checkphone-config.ts`. 30/30 fixture, `npx tsc --noEmit` exit 0.

**The one real trap, and why checkphone was NOT translated wholesale.** `CHECKPHONE_PROMPT_SECONDARY_TAG_LABELS` was derived from `CHECKPHONE_APP_SPECS[app].label` — and that field is the **checkphone AI's own vocabulary**: it is interpolated into prompts at `checkphone-engine.ts:426-430` (`DOCK：`, `上方固定：`) and `:1214` (`phoneAppLabel`), then parsed back by that engine, which is last in the D3 queue with 456 local-parser hits. Translating it to fix a UI column would have desynced the biggest engine in the repo from its own prompt.

`CHECKPHONE_APP_SPECS` already carries a parallel **`englishLabel`** field, so the fix was to point the scope map at `englishLabel` and leave `label` untouched. One line per app, zero risk to the prompt surface. `formatCheckPhoneOptionalPoolText()` (`:1305`) also reads `.label` and was deliberately left alone — it builds prompt text, not UI.

**A shadowing bug this surfaced.** `resolveContentTagLabel` tries `EXTRA_TAG_LABELS` → `getCheckPhonePromptSecondaryTagLabel` → `CONTENT_APP_LABELS`. The checkphone lookup ends with `isCheckPhoneAppId(tag) ? CHECKPHONE_APP_SPECS[tag].label : null`, which matches bare ids checkphone shares with content apps (`chat`, `reading`, `music`, `shopping`, `notes`, `photos`…) and therefore sits **in front of** `CONTENT_APP_LABELS`. Invisible while both were Chinese; after translation it would have returned Chinese for those tags anyway. That fallback now routes through `CHECKPHONE_APP_PROMPT_TAGS` into the English map. Fixture asserts all seven shared ids come back CJK-free.

**Fixture (30/30, `_fx-scope.mjs`, deleted — recreate from this)**: exact expected strings for the reported `Reading · Discuss` plus a spread across other apps; every label in `CONTENT_SCOPE_TAG_PROFILES` asserted CJK-free; the seven shadowed bare ids; that `getTagProfileId`/`areTagsEqual` still match on **tags** and are untouched by the relabelling; that the Chinese `["朋友圈","NPC回复"]` entry in `LEGACY_TAG_MIGRATIONS` still migrates (it is a tag, not a label) and then renders as `Moments · NPC reply`; and a negative control that an unknown tag still falls through verbatim, proving the assertions come from the maps rather than a blanket English default.

Two expectations in the first fixture run were **mine**, not the code's: checkphone's messenger and reader minors read `CheckPhone · Chat` / `CheckPhone · Reading`, because those come from each app's own `englishLabel`. Correct as-is — they name the phone's apps, not the top-level features.

Naming choices worth keeping consistent: `diary` → **Journal** (the app is 手记, a notebook; its `entries` minor is **Diary entries**, which is the 日记 part), `interview_magazine` → **Interview** (`在场` stays only as the deliberately-Chinese `INTERVIEW_MAGAZINE_TITLE_CN`), `vn` → **Visual Novel**, `checkphone` → **CheckPhone**.

Still Chinese and deliberately untouched: the `◇ 用户人设` / `◇ 角色描述` family in `preset-manager.tsx:64-70`. Those are preset-entry identifiers matched loosely (see the comment at :73), not scope labels.

## Editing a character mid-conversation had no visible effect — fixed 2026-08-05

User-reported: change a character's persona (friendly + emoji → fierce, curt, no emoji), save, keep chatting in the **same** thread — the replies stay in the old voice. Deleting the chat history makes the new persona take effect immediately. New characters were always fine.

**Not a code bug.** Instrumentation on the whole path (`loadCharacters()` → `assemblePromptPayload` → final payload) was added and then removed; the save path, the `_charsCache` invalidation and the assembler were all already correct — the edited persona *does* reach the prompt, on the very next message. What loses is the instruction, not the data: the model sees dozens of its own prior messages written in the old voice and imitates them, because few-shot examples outweigh a description. That is also exactly why a brand-new character never showed the problem — no history to imitate.

**Fix: a new preset entry `persona_style_authority`** in `lib/builtin-preset.ts`, modelled on `output_language_rule`:
- **No `tags`**, so the assembler's tag filter (`entryTags && !entryTags.every(...)`, `llm-prompt-assembler.ts:811` / `:2249`) never drops it and one entry covers every surface.
- Registered in `prompt_order` **immediately after the `shortTermMemory` divider**, which puts it at `depth: 0` — i.e. *below* the chat history whose style it is correcting. Placement is the point: above the history it would be just another description competing with the examples.
- `BUILTIN_PRESET_VERSION` → **268** (without the bump it would be dead code — see the warning on that line).

**Scope is deliberately narrow: VOICE only.** The entry says the profile outranks past messages for tone/register/emoji/manner, and then says in as many words that this *does not* apply to substance — plot, relationship state, promises, and everything in conversation history, short-term events, core and long-term memories must still be recalled and used exactly as before. That clause is load-bearing: a blanket "ignore earlier context" rule would fight the memory system (`lib/memory-types.ts`, `memoryCore`/`memoryLongTerm` markers, `characterRelations`) and trade a style bug for a continuity bug. The fixture pins it with scope guards so a later trim can't quietly widen it.

**Fixture (24/24, `_fx-persona.mjs`, deleted — recreate from this)**: structural (version bumped, entry enabled, **no `tags`**, ordered after the divider, CJK-free, and the four scope-guard phrases still present); behavioural through the **real** `assemblePromptPayload` and `assembleGroupPromptPayload` — the rule reaches the 1:1, Moments, Reading and group surfaces, lands *after* the last history message, and does **not** displace persona / core memory / long-term memory / history / `output_language_rule`. Non-vacuity control: flipping the entry to `enabled: false` in `prompt_order` makes it disappear while everything else still assembles, proving the assertions measure the assembler rather than a substring accident.

**Unrelated finding, NOT fixed (out of this task's scope):** the assembled chat prompt still carries Chinese from `lib/macro-engine.ts:247` and `lib/chat-time.ts:1` — `const weekdays = ["星期日", …]`, producing `当前系统时间：2026年8月5日10:12，星期三` inside `<chat_output_format>` on **every** chat prompt. Two more `.ts` files the `.tsx`-only Phase 1 sweep never covered. Pure display strings fed to the model; worth a look when the queue reaches them.

## ✅ `lib/internal-capability-storage.ts` (Chat Toolbox) — **DONE** (2026-08-08)
Two commits: `42dc72d`, `03d0070`. **582 → 131 CJK lines**, and all 131 are kept identifiers — verified mechanically by stripping the 44 tool names (longest-first) from every line and checking nothing Chinese remains: **0 unexplained CJK**. `tsc` 0 errors.

### The 44 tool names stay Chinese — measured, not assumed
**40 of 44 are literal dispatcher identifiers.** `tool-executor.ts` has **15 Chinese `case` labels** in its dispatch switch (`case "播放音乐":`, `case "添加日程":` …), plus `name === "播放音乐"`-style guards at `:790,797`; `notewall-utils.ts:425,468` passes `"发送便签"` / `"发送便签评论"` into `parseNoteWallToolCalls`; and `builtin-preset.ts:1518` teaches *"The action name must be exactly: 发送便签"*. Translating one silently breaks dispatch — the tool is called and matches nothing.

The other 4 (`网易云音乐`, `日历管理`, `本地资料库`, `工具箱管理`) are capability-level labels appearing elsewhere only *inside* error strings, never as identifiers. Left Chinese anyway: translating only those would leave the capability list half-English above its own still-Chinese sub-tools, and desync from the error messages in `tool-executor.ts` that name them. They belong to the tool-name rename track.

**Every name is now glossed in English on its introducing line** — `"Action: 发送便签 (post a note)"` — so an English-reading model knows what it does without the identifier moving.

### A missed producer from the protocol migration
All 33 directive examples taught `[执行动作:…]`. That name is **still parsed** (it is in `ACTION_DIRECTIVE_NAMES = "执行动作|工具调用|CallTool"`), so nothing was broken — but the migration's rule is *parsers accept both, **producers** emit English*, and `usageGuide` is producer-side: it teaches the model what to write. `tool-prompt.ts` moved to `[CallTool:…]` in its own phase, and `builtin-preset.ts:1441,1480` were unified to it *because they contradicted the new teaching*. **This file is the same class and was missed then.** All 33 converted.

### Two "write in Chinese" orders removed
`memory_write`'s `content` said `用简洁中文描述`, in both the schema description and the usage guide. Same family as the `vn-engine` / `interview-magazine` / `calendar` / `map-rpg` / `worldbook` traps — an instruction like that overrides `output_language_rule` for that field, so it is **deleted, not translated**.

### Template placeholders — safe, and verified before touching
The guide taught `{{参数名}}` / `{{{参数名}}}` / `{{steps.名称.data}}`. The engine is in `tool-executor.ts:2822` and matches a **generic** pattern (`[^{}\s]+`), not those words, so they are illustrative only. Now `{{paramName}}` / `{{steps.name.data}}`, matching what `components/settings/toolbox-settings.tsx` already teaches — that file was the other half of this pair and was translated back in Phase 1.

Also checked rather than assumed: the calendar `location` example now teaches `none` (not `无`) since `calendar-engine.ts` was made bilingual in D3, and `[MusicShare:…]` is a live alias in `rich-message-parser.ts:89`.

### Two process notes from this file
- **Splice with a tight, unique END anchor.** An end anchor set too far ahead swallowed a `TOOLBOX_REST_TOOL_PROPERTIES` const sitting between the two anchors. `tsc` caught it at once, but only because the const was referenced — a swallowed *string* block would have been silent.
- **Never chain a destructive checkout after a stash.** `git stash pop && git checkout <file>` discarded the three pieces the pop had just restored. Redone from the scratchpad blocks; keeping each translated block as a plain text file is what made recovery cheap.

## COUPLE SPACE (started 2026-08-11) — feature work, not translation
Priority set by the user: **Gift provenance → Couple Space shell → Reflection diary.** Mini-games (Route A) and gift resell+reaction come after. Confirmed decisions: **per-character** scope, and **no LLM calls of its own for the shell** (the reflection diary may change that in Stage 3; deferred).

Track 2 (the 3 remaining game imports — pocket-fishing, cute-pet, executive-diary) is **deferred wholesale** until Couple Space is done, to avoid fragmenting the work.

### Design facts established by the audit (re-derive from here, don't re-audit)
- **The calendar structurally cannot hold anniversaries.** `CalendarWeekPlan` is week-scoped (`weekStart` + items pinned to a literal `YYYY-MM-DD`); there is **no recurrence field anywhere in `calendar-types.ts`**. So "Couple Space owns its own anniversary store, calendar is read-only display" is forced, not a preference.
- **Projections reach long-term memory for free.** `memory-summarizer.ts:19,85` imports `loadNativeTimeline` + `formatTimelineForSummarization`, so anything registered as a projection in `loadNativeTimeline` flows into both short-term context *and* the long-term summarization pipeline. One projection module buys both.
- **Two layers are needed, because the data is two shapes.** Standing state (anniversary dates, current wishlist) must be a **macro** — `MacroContext` field + resolver in `macro-engine.ts`, populated in `llm-prompt-assembler.ts` at **4 sites** (`:718`, `:975`, `:2062`, `:2204` — 1:1 and group), consumed by a preset entry, which **requires a `BUILTIN_PRESET_VERSION` bump or it is dead code**. Use the `\x00TRIM\x00` sentinel so the block vanishes when empty. Episodic events (added to wishlist, gift given) are the **projection**.
- **8 registration points for a new app**: `desktop-config.ts` (IconId union + ICONS + PAGE_N_DEFAULT), `desktop-shell.tsx` (import + `activeApp` lazy mount), `icon-glyph.tsx`, `short-term-assembler.ts` (`sourceApp` union + `sourceDetail` union + `FEATURE_TAG` + the `loadNativeTimeline` block), `macro-engine.ts`, `llm-prompt-assembler.ts`, `builtin-preset.ts`, version bump. Binding Manager registration (`CONTENT_APP_LABELS`, `content-tag-utils.ts`) is only needed if the app makes its own LLM calls — the shell does not.
- Note the projection `label:` values in `loadNativeTimeline` are **still Chinese** (`便签墙`, `小红书`, `查手机`). Untranslated leftovers, unrelated to this work, but don't copy the pattern for new entries.

### Stage 1 — gift provenance: **DONE** (2026-08-11)
`lib/gift-provenance.ts` + `_fx-gift-provenance.mjs` (43/43) + `_fx-dexie-stub.mjs`. `tsc` exit 0.

**The finding that shrank the job: ~90% of the data was already captured.** `sendShoppingGiftMessage` (`chat-room.tsx:3412`) already writes ten provenance fields into `mediaData` (`shoppingGiftId`, `giftOrderId`, `giftItemId`, `giftMerchantLabel`, `giftPriceLabel`, `giftPreviewIcon`, `giftTone`, `giftDeliveredAt`, `giftSentAt`, `senderName`, plus `recipientId`/`recipientName` in groups). What was missing was an **index** — `loadSentShoppingGiftIds` (`shopping-gift-utils.ts:55`) walks every session x every message and keeps only a `Set` of ids, discarding recipient, date and price. So Stage 1 is a projection over existing data, not a new capture schema.

**Deliberately ADDITIVE — nothing existing was modified.** `loadSentShoppingGiftIds` is untouched and still scan-based, because it is what stops an already-sent gift being offered again; swapping it for an index read would make every historical gift re-giftable the moment the index was empty. **Messages stay the source of truth for "was this sent"; the index is the source of truth for "what is our gift history".** Fixture C1/C2 pin that the old scan still behaves exactly as before.

**Append-only by design**: syncing never drops a record just because its message was deleted — a gift given stays given even if the chat is cleared. That is the product guarantee B19/B20 exist to protect.

Also records **character→user** gifts (AI-sent `mediaType: "gift"` bubbles, which have no `shoppingGiftId`) keyed as `msg:<messageId>`, so gift history is two-directional without a later migration.

Not hooked into the send path on purpose: `sendRichMessage` returns a boolean, not the message id, so there is nothing to record at that moment. `syncGiftProvenanceFromMessages()` is idempotent and cheap — Stage 2 calls it when Couple Space opens. Only cost is a gift whose message is deleted *before* the first ever sync.

**Two bugs caught in my own code before it ran:**
1. `cleanText` initially did `.replace(/\s+/g, "")` — a blanket whitespace strip. Invisible in Chinese, but it turns "Blue Ceramic Mug" into "BlueCeramicMug". **Exact instance of the Chinese-sized-limit bug class documented above.** Fixture A5 is the permanent guard.
2. The NUL-stripping regex was written as a **literal NUL byte embedded in the source** (`cat -A` shows `^@`), not the escape `\u0000`. Behaviour was right, encoding was fragile. Verify with `s.split(String.fromCharCode(0)).length - 1 === 0`.

**Non-vacuity was run, not asserted.** Control 1 (restore the whitespace strip) → **40/43**, failing exactly A5/B13/B20. Control 2 (rebuild instead of merge) → **39/43**, failing exactly B15/B16/B19/B20.

**`_fx-dexie-stub.mjs` is now permanent** (~90 lines: put/bulkPut/get/toArray/delete/bulkDelete/clear/where().equals()/anyOf). Aliasing `dexie` to it via jiti lets a fixture drive the **real** `chat-storage`, `character-storage` and `kv-db` instead of copies of their logic. Reusable by any future storage fixture; the earlier `_fx-annots.mjs` had to invent the same thing and it was deleted.

**Process reminder, hit twice this session:** `node -e "…"` through bash mangles regex escapes — a control that silently does not apply looks exactly like a passing test. Both times the fix was a **script file** written with the Write tool. Always verify the edit landed (`sed -n`) before believing a non-vacuity result.

### Stage 2a — Couple Space data layer: **DONE** (2026-08-11)
`lib/couple-space-types.ts`, `lib/couple-space-storage.ts`, `lib/couple-space-memory.ts`, `_fx-couple-space.mjs` (61/61). `tsc` exit 0. No existing file touched yet — registration is 2c.

**`couple-space-storage.ts` must never import `couple-space-memory.ts`.** Storage imports only `kv-db` + types, which keeps it a leaf. The memory module imports `formatChatTimestamp` from `llm-prompt-assembler`, so a storage→memory edge would close a cycle the moment 2b touches the assembler — the same class of bug as the `prompt-sanitizer` → `block-tags` extraction. The UI calls storage CRUD and the record functions side by side, which is exactly what note-wall does (`notewall-storage.ts` does not import `notewall-memory.ts` either).

**2b will follow the `currentSchedule` pattern, not an import.** `llm-prompt-assembler` never computes the schedule itself — `engine.currentSchedule = input.currentSchedule ?? ""` at `:718`, `:975`, `:2062`, `:2204`, with the caller passing the value in. Couple Space standing state does the same, so the assembler gains no new import and no cycle is possible. (`llm-prompt-assembler` does reference `short-term-assembler`, but as `import type`, which is erased.)

**Date math is a pure exported function** (`computeUpcomingAnniversary`) so rollover is testable without storage. All arithmetic runs on `Date.UTC` midnights built from Y/M/D parts — never `new Date(string)` mixed with `new Date(y,m,d)`, which are UTC and local respectively and shift "days until" by one either side of the date line. Recurring **29 February falls back to 28 February** in common years; 1 March would move the date into the wrong month.

**Projection content carries its own `[Couple Space <time>]` head**, matching note-wall. `formatStoredPromptEventContent` (`prompt-time.ts:79`) only *rewrites* an existing `[label]` head and adds nothing when it is absent — so content without the head silently loses its timestamp on time-aware surfaces.

Non-vacuity run, not asserted: removing the roll-forward branch gives **58/61** (A4/A5/A14); a blanket whitespace strip gives **57/61** (C2/C3/C9/C13).

**The NUL trap recurred twice more** while writing this stage (once in a source file, once in CLAUDE.md itself). Writing ` ` in a file body can land as a raw 0x00 byte. `C:\Users\hp\...\scratchpad\denul.mjs` fixes a file in place; check any new file with `s.split(String.fromCharCode(0)).length - 1`.

## Still open / not yet done
- **`[系统指令]` / `[事件 …]` short-term timeline labels** (found 2026-08-06 during the offline/online research). Sites: `lib/short-term-assembler.ts:222,313`, `lib/chat-storage.ts:286,318`, `lib/chat-offline-storage.ts:178`. **These are read by the model** — they label system-instruction and offline-event entries inside the short-term event stream — so treat them as protocol, not as UI text: **make every consumer bilingual first (accept the legacy Chinese label AND the new English one), then flip the producers**, same dual-recognition pattern as the rest of this migration. Do not translate them in place; grep for every producer *and* every consumer of each label before touching either side (the `tool-executor` / `FETCH_RESULT_HEADER` / `prompt-sanitizer` regressions were all "one side moved, one consumer left behind").
- `lib/macro-engine.ts:247` + `lib/chat-time.ts:1` Chinese weekday/date formatting reaching every chat prompt (found 2026-08-05, see above).
- `notifyMascotPageContext` label in `components/chat/phone-chat-app.tsx` (2 call sites) — flagged since round 2, needs revisiting per the standing-rule note above.
- `app/api/**/route.ts` — ~420 Chinese occurrences across 43 files, scope not yet decided (see "Scope note" above) — ask the user before starting.
- The handful of out-of-scope `.ts` files under `components/world-builder/` and `components/debug-prompt-registry.ts` noted above — never explicitly in scope (rule 1 says `.tsx` only), no decision needed unless the user wants to expand scope.
- Newly-discovered AI-prompt files added to the protected list this session (ask before touching): `lib/rich-message-parser.ts`, `lib/group-admin.ts`, `lib/memory-types.ts`. Full protected list is in the "AI PROMPT/PROTOCOL TEXT" section above.

**Gotcha to check on every remaining file**: also grep for CJK-range `\u` escape sequences (`\\u[4-9a-fA-F][0-9a-fA-F]{3}`), not just literal Chinese characters — `phone-theme-app.tsx` had ~15 strings hidden this way that the literal-character grep missed.

**Round 2 of batching (2026-07-28), 23 files, 5 parallel agents (3 solo + 2 batches of 10), `npm run build` passes:**

- `world-builder/GenerateModal.tsx` — **done**, 97 strings. Self-contained category sentinel (导入/自定义/角色) translated consistently, aligned with `ImportModal.tsx` terminology (Import/Custom/Character) for cross-modal product consistency.
- `mascot/mascot-float.tsx` — **done**, ~90 strings. Placeholder sentinel "一行文字" (5 occurrences) translated consistently to "Sample text". **New protocol exception**: line 66,963 — `/^（(调用工具中|无内容)/.test(msg.displayText)` matches literal `"（调用工具中...）"`/`"（无内容）"` produced by `lib/mascot-chat-store.ts:433` and compared again at `lib/mascot-chat-store.ts:111,560` and `components/chat/mascot-chat-room.tsx:72` — left in Chinese. Checked `[图片]` fallback text too (used elsewhere in codebase) but confirmed zero equality/match consumers — safely translated to `[Image]`.
- `app-market/custom-app-runner.tsx` — **done**, ~60 strings, no protocol exceptions. One follow-up fix by me: `<html lang="zh-CN">` (fallback iframe wrapper doc, line 130) → `lang="en"` — not literally "UI text" so the agent flagged rather than changed it; safe one-line change, applied.
- **Batch C (10 files)**: checkphone-assets-page, checkphone-app, checkphone-music-page, checkphone-douban-page, checkphone-bilibili-page, character/world-tabs, world-builder/WorldBuilder, quick-action-float, desktop-customizer, checkphone-photos-page — all done. Confirmed pre-flagged exceptions (assets-page `formatChatUiTime` matching, bilibili-page `progressLabel` matching `fields["看到哪了"]`, douban-page tabs translated self-consistently). **New exception found**: `checkphone-music-page.tsx` — `getMusicMonthlyMinutes()`/`getMusicTopArtistName()` regexes (`/^分钟?/`, `/^最近偏爱[:：]?\s*/`) match AI-generated default values `profileFields["本月时长"]`/`topArtistLabel` from `lib/checkphone-engine.ts:6260-6261,6347-6348` — left `"分钟"`/`"最近偏爱"` in the matching regexes, translated the unrelated static label elsewhere. Also rewrote a few display-only formatters (万→k/M count abbreviations, `YYYY年MM月DD日`→`YYYY-MM-DD`) — pure presentation, not matched anywhere, safe.
- **Batch D (10 files)**: world-builder/PropertyPanel, auth/account-gate, checkphone-phone-page, checkphone-email-page, widgets/diy-widget-editor, checkphone-reading-page, reading/reading-appearance-dialog, checkphone-messages-page, world-builder/SettingsModal, checkphone-browser-page — all done. **New exceptions found**: `account-gate.tsx` — two regexes matching literal error strings from `lib/account-client.ts:43` and multiple `app/api/auth/*/route.ts` files (out of scope .ts files) — left in Chinese; `checkphone-email-page.tsx` — date regex `/^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/` parses AI-generated `email.timeLabel`, left in Chinese, only translated the derived "今天"/"昨天" display strings.

Emerging pattern across both rounds: date/time and count-progress parsing regexes in `components/checkphone/*` very often match either AI-generated content from `lib/checkphone-engine.ts` or shared Chinese-output formatters from `lib/chat-time.ts` — check for this specifically on every remaining `checkphone-*.tsx` file.

**Round 3 (2026-07-28), 20 files, 8 parallel agents (6 solo + 2 batches of 7), `npm run build` passes. Session hit its usage limit twice mid-round (all 8 agents failed simultaneously the first time — verified zero files were touched before retrying; batch E failed a second time after making real progress on 5/7 files — resumed cleanly via `SendMessage`, no rework needed since progress was preserved).** This was the most protocol-dense round yet:

- `settings/regex-manager.tsx` (88), `settings/weixin-settings.tsx` (85), `interview/interview-magazine-app.tsx` (83) — done, clean. `regex-manager.tsx`'s 2 `notifyMascotPageContext` labels translated per standing rule. `interview-magazine-app.tsx`: found dead code (`CHINESE_DIGITS`/`formatChineseOrdinalNumber`, never called) left as-is since it's not rendered UI text; found `phase: "..."` values (5 spots) that get interpolated into a Chinese-language LLM prompt template in `lib/interview-magazine-engine.ts:387` — left in Chinese.
- `reading/reading-viewer.tsx` (83) — done. Calls `parseAIResponse` from protected `lib/rich-message-parser.ts` as a function only (safe). **New protocol marker found**: `[无批注]` (line 748) — matched by `lib/reading-engine.ts:316`'s `.includes("[无批注]")` check and taught to the AI at `lib/builtin-preset.ts:3884` — left in Chinese.
- `desktop-shell.tsx` (77 Chinese / 4151 total lines) — done, the main app shell. **Major protocol finding**: this file directly *constructs* the chat call-protocol bracket tags — `callLabel = "语音通话"/"视频通话"`, then `` content: `[我向群聊发起了${callLabel}]` ``/`` `[我向${userName}发起了${callLabel}]` ``/`` `[我拒绝了${callLabel}]` `` (lines 1637-1650, 3611-3615) — matched by `CALL_SYS_RE` in `components/chat/chat-message-list.tsx:86` and further logic in `lib/chat-storage.ts`. Also found `"对方"` (the other party) as a cross-file sentinel matched in `lib/chat-storage.ts`, `lib/checkphone-engine.ts`, `chat-room.tsx`, `message-bubble.tsx`. All left in Chinese with inline `// NOTE: must stay in Chinese` comments added for future editors. Also had ~15 more `\u`-escaped Chinese strings (a `TEXT` constant) that the literal-character grep missed — translated. `<html lang="zh-CN">` in an embedded popup → `"en"`.
- `checkphone/checkphone-chat-page.tsx` (52 Chinese / 2197 total lines) — done. Confirmed the pre-flagged `tagLabel === "真实会话"` and date-parsing regex family, then found a WIDER family of the same pattern: `parseCheckPhoneTimeRank` and its generator counterparts (`formatCheckPhoneDisplayTime`, `formatCheckPhoneRelativeTime`, `formatCheckPhoneGroupActivityLabel`, `formatCheckPhoneDisplayDate`), a sticker bracket-tag regex (`CHECKPHONE_STICKER_RE` + `"表情包"` fallbacks), and count-label formatters (`formatGroupMemberCountLabel`, `formatMomentCountLabel`) — all matching `lib/checkphone-engine.ts` output, left in Chinese. The `mediaLabel` regex (line 507) was left in Chinese out of caution — producer confirmed AI-generated but exact prefix vocabulary unverified.
- **Batch E (7 files)**: widget-renderer, debug-prompt-panel, world-builder/SceneViewport, story/story-app-base, checkphone-xiaohongshu-page, music/music-app, map/map-lobby — all done. `music-app.tsx`'s self-contained `musicToast` sentinel (separate instance from `music-player.tsx`) translated consistently. `map-lobby.tsx`'s `DEFAULT_*_PROMPT` imports from protected `lib/map-rpg-engine.ts` confirmed reference-only, untouched. `checkphone-xiaohongshu-page.tsx`: found a self-contained producer/consumer pair (`` `发布于 ${...}` `` built by `makeXiaohongshuNoteTimeLabel()`, stripped via `/^发布于\s*/` elsewhere in the same file) — both sides translated consistently to `"Posted "`. `widget-renderer.tsx`: found actual image asset filenames (`老橙子素材.png`, `小鸟*.png`) and intentional Japanese decorative text in a postcard widget — correctly left untouched (not translatable UI text). One stylistic curly-quote pair at `widget-renderer.tsx:1230` (`"{quote}"` wrapping JSX text content, not an attribute delimiter) confirmed pre-existing/intentional typography, left alone.
- **Batch F (7 files)**: binding-manager, worldbook-manager, checkphone-weibo-page, api-settings, moderation-center, phone-settings-app, diary-entries-app — all done. `worldbook-manager.tsx`'s 3 `notifyMascotPageContext` labels translated per standing rule. **New protocol finding**: `checkphone-weibo-page.tsx:250` — `post.authorBadge !== "本人"` (self/own-post marker) matches AI-generated `authorBadge` field (`fields["身份"]` in `lib/checkphone-engine.ts`), taught to the AI via `lib/builtin-preset.ts:3577` (`[身份]本人`) — left in Chinese.

**Reinforced lesson**: several files this round (`desktop-shell.tsx`, `checkphone-chat-page.tsx`) turned out to be far more protocol-dense than their small Chinese-line count suggested — line count is not a reliable signal of protocol risk, especially for files that are chat-adjacent or `checkphone-*`. Keep pre-scanning every file for content-matching patterns regardless of size, and keep re-verifying smart quotes after every agent completion (or resume), not just once.

Re-derive the live list anytime with:
```
rg -c "[\x{4e00}-\x{9fff}]" components --glob '!components/chat/**'
```

Then `app/**/*.tsx` (much smaller — mostly `verify/`, `app-market/admin/`, `characters/`).

## Process to follow (worked well so far)
1. Pick one folder/feature area at a time (don't do "all of components/" in one shot).
2. For files with Chinese-line counts ≳ 300 lines total or ≳ 40 Chinese-containing lines, dispatch as their own background sub-agent; group several small files (< ~15 Chinese-containing lines) into one sub-agent batch. Never let two agents touch the same file concurrently.
3. Give every agent the same glossary (below) plus the full protocol-string warning above, and tell them to report per-file counts translated + any strings skipped as protocol/uncertain with file:line.
4. After a folder's agents all report back, run `npm run build`, grep the folder for stray smart quotes and remaining Chinese, then summarize for the user before starting the next folder.
5. Before touching any file in the "AI PROMPT/PROTOCOL TEXT" list above, stop and ask.

## Glossary (keep consistent)
设置=Settings, 取消=Cancel, 确定/确认=Confirm, 保存=Save, 删除=Delete, 编辑=Edit, 返回=Back, 关闭=Close, 发送=Send, 群聊=Group Chat, 群主=Group Owner, 管理员=Admin, 禁言=Mute, 解除禁言=Unmute, 移出群聊=Remove from Group, 转让群主=Transfer Ownership, 备注=Note, 聊天记录=Chat History, 群成员管理=Manage Group Members, 拉人进群=Add Members, 置顶聊天=Pin Chat, 双语翻译=Bilingual Translation, 表情包=Sticker, 全屏特效=Fullscreen Effects, 聊天背景=Chat Background, 视频通话=Video Call, 语音通话=Voice Call, 钱包=Wallet, 转账=Transfer, 收款=Receive Payment, 红包=Red Envelope, 群名称=Group Name, 用户=User, 角色=Character, 好友=Friend, 联系人=Contact, 朋友圈=Moments, 发布=Post, 评论=Comment, 点赞=Like, 图片=Image, 视频=Video, 文件=File, 语音=Voice, 未设置=Not set, 已设置=Set, 清除=Clear, 已读=Read, 已过期=Expired, 撤回=Recall, 正在输入=Typing, 人设=Persona, 世界观=Worldview/Setting, 余额=Balance, 支付=Pay.

## Environment notes
- Repo root (this file's directory) is nested one level under `D:\Documents\Claude\ai-virtual-phone-main\`.
- `npm install` was required before `npm run build` worked (node_modules wasn't present).
- Windows machine; use PowerShell or Git Bash as available.
