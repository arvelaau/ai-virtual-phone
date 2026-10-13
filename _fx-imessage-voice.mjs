// Fixture for the character sending real voice messages over iMessage:
//   A  lib/imessage-media-jobs.ts   (the voice job, its paths and lifetime)
//   B  lib/imessage-content.ts      (a [VoiceNote] becomes a job only when the line can deliver it)
//   C  lib/imessage-webhook-handler (queued, no text bubble, text when it cannot be)
//   D  lib/imessage-send-media.ts   (every state change; real voice vs audio file vs text)
//   F  wiring with no pure seam (snapshot capability, browser runner, settings switch, route)
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const stub = path.resolve("_fx-spectrum-stub.mjs");
const jiti = require("jiti")(import.meta.url, {
  alias: { "@spectrum-ts/core/webhook": stub, "@spectrum-ts/core": stub, "@spectrum-ts/imessage": stub, "@": path.resolve(".") },
});
const J = jiti("./lib/imessage-media-jobs.ts");
const C = jiti("./lib/imessage-content.ts");
const H = jiti("./lib/imessage-webhook-handler.ts");
const M = jiti("./lib/imessage-send-media.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const PHONE = "+15551234567";
const NOW = 1_800_000_000_000;
const mkJob = (over = {}) => ({
  ...J.buildVoiceJob({ id: "v1", token: "tok-secret-1234567890", lineId: "line1", characterId: "c1", sessionId: "s1", text: "good night, sleep well", now: NOW }),
  ...over,
});

// ---- A ------------------------------------------------------------------------------------------
let job = mkJob();
eq("A1 a voice job", [job.kind, job.status, job.attempts, job.text, job.description, job.withRef], ["voice", "pending", 0, "good night, sleep well", "", false]);
eq("A2 whitespace collapses and the text is clipped", [
  J.buildVoiceJob({ id: "a", token: "t", lineId: "l", characterId: "c", sessionId: "s", text: "  hello \n\n  there  ", now: NOW }).text,
  J.buildVoiceJob({ id: "a", token: "t", lineId: "l", characterId: "c", sessionId: "s", text: "x".repeat(5000), now: NOW }).text.length,
], ["hello there", J.MAX_VOICE_TEXT_CHARS]);
eq("A3 audio path is separate from the picture path", [J.mediaJobAudioPath("imessage-cloud", "line1", "v1"), J.mediaJobImagePath("imessage-cloud", "line1", "v1")],
  ["imessage-cloud/media/line1/audio_v1.json", "imessage-cloud/media/line1/job_v1.json"]);
yes("A4 isMediaJob accepts a voice job", J.isMediaJob(job) && !J.isMediaJob({ ...job, kind: "video" }));
eq("A5 lifetime: text 30 min, voice 2 h, photo 48 h", [J.maxAgeFor({ kind: "text" }), J.maxAgeFor({ kind: "voice" }), J.maxAgeFor({ kind: "photo" })], [30 * 60_000, 2 * 3600_000, 48 * 3600_000]);
const old = mkJob({ id: "old", createdAt: new Date(NOW - 3 * 3600_000).toISOString() });
const fresh = mkJob({ id: "fresh", createdAt: new Date(NOW - 10 * 60_000).toISOString() });
eq("A6 a voice note from three hours ago is not delivered, a fresh one is", J.selectRunnableJobs([old, fresh], NOW, 10).map((j) => j.id), ["fresh"]);
yes("A7 an expired voice job is reported expired", J.isExpired(old, NOW) && !J.isExpired(fresh, NOW));

// ---- B ------------------------------------------------------------------------------------------
const ctx = (voices) => ({ currentId: "cur", currentText: "hi", known: [], ...(voices ? { voices } : {}) });
let plan = C.planOutbound("Listen:\n\n[VoiceNote:miss you, come home soon: I made soup]", ctx("queue"));
eq("B1 queued with the words intact (colons kept)", [plan.voices, plan.bubbles.map((b) => b.text)], [[{ text: "miss you, come home soon: I made soup" }], ["Listen:"]]);
yes("B2 the note says it was queued", plan.notes.includes("voice note queued for delivery as a real voice message"));
plan = C.planOutbound("[VoiceNote:just this]", ctx("queue"));
eq("B3 a voice-only reply has no bubbles", [plan.bubbles, plan.voices], [[], [{ text: "just this" }]]);
plan = C.planOutbound("[VoiceNote:one]\n\n[VoiceNote:two]", ctx("queue"));
eq("B4 one clip per reply, the second stays as text", [plan.voices.length, plan.bubbles.map((b) => b.text)], [1, ["two"]]);
plan = C.planOutbound("hi [VoiceNote:first: second] there", ctx("text"));
eq("B5 text mode is exactly what it was", [plan.voices, plan.bubbles.map((b) => b.text)], [[], ["hi first · second there"]]);
plan = C.planOutbound("[VoiceNote:x]", ctx());
eq("B6 no option means text mode", plan.voices, []);
plan = C.planOutbound("[VoiceNote:]", ctx("queue"));
eq("B7 an empty voice note is not queued", plan.voices, []);
plan = C.planOutbound("[语音条:晚安]", ctx("queue"));
eq("B8 the legacy Chinese tag name", plan.voices, [{ text: "晚安" }]);
plan = C.planOutbound("[Photo:NoRef:a mug]\n\n[VoiceNote:look at this]", { ...ctx("queue"), photos: "queue" });
eq("B9 a photo and a voice note together", [plan.photos.length, plan.voices.length, plan.bubbles], [1, 1, []]);
plan = C.planOutbound("[Quote:hi]Sure\n\n[VoiceNote:ok]", ctx("queue"));
eq("B10 a quote still resolves next to a voice note", [plan.bubbles.map((b) => b.replyToId), plan.voices.length], [["cur"], 1]);
plan = C.planOutbound("so [VoiceNote:inline words] done", ctx("queue"));
eq("B11 a tag in the middle of a sentence: the words are not also in the text", plan.bubbles.map((b) => b.text), ["so done"]);

// ---- C ------------------------------------------------------------------------------------------
const baseIndex = { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] };
function world(opts = {}) {
  const store = new Map();
  store.set("imessage-cloud/index.json", baseIndex);
  store.set("imessage-cloud/runtime/line1.json", {
    format: "x", version: 1, createdAt: "",
    line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, replyDelaySeconds: 0 },
    apiConfig: {}, promptTemplate: { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" },
    ...(opts.capabilities === undefined ? {} : { capabilities: opts.capabilities }),
  });
  const w = { store, sent: [], reply: opts.reply ?? "Wait for it\n\n[VoiceNote:I'm so glad you texted]", n: 0 };
  w.deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    listRecentStored: async () => [],
    generate: async () => w.reply,
    send: async (t) => { w.sent.push(t); return "p" + w.sent.length; },
    now: () => NOW,
    sleep: async () => {},
    ...(opts.noNewId ? {} : { newId: () => "id" + (++w.n).toString(16).padStart(8, "0") }),
  };
  return w;
}
const inbound = { messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text: "say something" };
const jobKeys = (w) => [...w.store.keys()].filter((k) => k.includes("/outbox/"));

