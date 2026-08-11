// Fixture for lib/gift-provenance.ts (Stage 1 of Couple Space).
//
// Runs the REAL gift-provenance, chat-storage, character-storage and kv-db by aliasing
// `dexie` to an in-memory stub — so this exercises the actual code paths, not copies of
// their logic.
//
//   node _fx-gift-provenance.mjs
//
// Non-vacuity: see the note at the bottom of this file.

import path from "node:path";
import { createJiti } from "jiti";

// ── Browser globals, installed before any module is imported ──
globalThis.window = globalThis;
globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const GP = await jiti.import("./lib/gift-provenance.ts");
const chat = await jiti.import("./lib/chat-storage.ts");
const chars = await jiti.import("./lib/character-storage.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

// ───────────────────────── A. buildGiftProvenanceRecord (pure) ─────────────────────────
const names = new Map([["char_luna", "Luna"], ["char_rae", "Rae"]]);
const soloSession = { id: "sess_1", contactId: "char_luna", isGroup: false };
const groupSession = { id: "sess_g", contactId: "", isGroup: true };

const userGift = {
    id: "m1", sessionId: "sess_1", role: "user", content: "", status: "sent",
    createdAt: "2026-05-01T10:00:00.000Z", mediaType: "gift",
    mediaData: {
        giftName: "Blue Ceramic Mug", shoppingGiftId: "ord_7::item_2::1",
        giftOrderId: "ord_7", giftItemId: "item_2", giftMerchantLabel: "Slow Morning Goods",
        giftPriceLabel: "$24.00", giftDeliveredAt: "2026-04-28T09:00:00.000Z",
        giftSentAt: "2026-05-01T10:00:00.000Z", senderName: "Zara",
    },
};
const r1 = GP.buildGiftProvenanceRecord(userGift, soloSession, names);
eq("A1 direction is user_to_character", r1?.direction, "user_to_character");
eq("A2 id is the shoppingGiftId", r1?.id, "ord_7::item_2::1");
eq("A3 1:1 counterpart falls back to session.contactId", r1?.counterpartId, "char_luna");
eq("A4 counterpart name resolved from lookup", r1?.counterpartName, "Luna");
// The regression guard for the bug found while writing this module: a blanket whitespace
// strip is invisible in Chinese and destroys English product names.
eq("A5 product name keeps its spaces", r1?.productName, "Blue Ceramic Mug");
eq("A6 order id mapped", r1?.orderId, "ord_7");
eq("A7 price mapped", r1?.priceLabel, "$24.00");
eq("A8 deliveredAt mapped", r1?.deliveredAt, "2026-04-28T09:00:00.000Z");
eq("A9 isGroup false for 1:1", r1?.isGroup, false);

const groupGift = {
    ...userGift, id: "m2", sessionId: "sess_g",
    mediaData: { ...userGift.mediaData, shoppingGiftId: "ord_8::item_1::1", recipientId: "char_rae", recipientName: "Rae" },
};
const r2 = GP.buildGiftProvenanceRecord(groupGift, groupSession, names);
eq("A10 group counterpart from mediaData.recipientId", r2?.counterpartId, "char_rae");
eq("A11 group counterpart name", r2?.counterpartName, "Rae");
eq("A12 isGroup true", r2?.isGroup, true);

const aiGift = {
    id: "m3", sessionId: "sess_1", role: "assistant", content: "", status: "sent",
    createdAt: "2026-05-02T12:00:00.000Z", mediaType: "gift",
    mediaData: { giftName: "Pressed Flower Card" },
};
const r3 = GP.buildGiftProvenanceRecord(aiGift, soloSession, names);
eq("A13 assistant gift is character_to_user", r3?.direction, "character_to_user");
eq("A14 AI gift id falls back to msg:<id>", r3?.id, "msg:m3");
eq("A15 AI gift has no shoppingGiftId", r3?.shoppingGiftId, undefined);
eq("A16 AI gift has no orderId", r3?.orderId, undefined);
eq("A17 sentAt falls back to createdAt", r3?.sentAt, "2026-05-02T12:00:00.000Z");
eq("A18 AI gift counterpart is the contact", r3?.counterpartId, "char_luna");

check("A19 non-gift message yields null",
    GP.buildGiftProvenanceRecord({ ...userGift, mediaType: "transfer" }, soloSession, names) === null);
check("A20 system-role gift yields null",
    GP.buildGiftProvenanceRecord({ ...userGift, role: "system" }, soloSession, names) === null);
check("A21 tool-role gift yields null",
    GP.buildGiftProvenanceRecord({ ...userGift, role: "tool" }, soloSession, names) === null);

// ───────────────────────── B. index behaviour, driving real storage ─────────────────────
chars.saveCharacters([
    { id: "char_luna", name: "Luna" },
    { id: "char_rae", name: "Rae" },
]);
chat.saveChatSessions([
    { id: "sess_1", contactId: "char_luna", unreadCount: 0, updatedAt: "2026-05-01T10:00:00.000Z", isPinned: false },
    { id: "sess_2", contactId: "char_rae", unreadCount: 0, updatedAt: "2026-05-03T10:00:00.000Z", isPinned: false },
]);
for (const msg of [
    userGift,
    { ...aiGift },
    {
        id: "m4", sessionId: "sess_2", role: "user", content: "", status: "sent",
        createdAt: "2026-05-03T09:00:00.000Z", mediaType: "gift",
        mediaData: { giftName: "Linen Scarf", shoppingGiftId: "ord_9::item_1::1", giftSentAt: "2026-05-03T09:00:00.000Z" },
    },
    { id: "m5", sessionId: "sess_1", role: "user", content: "just a note", status: "sent", createdAt: "2026-05-01T11:00:00.000Z" },
]) chat.upsertImportedChatMessage(msg);

GP.clearGiftProvenanceIndex();
const sync1 = GP.syncGiftProvenanceFromMessages();
eq("B1 sync found 3 gift bubbles", sync1.giftsFound, 3);
eq("B2 sync added 3 records", sync1.added, 3);
check("B3 sync scanned the non-gift message too", sync1.scannedMessages >= 4, sync1);

const all = GP.loadGiftHistory();
eq("B4 history holds 3 records", all.length, 3);
eq("B5 history is newest first", all[0]?.id, "ord_9::item_1::1");
eq("B6 oldest last", all[all.length - 1]?.id, "ord_7::item_2::1");

eq("B7 filter by characterId (Luna)", GP.loadGiftHistory({ characterId: "char_luna" }).length, 2);
eq("B8 filter by characterId (Rae)", GP.loadGiftHistory({ characterId: "char_rae" }).length, 1);
eq("B9 filter by direction", GP.loadGiftHistory({ direction: "character_to_user" }).length, 1);
eq("B10 limit honoured", GP.loadGiftHistory({ limit: 2 }).length, 2);

const counts = GP.countGiftsExchanged("char_luna");
eq("B11 given count", counts.given, 1);
eq("B12 received count", counts.received, 1);

const byId = GP.loadGiftProvenance("ord_7::item_2::1");
eq("B13 lookup by id", byId?.productName, "Blue Ceramic Mug");
check("B14 unknown id yields null", GP.loadGiftProvenance("nope") === null);

// Idempotent: re-syncing must not duplicate.
const sync2 = GP.syncGiftProvenanceFromMessages();
eq("B15 re-sync adds nothing", sync2.added, 0);
eq("B16 re-sync updates the same 3", sync2.updated, 3);
eq("B17 history still 3 after re-sync", GP.loadGiftHistory().length, 3);

// THE product guarantee: a gift given stays given even after the chat is deleted.
chat.deleteChatMessage("m4");
const sync3 = GP.syncGiftProvenanceFromMessages();
eq("B18 deleted message no longer scanned", sync3.giftsFound, 2);
eq("B19 but its record survives (append-only)", GP.loadGiftHistory().length, 3);
check("B20 the surviving record is still queryable",
    GP.loadGiftProvenance("ord_9::item_1::1")?.productName === "Linen Scarf");

// ───────────────────────── C. the scan we deliberately did NOT replace ──────────────────
const giftUtils = await jiti.import("./lib/shopping-gift-utils.ts");
const sentIds = giftUtils.loadSentShoppingGiftIds();
check("C1 loadSentShoppingGiftIds still scans messages (unchanged behaviour)",
    sentIds instanceof Set && sentIds.has("ord_7::item_2::1"), [...sentIds]);
check("C2 it does NOT report the deleted message's gift as sent",
    !sentIds.has("ord_9::item_1::1"), [...sentIds]);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: restore the whitespace strip in cleanText (lib/gift-provenance.ts) and A5\n" +
    "fails with \"BlueCeramicMug\"; make syncGiftProvenanceFromMessages rebuild from scratch\n" +
    "instead of merging and B19 fails (2 instead of 3).",
);
process.exit(fail ? 1 : 0);
