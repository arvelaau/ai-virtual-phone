// app/api/imessage/send-media/route.ts
// Delivers a picture the character wanted to send over real iMessage.
//
// The browser (which has the image-generation settings and the character's reference image)
// generates the picture, stores it in the owner's Supabase bucket next to a "job" the webhook
// created, and then calls this route with { lineId, jobId, token }. The token lives only inside
// the job object, so only someone who can read the owner's bucket can know it.
//
// All decisions live in lib/imessage-send-media.ts; this file wires Supabase and the SDK in.
//
// Environment: PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, IMESSAGE_SUPABASE_URL,
// IMESSAGE_SUPABASE_SERVICE_ROLE_KEY (the same ones the webhook uses).

import { NextResponse } from "next/server";
import { Spectrum, attachment, voice } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import {
    IMESSAGE_CLOUD_INDEX_PATH,
} from "@/lib/imessage-webhook-handler";
import { sendMediaJob, type SendMediaDeps } from "@/lib/imessage-send-media";
import { getIMessageSupabaseConfig, getObjectText, putObjectText } from "@/lib/server/imessage-supabase";
import type { IMessageCloudRuntimeIndex } from "@/lib/imessage-types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4096;

export async function POST(request: Request) {
    const projectId = process.env.PHOTON_PROJECT_ID?.trim();
    const projectSecret = process.env.PHOTON_PROJECT_SECRET?.trim();
    if (!projectId || !projectSecret) {
        return NextResponse.json({ ok: false, code: "missing_photon_env" }, { status: 503 });
    }
    const supabase = getIMessageSupabaseConfig();
    if (!supabase) {
        return NextResponse.json({ ok: false, code: "missing_supabase_env" }, { status: 503 });
    }

    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
        return NextResponse.json({ ok: false, code: "bad_request" }, { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
        const parsed = JSON.parse(text);
        body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
        return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
    }

    // The SDK client is created lazily: refusals (bad token, unknown job, already sent) never
    // open a connection to Photon.
    let spectrum: Awaited<ReturnType<typeof Spectrum>> | null = null;
    const spaces = new Map<string, { send: (content: unknown) => Promise<unknown> }>();
    async function spaceFor(phone: string) {
        if (!spectrum) {
            spectrum = await Spectrum({ projectId: projectId!, projectSecret: projectSecret!, providers: [imessage.config()] });
        }
        let space = spaces.get(phone);
        if (!space) {
            const im = imessage(spectrum as never) as unknown as {
                space: { create(users: string): Promise<{ send: (content: unknown) => Promise<unknown> }> };
            };
            space = await im.space.create(phone);
            spaces.set(phone, space);
        }
        return space;
    }
    const idOf = (sent: unknown): string | undefined => {
        const first = Array.isArray(sent) ? sent[0] : sent;
        const id = (first as { id?: unknown } | undefined)?.id;
        return typeof id === "string" ? id : undefined;
    };

    const deps: SendMediaDeps = {
        readJson: async <T,>(path: string) => {
            const raw = await getObjectText(supabase, path);
            if (!raw) return null;
            try {
                return JSON.parse(raw) as T;
            } catch {
                return null;
            }
        },
        putJson: (path, value) => putObjectText(supabase, path, JSON.stringify(value)),
        phoneForLine: async (lineId) => {
            const raw = await getObjectText(supabase, IMESSAGE_CLOUD_INDEX_PATH);
            if (!raw) return null;
            try {
                const index = JSON.parse(raw) as IMessageCloudRuntimeIndex;
                return index.lines?.find((line) => line.lineId === lineId)?.phone ?? null;
            } catch {
                return null;
            }
        },
        sendText: async (phone, message) => idOf(await (await spaceFor(phone)).send(message)),
        sendPhoto: async (phone, bytes, mimeType, fileName) =>
            idOf(await (await spaceFor(phone)).send(attachment(Buffer.from(bytes), { mimeType, name: fileName }))),
        sendVoice: async (phone, bytes, mimeType, fileName) =>
            idOf(await (await spaceFor(phone)).send(voice(Buffer.from(bytes), { mimeType, name: fileName }))),
        sendAudioFile: async (phone, bytes, mimeType, fileName) =>
            idOf(await (await spaceFor(phone)).send(attachment(Buffer.from(bytes), { mimeType, name: fileName }))),
        now: () => Date.now(),
    };

    try {
        const result = await sendMediaJob(deps, body);
        return NextResponse.json(
            { ok: result.ok, code: result.code, status: result.jobStatus ?? null, detail: result.detail ?? null },
            { status: result.status },
        );
    } finally {
        if (spectrum) {
            try { await (spectrum as { stop(): Promise<void> }).stop(); } catch { /* ignore */ }
        }
    }
}
