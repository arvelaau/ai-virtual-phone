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
// Shape of one delivery:
//   1. verify Photon's signature synchronously, so a bad secret is a visible 401;
//   2. acknowledge with 200 straight away, so Photon never times out on a slow model call
//      and retries;
//   3. do the actual work inside `after()`, which a serverless host keeps alive until it
//      finishes. The Spectrum SDK itself dispatches its handler fire-and-forget AFTER it has
//      produced its response, so without this the function could be frozen mid-reply.
//
// Every delivery ends in exactly one trace event (lib/imessage-webhook-trace.ts) that the
// Settings page can read back, because on a serverless host a silent non-reply is otherwise
// impossible to diagnose.

import { after, NextResponse } from "next/server";
import { Spectrum } from "@spectrum-ts/core";
import { verifySpectrumSignature } from "@spectrum-ts/core/webhook";
import { imessage } from "@spectrum-ts/imessage";
import { buildProviderRequest, parseProviderResponse, toLlmRequestMessages } from "@/lib/llm-provider-adapter";
import {
    describeModelTimeout,
    hostOf,
    iterateBody,
    newStreamProgress,
    readStreamedReply,
} from "@/lib/imessage-llm-stream";
import {
    buildPromptFromTemplate,
    messagesAfterSnapshot,
} from "@/lib/imessage-webhook-core";
import {
    handleInboundMessage,
    IMESSAGE_CLOUD_PREFIX,
    type HandlerDeps,
} from "@/lib/imessage-webhook-handler";
import { traceEvent, type TraceEvent } from "@/lib/imessage-webhook-trace";
import {
    getIMessageSupabaseConfig,
    getObjectText,
    listRecentObjects,
    putObjectText,
    type IMessageSupabaseConfig,
} from "@/lib/server/imessage-supabase";
import { appendTrace } from "@/lib/server/imessage-trace";
import { readInboundContent } from "@/lib/imessage-content";
import type { IMessageCloudRuntimeSnapshot, IMessageCloudStoredMessage } from "@/lib/imessage-types";

export const runtime = "nodejs";
export const maxDuration = 300;

const HISTORY_LIMIT = 20;
/**
 * The whole delivery has to fit in maxDuration (300 s, the longest the platform's plans share).
 * Spectrum start-up, Supabase reads and the iMessage send need a few seconds, so the model gets
 * the rest.
 */
const LLM_DEADLINE_MS = 280_000;
/** How long to wait for the SDK to hand over a message before calling it "never delivered". */
const SDK_DELIVERY_WAIT_MS = 10_000;

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
    const prefix = `${IMESSAGE_CLOUD_PREFIX}/messages/${safePart(lineId)}`;
    const objects = await listRecentObjects(config, prefix, HISTORY_LIMIT);
    const loaded = await Promise.all(
        objects.map((item) => readJson<IMessageCloudStoredMessage>(config, `${prefix}/${item.name}`)),
    );
    return loaded.filter(
        (item): item is IMessageCloudStoredMessage =>
            Boolean(item) && item!.format === "ai-phone-imessage-cloud-message" && item!.lineId === lineId,
    );
}

