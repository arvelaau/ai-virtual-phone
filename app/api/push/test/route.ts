// app/api/push/test/route.ts
// Sends one real Web Push notification to a single subscription. Used by the
// Proactive Push settings page's "Send test notification" button to prove
// the whole delivery path (VAPID -> encrypted push -> service worker ->
// OS notification) works before any Cloudflare Worker exists — see
// PROACTIVE-MESSAGE-2.0-PLAN.md, Stage 1.
//
// Stateless: the VAPID keys and the subscription are supplied by the caller
// on every request (both already live in the browser's local storage), not
// persisted here.

import { NextResponse } from "next/server";
import webpush from "web-push";
import type { PushSubscription as WebPushSubscription } from "web-push";

export const runtime = "nodejs";

type TestPushBody = {
    subscription?: unknown;
    vapidPublicKey?: string;
    vapidPrivateKey?: string;
    vapidSubject?: string;
    title?: string;
    body?: string;
};

function isValidSubscription(value: unknown): value is WebPushSubscription {
    if (!value || typeof value !== "object") return false;
    const sub = value as Record<string, unknown>;
    if (typeof sub.endpoint !== "string" || !sub.endpoint) return false;
    const keys = sub.keys as Record<string, unknown> | undefined;
    return Boolean(keys && typeof keys.p256dh === "string" && typeof keys.auth === "string");
}

export async function POST(request: Request) {
    let payload: TestPushBody;
    try {
        payload = await request.json();
    } catch {
        return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
    }

    if (!isValidSubscription(payload.subscription)) {
        return NextResponse.json({ error: "missing_or_invalid_subscription" }, { status: 400 });
    }
    const publicKey = String(payload.vapidPublicKey || "").trim();
    const privateKey = String(payload.vapidPrivateKey || "").trim();
    if (!publicKey || !privateKey) {
        return NextResponse.json({ error: "missing_vapid_keys" }, { status: 400 });
    }
    const subject = String(payload.vapidSubject || "").trim() || "mailto:proactive-push@ai-virtual-phone.local";

    const notificationPayload = JSON.stringify({
        title: String(payload.title || "Test notification").slice(0, 200),
        body: String(payload.body || "If you can see this, push delivery works.").slice(0, 500),
    });

    try {
        await webpush.sendNotification(payload.subscription, notificationPayload, {
            vapidDetails: { subject, publicKey, privateKey },
        });
        return NextResponse.json({ ok: true });
    } catch (err) {
        const statusCode = err && typeof err === "object" && "statusCode" in err
            ? Number((err as { statusCode?: unknown }).statusCode)
            : undefined;
        // web-push's own error message for anything it doesn't specifically
        // recognize is the unhelpfully generic "Received unexpected response
        // code" — the actually useful part (the push service's real HTTP
        // status, and its response body when present) was being thrown away
        // here. Both are on the WebPushError instance; surface them.
        const body = err && typeof err === "object" && "body" in err
            ? String((err as { body?: unknown }).body || "").slice(0, 300)
            : "";
        const baseMessage = err instanceof Error ? err.message : "push_send_failed";
        const detail = [
            statusCode !== undefined && Number.isFinite(statusCode) ? `status ${statusCode}` : null,
            body || null,
        ].filter(Boolean).join(", ");
        // A 404/410 from the push service means the subscription is gone
        // (expired, or the user removed the PWA) — the caller should clear
        // its stored subscription and ask the user to re-enable push.
        return NextResponse.json(
            {
                error: detail ? `${baseMessage} (${detail})` : baseMessage,
                expired: statusCode === 404 || statusCode === 410,
            },
            { status: 502 },
        );
    }
}
