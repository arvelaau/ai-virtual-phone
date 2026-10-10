// app/api/imessage/webhook/route.ts
// Receives real iMessages from Photon / Spectrum Cloud, answers in character, and
// writes the exchange back to the user's Supabase so the browser can pull it into Chat.
//
// 1:1 only. A message from a number that is not bound to a character is ignored.
//
// Environment:
//   PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET   Spectrum Cloud credentials
//   PHOTON_WEBHOOK_SECRET                      per-webhook signing secret (HMAC)
//   IMESSAGE_SUPABASE_URL, IMESSAGE_SUPABASE_SERVICE_ROLE_KEY
//
// Delivery is at-least-once, so inbound messages are deduped on their Spectrum id by
// checking whether the stored record already exists before generating anything.

import { NextResponse } from "next/server";
import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { buildProviderRequest, parseProviderResponse, toLlmRequestMessages } from "@/lib/llm-provider-adapter";
import {
    findLineForSender,
    inboundMessagePath,
    messagesAfterSnapshot,
    buildPromptFromTemplate,
    modelOutputToBubbles,
} from "@/lib/imessage-webhook-core";
import {
    getIMessageSupabaseConfig,
    getObjectText,
    listRecentObjects,
    putObjectText,
    type IMessageSupabaseConfig,
} from "@/lib/server/imessage-supabase";
import type {
    IMessageCloudRuntimeIndex,
    IMessageCloudRuntimeSnapshot,
    IMessageCloudStoredMessage,
} from "@/lib/imessage-types";

export const runtime = "nodejs";
export const maxDuration = 60;

const PREFIX = "imessage-cloud";
const INDEX_PATH = `${PREFIX}/index.json`;
const HISTORY_LIMIT = 20;
const LLM_TIMEOUT_MS = 45_000;

function safePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function readJson<T>(config: IMessageSupabaseConfig, path: string): Promise<T | null> {
    const text = await getObjectText(config, path);
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

async function loadRecentStored(
    config: IMessageSupabaseConfig,
    lineId: string,
): Promise<IMessageCloudStoredMessage[]> {
    const prefix = `${PREFIX}/messages/${safePart(lineId)}`;
    const objects = await listRecentObjects(config, prefix, HISTORY_LIMIT);
    const loaded = await Promise.all(
        objects.map((item) => readJson<IMessageCloudStoredMessage>(config, `${prefix}/${item.name}`)),
    );
    return loaded.filter(
        (item): item is IMessageCloudStoredMessage =>
            Boolean(item) && item!.format === "ai-phone-imessage-cloud-message" && item!.lineId === lineId,
    );
}

async function generateReply(snapshot: IMessageCloudRuntimeSnapshot, inboundText: string, recent: IMessageCloudStoredMessage[]) {
    const since = messagesAfterSnapshot(recent, snapshot.createdAt, HISTORY_LIMIT);
    const messages = buildPromptFromTemplate(snapshot.promptTemplate, since, inboundText);
    const request = buildProviderRequest(snapshot.apiConfig, snapshot.preset, toLlmRequestMessages(messages));
    const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`LLM request failed (${response.status}).`);
    return parseProviderResponse(request.providerKind, await response.json()).content;
}

export async function POST(request: Request) {
    const projectId = (process.env.PHOTON_PROJECT_ID ?? "").trim();
    const projectSecret = (process.env.PHOTON_PROJECT_SECRET ?? "").trim();
    const webhookSecret = (process.env.PHOTON_WEBHOOK_SECRET ?? "").trim();
    const supabase = getIMessageSupabaseConfig();

    if (!projectId || !projectSecret || !webhookSecret) {
        return NextResponse.json({ error: "missing_photon_env" }, { status: 503 });
    }
    if (!supabase) {
        return NextResponse.json({ error: "missing_supabase_env" }, { status: 503 });
    }

    const spectrum = await Spectrum({
        projectId,
        projectSecret,
        webhookSecret,
        providers: [imessage.config()],
    });

    // The SDK runs the handler fire-and-forget AFTER it has produced the HTTP response,
    // and a serverless function may be frozen once we return. So we hold the handler's
    // promise and await it ourselves before leaving.
    let handlerStarted = false;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => { finish = resolve; });

    try {
        const response = await spectrum.webhook(request, async (space, message) => {
            handlerStarted = true;
            try {
                if (message.direction !== "inbound") return;
                const content = message.content as { type?: string; text?: string };
                if (content.type !== "text" || !content.text?.trim()) return;

                const index = await readJson<IMessageCloudRuntimeIndex>(supabase, INDEX_PATH);
                if (!index) return;
                const target = findLineForSender(index, message.sender?.id ?? "");
                if (!target) return; // not a bound number -> stay silent

                const inboundPath = inboundMessagePath(PREFIX, target.lineId, message.id);
                if (await getObjectText(supabase, inboundPath)) return; // retry of a delivery we already handled

                const snapshot = await readJson<IMessageCloudRuntimeSnapshot>(supabase, target.path);
                if (!snapshot || !snapshot.line.enabled) return;

                const recent = await loadRecentStored(supabase, target.lineId);
                const now = new Date().toISOString();
                const inbound: IMessageCloudStoredMessage = {
                    format: "ai-phone-imessage-cloud-message",
                    version: 1,
                    direction: "inbound",
                    lineId: target.lineId,
                    characterId: target.characterId,
                    sessionId: target.sessionId,
                    externalId: message.id,
                    createdAt: now,
                    role: "user",
                    content: content.text,
                };
                // Written BEFORE generating, so a retry that arrives mid-generation is deduped too.
                await putObjectText(supabase, inboundPath, JSON.stringify(inbound));

                const raw = await generateReply(snapshot, content.text, recent);
                const bubbles = modelOutputToBubbles(raw);
                for (let i = 0; i < bubbles.length; i += 1) {
                    await space.send(bubbles[i]);
                    const outbound: IMessageCloudStoredMessage = {
                        ...inbound,
                        direction: "outbound",
                        externalId: `${message.id}_reply_${i}`,
                        // +i ms keeps the bubbles ordered when the browser sorts by createdAt
                        createdAt: new Date(Date.now() + i).toISOString(),
                        role: "assistant",
                        content: bubbles[i],
                    };
                    await putObjectText(
                        supabase,
                        inboundMessagePath(PREFIX, target.lineId, outbound.externalId),
                        JSON.stringify(outbound),
                    );
                }
            } catch (err) {
                console.error("[imessage-webhook] handler failed:", err instanceof Error ? err.message : err);
            } finally {
                finish();
            }
        });

        // Give the SDK one tick to dispatch the handler, then wait for it if it started.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (handlerStarted) await done;
        return response;
    } finally {
        await spectrum.stop().catch(() => undefined);
    }
}

export async function GET() {
    return NextResponse.json({
        ok: true,
        configured: Boolean(
            process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET &&
            process.env.PHOTON_WEBHOOK_SECRET && getIMessageSupabaseConfig(),
        ),
    });
}
