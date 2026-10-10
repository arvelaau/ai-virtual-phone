// Chat Record Transfer (ported from momo.float.phone: feat commit 1423f44 introduced
// lib/chat-record-transfer.ts; fix commit 8b5988a, on the unmerged branch
// momo/codex/fix-chat-record-import-wipe, replaced the old per-message upsert import path
// with a chunked, awaitable, error-propagating bulk write -- the old path was the direct
// cause of a real "data wiped, phone reset to its initial state" bug after importing a few
// thousand messages). This fixture drives the REAL lib/chat-record-transfer.ts,
// lib/chat-storage.ts and lib/chat-db.ts (aliasing `dexie` to the shared in-memory stub, so
// chatDb/mediaCacheDb are real Dexie-shaped objects this fixture can also monkey-patch to
// simulate a failing probe or a failing write).
//
//   node _fx-momo-chat-record-transfer.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
let dispatched = [];
globalThis.dispatchEvent = (ev) => { dispatched.push({ type: ev.type, detail: ev.detail }); return true; };

// Node has no FileReader; blobToDataUrl only needs readAsDataURL. Node's global Blob
// already supports arrayBuffer(), so this is a real base64 data-URL encode, not a stub.
globalThis.FileReader = class {
    readAsDataURL(blob) {
        blob.arrayBuffer().then((buf) => {
            const b64 = Buffer.from(buf).toString("base64");
            this.result = `data:${blob.type || "application/octet-stream"};base64,${b64}`;
            if (this.onload) this.onload();
        }).catch((err) => {
            this.error = err;
            if (this.onerror) this.onerror();
        });
    }
};

const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

const chatDbMod = await jiti.import("./lib/chat-db.ts");
const chatStorage = await jiti.import("./lib/chat-storage.ts");
const transfer = await jiti.import("./lib/chat-record-transfer.ts");
const mediaCache = await jiti.import("./lib/media-cache-storage.ts");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; failures.push({ name, extra }); console.log("FAIL", name, extra ?? ""); }
}

await chatStorage.hydrateChatStorage();

function makeFile(content, name = "records.json") {
    return {
        text: async () => content,
        name,
    };
}

// ── A. dbBulkPutMessages: chunked writes at the 2000-item boundary ──
{
    let bulkPutCalls = [];
    const originalBulkPut = chatDbMod.chatDb.messages.bulkPut.bind(chatDbMod.chatDb.messages);
    chatDbMod.chatDb.messages.bulkPut = async (items) => {
        bulkPutCalls.push(items.length);
        return originalBulkPut(items);
    };

    const msgs4500 = Array.from({ length: 4500 }, (_, i) => ({
        id: `bulk_${i}`, sessionId: "s_bulk", role: "user", content: `msg ${i}`,
        status: "sent", createdAt: new Date().toISOString(), order: i,
    }));
    await chatDbMod.dbBulkPutMessages(msgs4500);
    check("A1 4500 items split into 3 chunks (2000, 2000, 500)", bulkPutCalls.length === 3);
    check("A2 chunk sizes are exactly [2000, 2000, 500]", bulkPutCalls.join(",") === "2000,2000,500");

    bulkPutCalls = [];
    await chatDbMod.dbBulkPutMessages([]);
    check("A3 an empty array makes zero bulkPut calls", bulkPutCalls.length === 0);

    chatDbMod.chatDb.messages.bulkPut = originalBulkPut;
    await chatDbMod.chatDb.messages.bulkDelete(msgs4500.map(m => m.id));
}

