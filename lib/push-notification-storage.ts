// lib/push-notification-storage.ts
// Local storage for Web Push credentials (VAPID keypair) and the browser's
// current PushSubscription. Stage 1 of Proactive Message 2.0 — see
// PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root for the full design.
//
// The VAPID private key is sensitive (it lets whoever holds it send push
// messages that the browser will accept as coming from this app). It is
// stored locally the same way other secrets already are in this app (e.g.
// the Supabase service role key in cloud-backup config) — never sent
// anywhere except when the user explicitly triggers a test push or, in a
// later stage, the one-click Cloudflare deploy flow.

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const PUSH_CONFIG_KEY = "ai_phone_push_config_v1";
registerKvMigration(PUSH_CONFIG_KEY);

export type PushVapidKeys = {
    publicKey: string;   // base64url, used as PushManager.subscribe's applicationServerKey
    privateKey: string;  // base64url, kept locally; becomes a Worker secret in a later stage
    subject: string;     // VAPID "sub" claim — a mailto: or https: contact URL
    createdAt: string;
};

export type StoredPushSubscription = {
    subscription: PushSubscriptionJSON;
    createdAt: string;
};

export type DeployedWorkerConfig = {
    workerUrl: string;
    accessToken: string;   // shared bearer token this app and the Worker both know
    accountId: string;
    databaseId: string;
    deployedAt: string;
};

export type PushNotificationConfig = {
    vapidKeys: PushVapidKeys | null;
    subscription: StoredPushSubscription | null;
    worker: DeployedWorkerConfig | null;
};

function getDefaultPushNotificationConfig(): PushNotificationConfig {
    return { vapidKeys: null, subscription: null, worker: null };
}

export function loadPushNotificationConfig(): PushNotificationConfig {
    if (typeof window === "undefined") return getDefaultPushNotificationConfig();
    try {
        const raw = kvGet(PUSH_CONFIG_KEY);
        if (!raw) return getDefaultPushNotificationConfig();
        const parsed = JSON.parse(raw) as Partial<PushNotificationConfig>;
        return {
            vapidKeys: parsed.vapidKeys && typeof parsed.vapidKeys.publicKey === "string"
                && typeof parsed.vapidKeys.privateKey === "string"
                ? parsed.vapidKeys
                : null,
            subscription: parsed.subscription && parsed.subscription.subscription
                ? parsed.subscription
                : null,
            worker: parsed.worker && typeof parsed.worker.workerUrl === "string" && typeof parsed.worker.accessToken === "string"
                ? parsed.worker
                : null,
        };
    } catch {
        return getDefaultPushNotificationConfig();
    }
}

function savePushNotificationConfig(config: PushNotificationConfig): void {
    if (typeof window === "undefined") return;
    kvSet(PUSH_CONFIG_KEY, JSON.stringify(config));
}

export function saveVapidKeys(keys: PushVapidKeys): void {
    const config = loadPushNotificationConfig();
    savePushNotificationConfig({ ...config, vapidKeys: keys });
}

export function clearVapidKeys(): void {
    // Rotating the keypair invalidates every existing subscription (the
    // browser ties a subscription to the applicationServerKey it was
    // created with) and the deployed Worker (its secret is the old key),
    // so drop both at the same time.
    savePushNotificationConfig({ vapidKeys: null, subscription: null, worker: null });
}

export function saveSubscription(subscription: PushSubscriptionJSON): void {
    const config = loadPushNotificationConfig();
    savePushNotificationConfig({
        ...config,
        subscription: { subscription, createdAt: new Date().toISOString() },
    });
}

export function clearSubscription(): void {
    const config = loadPushNotificationConfig();
    savePushNotificationConfig({ ...config, subscription: null });
}

export function saveDeployedWorker(worker: DeployedWorkerConfig): void {
    const config = loadPushNotificationConfig();
    savePushNotificationConfig({ ...config, worker });
}

export function clearDeployedWorker(): void {
    const config = loadPushNotificationConfig();
    savePushNotificationConfig({ ...config, worker: null });
}
