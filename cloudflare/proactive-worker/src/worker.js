// cloudflare/proactive-worker/src/worker.js
//
// Proactive Message 2.0 — Cloudflare Worker. See PROACTIVE-MESSAGE-2.0-PLAN.md
// at the repo root for the full design. Stage 2 scope only: this Worker can
// receive a push subscription, send a manual test push, and report whether
// its Cron Trigger is actually firing. It does NOT yet read character
// snapshots or generate real proactive messages — that is Stage 3/4.
//
// Deliberately plain, dependency-free JS (no bundler, no npm deps) so the
// one-click deploy flow can upload this file to Cloudflare's Workers API
// verbatim. It only uses standard Workers runtime globals: fetch, crypto
// (WebCrypto), and the D1 binding (env.DB).
//
// Bindings expected (set by the deploy flow, or by wrangler.toml for a
// manual deploy):
//   DB               - D1 database binding (see ../schema.sql)
//   ACCESS_TOKEN     - secret; value the app must send in the X-Client-Token
//                      header to call /subscribe, /test-push, /status, etc.
//                      (a custom header, not Authorization — see the note by
//                      isAuthorized() below for why)
//   VAPID_PUBLIC_KEY - plain text; base64url, uncompressed P-256 point (65 bytes)
//   VAPID_PRIVATE_KEY- secret; base64url, raw P-256 scalar (32 bytes)
//   VAPID_SUBJECT    - plain text; a mailto: or https: contact URL for the VAPID JWT "sub" claim

// ---------- base64url <-> bytes ----------

function base64UrlToBytes(base64Url) {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}

function bytesToBase64Url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
        out.set(arr, offset);
        offset += arr.length;
    }
    return out;
}

// ---------- VAPID (RFC 8292) ----------

async function importVapidPrivateKey(vapidPublicKeyB64, vapidPrivateKeyB64) {
    const pub = base64UrlToBytes(vapidPublicKeyB64); // 0x04 || x(32) || y(32)
    const x = pub.slice(1, 33);
    const y = pub.slice(33, 65);
    const d = base64UrlToBytes(vapidPrivateKeyB64);
    const jwk = {
        kty: "EC",
        crv: "P-256",
        x: bytesToBase64Url(x),
        y: bytesToBase64Url(y),
        d: bytesToBase64Url(d),
        ext: true,
    };
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function buildVapidAuthorizationHeader(endpoint, vapidPublicKeyB64, vapidPrivateKey, subject) {
    const audience = new URL(endpoint).origin;
    const header = { typ: "JWT", alg: "ES256" };
    const payload = {
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: subject,
    };
    const encoder = new TextEncoder();
    const headerB64 = bytesToBase64Url(encoder.encode(JSON.stringify(header)));
    const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    // WebCrypto's ECDSA sign() returns the raw (r || s) signature for P-256 —
    // exactly what JWT's ES256 wants, no DER conversion needed.
    const signatureBuffer = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        vapidPrivateKey,
        encoder.encode(signingInput),
    );
    const jwt = `${signingInput}.${bytesToBase64Url(new Uint8Array(signatureBuffer))}`;
    return `vapid t=${jwt}, k=${vapidPublicKeyB64}`;
}

// ---------- Payload encryption (RFC 8291, aes128gcm content-encoding) ----------

async function hkdf(keyMaterialBytes, saltBytes, infoBytes, lengthBits) {
    const key = await crypto.subtle.importKey("raw", keyMaterialBytes, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes },
        key,
        lengthBits,
    );
    return new Uint8Array(bits);
}

