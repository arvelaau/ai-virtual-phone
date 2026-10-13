// lib/imessage-send-media.ts
// The delivery half of "the character sends a real photo over iMessage".
//
// The browser has generated the picture and stored it next to the job; this decides whether a
// request to deliver it is legitimate and carries it out. Pure with injected side effects (the
// storage reads/writes and the two SDK calls), so every refusal and every state change is
// driven from a fixture without Photon, Supabase or a network.

import { IMESSAGE_CLOUD_PREFIX } from "./imessage-webhook-handler";
import { inboundMessagePath } from "./imessage-webhook-core";
import {
    isExpired,
    isMediaJob,
    isTerminalStatus,
    mediaJobAudioPath,
    mediaJobImagePath,
    mediaJobPath,
    MAX_JOB_ATTEMPTS,
    photoFallbackText,
    tokensMatch,
    type IMessageMediaJob,
    type MediaJobStatus,
} from "./imessage-media-jobs";
import type { IMessageCloudStoredMessage } from "./imessage-types";

/** Largest picture the route will hand to the SDK (decoded bytes). */
export const MAX_SEND_IMAGE_BYTES = 12 * 1024 * 1024;
/** Largest clip the route will hand to the SDK. A spoken sentence or two is far below this. */
export const MAX_SEND_AUDIO_BYTES = 8 * 1024 * 1024;

const AUDIO_MIME_RE = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|wav|x-wav|wave|ogg|opus|webm|flac|x-flac)$/i;

function audioExtensionFor(mimeType: string): string {
    if (/mp4|m4a|aac/i.test(mimeType)) return "m4a";
    if (/wav|wave/i.test(mimeType)) return "wav";
    if (/ogg|opus/i.test(mimeType)) return "ogg";
    if (/webm/i.test(mimeType)) return "webm";
    if (/flac/i.test(mimeType)) return "flac";
    return "mp3";
}

/**
 * The SDK turns a "voice" into a real iMessage voice message only after converting it to m4a,
 * which needs ffmpeg on the server. When that binary is missing the error says so; that is the
 * one failure where sending the same clip as an ordinary audio attachment is the right retry.
 */
export function isFfmpegUnavailableError(err: unknown): boolean {
    const text = err instanceof Error ? err.message : String(err ?? "");
    return /ffmpeg/i.test(text) && /(unavailable|not found|ENOENT|install|PATH)/i.test(text);
}

export type VoiceDelivery = { id: string | undefined; mode: "voice_message" | "audio_file" };

/** Sends a clip as a real voice message when the server can convert it, else as an audio file. */
export async function deliverVoice(
    deps: Pick<SendMediaDeps, "sendVoice" | "sendAudioFile">,
    phone: string,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
): Promise<VoiceDelivery> {
    if (deps.sendVoice) {
        try {
            return { id: await deps.sendVoice(phone, bytes, mimeType, fileName), mode: "voice_message" };
        } catch (err) {
            if (!isFfmpegUnavailableError(err) || !deps.sendAudioFile) throw err;
        }
    }
    if (!deps.sendAudioFile) throw new Error("audio delivery is not available");
    return { id: await deps.sendAudioFile(phone, bytes, mimeType, fileName), mode: "audio_file" };
}

export type SendMediaDeps = {
    readJson<T>(path: string): Promise<T | null>;
    putJson(path: string, value: unknown): Promise<void>;
    /** The number bound to this line, or null when the line is unknown. */
    phoneForLine(lineId: string): Promise<string | null>;
    sendText(phone: string, text: string): Promise<string | undefined>;
    sendPhoto(phone: string, bytes: Uint8Array, mimeType: string, fileName: string): Promise<string | undefined>;
    /** A real iMessage voice message (needs ffmpeg unless the clip is already m4a/aac). */
    sendVoice?(phone: string, bytes: Uint8Array, mimeType: string, fileName: string): Promise<string | undefined>;
    /** The same clip as an ordinary audio attachment; the fallback when sendVoice cannot convert it. */
    sendAudioFile?(phone: string, bytes: Uint8Array, mimeType: string, fileName: string): Promise<string | undefined>;
    now(): number;
};

