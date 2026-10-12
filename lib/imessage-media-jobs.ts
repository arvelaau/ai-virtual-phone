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
    kind: "photo";
    lineId: string;
    characterId: string;
    sessionId: string;
    /** What to draw. The same wording the character used in [Photo:...]. */
    description: string;
    /** Use the character's reference image (a selfie) or not (a scene). */
    withRef: boolean;
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
export const MAX_PHOTOS_PER_REPLY = 2;

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

export function isMediaJob(value: unknown): value is IMessageMediaJob {
    if (!value || typeof value !== "object") return false;
    const v = value as Partial<IMessageMediaJob>;
    return v.format === IMESSAGE_MEDIA_JOB_FORMAT
        && typeof v.id === "string" && typeof v.lineId === "string"
        && typeof v.token === "string" && typeof v.status === "string"
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
            if (job.kind !== "photo" || isTerminalStatus(job.status)) return false;
            if (jobAgeMs(job, now) > JOB_MAX_AGE_MS) return false;
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
    return !isTerminalStatus(job.status) && jobAgeMs(job, now) > JOB_MAX_AGE_MS;
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
