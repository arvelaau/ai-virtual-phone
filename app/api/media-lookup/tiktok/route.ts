// app/api/media-lookup/tiktok/route.ts
// GET ?url=<tiktok link>&thumb=1
// Reads what a TikTok link exposes without watching it (creator, caption, hashtags, cover frame).
// Used by the chat plugin "TikTok Link Viewer". Not an open proxy: see lib/server/tiktok-lookup.ts.

import { NextResponse } from "next/server";
import { lookupTikTok } from "@/lib/server/tiktok-lookup";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
    const params = new URL(request.url).searchParams;
    const url = (params.get("url") || "").trim();
    if (!url || url.length > 2000) {
        return NextResponse.json({ ok: false, code: "bad_url", error: "Missing or oversized url." }, { status: 400 });
    }
    const result = await lookupTikTok(url, { wantThumbnail: params.get("thumb") === "1" });
    if (!result.ok) {
        const status = result.code === "bad_url" || result.code === "not_tiktok" ? 400 : result.code === "timeout" ? 504 : 502;
        return NextResponse.json(result, { status });
    }
    return NextResponse.json({
        ok: true,
        url: result.info.url,
        canonicalUrl: result.info.canonicalUrl,
        title: result.info.title,
        author: result.info.author,
        authorUrl: result.info.authorUrl,
        hashtags: result.info.hashtags,
        source: result.info.source,
        thumbnailDataUrl: result.thumbnailDataUrl ?? null,
    }, { headers: { "Cache-Control": "private, max-age=600" } });
}
