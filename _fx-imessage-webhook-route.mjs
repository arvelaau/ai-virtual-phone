// Route-level fixture for app/api/imessage/webhook/route.ts: everything that happens
// BEFORE the work is handed to after(). Photon's signature scheme is reproduced here, the
// real route runs, and only the outbound fetch (Supabase) is replaced.
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };

const SECRET = "whsec_fixture_secret_64_chars_long_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT_SECRET = "proj-secret-should-never-leak";
process.env.PHOTON_PROJECT_ID = "proj_1";
process.env.PHOTON_PROJECT_SECRET = PROJECT_SECRET;
process.env.PHOTON_WEBHOOK_SECRET = SECRET;
process.env.IMESSAGE_SUPABASE_URL = "https://example.supabase.co";
process.env.IMESSAGE_SUPABASE_SERVICE_ROLE_KEY = "service-role-should-never-leak";

// fake Supabase storage
const store = new Map();
let fetchCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  fetchCalls += 1;
  const u = String(url);
  const obj = u.split("/storage/v1/object/ai-phone-backup/")[1];
  if (!obj) return new Response("[]", { status: 200 });
  if ((init.method || "GET") === "GET") {
    return store.has(obj) ? new Response(store.get(obj), { status: 200 }) : new Response("{}", { status: 400 });
  }
  store.set(obj, String(init.body));
  return new Response("{}", { status: 200 });
};

const route = jiti("./app/api/imessage/webhook/route.ts");
const URL_ = "https://app.example/api/imessage/webhook";

function signed(bodyObjOrText, { secret = SECRET, ts = String(Math.floor(Date.now() / 1000)), signature = true } = {}) {
  const raw = typeof bodyObjOrText === "string" ? bodyObjOrText : JSON.stringify(bodyObjOrText);
  const headers = { "content-type": "application/json" };
  if (signature) {
    headers["x-spectrum-timestamp"] = ts;
    headers["x-spectrum-signature"] = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
  }
  return new Request(URL_, { method: "POST", headers, body: raw });
}
const traces = () => JSON.parse(store.get("imessage-cloud/debug/events.json") ?? "[]");
const post = async (req) => { const r = await route.POST(req); return { status: r.status, body: await r.json().catch(() => ({})) }; };

// 1. environment
const savedSecret = process.env.PHOTON_WEBHOOK_SECRET;
delete process.env.PHOTON_WEBHOOK_SECRET;
let r = await post(signed({ event: "messages" }));
eq("A1 missing webhook secret -> 503", [r.status, r.body.error], [503, "missing_photon_env"]);
process.env.PHOTON_WEBHOOK_SECRET = savedSecret;
const savedUrl = process.env.IMESSAGE_SUPABASE_URL;
delete process.env.IMESSAGE_SUPABASE_URL;
r = await post(signed({ event: "messages" }));
eq("A2 missing supabase env -> 503", [r.status, r.body.error], [503, "missing_supabase_env"]);
process.env.IMESSAGE_SUPABASE_URL = savedUrl;

// 2. signature, verified BEFORE anything is acknowledged
store.clear();
r = await post(signed({ event: "messages", message: { id: "m1" } }, { signature: false }));
eq("B1 no signature headers -> 400", r.status, 400);
eq("B2 recorded as a signature rejection", [traces()[0]?.result, traces()[0]?.reason], ["rejected", "signature_rejected"]);

store.clear();
r = await post(signed({ event: "messages", message: { id: "m1" } }, { secret: "a-different-secret" }));
eq("B3 wrong secret -> 401", r.status, 401);
eq("B4 the trace names the reason", traces()[0]?.detail, "signature-mismatch");

store.clear();
r = await post(signed({ event: "messages", message: { id: "m1" } }, { ts: "1000" }));
eq("B5 stale timestamp -> 401", r.status, 401);
eq("B6 reason is expiry", traces()[0]?.detail, "expired");

// 3. payload shape
store.clear();
r = await post(signed("not json at all {"));
eq("C1 malformed body -> 400", [r.status, r.body.error], [400, "malformed_payload"]);
eq("C2 recorded", traces()[0]?.reason, "malformed_payload");

store.clear();
r = await post(signed({ event: "typing", space: { id: "x" } }));
eq("C3 a non-message event is acknowledged, not errored", [r.status, r.body.ok], [200, true]);
eq("C4 recorded as ignored with the event name", [traces()[0]?.result, traces()[0]?.reason, traces()[0]?.detail], ["ignored", "no_message", 'event "typing"']);

// 4. nothing sensitive is ever persisted or returned
const persisted = JSON.stringify([...store.entries()]);
yes("D1 project secret not in storage", !persisted.includes(PROJECT_SECRET));
yes("D2 service role key not in storage", !persisted.includes("service-role-should-never-leak"));
yes("D3 webhook secret not in storage", !persisted.includes(SECRET));

// 5. the trace is capped, newest first
store.clear();
for (let i = 0; i < 20; i += 1) await post(signed({ event: "typing", n: i }));
eq("D4 the persisted trace is capped", traces().length, 15);

// 6. structure: delivery is handed to after() only AFTER verification, and the route
//    acknowledges instead of awaiting the model.
const src = fs.readFileSync("app/api/imessage/webhook/route.ts", "utf8");
const iVerify = src.indexOf("verifySpectrumSignature({");
const iAfter = src.indexOf("after(async");
yes("E1 the signature is checked before work is scheduled", iVerify > 0 && iAfter > iVerify, `${iVerify} ${iAfter}`);
yes("E2 the work is not awaited inline by the request", !/await processDelivery\(delivery\)\s*;?\s*\n\s*return NextResponse/.test(src));
yes("E3 a bounded wait for the SDK to deliver exists", /SDK_DELIVERY_WAIT_MS/.test(src) && /sdk_never_delivered/.test(src));
yes("E4 the old single-tick wait is gone", !/setTimeout\(resolve, 0\)/.test(src));

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