async function encryptWebPushPayload(subscriptionKeys, plaintextBytes) {
    const encoder = new TextEncoder();
    const subscriberPublicKeyBytes = base64UrlToBytes(subscriptionKeys.p256dh);
    const authSecretBytes = base64UrlToBytes(subscriptionKeys.auth);

    const subscriberPublicKey = await crypto.subtle.importKey(
        "raw", subscriberPublicKeyBytes, { name: "ECDH", namedCurve: "P-256" }, false, [],
    );

    const ephemeralKeyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
    );
    const ephemeralPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeralKeyPair.publicKey));

    const sharedSecretBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: subscriberPublicKey }, ephemeralKeyPair.privateKey, 256,
    );
    const sharedSecret = new Uint8Array(sharedSecretBits);

    // ikm = HKDF-Expand(HKDF-Extract(auth_secret, ecdh_secret), key_info, 32)
    const keyInfo = concatBytes(
        encoder.encode("WebPush: info\0"),
        subscriberPublicKeyBytes,
        ephemeralPublicKeyBytes,
    );
    const ikm = await hkdf(sharedSecret, authSecretBytes, keyInfo, 256);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 128);
    const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 96);

    // Single-record aes128gcm body: plaintext || 0x02 (last-record delimiter, no extra padding needed for small payloads)
    const padded = concatBytes(plaintextBytes, new Uint8Array([0x02]));
    const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    const ciphertextBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, padded);
    const ciphertext = new Uint8Array(ciphertextBuffer);

    const recordSize = new Uint8Array(4);
    new DataView(recordSize.buffer).setUint32(0, 4096, false);
    const keyIdLength = new Uint8Array([ephemeralPublicKeyBytes.length]);

    const body = concatBytes(salt, recordSize, keyIdLength, ephemeralPublicKeyBytes, ciphertext);
    return body;
}

async function sendWebPush(subscription, payloadObject, vapidConfig) {
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(payloadObject));
    const body = await encryptWebPushPayload(subscription.keys, plaintext);
    const authorization = await buildVapidAuthorizationHeader(
        subscription.endpoint, vapidConfig.publicKey, vapidConfig.privateKey, vapidConfig.subject,
    );

    const response = await fetch(subscription.endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
            TTL: "86400",
            Authorization: authorization,
        },
        body,
    });
    return response;
}

// ---------- HTTP routes ----------

// A custom header rather than "Authorization: Bearer <token>" — deliberately
// matching the reference proactive-push Worker this feature was modeled on
// (SullyOS, github.com/qegj567-cloud/SullyOS, worker/proactive-push/src/index.ts).
// "Authorization" is one of the handful of header names the Fetch/CORS spec
// singles out for special preflight/credentials handling, and WebKit (Safari,
// and Chrome-on-iOS since it's WebKit under the hood too) has a history of
// quirks specifically around cross-origin requests that carry it — this app
// is used almost exclusively from iOS home-screen PWAs. A plain custom header
// has no such special-cased behavior in the spec.
function isAuthorized(request, env) {
    const token = request.headers.get("X-Client-Token") || "";
    return Boolean(env.ACCESS_TOKEN) && token === env.ACCESS_TOKEN;
}

// The app's own settings page calls this Worker directly from the browser
// (cross-origin: the app is on vercel.app, the Worker on workers.dev), so
// every response needs CORS headers or the browser silently blocks it
// before the app's code ever sees a status code (shows up as a generic
// "Load failed"/"Failed to fetch", not a 401/500 — hard to diagnose without
// knowing to look for this). Access-Control-Allow-Origin: * is fine here
// because the actual security boundary is the ACCESS_TOKEN check, not CORS —
// CORS only controls which origins' JS can read the response.
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "X-Client-Token, Content-Type",
    "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

