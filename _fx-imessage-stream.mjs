// Fixture for lib/imessage-llm-stream.ts: reading a streamed model answer and explaining a
// timeout. Every byte stream is hand-built, including the awkward ones (a JSON record cut in
// half across network chunks, a stream that goes quiet, a stream that dies half way).
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const S = jiti("./lib/imessage-llm-stream.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const enc = new TextEncoder();
async function* chunks(...parts) { for (const p of parts) yield enc.encode(p); }
const oa = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const fakeClock = () => { let t = 0; return () => (t += 1000); };

// A. well-formed OpenAI-compatible stream
let progress = S.newStreamProgress();
let out = await S.readStreamedReply(
  chunks(oa({ content: "Hello" }), oa({ content: " there" }), "data: [DONE]\n\n"),
  "openai-compatible", progress, fakeClock(),
);
eq("A1 content assembled from deltas", out, "Hello there");
eq("A2 content length tracked", progress.contentChars, 11);
eq("A3 first byte recorded", progress.firstByteMs, 1000);
eq("A4 chunk count", progress.chunks, 3);

// B. reasoning is not part of the answer
progress = S.newStreamProgress();
out = await S.readStreamedReply(
  chunks(oa({ reasoning_content: "let me think about this carefully" }), oa({ content: "Answer." })),
  "openai-compatible", progress, fakeClock(),
);
eq("B1 reasoning excluded from the answer", out, "Answer.");
yes("B2 reasoning is counted for diagnostics", progress.reasoningChars > 0, JSON.stringify(progress));

// C. a record cut in half across network chunks must not lose text
const whole = `data: ${JSON.stringify({ choices: [{ delta: { content: "split across chunks" } }] })}\n\n`;
const cut = Math.floor(whole.length / 2);
progress = S.newStreamProgress();
out = await S.readStreamedReply(
  chunks(oa({ content: "A " }), whole.slice(0, cut), whole.slice(cut), oa({ content: " end" })),
  "openai-compatible", progress, fakeClock(),
);
eq("C1 a split record survives", out, "A split across chunks end");

// D. CRLF event separators (some relays)
progress = S.newStreamProgress();
out = await S.readStreamedReply(
  chunks(`data: ${JSON.stringify({ choices: [{ delta: { content: "crlf ok" } }] })}\r\n\r\n`),
  "openai-compatible", progress, fakeClock(),
);
eq("D1 CRLF framing", out, "crlf ok");

// E. a stream with no trailing blank line still yields its last record
progress = S.newStreamProgress();
out = await S.readStreamedReply(
  chunks(`data: ${JSON.stringify({ choices: [{ delta: { content: "no trailing newline" } }] })}`),
  "openai-compatible", progress, fakeClock(),
);
eq("E1 unterminated final record", out, "no trailing newline");

// F. nothing arrives at all
progress = S.newStreamProgress();
out = await S.readStreamedReply(chunks(), "openai-compatible", progress, fakeClock());
eq("F1 an empty stream is an empty answer", out, "");
eq("F2 and no first byte is recorded", progress.firstByteMs, null);

// G. the stream dies half way: progress must survive for the diagnosis
progress = S.newStreamProgress();
async function* dies() { yield enc.encode(oa({ content: "partial answer" })); throw new Error("aborted"); }
let threw = null;
try { await S.readStreamedReply(dies(), "openai-compatible", progress, fakeClock()); } catch (e) { threw = e.message; }
eq("G1 the error propagates", threw, "aborted");
eq("G2 progress kept what arrived", [progress.firstByteMs, progress.contentChars], [1000, 14]);

// H. a real WHATWG stream through iterateBody
const body = new ReadableStream({
  start(c) { c.enqueue(enc.encode(oa({ content: "via " }))); c.enqueue(enc.encode(oa({ content: "ReadableStream" }))); c.close(); },
});
progress = S.newStreamProgress();
out = await S.readStreamedReply(S.iterateBody(body), "openai-compatible", progress, fakeClock());
eq("H1 ReadableStream adapter", out, "via ReadableStream");

// I. multi-word text is not mangled
progress = S.newStreamProgress();
out = await S.readStreamedReply(chunks(oa({ content: "Blue Ceramic Mug is great" })), "openai-compatible", progress, fakeClock());
eq("I1 spaces survive", out, "Blue Ceramic Mug is great");

// J. explaining a timeout
const base = { host: "relay.example.com", model: "MiniMax-M2", deadlineMs: 50_000, promptChars: 42_000 };
let msg = S.describeModelTimeout({ ...base, progress: { firstByteMs: null, contentChars: 0, reasoningChars: 0, chunks: 0 } });
yes("J1 no bytes: names the host and the model", /relay\.example\.com \(MiniMax-M2\)/.test(msg), msg);
yes("J2 no bytes: says no bytes arrived", /No response bytes/.test(msg), msg);
yes("J3 states the deadline and prompt size", /50s/.test(msg) && /42k chars/.test(msg), msg);
msg = S.describeModelTimeout({ ...base, progress: { firstByteMs: 23400, contentChars: 120, reasoningChars: 900, chunks: 30 } });
yes("J4 slow answer: says it began", /began answering after 23\.4s/.test(msg), msg);
yes("J5 slow answer: reports how far it got", /120 chars of answer/.test(msg) && /900 chars of reasoning/.test(msg), msg);
yes("J6 the two cases read differently", !/No response bytes/.test(msg));
eq("J7 hostOf keeps only the host", S.hostOf("https://relay.example.com/v1/chat/completions?key=SECRET"), "relay.example.com");
yes("J8 a key in the URL never reaches the message", !S.describeModelTimeout({ ...base, host: S.hostOf("https://r.example.com/v1?key=SECRET"), progress: S.newStreamProgress() }).includes("SECRET"));
eq("J9 hostOf survives garbage", S.hostOf("not a url"), "the model endpoint");

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
