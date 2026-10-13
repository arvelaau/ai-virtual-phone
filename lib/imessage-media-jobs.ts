// lib/imessage-media-jobs.ts
// Photos the character wants to send over real iMessage.
//
// Why a queue: the webhook runs on a short-lived server, but the image-generation settings,
// the character's reference image and the generation pipeline all live in the BROWSER. So the
// webhook only records what the character wanted to send (a "job"), the browser that has the
// app open generates the picture, uploads it, and asks a small server route to deliver it.
//
//   webhook   -> writes  imessage-cloud/outbox/<line>/<job>.json   (status "pending")
//   browser   -> generates, writes imessage-cloud/media/<line>/<job>.json, POSTs send-media
//   send-media-> verifies the job's token, sends the attachment, marks the job "sent"
//
// Pure module: paths, record shape and the "which jobs may run now" decision. Nothing here
// touches storage, the network or the SDK, so each rule can be driven from a fixture.

export const IMESSAGE_MEDIA_JOB_FORMAT = "ai-phone-imessage-media-job" as const;

export type MediaJobStatus =
    | "pending"        // queued by the webhook, nobody has picked it up
    | "generating"     // a browser is working on it (see leaseUntil)
    | "ready"          // the picture is uploaded; only the delivery call is missing
    | "sent"           // delivered as a real attachment
    | "fallback_sent"  // generation failed, the description went out as text instead
    | "failed";        // gave up; nothing was delivered

export type IMessageMediaJob = {
    format: typeof IMESSAGE_MEDIA_JOB_FORMAT;
    version: 1;
    id: string;
    kind: "photo" | "text" | "voice";
    lineId: string;
    characterId: string;
    sessionId: string;
    /** photo: what to draw (the wording the character used in [Photo:...]). text: unused. */
    description: string;
    /** photo: use the character's reference image (a selfie) or not (a scene). */
    withRef: boolean;
    /**
     * text: the message to deliver, exactly as it appears in the local chat.
     * voice: the words to speak (also what goes out as plain text if speech cannot be made).
     */
    text?: string;
    /** text: id of the local chat message this mirrors (so the pull never imports it twice). */
    localMessageId?: string;
    /**
     * Capability token. Only someone who can READ the owner's storage bucket can learn it, so
     * possessing it proves the caller of send-media is the owner's own app, not a stranger who
     * guessed a job id.
     */
    token: string;
    status: MediaJobStatus;
    attempts: number;
    /** Epoch ms until which a "generating" claim is honoured; a crashed tab stops blocking after that. */
    leaseUntil?: number;
    createdAt: string;
    updatedAt: string;
    error?: string;
};

export const MAX_JOB_ATTEMPTS = 3;
/** How long one browser may hold a job. Image models are slow (minutes), so this is generous. */
export const JOB_LEASE_MS = 10 * 60_000;
/** A job older than this is not worth delivering any more ("here's the photo" two days late). */
export const JOB_MAX_AGE_MS = 48 * 3600_000;
/**
 * A mirrored text is a moment-in-time remark ("you still up?"); delivered hours late it is
 * wrong, so it expires much sooner than a photo.
 */
export const TEXT_JOB_MAX_AGE_MS = 30 * 60_000;
/** A voice note is a reply to something said just now; hours later it is out of place. */
export const VOICE_JOB_MAX_AGE_MS = 2 * 3600_000;

export function maxAgeFor(job: Pick<IMessageMediaJob, "kind">): number {
    if (job.kind === "text") return TEXT_JOB_MAX_AGE_MS;
    if (job.kind === "voice") return VOICE_JOB_MAX_AGE_MS;
    return JOB_MAX_AGE_MS;
}
export const MAX_PHOTOS_PER_REPLY = 2;
/** One spoken clip per reply: a second one is almost always the model repeating itself. */
export const MAX_VOICES_PER_REPLY = 1;
/** Longest text that is synthesized; a voice note is a sentence or two, not an essay. */
export const MAX_VOICE_TEXT_CHARS = 600;

const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, "_");

export function mediaJobPath(prefix: string, lineId: string, jobId: string): string {
    return `${prefix}/outbox/${safe(lineId)}/${safe(jobId)}.json`;
}

export function mediaJobPrefix(prefix: string, lineId: string): string {
    return `${prefix}/outbox/${safe(lineId)}/`;
}

/** Where the generated picture is stored: same JSON shape the inbound-photo import already reads. */
export function mediaJobImagePath(prefix: string, lineId: string, jobId: string): string {
    return `${prefix}/media/${safe(lineId)}/job_${safe(jobId)}.json`;
}

/** Where the synthesized clip is stored: { mimeType, dataBase64 }, like the picture. */
export function mediaJobAudioPath(prefix: string, lineId: string, jobId: string): string {
    return `${prefix}/media/${safe(lineId)}/audio_${safe(jobId)}.json`;
}

