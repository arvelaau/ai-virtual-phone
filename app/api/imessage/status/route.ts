// app/api/imessage/status/route.ts
// What the iMessage webhook has actually been doing, for the Settings page. Admin-only.
//
// Returns the recent trace events plus the numbers bound in the cloud index (masked), which
// is what the webhook compares an incoming sender against. Comparing the two is usually all
// it takes to see why a message got no reply.

import { NextResponse } from "next/server";
import { isIMessageAdminAllowed } from "@/lib/server/imessage-admin-gate";
import { getIMessageSupabaseConfig, getObjectText } from "@/lib/server/imessage-supabase";
import { readTraces } from "@/lib/server/imessage-trace";
import { IMESSAGE_CLOUD_INDEX_PATH } from "@/lib/imessage-webhook-handler";
import { maskAddress, REASON_TEXT } from "@/lib/imessage-webhook-trace";
import type { IMessageCloudRuntimeIndex } from "@/lib/imessage-types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
    if (!(await isIMessageAdminAllowed(request))) {
        return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const photonEnv = {
        PHOTON_PROJECT_ID: Boolean((process.env.PHOTON_PROJECT_ID ?? "").trim()),
        PHOTON_PROJECT_SECRET: Boolean((process.env.PHOTON_PROJECT_SECRET ?? "").trim()),
        PHOTON_WEBHOOK_SECRET: Boolean((process.env.PHOTON_WEBHOOK_SECRET ?? "").trim()),
    };
    const supabase = getIMessageSupabaseConfig();
    if (!supabase) {
        return NextResponse.json({
            ok: true,
            env: { ...photonEnv, IMESSAGE_SUPABASE: false },
            events: [],
            bound: [],
            indexFound: false,
            reasons: REASON_TEXT,
        });
    }

    let indexFound = false;
    let bound: Array<{ phone: string; character: string; updatedAt: string }> = [];
    let indexUpdatedAt = "";
    let indexError = "";
    try {
        const text = await getObjectText(supabase, IMESSAGE_CLOUD_INDEX_PATH);
        if (text) {
            const index = JSON.parse(text) as IMessageCloudRuntimeIndex;
            indexFound = true;
            indexUpdatedAt = index.updatedAt ?? "";
            bound = (index.lines ?? []).map((line) => ({
                phone: maskAddress(line.phone),
                character: line.characterName,
                updatedAt: line.updatedAt,
            }));
        }
    } catch (err) {
        indexError = err instanceof Error ? err.message : "could not read the index";
    }

    return NextResponse.json({
        ok: true,
        env: { ...photonEnv, IMESSAGE_SUPABASE: true },
        indexFound,
        indexUpdatedAt,
        indexError,
        bound,
        events: await readTraces(supabase),
        reasons: REASON_TEXT,
    });
}