async function handleSubscribe(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json_body" }, 400);
    }
    const endpoint = String(body?.endpoint || "");
    const p256dh = String(body?.keys?.p256dh || "");
    const auth = String(body?.keys?.auth || "");
    if (!endpoint || !p256dh || !auth) return json({ error: "missing_subscription_fields" }, 400);

    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT INTO subscriptions (id, endpoint, p256dh, auth, character_id, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, last_seen_at = excluded.last_seen_at`,
    ).bind(crypto.randomUUID(), endpoint, p256dh, auth, now).run();

    return json({ ok: true });
}

async function loadVapidConfig(env) {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
    const privateKey = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    return {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey,
        subject: env.VAPID_SUBJECT || "mailto:proactive-push@ai-virtual-phone.local",
    };
}

async function pushToAllSubscriptions(env, payloadObject) {
    const vapidConfig = await loadVapidConfig(env);
    if (!vapidConfig) return { sent: 0, failed: 0, errors: ["missing_vapid_config"] };

    const { results } = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM subscriptions").all();
    let sent = 0;
    const errors = [];
    for (const row of results) {
        try {
            const response = await sendWebPush(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                payloadObject,
                vapidConfig,
            );
            if (response.ok) {
                sent += 1;
            } else if (response.status === 404 || response.status === 410) {
                // Subscription is gone (expired, or the PWA was removed) — prune it.
                await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(row.id).run();
                errors.push(`expired:${row.id}`);
            } else {
                errors.push(`http_${response.status}:${row.id}`);
            }
        } catch (err) {
            errors.push(`${row.id}:${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { sent, failed: errors.length, errors };
}

// ---------- LLM calling (adapted from tools/weixin-local-assistant/assistant.mjs) ----------

function determineBaseUrl(apiConfig) {
    const explicit = String(apiConfig.baseUrl || "").trim();
    if (explicit) return explicit.replace(/\/+$/, "");
    switch (apiConfig.provider) {
        case "OpenAI": return "https://api.openai.com/v1";
        case "DeepSeek": return "https://api.deepseek.com/v1";
        case "Groq": return "https://api.groq.com/openai/v1";
        case "OpenRouter": return "https://openrouter.ai/api/v1";
        case "Moonshot": return "https://api.moonshot.cn/v1";
        case "Zhipu": return "https://open.bigmodel.cn/api/paas/v4";
        case "SiliconFlow": return "https://api.siliconflow.cn/v1";
        case "TogetherAI": return "https://api.together.xyz/v1";
        case "Anthropic": return "https://api.anthropic.com/v1";
        case "Google": return "https://generativelanguage.googleapis.com/v1beta";
        default: return "";
    }
}

function buildChatCompletionsUrl(baseUrl) {
    return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
}

function cleanReplyText(text) {
    return String(text || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
        .replace(/\(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\)\s*/g, "")
        .trim();
}

function extractOpenAiCompatibleText(data) {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const content = choice?.message?.content ?? choice?.text ?? "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
    }
    return "";
}

async function callLLM(apiConfig, messages) {
    const baseUrl = determineBaseUrl(apiConfig);
    const apiKey = String(apiConfig.apiKey || "").trim();
    const model = String(apiConfig.defaultModel || "").trim();
    if (!baseUrl || !apiKey || !model) throw new Error("missing_api_config");
    // Same scope limit as the weixin local assistant: only OpenAI-compatible
    // /chat/completions is implemented here. Anthropic/Google work if the
    // user's own API config points baseUrl at an OpenAI-compatible relay.
    if ((apiConfig.provider === "Anthropic" || apiConfig.provider === "Google") && !apiConfig.baseUrl) {
        throw new Error(`provider_not_supported_without_openai_compatible_baseurl:${apiConfig.provider}`);
    }

    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (baseUrl.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "https://ai-virtual-phone.local";
        headers["X-Title"] = "AI Virtual Phone Proactive Worker";
    }

    const response = await fetch(buildChatCompletionsUrl(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, temperature: 0.8 }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`llm_http_${response.status}:${text.slice(0, 300)}`);
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`llm_returned_non_json:${text.slice(0, 200)}`);
    }
    return cleanReplyText(extractOpenAiCompatibleText(data));
}

// ---------- Cron eligibility + firing ----------

// Must match lib/follow-up-service.ts's MAX_FOLLOW_UPS.
const MAX_FOLLOW_UPS = 10;

async function loadProactiveState(env, characterId) {
    const { results } = await env.DB.prepare(
        "SELECT mechanism, state_json FROM proactive_state WHERE character_id = ?1",
    ).bind(characterId).all();
    const state = {};
    for (const row of results) {
        try {
            state[row.mechanism] = JSON.parse(row.state_json);
        } catch {
            // ignore a corrupt row rather than failing the whole tick
        }
    }
    return state;
}

async function saveProactiveState(env, characterId, mechanism, stateObj) {
    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT INTO proactive_state (character_id, mechanism, state_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(character_id, mechanism) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).bind(characterId, mechanism, JSON.stringify(stateObj), now).run();
}

/** Calls the LLM, stores the reply for later reverse-sync, and pushes a notification. */
async function fireMechanism(env, characterId, snapshot, template) {
    const replyText = await callLLM(snapshot.apiConfig, template.messages);
    if (!replyText) return; // model chose to stay silent — nothing to deliver
    const now = new Date().toISOString();
    await env.DB.prepare(
        "INSERT INTO pending_messages (id, character_id, content, created_at, delivered) VALUES (?1, ?2, ?3, ?4, 0)",
    ).bind(crypto.randomUUID(), characterId, replyText, now).run();
    await pushToAllSubscriptions(env, {
        title: snapshot.characterName || "New message",
        body: replyText.slice(0, 180),
    });
}

