/**
 * Server-side client for the Photon / Spectrum management API.
 *
 * Credentials come from the server environment only and are never returned to the
 * browser, never logged, and never placed in a URL:
 *
 *   PHOTON_PROJECT_ID
 *   PHOTON_PROJECT_SECRET
 *
 * Auth is HTTP Basic `projectId:projectSecret`, which is just the secret re-encoded, so
 * the Authorization header is treated as a secret too (error messages below never echo it).
 */
import {
    describePhotonError,
    parseUsersResponse,
    type PhotonSharedUser,
} from "../imessage-photon-admin";

const PHOTON_BASE = "https://spectrum.photon.codes";
const REQUEST_TIMEOUT_MS = 15_000;

export type PhotonCredentials = { projectId: string; projectSecret: string };

export function getPhotonCredentials(): PhotonCredentials | null {
    const projectId = (process.env.PHOTON_PROJECT_ID ?? "").trim();
    const projectSecret = (process.env.PHOTON_PROJECT_SECRET ?? "").trim();
    if (!projectId || !projectSecret) return null;
    return { projectId, projectSecret };
}

export type PhotonResult<T> =
    | { ok: true; data: T }
    | { ok: false; status: number; error: string };

function authHeader(creds: PhotonCredentials): string {
    return `Basic ${Buffer.from(`${creds.projectId}:${creds.projectSecret}`).toString("base64")}`;
}

function usersUrl(creds: PhotonCredentials): string {
    return `${PHOTON_BASE}/projects/${encodeURIComponent(creds.projectId)}/users/`;
}

async function readDetail(res: Response): Promise<string> {
    const text = await res.text().catch(() => "");
    try {
        const body = JSON.parse(text) as { message?: unknown; error?: unknown };
        const picked = body.message ?? body.error;
        if (typeof picked === "string") return picked.slice(0, 200);
    } catch { /* not JSON */ }
    return text.slice(0, 200);
}

export async function listSharedUsers(creds: PhotonCredentials): Promise<PhotonResult<PhotonSharedUser[]>> {
    let res: Response;
    try {
        res = await fetch(usersUrl(creds), {
            headers: { Authorization: authHeader(creds) },
            cache: "no-store",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        const cause = err instanceof Error ? err.message : "network error";
        return { ok: false, status: 0, error: describePhotonError(0, cause) };
    }
    if (!res.ok) {
        return { ok: false, status: res.status, error: describePhotonError(res.status, await readDetail(res)) };
    }
    const users = parseUsersResponse(await res.json().catch(() => null));
    if (!users) {
        return { ok: false, status: res.status, error: "Photon's answer did not contain a user list. The API may have changed." };
    }
    return { ok: true, data: users };
}

export async function enrollSharedUser(
    creds: PhotonCredentials,
    phoneNumber: string,
): Promise<PhotonResult<{ assignedPhoneNumber: string; userId: string }>> {
    let res: Response;
    try {
        res = await fetch(usersUrl(creds), {
            method: "POST",
            headers: { Authorization: authHeader(creds), "Content-Type": "application/json" },
            body: JSON.stringify({ type: "shared", phoneNumber }),
            cache: "no-store",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        const cause = err instanceof Error ? err.message : "network error";
        return { ok: false, status: 0, error: describePhotonError(0, cause) };
    }
    if (!res.ok) {
        return { ok: false, status: res.status, error: describePhotonError(res.status, await readDetail(res)) };
    }
    const body = await res.json().catch(() => null) as { data?: Record<string, unknown> } & Record<string, unknown> | null;
    const data = (body?.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown> | null;
    const assigned = typeof data?.assignedPhoneNumber === "string" ? data.assignedPhoneNumber : "";
    if (!assigned) {
        return { ok: false, status: res.status, error: "Photon registered the number but returned no assigned line. The API may have changed." };
    }
    return { ok: true, data: { assignedPhoneNumber: assigned, userId: typeof data?.id === "string" ? data.id : "" } };
}
