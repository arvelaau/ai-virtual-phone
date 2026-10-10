/**
 * Shared access gate for the iMessage management routes (enroll, status).
 *
 * They use the owner's Photon credentials or expose their webhook diagnostics, so they are
 * limited to an admin account, the shared admin key, or a self-hosted instance.
 */
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { getModeratorContext } from "@/lib/server/admin-auth";

export async function isIMessageAdminAllowed(request: Request): Promise<boolean> {
    if (isSelfHostedModeEnabled()) return true;
    return Boolean(await getModeratorContext(request).catch(() => null));
}
