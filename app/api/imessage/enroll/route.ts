// app/api/imessage/enroll/route.ts
// Registers the owner's phone number with their Photon project and reports which shared
// line to text. Uses the project's server-side credentials and spends project quota, so it
// is restricted to an admin account, the shared admin key, or a self-hosted instance.
//
//   GET  ?phone=+15551234567   -> is this number registered, and what is its line?
//   POST { phone }             -> register it (idempotent: an existing registration is
//                                 returned as-is and costs no quota)
//
// Only the status of the number you ask about is returned, never the project's full user
// list, and never any credential.

import { NextResponse } from "next/server";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { getModeratorContext } from "@/lib/server/admin-auth";
import {
    enrollSharedUser,
    getPhotonCredentials,
    listSharedUsers,
} from "@/lib/server/photon-admin";
import {
    isE164,
    normalizePhoneE164,
    summarizeEnrollment,
} from "@/lib/imessage-photon-admin";

export const runtime = "nodejs";
export const maxDuration = 30;

async function isAllowed(request: Request): Promise<boolean> {
    if (isSelfHostedModeEnabled()) return true;
    return Boolean(await getModeratorContext(request).catch(() => null));
}

function forbidden() {
    return NextResponse.json(
        { ok: false, error: "forbidden", message: "Only an admin account (or the admin key) can manage iMessage registration." },
        { status: 403 },
    );
}

function statusFor(status: number): number {
    // Surface Photon's own verdicts where they are meaningful to the caller, and hide the rest.
    if (status === 401 || status === 403) return 502; // OUR credentials are wrong, not the caller's
    if (status === 404 || status === 409 || status === 429) return status;
    if (status === 400 || status === 422) return 400;
    return 502;
}

export async function GET(request: Request) {
    if (!(await isAllowed(request))) return forbidden();

    const creds = getPhotonCredentials();
    if (!creds) {
        return NextResponse.json({ ok: false, configured: false, error: "missing_photon_env" }, { status: 503 });
    }

    const phone = normalizePhoneE164(new URL(request.url).searchParams.get("phone"));
    if (!phone) {
        // No number asked about: report only that the credentials are present and valid.
        const probe = await listSharedUsers(creds);
        if (!probe.ok) {
            return NextResponse.json({ ok: false, configured: true, message: probe.error }, { status: statusFor(probe.status) });
        }
        return NextResponse.json({ ok: true, configured: true, credentialsValid: true });
    }
    if (!isE164(phone)) {
        return NextResponse.json(
            { ok: false, configured: true, message: "Use the international format, for example +15551234567." },
            { status: 400 },
        );
    }

    const listed = await listSharedUsers(creds);
    if (!listed.ok) {
        return NextResponse.json({ ok: false, configured: true, message: listed.error }, { status: statusFor(listed.status) });
    }
    return NextResponse.json({ ok: true, configured: true, ...summarizeEnrollment(listed.data, phone) });
}

export async function POST(request: Request) {
    if (!(await isAllowed(request))) return forbidden();

    const creds = getPhotonCredentials();
    if (!creds) {
        return NextResponse.json({ ok: false, configured: false, error: "missing_photon_env" }, { status: 503 });
    }

    const body = await request.json().catch(() => ({})) as { phone?: unknown };
    const phone = normalizePhoneE164(body.phone);
    if (!isE164(phone)) {
        return NextResponse.json(
            { ok: false, configured: true, message: "Use the international format, for example +15551234567." },
            { status: 400 },
        );
    }

    // Look first: every creation consumes a shared-user slot, and a repeat press must be free.
    const listed = await listSharedUsers(creds);
    if (!listed.ok) {
        return NextResponse.json({ ok: false, configured: true, message: listed.error }, { status: statusFor(listed.status) });
    }
    const existing = summarizeEnrollment(listed.data, phone);
    if (existing.state === "registered") {
        return NextResponse.json({ ok: true, configured: true, alreadyRegistered: true, ...existing });
    }

    const created = await enrollSharedUser(creds, phone);
    if (!created.ok) {
        return NextResponse.json({ ok: false, configured: true, message: created.error }, { status: statusFor(created.status) });
    }
    return NextResponse.json({
        ok: true,
        configured: true,
        alreadyRegistered: false,
        state: "registered",
        phoneNumber: phone,
        assignedPhoneNumber: created.data.assignedPhoneNumber,
    });
}
