"use client";

// components/settings/proactive-push-settings.tsx
// Proactive Message 2.0 — see PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// Stage 1 (push plumbing): VAPID keypair, subscribe flow, manual test push.
// Stage 2: one-click Cloudflare deploy — creates a D1 database, uploads the
// Worker, sets secrets, and registers a Cron Trigger on the user's own
// Cloudflare account. Stage 3: per-character opt-in + snapshot sync. Stage 4
// (this update): the deployed Worker's Cron Trigger now actually reads each
// synced character's snapshot, calls their bound LLM, and sends a real
// push notification when a follow-up/timed-wake/period-care message is due.

import { useEffect, useState } from "react";
import {
    AlertCircle, Bell, BellOff, ChevronDown, ChevronUp, Cloud, CloudOff, Copy, KeyRound,
    Loader2, Play, RefreshCw, Send, Smartphone, Users,
} from "lucide-react";
import { Alert } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/modal";
import { Select } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import {
    clearVapidKeys,
    loadPushNotificationConfig,
    saveSubscription,
    saveVapidKeys,
    clearSubscription,
    saveDeployedWorker,
    type PushNotificationConfig,
} from "@/lib/push-notification-storage";
import {
    getCurrentPushSubscription,
    isIosDevice,
    isPushSupported,
    isStandaloneDisplayMode,
    subscribeToPush,
    unsubscribeFromPush,
} from "@/lib/push-subscribe";
import {
    deployProactiveWorker,
    getWorkerStatus,
    listCloudflareAccounts,
    registerSubscriptionWithWorker,
    runProactiveCycleNow,
    sendTestPushViaWorker,
    type CloudflareAccount,
    type DeployProgressEvent,
    type DeployProgressStep,
    type WorkerStatus,
} from "@/lib/proactive-worker-client";
import { getProactiveCloudSyncOptedInCharacterIds, setProactiveCloudSyncEnabled } from "@/lib/proactive-cloud-storage";
import { removeProactiveCharacterFromCloud, syncProactiveCharacterToCloud } from "@/lib/proactive-cloud-sync";

type Banner = { variant: "success" | "danger" | "default"; message: string };

const DEPLOY_STEP_LABELS: Record<DeployProgressStep, string> = {
    list_accounts: "Looking up your Cloudflare account",
    create_database: "Creating the D1 database",
    upload_worker: "Uploading the Worker",
    set_cron: "Scheduling the Cron Trigger",
    done: "Done",
};

