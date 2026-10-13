// Fixture: messages the character starts in the app (follow-ups, timed wake-ups, chat plugins
// that make it write first) also go out over real iMessage.
//   A  decideMirror            which messages qualify and why the others do not
//   B  lastLocalUserMessageAt  what counts as "the user just typed something here"
//   C  text jobs               shape, expiry (a late "you still up?" is wrong)
//   D  sendMediaJob (text)     delivery, record shape, every refusal
//   E  what the webhook sees   the mirrored record reaches the next prompt, the pull skips it
//   F  wiring                  listener, lease, no-duplicate rule, settings switch
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const X = jiti("./lib/imessage-mirror.ts");
const J = jiti("./lib/imessage-media-jobs.ts");
const M = jiti("./lib/imessage-send-media.ts");
const W = jiti("./lib/imessage-webhook-core.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(NOW + ms).toISOString();
const msg = (over = {}) => ({ id: "m1", sessionId: "s1", role: "assistant", content: "you still up?", createdAt: iso(0), ...over });
const decide = (over = {}) => X.decideMirror({ mode: "proactive", message: msg(), isGroup: false, now: NOW, ...over });

// ---- A: the decision -----------------------------------------------------------------------
eq("A1 off", decide({ mode: "off" }), { send: false, reason: "off" });
eq("A2 group chats are never mirrored", decide({ isGroup: true }), { send: false, reason: "group" });
eq("A3 only the character's own messages", decide({ message: msg({ role: "user" }) }), { send: false, reason: "not_assistant" });
eq("A4 imported from iMessage by id", decide({ message: msg({ id: "imsg_cloud_abc" }) }), { send: false, reason: "imported" });
eq("A5 imported by cloudSync marker", decide({ message: msg({ cloudSync: { source: "proactive-cloud" } }) }), { send: false, reason: "imported" });
eq("A6 blacklisted/rejected is not delivered", decide({ message: msg({ status: "rejected" }) }), { send: false, reason: "not_delivered" });
eq("A7 media messages are not text", decide({ message: msg({ mediaType: "image" }) }), { send: false, reason: "not_text" });
eq("A8 empty content", decide({ message: msg({ content: "  \n " }) }), { send: false, reason: "empty" });

eq("A9 no local user message ever: proactive", decide({ lastLocalUserAt: undefined }), { send: true, reason: "proactive" });
eq("A10 user typed an hour ago: proactive", decide({ lastLocalUserAt: NOW - 3600_000 }), { send: true, reason: "proactive" });
eq("A11 user typed 30 s ago: this is a reply, not mirrored", decide({ lastLocalUserAt: NOW - 30_000 }), { send: false, reason: "reply_to_local_user" });
eq("A12 a follow-up round is proactive even right after the user's message", decide({ lastLocalUserAt: NOW - 30_000, message: msg({ followUpIndex: 1 }) }), { send: true, reason: "proactive" });
eq("A13 the window is exactly 5 minutes", [
  decide({ lastLocalUserAt: NOW - (X.LOCAL_REPLY_WINDOW_MS - 1) }).send,
  decide({ lastLocalUserAt: NOW - X.LOCAL_REPLY_WINDOW_MS }).send,
], [false, true]);
eq("A14 'all' mirrors replies too", decide({ mode: "all", lastLocalUserAt: NOW - 1000 }), { send: true, reason: "all" });
eq("A15 'all' still refuses imported and group", [decide({ mode: "all", message: msg({ id: "imsg_cloud_x" }) }).send, decide({ mode: "all", isGroup: true }).send], [false, false]);

const many = Array.from({ length: X.MAX_MIRRORED_PER_HOUR }, (_, i) => NOW - i * 1000);
eq("A16 hourly ceiling", decide({ recentMirrorTimes: many }), { send: false, reason: "rate_limited" });
eq("A17 sends older than an hour do not count", decide({ recentMirrorTimes: many.map((t) => t - 3600_000) }).send, true);
eq("A18 modes normalise, default is proactive", [X.normalizeMirrorMode(undefined), X.normalizeMirrorMode("all"), X.normalizeMirrorMode("nope"), X.normalizeMirrorMode("off")], ["proactive", "all", "proactive", "off"]);
eq("A19 job id is deterministic and path-safe", [X.mirrorJobId("msg_1/x y"), X.mirrorJobId("msg_1/x y")], ["mirror_msg_1_x_y", "mirror_msg_1_x_y"]);

// ---- B: "the user just typed here" ---------------------------------------------------------
const hist = [
  { id: "u1", role: "user", createdAt: iso(-600_000) },
  { id: "a1", role: "assistant", createdAt: iso(-590_000) },
  { id: "imsg_cloud_9", role: "user", createdAt: iso(-10_000) },          // typed on the PHONE, does not count
  { id: "u2", role: "user", createdAt: iso(-120_000) },
  { id: "u3", role: "user", createdAt: iso(+5_000) },                       // after the message in question
  { id: "u4", role: "user", createdAt: iso(-1000), cloudSync: { source: "weixin-cloud" } },
];
eq("B1 latest LOCAL user message before the moment", X.lastLocalUserMessageAt(hist, NOW), NOW - 120_000);
eq("B2 none", X.lastLocalUserMessageAt([{ id: "a", role: "assistant", createdAt: iso(-1) }], NOW), undefined);
eq("B3 bad timestamps are ignored", X.lastLocalUserMessageAt([{ id: "u", role: "user", createdAt: "garbage" }], NOW), undefined);

// ---- C: text jobs ------------------------------------------------------------------------------------
const textJob = (over = {}) => ({ ...J.buildTextJob({ id: "mirror_m1", token: "tok-secret-1234567890", lineId: "line1", characterId: "c1", sessionId: "s1", text: "you still up?", localMessageId: "m1", now: NOW }), ...over });
let job = textJob();
eq("C1 shape", [job.kind, job.status, job.text, job.localMessageId, job.attempts], ["text", "pending", "you still up?", "m1", 0]);
yes("C2 isMediaJob accepts both kinds, rejects an unknown kind", J.isMediaJob(job) && !J.isMediaJob({ ...job, kind: "video" }));
eq("C3 text jobs expire after 30 minutes, photos after 48 hours", [J.maxAgeFor({ kind: "text" }), J.maxAgeFor({ kind: "photo" })], [30 * 60_000, 48 * 3600_000]);
const old = textJob({ createdAt: iso(-(J.TEXT_JOB_MAX_AGE_MS + 1000)) });
eq("C4 a stale text job never runs", J.selectRunnableJobs([old, textJob({ id: "fresh" })], NOW, 5).map((j) => j.id), ["fresh"]);
eq("C5 isExpired follows the kind", [J.isExpired(old, NOW), J.isExpired({ ...old, kind: "photo" }, NOW)], [true, false]);
eq("C6 a leased text job is left alone until the lease ends", [
  J.selectRunnableJobs([textJob({ status: "generating", leaseUntil: NOW + 5000, attempts: 1 })], NOW, 1).length,
  J.selectRunnableJobs([textJob({ status: "generating", leaseUntil: NOW - 1, attempts: 1 })], NOW, 1).length,
], [0, 1]);

// ---- D: delivery ------------------------------------------------------------------------------------------
const PHONE = "+15551234567";
function dworld(over = {}) {
  const store = new Map();
  const sent = [];
  if (over.noJob !== true) store.set("imessage-cloud/outbox/line1/mirror_m1.json", textJob(over.job || {}));
  const deps = {
    readJson: async (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null),
    putJson: async (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); },
    phoneForLine: async () => PHONE,
    sendText: async (phone, text) => { if (over.sendFails) throw new Error("grpc down"); sent.push([phone, text]); return "pt9"; },
    sendPhoto: async () => { throw new Error("must not be called for a text job"); },
    now: () => NOW + 1000,
  };
  return { store, sent, deps };
}
const go = (d, extra = {}) => M.sendMediaJob(d.deps, { lineId: "line1", jobId: "mirror_m1", token: "tok-secret-1234567890", ...extra });
const jobOf = (d) => d.store.get("imessage-cloud/outbox/line1/mirror_m1.json");

