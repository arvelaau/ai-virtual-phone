// lib/rich-tag-builders.ts
//
// Single source of truth for WRITING rich-media protocol tags.
// The reading side lives in lib/rich-message-parser.ts (bilingual since Phase A);
// this module is the Phase C3 write side.
//
// Before this existed the same tag formats were hand-written in three places —
// lib/llm-prompt-assembler.ts once and lib/short-term-assembler.ts twice — which
// is exactly how a producer drifts out of sync with its parser. Every producer
// must go through these helpers.
//
// SCOPE NOTE (C3): only the tag NAME is English here. Default payload labels
// (恭喜发财 / 转账 / 礼物 / 联系人 / 语音消息 / 表情 / 贴纸 / 未知歌曲 …) are
// content, not protocol, and are deliberately left to Phase C4 so their wording
// can be decided deliberately. A tag like [RedPacket:100:恭喜发财] is perfectly
// valid in the meantime — the parser treats the label as free text.
//
// See PROTOCOL-MIGRATION-PLAN.md.

// ── Default payload labels (Phase C4) ──────────────────────
//
// Used when the AI omits an optional field. These are CONTENT, not protocol —
// nothing matches them — so the wording simply mirrors what Phase 1 already
// shipped as the visible fallback in components/chat/message-bubble.tsx, keeping
// a message's stored label identical to what the UI would have shown anyway.
// Old messages keep whatever Chinese label they were stored with; that is fine,
// the field is free text.
export const DEFAULT_RED_PACKET_BLESSING = "Best wishes and good fortune"; // message-bubble.tsx:649,1697
export const DEFAULT_TRANSFER_NOTE = "Transfer";                           // message-bubble.tsx:690,1697
export const DEFAULT_PAYMENT_REQUEST_LABEL = "Payment Request";            // message-bubble.tsx:1697
export const DEFAULT_GIFT_NAME = "Gift";                                   // message-bubble.tsx:1070
export const DEFAULT_GIFT_MERCHANT_LABEL = "Character Gift";
export const DEFAULT_GIFT_PRICE_LABEL = "A Thoughtful Gift";               // message-bubble.tsx:1116
export const DEFAULT_CONTACT_NAME = "Contact";                             // message-bubble.tsx:1030
export const DEFAULT_VOICE_NOTE_TEXT = "Voice Message";                    // message-bubble.tsx:2162
export const DEFAULT_LOCATION_NAME = "Location";                           // message-bubble.tsx:1360
export const DEFAULT_STICKER_NAME = "Sticker";                             // message-bubble.tsx:1490,1509
export const DEFAULT_MUSIC_TITLE = "Unknown Song";                         // message-bubble.tsx:2074
export const DEFAULT_PHOTO_DESCRIPTION = "Image";                          // message-bubble.tsx:1953

// ── Bare action tags (no arguments) ────────────────────────
export const TAG_CLAIM_RED_PACKET = "[ClaimRedPacket]";
export const TAG_DECLINE_RED_PACKET = "[DeclineRedPacket]";
export const TAG_CLAIM_TRANSFER = "[ClaimTransfer]";
export const TAG_DECLINE_TRANSFER = "[DeclineTransfer]";
export const TAG_ACCEPT_PAYMENT_REQUEST = "[AcceptPaymentRequest]";
export const TAG_DECLINE_PAYMENT_REQUEST = "[DeclinePaymentRequest]";

// ── Group accept/decline forms (subject + object) ──────────
// Wording must stay inside what lib/rich-message-parser.ts accepts:
//   claimed|returned the red envelope from / accepted|claimed|declined|returned
//   the transfer from / accepted|approved|paid|covered|rejected|declined|returned
//   the payment request from.

/** [A claimed the red envelope from B] */
export function buildClaimRedPacketFromTag(claimer: string, owner: string): string {
    return `[${claimer} claimed the red envelope from ${owner}]`;
}

/** [A returned the red envelope from B] */
export function buildDeclineRedPacketFromTag(claimer: string, owner: string): string {
    return `[${claimer} returned the red envelope from ${owner}]`;
}

