/**
 * Persistence for the webhook's diagnostic trace (server side).
 *
 * Stored as one small JSON array in the user's own Supabase bucket, so the Settings page can
 * show what the webhook did with the last messages without anyone having to dig through
 * hosting logs. Best effort by design: a failure here must never affect message handling.
 */
import { getObjectText, putObjectText, type IMessageSupabaseConfig } from "./imessage-supabase";
import { pushTrace, type TraceEvent } from "../imessage-webhook-trace";

export const TRACE_PATH = "imessage-cloud/debug/events.json";

export async function readTraces(config: IMessageSupabaseConfig): Promise<TraceEvent[]> {
    try {
        const text = await getObjectText(config, TRACE_PATH);
        if (!text) return [];
        const parsed = JSON.parse(text) as unknown;
        return Array.isArray(parsed) ? (parsed as TraceEvent[]) : [];
    } catch {
        return [];
    }
}

export async function appendTrace(config: IMessageSupabaseConfig, event: TraceEvent): Promise<void> {
    // Also goes to the hosting log, which is where it is first looked at when it matters.
    console.log("[imessage-webhook]", JSON.stringify(event));
    try {
        const existing = await readTraces(config);
        await putObjectText(config, TRACE_PATH, JSON.stringify(pushTrace(existing, event)));
    } catch (err) {
        console.warn("[imessage-webhook] could not persist trace:", err instanceof Error ? err.message : err);
    }
}