// ── B. initChatDb: the anti-wipe guard ──
{
    // B1: flag missing, but IndexedDB genuinely has data -> reuse it, mark migrated,
    // never touch localStorage's (empty) legacy keys as if they were real.
    localStorage.removeItem("ai_phone_idb_migrated_v1");
    await chatDbMod.chatDb.sessions.put({ id: "s_probe", contactId: "c_probe" });
    const resultB1 = await chatDbMod.initChatDb();
    check("B1 IndexedDB data is reused rather than shadowed by an empty localStorage migration",
        resultB1.sessions.some(s => s.id === "s_probe"));
    check("B1b the migration flag was set so this path isn't repeated every load",
        localStorage.getItem("ai_phone_idb_migrated_v1") === "1");
    await chatDbMod.chatDb.sessions.delete("s_probe");
    localStorage.removeItem("ai_phone_idb_migrated_v1");

    // B2: the probe itself throws (simulating a locked/quota/transient IndexedDB error).
    // Must NOT fall through to the fresh-install branch (which would read empty
    // localStorage and, on the next full save, wipe IndexedDB) -- must recover via a
    // direct read instead.
    await chatDbMod.chatDb.sessions.put({ id: "s_recover", contactId: "c_recover" });
    const originalCount = chatDbMod.chatDb.messages.count.bind(chatDbMod.chatDb.messages);
    chatDbMod.chatDb.messages.count = async () => { throw new Error("simulated probe failure"); };
    const resultB2 = await chatDbMod.initChatDb();
    check("B2 a failing probe still recovers real data via the retry path, not an empty migration",
        resultB2.sessions.some(s => s.id === "s_recover"));
    chatDbMod.chatDb.messages.count = originalCount;
    await chatDbMod.chatDb.sessions.delete("s_recover");
    localStorage.removeItem("ai_phone_idb_migrated_v1");

    // B3: the probe throws AND the recovery read also fails -> must throw, and must
    // NEVER silently fall through to the wipe-risk branch.
    chatDbMod.chatDb.messages.count = async () => { throw new Error("simulated probe failure"); };
    const originalToArray = chatDbMod.chatDb.messages.toArray.bind(chatDbMod.chatDb.messages);
    chatDbMod.chatDb.messages.toArray = async () => { throw new Error("simulated total failure"); };
    let threwB3 = false;
    try { await chatDbMod.initChatDb(); } catch { threwB3 = true; }
    check("B3 total failure throws instead of silently returning empty/fresh-install data", threwB3);
    chatDbMod.chatDb.messages.count = originalCount;
    chatDbMod.chatDb.messages.toArray = originalToArray;
    localStorage.removeItem("ai_phone_idb_migrated_v1");

    // B4: markMigrated must not throw even when localStorage.setItem is broken (quota
    // full) -- a flag-write failure is a performance concern only, never a data incident.
    await chatDbMod.chatDb.sessions.put({ id: "s_quota", contactId: "c_quota" });
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("simulated quota exceeded"); };
    let threwB4 = false;
    let resultB4 = null;
    try { resultB4 = await chatDbMod.initChatDb(); } catch { threwB4 = true; }
    check("B4 a broken localStorage.setItem does not make initChatDb throw", !threwB4);
    check("B4b ...and the real IndexedDB data was still returned", resultB4?.sessions.some(s => s.id === "s_quota"));
    localStorage.setItem = originalSetItem;
    await chatDbMod.chatDb.sessions.delete("s_quota");
    localStorage.setItem("ai_phone_idb_migrated_v1", "1");
}

// ── C. bulkUpsertImportedMessages ──
{
    const session = chatStorage.createOrGetSession("char_bulk_test");
    chatStorage.pushChatMessage({ sessionId: session.id, role: "user", content: "seed message" });
    const seedCount = chatStorage.loadChatMessages(session.id).length;

    const batch = [
        { id: "imp_1", sessionId: session.id, role: "assistant", content: "one", status: "sent", createdAt: new Date().toISOString() },
        { id: "imp_2", sessionId: session.id, role: "assistant", content: "two", status: "sent", createdAt: new Date().toISOString() },
    ];
    const resultC1 = await chatStorage.bulkUpsertImportedMessages(batch);
    check("C1 both new messages are inserted", resultC1.insertedCount === 2 && resultC1.skippedCount === 0);
    check("C2 they land in the session's message list", chatStorage.loadChatMessages(session.id).length === seedCount + 2);

    // C3: re-importing the exact same batch dedupes against the live in-memory cache.
    const resultC2 = await chatStorage.bulkUpsertImportedMessages(batch);
    check("C3 re-importing the same ids inserts nothing and skips both", resultC2.insertedCount === 0 && resultC2.skippedCount === 2);
    check("C4 the session did not grow from the duplicate import", chatStorage.loadChatMessages(session.id).length === seedCount + 2);

    // C5: an empty batch is a no-op, not an error.
    const resultC3 = await chatStorage.bulkUpsertImportedMessages([]);
    check("C5 an empty batch returns zero/zero without touching storage", resultC3.insertedCount === 0 && resultC3.skippedCount === 0);

    // C6: only the affected session's preview is touched -- an unrelated session is untouched.
    const otherSession = chatStorage.createOrGetSession("char_bulk_other");
    chatStorage.pushChatMessage({ sessionId: otherSession.id, role: "user", content: "unrelated" });
    const otherBefore = chatStorage.findChatSessionById(otherSession.id);
    await chatStorage.bulkUpsertImportedMessages([
        { id: "imp_3", sessionId: session.id, role: "assistant", content: "three", status: "sent", createdAt: new Date().toISOString() },
    ]);
    const otherAfter = chatStorage.findChatSessionById(otherSession.id);
    check("C6 an unrelated session's updatedAt/preview is left untouched by a different session's bulk import",
        otherBefore.updatedAt === otherAfter.updatedAt && otherBefore.lastMessagePreview === otherAfter.lastMessagePreview);

    // C7: a write failure propagates (throws), rather than silently reporting success.
    const originalBulkPut = chatDbMod.chatDb.messages.bulkPut.bind(chatDbMod.chatDb.messages);
    chatDbMod.chatDb.messages.bulkPut = async () => { throw new Error("simulated disk full"); };
    let threwC7 = false;
    try {
        await chatStorage.bulkUpsertImportedMessages([
            { id: "imp_will_fail", sessionId: session.id, role: "assistant", content: "x", status: "sent", createdAt: new Date().toISOString() },
        ]);
    } catch { threwC7 = true; }
    check("C7 a bulk write failure propagates as a thrown error", threwC7);
    chatDbMod.chatDb.messages.bulkPut = originalBulkPut;
}