/** [A claimed the transfer from B] */
export function buildClaimTransferFromTag(claimer: string, owner: string): string {
    return `[${claimer} claimed the transfer from ${owner}]`;
}

/** [A returned the transfer from B] */
export function buildDeclineTransferFromTag(claimer: string, owner: string): string {
    return `[${claimer} returned the transfer from ${owner}]`;
}

/** [A accepted the payment request from B] */
export function buildAcceptPaymentRequestFromTag(claimer: string, owner: string): string {
    return `[${claimer} accepted the payment request from ${owner}]`;
}

/** [A rejected the payment request from B] */
export function buildDeclinePaymentRequestFromTag(claimer: string, owner: string): string {
    return `[${claimer} rejected the payment request from ${owner}]`;
}

// ── Parameterised tags ─────────────────────────────────────

/** [RedPacket:amount:count:label] (group, count>1) or [RedPacket:amount:label]. */
export function buildRedPacketTag(amount: number, label: string, count?: number): string {
    return count && count > 1
        ? `[RedPacket:${amount}:${count}:${label}]`
        : `[RedPacket:${amount}:${label}]`;
}

/** [Transfer:amount:label:sender:recipient] (group) or [Transfer:amount:label]. */
export function buildTransferTag(amount: number, label: string, senderName?: string, recipientName?: string): string {
    return senderName && recipientName
        ? `[Transfer:${amount}:${label}:${senderName}:${recipientName}]`
        : `[Transfer:${amount}:${label}]`;
}

/** [Gift:name:recipient] (group) or [Gift:name]. */
export function buildGiftTag(giftName: string, recipientName?: string): string {
    return recipientName ? `[Gift:${giftName}:${recipientName}]` : `[Gift:${giftName}]`;
}

/** [ContactCard:name] */
export function buildContactCardTag(name: string): string {
    return `[ContactCard:${name}]`;
}

/** [VoiceNote:text] */
export function buildVoiceNoteTag(label: string): string {
    return `[VoiceNote:${label}]`;
}

/** [Location:place] */
export function buildLocationTag(label: string): string {
    return `[Location:${label}]`;
}

/** [Sticker:name] */
export function buildStickerTag(label: string): string {
    return `[Sticker:${label}]`;
}

/** [Quote:preview] — the reply body is appended by the caller. */
export function buildQuoteTag(preview: string): string {
    return `[Quote:${preview}]`;
}

/** [Music:title-artist] or [Music:title]. */
export function buildMusicTag(title: string, artist?: string): string {
    return `[Music:${title}${artist ? `-${artist}` : ""}]`;
}

/** [MusicShare:title] */
export function buildMusicShareTag(title: string): string {
    return `[MusicShare:${title}]`;
}

/**
 * [A poked B] — group form, both names explicit.
 * Mirrors the legacy [A拍了拍B]; the parser needs both sides.
 */
export function buildPokeTag(sender: string, target: string): string {
    return `[${sender} poked ${target}]`;
}

/** [I poked X] — 1:1 form, mirrors the legacy [我拍了拍X]. */
export function buildPokeSelfTag(target: string): string {
    return `[I poked ${target}]`;
}

/**
 * [Photo:WithRef|NoRef:description] or [Photo:description].
 * `WithRef`/`NoRef` are the English spellings of 使用参考图/不使用参考图.
 */
export function buildPhotoTag(description: string, useReferenceImage?: boolean): string {
    return useReferenceImage === undefined
        ? `[Photo:${description}]`
        : `[Photo:${useReferenceImage ? "WithRef" : "NoRef"}:${description}]`;
}

// ── Paired block tags ──────────────────────────────────────

/** [StatusPanel]…[/StatusPanel] */
export function buildStatusPanelBlock(content: string): string {
    return `[StatusPanel]${content}[/StatusPanel]`;
}

/** [InnerThoughts]…[/InnerThoughts] */
export function buildInnerThoughtsBlock(content: string): string {
    return `[InnerThoughts]${content}[/InnerThoughts]`;
}
