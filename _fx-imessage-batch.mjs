// Fixture for the quiet window: several bubbles in a row must produce ONE reply.
// Each inbound message runs as its own concurrent "invocation" against a shared fake store
// and a fake clock, exactly like separate serverless functions would.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const H = jiti("./lib/imessage-webhook-handler.ts");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const PHONE = "+15551234567";
const tpl = { version: 1, slotToken: "T", beforeMessages: [], afterMessages: [], baseHistoryLength: 0, createdAt: "" };

function world(delaySeconds) {
  const store = new Map();
  store.set("imessage-cloud/index.json", { format: "x", version: 1, updatedAt: "", lines: [{ lineId: "line1", phone: PHONE, characterId: "c1", characterName: "Mira", sessionId: "s1", path: "imessage-cloud/runtime/line1.json", updatedAt: "" }] });
  store.set("imessage-cloud/runtime/line1.json", {
    format: "x", version: 1, createdAt: "", line: { id: "line1", phone: PHONE, characterId: "c1", enabled: true, ...(delaySeconds === undefined ? {} : { replyDelaySeconds: delaySeconds }) },
    apiConfig: { enableImageRecognition: true }, promptTemplate: tpl,
  });
  const w = { store, sent: [], gen: [], t: 1_000_000, sleeps: 0 };
  // Cooperative scheduler: sleep() yields so other invocations can run, and time only
  // advances when everybody is asleep -- a stand-in for real concurrent functions.
  w.waiters = [];
  w.deps = {
    readJson: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    putJson: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
    listRecentStored: async () => [...store.entries()].filter(([k]) => k.includes("/messages/")).map(([, v]) => v),
    generate: async (_s, text, history, images) => { w.gen.push({ text, history: history.map((m) => m.content), images: images ?? [] }); return "Got all of that"; },
    send: async (text) => { w.sent.push(text); return "p" + w.sent.length; },
    now: () => w.t,
    sleep: (ms) => new Promise((resolve) => { w.sleeps += 1; w.waiters.push({ at: w.t + ms, resolve }); }),
  };
  return w;
}
const input = (id, text, extra = {}) => ({ messageId: id, senderId: PHONE, spaceId: "iMessage;-;" + PHONE, direction: "inbound", contentType: "text", text, ...extra });

/** Runs invocations that start at given offsets (ms) and drives the fake clock until all finish. */
async function run(w, arrivals) {
  const results = new Array(arrivals.length);
  const pending = arrivals.map(([at, inp], i) => ({ at, inp, i, started: false }));
  const finished = new Set();
  const tick = () => new Promise((r) => setImmediate(r));
  const t0 = w.t;
  for (let guard = 0; guard < 5000 && finished.size < arrivals.length; guard += 1) {
    for (const p of pending) {
      if (!p.started && w.t - t0 >= p.at) {
        p.started = true;
        H.handleInboundMessage(w.deps, p.inp).then((r) => { results[p.i] = r; finished.add(p.i); });
      }
    }
    for (let k = 0; k < 6; k += 1) await tick();
    if (finished.size >= arrivals.length) break;
    const nextWake = w.waiters.length ? Math.min(...w.waiters.map((x) => x.at)) : Infinity;
    const nextArrival = Math.min(...pending.filter((p) => !p.started).map((p) => t0 + p.at), Infinity);
    const target = Math.min(nextWake, nextArrival);
    if (!Number.isFinite(target)) break;
    w.t = Math.max(w.t, target);
    const due = w.waiters.filter((x) => x.at <= w.t);
    w.waiters = w.waiters.filter((x) => x.at > w.t);
    due.forEach((x) => x.resolve());
  }
  return results;
}

// ---- A: delay resolution --------------------------------------------------------------------
eq("A1 unset -> 60 s default", H.replyDelayMs({}), 60_000);
eq("A2 0 -> immediate", H.replyDelayMs({ replyDelaySeconds: 0 }), 0);
eq("A3 above the ceiling is clamped", H.replyDelayMs({ replyDelaySeconds: 9999 }), H.MAX_REPLY_DELAY_SECONDS * 1000);
eq("A4 negative is immediate", H.replyDelayMs({ replyDelaySeconds: -5 }), 0);
eq("A5 garbage -> default", H.replyDelayMs({ replyDelaySeconds: "x" }), 60_000);
eq("A6 no line -> default", H.replyDelayMs(undefined), 60_000);

