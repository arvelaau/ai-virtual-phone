// Fixture for the "deleted friend comes back" bug (lib/chat-storage.ts).
//
// Removing a friend is "drop the contact, keep the session", so that adding them back
// picks the history up again. But restoreContactsForPrivateSessions is a data-rescue path:
// it sees "a session with messages but no contact", concludes the contact table was lost,
// and rebuilds the contact from the session -- resurrecting the friend the user just
// removed, in the chat list, the contacts page and Moments at once.
//
// It only fires when contacts are at most half the private sessions with messages, which
// is why it was invisible with many friends and reproduced every time with one or two.
//
// Runs the REAL chat-storage, character-storage and kv-db by aliasing `dexie` to the
// in-memory stub, so this exercises the actual rescue path rather than a copy of it.
//
//   node _fx-contact-tombstone.mjs

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

const root = process.cwd();
const jiti = createJiti(root, {
    interopDefault: true,
    alias: { "@": root, dexie: path.join(root, "_fx-dexie-stub.mjs") },
});

const chat = await jiti.import("./lib/chat-storage.ts");
const chars = await jiti.import("./lib/character-storage.ts");
const fr = await jiti.import("./lib/friend-request-storage.ts");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};
const eq = (label, actual, expected) =>
    check(`${label} (expected ${JSON.stringify(expected)})`, actual === expected, actual);

const has = (id) => chat.loadChatContacts().some(c => c.characterId === id);

// saveChatContacts falls back to an ADDITIVE write before hydration, which would make the
// "contact table was wiped" setup in group F silently do nothing.
await chat.hydrateChatStorage();

// ── world setup: two characters, each with a private session carrying a message ──
// Two is deliberate: the rescue only fires when contacts <= half the sessions with
// messages, so with two sessions removing ONE friend leaves 1 contact vs 2 sessions,
// which is exactly the ratio that trips it.
chars.saveCharacters([
    { id: "char_luna", name: "Luna" },
    { id: "char_rae", name: "Rae" },
]);
chat.saveChatSessions([
    { id: "sess_luna", contactId: "char_luna", unreadCount: 0, updatedAt: "2026-05-01T10:00:00.000Z", isPinned: false },
    { id: "sess_rae", contactId: "char_rae", unreadCount: 0, updatedAt: "2026-05-02T10:00:00.000Z", isPinned: false },
]);
// Contacts BEFORE messages, deliberately: addChatContact calls loadChatContacts, which
// runs the rescue. Adding messages first makes the rescue fire during setup and mint a
// contact_recovered_* entry for whichever character has no contact yet -- which would put
// the bug's own fingerprint in the fixture's baseline.
for (const id of ["char_luna", "char_rae"]) chat.addChatContact(id);
for (const [i, id] of ["char_luna", "char_rae"].entries()) {
    chat.upsertImportedChatMessage({
        id: `m_${i}`, sessionId: `sess_${id.replace("char_", "")}`, role: "assistant",
        content: `hi from ${id}`, status: "sent", createdAt: "2026-05-01T10:00:00.000Z",
    });
}

eq("A1 both friends start present", chat.loadChatContacts().length, 2);

// ── B. THE BUG ──
chat.removeChatContact("char_luna");
check("B1 the removed friend is gone from contacts", !has("char_luna"), chat.loadChatContacts());
check("B2 ...and stays gone across reloads (the rescue does not resurrect them)",
    !has("char_luna") && !has("char_luna") && !has("char_luna"), chat.loadChatContacts());
check("B3 the other friend is untouched", has("char_rae"));
// The session must SURVIVE -- that is the whole design, so re-adding restores history.
check("B4 the private session is kept, not deleted",
    chat.loadChatSessions().some(s => !s.isGroup && s.contactId === "char_luna"),
    chat.loadChatSessions().map(s => s.contactId));
check("B5 no contact_recovered_* entry was written",
    !chat.loadChatContacts().some(c => String(c.id).startsWith("contact_recovered_")),
    chat.loadChatContacts().map(c => c.id));
check("B6 the removal is recorded as deliberate", chat.isContactRemovedByUser("char_luna"));

