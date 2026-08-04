# Protocol Token Migration Plan (dual-recognition)

**Status: APPROVED by user 2026-07-28. Phase A1 COMPLETE.**

| Phase | Scope | Status |
|---|---|---|
| A1 | `lib/rich-message-parser.ts` bilingual | ✅ done — 45/45 fixture, build + tsc clean |
| A4 | guard lists (`state-value-parser`, `custom-app-chat-directives`) | ✅ done — 11/11 fixture |
| A2 | `lib/action-parser.ts` (family 7) | ✅ done — 19/19 fixture |
| A3 | `lib/text-tool-protocol.ts` (family 8) | ✅ done — covered by same fixture |
| **A** | **all parsers bilingual — nothing emits English yet** | ✅ **COMPLETE** |
| B | renderers/serializers bilingual on the read side | ✅ done — 18/18 fixture; new `lib/call-tag-patterns.ts` |
| C1 | `lib/group-admin.ts` producer (family 5) | ✅ done — 27/27 fixture, **smoke test passed** |
| C2 | call tags (family 2), 15 sites / 7 files | ✅ done — 37/37 fixture, **smoke test passed** |
| C3 | rich-media tags — new `lib/rich-tag-builders.ts`, ~40 sites / 5 files | ✅ done — 48/48 fixture, **smoke test passed** |
| C4 | default payload labels (family 10) | ✅ code done — 18/18 fixture, ⬜ smoke test |
| **C** | **all producers emit English** | ✅ complete, all smoke tests passed |
| D1a | tag contracts in `builtin-preset.ts` | ✅ code done — 99/99 + 9/9 fixtures, ⬜ smoke test |
| D1b | remaining `builtin-preset.ts` prose (~2296 lines) | ⬜ sub-agent work, no protocol risk |
| D2 | `mascot-prompts.ts`, `mascot-tools.ts`, `custom-sticker-storage.ts:260` | ⬜ |

**Parsers discovered late (add to any future audit):** `lib/moments-engine.ts:1155-1164` has its OWN photo/block parser separate from `rich-message-parser.ts` — found only because the D1a contract fixture flagged the photo templates. If another feature-specific parser exists, the same class of bug is waiting there. Grep for `\[照片` / `\[朋友圈` style literals outside the four known parser files before trusting that Phase A covered everything.
| D–E | see below | ⬜ |

**Lesson repeated in C1 and C2:** the phase list under-counts producer sites every time. Always re-sweep with a regex for the raw tag shape before editing — C2's plan entry said "call screens + desktop-shell" but there were 15 sites across 7 files, 3 of them in `lib/`.

### Call-tag English forms (locked by Phase B)
`[I started a voice call with X]` · `[I started a video call with X]` · `[I started a voice call]` (no target) · `[I ended the voice call](duration MM:SS)` · `[I declined the voice call]` · `[I cancelled the voice call]` (also accepts `canceled`). Group: initiate uses **target** `the group` (call type stays ungrouped, mirroring `[我向群聊发起了语音通话]`); hangup/reject/cancel use `the group voice call` (mirroring `[我挂断了群语音通话]`).

### Agreed English token names (locked in by Phase A1 — later phases must match exactly)
`RedPacket` · `Transfer` · `PaymentRequest` · `Gift` · `ContactCard` · `Photo` (`WithRef`/`NoRef`) · `Location` · `Sticker` · `Quote` · `Music` · `MusicShare` · `VoiceNote` · block tags `StatusPanel` / `InnerThoughts`

Action shells (family 7): `Moments` · `GroupMessage` · `Comment` · `Reply` · `Message` · `DirectMessage` — canonical internal type stays Chinese; open/close must use the same spelling.

Tool directives (family 8): `FetchTool` (= 获取指令/获取工具) · `CallTool` (= 执行动作/工具调用)

Sentence forms: `[A poked B]` · `[I started a voice call with X]` · `[I started a video call with X]` · `[A claimed|returned the red envelope from B]` · `[A accepted|claimed|declined|returned the transfer from B]` · `[A accepted|approved|paid|covered|rejected|declined|returned the payment request from B]` · `[A transferred group ownership to B]` · `[A made B an admin]` · `[A removed admin from B]` · `[A removed B from the group]` · `[A invited B to the group]` · `[A muted B for N minutes|hours|days]` · `[A muted B: N minutes]` · `[A unmuted B]` · bare forms `[ClaimRedPacket]` `[DeclineRedPacket]` `[AcceptTransfer]` `[ClaimTransfer]` `[DeclineTransfer]` `[AcceptPaymentRequest]` `[DeclinePaymentRequest]`