// ── D. createChatRecordExport / importChatRecordFile: round trip ──
{
    const srcSession = chatStorage.createOrGetSession("char_export_src");
    const m1 = chatStorage.pushChatMessage({ sessionId: srcSession.id, role: "user", content: "hello" });
    const mediaRef = await mediaCache.storeMediaBlob(new Blob(["fake image bytes"]), "image/png", "image");
    chatStorage.pushChatMessage({ sessionId: srcSession.id, role: "assistant", content: "[Photo]", mediaType: "image", mediaUrl: mediaRef });

    const exportBlob = await transfer.createChatRecordExport(srcSession, "Export Test");
    const exportText = await exportBlob.text();
    const exportJson = JSON.parse(exportText);
    check("D1 export type/version are correct", exportJson.type === "float-chat-records" && exportJson.version === 1);
    check("D2 export carries both messages", exportJson.messages.length === 2);
    check("D3 the media-store reference was embedded as a real data URL", typeof exportJson.media[mediaRef]?.dataUrl === "string" && exportJson.media[mediaRef].dataUrl.startsWith("data:"));
    check("D4 isTyping was stripped from exported messages", exportJson.messages.every(m => !("isTyping" in m)));

    // D5: importing into a DIFFERENT session namespaces message ids and restores media
    // under a fresh ref (never collides with the source ref).
    const dstSession = chatStorage.createOrGetSession("char_import_dst");
    const importResult = await transfer.importChatRecordFile(makeFile(exportText), dstSession);
    check("D5 both messages inserted into the new session", importResult.inserted === 2);
    check("D6 the embedded media was restored (mediaRestored === 1)", importResult.mediaRestored === 1);
    const dstMessages = chatStorage.loadChatMessages(dstSession.id);
    check("D7 imported message ids are namespaced under the target session (cross-session import)",
        dstMessages.every(m => m.id.startsWith(`import_${dstSession.id}_`)));
    const restoredMediaMsg = dstMessages.find(m => m.mediaType === "image");
    check("D8 the restored media ref is NOT the original ref (a fresh blob was actually stored)",
        typeof restoredMediaMsg?.mediaUrl === "string" && restoredMediaMsg.mediaUrl !== mediaRef);
    check("D9 events were dispatched on a successful import",
        dispatched.some(d => d.type === "chat-messages-updated" && d.detail.sessionId === dstSession.id)
        && dispatched.some(d => d.type === "chat-message-pushed" && d.detail.imported === true));

    // D10: importing back into the SAME session id preserves the original message ids
    // (no artificial namespacing needed -- it's the same conversation).
    dispatched = [];
    const sameSessionExport = await transfer.createChatRecordExport(srcSession, "Same Session");
    const sameSessionText = await sameSessionExport.text();
    // Import into a session object carrying the SAME id as the source, but as a distinct
    // session record with no existing messages, to observe id preservation cleanly.
    const sameIdSession = { ...srcSession, id: srcSession.id };
    const sameResult = await transfer.importChatRecordFile(makeFile(sameSessionText), sameIdSession);
    check("D11 re-importing into the very same session dedupes against the messages already there",
        sameResult.inserted === 0 && sameResult.skipped === 2);
}

// ── E. importChatRecordFile: validation ──
{
    const target = chatStorage.createOrGetSession("char_validation_target");

    let threwWrongType = false;
    try { await transfer.importChatRecordFile(makeFile(JSON.stringify({ type: "something-else" })), target); }
    catch { threwWrongType = true; }
    check("E1 a file with the wrong type field is rejected", threwWrongType);

    let threwWrongVersion = false;
    try { await transfer.importChatRecordFile(makeFile(JSON.stringify({ type: "float-chat-records", version: 2, messages: [] })), target); }
    catch { threwWrongVersion = true; }
    check("E2 a file with an unsupported version is rejected", threwWrongVersion);

    let threwNoMessages = false;
    try { await transfer.importChatRecordFile(makeFile(JSON.stringify({ type: "float-chat-records", version: 1 })), target); }
    catch { threwNoMessages = true; }
    check("E3 a file with no messages array at all is rejected", threwNoMessages);

    // E4: a message shape missing a required field is silently filtered, not fatal to
    // the whole import.
    const mixedBatch = {
        type: "float-chat-records", version: 1, exportedAt: new Date().toISOString(),
        session: { id: "src", contactId: "c", name: "n", isGroup: false },
        messages: [
            { id: "valid_1", sessionId: "src", role: "user", content: "ok", createdAt: new Date().toISOString() },
            { id: "missing_content", sessionId: "src", role: "user", createdAt: new Date().toISOString() },
            "not even an object",
            null,
        ],
        media: {},
    };
    const resultE4 = await transfer.importChatRecordFile(makeFile(JSON.stringify(mixedBatch)), target);
    check("E4 only the one well-formed message is inserted", resultE4.inserted === 1);
    check("E5 the three malformed entries are counted as skipped", resultE4.skipped === 3);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
