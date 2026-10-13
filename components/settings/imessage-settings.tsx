"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { isCloudBackupConfigured, loadCloudBackupConfig } from "@/lib/cloud-backup/config";
import {
    addIMessageLine,
    loadIMessageLines,
    removeIMessageLine,
    updateIMessageLine,
} from "@/lib/imessage-storage";
import { pullIMessageCloudMessages, syncIMessageLineRuntimeToCloud } from "@/lib/imessage-cloud-sync";
import { normalizeIMessageAddress } from "@/lib/imessage-webhook-core";
import { isE164, normalizePhoneE164 } from "@/lib/imessage-photon-admin";
import type { IMessageLineBinding } from "@/lib/imessage-types";
import { Button } from "@/components/ui/button";
import { Input, Select, Toggle } from "@/components/ui/form";

type ServerStatus = "checking" | "ready" | "not_configured" | "unreachable";

type ActivityEvent = { at: string; result: string; reason: string; detail?: string; senderHint?: string; messageType?: string; ms?: number };
type ActivityView = {
    env: Record<string, boolean>;
    indexFound: boolean;
    indexError?: string;
    bound: Array<{ phone: string; character: string }>;
    events: ActivityEvent[];
    reasons: Record<string, string>;
};

type EnrollView = { state: "registered" | "registered_without_line" | "not_registered" | "error"; line?: string; message?: string };

const ADMIN_KEY_STORAGE = "imessage_admin_key_session";

function readSessionKey(): string {
    try { return window.sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? ""; } catch { return ""; }
}
function writeSessionKey(value: string): void {
    try { window.sessionStorage.setItem(ADMIN_KEY_STORAGE, value); } catch { /* private mode */ }
}

