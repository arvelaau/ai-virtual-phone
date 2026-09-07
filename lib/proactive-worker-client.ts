// lib/proactive-worker-client.ts
// Client-side orchestration for the Cloudflare one-click deploy flow, and
// for talking to the deployed Worker afterward. See
// PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// Each deploy step calls app/api/cloudflare-deploy/route.ts (the relay,
// since browsers can't call api.cloudflare.com directly). The pasted
// Cloudflare token only ever lives in this session's memory while deploying
// — it is never written to local storage.

export type CloudflareAccount = { id: string; name: string };

export type DeployProgressStep =
    | "list_accounts"
    | "create_database"
    | "upload_worker"
    | "set_cron"
    | "done";

export type DeployProgressEvent = { step: DeployProgressStep; status: "started" | "done" | "error"; detail?: string };

export type DeployResult = {
    accountId: string;
    databaseId: string;
    workerUrl: string;
    accessToken: string;
};

function generateAccessToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function callDeployStep<T>(step: string, token: string, extra: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch("/api/cloudflare-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, token, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `deploy step "${step}" failed`);
    return data as T;
}

export async function listCloudflareAccounts(token: string): Promise<CloudflareAccount[]> {
    const data = await callDeployStep<{ accounts: CloudflareAccount[] }>("list_accounts", token);
    return data.accounts;
}

/**
 * Runs the full one-click deploy against the given Cloudflare account.
 * Call listCloudflareAccounts() first if the token can access more than one
 * account and let the user pick; pass that account's id here.
 */
export async function deployProactiveWorker(
    token: string,
    accountId: string,
    vapidKeys: { publicKey: string; privateKey: string; subject: string },
    onProgress?: (event: DeployProgressEvent) => void,
): Promise<DeployResult> {
    const emit = (step: DeployProgressStep, status: DeployProgressEvent["status"], detail?: string) =>
        onProgress?.({ step, status, detail });

    emit("create_database", "started");
    const { databaseId } = await callDeployStep<{ databaseId: string }>("create_database", token, { accountId });
    emit("create_database", "done");

    const accessToken = generateAccessToken();

    emit("upload_worker", "started");
    const { workerUrl } = await callDeployStep<{ workerUrl: string }>("upload_worker", token, {
        accountId,
        databaseId,
        vapidPublicKey: vapidKeys.publicKey,
        vapidPrivateKey: vapidKeys.privateKey,
        vapidSubject: vapidKeys.subject,
        accessToken,
    });
    emit("upload_worker", "done");

    emit("set_cron", "started");
    await callDeployStep<{ ok: true }>("set_cron", token, { accountId });
    emit("set_cron", "done");

    emit("done", "done");
    return { accountId, databaseId, workerUrl, accessToken };
}

// ---------- Talking to the deployed Worker directly (not through the relay — CORS is fine here, it's our own Worker) ----------

async function callWorker<T>(workerUrl: string, accessToken: string, path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${workerUrl}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(init?.headers || {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Worker request to ${path} failed (${res.status})`);
    return data as T;
}

export async function registerSubscriptionWithWorker(
    workerUrl: string,
    accessToken: string,
    subscription: PushSubscriptionJSON,
): Promise<void> {
    await callWorker(workerUrl, accessToken, "/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
    });
}

export async function uploadSnapshotToWorker(
    workerUrl: string,
    accessToken: string,
    characterId: string,
    snapshot: unknown,
): Promise<void> {
    await callWorker(workerUrl, accessToken, "/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId, snapshot }),
    });
}

export async function deleteSnapshotFromWorker(
    workerUrl: string,
    accessToken: string,
    characterId: string,
): Promise<void> {
    await callWorker(workerUrl, accessToken, "/snapshot/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId }),
    });
}

export async function sendTestPushViaWorker(
    workerUrl: string,
    accessToken: string,
): Promise<{ sent: number; failed: number; errors: string[] }> {
    return callWorker(workerUrl, accessToken, "/test-push", { method: "POST" });
}

export type WorkerStatus = {
    lastCronRunAt: string | null;
    lastCronSummary: { processed: number; fired: number; errors: string[] } | null;
    lastCronError: string | null;
    subscriptionCount: number;
    snapshotCount: number;
};

export async function getWorkerStatus(workerUrl: string, accessToken: string): Promise<WorkerStatus> {
    return callWorker(workerUrl, accessToken, "/status", { method: "GET" });
}

/** Runs one cron-tick's worth of eligibility checking + firing immediately, for every synced character. */
export async function runProactiveCycleNow(
    workerUrl: string,
    accessToken: string,
): Promise<{ processed: number; fired: number; errors: string[] }> {
    return callWorker(workerUrl, accessToken, "/run-now", { method: "POST" });
}

export type PendingProactiveMessage = { id: string; characterId: string; content: string; createdAt: string };

/** Messages the Worker generated since the app was last open. Reverse-sync (Stage 5) merges these into local chat history. */
export async function pullPendingMessages(workerUrl: string, accessToken: string): Promise<PendingProactiveMessage[]> {
    const data = await callWorker<{ messages: PendingProactiveMessage[] }>(workerUrl, accessToken, "/pending-messages", { method: "GET" });
    return data.messages;
}

/** Confirms the given pending messages were merged locally, so the Worker stops offering them. */
export async function ackPendingMessages(workerUrl: string, accessToken: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await callWorker(workerUrl, accessToken, "/pending-messages/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });
}