let w = world({ capabilities: { photos: false, voice: true } });
let t = await H.handleInboundMessage(w.deps, inbound);
eq("C1 replied with the text part only", [t.result, w.sent], ["replied", ["Wait for it"]]);
const written = w.store.get(jobKeys(w)[0]);
eq("C2 one voice job with the words", [jobKeys(w).length, written.kind, written.text, written.status, written.lineId, written.characterId, written.sessionId], [1, "voice", "I'm so glad you texted", "pending", "line1", "c1", "s1"]);
yes("C3 long token, id names the voice job", written.token.length >= 16 && written.id.startsWith("m1_voice_"), JSON.stringify(written));
yes("C4 trace counts it", /1 bubble\(s\) \+ 1 voice note\(s\) queued/.test(t.detail), t.detail);
w = world({ capabilities: { voice: true }, reply: "[VoiceNote:only a voice]" });
t = await H.handleInboundMessage(w.deps, inbound);
eq("C5 a voice-only reply is a success, not empty_reply", [t.result, t.reason, w.sent.length, jobKeys(w).length], ["replied", "replied", 0, 1]);
w = world({ capabilities: { voice: false } });
t = await H.handleInboundMessage(w.deps, inbound);
eq("C6 capability off: the words go out as text, nothing queued", [w.sent, jobKeys(w).length], [["Wait for it", "I'm so glad you texted"], 0]);
w = world({});
t = await H.handleInboundMessage(w.deps, inbound);
eq("C7 an older snapshot without the flag: text", [w.sent, jobKeys(w).length], [["Wait for it", "I'm so glad you texted"], 0]);
w = world({ capabilities: { voice: true }, noNewId: true });
t = await H.handleInboundMessage(w.deps, inbound);
eq("C8 no id source: text, never a job without a token", [w.sent, jobKeys(w).length], [["Wait for it", "I'm so glad you texted"], 0]);