/**
 * Checks one character's synced snapshot against its fire-state and fires at
 * most one mechanism per tick (deliberate — avoids bursting several
 * notifications for one character in the same cron window). Priority:
 * timed wake (explicit scheduled intent) > follow-up > period care.
 * Returns true if something fired.
 */
async function processCharacterSnapshot(env, characterId, snapshot, now) {
    const state = await loadProactiveState(env, characterId);

    for (const sched of snapshot.timedWake?.schedules || []) {
        if (sched.fireAt > now) continue;
        const firedIds = state.timed_wake?.firedIds || [];
        if (firedIds.includes(sched.id)) continue;
        await fireMechanism(env, characterId, snapshot, snapshot.timedWake.template);
        await saveProactiveState(env, characterId, "timed_wake", { firedIds: [...firedIds, sched.id].slice(-50) });
        return true;
    }

    for (const sched of snapshot.followUp?.schedules || []) {
        if (sched.fireAt > now) continue;
        if (sched.count >= MAX_FOLLOW_UPS) continue;
        if (state.follow_up?.lastFiredForFireAt === sched.fireAt) continue;
        await fireMechanism(env, characterId, snapshot, snapshot.followUp.template);
        await saveProactiveState(env, characterId, "follow_up", { lastFiredForFireAt: sched.fireAt });
        return true;
    }

    if (snapshot.periodCare?.enabled && snapshot.periodCare?.cycleKey && snapshot.periodCare?.template) {
        if (state.period_care?.lastFiredCycleKey !== snapshot.periodCare.cycleKey) {
            await fireMechanism(env, characterId, snapshot, snapshot.periodCare.template);
            await saveProactiveState(env, characterId, "period_care", { lastFiredCycleKey: snapshot.periodCare.cycleKey });
            return true;
        }
    }

    return false;
}

