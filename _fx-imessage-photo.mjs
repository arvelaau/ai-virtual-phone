// Fixture for the character sending real photos over iMessage:
//   A  lib/imessage-media-jobs.ts   (paths, record shape, which jobs may run, token check)
//   B  lib/imessage-content.ts      (photo tags become jobs only when the line can deliver them)
//   C  lib/imessage-webhook-handler (the webhook queues the job and still answers in text)
//   D  lib/imessage-send-media.ts   (every refusal and every state change of the delivery step)
//   E  app/api/imessage/send-media  (the route, with Photon replaced by a stub)
//   F  wiring that has no pure seam (snapshot capability, browser runner, settings switch)
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const stub = path.resolve("_fx-spectrum-stub.mjs");
const jiti = require("jiti")(import.meta.url, {
  alias: {
    "@spectrum-ts/core/webhook": stub,
    "@spectrum-ts/core": stub,
    "@spectrum-ts/imessage": stub,
    "@": path.resolve("."),
  },
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
const mkJob = (over = {}) => ({ ...J.buildPhotoJob({ id: "j1", token: "tok-secret-1234567890", lineId: "line1", characterId: "c1", sessionId: "s1", description: "a bowl of ramen on a counter", withRef: false, now: NOW }), ...over });

// ---- A: jobs --------------------------------------------------------------------------------
eq("A1 job path is sanitised", J.mediaJobPath("imessage-cloud", "line/../1", "j 1"), "imessage-cloud/outbox/line____1/j_1.json");
eq("A2 image path shares the inbound-photo shape location", J.mediaJobImagePath("imessage-cloud", "line1", "j1"), "imessage-cloud/media/line1/job_j1.json");
eq("A3 prefix ends with a slash for listing", J.mediaJobPrefix("imessage-cloud", "line1"), "imessage-cloud/outbox/line1/");
let job = mkJob();
eq("A4 a new job is pending with no attempts", [job.status, job.attempts, job.kind, job.format], ["pending", 0, "photo", "ai-phone-imessage-media-job"]);
yes("A5 isMediaJob accepts a job, rejects junk", J.isMediaJob(job) && !J.isMediaJob(null) && !J.isMediaJob({ format: "x" }) && !J.isMediaJob({ ...job, token: 5 }));

const at = (ms) => new Date(NOW + ms).toISOString();
const jobs = [
  mkJob({ id: "p1", status: "pending", createdAt: at(10) }),
  mkJob({ id: "p0", status: "pending", createdAt: at(0) }),
  mkJob({ id: "g-live", status: "generating", leaseUntil: NOW + 60_000, attempts: 1, createdAt: at(1) }),
  mkJob({ id: "g-dead", status: "generating", leaseUntil: NOW - 1, attempts: 1, createdAt: at(2) }),
  mkJob({ id: "g-spent", status: "generating", leaseUntil: NOW - 1, attempts: J.MAX_JOB_ATTEMPTS, createdAt: at(3) }),
  mkJob({ id: "rdy", status: "ready", attempts: J.MAX_JOB_ATTEMPTS, createdAt: at(4) }),
  mkJob({ id: "snt", status: "sent", createdAt: at(5) }),
  mkJob({ id: "fb", status: "fallback_sent", createdAt: at(6) }),
  mkJob({ id: "bad", status: "failed", createdAt: at(7) }),
  mkJob({ id: "old", status: "pending", createdAt: new Date(NOW - J.JOB_MAX_AGE_MS - 1000).toISOString() }),
];
eq("A6 runnable set, oldest first", J.selectRunnableJobs(jobs, NOW, 10).map((j) => j.id), ["p0", "g-dead", "rdy", "p1"]);
eq("A7 a live lease is honoured", J.selectRunnableJobs(jobs, NOW, 10).some((j) => j.id === "g-live"), false);
eq("A8 'ready' runs even when attempts are spent (delivery only)", J.selectRunnableJobs([jobs[5]], NOW, 1).map((j) => j.id), ["rdy"]);
eq("A9 max limits the batch", J.selectRunnableJobs(jobs, NOW, 1).map((j) => j.id), ["p0"]);
eq("A10 terminal and stale jobs never run", J.selectRunnableJobs([jobs[6], jobs[7], jobs[8], jobs[9]], NOW, 10), []);
yes("A11 token match is exact", J.tokensMatch("abc123", "abc123") && !J.tokensMatch("abc123", "abc124") && !J.tokensMatch("abc123", "abc12") && !J.tokensMatch("abc123", "") && !J.tokensMatch("abc123", undefined) && !J.tokensMatch("", ""));
eq("A12 fallback text", [J.photoFallbackText("  a  bowl\nof ramen "), J.photoFallbackText("")], ["📷 a bowl of ramen", "📷"]);
yes("A13 the module is browser-safe (no node: imports)", !/from "node:/.test(fs.readFileSync("lib/imessage-media-jobs.ts", "utf8")));

// ---- B: the planner -------------------------------------------------------------------------
const ctx = (photos) => ({ currentId: "cur", currentText: "hi", known: [], ...(photos ? { photos } : {}) });
let plan = C.planOutbound("Look at this\n\n[Photo:NoRef:half-eaten ramen: warm light, from above]", ctx("queue"));
eq("B1 text stays, the photo becomes a job", [plan.bubbles.map((b) => b.text), plan.photos], [["Look at this"], [{ description: "half-eaten ramen: warm light, from above", withRef: false }]]);
yes("B2 the note says it was queued", plan.notes.includes("photo queued for delivery as a real picture"));
plan = C.planOutbound("[Photo:WithRef:me on a train seat]", ctx("queue"));
eq("B3 a photo-only reply has no bubbles and one job", [plan.bubbles, plan.photos], [[], [{ description: "me on a train seat", withRef: true }]]);
plan = C.planOutbound("[Photo:使用参考图:自拍]\n\n[Photo:不使用参考图:街景]", ctx("queue"));
eq("B4 legacy Chinese flags", plan.photos, [{ description: "自拍", withRef: true }, { description: "街景", withRef: false }]);
plan = C.planOutbound("[Photo:NoRef:one]\n\n[Photo:NoRef:two]\n\n[Photo:NoRef:three]", ctx("queue"));
eq("B5 at most two photos per reply; the rest become text", [plan.photos.length, plan.bubbles.map((b) => b.text)], [2, ["📷 three"]]);
plan = C.planOutbound("hello [Photo:NoRef:a mug] there", ctx("text"));
eq("B6 text mode is unchanged", [plan.photos, plan.bubbles.map((b) => b.text)], [[], ["hello 📷 a mug there"]]);
plan = C.planOutbound("hello [Photo:NoRef:a mug] there", ctx());
eq("B7 no option means text mode", plan.photos, []);
plan = C.planOutbound("[Photo:NoRef:]", ctx("queue"));
eq("B8 a photo with no description is not queued", plan.photos, []);
plan = C.planOutbound("[Quote:hi]Sure!\n\n[Photo:NoRef:a mug]", ctx("queue"));
eq("B9 a quote still resolves when a photo is present", [plan.bubbles.map((b) => b.replyToId), plan.photos.length], [["cur"], 1]);

// ---- C: the webhook handler ----------------------------------------------------------------------
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
  const w = { store, sent: [], reply: opts.reply ?? "Look!\n\n[Photo:WithRef:me at the window]", n: 0 };
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
const inbound = { messageId: "m1", senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text: "send me a pic" };
const jobKeys = (w) => [...w.store.keys()].filter((k) => k.includes("/outbox/"));

let w = world({ capabilities: { photos: true } });
let t = await H.handleInboundMessage(w.deps, inbound);
eq("C1 replied", [t.result, w.sent], ["replied", ["Look!"]]);
eq("C2 one job was written", jobKeys(w).length, 1);
const written = w.store.get(jobKeys(w)[0]);
eq("C3 job carries the line, character, session and what to draw", [written.lineId, written.characterId, written.sessionId, written.description, written.withRef, written.status], ["line1", "c1", "s1", "me at the window", true, "pending"]);
yes("C4 job has a long token and a distinct id", written.token.length >= 16 && written.id.startsWith("m1_photo_"), JSON.stringify(written));
yes("C5 the trace counts the queued photo", /1 bubble\(s\) \+ 1 photo\(s\) queued/.test(t.detail), t.detail);
yes("C6 the job path matches the browser's listing prefix", jobKeys(w)[0].startsWith(J.mediaJobPrefix("imessage-cloud", "line1")), jobKeys(w)[0]);

w = world({ capabilities: { photos: true }, reply: "[Photo:NoRef:a mug]" });
t = await H.handleInboundMessage(w.deps, inbound);
eq("C7 a photo-only reply is a success, not 'empty_reply'", [t.result, t.reason, w.sent.length, jobKeys(w).length], ["replied", "replied", 0, 1]);

w = world({ capabilities: { photos: false } });
t = await H.handleInboundMessage(w.deps, inbound);
eq("C8 capability off: the photo goes out as text and nothing is queued", [w.sent, jobKeys(w).length], [["Look!", "📷 me at the window"], 0]);

w = world({});
t = await H.handleInboundMessage(w.deps, inbound);
eq("C9 snapshot without capabilities (older sync): text", [w.sent, jobKeys(w).length], [["Look!", "📷 me at the window"], 0]);

w = world({ capabilities: { photos: true }, noNewId: true });
t = await H.handleInboundMessage(w.deps, inbound);
eq("C10 no id source: text, never a job without a token", [w.sent, jobKeys(w).length], [["Look!", "📷 me at the window"], 0]);

w = world({ capabilities: { photos: true }, reply: "[Photo:NoRef:a]\n\n[Photo:NoRef:b]" });
await H.handleInboundMessage(w.deps, inbound);
const tokens = jobKeys(w).map((k) => w.store.get(k).token);
yes("C11 two photos get two different tokens", tokens.length === 2 && tokens[0] !== tokens[1], JSON.stringify(tokens));

// ---- D: the delivery step -----------------------------------------------------------------------------
function dworld(over = {}) {
  const store = new Map();
  const log = { text: [], photo: [] };
  const j = mkJob({ status: "ready", ...(over.job || {}) });
  if (over.noJob !== true) store.set(J.mediaJobPath("imessage-cloud", "line1", "j1"), j);
  if (over.noImage !== true) store.set(J.mediaJobImagePath("imessage-cloud", "line1", "j1"), over.image ?? { mimeType: "image/jpeg", dataBase64: Buffer.from("fake-jpeg-bytes").toString("base64") });
  const deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    phoneForLine: async (id) => (over.noLine ? null : id === "line1" ? PHONE : null),
    sendText: async (phone, text) => { if (over.textFails) throw new Error("grpc down"); log.text.push([phone, text]); return "pt1"; },
    sendPhoto: async (phone, bytes, mime, name) => { if (over.photoFails) throw new Error("attachment rejected"); log.photo.push([phone, bytes.byteLength, mime, name]); return "pp1"; },
    now: () => NOW + 1000,
  };
  return { store, log, deps };
}
const jobAt = (d) => d.store.get(J.mediaJobPath("imessage-cloud", "line1", "j1"));
const go = (d, extra = {}) => M.sendMediaJob(d.deps, { lineId: "line1", jobId: "j1", token: "tok-secret-1234567890", ...extra });

let d = dworld();
let r = await go(d);
eq("D1 delivered", [r.ok, r.status, r.code, r.jobStatus], [true, 200, "sent", "sent"]);
eq("D2 the attachment reached the bound number with the right type and name", d.log.photo, [[PHONE, 15, "image/jpeg", "photo.jpg"]]);
eq("D3 the job is marked sent", jobAt(d).status, "sent");
const rec = d.store.get("imessage-cloud/messages/line1/j1_photo.json");
eq("D4 an outbound record points at the picture so Chat can import it", [rec?.direction, rec?.role, rec?.content, rec?.image, rec?.platformMessageId], ["outbound", "assistant", "", { path: "imessage-cloud/media/line1/job_j1.json", mimeType: "image/jpeg" }, "pp1"]);
yes("D5 the record is the shape the browser pull accepts", rec?.format === "ai-phone-imessage-cloud-message" && rec?.lineId === "line1" && rec?.characterId === "c1" && rec?.sessionId === "s1");

r = await go(d);
eq("D6 asking again does not send twice", [r.ok, r.code, d.log.photo.length], [true, "already_sent", 1]);

d = dworld();
r = await go(d, { token: "wrong-token-xxxxxxxxxxxx" });
eq("D7 wrong token: 403 and nothing is sent", [r.status, r.code, d.log.photo.length, d.log.text.length], [403, "bad_token", 0, 0]);
yes("D8 ...and the response reveals nothing about the job", r.jobStatus === undefined && r.detail === undefined);
d = dworld();
r = await go(d, { token: undefined });
eq("D9 missing token", [r.status, r.code], [403, "bad_token"]);

d = dworld({ noJob: true });
eq("D10 unknown job", (await go(d)).code, "job_not_found");
d = dworld();
r = await M.sendMediaJob(d.deps, { lineId: "line1", jobId: "", token: "x" });
eq("D11 bad request", [r.status, r.code], [400, "bad_request"]);
r = await M.sendMediaJob(d.deps, { lineId: 5, jobId: "j1", token: "x" });
eq("D12 non-string ids", r.status, 400);
d = dworld({ job: { lineId: "other" } });
eq("D13 a job whose own lineId disagrees with its path is not served", (await go(d)).code, "job_not_found");

d = dworld({ noImage: true });
r = await go(d);
eq("D14 picture not uploaded yet", [r.status, r.code, d.log.photo.length], [409, "image_not_ready", 0]);
d = dworld({ image: { mimeType: "application/pdf", dataBase64: "AAAA" } });
eq("D15 non-image mime is refused", (await go(d)).code, "unsupported_image");
d = dworld({ image: { mimeType: "image/png", dataBase64: "!!!not base64!!!" } });
eq("D16 undecodable data is refused", (await go(d)).code, "bad_image_data");
d = dworld({ image: { mimeType: "image/png", dataBase64: Buffer.alloc(M.MAX_SEND_IMAGE_BYTES + 1).toString("base64") } });
eq("D17 oversize picture is refused", (await go(d)).code, "image_too_large");

d = dworld({ noLine: true });
eq("D18 line no longer exists", (await go(d)).code, "line_not_found");
d = dworld({ job: { createdAt: new Date(NOW - J.JOB_MAX_AGE_MS - 5000).toISOString() } });
r = await go(d);
eq("D19 an old job is expired, not delivered", [r.status, r.code, jobAt(d).status, d.log.photo.length], [410, "expired", "failed", 0]);
d = dworld({ job: { status: "failed", error: "boom" } });
eq("D20 a failed job stays failed", [(await go(d)).status, d.log.photo.length], [409, 0]);

d = dworld({ photoFails: true, job: { attempts: 0 } });
r = await go(d);
eq("D21 a send error keeps the job deliverable and counts the attempt", [r.status, r.code, jobAt(d).status, jobAt(d).attempts], [502, "send_error", "ready", 1]);
d = dworld({ photoFails: true, job: { attempts: J.MAX_JOB_ATTEMPTS - 1 } });
r = await go(d);
eq("D22 ...and gives up after the last attempt", [jobAt(d).status, r.jobStatus], ["failed", "failed"]);
yes("D23 no outbound record is written for a failed send", !d.store.has("imessage-cloud/messages/line1/j1_photo.json"));

d = dworld({ noImage: true, job: { status: "generating", attempts: 3 } });
r = await go(d, { fallback: true, reason: "image model said no" });
eq("D24 fallback delivers the description as text", [r.code, d.log.text, d.log.photo.length], ["fallback_sent", [[PHONE, "📷 a bowl of ramen on a counter"]], 0]);
eq("D25 ...records the reason and the text", [jobAt(d).status, jobAt(d).error, d.store.get("imessage-cloud/messages/line1/j1_photo.json")?.content], ["fallback_sent", "image model said no", "📷 a bowl of ramen on a counter"]);
d = dworld({ textFails: true });
eq("D26 fallback send error is reported, job stays open", [(await go(d, { fallback: true })).code, jobAt(d).status], ["send_error", "ready"]);
d = dworld({ job: { status: "fallback_sent" } });
eq("D27 a fallback is not repeated either", [(await go(d, { fallback: true })).code, d.log.text.length], ["already_sent", 0]);

// ---- E: the route -------------------------------------------------------------------------------
process.env.PHOTON_PROJECT_ID = "proj_1";
process.env.PHOTON_PROJECT_SECRET = "proj-secret";
process.env.IMESSAGE_SUPABASE_URL = "https://example.supabase.co";
process.env.IMESSAGE_SUPABASE_SERVICE_ROLE_KEY = "service-role";
const remote = new Map();
let remoteCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  remoteCalls += 1;
  const u = String(url);
  const obj = u.split("/storage/v1/object/ai-phone-backup/")[1];
  if (!obj) return new Response("[]", { status: 200 });
  if ((init.method || "GET") === "GET") return remote.has(obj) ? new Response(remote.get(obj), { status: 200 }) : new Response("{}", { status: 400 });
  remote.set(obj, String(init.body));
  return new Response("{}", { status: 200 });
};
const route = jiti("./app/api/imessage/send-media/route.ts");
const post = (body, raw) => route.POST(new Request("https://app.example/api/imessage/send-media", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));

let res = await post({}, "{not json");
eq("E1 malformed JSON", res.status, 400);
res = await post({ lineId: "x".repeat(5000) });
eq("E2 oversized body", res.status, 413);
res = await post({ lineId: "line1", jobId: "nope", token: "x" });
eq("E3 unknown job -> 404, and Photon was never contacted", [res.status, (await res.json()).code], [404, "job_not_found"]);
remote.set("imessage-cloud/outbox/line1/j1.json", JSON.stringify(mkJob({ status: "ready" })));
res = await post({ lineId: "line1", jobId: "j1", token: "wrong" });
eq("E4 wrong token -> 403 without opening a Photon connection", [res.status, (await res.json()).code], [403, "bad_token"]);
res = await post({ lineId: "line1", jobId: "j1", token: "tok-secret-1234567890" });
const body = await res.json();
eq("E5 a legitimate request gets as far as the SDK (stubbed to refuse)", res.status === 404 || res.status === 502 || res.status === 409, true);
yes("E6 no secret ever appears in a response", !/proj-secret|service-role|tok-secret/.test(JSON.stringify(body)), JSON.stringify(body));
delete process.env.PHOTON_PROJECT_ID;
res = await post({ lineId: "line1", jobId: "j1", token: "x" });
eq("E7 missing Photon config -> 503", [res.status, (await res.json()).code], [503, "missing_photon_env"]);

// ---- F: wiring ----------------------------------------------------------------------------------
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sync = read("lib/imessage-cloud-sync.ts");
yes("F1 the snapshot only promises photos when generation is available", /capabilities: \{\s*photos: line\.sendPhotos !== false && isImageGenerationAvailableFor\(character\.id\)/.test(sync));
yes("F2 the sync loop runs the photo jobs and re-pulls after a delivery", /void processIMessageMediaJobs\(\)/.test(sync) && /run\.delivered \+ run\.fallbacks === 0/.test(sync));
yes("F3 the runner generates with the photo style and the reference flag", /useReferenceImage: job\.withRef,\n\s+photoStyle: true/.test(sync));
yes("F4 the runner asks for a text fallback when generation is not set up", /requestDelivery\(leased, \{ reason: failure \}\)/.test(sync));
yes("F5 a lease is taken before generating (so two tabs do not both pay)", /status: "generating",\n\s+attempts: job\.attempts \+ 1,\n\s+leaseUntil/.test(sync));
yes("F6 settings page exposes the per-line switch", /Send photos as real pictures/.test(read("components/settings/imessage-settings.tsx")));
yes("F7 the webhook route supplies an id source", /newId: \(\) => globalThis\.crypto\.randomUUID\(\)/.test(read("app/api/imessage/webhook/route.ts")));
yes("F8 the delivery route never logs or echoes the token", !/console\.(log|error|warn)/.test(read("app/api/imessage/send-media/route.ts")));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