### How to re-run the Phase A verification
`node_modules/.bin/jiti` is available, so the real TS parser can be imported from a plain Node script — no test runner needed. Drop a `.mjs` file **inside the repo** (so `jiti` resolves), `createJiti(import.meta.url, { alias: { "@": ROOT } })`, `await jiti.import(ROOT + "/lib/rich-message-parser.ts")`, then feed each tag in both languages through `parseAIResponse` and diff `mediaType` + `mediaData`. Delete the file afterwards. Extend this fixture at every later phase.

Goal: move the AI-facing bracket-tag protocol from Chinese tokens to English tokens **without breaking existing stored chat history**, using backward-compatible dual-recognition (parsers accept both; producers emit English going forward; Chinese patterns kept permanently as read-only legacy).

---

## 0. Why dual-recognition and not a rename

Three facts make a straight rename unsafe:

1. **Tags are persisted into user data.** Producers write literal tags into message `content` fields (`desktop-shell.tsx:1642,1650,3615`, `voice-call-screen.tsx:514,738,766`, `video-call-screen.tsx:516,859,882`, `group-call-screen.tsx:380,496,521`, `chat-storage.ts:1145`, `follow-up-service.ts:632`). Every existing user chat log contains Chinese tags.
2. **The protocol is a closed round-trip loop.** AI emits tag → `rich-message-parser` → stored as `mediaType`/`mediaData` → `chat-storage` serializes for preview/history → **`llm-prompt-assembler.ts:1390,1393` re-serializes back into Chinese tags and feeds them to the AI as next-turn context**. Breaking any link corrupts the loop.
3. **No compile-time safety.** Every link is a string/regex match. A missed site fails silently at runtime; `npm run build` still passes.

Additional complication: **the tokens are ordinary Chinese words** (`红包`=red envelope, `评论`=comment, `音乐`=music, `位置`=location). They appear both as protocol tokens *and* as ordinary UI vocabulary and user-content. Raw site counts (`评论` 578, `回复` 396, `音乐` 138) are mostly false positives — **no blind find-and-replace is possible; every site needs individual classification.**

---

## 1. Tag inventory (~50 variants across 10 families)

### Family 1 — Rich-media inline tags (`lib/rich-message-parser.ts` `RICH_PATTERNS`)
| # | Tag | → mediaType |
|---|---|---|
| 1 | `[红包:金额:个数:留言]` | red_packet (3-arg) |
| 2 | `[红包:金额:留言]` | red_packet (2-arg legacy) |
| 3 | `[转账:金额:留言]` / `[转账:金额:留言:转账人:收款人]` | transfer |
| 4 | `[代付请求:总金额:商品/详情/价格/数量]` | payment_request |
| 5 | `[礼物:商品名:收礼人]` / `[礼物:商品名:送给收礼人]` | gift (group) |
| 6 | `[礼物:商品名]` | gift (1:1) |
| 7 | `[名片:角色名]` | contact_card |
| 8 | `[照片:使用参考图\|不使用参考图:描述]` | image (+ref flag) |
| 9 | `[照片:描述]` | image |
| 10 | `[位置:地点]` | location |
| 11 | `[A拍了拍B]` | poke |
| 12 | `[表情包:名称]` | sticker |
| 13 | `[引用:预览]正文` | quote |
| 14 | `[音乐:歌名-歌手]` | music |
| 15 | `[音乐分享:歌名]` | music_share |
| 16 | `[语音条:文字]` | audio |

### Family 2 — Call tags (parser + UI producers)
| # | Tag |
|---|---|
| 17 | `[我向X发起了语音通话]` |
| 18 | `[我向X发起了视频通话]` |
| 19 | `[我挂断了X通话](时长 …)` |
| 20 | `[我拒绝了X通话]` |
| 21 | `[我取消了X通话]` |
| 22 | group variants: `[我向群聊发起了X]` / `[我挂断了群X]` / `[我拒绝了群X]` / `[我取消了群X]` |

Matched by `CALL_SYS_RE` (`components/chat/chat-room.tsx:86`) and replace-patterns at `chat-room.tsx:3012,3025,3029,3031`.