export function IMessageSettings() {
    const [lines, setLines] = useState<IMessageLineBinding[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [phone, setPhone] = useState("");
    const [characterId, setCharacterId] = useState("");
    const [serverStatus, setServerStatus] = useState<ServerStatus>("checking");
    const [cloudReady, setCloudReady] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const [webhookUrl, setWebhookUrl] = useState("");
    const [enroll, setEnroll] = useState<Record<string, EnrollView>>({});
    const [adminKey, setAdminKey] = useState("");
    const [needsKey, setNeedsKey] = useState(false);
    const [activity, setActivity] = useState<ActivityView | null>(null);
    const [activityError, setActivityError] = useState("");

    const refresh = useCallback(() => setLines(loadIMessageLines()), []);

    useEffect(() => {
        refresh();
        const chars = loadCharacters();
        setCharacters(chars);
        setCharacterId((current) => current || chars[0]?.id || "");
        setCloudReady(isCloudBackupConfigured(loadCloudBackupConfig()));
        setWebhookUrl(`${window.location.origin}/api/imessage/webhook`);
        setAdminKey(readSessionKey());

        let cancelled = false;
        fetch("/api/imessage/webhook", { cache: "no-store" })
            .then((res) => res.json())
            .then((data: { configured?: boolean }) => {
                if (!cancelled) setServerStatus(data.configured ? "ready" : "not_configured");
            })
            .catch(() => {
                if (!cancelled) setServerStatus("unreachable");
            });
        return () => { cancelled = true; };
    }, [refresh]);

    const characterName = (id: string) => characters.find((c) => c.id === id)?.name ?? "(deleted character)";

    const handleAdd = () => {
        const normalized = normalizeIMessageAddress(phone);
        if (!normalized) { setMessage("Enter the phone number or email you text from."); return; }
        if (!characterId) { setMessage("Pick a character first."); return; }
        if (lines.some((line) => normalizeIMessageAddress(line.phone) === normalized)) {
            setMessage("That number is already bound to a character.");
            return;
        }
        addIMessageLine({ phone: phone.trim(), characterId, enabled: true });
        setPhone("");
        setMessage("Line added. Press Sync to upload this character's runtime package.");
        refresh();
    };

    const handleSync = async (line: IMessageLineBinding) => {
        setBusyId(line.id);
        setMessage("");
        try {
            const result = await syncIMessageLineRuntimeToCloud(line.id);
            setMessage(
                `Synced ${characterName(line.characterId)} (${Math.round(result.bytes / 1024)} KB).` +
                (result.slotFound
                    ? ""
                    : " Note: the chat history position was not found in this character's prompt, so replies append the new message at the end. This usually means a custom preset or regex rule is rewriting the history."),
            );
        } catch (err) {
            setMessage(err instanceof Error ? err.message : "Sync failed.");
        } finally {
            setBusyId(null);
        }
    };

    /** GET = look up the registration; POST = register (idempotent on the server). */
    const callEnroll = async (line: IMessageLineBinding, method: "GET" | "POST") => {
        const phoneNumber = normalizePhoneE164(line.phone);
        if (!isE164(phoneNumber)) {
            setEnroll((prev) => ({ ...prev, [line.id]: { state: "error", message: "Registration needs a phone number in international format, for example +15551234567. An email cannot be registered." } }));
            return;
        }
        setBusyId(`enroll:${line.id}`);
        try {
            const headers: Record<string, string> = adminKey ? { "x-app-market-admin-key": adminKey } : {};
            const res = method === "GET"
                ? await fetch(`/api/imessage/enroll?phone=${encodeURIComponent(phoneNumber)}`, { headers, cache: "no-store" })
                : await fetch("/api/imessage/enroll", {
                    method: "POST",
                    headers: { ...headers, "Content-Type": "application/json" },
                    body: JSON.stringify({ phone: phoneNumber }),
                });
            const data = await res.json().catch(() => ({})) as {
                ok?: boolean; state?: EnrollView["state"]; assignedPhoneNumber?: string; message?: string; error?: string;
            };
            if (res.status === 403) {
                setNeedsKey(true);
                setEnroll((prev) => ({ ...prev, [line.id]: { state: "error", message: data.message || "Admin access is required." } }));
                return;
            }
            if (res.status === 503) {
                setEnroll((prev) => ({ ...prev, [line.id]: { state: "error", message: "The server has no Photon credentials. Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET and redeploy." } }));
                return;
            }
            if (!res.ok || !data.ok) {
                setEnroll((prev) => ({ ...prev, [line.id]: { state: "error", message: data.message || `Request failed (${res.status}).` } }));
                return;
            }
            const state = data.state ?? "not_registered";
            if (state === "registered" && data.assignedPhoneNumber) {
                updateIMessageLine(line.id, { linePhone: data.assignedPhoneNumber });
                refresh();
            }
            setEnroll((prev) => ({ ...prev, [line.id]: { state, line: data.assignedPhoneNumber } }));
        } catch (err) {
            setEnroll((prev) => ({ ...prev, [line.id]: { state: "error", message: err instanceof Error ? err.message : "Request failed." } }));
        } finally {
            setBusyId(null);
        }
    };

    const loadActivity = async () => {
        setBusyId("activity");
        setActivityError("");
        try {
            const headers: Record<string, string> = adminKey ? { "x-app-market-admin-key": adminKey } : {};
            const res = await fetch("/api/imessage/status", { headers, cache: "no-store" });
            if (res.status === 403) {
                setNeedsKey(true);
                setActivityError("Admin access is required to see webhook activity.");
                return;
            }
            const data = await res.json() as ActivityView & { ok?: boolean };
            if (!res.ok || !data.ok) { setActivityError(`Could not load activity (${res.status}).`); return; }
            setActivity(data);
        } catch (err) {
            setActivityError(err instanceof Error ? err.message : "Could not load activity.");
        } finally {
            setBusyId(null);
        }
    };

    const handlePull = async () => {
        setBusyId("pull");
        setMessage("");
        try {
            const result = await pullIMessageCloudMessages();
            for (const sessionId of result.sessionIds) {
                window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
            }
            setMessage(
                result.errors.length
                    ? `Pulled ${result.added} new, ${result.errors.length} error(s): ${result.errors[0]}`
                    : `Pulled ${result.added} new message(s).`,
            );
        } catch (err) {
            setMessage(err instanceof Error ? err.message : "Pull failed.");
        } finally {
            setBusyId(null);
        }
    };

    const statusText: Record<ServerStatus, string> = {
        checking: "Checking server...",
        ready: "Server is configured",
        not_configured: "Server environment variables are missing",
        unreachable: "Webhook route could not be reached",
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Status</p>
                <div className="menu-group p-4 flex flex-col gap-2">
                    <span className="menu-desc ml-1">Server: {statusText[serverStatus]}</span>
                    <span className="menu-desc ml-1">
                        Cloud backup (Supabase): {cloudReady ? "configured" : "not configured, set it up in Data Management first"}
                    </span>
                    <span className="menu-desc ml-1">
                        Webhook URL to paste into the Photon dashboard:
                    </span>
                    <Input readOnly value={webhookUrl} onFocus={(event) => event.currentTarget.select()} />
                    <span className="menu-desc ml-1">
                        The server needs PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, PHOTON_WEBHOOK_SECRET,
                        IMESSAGE_SUPABASE_URL and IMESSAGE_SUPABASE_SERVICE_ROLE_KEY. The Supabase pair must be
                        the same project as Cloud Backup. Photon secrets are never entered here.
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Bound lines (1:1 chat)</p>
                {lines.length === 0 && (
                    <div className="menu-group p-4">
                        <span className="menu-desc">No lines yet. Add the number you will text from below.</span>
                    </div>
                )}
                {lines.map((line) => (
                    <div key={line.id} className="menu-group p-4 flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-col">
                                <span className="menu-label">{line.phone}</span>
                                <span className="menu-desc">replies as {characterName(line.characterId)}</span>
                            </div>
                            <Toggle
                                checked={line.enabled}
                                onChange={(next) => { updateIMessageLine(line.id, { enabled: next }); refresh(); }}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="menu-label">Messages the character starts in the app</span>
                            <span className="menu-desc">Follow-ups, timed wake-ups and chat plugins that make the character write first. They can also be sent to this iMessage number. Only happens while this app is open.</span>
                            <Select
                                value={line.mirrorMode ?? "proactive"}
                                onChange={(event) => { updateIMessageLine(line.id, { mirrorMode: event.target.value as "off" | "proactive" | "all" }); refresh(); }}
                            >
                                <option value="proactive">Send the ones the character starts</option>
                                <option value="all">Send everything the character writes in the app</option>
                                <option value="off">Keep them in the app only</option>
                            </Select>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="flex flex-col">
                                <span className="menu-label">Send photos as real pictures</span>
                                <span className="menu-desc">When the character sends a photo, this app generates it and delivers it over iMessage. Needs image generation set up, and only happens while this app is open; otherwise the photo goes out as a text description. Sync to cloud after changing it.</span>
                            </span>
                            <Toggle
                                checked={line.sendPhotos !== false}
                                onChange={(next) => { updateIMessageLine(line.id, { sendPhotos: next }); refresh(); }}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="menu-desc">Wait for a pause before answering, so several bubbles get one reply. Sync to cloud after changing it.</span>
                            <Select
                                value={String(line.replyDelaySeconds ?? 60)}
                                onChange={(event) => { updateIMessageLine(line.id, { replyDelaySeconds: Number(event.target.value) }); refresh(); }}
                            >
                                <option value="0">Answer every message right away</option>
                                <option value="15">Wait 15 seconds of quiet</option>
                                <option value="30">Wait 30 seconds of quiet</option>
                                <option value="60">Wait 1 minute of quiet</option>
                                <option value="90">Wait 90 seconds of quiet</option>
                                <option value="120">Wait 2 minutes of quiet</option>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-1">
                            {(() => {
                                const view = enroll[line.id];
                                const lineNumber = view?.line || line.linePhone;
                                if (lineNumber) {
                                    return <span className="menu-desc">Text this number from iMessage: <strong>{lineNumber}</strong></span>;
                                }
                                if (view?.state === "registered_without_line") {
                                    return <span className="menu-desc">Registered, but Photon has not assigned a line yet. Check again in a moment.</span>;
                                }
                                if (view?.state === "not_registered") {
                                    return <span className="menu-desc">Not registered with Photon yet. Messages from this number are silently dropped until you register it.</span>;
                                }
                                if (view?.state === "error") {
                                    return <span className="menu-desc">{view.message}</span>;
                                }
                                return <span className="menu-desc">Registration status unknown. Press Check.</span>;
                            })()}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                disabled={busyId !== null}
                                onClick={() => void callEnroll(line, "GET")}
                            >
                                {busyId === `enroll:${line.id}` ? "Working..." : "Check registration"}
                            </Button>
                            {enroll[line.id]?.state === "not_registered" && (
                                <Button
                                    variant="primary"
                                    disabled={busyId !== null}
                                    onClick={() => void callEnroll(line, "POST")}
                                >
                                    Register this number
                                </Button>
                            )}
                            <Button
                                variant="primary"
                                disabled={busyId !== null || !cloudReady}
                                onClick={() => void handleSync(line)}
                            >
                                {busyId === line.id ? "Syncing..." : "Sync to cloud"}
                            </Button>
                            <Button
                                variant="soft-danger"
                                disabled={busyId !== null}
                                onClick={() => { removeIMessageLine(line.id); refresh(); }}
                                aria-label="Remove line"
                            >
                                <Trash2 size={16} />
                            </Button>
                        </div>
                    </div>
                ))}
                {lines.length > 0 && (
                    <Button variant="outline" disabled={busyId !== null || !cloudReady} onClick={() => void handlePull()}>
                        {busyId === "pull" ? "Pulling..." : "Pull messages now"}
                    </Button>
                )}
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Add a line</p>
                <div className="menu-group p-4 flex flex-col gap-2">
                    <label className="menu-desc ml-1">Your phone number or Apple ID email</label>
                    <Input
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                        placeholder="+15551234567"
                    />
                    <label className="menu-desc ml-1">Character who answers</label>
                    <Select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
                        {characters.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </Select>
                    <Button variant="primary" onClick={handleAdd}>Add line</Button>
                    <span className="menu-desc ml-1">
                        Messages from this number reach the bot you set up in Photon and are answered in
                        character. After changing the persona, preset, worldbook or memory, press Sync again.
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Webhook activity</p>
                <div className="menu-group p-4 flex flex-col gap-2">
                    <span className="menu-desc ml-1">
                        What the server did with the most recent messages. If you text the bot and nothing appears
                        here, Photon is not reaching this deployment at all.
                    </span>
                    <Button variant="outline" disabled={busyId !== null} onClick={() => void loadActivity()}>
                        {busyId === "activity" ? "Loading..." : "Refresh activity"}
                    </Button>
                    {activityError && <span className="menu-desc ml-1">{activityError}</span>}
                    {activity && (
                        <div className="flex flex-col gap-2">
                            <span className="menu-desc ml-1">
                                Server env: {Object.entries(activity.env).map(([k, v]) => `${k} ${v ? "ok" : "MISSING"}`).join(", ")}
                            </span>
                            <span className="menu-desc ml-1">
                                Cloud index: {activity.indexFound
                                    ? `found, binds ${activity.bound.map((b) => `${b.phone} (${b.character})`).join(", ") || "no numbers"}`
                                    : "NOT FOUND. Press Sync to cloud, and check IMESSAGE_SUPABASE_URL matches Cloud Backup."}
                                {activity.indexError ? ` (${activity.indexError})` : ""}
                            </span>
                            {activity.events.length === 0 && (
                                <span className="menu-desc ml-1">No webhook deliveries recorded yet.</span>
                            )}
                            {activity.events.map((event, i) => (
                                <div key={`${event.at}-${i}`} className="flex flex-col">
                                    <span className="menu-label">
                                        {event.result === "replied" ? "Replied" : event.result === "ignored" ? "Ignored" : event.result === "rejected" ? "Not answered" : "Error"}
                                        {" · "}{new Date(event.at).toLocaleString()}
                                    </span>
                                    <span className="menu-desc">
                                        {activity.reasons[event.reason] ?? event.reason}
                                        {event.detail ? ` (${event.detail})` : ""}
                                        {event.senderHint ? ` · from ${event.senderHint}` : ""}
                                        {typeof event.ms === "number" ? ` · ${Math.round(event.ms / 100) / 10}s` : ""}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {needsKey && (
                <div className="flex flex-col gap-2">
                    <p className="settings-menu-section-title">Admin key</p>
                    <div className="menu-group p-4 flex flex-col gap-2">
                        <span className="menu-desc ml-1">
                            Registering numbers spends your Photon quota, so it needs an admin account or the
                            admin key. Kept for this browser tab only.
                        </span>
                        <Input
                            type="password"
                            value={adminKey}
                            onChange={(event) => { setAdminKey(event.target.value); writeSessionKey(event.target.value); }}
                            placeholder="APP_MARKET_ADMIN_KEY"
                        />
                    </div>
                </div>
            )}

            {message && <p className="menu-desc ml-1">{message}</p>}
        </div>
    );
}
