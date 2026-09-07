// app/api/push/vapid/route.ts
// Generates a new VAPID keypair for Web Push. Pure keygen utility — nothing
// is persisted server-side; the caller (the app running in the browser)
// stores both keys locally, exactly like it already does for other secrets
// (see lib/push-notification-storage.ts). See PROACTIVE-MESSAGE-2.0-PLAN.md.

import { NextResponse } from "next/server";
import webpush from "web-push";

export const runtime = "nodejs";

export async function POST() {
    try {
        const keys = webpush.generateVAPIDKeys();
        return NextResponse.json({ publicKey: keys.publicKey, privateKey: keys.privateKey });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "vapid_keygen_failed" },
            { status: 500 },
        );
    }
}
