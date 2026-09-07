// app/api/proactive-relay/route.ts
// Server-side relay for calling the deployed Proactive Message 2.0 Worker.
// See PROACTIVE-MESSAGE-2.0-PLAN.md at the repo root.
//
// Why this exists: calling the Worker directly from the browser (fetch()
// from vercel.app to *.workers.dev) is what every earlier stage of this
// feature did, and it works fine from most networks/devices — verified
// repeatedly via curl and via this project's own Node fixtures, including
// after two rounds of fixes (missing CORS headers, then the Authorization
// header specifically). On at least one real device every such call still
// failed at the browser fetch() layer itself (a bare network-level failure,
// not a readable HTTP error), while the exact same Worker answered a plain
// top-level navigation (e.g. /health) instantly on that same device — and
// while every OTHER cross-origin call this app makes already goes through a
// server relay (see app/api/cloudflare-deploy/route.ts) and has never once
// shown this symptom. Routing runtime Worker calls through our own
// first-party origin the same way removes the entire class of failure,
// whatever its exact browser/network-level cause on that device — a Node
// server has no CORS or browser-privacy-heuristic concerns at all.
//
// The Worker's own X-Client-Token stays exactly as sensitive as it already
// was: it lives only in the browser's local storage same as before, and
// this route holds no state of its own — it's forwarded on every call and
// never persisted here.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

function isAllowedWorkerUrl(raw: unknown): raw is string {
    if (typeof raw !== "string") return false;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    // Deliberately an allowlist (not a denylist like the general-purpose
    // tool-proxy route) — this relay only ever needs to reach a Worker this
    // same app deployed, so the valid shape is narrow and known.
    return url.protocol === "https:" && url.hostname.endsWith(".workers.dev");
}

export async function POST(request: Request) {
    let payload: { workerUrl?: unknown; accessToken?: unknown; path?: unknown; method?: unknown; body?: unknown };
    try {
        payload = await request.json();
    } catch {
        return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const { workerUrl, accessToken, path, method, body } = payload;
    if (!isAllowedWorkerUrl(workerUrl)) {
        return NextResponse.json({ error: "invalid_worker_url" }, { status: 400 });
    }
    if (typeof path !== "string" || !path.startsWith("/")) {
        return NextResponse.json({ error: "invalid_path" }, { status: 400 });
    }
    const httpMethod = method === "POST" ? "POST" : "GET";
    // The client always sends an already-JSON.stringify()'d body (or none) —
    // passed through verbatim rather than re-parsed/re-stringified.
    const rawBody = typeof body === "string" ? body : undefined;

    try {
        const res = await fetch(`${workerUrl}${path}`, {
            method: httpMethod,
            headers: {
                "X-Client-Token": typeof accessToken === "string" ? accessToken : "",
                ...(rawBody !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: rawBody,
        });
        const data = await res.json().catch(() => ({}));
        return NextResponse.json(data, { status: res.status });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "worker_unreachable" },
            { status: 502 },
        );
    }
}