export function ProactivePushSettings() {
    const [config, setConfig] = useState<PushNotificationConfig>(() => loadPushNotificationConfig());
    const [supported, setSupported] = useState(true);
    const [ios, setIos] = useState(false);
    const [standalone, setStandalone] = useState(true);
    const [generatingKeys, setGeneratingKeys] = useState(false);
    const [subscribing, setSubscribing] = useState(false);
    const [sendingTest, setSendingTest] = useState(false);
    const [confirmRegenerate, setConfirmRegenerate] = useState(false);
    const [banner, setBanner] = useState<Banner | null>(null);

    const [showManualDeploy, setShowManualDeploy] = useState(false);
    const [cfToken, setCfToken] = useState("");
    const [cfAccounts, setCfAccounts] = useState<CloudflareAccount[] | null>(null);
    const [cfAccountId, setCfAccountId] = useState("");
    const [deploying, setDeploying] = useState(false);
    const [deploySteps, setDeploySteps] = useState<Partial<Record<DeployProgressStep, DeployProgressEvent["status"]>>>({});
    const [registeringDevice, setRegisteringDevice] = useState(false);
    const [testingViaWorker, setTestingViaWorker] = useState(false);
    const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
    const [checkingStatus, setCheckingStatus] = useState(false);
    const [runningNow, setRunningNow] = useState(false);

    const [optedInCharacters, setOptedInCharacters] = useState<{ id: string; name: string }[]>([]);
    const [syncingCharacterId, setSyncingCharacterId] = useState<string | null>(null);
    const [characterSyncResult, setCharacterSyncResult] = useState<Record<string, { ok: boolean; message: string }>>({});

    const refreshOptedInCharacters = () => {
        const characters = loadCharacters();
        const ids = getProactiveCloudSyncOptedInCharacterIds();
        setOptedInCharacters(
            ids.map((id) => ({ id, name: characters.find((c) => c.id === id)?.name || id })),
        );
    };

    useEffect(() => {
        setSupported(isPushSupported());
        setIos(isIosDevice());
        setStandalone(isStandaloneDisplayMode());
        // The browser's own subscription is the source of truth; reconcile
        // it with what we have stored in case they've drifted (e.g. the
        // user cleared site data, or unsubscribed via browser settings).
        getCurrentPushSubscription().then((live) => {
            if (!live) {
                clearSubscription();
                setConfig(loadPushNotificationConfig());
            }
        });
        refreshOptedInCharacters();
    }, []);

    const canInstallCheck = !ios || standalone;

    const handleGenerateKeys = async (regenerate: boolean) => {
        if (config.vapidKeys && !regenerate) return;
        setGeneratingKeys(true);
        setBanner(null);
        try {
            const res = await fetch("/api/push/vapid", { method: "POST" });
            const data = await res.json();
            if (!res.ok || !data.publicKey || !data.privateKey) {
                throw new Error(data.error || "Failed to generate keys");
            }
            if (regenerate) {
                await unsubscribeFromPush();
                clearVapidKeys();
            }
            saveVapidKeys({
                publicKey: data.publicKey,
                privateKey: data.privateKey,
                subject: "mailto:proactive-push@ai-virtual-phone.local",
                createdAt: new Date().toISOString(),
            });
            setConfig(loadPushNotificationConfig());
            setBanner({ variant: "success", message: "VAPID keypair generated." });
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Failed to generate keys" });
        } finally {
            setGeneratingKeys(false);
            setConfirmRegenerate(false);
        }
    };

    const handleSubscribe = async () => {
        if (!config.vapidKeys) return;
        setSubscribing(true);
        setBanner(null);
        try {
            const result = await subscribeToPush(config.vapidKeys.publicKey);
            if (!result.ok) {
                const messages: Record<string, string> = {
                    unsupported: "This browser does not support Web Push.",
                    not_installed: "Add this app to your Home Screen first, then reopen it from there and try again.",
                    permission_denied: "Notification permission was denied.",
                    subscribe_failed: result.detail || "Subscription failed.",
                };
                setBanner({ variant: "danger", message: messages[result.reason] });
                return;
            }
            saveSubscription(result.subscription);
            setConfig(loadPushNotificationConfig());
            setBanner({ variant: "success", message: "Notifications enabled on this device." });
        } finally {
            setSubscribing(false);
        }
    };

    const handleUnsubscribe = async () => {
        await unsubscribeFromPush();
        clearSubscription();
        setConfig(loadPushNotificationConfig());
        setBanner({ variant: "default", message: "Notifications disabled on this device." });
    };

    const handleSendTest = async () => {
        if (!config.vapidKeys || !config.subscription) return;
        setSendingTest(true);
        setBanner(null);
        try {
            const res = await fetch("/api/push/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    subscription: config.subscription.subscription,
                    vapidPublicKey: config.vapidKeys.publicKey,
                    vapidPrivateKey: config.vapidKeys.privateKey,
                    vapidSubject: config.vapidKeys.subject,
                    title: "Test notification",
                    body: "Push delivery is working.",
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                if (data.expired) {
                    clearSubscription();
                    setConfig(loadPushNotificationConfig());
                }
                throw new Error(data.error || "Send failed");
            }
            setBanner({ variant: "success", message: "Test notification sent. It should arrive shortly." });
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Send failed" });
        } finally {
            setSendingTest(false);
        }
    };

    const copyPublicKey = async () => {
        if (!config.vapidKeys) return;
        try {
            await navigator.clipboard.writeText(config.vapidKeys.publicKey);
            setBanner({ variant: "default", message: "Public key copied." });
        } catch {
            // clipboard access can fail silently in some embedded contexts; not worth surfacing as an error
        }
    };

    const handleStartDeploy = async () => {
        if (!config.vapidKeys) {
            setBanner({ variant: "danger", message: "Generate a VAPID keypair first (above)." });
            return;
        }
        const token = cfToken.trim();
        if (!token) {
            setBanner({ variant: "danger", message: "Paste a Cloudflare API token first." });
            return;
        }
        setBanner(null);
        setDeploying(true);
        setDeploySteps({});
        try {
            let accountId = cfAccountId;
            if (!accountId) {
                setDeploySteps({ list_accounts: "started" });
                const accounts = await listCloudflareAccounts(token);
                setDeploySteps({ list_accounts: "done" });
                if (accounts.length === 0) {
                    throw new Error("This token has no accessible accounts.");
                }
                if (accounts.length > 1) {
                    // Let the user pick, then they press "Start deployment" again.
                    setCfAccounts(accounts);
                    setDeploying(false);
                    return;
                }
                accountId = accounts[0].id;
                setCfAccountId(accountId);
            }

            const result = await deployProactiveWorker(
                token,
                accountId,
                config.vapidKeys,
                (event) => setDeploySteps((prev) => ({ ...prev, [event.step]: event.status })),
            );

            saveDeployedWorker({
                workerUrl: result.workerUrl,
                accessToken: result.accessToken,
                accountId: result.accountId,
                databaseId: result.databaseId,
                deployedAt: new Date().toISOString(),
            });
            setConfig(loadPushNotificationConfig());
            setCfToken("");
            setBanner({ variant: "success", message: `Deployed: ${result.workerUrl}` });
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Deployment failed" });
            setDeploySteps((prev) => {
                const next = { ...prev };
                for (const step of Object.keys(next) as DeployProgressStep[]) {
                    if (next[step] === "started") next[step] = "error";
                }
                return next;
            });
        } finally {
            setDeploying(false);
        }
    };

    const handleRegisterDevice = async () => {
        if (!config.worker || !config.subscription) return;
        setRegisteringDevice(true);
        setBanner(null);
        try {
            await registerSubscriptionWithWorker(config.worker.workerUrl, config.worker.accessToken, config.subscription.subscription);
            setBanner({ variant: "success", message: "This device is registered with the Worker." });
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Failed to register device" });
        } finally {
            setRegisteringDevice(false);
        }
    };

    const handleTestViaWorker = async () => {
        if (!config.worker) return;
        setTestingViaWorker(true);
        setBanner(null);
        try {
            const result = await sendTestPushViaWorker(config.worker.workerUrl, config.worker.accessToken);
            setBanner({
                variant: result.failed > 0 ? "danger" : "success",
                message: `Worker sent ${result.sent}, failed ${result.failed}.${result.errors.length ? ` (${result.errors[0]})` : ""}`,
            });
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Test push via Worker failed" });
        } finally {
            setTestingViaWorker(false);
        }
    };

    const handleSyncCharacterNow = async (characterId: string) => {
        setSyncingCharacterId(characterId);
        setCharacterSyncResult((prev) => ({ ...prev, [characterId]: undefined } as typeof prev));
        try {
            await syncProactiveCharacterToCloud(characterId);
            setCharacterSyncResult((prev) => ({ ...prev, [characterId]: { ok: true, message: `Synced at ${new Date().toLocaleTimeString()}` } }));
        } catch (err) {
            setCharacterSyncResult((prev) => ({ ...prev, [characterId]: { ok: false, message: err instanceof Error ? err.message : "Sync failed" } }));
        } finally {
            setSyncingCharacterId(null);
        }
    };

    const handleRemoveCharacterFromCloud = async (characterId: string) => {
        setSyncingCharacterId(characterId);
        try {
            setProactiveCloudSyncEnabled(characterId, false);
            await removeProactiveCharacterFromCloud(characterId);
            refreshOptedInCharacters();
        } catch (err) {
            setCharacterSyncResult((prev) => ({ ...prev, [characterId]: { ok: false, message: err instanceof Error ? err.message : "Failed to remove from Worker" } }));
        } finally {
            setSyncingCharacterId(null);
        }
    };

    const handleRunNow = async () => {
        if (!config.worker) return;
        setRunningNow(true);
        setBanner(null);
        try {
            const result = await runProactiveCycleNow(config.worker.workerUrl, config.worker.accessToken);
            setBanner({
                variant: result.errors.length > 0 ? "danger" : "success",
                message: `Checked ${result.processed} character(s), fired ${result.fired}.${result.errors.length ? ` (${result.errors[0]})` : ""}`,
            });
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Run now failed" });
        } finally {
            setRunningNow(false);
        }
    };

    const handleCheckStatus = async () => {
        if (!config.worker) return;
        setCheckingStatus(true);
        try {
            const status = await getWorkerStatus(config.worker.workerUrl, config.worker.accessToken);
            setWorkerStatus(status);
        } catch (err) {
            setBanner({ variant: "danger", message: err instanceof Error ? err.message : "Failed to check status" });
        } finally {
            setCheckingStatus(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Proactive Push</h2>
            </div>

            <Alert variant="default">
                <AlertCircle size={16} className="mt-[2px] shrink-0" />
                <div>
                    This delivers proactive messages as real OS notifications, even after iOS closes
                    the app in the background. The deployed Worker now reads each opted-in
                    character&apos;s synced data on its own schedule, generates an in-character
                    message with their bound API config, and pushes it — the reply only appears in
                    the chat itself the next time you open the app (that reconciliation step is not
                    built yet).
                </div>
            </Alert>

            {banner && <Alert variant={banner.variant}>{banner.message}</Alert>}

            {!supported && (
                <Alert variant="danger">
                    <AlertCircle size={16} className="mt-[2px] shrink-0" />
                    <div>This browser does not support Web Push.</div>
                </Alert>
            )}

            {ios && !standalone && (
                <Alert variant="danger">
                    <Smartphone size={16} className="mt-[2px] shrink-0" />
                    <div>
                        On iOS, push notifications only work once this app is added to the Home
                        Screen. Use the Share button, choose &quot;Add to Home Screen&quot;, then
                        open the app from that icon and come back here.
                    </div>
                </Alert>
            )}

            <div className="ui-config-card flex flex-col gap-3" style={{ padding: "16px" }}>
                <div className="flex items-center gap-2">
                    <KeyRound size={18} />
                    <span className="menu-label font-semibold">Push Credentials (VAPID)</span>
                </div>
                {config.vapidKeys ? (
                    <>
                        <div className="menu-desc break-all">{config.vapidKeys.publicKey}</div>
                        <div className="flex gap-2">
                            <button className="ui-btn" onClick={copyPublicKey}>
                                <Copy size={16} /> Copy public key
                            </button>
                            <button
                                className="ui-btn"
                                disabled={generatingKeys}
                                onClick={() => setConfirmRegenerate(true)}
                            >
                                {generatingKeys ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                Regenerate
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <span className="menu-desc">No keypair yet. Generate one to enable push for this app.</span>
                        <button
                            className="ui-btn ui-btn-primary rounded-[20px] self-start"
                            disabled={generatingKeys || !supported}
                            onClick={() => handleGenerateKeys(false)}
                        >
                            {generatingKeys && <Loader2 size={16} className="animate-spin" />}
                            Generate keypair
                        </button>
                    </>
                )}
            </div>

            <div className="ui-config-card flex flex-col gap-3" style={{ padding: "16px" }}>
                <div className="flex items-center gap-2">
                    {config.subscription ? <Bell size={18} /> : <BellOff size={18} />}
                    <span className="menu-label font-semibold">Push Subscription</span>
                </div>
                <span className="menu-desc">
                    {config.subscription
                        ? "This device is subscribed to push notifications."
                        : "This device is not subscribed yet."}
                </span>
                {config.subscription ? (
                    <button className="ui-btn self-start" onClick={handleUnsubscribe}>
                        <BellOff size={16} /> Disable on this device
                    </button>
                ) : (
                    <button
                        className="ui-btn ui-btn-primary rounded-[20px] self-start"
                        disabled={!config.vapidKeys || subscribing || !supported || !canInstallCheck}
                        onClick={handleSubscribe}
                    >
                        {subscribing ? <Loader2 size={16} className="animate-spin" /> : <Bell size={16} />}
                        Enable notifications
                    </button>
                )}
            </div>

            <div className="ui-config-card flex flex-col gap-3" style={{ padding: "16px" }}>
                <div className="flex items-center gap-2">
                    <Send size={18} />
                    <span className="menu-label font-semibold">Send test notification</span>
                </div>
                <span className="menu-desc">
                    Sends one real push through the server, end to end, so you can confirm delivery
                    before anything else is built on top of it.
                </span>
                <button
                    className="ui-btn ui-btn-primary rounded-[20px] self-start"
                    disabled={!config.vapidKeys || !config.subscription || sendingTest}
                    onClick={handleSendTest}
                >
                    {sendingTest ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    Send test notification
                </button>
            </div>

            <div className="ui-config-card flex flex-col gap-3" style={{ padding: "16px" }}>
                <div className="flex items-center gap-2">
                    <Cloud size={18} />
                    <span className="menu-label font-semibold">Proactive Message 2.0 — Cloud Deploy</span>
                </div>

                {config.worker ? (
                    <>
                        <span className="menu-desc break-all">Deployed: {config.worker.workerUrl}</span>
                        <div className="flex flex-wrap gap-2">
                            <button
                                className="ui-btn"
                                disabled={!config.subscription || registeringDevice}
                                onClick={handleRegisterDevice}
                            >
                                {registeringDevice && <Loader2 size={16} className="animate-spin" />}
                                Register this device
                            </button>
                            <button className="ui-btn" disabled={testingViaWorker} onClick={handleTestViaWorker}>
                                {testingViaWorker ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                                Send test via Worker
                            </button>
                            <button className="ui-btn" disabled={checkingStatus} onClick={handleCheckStatus}>
                                {checkingStatus ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                Check schedule status
                            </button>
                            <button className="ui-btn" disabled={runningNow} onClick={handleRunNow}>
                                {runningNow ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                                Run proactive check now
                            </button>
                        </div>
                        {!config.subscription && (
                            <span className="menu-desc">Enable notifications on this device (above) before registering it.</span>
                        )}
                        {workerStatus && (
                            <span className="menu-desc">
                                Subscriptions: {workerStatus.subscriptionCount}. Synced characters: {workerStatus.snapshotCount ?? 0}.
                                Last scheduled check:{" "}
                                {workerStatus.lastCronRunAt ? new Date(workerStatus.lastCronRunAt).toLocaleString() : "not yet — cron runs every 15 minutes"}.
                                {workerStatus.lastCronSummary && (
                                    <> Last tick: checked {workerStatus.lastCronSummary.processed}, fired {workerStatus.lastCronSummary.fired}.</>
                                )}
                                {workerStatus.lastCronError && <> Last cron error: {workerStatus.lastCronError}</>}
                            </span>
                        )}
                    </>
                ) : (
                    <>
                        <span className="menu-desc">
                            Deploys a Worker to your own Cloudflare account: creates the D1 database,
                            uploads the Worker, sets secrets, and schedules the Cron Trigger. Needs a
                            Cloudflare API Token scoped to Workers Scripts:Edit, D1:Edit, Account
                            Settings:Read. The token is relayed through this app&apos;s own server for
                            each step and is not stored anywhere.
                        </span>
                        <input
                            type="password"
                            className="ui-input"
                            placeholder="Paste Cloudflare API Token"
                            value={cfToken}
                            onChange={(e) => setCfToken(e.target.value)}
                            disabled={deploying}
                        />
                        {cfAccounts && cfAccounts.length > 1 && (
                            <Select value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)}>
                                <option value="">Choose an account…</option>
                                {cfAccounts.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </Select>
                        )}
                        <button
                            className="ui-btn ui-btn-primary rounded-[20px] self-start"
                            disabled={deploying || !config.vapidKeys || (cfAccounts !== null && cfAccounts.length > 1 && !cfAccountId)}
                            onClick={handleStartDeploy}
                        >
                            {deploying && <Loader2 size={16} className="animate-spin" />}
                            Start deployment
                        </button>
                        {Object.keys(deploySteps).length > 0 && (
                            <ul className="menu-desc flex flex-col gap-1">
                                {(Object.keys(DEPLOY_STEP_LABELS) as DeployProgressStep[])
                                    .filter((step) => deploySteps[step])
                                    .map((step) => (
                                        <li key={step}>
                                            {deploySteps[step] === "started" ? "⏳" : deploySteps[step] === "error" ? "⚠️" : "✅"}{" "}
                                            {DEPLOY_STEP_LABELS[step]}
                                        </li>
                                    ))}
                            </ul>
                        )}
                    </>
                )}

                <button
                    type="button"
                    className="ui-btn ui-btn-ghost self-start"
                    onClick={() => setShowManualDeploy((v) => !v)}
                >
                    {showManualDeploy ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    Deploy manually instead
                </button>
                {showManualDeploy && (
                    <span className="menu-desc">
                        See <code>cloudflare/proactive-worker/README.md</code> in the project for
                        step-by-step <code>wrangler</code> CLI commands, if you&apos;d rather not
                        paste a Cloudflare API token into the app.
                    </span>
                )}
            </div>

            <div className="ui-config-card flex flex-col gap-3" style={{ padding: "16px" }}>
                <div className="flex items-center gap-2">
                    <Users size={18} />
                    <span className="menu-label font-semibold">Opted-in Characters</span>
                </div>
                <span className="menu-desc">
                    Every character whose data is allowed to leave this device. Toggle this per
                    character from that chat&apos;s own Settings (the notification bell icon), or
                    remove one from here.
                </span>
                {optedInCharacters.length === 0 ? (
                    <span className="menu-desc">No characters opted in yet.</span>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {optedInCharacters.map((c) => {
                            const result = characterSyncResult[c.id];
                            const busy = syncingCharacterId === c.id;
                            return (
                                <li key={c.id} className="flex flex-col gap-1 border-t border-black/5 pt-2 first:border-t-0 first:pt-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="menu-label">{c.name}</span>
                                        <div className="flex gap-2">
                                            <button
                                                className="ui-btn"
                                                disabled={busy || !config.worker}
                                                onClick={() => handleSyncCharacterNow(c.id)}
                                            >
                                                {busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                                Sync now
                                            </button>
                                            <button
                                                className="ui-btn"
                                                disabled={busy}
                                                onClick={() => handleRemoveCharacterFromCloud(c.id)}
                                            >
                                                <CloudOff size={16} /> Remove
                                            </button>
                                        </div>
                                    </div>
                                    {!config.worker && <span className="menu-desc">Deploy the Worker above before syncing.</span>}
                                    {result && (
                                        <span className={`menu-desc ${result.ok ? "" : "text-red-600"}`}>{result.message}</span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {confirmRegenerate && (
                <ConfirmDialog
                    title="Regenerate keypair?"
                    message="This invalidates the current subscription on every device that enabled notifications with the old key, and disconnects the deployed Worker (it still has the old key as a secret). You'll need to re-enable notifications and redeploy afterward."
                    icon={AlertCircle}
                    confirmLabel="Regenerate"
                    variant="danger"
                    onConfirm={() => handleGenerateKeys(true)}
                    onCancel={() => setConfirmRegenerate(false)}
                />
            )}
        </div>
    );
}