// ---- D ------------------------------------------------------------------------------------------
const CLIP = Buffer.from("fake-mp3-bytes-here").toString("base64");
function dworld(over = {}) {
  const store = new Map();
  const log = { text: [], voice: [], file: [], photo: [] };
  const j = mkJob({ status: "ready", ...(over.job || {}) });
  store.set(J.mediaJobPath("imessage-cloud", "line1", "v1"), j);
  if (over.noAudio !== true) store.set(J.mediaJobAudioPath("imessage-cloud", "line1", "v1"), over.audio ?? { mimeType: "audio/mpeg", dataBase64: CLIP });
  const deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    phoneForLine: async (id) => (id === "line1" ? PHONE : null),
    sendText: async (phone, text) => { log.text.push([phone, text]); return "pt1"; },
    sendPhoto: async () => { log.photo.push(1); return "pp1"; },
    now: () => NOW + 1000,
  };
  if (over.noNative !== true) {
    deps.sendVoice = async (phone, bytes, mime, name) => {
      if (over.voiceError) throw new Error(over.voiceError);
      log.voice.push([phone, bytes.byteLength, mime, name]);
      return "pv1";
    };
  }
  if (over.noFile !== true) deps.sendAudioFile = async (phone, bytes, mime, name) => { log.file.push([phone, bytes.byteLength, mime, name]); return "pf1"; };
  return { store, log, deps };
}
const jobAt = (d) => d.store.get(J.mediaJobPath("imessage-cloud", "line1", "v1"));
const go = (d, extra = {}) => M.sendMediaJob(d.deps, { lineId: "line1", jobId: "v1", token: "tok-secret-1234567890", ...extra });

let d = dworld();
let r = await go(d);
eq("D1 sent as a real voice message", [r.ok, r.status, r.code, r.jobStatus, r.detail], [true, 200, "sent", "sent", "voice_message"]);
eq("D2 the clip reached the bound number with the right type and an .mp3 name", [d.log.voice, d.log.file.length, d.log.text.length], [[[PHONE, 19, "audio/mpeg", "voice.mp3"]], 0, 0]);
eq("D3 job marked sent", jobAt(d).status, "sent");
const rec = d.store.get("imessage-cloud/messages/line1/v1_voice.json");
eq("D4 an outbound record carries the spoken words so Chat shows them", [rec?.direction, rec?.role, rec?.content, rec?.platformMessageId], ["outbound", "assistant", "good night, sleep well", "pv1"]);
r = await go(d);
eq("D5 asking again does not send twice", [r.code, d.log.voice.length], ["already_sent", 1]);

d = dworld({ voiceError: "voice content: input is not m4a/aac and ffmpeg is unavailable. Install `ffmpeg-static` or ensure `ffmpeg` is on PATH." });
r = await go(d);
eq("D6 no ffmpeg on the server: the same clip goes out as an audio file", [r.ok, r.code, r.detail, d.log.voice.length, d.log.file], [true, "sent", "audio_file", 0, [[PHONE, 19, "audio/mpeg", "voice.mp3"]]]);

d = dworld({ voiceError: "grpc deadline exceeded" });
r = await go(d);
eq("D7 any other failure is retried, and is NOT sent as a file (no double message)", [r.ok, r.status, r.code, r.jobStatus, d.log.file.length, jobAt(d).attempts], [false, 502, "send_error", "ready", 0, 1]);
d = dworld({ voiceError: "grpc deadline exceeded", job: { attempts: J.MAX_JOB_ATTEMPTS - 1 } });
r = await go(d);
eq("D8 gives up after the last attempt", [r.jobStatus, jobAt(d).status], ["failed", "failed"]);

d = dworld({ noNative: true });
r = await go(d);
eq("D9 a server with only the file path still delivers", [r.ok, r.detail, d.log.file.length], [true, "audio_file", 1]);
d = dworld({ voiceError: "ffmpeg is unavailable", noFile: true });
r = await go(d);
eq("D10 ffmpeg missing and no file path: an honest failure", [r.ok, r.code], [false, "send_error"]);

