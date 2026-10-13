// lib/server/link-readers.ts
// One place that knows how to turn the links in a message into text (and a picture) the
// character can use. Currently TikTok and X posts; adding another site means adding a reader
// here, not touching the webhook or the plugin.

import { extractTikTokUrls, formatTikTokContext } from "../tiktok-link";
import { extractXStatusUrls, formatXContext } from "../x-link";
import { lookupTikTok, type TikTokLookupResult } from "./tiktok-lookup";
import { lookupXPost, type XLookupResult } from "./x-lookup";

export type LinkKind = "tiktok" | "x";

export type LinkReading = {
    url: string;
    kind: LinkKind;
    readable: boolean;
    /** The block that goes into the prompt, whether the link was readable or not. */
    context: string;
    imageDataUrl?: string;
    error?: string;
};

export type LinkReaderLookups = {
    tiktok?: (url: string, options: { wantThumbnail: boolean; timeoutMs: number }) => Promise<TikTokLookupResult>;
    x?: (url: string, options: { wantImage: boolean; timeoutMs: number }) => Promise<XLookupResult>;
};

/** Which reader (if any) owns this link. */
export function classifyLink(url: string): LinkKind | null {
    if (extractTikTokUrls(url, 1).length > 0) return "tiktok";
    if (extractXStatusUrls(url, 1).length > 0) return "x";
    return null;
}

export async function readLink(
    url: string,
    options: { wantImage: boolean; timeoutMs?: number; lookups?: LinkReaderLookups },
): Promise<LinkReading | null> {
    const kind = classifyLink(url);
    if (!kind) return null;
    const timeoutMs = options.timeoutMs ?? 8000;
    try {
        if (kind === "tiktok") {
            const run = options.lookups?.tiktok ?? ((u, o) => lookupTikTok(u, { wantThumbnail: o.wantThumbnail, timeoutMs: o.timeoutMs }));
            const r = await run(url, { wantThumbnail: options.wantImage, timeoutMs });
            return r.ok
                ? { url, kind, readable: true, context: formatTikTokContext(r.info), ...(r.thumbnailDataUrl ? { imageDataUrl: r.thumbnailDataUrl } : {}) }
                : { url, kind, readable: false, context: formatTikTokContext(null, r.error), error: r.error };
        }
        const run = options.lookups?.x ?? ((u, o) => lookupXPost(u, { wantImage: o.wantImage, timeoutMs: o.timeoutMs }));
        const r = await run(url, { wantImage: options.wantImage, timeoutMs });
        return r.ok
            ? { url, kind, readable: true, context: formatXContext(r.info), ...(r.imageDataUrl ? { imageDataUrl: r.imageDataUrl } : {}) }
            : { url, kind, readable: false, context: formatXContext(null, r.error), error: r.error };
    } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 160) : "lookup failed";
        return {
            url, kind, readable: false, error,
            context: kind === "tiktok" ? formatTikTokContext(null, error) : formatXContext(null, error),
        };
    }
}

/** Every supported link in `text`, in the order they appear, capped. */
export function findLinks(text: string, max: number): Array<{ url: string; kind: LinkKind; at: number }> {
    const found: Array<{ url: string; kind: LinkKind; at: number }> = [];
    for (const url of extractTikTokUrls(text, max)) found.push({ url, kind: "tiktok", at: text.indexOf(url) });
    for (const url of extractXStatusUrls(text, max)) found.push({ url, kind: "x", at: text.indexOf(url) });
    return found.sort((a, b) => a.at - b.at).slice(0, max);
}

export type LinksInTextResult = {
    blocks: string[];
    images: Array<{ mimeType: string; dataBase64: string }>;
    readable: number;
    total: number;
    kinds: LinkKind[];
};

/** Reads the links in a message (in parallel) and returns what to add to the model's input. */
export async function readLinksInText(
    text: string,
    options: { wantImages: boolean; maxLinks?: number; maxImages?: number; timeoutMs?: number; lookups?: LinkReaderLookups },
): Promise<LinksInTextResult> {
    const links = findLinks(text, options.maxLinks ?? 2);
    const result: LinksInTextResult = { blocks: [], images: [], readable: 0, total: links.length, kinds: [] };
    if (links.length === 0) return result;
    const readings = await Promise.all(links.map((l) => readLink(l.url, { wantImage: options.wantImages, timeoutMs: options.timeoutMs, lookups: options.lookups })));
    const maxImages = options.maxImages ?? 2;
    for (const reading of readings) {
        if (!reading) continue;
        result.blocks.push(reading.context);
        result.kinds.push(reading.kind);
        if (reading.readable) result.readable += 1;
        const parsed = reading.imageDataUrl ? /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(reading.imageDataUrl) : null;
        if (parsed && result.images.length < maxImages) result.images.push({ mimeType: parsed[1].toLowerCase(), dataBase64: parsed[2] });
    }
    return result;
}
