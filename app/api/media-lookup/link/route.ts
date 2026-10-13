// app/api/media-lookup/link/route.ts
// GET ?url=<link>&image=1
// Reads one supported link (TikTok video, X post) and returns the text block and, optionally,
// a picture for the model. Used by the "Social Link Viewer" chat plugin.
// Not an open proxy: only the hosts each reader allows are ever contacted.

import { NextResponse } from "next/server";
import { classifyLink, readLink } from "@/lib/server/link-readers";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
    const params = new URL(request.url).searchParams;
    const url = (params.get("url") || "").trim();
    if (!url || url.length > 2000) {
        return NextResponse.json({ ok: false, code: "bad_url", error: "Missing or oversized url." }, { status: 400 });
    }
    if (!classifyLink(url)) {
        return NextResponse.json({ ok: false, code: "unsupported", error: "That link is not from a supported site." }, { status: 400 });
    }
    const reading = await readLink(url, { wantImage: params.get("image") === "1", timeoutMs: 8000 });
    if (!reading) {
        return NextResponse.json({ ok: false, code: "unsupported", error: "That link is not from a supported site." }, { status: 400 });
    }
    return NextResponse.json({
        ok: reading.readable,
        kind: reading.kind,
        context: reading.context,
        imageDataUrl: reading.imageDataUrl ?? null,
        error: reading.error ?? null,
    }, { status: reading.readable ? 200 : 502, headers: { "Cache-Control": "private, max-age=600" } });
}