### Family 3 — Accept/decline with subject+object (group form)
| # | Tag |
|---|---|
| 23 | `[A领取了B的红包]` |
| 24 | `[A退回了B的红包]` |
| 25 | `[A(接受\|领取)了B的转账]` |
| 26 | `[A(拒收\|退回)了B的转账]` |
| 27 | `[A(接受\|同意\|支付\|代付)了B的代付]` |
| 28 | `[A(拒绝\|拒收\|退回)了B的代付]` |

### Family 4 — 1:1 simple accept/decline
| # | Tag |
|---|---|
| 29-34 | `[领取红包]` `[拒收红包]` `[接受转账]`/`[领取转账]` `[拒收转账]` `[接受代付]` `[拒绝代付]` |

### Family 5 — Group admin (`lib/group-admin.ts` producer ↔ parser)
| # | Tag |
|---|---|
| 35 | `[A将群主转让给了B]` (+ non-protocol `[A收回了群主身份]`) |
| 36 | `[A将B设为了管理员]` |
| 37 | `[A取消了B的管理员]` |
| 38 | `[A将B移出了群聊]` |
| 39 | `[A邀请B加入了群聊]` |
| 40 | `[A将B禁言N分钟]` / `[A禁言了B:N分钟]` (units 分钟/小时/天) |
| 41 | `[A解除了B的禁言]` |

Note `group-admin.ts` has **two** parallel generators: `buildGroupAdminNoticeText` (display prose, lines 175-182) and the protocol-tag generator (lines 200-207). Only the second is protocol; both need care.

### Family 6 — Hidden block tags (`extractBracketBlock`)
| # | Tag |
|---|---|
| 42 | `[状态栏]…[/状态栏]` |
| 43 | `[内心]…[/内心]` |

### Family 7 — Action shells (`lib/action-parser.ts`)
| # | Tag |
|---|---|
| 44-49 | `[朋友圈]…[/朋友圈]`, `[评论 "kw"]…[/评论]`, `[回复 "kw"]…[/回复]`, `[消息]…[/消息]`, `[私信]…[/私信]`, `[群消息 "群名"]…[/群消息]` — each also has a group form `["角色名"朋友圈]` |

### Family 8 — Tool directives (`lib/text-tool-protocol.ts`)
| # | Token |
|---|---|
| 50 | `[…获取指令:…]` / `获取工具` |
| 51 | `执行动作:` / `工具调用:` |

### Family 9 — Guard / reserved-name lists (must gain English names too)
- `lib/state-value-parser.ts:12` `RICH_MEDIA_NAMES` (8 names) — prevents `[表情包:11]` being read as a state value.
- `lib/custom-app-chat-directives.ts:15-33` `BUILTIN_DIRECTIVE_LABELS` (18 names) — stops user custom-apps shadowing builtin tags.

### Family 10 — Chinese literals the parser *writes into* `mediaData` (not tags, but protocol-adjacent)
`"恭喜发财"` (default red-packet blessing), `"转账"` (default transfer label), `"角色赠礼"`/`"心意礼物"` (gift merchant/price), `"代付请求"` (label, matched by `shopping-app.tsx:906`), `"待确认"` (directive status), `"查看"` (default action), `参数N` (arg labels).

---

## 2. File matrix

**Parser layer (read side)**
| File | Families |
|---|---|
| `lib/rich-message-parser.ts` | 1, 2, 3, 4, 6, 10 |
| `lib/action-parser.ts` | 7 |
| `lib/text-tool-protocol.ts` | 8 |
| `lib/state-value-parser.ts` | 9 (guard) |
| `lib/custom-app-chat-directives.ts` | 9 (guard) |

**Serializer / round-trip layer**
| File | Role |
|---|---|
| `lib/chat-storage.ts` (129 zh lines) | history + preview serialization (`:268` preview labels, `:1145` poke tag, `:343-349`) |
| `lib/llm-prompt-assembler.ts` (71) | **re-serializes stored msgs back into tags for the AI** (`:1390,1393`) |
| `lib/follow-up-service.ts` (34) | generates tags (`:628,632`) |
| `lib/group-admin.ts` (34) | generates family-5 tags (`:200-207`) |