let d = dworld();
let r = await go(d);
eq("D1 delivered to the bound number", [r.ok, r.code, d.sent], [true, "sent", [[PHONE, "you still up?"]]]);
const rec = d.store.get("imessage-cloud/messages/line1/mirror_m1_text.json");
eq("D2 the record marks which local message it mirrors", [rec?.direction, rec?.role, rec?.content, rec?.localMessageId, rec?.platformMessageId], ["outbound", "assistant", "you still up?", "m1", "pt9"]);
eq("D3 job is marked sent", jobOf(d).status, "sent");
r = await go(d);
eq("D4 a repeat does not send twice", [r.code, d.sent.length], ["already_sent", 1]);

d = dworld();
r = await go(d, { token: "wrong" });
eq("D5 wrong token sends nothing", [r.status, r.code, d.sent.length], [403, "bad_token", 0]);
d = dworld({ job: { text: "   " } });
r = await go(d);
eq("D6 empty text is refused and the job closed", [r.status, r.code, jobOf(d).status, d.sent.length], [422, "empty_text", "failed", 0]);
d = dworld({ job: { createdAt: iso(-(J.TEXT_JOB_MAX_AGE_MS + 5000)) } });
r = await go(d);
eq("D7 a text that waited too long is not delivered", [r.status, r.code, d.sent.length], [410, "expired", 0]);
d = dworld({ sendFails: true });
r = await go(d);
eq("D8 send error: job goes back to pending with the attempt counted", [r.status, r.code, jobOf(d).status, jobOf(d).attempts], [502, "send_error", "pending", 1]);
d = dworld({ sendFails: true, job: { attempts: J.MAX_JOB_ATTEMPTS - 1 } });
r = await go(d);
eq("D9 ...and gives up after the last attempt", [jobOf(d).status, r.jobStatus], ["failed", "failed"]);
yes("D10 no record on a failed send", !d.store.has("imessage-cloud/messages/line1/mirror_m1_text.json"));
d = dworld({ job: { status: "generating", leaseUntil: NOW + 30_000, attempts: 1 } });
eq("D11 the claim made by the mirroring tab does not block its own request", (await go(d)).code, "sent");

