// app/api/cloudflare-deploy/route.ts
// Relay for the "Proactive Message 2.0" one-click Cloudflare deploy flow.
// See PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// Browsers cannot call api.cloudflare.com directly (no CORS there), so this
// route relays each step server-side. The pasted Cloudflare API token is
// forwarded on every call and never persisted — this route holds no state
// of its own between requests.
//
// Required token scopes (shown to the user in the settings UI): Workers
// Scripts:Edit, D1:Edit, Account Settings:Read.
//
// ⚠️ These Cloudflare API calls have been implemented carefully from the
// documented v4 API shapes, but — unlike the Worker's own Web Push crypto,
// which was round-trip verified locally — they have NOT been exercised
// against a real Cloudflare account yet (that requires a real API token,
// which only the user can provide). Errors from Cloudflare are passed
// through verbatim to the client so a first real run is diagnosable.

import { NextResponse } from "next/server";
import { CLOUDFLARE_WORKER_SCHEMA_SQL, CLOUDFLARE_WORKER_SOURCE } from "@/lib/cloudflare-worker-assets";

export const runtime = "nodejs";
export const maxDuration = 60;

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const WORKER_SCRIPT_NAME = "ai-phone-proactive-worker";
const D1_DATABASE_NAME = "ai-phone-proactive";
const COMPATIBILITY_DATE = "2025-01-01";
const CRON_SCHEDULE = "*/15 * * * *";

type CfResponse<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${CF_API_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init?.headers || {}),
        },
    });
    const data = (await res.json()) as CfResponse<T>;
    if (!res.ok || !data.success) {
        const message = data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
        throw new Error(message);
    }
    return data.result;
}

function splitSchemaStatements(sql: string): string[] {
    return sql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--"));
}

async function listAccounts(token: string) {
    const accounts = await cf<{ id: string; name: string }[]>(token, "/accounts");
    return accounts.map((a) => ({ id: a.id, name: a.name }));
}

async function createOrReuseDatabase(token: string, accountId: string) {
    const existing = await cf<{ uuid: string; name: string }[]>(
        token,
        `/accounts/${accountId}/d1/database?name=${encodeURIComponent(D1_DATABASE_NAME)}`,
    );
    const match = existing.find((d) => d.name === D1_DATABASE_NAME);
    if (match) return match.uuid;

    const created = await cf<{ uuid: string }>(token, `/accounts/${accountId}/d1/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: D1_DATABASE_NAME }),
    });
    return created.uuid;
}

async function applySchema(token: string, accountId: string, databaseId: string) {
    for (const statement of splitSchemaStatements(CLOUDFLARE_WORKER_SCHEMA_SQL)) {
        await cf(token, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sql: statement }),
        });
    }
}

async function uploadWorker(
    token: string,
    accountId: string,
    databaseId: string,
    secrets: { vapidPublicKey: string; vapidPrivateKey: string; vapidSubject: string; accessToken: string },
) {
    const metadata = {
        main_module: "worker.js",
        compatibility_date: COMPATIBILITY_DATE,
        bindings: [
            { type: "d1", name: "DB", id: databaseId },
            { type: "plain_text", name: "VAPID_PUBLIC_KEY", text: secrets.vapidPublicKey },
            { type: "plain_text", name: "VAPID_SUBJECT", text: secrets.vapidSubject },
            { type: "secret_text", name: "VAPID_PRIVATE_KEY", text: secrets.vapidPrivateKey },
            { type: "secret_text", name: "ACCESS_TOKEN", text: secrets.accessToken },
        ],
    };

    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append(
        "worker.js",
        new Blob([CLOUDFLARE_WORKER_SOURCE], { type: "application/javascript+module" }),
        "worker.js",
    );

    await cf(token, `/accounts/${accountId}/workers/scripts/${WORKER_SCRIPT_NAME}`, {
        method: "PUT",
        body: form,
    });

    // Make sure the script is reachable at https://<name>.<subdomain>.workers.dev
    await cf(token, `/accounts/${accountId}/workers/scripts/${WORKER_SCRIPT_NAME}/subdomain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
    });
    const subdomainInfo = await cf<{ subdomain: string }>(token, `/accounts/${accountId}/workers/subdomain`);
    return `https://${WORKER_SCRIPT_NAME}.${subdomainInfo.subdomain}.workers.dev`;
}

async function setCronSchedule(token: string, accountId: string) {
    await cf(token, `/accounts/${accountId}/workers/scripts/${WORKER_SCRIPT_NAME}/schedules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ cron: CRON_SCHEDULE }]),
    });
}

export async function POST(request: Request) {
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const step = String(body.step || "");
    const token = String(body.token || "").trim();
    if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

    try {
        switch (step) {
            case "list_accounts": {
                const accounts = await listAccounts(token);
                return NextResponse.json({ accounts });
            }
            case "create_database": {
                const accountId = String(body.accountId || "");
                if (!accountId) return NextResponse.json({ error: "missing_accountId" }, { status: 400 });
                const databaseId = await createOrReuseDatabase(token, accountId);
                await applySchema(token, accountId, databaseId);
                return NextResponse.json({ databaseId, databaseName: D1_DATABASE_NAME });
            }
            case "upload_worker": {
                const accountId = String(body.accountId || "");
                const databaseId = String(body.databaseId || "");
                const vapidPublicKey = String(body.vapidPublicKey || "");
                const vapidPrivateKey = String(body.vapidPrivateKey || "");
                const vapidSubject = String(body.vapidSubject || "");
                const accessToken = String(body.accessToken || "");
                if (!accountId || !databaseId || !vapidPublicKey || !vapidPrivateKey || !accessToken) {
                    return NextResponse.json({ error: "missing_upload_worker_fields" }, { status: 400 });
                }
                const workerUrl = await uploadWorker(token, accountId, databaseId, {
                    vapidPublicKey,
                    vapidPrivateKey,
                    vapidSubject,
                    accessToken,
                });
                return NextResponse.json({ workerUrl, scriptName: WORKER_SCRIPT_NAME });
            }
            case "set_cron": {
                const accountId = String(body.accountId || "");
                if (!accountId) return NextResponse.json({ error: "missing_accountId" }, { status: 400 });
                await setCronSchedule(token, accountId);
                return NextResponse.json({ ok: true, cron: CRON_SCHEDULE });
            }
            default:
                return NextResponse.json({ error: "unknown_step" }, { status: 400 });
        }
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "cloudflare_deploy_step_failed", step },
            { status: 502 },
        );
    }
}