d = dworld({ noAudio: true });
r = await go(d);
eq("D11 the clip is not uploaded yet", [r.status, r.code, d.log.voice.length], [409, "audio_not_ready", 0]);
d = dworld({ audio: { mimeType: "image/png", dataBase64: CLIP } });
r = await go(d);
eq("D12 a non-audio mime type is refused", [r.status, r.code, d.log.voice.length], [415, "unsupported_audio", 0]);
d = dworld({ audio: { mimeType: "audio/mpeg", dataBase64: Buffer.alloc(M.MAX_SEND_AUDIO_BYTES + 1, 1).toString("base64") } });
r = await go(d);
eq("D13 an oversized clip is refused", [r.status, r.code], [413, "audio_too_large"]);
d = dworld({ audio: { mimeType: "audio/mpeg", dataBase64: "" } });
r = await go(d);
eq("D14 empty audio data is not ready", r.code, "audio_not_ready");

d = dworld();
r = await go(d, { fallback: true, reason: "no voice is set up" });
eq("D15 fallback sends the WORDS as text, not a photo caption", [r.code, r.jobStatus, d.log.text, d.log.voice.length], ["fallback_sent", "fallback_sent", [[PHONE, "good night, sleep well"]], 0]);
eq("D16 the reason is kept on the job, never sent", [jobAt(d).error, d.log.text.length], ["no voice is set up", 1]);

d = dworld();
r = await go(d, { token: "wrong" });
eq("D17 a wrong token learns nothing and sends nothing", [r.status, r.code, d.log.voice.length, d.log.text.length], [403, "bad_token", 0, 0]);
d = dworld({ job: { text: "   " } });
r = await go(d);
eq("D18 a job with no words fails", [r.code, jobAt(d).status], ["empty_text", "failed"]);
d = dworld({ job: { createdAt: new Date(NOW - 3 * 3600_000).toISOString() } });
r = await go(d);
eq("D19 an old voice job is expired, not spoken", [r.status, r.code, d.log.voice.length], [410, "expired", 0]);

// photo and text kinds are untouched
d = dworld();
const photoJob = { ...J.buildPhotoJob({ id: "v1", token: "tok-secret-1234567890", lineId: "line1", characterId: "c1", sessionId: "s1", description: "a mug", withRef: false, now: NOW }), status: "ready" };
d.store.set(J.mediaJobPath("imessage-cloud", "line1", "v1"), photoJob);
d.store.set(J.mediaJobImagePath("imessage-cloud", "line1", "v1"), { mimeType: "image/jpeg", dataBase64: CLIP });
r = await go(d);
eq("D20 photo jobs still go through the photo path", [r.code, d.log.photo.length, d.log.voice.length], ["sent", 1, 0]);

yes("D21 ffmpeg detection is specific", M.isFfmpegUnavailableError(new Error("ffmpeg is unavailable")) && M.isFfmpegUnavailableError(new Error("spawn ffmpeg ENOENT not found")) && !M.isFfmpegUnavailableError(new Error("grpc down")) && !M.isFfmpegUnavailableError(new Error("conversion failed")));

// ---- F: wiring -------------------------------------------------------------------------------------
const sync = fs.readFileSync("lib/imessage-cloud-sync.ts", "utf8");
const route = fs.readFileSync("app/api/imessage/send-media/route.ts", "utf8");
const settings = fs.readFileSync("components/settings/imessage-settings.tsx", "utf8");
const types = fs.readFileSync("lib/imessage-types.ts", "utf8");
yes("F1 the snapshot decides voice at sync time from the line switch AND a bound voice", /voice:\s*line\.sendVoice !== false && resolveVoiceConfig\(character\.id, "chat"\) !== null/.test(sync));
yes("F2 the browser runner has a voice branch before the photo logic", /if \(job\.kind === "voice"\) \{\s*await runVoiceJob\(/.test(sync));
yes("F3 the runner synthesizes with the character's own voice config and falls back to text", /resolveVoiceConfig\(job\.characterId, "chat"\)/.test(sync) && /synthesizeSpeech\(job\.text/.test(sync) && /requestDelivery\(leased, \{ reason: failure \}\)/.test(sync));
yes("F4 the route uses the SDK's voice builder and keeps attachment() for the file path", /import \{ Spectrum, attachment, voice \}/.test(route) && /voice\(Buffer\.from\(bytes\)/.test(route) && /sendAudioFile/.test(route));
yes("F5 the settings page has the switch and the type has the field", /sendVoice: next/.test(settings) && /sendVoice\?: boolean/.test(types) && /voice\?: boolean/.test(types));
yes("F6 the jobs module stays browser-safe", !/from "node:/.test(fs.readFileSync("lib/imessage-media-jobs.ts", "utf8")));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
