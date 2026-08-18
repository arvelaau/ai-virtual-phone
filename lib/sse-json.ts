// Fault-tolerant SSE-JSON parser.
//
// Non-conforming relays flush a long JSON `data:` line from the middle, and some
// even insert a blank line at the cut so it arrives as two separate "events".
// Symptom: `JSON Parse error: Unterminated string`.
//
// This reassembles fragments: a record that fails to parse is held in `carry` and
// retried concatenated with the next one. If the joined text still fails but the
// NEW fragment parses on its own, the held text is judged garbage (a keepalive or
// a non-JSON relay message) and dropped, so one bad record cannot poison the rest
// of the stream.
//
// Shared by both streaming paths in chat-engine (plain text stream and native
// tool-call stream), which previously had two independent copies of the same
// naive `JSON.parse(dataLine)`.

// Stop-loss ceiling. A held fragment past this size is not a split record, it is a
// relay dumping something we will never be able to parse.
const MAX_CARRY_CHARS = 8_000_000;

export type SseJsonParser = {
    /** Feed one complete SSE event (already split on the blank line). Returns the JSON values parsed from it. */
    pushEvent: (eventText: string) => unknown[];
    /** End of stream: settle any held fragment (returned if it parses, dropped otherwise). */
    flush: () => unknown[];
};

export function createSseJsonParser(): SseJsonParser {
    let carry = "";

    const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
        try {
            return { ok: true, value: JSON.parse(text) as unknown };
        } catch {
            return { ok: false };
        }
    };

    const consumeRecord = (record: string, out: unknown[]): void => {
        if (!record || record === "[DONE]") {
            // [DONE] means nothing more is coming, so a still-unparsed fragment can
            // never be completed -- drop it rather than let it leak into a later stream.
            if (record === "[DONE]") carry = "";
            return;
        }
        if (carry) {
            const joined = tryParse(carry + record);
            if (joined.ok) {
                carry = "";
                out.push(joined.value);
                return;
            }
            const alone = tryParse(record);
            if (alone.ok) {
                // The new fragment is complete on its own, so whatever is held cannot
                // be its prefix. Drop the held text instead of corrupting this record.
                carry = "";
                out.push(alone.value);
                return;
            }
            carry = carry.length + record.length > MAX_CARRY_CHARS ? "" : carry + record;
            return;
        }
        const alone = tryParse(record);
        if (alone.ok) {
            out.push(alone.value);
            return;
        }
        carry = record.length > MAX_CARRY_CHARS ? "" : record;
    };

    return {
        pushEvent(eventText: string): unknown[] {
            const out: unknown[] = [];
            const records: string[] = [];
            for (const line of eventText.split("\n")) {
                if (line.startsWith("data:")) {
                    // Per the SSE spec at most ONE space after the colon is the
                    // separator. Do not trim: a record split mid-string can legitimately
                    // begin or end with a space that belongs to the JSON payload.
                    records.push(line.slice(5).replace(/^ /, ""));
                } else if (/^(event:|id:|retry:|:)/.test(line)) {
                    continue; // other SSE fields, and `:` comment keepalives
                } else if (line) {
                    // A bare line with no `data:` prefix is the tail of a line the relay
                    // cut in half, so it belongs to the record immediately before it.
                    if (records.length > 0) records[records.length - 1] += line;
                    else records.push(line);
                }
            }
            for (const record of records) consumeRecord(record, out);
            return out;
        },
        flush(): unknown[] {
            if (!carry) return [];
            const last = tryParse(carry);
            carry = "";
            return last.ok ? [last.value] : [];
        },
    };
}
