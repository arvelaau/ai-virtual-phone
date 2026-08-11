// Fixture for gift resell + provenance-aware character reaction.
//
// The load-bearing assertions: only a gift the character GAVE can be resold, the wallet is
// actually credited, the provenance record keeps its fate across a re-scan, and the event
// the character reads names the specific gift and who gave it.
//
//   node _fx-gift-resell.mjs

import path from "node:path";
import { createJiti } from "jiti";

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
if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init?.detail; }
    };
}

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const GP = await jiti.import("./lib/gift-provenance.ts");
const R = await jiti.import("./lib/gift-resell.ts");
const M = await jiti.import("./lib/couple-space-memory.ts");
const W = await jiti.import("./lib/wallet-storage.ts");
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

// ── A. price parsing / valuation ──
eq("A1 plain dollar label", R.parsePriceLabel("$24.00"), 24);
eq("A2 label with currency word", R.parsePriceLabel("USD 40"), 40);
eq("A3 thousands separator", R.parsePriceLabel("$1,200.50"), 1200.5);
eq("A4 no number yields null", R.parsePriceLabel("free"), null);
eq("A5 undefined yields null", R.parsePriceLabel(undefined), null);
eq("A6 resale applies the rate", R.estimateResaleValue("$24.00"), 24 * R.GIFT_RESALE_RATE);
eq("A7 unparseable price has no estimate", R.estimateResaleValue("priceless"), null);

// ── B. only a received gift can be resold ──
const CHAR = "char_luna";
chars.saveCharacters([{ id: CHAR, name: "Luna" }]);
chat.saveChatSessions([
    { id: "sess_1", contactId: CHAR, unreadCount: 0, updatedAt: "2026-05-01T10:00:00.000Z", isPinned: false },
]);
// m1: the character gave the user a gift. m2: the user gave the character one.
chat.upsertImportedChatMessage({
    id: "m1", sessionId: "sess_1", role: "assistant", content: "", status: "sent",
    createdAt: "2026-05-01T10:00:00.000Z", mediaType: "gift",
    mediaData: { giftName: "Blue Ceramic Mug", giftPriceLabel: "$24.00" },
});
chat.upsertImportedChatMessage({
    id: "m2", sessionId: "sess_1", role: "user", content: "", status: "sent",
    createdAt: "2026-05-02T10:00:00.000Z", mediaType: "gift",
    mediaData: { giftName: "Linen Scarf", shoppingGiftId: "ord_9::i1::1", giftPriceLabel: "$40.00" },
});
GP.clearGiftProvenanceIndex();
GP.syncGiftProvenanceFromMessages();

const received = GP.loadGiftProvenance("msg:m1");
const sent = GP.loadGiftProvenance("ord_9::i1::1");
check("B1 received gift is resellable", R.canResellGift(received), received);
check("B2 a gift the user SENT is not resellable", !R.canResellGift(sent), sent);
check("B3 null record is not resellable", !R.canResellGift(null));

const refuse = R.resellGift({ characterId: CHAR, giftId: sent.id, characterName: "Luna" });
check("B4 reselling a sent gift is refused", refuse.ok === false, refuse);
check("B5 the refusal explains why", String(refuse.error ?? "").includes("were given"), refuse.error);

// ── C. the resell itself ──
M.clearAllCoupleSpaceProjections();
const balanceBefore = W.getWalletBalance(W.loadWalletState());
const result = R.resellGift({ characterId: CHAR, giftId: "msg:m1", characterName: "Luna" });

check("C1 resell succeeds", result.ok === true, result);
eq("C2 amount is half the original", result.amount, 12);
const balanceAfter = W.getWalletBalance(W.loadWalletState());
eq("C3 the wallet was actually credited", Math.round((balanceAfter - balanceBefore) * 100) / 100, 12);

const marked = GP.loadGiftProvenance("msg:m1");
check("C4 the record is marked resold", Boolean(marked?.resoldAt), marked);
eq("C5 the resale amount is stored", marked?.resaleAmount, 12);
check("C6 it is no longer resellable", !R.canResellGift(marked), marked);

const again = R.resellGift({ characterId: CHAR, giftId: "msg:m1", characterName: "Luna" });
check("C7 reselling twice is refused", again.ok === false, again);
eq("C8 the wallet is not credited twice",
    Math.round((W.getWalletBalance(W.loadWalletState()) - balanceBefore) * 100) / 100, 12);

const explicit = GP.loadGiftProvenance("ord_9::i1::1");
check("C9 an unknown gift id is refused",
    R.resellGift({ characterId: CHAR, giftId: "nope", characterName: "Luna" }).ok === false, explicit);

// ── D. what the character reads ──
const events = M.loadCoupleSpaceProjectionEntries(CHAR);
const resoldEvent = events.find(e => e.id === "couple_space_gift_resold_msg:m1");
check("D1 an event was written", Boolean(resoldEvent), events.map(e => e.id));
check("D2 it names the specific gift", resoldEvent?.content.includes("Blue Ceramic Mug"), resoldEvent?.content);
// Provenance-aware: the character is told it was THEIR gift, not just that something sold.
check("D3 it names who gave it", resoldEvent?.content.includes("Luna gave them"), resoldEvent?.content);
check("D4 it carries the Couple Space head", resoldEvent?.content.startsWith("[Couple Space "), resoldEvent?.content);
check("D5 it states the amount", resoldEvent?.content.includes("12"), resoldEvent?.content);

// ── E. the fate survives a re-scan ──
// The preservation works because buildGiftProvenanceRecord OMITS these keys entirely, so
// the {...existing, ...incoming} spread cannot clobber them. Asserting the omission is what
// actually discriminates -- removing the explicit carry-over in mergeRecord changes nothing
// today, so a control against that line alone is vacuous.
const rebuilt = GP.buildGiftProvenanceRecord(
    { id: "m1", sessionId: "sess_1", role: "assistant", content: "", status: "sent",
      createdAt: "2026-05-01T10:00:00.000Z", mediaType: "gift", mediaData: { giftName: "Blue Ceramic Mug" } },
    { id: "sess_1", contactId: CHAR, isGroup: false },
);
check("E0a the builder omits resoldAt rather than setting it undefined", !("resoldAt" in rebuilt), Object.keys(rebuilt));
check("E0b the builder omits resaleAmount too", !("resaleAmount" in rebuilt), Object.keys(rebuilt));

// A rescan rebuilds each row from its chat message, which knows nothing about the resale.
GP.syncGiftProvenanceFromMessages();
const afterRescan = GP.loadGiftProvenance("msg:m1");
check("E1 resoldAt survives a re-scan", Boolean(afterRescan?.resoldAt), afterRescan);
eq("E2 resaleAmount survives a re-scan", afterRescan?.resaleAmount, 12);
check("E3 still not resellable after a re-scan", !R.canResellGift(afterRescan), afterRescan);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity: remove the direction check in resellGift and B4/B5 fail; make\n" +
    "buildGiftProvenanceRecord emit `resoldAt: undefined` and E0a/E1 fail.\n" +
    "NOTE: dropping the explicit carry-over in mergeRecord alone changes NOTHING -- the key\n" +
    "omission is the real mechanism, which is exactly why E0a/E0b exist.",
);
process.exit(fail ? 1 : 0);