// ── C. the second symptom: the AI's later friend request used to be wiped ──
// getPendingFriendRequests treats a request from someone who IS a contact as stale and
// DELETES it from storage. With the friend resurrected, the AI's post-removal request was
// erased before the user ever saw it in "New friends".
fr.clearRequestsForCharacter("char_luna");
const req1 = fr.addFriendRequest("char_luna", "can we talk?", 1);
const pending = fr.getPendingFriendRequests();
check("C1 a request from a removed friend survives and is shown",
    pending.some(r => r.characterId === "char_luna"), pending);
check("C2 ...and is still in storage afterwards",
    fr.loadFriendRequests().some(r => r.id === req1.id), fr.loadFriendRequests());

// ── D. adding back clears the tombstone, via every path ──
chat.addChatContact("char_luna");
check("D1 re-added friend is present again", has("char_luna"));
check("D2 the tombstone is cleared", !chat.isContactRemovedByUser("char_luna"));
check("D3 history is still there after re-adding",
    chat.loadChatMessages("sess_luna").length > 0, chat.loadChatMessages("sess_luna").length);
// Now that they are a contact again, the pending request IS genuinely stale.
fr.clearRequestsForCharacter("char_luna");
fr.addFriendRequest("char_luna", "hi again", 2);
check("D4 once re-added, a pending request is correctly treated as stale",
    !fr.getPendingFriendRequests().some(r => r.characterId === "char_luna"),
    fr.getPendingFriendRequests());

// ── E. remove/re-add cycles do not accumulate or leak ──
for (let i = 0; i < 3; i++) {
    chat.removeChatContact("char_luna");
    check(`E${i + 1}a cycle ${i + 1}: removed`, !has("char_luna"));
    chat.addChatContact("char_luna");
    check(`E${i + 1}b cycle ${i + 1}: restored`, has("char_luna"));
}
check("E4 no tombstone left after the final re-add", !chat.isContactRemovedByUser("char_luna"));
check("E5 no duplicate contacts accumulated",
    chat.loadChatContacts().filter(c => c.characterId === "char_luna").length === 1,
    chat.loadChatContacts());

// ── F. the rescue still rescues -- this must not become a blanket disable ──
// Simulate the real disaster it exists for: the contact table is wiped without any
// deliberate removal. Every contact must come back.
chat.saveChatContacts([]);
const rescued = chat.loadChatContacts();
check("F1 a genuinely lost contact table is still rebuilt from sessions",
    rescued.length === 2, rescued.map(c => c.characterId));
check("F2 rescued entries are marked as recovered",
    rescued.every(c => String(c.id).startsWith("contact_recovered_")), rescued.map(c => c.id));

// ...but a deliberate removal must still be respected during that same rescue.
chat.removeChatContact("char_rae");
chat.saveChatContacts(chat.loadChatContacts().filter(c => c.characterId !== "char_luna"));
const mixed = chat.loadChatContacts();
check("F3 rescue restores the accidentally-missing one",
    mixed.some(c => c.characterId === "char_luna"), mixed.map(c => c.characterId));
check("F4 ...while still skipping the deliberately removed one",
    !mixed.some(c => c.characterId === "char_rae"), mixed.map(c => c.characterId));

console.log(`\n${pass}/${pass + fail} passed`);
console.log(
    "\nNon-vacuity, measured -- three controls, and note they fail in DIFFERENT directions:\n" +
    "  drop `&& !removedByUser.has(...)` from the rescue -> 16/25: B1 B2 B5 C1 C2,\n" +
    "    E1a E2a E3a, F4. B5's output shows the contact_recovered_* id that is the\n" +
    "    original bug's fingerprint, and C1/C2 show the AI's friend request being erased.\n" +
    "  remove markContactRemoved from removeChatContact -> 15/25: the same set plus B6.\n" +
    "  remove unmarkContactRemoved from addChatContact -> 21/25: D2 E4 F1 F3 instead.\n" +
    "    That is the OPPOSITE failure -- anyone ever removed stays tombstoned forever, so\n" +
    "    the rescue can never help them again even after a genuine data loss. F1/F3 exist\n" +
    "    to catch exactly that over-correction.",
);
process.exit(fail ? 1 : 0);