async function generateReply(
    snapshot: IMessageCloudRuntimeSnapshot,
    inboundText: string,
    recent: IMessageCloudStoredMessage[],
): Promise<{ content: string; note: string }> {
    const since = messagesAfterSnapshot(recent, snapshot.createdAt, HISTORY_LIMIT);
    const messages = buildPromptFromTemplate(snapshot.promptTemplate, since, inboundText);
    // Streamed, like the Chat app: a thinking model behind a relay is silent for a long time,
    // and a single buffered request is what such relays cut off.
    const request = buildProviderRequest(snapshot.apiConfig, snapshot.preset, toLlmRequestMessages(messages), { stream: true });
    const host = hostOf(request.url);
    const model = snapshot.apiConfig.defaultModel ?? "";
    const promptChars = JSON.stringify(request.body).length;
    const progress = newStreamProgress();
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), LLM_DEADLINE_MS);

    const timeoutError = () => new Error(
        describeModelTimeout({ host, model, deadlineMs: LLM_DEADLINE_MS, progress, promptChars }),
    );

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const snippet = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
            throw new Error(`${host} answered ${response.status}${snippet ? `: ${snippet}` : ""}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        let content: string;
        if (!response.body || !contentType.includes("text/event-stream")) {
            // The endpoint ignored stream:true and answered with a plain JSON body.
            content = parseProviderResponse(request.providerKind, await response.json()).content;
        } else {
            content = await readStreamedReply(iterateBody(response.body), request.providerKind, progress);
        }

        const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
        const first = progress.firstByteMs === null ? "" : `, first byte ${Math.round(progress.firstByteMs / 100) / 10}s`;
        return { content, note: `${host} ${seconds}s${first}` };
    } catch (err) {
        if (controller.signal.aborted) throw timeoutError();
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function headerRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
}

type Delivery = {
    url: string;
    headers: Headers;
    bodyBytes: Uint8Array;
    projectId: string;
    projectSecret: string;
    webhookSecret: string;
    supabase: IMessageSupabaseConfig;
};

async function processDelivery(d: Delivery): Promise<TraceEvent> {
    const startedAt = Date.now();
    const spectrum = await Spectrum({
        projectId: d.projectId,
        projectSecret: d.projectSecret,
        webhookSecret: d.webhookSecret,
        providers: [imessage.config()],
    });

    let signalStarted: () => void = () => {};
    let signalDone: () => void = () => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const done = new Promise<void>((resolve) => { signalDone = resolve; });
    let outcome: TraceEvent | null = null;

    try {
        const replay = new Request(d.url, { method: "POST", headers: d.headers, body: d.bodyBytes as unknown as BodyInit });
        const response = await spectrum.webhook(replay, async (space, message) => {
            signalStarted();
            try {
                const inboundContent = readInboundContent(message.content);
                const deps: HandlerDeps = {
                    readJson: (path) => readJson(d.supabase, path),
                    putJson: (path, value) => putObjectText(d.supabase, path, JSON.stringify(value)),
                    listRecentStored: (lineId) => loadRecentStored(d.supabase, lineId),
                    generate: generateReply,
                    send: async (text, replyToId) => {
                        const idOf = (sent: unknown): string | undefined => {
                            const first = Array.isArray(sent) ? sent[0] : sent;
                            const id = (first as { id?: unknown } | undefined)?.id;
                            return typeof id === "string" ? id : undefined;
                        };
                        if (replyToId) {
                            try {
                                const target = replyToId === message.id
                                    ? message
                                    : await (space as unknown as { getMessage(id: string): Promise<typeof message | undefined> }).getMessage(replyToId);
                                if (target) return idOf(await target.reply(text));
                            } catch {
                                // fall through to a plain message rather than lose the bubble
                            }
                        }
                        return idOf(await space.send(text));
                    },
                    now: () => Date.now(),
                };
                outcome = await handleInboundMessage(deps, {
                    messageId: message.id,
                    senderId: message.sender?.id ?? "",
                    spaceId: (space as { id?: string }).id ?? "",
                    direction: message.direction,
                    contentType: inboundContent.kind === "text" ? "text" : inboundContent.type,
                    text: inboundContent.kind === "text" ? inboundContent.text : "",
                    quote: inboundContent.kind === "text" ? inboundContent.quote : undefined,
                });
            } catch (err) {
                outcome = traceEvent("error", "handler_error", {
                    detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
                });
            } finally {
                signalDone();
            }
        });

        if (!response.ok) {
            outcome = traceEvent("rejected", "signature_rejected", { detail: `the SDK answered ${response.status}` });
        } else {
            const delivered = await Promise.race([
                started.then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SDK_DELIVERY_WAIT_MS)),
            ]);
            if (delivered) await done;
            else outcome = traceEvent("error", "sdk_never_delivered", { detail: `no message within ${SDK_DELIVERY_WAIT_MS / 1000}s` });
        }
    } catch (err) {
        outcome = traceEvent("error", "handler_error", {
            detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
    } finally {
        await spectrum.stop().catch(() => undefined);
    }

    const final = outcome ?? traceEvent("error", "handler_error", { detail: "no outcome was recorded" });
    return { ...final, ms: final.ms ?? Date.now() - startedAt };
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

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const headers = headerRecord(request.headers);

    // 1. Signature, synchronously: a wrong PHOTON_WEBHOOK_SECRET must be a visible 401.
    const verification = await verifySpectrumSignature({ headers, rawBody: bodyBytes, secret: webhookSecret });
    if (!verification.ok) {
        await appendTrace(supabase, traceEvent("rejected", "signature_rejected", { detail: verification.reason }));
        return NextResponse.json(
            { error: "signature", reason: verification.reason },
            { status: verification.reason === "missing-headers" ? 400 : 401 },
        );
    }

    let envelope: { event?: unknown; message?: { id?: unknown; content?: { type?: unknown } } } | null = null;
    try {
        envelope = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
        await appendTrace(supabase, traceEvent("rejected", "malformed_payload"));
        return NextResponse.json({ error: "malformed_payload" }, { status: 400 });
    }
    if (!envelope?.message || typeof envelope.message.id !== "string") {
        await appendTrace(supabase, traceEvent("ignored", "no_message", { detail: `event "${String(envelope?.event ?? "")}"` }));
        return NextResponse.json({ ok: true });
    }

    // 2 + 3. Acknowledge now; do the work after the response, kept alive by the host.
    const delivery: Delivery = {
        url: request.url,
        headers: new Headers(request.headers),
        bodyBytes,
        projectId,
        projectSecret,
        webhookSecret,
        supabase,
    };
    after(async () => {
        try {
            await appendTrace(supabase, await processDelivery(delivery));
        } catch (err) {
            await appendTrace(supabase, traceEvent("error", "handler_error", {
                detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
            }));
        }
    });
    return NextResponse.json({ ok: true });
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

