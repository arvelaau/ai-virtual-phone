// Paste this whole file into the browser DevTools console, on the running app.
//
// The chat bubble look can come from FOUR places. Three of them live in your browser's
// IndexedDB, not in the repo, so reverting files does nothing to them:
//
//   1. globalCustomCSS      theme profile        (applies everywhere)
//   2. cssOverrides         theme profile        (individual colour variables)
//   3. chat-app-custom-css  kv key               (the whole chat app)
//   4. session.customCSS    per chat session     (one conversation only)
//
// This only READS. Nothing is changed. It prints what is set and how to clear each one.

(async () => {
    const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    const getAll = (db, store) => new Promise((res, rej) => {
        if (!db.objectStoreNames.contains(store)) return res([]);
        const r = db.transaction(store, "readonly").objectStore(store).getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    const show = (label, css, howToClear) => {
        const text = (css || "").trim();
        if (!text) { console.log(`%c[ ] ${label}: kosong`, "color:#888"); return false; }
        console.log(`%c[X] ${label}: ${text.length} karakter`, "color:#e66;font-weight:bold");
        console.log(text.length > 1200 ? text.slice(0, 1200) + "\n… (dipotong)" : text);
        console.log(`%c    cara hapus: ${howToClear}`, "color:#888");
        return true;
    };

    let found = 0;
    console.log("%c=== CSS chat yang tersimpan di browser ===", "font-size:14px;font-weight:bold");

    // 1 + 2 + 3 — the kv store
    const kv = await open("AiPhoneKvDB");
    const rows = await getAll(kv, "entries");
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    const themeRaw = byKey.get("ai_phone_theme_profile_v1");
    if (themeRaw) {
        let profile = {};
        try { profile = JSON.parse(themeRaw); } catch { /* ignore */ }
        if (show("globalCustomCSS", profile.globalCustomCSS, "Settings -> Theme -> Custom CSS -> kosongkan lalu simpan")) found++;
        const overrides = profile.cssOverrides || {};
        const bubbleKeys = Object.keys(overrides).filter((k) => /bubble|chat/i.test(k));
        if (bubbleKeys.length) {
            found++;
            console.log("%c[X] cssOverrides menyentuh bubble/chat:", "color:#e66;font-weight:bold");
            for (const k of bubbleKeys) console.log(`      ${k}: ${overrides[k]}`);
            console.log("%c    cara hapus: Settings -> Theme -> reset warna yang bersangkutan", "color:#888");
        } else {
            console.log("%c[ ] cssOverrides: tidak ada yang menyentuh bubble/chat", "color:#888");
        }
    } else {
        console.log("%c[ ] belum ada theme profile tersimpan", "color:#888");
    }

    if (show("chat-app-custom-css", byKey.get("chat-app-custom-css"),
        "buka profil user di dalam app chat -> editor CSS -> Clear")) found++;

    // 4 — per-session
    const chat = await open("AiPhoneChatDB");
    const sessions = await getAll(chat, "sessions");
    const withCss = sessions.filter((s) => (s.customCSS || "").trim());
    if (withCss.length) {
        found += withCss.length;
        console.log(`%c[X] ${withCss.length} sesi chat punya CSS sendiri:`, "color:#e66;font-weight:bold");
        for (const s of withCss) {
            console.log(`      sesi ${s.id} (contactId ${s.contactId}) — ${s.customCSS.trim().length} karakter`);
            console.log(s.customCSS.trim().slice(0, 600));
        }
        console.log("%c    cara hapus: buka chat itu -> panel setelan -> CSS -> kosongkan", "color:#888");
    } else {
        console.log("%c[ ] tidak ada sesi chat yang punya CSS sendiri", "color:#888");
    }

    console.log(found
        ? `%c=> ${found} sumber CSS tersimpan ditemukan. Itu yang menimpa file repo.`
        : "%c=> Tidak ada CSS tersimpan. Tampilan yang kamu lihat berarti memang bawaan upstream; coba hard-reload (Ctrl+Shift+R) untuk memastikan bukan cache service worker.",
        "font-weight:bold");
})();
