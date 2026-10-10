// Fixture for lib/imessage-webhook-trace.ts + lib/imessage-webhook-handler.ts.
// Every side effect (Supabase, the model, space.send) is replaced with a fake, so each
// way a message can end is driven for real and has to produce exactly one trace event.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const T = jiti("./lib/imessage-webhook-trace.ts");
const H = jiti("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => {
  cond ? pass++ : (fail++, console.log("FAIL", name, info));
};

// ---- A: pure helpers -------------------------------------------------------
eq("A1 mask phone", T.maskAddress("+15551234567"), "+15…567");
eq("A2 mask email", T.maskAddress("jane@example.com"), "j***@example.com");
eq("A3 mask empty", T.maskAddress(""), "(empty)");
eq("A4 mask never leaks the full number", T.maskAddress("+15551234567").includes("15551234567"), false);
eq("A5 missing direction is NOT outbound", T.isOutboundDirection(undefined), false);
eq("A6 'outbound' is outbound", T.isOutboundDirection("outbound"), true);
eq("A7 case-insensitive", T.isOutboundDirection(" OUTBOUND "), true);
eq("A8 'inbound' is not outbound", T.isOutboundDirection("inbound"), false);
eq("A9 address from 1:1 space id", T.addressFromSpaceId("iMessage;-;+15551234567"), "+15551234567");
eq("A10 address from email space id", T.addressFromSpaceId("iMessage;-;jane@example.com"), "jane@example.com");
eq("A11 group guid is not an address", T.addressFromSpaceId("iMessage;+;chat123456789012"), "");
eq("A12 candidates dedupe by digits", T.candidateAddresses("+1 (555) 123-4567", "iMessage;-;+15551234567").length, 1);
eq("A13 candidates fall back to space", T.candidateAddresses("", "iMessage;-;+15551234567"), ["+15551234567"]);
eq("A14 no candidates at all", T.candidateAddresses("", ""), []);

const ev = (n) => T.traceEvent("ignored", "x" + n, {}, 1000 + n);
let list = [];
for (let i = 0; i < 20; i += 1) list = T.pushTrace(list, ev(i), 15);
eq("A15 trace capped", list.length, 15);
eq("A16 newest first", list[0].reason, "x19");
const frozen = [ev(1)];
T.pushTrace(frozen, ev(2));
eq("A17 pushTrace does not mutate", frozen.length, 1);

eq("A18 no marker -> process", T.shouldSkipDelivery(null, 5000).skip, false);
eq("A19 done -> skip", T.shouldSkipDelivery({ state: "done", at: 0 }, 5000).reason, "already_handled");
eq("A20 fresh processing -> skip", T.shouldSkipDelivery({ state: "processing", at: 4000 }, 5000).reason, "still_processing");
eq("A21 stale processing -> take over", T.shouldSkipDelivery({ state: "processing", at: 0 }, T.PROCESSING_STALE_MS + 1).skip, false);
eq("A22 failed -> retry allowed", T.shouldSkipDelivery({ state: "failed", at: 4000 }, 5000).skip, false);

// ---- B: the handler --------------------------------------------------------
const SECRET_KEY = "sk-live-SUPER-SECRET-123";
const PHONE = "+15551234567";
const indexFor = (phone = PHONE) => ({
  format: "ai-phone-imessage-cloud-index", version: 1, updatedAt: "2026-01-01T00:00:00Z",
  lines: [{ lineId: "line1", phone, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "2026-01-01T00:00:00Z" }],
});
const snapshotFor = (over = {}) => ({
  format: "ai-phone-imessage-runtime", version: 1, createdAt: "2026-01-01T00:00:00Z",
  line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, addedAt: "" },
  apiConfig: { apiKey: SECRET_KEY },
  promptTemplate: { version: 1, slotToken: "T", beforeMessages: [{ role: "system", content: "SYS" }], afterMessages: [], baseHistoryLength: 0, createdAt: "" },
  ...over,
});

function world(opts = {}) {
  const store = new Map();
  if (opts.index !== null) store.set("imessage-cloud/index.json", opts.index ?? indexFor());
  if (opts.snapshot !== null) store.set("imessage-cloud/runtime/line1.json", opts.snapshot ?? snapshotFor());
  const w = { store, sent: [], llmCalls: 0, clock: opts.clock ?? 1_000_000 };
  w.reply = opts.reply ?? "Hello there\n\nSecond bubble";
  w.llmError = opts.llmError ?? null;
  w.failSendAt = opts.failSendAt ?? -1;
  w.deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    listRecentStored: async () => [],
    generate: async () => { w.llmCalls += 1; if (w.llmError) throw new Error(w.llmError); return w.reply; },
    send: async (text) => { if (w.sent.length === w.failSendAt) throw new Error("gRPC unavailable"); w.sent.push(text); },
    now: () => w.clock,
  };
  return w;
}
const msg = (over = {}) => ({
  messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE,
  direction: "inbound", contentType: "text", text: "hi", ...over,
});
const run = (w, over) => H.handleInboundMessage(w.deps, msg(over));
const markerKeys = (w) => [...w.store.keys()].filter((k) => k.includes("/seen/"));