// ---- B: a burst gets one reply -------------------------------------------------------------
let w = world(60);
let res = await run(w, [[0, input("m1", "hey")], [5_000, input("m2", "are you there")], [12_000, input("m3", "i need to tell you something")]]);
eq("B1 exactly one model call", w.gen.length, 1);
eq("B2 exactly one reply sent", w.sent, ["Got all of that"]);
eq("B3 the model saw all three bubbles in order", w.gen[0].text, "hey\nare you there\ni need to tell you something");
eq("B4 the two earlier invocations stepped aside", res.slice(0, 2).map((r) => [r.result, r.reason]), [["ignored", "batched"], ["ignored", "batched"]]);
eq("B5 the last one replied", [res[2].result, res[2].reason], ["replied", "replied"]);
yes("B6 trace says how many were answered together", /answered 3 messages together/.test(res[2].detail ?? ""), res[2].detail);
yes("B7 the reply came only after the quiet window", w.t - 1_000_000 >= 12_000 + 60_000, String(w.t - 1_000_000));

// ---- C: the window is measured from the LAST message ---------------------------------------
w = world(60);
res = await run(w, [[0, input("m1", "one")], [50_000, input("m2", "two")]]);
eq("C1 a message at 50 s restarts the wait: still one reply", w.sent.length, 1);
yes("C2 ...which came at least 60 s after the second message", w.t - 1_000_000 >= 50_000 + 60_000, String(w.t - 1_000_000));

// ---- D: a late message after the reply starts a new turn ----------------------------------
w = world(30);
res = await run(w, [[0, input("m1", "first")], [200_000, input("m2", "later")]]);
eq("D1 two separate turns", w.gen.length, 2);
eq("D2 the second turn is only the new message", w.gen[1].text, "later");
yes("D3 the earlier exchange is history, not re-batched", w.gen[1].history.includes("first") && w.gen[1].history.includes("Got all of that"), JSON.stringify(w.gen[1].history));
eq("D4 both replied", res.map((r) => r.result), ["replied", "replied"]);

// ---- E: photos in a burst -------------------------------------------------------------------
w = world(30);
res = await run(w, [
  [0, input("m1", "look", { contentType: "image", image: { mimeType: "image/png", dataBase64: "QQ==" } })],
  [4_000, input("m2", "and this", { contentType: "image", image: { mimeType: "image/png", dataBase64: "Qg==" } })],
]);
eq("E1 both photos reach the model in one request", w.gen[0].images.map((i) => i.dataBase64), ["QQ==", "Qg=="]);
eq("E2 and one reply", w.sent.length, 1);

// ---- F: instant mode is untouched ----------------------------------------------------------
w = world(0);
res = await run(w, [[0, input("m1", "one")], [1_000, input("m2", "two")]]);
eq("F1 delay 0: each message answered on its own", w.gen.map((g) => g.text), ["one", "two"]);
eq("F2 ...and never sleeps", w.sleeps, 0);

// ---- G: failures --------------------------------------------------------------------------
w = world(30);
w.deps.generate = async () => { throw new Error("boom"); };
res = await run(w, [[0, input("m1", "a")], [3_000, input("m2", "b")]]);
eq("G1 a failed model call is reported by the answering invocation", [res[1].result, res[1].reason], ["error", "llm_error"]);
eq("G2 nothing is sent", w.sent.length, 0);

// ---- H: records ---------------------------------------------------------------------------
w = world(30);
await run(w, [[0, input("m1", "a", { contentType: "image", image: { mimeType: "image/png", dataBase64: "QQ==" } })], [2_000, input("m2", "b")]]);
const outs = [...w.store.entries()].filter(([k]) => k.includes("/messages/")).map(([, v]) => v).filter((m) => m.direction === "outbound");
yes("H1 the reply never inherits the photo", outs.length > 0 && outs.every((m) => !m.image), JSON.stringify(outs));
yes("H2 every inbound message is stored", ["m1", "m2"].every((id) => [...w.store.keys()].some((k) => k.endsWith(`${id}.json`) && k.includes("/messages/"))));

// ---- I: wiring ----------------------------------------------------------------------------
const route = fs.readFileSync("app/api/imessage/webhook/route.ts", "utf8");
yes("I1 route gives the handler a real sleep", /sleep: \(ms\) => new Promise/.test(route));
yes("I2 model deadline shrinks by the time already spent waiting", /LLM_DEADLINE_MS - \(Date\.now\(\) - startedAt\)/.test(route));
const ui = fs.readFileSync("components/settings/imessage-settings.tsx", "utf8");
yes("I3 settings page exposes the quiet window", /replyDelaySeconds/.test(ui));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