**Teaching layer (system prompts)**
| File | Role |
|---|---|
| `lib/builtin-preset.ts` (2405 zh lines, **976 contain a bracket tag**) | teaches the AI every family |
| `lib/mascot-prompts.ts` (532) / `lib/mascot-tools.ts` | mascot-side teaching + tool names |

**UI layer (already phase-1 translated, Chinese protocol strings deliberately preserved)**
`components/chat/chat-room.tsx`, `message-bubble.tsx`, `chat-message-list.tsx`, `chat-settings-panel.tsx`, `voice-call-screen.tsx`, `video-call-screen.tsx`, `group-call-screen.tsx`, `components/desktop-shell.tsx`, `components/shopping/shopping-app.tsx`, `components/memory/memory-timeline.tsx`.

---

## 3. Work order (each phase leaves the app fully working)

### Phase A — make parsers bilingual *(purely additive, zero behavior change)*
Add English alternatives to every pattern so parsers accept Chinese **and** English. Nothing emits English yet, so there is no observable change; this phase is the safety net for everything after.
- A1 `rich-message-parser.ts` (families 1-4, 6)
- A2 `action-parser.ts` (family 7)
- A3 `text-tool-protocol.ts` (family 8)
- A4 guard lists — `state-value-parser.ts`, `custom-app-chat-directives.ts` (family 9)

Verify: build + a fixture that feeds sample AI output in **both** languages through `parseAIResponse` and asserts identical `parts` output.

### Phase B — make renderers/serializers bilingual *(still nothing emits English)*
Every consumer that matches **stored** content must recognize both forms. This is the step that guarantees old history keeps rendering.
- B1 `chat-room.tsx` `CALL_SYS_RE` + the 4 replace-patterns
- B2 `message-bubble.tsx`, `chat-message-list.tsx`
- B3 `chat-storage.ts` preview/history serialization
- B4 `llm-prompt-assembler.ts` re-serialization (accept both on read)

Verify: build + open an existing chat with old Chinese-tag history and confirm rendering unchanged.

### Phase C — flip producers to emit English, one family at a time
- C1 family 5 — `group-admin.ts` (self-contained, smallest, best first)
- C2 family 2 — call screens + `desktop-shell.tsx`
- C3 families 1/3/4 — `follow-up-service.ts`, `llm-prompt-assembler.ts` write side
- C4 family 10 — `mediaData` default literals (+ update `shopping-app.tsx:906` match)

Verify per family: build + manual smoke test of that feature (send/accept a transfer, red envelope, call, kick/mute, etc.).

### Phase D — flip the teaching prompts *(last)*
- D1 `builtin-preset.ts` — family by family, matching exactly what Phase C emits
- D2 `mascot-prompts.ts` / `mascot-tools.ts`

Must come last: teaching English before A/B are in place would break parsing immediately.

### Phase E — permanent legacy support
Keep every Chinese pattern in the parsers forever, marked `// LEGACY: matches pre-migration stored history — never remove`. No data rewrite, no migration script.

---

## 4. Known risks / open items

1. **No compile-time safety** — needs a manual smoke-test checklist per family. Recommend building the both-language parser fixture in Phase A and extending it each phase.
2. **Tool names are code identifiers** — `lib/cocreate-tools.ts` has `handle切换` as a *function name*, `case "切换":`, `Set(["查看","追加","编辑","删除","切换"])`, matched from `cocreate-app.tsx:1355`. Same for mascot tool names matched by `preset-manager.tsx:86-93`. These are a **separate rename track**, not part of the tag protocol — decide separately.
3. **`builtin-preset.ts` is 976 bracket-tag lines** — Phase D is by far the largest single chunk; it should be split per family, not done in one pass.
4. **Saved user config shadows new defaults** — `loadMemoryConfig()` does `{...DEFAULT, ...stored}`, so any user who ever changed a memory setting keeps the *old* stored prompt; translated defaults only reach fresh installs or users who press "Restore Default". The same pattern likely applies to other prompt defaults (`lib/map-rpg-engine.ts`, `lib/vn-engine.ts`, DM prompt config). Not a bug to fix here, but it means prompt translations land gradually.
5. **Mixed-language prompts during rollout** — between Phase C and D the AI is taught Chinese tags while some producers emit English; both are parsed, so it works, but keep the window short per family.

---

## 5. Recommended first step

Phase A1 on `lib/rich-message-parser.ts` only — purely additive, self-contained, and it makes every later phase safe. Nothing user-visible changes.