let w = world();
let r = await run(w);
eq("B1 happy path replies", [r.result, r.reason], ["replied", "replied"]);
eq("B2 both bubbles were sent", w.sent, ["Hello there", "Second bubble"]);
eq("B3 outbound records written", [...w.store.keys()].filter((k) => k.includes("/messages/")).length, 3);
eq("B4 marker ends 'done'", w.store.get(markerKeys(w)[0]).state, "done");
eq("B5 detail counts bubbles", r.detail, "2 bubble(s)");

w = world();
r = await run(w, { direction: undefined });
eq("B6 missing direction is still answered", r.result, "replied");

w = world();
r = await run(w, { direction: "outbound" });
eq("B7 outbound ignored", [r.result, r.reason], ["ignored", "ignored_outbound"]);
eq("B8 outbound never reaches the model", w.llmCalls, 0);

w = world();
r = await run(w, { contentType: "attachment", text: "" });
eq("B9 non-text ignored", [r.result, r.reason], ["ignored", "ignored_non_text"]);
yes("B10 names the content type", /attachment/.test(r.detail ?? ""), r.detail);

w = world({ index: null });
r = await run(w);
eq("B11 no index", [r.result, r.reason], ["rejected", "no_cloud_index"]);

w = world();
r = await run(w, { senderId: "+19998887777", spaceId: "iMessage;-;+19998887777" });
eq("B12 unbound sender", [r.result, r.reason], ["rejected", "sender_not_bound"]);
yes("B13 shows what it got and what is bound", /got \+19…777/.test(r.detail) && /bound numbers: \+15…567/.test(r.detail), r.detail);
yes("B14 never prints a full number", !/15551234567|19998887777/.test(JSON.stringify(r)), JSON.stringify(r));
eq("B15 unbound sender never reaches the model", w.llmCalls, 0);

w = world();
r = await run(w, { senderId: "" });
eq("B16 sender missing: falls back to the space id", r.result, "replied");

w = world();
r = await run(w, { senderId: "someone-else-id", spaceId: "iMessage;-;" + PHONE });
eq("B17 sender unrecognisable but space carries the address", r.result, "replied");

w = world({ snapshot: snapshotFor({ line: { id: "line1", phone: PHONE, characterId: "c1", enabled: false } }) });
r = await run(w);
eq("B18 disabled line", [r.result, r.reason], ["rejected", "line_disabled"]);
eq("B19 disabled line never reaches the model", w.llmCalls, 0);

w = world({ snapshot: null });
r = await run(w);
eq("B20 missing runtime package", [r.result, r.reason], ["rejected", "no_snapshot"]);

// retries / at-least-once delivery
w = world();
await run(w);
const sentAfterFirst = w.sent.length;
r = await run(w);
eq("B21 a retry of an answered message is skipped", [r.result, r.reason], ["ignored", "already_handled"]);
eq("B22 ...and sends nothing again", w.sent.length, sentAfterFirst);

w = world();
w.store.set(`imessage-cloud/seen/line1/m1.json`, { state: "processing", at: w.clock - 5_000 });
r = await run(w);
eq("B23 a retry during live processing is skipped", [r.result, r.reason], ["ignored", "still_processing"]);

w = world();
w.store.set(`imessage-cloud/seen/line1/m1.json`, { state: "processing", at: w.clock - T.PROCESSING_STALE_MS - 1000 });
r = await run(w);
eq("B24 a killed function does not silence the message forever", r.result, "replied");

// failure modes
w = world({ llmError: "LLM request failed (429)." });
r = await run(w);
eq("B25 model failure is reported", [r.result, r.reason], ["error", "llm_error"]);
yes("B26 ...with the cause", /429/.test(r.detail), r.detail);
eq("B27 marker is 'failed', not stuck 'processing'", w.store.get(markerKeys(w)[0]).state, "failed");
w.llmError = null;
r = await run(w);
eq("B28 a failed attempt can be retried", r.result, "replied");

w = world({ reply: "[InnerThoughts]only a thought[/InnerThoughts]" });
r = await run(w);
eq("B29 an all-hidden reply is reported, not swallowed", [r.result, r.reason], ["error", "empty_reply"]);

w = world({ failSendAt: 1 });
r = await run(w);
eq("B30 a mid-way send failure is reported", [r.result, r.reason], ["error", "send_error"]);
yes("B31 ...naming which bubble", /bubble 2\/2/.test(r.detail), r.detail);
eq("B32 ...and the first bubble did go out", w.sent, ["Hello there"]);

w = world({ reply: "Blue Ceramic Mug is great" });
await run(w);
eq("B33 multi-word text survives intact", w.sent, ["Blue Ceramic Mug is great"]);

// secrets never reach a trace
w = world({ llmError: "boom" });
const allTraces = [];
allTraces.push(await run(w));
w = world({ index: null });
allTraces.push(await run(w));
w = world();
allTraces.push(await run(w));
yes("B34 the model API key never appears in a trace", !JSON.stringify(allTraces).includes(SECRET_KEY));
yes("B35 every call returns one well-formed trace", allTraces.every((t) => t.at && t.result && t.reason));

// the model's own timing note is carried into the trace
w = world();
w.deps.generate = async () => ({ content: "Hi there", note: "relay.example.com 6.2s, first byte 2.1s" });
r = await run(w);
eq("B36 a model note is appended to the replied detail", r.detail, "1 bubble(s), relay.example.com 6.2s, first byte 2.1s");
console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
