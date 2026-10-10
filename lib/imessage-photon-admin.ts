// lib/imessage-photon-admin.ts
// Pure helpers for the Photon / Spectrum management API ("shared users"). No network, no
// env, no storage, so both the route handler and the Settings page can import it and a
// fixture can drive it directly.
//
// How the service works (verified against a working third-party bridge's photon.js):
//   - You register YOUR phone number in the project. Photon assigns one number from its
//     shared pool (`assignedPhoneNumber`), and that is the number you TEXT from iMessage.
//   - A sender that is not registered is dropped on Photon's side with no error anywhere,
//     which is why registration status has to be surfaced explicitly.

export type PhotonSharedUser = {
    id: string;
    phoneNumber: string;
    assignedPhoneNumber: string;
};

/** E.164: "+" then a non-zero country code, 7-15 digits in total. */
export const PHONE_E164_RE = /^\+[1-9]\d{6,14}$/;

/** Accepts spaces, dashes and brackets; adds the missing "+". Returns "" for nothing usable. */
export function normalizePhoneE164(raw: unknown): string {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits ? `+${digits}` : "";
}

export function isE164(value: string): boolean {
    return PHONE_E164_RE.test(value);
}

/**
 * The list endpoint answers `{ data: { users: [...], total } }`; tolerate `{ data: [...] }`
 * too. Returns null when the shape is not recognisable, so a changed API reads as an error
 * rather than as "nobody is registered".
 */
export function parseUsersResponse(body: unknown): PhotonSharedUser[] | null {
    if (!body || typeof body !== "object") return null;
    const data = (body as { data?: unknown }).data;
    const list = Array.isArray(data)
        ? data
        : (data && typeof data === "object" ? (data as { users?: unknown }).users : undefined);
    if (!Array.isArray(list)) return null;
    return list
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            phoneNumber: typeof item.phoneNumber === "string" ? item.phoneNumber : "",
            assignedPhoneNumber: typeof item.assignedPhoneNumber === "string" ? item.assignedPhoneNumber : "",
        }));
}

/** Matches on digits only, so "+1 (555) 123-4567" finds "+15551234567". */
export function findRegisteredUser(users: PhotonSharedUser[], phone: string): PhotonSharedUser | null {
    const wanted = normalizePhoneE164(phone);
    if (!wanted) return null;
    return users.find((user) => normalizePhoneE164(user.phoneNumber) === wanted) ?? null;
}

/** A user can exist without a line yet; only a user WITH a line is usable. */
export function hasLine(user: PhotonSharedUser | null): user is PhotonSharedUser {
    return Boolean(user && user.assignedPhoneNumber);
}

/** Status codes translated into something actionable. */
export function describePhotonError(status: number, detail = ""): string {
    if (status === 401 || status === 403) {
        return "Photon rejected the credentials. Check that PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET belong together and have no stray spaces.";
    }
    if (status === 404) return "Photon could not find this project. The Project ID is probably wrong.";
    if (status === 409) return "This number is already registered with the project.";
    if (status === 400 || status === 422) return `Photon rejected the request${detail ? `: ${detail}` : "."}`;
    if (status === 429) return "Photon is rate limiting requests. Wait a moment and try again.";
    if (status === 0) return `Could not reach Photon${detail ? `: ${detail}` : "."}`;
    return `Photon answered ${status}${detail ? `: ${detail}` : "."}`;
}

export type EnrollmentStatus =
    | { state: "registered"; phoneNumber: string; assignedPhoneNumber: string }
    | { state: "registered_without_line"; phoneNumber: string }
    | { state: "not_registered"; phoneNumber: string };

export function summarizeEnrollment(users: PhotonSharedUser[], phone: string): EnrollmentStatus {
    const phoneNumber = normalizePhoneE164(phone);
    const user = findRegisteredUser(users, phoneNumber);
    if (!user) return { state: "not_registered", phoneNumber };
    if (!hasLine(user)) return { state: "registered_without_line", phoneNumber };
    return { state: "registered", phoneNumber, assignedPhoneNumber: user.assignedPhoneNumber };
}