async function processDueProactiveMessages(env) {
    const now = Date.now();
    const { results } = await env.DB.prepare("SELECT character_id, snapshot_json FROM character_snapshots").all();
    const summary = { processed: 0, fired: 0, errors: [] };
    for (const row of results) {
        summary.processed += 1;
        try {
            let snapshot;
            try {
                snapshot = JSON.parse(row.snapshot_json);
            } catch {
                summary.errors.push(`${row.character_id}:corrupt_snapshot_json`);
                continue;
            }
            const fired = await processCharacterSnapshot(env, row.character_id, snapshot, now);
            if (fired) summary.fired += 1;
        } catch (err) {
            summary.errors.push(`${row.character_id}:${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return summary;
}

async function handleSnapshot(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json_body" }, 400);
    }
    const characterId = String(body?.characterId || "");
    if (!characterId || !body?.snapshot) return json({ error: "missing_snapshot_fields" }, 400);

    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT INTO character_snapshots (character_id, snapshot_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(character_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
    ).bind(characterId, JSON.stringify(body.snapshot), now).run();

    return json({ ok: true });
}

async function handleDeleteSnapshot(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json_body" }, 400);
    }
    const characterId = String(body?.characterId || "");
    if (!characterId) return json({ error: "missing_characterId" }, 400);

    await env.DB.batch([
        env.DB.prepare("DELETE FROM character_snapshots WHERE character_id = ?1").bind(characterId),
        env.DB.prepare("DELETE FROM proactive_state WHERE character_id = ?1").bind(characterId),
        env.DB.prepare("DELETE FROM pending_messages WHERE character_id = ?1").bind(characterId),
    ]);
    return json({ ok: true });
}

async function handlePendingMessages(env) {
    const { results } = await env.DB.prepare(
        "SELECT id, character_id, content, created_at FROM pending_messages WHERE delivered = 0 ORDER BY created_at ASC",
    ).all();
    return json({
        messages: results.map((row) => ({
            id: row.id,
            characterId: row.character_id,
            content: row.content,
            createdAt: row.created_at,
        })),
    });
}

async function handleAckPendingMessages(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json_body" }, 400);
    }
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) return json({ acked: 0 });

    // Once the client has merged a message into local chat history there is
    // no further use for the row — delete rather than flag, so the table
    // doesn't grow unbounded across every proactive message ever sent.
    const statements = ids.map((id) => env.DB.prepare("DELETE FROM pending_messages WHERE id = ?1").bind(id));
    await env.DB.batch(statements);
    return json({ acked: ids.length });
}

async function handleTestPush(env) {
    const result = await pushToAllSubscriptions(env, {
        title: "Test notification",
        body: "This came from your deployed Cloudflare Worker.",
    });
    return json(result);
}

async function writeWorkerMeta(env, key, value) {
    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT INTO worker_meta (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(key, value, now).run();
}

async function readWorkerMeta(env, key) {
    const row = await env.DB.prepare("SELECT value, updated_at FROM worker_meta WHERE key = ?1").bind(key).first();
    return row || null;
}

async function handleStatus(env) {
    const [lastCron, lastCronSummary, lastCronError] = await Promise.all([
        readWorkerMeta(env, "last_cron_run_at"),
        readWorkerMeta(env, "last_cron_summary"),
        readWorkerMeta(env, "last_cron_error"),
    ]);
    const [subscriptions, snapshots] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as count FROM subscriptions").all(),
        env.DB.prepare("SELECT COUNT(*) as count FROM character_snapshots").all(),
    ]);
    return json({
        lastCronRunAt: lastCron?.updated_at || null,
        lastCronSummary: lastCronSummary ? JSON.parse(lastCronSummary.value) : null,
        lastCronError: lastCronError?.value || null,
        subscriptionCount: subscriptions.results?.[0]?.count ?? 0,
        snapshotCount: snapshots.results?.[0]?.count ?? 0,
    });
}

async function handleRunNow(env) {
    const summary = await processDueProactiveMessages(env);
    return json(summary);
}

export default {
    async fetch(request, env) {
        // Every route handler below can throw (a D1 query against a table
        // that somehow doesn't exist, a malformed stored snapshot, etc.) and
        // none of them are individually wrapped. Without this, an uncaught
        // exception here becomes Cloudflare's own generic error response —
        // no CORS headers, not JSON, and (via app/api/proactive-relay's
        // res.json().catch(() => ({}))) arrives at the client as a bare
        // "failed (500)" with the actual reason thrown away. Catching here
        // turns that into a readable error message instead of a guess.
        try {
            const url = new URL(request.url);

            // Browsers send a CORS preflight OPTIONS request before the actual
            // POST/GET whenever the request carries a custom header (X-Client-Token
            // here) — this must succeed (with the same CORS headers) before the
            // browser will even attempt the real request.
            if (request.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: CORS_HEADERS });
            }

            // Unauthenticated liveness check — lets the app (or a person, by just
            // opening this URL) confirm the Worker itself is reachable and
            // responding, with zero token/CORS complexity in the way. Useful when
            // a token-guarded call is failing and it's unclear whether that's a
            // network problem or an auth/CORS problem.
            if (url.pathname === "/health" && request.method === "GET") {
                return json({ ok: true });
            }

            if (url.pathname === "/subscribe" && request.method === "POST") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleSubscribe(request, env);
            }
            if (url.pathname === "/snapshot" && request.method === "POST") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleSnapshot(request, env);
            }
            if (url.pathname === "/snapshot/delete" && request.method === "POST") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleDeleteSnapshot(request, env);
            }
            if (url.pathname === "/pending-messages" && request.method === "GET") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handlePendingMessages(env);
            }
            if (url.pathname === "/pending-messages/ack" && request.method === "POST") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleAckPendingMessages(request, env);
            }
            if (url.pathname === "/test-push" && request.method === "POST") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleTestPush(env);
            }
            if (url.pathname === "/status" && request.method === "GET") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleStatus(env);
            }
            if (url.pathname === "/run-now" && request.method === "POST") {
                if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
                return await handleRunNow(env);
            }
            return json({ error: "not_found" }, 404);
        } catch (err) {
            return json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
        }
    },

    async scheduled(_event, env, ctx) {
        await writeWorkerMeta(env, "last_cron_run_at", "ok");
        try {
            const summary = await processDueProactiveMessages(env);
            ctx.waitUntil(writeWorkerMeta(env, "last_cron_summary", JSON.stringify(summary)));
        } catch (err) {
            ctx.waitUntil(writeWorkerMeta(env, "last_cron_error", err instanceof Error ? err.message : String(err)));
        }
    },
};