// ---- E: what the next webhook turn sees ------------------------------------------------------------------
const tpl = { version: 1, slotToken: "T", beforeMessages: [{ role: "system", content: "SYS" }], afterMessages: [], baseHistoryLength: 0, createdAt: iso(-60_000) };
const stored = [rec];
const after = W.messagesAfterSnapshot(stored, tpl.createdAt, 20);
eq("E1 the mirrored record is newer than the snapshot, so it is replayed", after.length, 1);
const prompt = W.buildPromptFromTemplate(tpl, after, "what do you mean?");
eq("E2 the model sees its own proactive message before the user's answer", prompt.map((m) => m.content), ["SYS", "you still up?", "what do you mean?"]);
eq("E3 as an assistant turn", prompt[1].role, "assistant");

// ---- F: wiring ---------------------------------------------------------------------------------------------
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sync = read("lib/imessage-cloud-sync.ts");
yes("F1 the pull skips mirrored records", /if \(stored\.localMessageId\) \{ result\.skipped \+= 1; continue; \}/.test(sync));
yes("F2 the sync loop listens for locally pushed messages and removes the listener", /window\.addEventListener\(CHAT_MESSAGE_PUSHED_EVENT, onPushed\)/.test(sync) && /window\.removeEventListener\(CHAT_MESSAGE_PUSHED_EVENT, onPushed\)/.test(sync));
yes("F3 an existing job means 'already handled' (no second send)", /if \(await getObject\(config, mediaJobPath\(IMESSAGE_CLOUD_PREFIX, line\.id, jobId\)\)\)/.test(sync));
yes("F4 the job is claimed with a lease before the request", /status: "generating",\n\s+attempts: 1,\n\s+leaseUntil: now \+ 60_000/.test(sync));
yes("F5 the runner retries text jobs without generating anything", /if \(job\.kind === "text"\) \{\n\s+const delivery = await requestDelivery\(job\);/.test(sync));
yes("F6 the decision is made by the pure module with the per-line mode", /mode: normalizeMirrorMode\(line\.mirrorMode\)/.test(sync) && /lastLocalUserAt: lastLocalUserMessageAt\(/.test(sync));
yes("F7 settings page has the switch", /Messages the character starts in the app/.test(read("components/settings/imessage-settings.tsx")) && /Keep them in the app only/.test(read("components/settings/imessage-settings.tsx")));
yes("F8 mirrored sends keep an hourly record", /mirrorSendTimes\.set\(line\.id,/.test(sync));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