export type SendMediaInput = {
    lineId?: unknown;
    jobId?: unknown;
    token?: unknown;
    /** Deliver the description as text because the picture could not be made. */
    fallback?: unknown;
    /** Why the browser gave up (shown in the job, never sent anywhere). */
    reason?: unknown;
};

export type SendMediaResult = {
    ok: boolean;
    status: number;
    code: string;
    jobStatus?: MediaJobStatus;
    detail?: string;
};

function reply(status: number, code: string, jobStatus?: MediaJobStatus, detail?: string): SendMediaResult {
    return { ok: status >= 200 && status < 300, status, code, ...(jobStatus ? { jobStatus } : {}), ...(detail ? { detail } : {}) };
}

function decodeBase64(b64: string): Uint8Array {
    const clean = b64.replace(/\s+/g, "");
    // atob is available in Node 16+ and every browser
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function extensionFor(mimeType: string): string {
    if (/png/i.test(mimeType)) return "png";
    if (/webp/i.test(mimeType)) return "webp";
    if (/gif/i.test(mimeType)) return "gif";
    return "jpg";
}

export async function sendMediaJob(deps: SendMediaDeps, input: SendMediaInput): Promise<SendMediaResult> {
    const lineId = typeof input.lineId === "string" ? input.lineId.trim() : "";
    const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
    if (!lineId || !jobId || lineId.length > 200 || jobId.length > 200) return reply(400, "bad_request");

    const jobPath = mediaJobPath(IMESSAGE_CLOUD_PREFIX, lineId, jobId);
    let job: IMessageMediaJob | null = null;
    try {
        const raw = await deps.readJson<unknown>(jobPath);
        job = isMediaJob(raw) ? raw : null;
    } catch (err) {
        return reply(502, "storage_error", undefined, err instanceof Error ? err.message.slice(0, 200) : "read failed");
    }
    if (!job || job.lineId !== lineId || job.id !== jobId) return reply(404, "job_not_found");

    // Capability check BEFORE anything else is revealed: a wrong token learns nothing.
    if (!tokensMatch(job.token, input.token)) return reply(403, "bad_token");

    if (job.status === "sent" || job.status === "fallback_sent") return reply(200, "already_sent", job.status);
    if (isTerminalStatus(job.status)) return reply(409, "job_failed", job.status, job.error);

    const now = deps.now();
    if (isExpired(job, now)) {
        await deps.putJson(jobPath, { ...job, status: "failed", error: "expired", updatedAt: new Date(now).toISOString() }).catch(() => undefined);
        return reply(410, "expired", "failed");
    }

    let phone: string | null;
    try {
        phone = await deps.phoneForLine(lineId);
    } catch (err) {
        return reply(502, "storage_error", undefined, err instanceof Error ? err.message.slice(0, 200) : "index read failed");
    }
    if (!phone) return reply(404, "line_not_found");

    const stamp = new Date(now).toISOString();
    const outboundBase = {
        format: "ai-phone-imessage-cloud-message" as const,
        version: 1 as const,
        direction: "outbound" as const,
        lineId,
        characterId: job.characterId,
        sessionId: job.sessionId,
        externalId: `${job.id}_photo`,
        createdAt: stamp,
        role: "assistant" as const,
    };
    const recordPath = inboundMessagePath(IMESSAGE_CLOUD_PREFIX, lineId, outboundBase.externalId);

    // -- a message the character wrote in the app, mirrored onto iMessage --------------------
    if (job.kind === "text") {
        const text = typeof job.text === "string" ? job.text.trim() : "";
        if (!text) {
            await deps.putJson(jobPath, { ...job, status: "failed", error: "empty text", updatedAt: stamp }).catch(() => undefined);
            return reply(422, "empty_text", "failed");
        }
        let platformId: string | undefined;
        try {
            platformId = await deps.sendText(phone, text);
        } catch (err) {
            const attempts = job.attempts + 1;
            const detail = err instanceof Error ? err.message.slice(0, 200) : "send failed";
            const gaveUp = attempts >= MAX_JOB_ATTEMPTS;
            await deps.putJson(jobPath, { ...job, attempts, status: gaveUp ? "failed" : "pending", error: detail, updatedAt: stamp }).catch(() => undefined);
            return reply(502, "send_error", gaveUp ? "failed" : "pending", detail);
        }
        const textRecord: IMessageCloudStoredMessage = {
            ...outboundBase,
            externalId: `${job.id}_text`,
            content: text,
            ...(job.localMessageId ? { localMessageId: job.localMessageId } : {}),
            ...(platformId ? { platformMessageId: platformId } : {}),
        };
        await deps.putJson(inboundMessagePath(IMESSAGE_CLOUD_PREFIX, lineId, textRecord.externalId), textRecord);
        await deps.putJson(jobPath, { ...job, status: "sent", leaseUntil: undefined, error: undefined, updatedAt: stamp });
        return reply(200, "sent", "sent");
    }

    // -- a spoken note --------------------------------------------------------------------
    if (job.kind === "voice") {
        const spoken = typeof job.text === "string" ? job.text.trim() : "";
        if (!spoken) {
            await deps.putJson(jobPath, { ...job, status: "failed", error: "empty text", updatedAt: stamp }).catch(() => undefined);
            return reply(422, "empty_text", "failed");
        }
        const voiceRecordPath = inboundMessagePath(IMESSAGE_CLOUD_PREFIX, lineId, `${job.id}_voice`);
        const voiceRecord = (platformId: string | undefined): IMessageCloudStoredMessage => ({
            ...outboundBase,
            externalId: `${job.id}_voice`,
            content: spoken,
            ...(platformId ? { platformMessageId: platformId } : {}),
        });

        // The clip could not be made: the words go out as an ordinary message instead.
        if (input.fallback === true) {
            let platformId: string | undefined;
            try {
                platformId = await deps.sendText(phone, spoken);
            } catch (err) {
                return reply(502, "send_error", job.status, err instanceof Error ? err.message.slice(0, 200) : "send failed");
            }
            await deps.putJson(voiceRecordPath, voiceRecord(platformId));
            const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : undefined;
            await deps.putJson(jobPath, { ...job, status: "fallback_sent", leaseUntil: undefined, ...(reason ? { error: reason } : {}), updatedAt: stamp });
            return reply(200, "fallback_sent", "fallback_sent");
        }

        let clip: { mimeType?: string; dataBase64?: string } | null = null;
        try {
            clip = await deps.readJson<{ mimeType?: string; dataBase64?: string }>(mediaJobAudioPath(IMESSAGE_CLOUD_PREFIX, lineId, jobId));
        } catch (err) {
            return reply(502, "storage_error", job.status, err instanceof Error ? err.message.slice(0, 200) : "audio read failed");
        }
        if (!clip || typeof clip.dataBase64 !== "string" || !clip.dataBase64) return reply(409, "audio_not_ready", job.status);
        const audioMime = typeof clip.mimeType === "string" && AUDIO_MIME_RE.test(clip.mimeType.split(";")[0].trim()) ? clip.mimeType.split(";")[0].trim().toLowerCase() : "";
        if (!audioMime) return reply(415, "unsupported_audio", job.status);
        let audioBytes: Uint8Array;
        try {
            audioBytes = decodeBase64(clip.dataBase64);
        } catch {
            return reply(422, "bad_audio_data", job.status);
        }
        if (audioBytes.byteLength === 0) return reply(422, "bad_audio_data", job.status);
        if (audioBytes.byteLength > MAX_SEND_AUDIO_BYTES) return reply(413, "audio_too_large", job.status);

        let delivered: VoiceDelivery;
        try {
            delivered = await deliverVoice(deps, phone, audioBytes, audioMime, `voice.${audioExtensionFor(audioMime)}`);
        } catch (err) {
            const attempts = job.attempts + 1;
            const detail = err instanceof Error ? err.message.slice(0, 200) : "send failed";
            const gaveUp = attempts >= MAX_JOB_ATTEMPTS;
            await deps.putJson(jobPath, { ...job, attempts, status: gaveUp ? "failed" : "ready", error: detail, updatedAt: stamp }).catch(() => undefined);
            return reply(502, "send_error", gaveUp ? "failed" : "ready", detail);
        }
        await deps.putJson(voiceRecordPath, voiceRecord(delivered.id));
        await deps.putJson(jobPath, { ...job, status: "sent", leaseUntil: undefined, error: undefined, updatedAt: stamp });
        return reply(200, "sent", "sent", delivered.mode);
    }

    // -- the picture could not be made: say what it was instead --------------------------
    if (input.fallback === true) {
        const text = photoFallbackText(job.description);
        let platformId: string | undefined;
        try {
            platformId = await deps.sendText(phone, text);
        } catch (err) {
            return reply(502, "send_error", job.status, err instanceof Error ? err.message.slice(0, 200) : "send failed");
        }
        const record: IMessageCloudStoredMessage = { ...outboundBase, content: text, ...(platformId ? { platformMessageId: platformId } : {}) };
        await deps.putJson(recordPath, record);
        const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : undefined;
        await deps.putJson(jobPath, { ...job, status: "fallback_sent", leaseUntil: undefined, ...(reason ? { error: reason } : {}), updatedAt: stamp });
        return reply(200, "fallback_sent", "fallback_sent");
    }

    // -- the real picture -------------------------------------------------------------------
    const imagePath = mediaJobImagePath(IMESSAGE_CLOUD_PREFIX, lineId, jobId);
    let image: { mimeType?: string; dataBase64?: string } | null = null;
    try {
        image = await deps.readJson<{ mimeType?: string; dataBase64?: string }>(imagePath);
    } catch (err) {
        return reply(502, "storage_error", job.status, err instanceof Error ? err.message.slice(0, 200) : "image read failed");
    }
    if (!image || typeof image.dataBase64 !== "string" || !image.dataBase64) return reply(409, "image_not_ready", job.status);
    const mimeType = typeof image.mimeType === "string" && /^image\/(png|jpe?g|webp|gif)$/i.test(image.mimeType) ? image.mimeType.toLowerCase() : "";
    if (!mimeType) return reply(415, "unsupported_image", job.status);

    let bytes: Uint8Array;
    try {
        bytes = decodeBase64(image.dataBase64);
    } catch {
        return reply(422, "bad_image_data", job.status);
    }
    if (bytes.byteLength === 0) return reply(422, "bad_image_data", job.status);
    if (bytes.byteLength > MAX_SEND_IMAGE_BYTES) return reply(413, "image_too_large", job.status);

    let platformId: string | undefined;
    try {
        platformId = await deps.sendPhoto(phone, bytes, mimeType, `photo.${extensionFor(mimeType)}`);
    } catch (err) {
        const attempts = job.attempts + 1;
        const detail = err instanceof Error ? err.message.slice(0, 200) : "send failed";
        const gaveUp = attempts >= MAX_JOB_ATTEMPTS;
        await deps.putJson(jobPath, {
            ...job,
            attempts,
            status: gaveUp ? "failed" : "ready",
            error: detail,
            updatedAt: stamp,
        }).catch(() => undefined);
        return reply(502, "send_error", gaveUp ? "failed" : "ready", detail);
    }

    const record: IMessageCloudStoredMessage = {
        ...outboundBase,
        content: "",
        image: { path: imagePath, mimeType },
        ...(platformId ? { platformMessageId: platformId } : {}),
    };
    await deps.putJson(recordPath, record);
    await deps.putJson(jobPath, { ...job, status: "sent", leaseUntil: undefined, error: undefined, updatedAt: stamp });
    return reply(200, "sent", "sent");
}
