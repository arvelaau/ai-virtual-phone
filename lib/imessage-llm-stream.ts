// lib/imessage-llm-stream.ts
// Reading the model's streamed answer for the iMessage webhook, and explaining a timeout.
//
// Why streaming: the Chat app always streams, and "thinking" models routed through a relay
// are silent for a long time before the first byte. A single non-streaming request over such
// a relay is exactly what gets cut off, with an error that says nothing about why. Reading
// the stream also tells us WHEN the first byte arrived, which is what separates "the model
// is still thinking / the endpoint is unreachable" from "it answers, but too slowly".
//
// Pure: takes an async iterable of bytes and a clock, so a fixture can drive every shape.

import { createSseJsonParser } from "./sse-json";
import { parseProviderStreamDelta, stripHallucinatedTimestamps, type LlmProviderKind } from "./llm-provider-adapter";

export type StreamProgress = {
    /** ms from the start of the read until the first byte arrived; null while nothing has. */
    firstByteMs: number | null;
    contentChars: number;
    reasoningChars: number;
    chunks: number;
};

export function newStreamProgress(): StreamProgress {
    return { firstByteMs: null, contentChars: 0, reasoningChars: 0, chunks: 0 };
}

/**
 * Consumes an SSE byte stream and returns the visible answer text. `progress` is updated as
 * bytes arrive, so a caller that aborts mid-stream can still say how far it got.
 */
export async function readStreamedReply(
    stream: AsyncIterable<Uint8Array>,
    providerKind: LlmProviderKind,
    progress: StreamProgress,
    clock: () => number = Date.now,
): Promise<string> {
    const startedAt = clock();
    const decoder = new TextDecoder();
    const sse = createSseJsonParser();
    let buffer = "";
    let content = "";

    const handleParsed = (parsed: unknown) => {
        const delta = parseProviderStreamDelta(providerKind, parsed);
        if (delta.reasoning) progress.reasoningChars += delta.reasoning.length;
        if (delta.content) {
            content += delta.content;
            progress.contentChars = content.length;
        }
    };
    const handleEvent = (eventText: string) => {
        for (const parsed of sse.pushEvent(eventText)) handleParsed(parsed);
    };

    for await (const chunk of stream) {
        if (progress.firstByteMs === null) progress.firstByteMs = clock() - startedAt;
        progress.chunks += 1;
        buffer += decoder.decode(chunk, { stream: true });
        const normalized = buffer.replace(/\r\n/g, "\n");
        const parts = normalized.split("\n\n");
        buffer = parts[parts.length - 1] ?? "";
        for (const eventText of parts.slice(0, -1)) handleEvent(eventText);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
    for (const parsed of sse.flush()) handleParsed(parsed);

    return stripHallucinatedTimestamps(content.trim());
}

/** Adapts a WHATWG ReadableStream to something `for await` accepts on every runtime. */
export async function* iterateBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "the model endpoint";
    }
}

/**
 * The sentence that goes into the trace when the deadline is hit. It names the host and the
 * model (never a key) and says which of the two very different situations this is.
 */
export function describeModelTimeout(info: {
    host: string;
    model: string;
    deadlineMs: number;
    progress: StreamProgress;
    promptChars: number;
}): string {
    const seconds = Math.round(info.deadlineMs / 1000);
    const who = `${info.host}${info.model ? ` (${info.model})` : ""}`;
    const size = `prompt ${Math.round(info.promptChars / 1000)}k chars`;
    const p = info.progress;
    if (p.firstByteMs === null) {
        return `No response bytes from ${who} within ${seconds}s (${size}). The model is still thinking, or this endpoint is slow or unreachable from the server's region.`;
    }
    const first = Math.round(p.firstByteMs / 100) / 10;
    const reasoning = p.reasoningChars ? `, ${p.reasoningChars} chars of reasoning` : "";
    return `${who} began answering after ${first}s but had not finished within ${seconds}s (${p.contentChars} chars of answer${reasoning}, ${size}). The model is too slow for this server's time limit.`;
}