export function buildPhotoJob(input: {
    id: string;
    token: string;
    lineId: string;
    characterId: string;
    sessionId: string;
    description: string;
    withRef: boolean;
    now: number;
}): IMessageMediaJob {
    const at = new Date(input.now).toISOString();
    return {
        format: IMESSAGE_MEDIA_JOB_FORMAT,
        version: 1,
        id: input.id,
        kind: "photo",
        lineId: input.lineId,
        characterId: input.characterId,
        sessionId: input.sessionId,
        description: input.description,
        withRef: input.withRef,
        token: input.token,
        status: "pending",
        attempts: 0,
        createdAt: at,
        updatedAt: at,
    };
}

/** A text message the character sent in the app, to be mirrored onto iMessage. */
export function buildTextJob(input: {
    id: string;
    token: string;
    lineId: string;
    characterId: string;
    sessionId: string;
    text: string;
    localMessageId: string;
    now: number;
}): IMessageMediaJob {
    const at = new Date(input.now).toISOString();
    return {
        format: IMESSAGE_MEDIA_JOB_FORMAT,
        version: 1,
        id: input.id,
        kind: "text",
        lineId: input.lineId,
        characterId: input.characterId,
        sessionId: input.sessionId,
        description: "",
        withRef: false,
        text: input.text,
        localMessageId: input.localMessageId,
        token: input.token,
        status: "pending",
        attempts: 0,
        createdAt: at,
        updatedAt: at,
    };
}

/** A spoken note the character wants to send; the browser synthesizes it (its voice settings live there). */
export function buildVoiceJob(input: {
    id: string;
    token: string;
    lineId: string;
    characterId: string;
    sessionId: string;
    text: string;
    now: number;
}): IMessageMediaJob {
    const at = new Date(input.now).toISOString();
    return {
        format: IMESSAGE_MEDIA_JOB_FORMAT,
        version: 1,
        id: input.id,
        kind: "voice",
        lineId: input.lineId,
        characterId: input.characterId,
        sessionId: input.sessionId,
        description: "",
        withRef: false,
        text: input.text.replace(/\s+/g, " ").trim().slice(0, MAX_VOICE_TEXT_CHARS),
        token: input.token,
        status: "pending",
        attempts: 0,
        createdAt: at,
        updatedAt: at,
    };
}

export function isMediaJob(value: unknown): value is IMessageMediaJob {
    if (!value || typeof value !== "object") return false;
    const v = value as Partial<IMessageMediaJob>;
    return v.format === IMESSAGE_MEDIA_JOB_FORMAT
        && typeof v.id === "string" && typeof v.lineId === "string"
        && typeof v.token === "string" && typeof v.status === "string"
        && (v.kind === "photo" || v.kind === "text" || v.kind === "voice")
        && typeof v.description === "string";
}

export function isTerminalStatus(status: MediaJobStatus): boolean {
    return status === "sent" || status === "fallback_sent" || status === "failed";
}

export function jobAgeMs(job: IMessageMediaJob, now: number): number {
    const created = Date.parse(job.createdAt);
    return Number.isFinite(created) ? now - created : 0;
}

/**
 * Which jobs a browser may work on right now, oldest first.
 *  - "pending" jobs;
 *  - "generating" jobs whose lease ran out (the tab that held them is gone), while attempts remain;
 *  - "ready" jobs (the picture exists; only delivery is missing).
 * Terminal jobs and jobs older than JOB_MAX_AGE_MS are never returned.
 */
export function selectRunnableJobs(jobs: IMessageMediaJob[], now: number, max = 1): IMessageMediaJob[] {
    return jobs
        .filter((job) => {
            if (isTerminalStatus(job.status)) return false;
            if (jobAgeMs(job, now) > maxAgeFor(job)) return false;
            if (job.status === "ready") return true;
            if (job.attempts >= MAX_JOB_ATTEMPTS) return false;
            if (job.status === "pending") return true;
            if (job.status === "generating") return (job.leaseUntil ?? 0) < now;
            return false;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, Math.max(0, max));
}

/** Jobs that are stale enough that nobody should ever deliver them (and no longer runnable). */
export function isExpired(job: IMessageMediaJob, now: number): boolean {
    return !isTerminalStatus(job.status) && jobAgeMs(job, now) > maxAgeFor(job);
}

/**
 * Constant-time token comparison. Hand-written rather than node:crypto so this module can
 * also be bundled for the browser.
 */
export function tokensMatch(expected: string, given: unknown): boolean {
    if (typeof given !== "string" || given.length === 0 || expected.length === 0) return false;
    if (expected.length !== given.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    return diff === 0;
}
/** The text that goes out instead when the picture cannot be produced. */
export function photoFallbackText(description: string): string {
    const text = description.replace(/\s+/g, " ").trim();
    return text ? `📷 ${text}` : "📷";
}
