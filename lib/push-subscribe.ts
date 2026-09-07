// lib/push-subscribe.ts
// Client-side Web Push subscribe/unsubscribe flow. Stage 1 of Proactive
// Message 2.0 — see PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// iOS constraint (Apple platform rule, not something this code can route
// around): Web Push only works once the PWA has been added to the Home
// Screen (standalone display mode) and only on iOS 16.4+. A subscribe call
// made from a normal Safari tab will fail even though the API exists.

import { requestNotificationPermission } from "./browser-notification";

export function isPushSupported(): boolean {
    if (typeof window === "undefined") return false;
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** True once the app is running installed to the Home Screen / as a standalone app. */
export function isStandaloneDisplayMode(): boolean {
    if (typeof window === "undefined") return false;
    const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/** True on an iOS/iPadOS device — used to show the "add to Home Screen first" guidance. */
export function isIosDevice(): boolean {
    if (typeof window === "undefined") return false;
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const output = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
    return output;
}

export type PushSubscribeResult =
    | { ok: true; subscription: PushSubscriptionJSON }
    | { ok: false; reason: "unsupported" | "not_installed" | "permission_denied" | "subscribe_failed"; detail?: string };

/** Requests permission (if needed) and subscribes to push, using the given VAPID public key. */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscribeResult> {
    if (!isPushSupported()) return { ok: false, reason: "unsupported" };
    if (isIosDevice() && !isStandaloneDisplayMode()) return { ok: false, reason: "not_installed" };

    const granted = await requestNotificationPermission();
    if (!granted) return { ok: false, reason: "permission_denied" };

    try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) await existing.unsubscribe();

        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        });
        return { ok: true, subscription: subscription.toJSON() as PushSubscriptionJSON };
    } catch (err) {
        return { ok: false, reason: "subscribe_failed", detail: err instanceof Error ? err.message : String(err) };
    }
}

export async function unsubscribeFromPush(): Promise<boolean> {
    if (!isPushSupported()) return false;
    try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!existing) return true;
        return await existing.unsubscribe();
    } catch {
        return false;
    }
}

export async function getCurrentPushSubscription(): Promise<PushSubscriptionJSON | null> {
    if (!isPushSupported()) return null;
    try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        return existing ? (existing.toJSON() as PushSubscriptionJSON) : null;
    } catch {
        return null;
    }
}
