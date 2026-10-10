// Fixture for lib/imessage-photon-admin.ts + app/api/imessage/enroll/route.ts.
// The route is driven for real; only the outbound Photon fetch is replaced.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};

const lib = jiti("./lib/imessage-photon-admin.ts");

// A: pure helpers
eq("A1 normalize", lib.normalizePhoneE164("+1 (555) 123-4567"), "+15551234567");
eq("A2 adds plus", lib.normalizePhoneE164("8613800138000"), "+8613800138000");
eq("A3 empty", lib.normalizePhoneE164(""), "");
eq("A4 e164 ok", lib.isE164("+15551234567"), true);
eq("A5 e164 too short", lib.isE164("+12345"), false);
eq("A6 e164 leading zero", lib.isE164("+0551234567"), false);
eq("A7 email is not a phone", lib.isE164(lib.normalizePhoneE164("a@b.com")), false);
const body = { succeed: true, data: { users: [
  { id: "u1", phoneNumber: "+15551234567", assignedPhoneNumber: "+19998887777" },
  { id: "u2", phoneNumber: "+442071838750", assignedPhoneNumber: "" },
], total: 2 } };
const users = lib.parseUsersResponse(body);
eq("A8 parse count", users?.length, 2);
eq("A9 bare array shape", lib.parseUsersResponse({ data: [{ id: "x", phoneNumber: "+1", assignedPhoneNumber: "+2" }] })?.length, 1);
eq("A10 unknown shape -> null (not 'nobody registered')", lib.parseUsersResponse({ data: { users: "no" } }), null);
eq("A11 non-object -> null", lib.parseUsersResponse(null), null);
eq("A12 registered", lib.summarizeEnrollment(users, "+1 555 123 4567").state, "registered");
eq("A13 line returned", lib.summarizeEnrollment(users, "+15551234567").assignedPhoneNumber, "+19998887777");
eq("A14 user without line", lib.summarizeEnrollment(users, "+442071838750").state, "registered_without_line");
eq("A15 not registered", lib.summarizeEnrollment(users, "+19990000000").state, "not_registered");
eq("A16 409 message", /already registered/.test(lib.describePhotonError(409)), true);
eq("A17 401 message", /credentials/.test(lib.describePhotonError(401)), true);

// B: the route, with Photon replaced
const SECRET = "sekrit-project-secret-XYZ";
const PID = "proj_123";
process.env.PHOTON_PROJECT_ID = PID;
process.env.PHOTON_PROJECT_SECRET = SECRET;
process.env.APP_MARKET_ADMIN_KEY = "owner-key";
delete process.env.NEXT_PUBLIC_SELF_HOSTED_MODE;

let calls = [];
let photon = { users: [], enrollStatus: 200, listStatus: 200 };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || "GET", headers: init.headers, body: init.body });
  const method = init.method || "GET";
  if (method === "GET") {
    if (photon.listStatus !== 200) return new Response(JSON.stringify({ message: "nope" }), { status: photon.listStatus });
    return new Response(JSON.stringify({ data: { users: photon.users, total: photon.users.length } }), { status: 200 });
  }
  if (photon.enrollStatus !== 200) return new Response(JSON.stringify({ message: "taken" }), { status: photon.enrollStatus });
  const created = { id: "new", phoneNumber: JSON.parse(init.body).phoneNumber, assignedPhoneNumber: "+17770001111" };
  photon.users.push(created);
  return new Response(JSON.stringify({ data: created }), { status: 200 });
};

const route = jiti("./app/api/imessage/enroll/route.ts");
const U = "http://x/api/imessage/enroll";
const admin = { "x-app-market-admin-key": "owner-key" };
const get = (q = "", headers = admin) => route.GET(new Request(`${U}${q}`, { headers }));
const post = (b, headers = admin) => route.POST(new Request(U, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(b) }));
const json = async (r) => ({ status: r.status, ...(await r.json()) });
const photonPosts = () => calls.filter((c) => c.method === "POST").length;

let r;
// access gate
calls = [];
r = await json(await get("?phone=%2B15551234567", {}));
eq("B1 no admin -> 403", r.status, 403);
eq("B2 forbidden never reaches Photon", calls.length, 0);
r = await json(await post({ phone: "+15551234567" }, { "x-app-market-admin-key": "wrong" }));
eq("B3 wrong key -> 403", r.status, 403);
eq("B4 wrong key never reaches Photon", calls.length, 0);

// missing env
const saved = process.env.PHOTON_PROJECT_SECRET;
delete process.env.PHOTON_PROJECT_SECRET;
r = await json(await get("?phone=%2B15551234567"));
eq("B5 missing env -> 503", r.status, 503);
eq("B6 missing env flag", r.configured, false);
process.env.PHOTON_PROJECT_SECRET = saved;

// status
photon = { users: [{ id: "u1", phoneNumber: "+15551234567", assignedPhoneNumber: "+19998887777" }], enrollStatus: 200, listStatus: 200 };
calls = [];
r = await json(await get("?phone=%2B1%20555%20123%204567"));
eq("B7 registered status", [r.status, r.state, r.assignedPhoneNumber], [200, "registered", "+19998887777"]);
eq("B8 status is read-only", photonPosts(), 0);
eq("B9 basic auth sent", /^Basic /.test(String(calls[0].headers.Authorization)), true);
r = await json(await get("?phone=%2B19990000000"));
eq("B10 not registered", r.state, "not_registered");
r = await json(await get("?phone=12"));
eq("B11 bad phone -> 400", r.status, 400);
r = await json(await get(""));
eq("B12 no phone -> credentials probe", [r.status, r.credentialsValid], [200, true]);

// enroll
calls = [];
r = await json(await post({ phone: "+15551234567" }));
eq("B13 already registered -> idempotent", [r.status, r.alreadyRegistered, r.assignedPhoneNumber], [200, true, "+19998887777"]);
eq("B14 idempotent costs no quota (no POST to Photon)", photonPosts(), 0);
calls = [];
r = await json(await post({ phone: "+19990000000" }));
eq("B15 new number enrolled", [r.status, r.alreadyRegistered, r.assignedPhoneNumber], [200, false, "+17770001111"]);
eq("B16 exactly one creation", photonPosts(), 1);
eq("B17 creation body is shared + E.164", JSON.parse(calls.find((c) => c.method === "POST").body), { type: "shared", phoneNumber: "+19990000000" });
calls = [];
r = await json(await post({ phone: "+19990000000" }));
eq("B18 pressing again is free", [r.alreadyRegistered, photonPosts()], [true, 0]);
r = await json(await post({ phone: "nope" }));
eq("B19 invalid body -> 400", r.status, 400);
r = await json(await post({}));
eq("B20 missing phone -> 400", r.status, 400);

// Photon failures
photon = { users: [], enrollStatus: 409, listStatus: 200 };
r = await json(await post({ phone: "+15550001111" }));
eq("B21 409 passes through", r.status, 409);
photon = { users: [], enrollStatus: 200, listStatus: 401 };
r = await json(await get("?phone=%2B15550001111"));
eq("B22 OUR bad credentials is a 502, not a 401 for the caller", r.status, 502);
photon = { users: [], enrollStatus: 200, listStatus: 429 };
r = await json(await get("?phone=%2B15550001111"));
eq("B23 429 passes through", r.status, 429);
globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
r = await json(await get("?phone=%2B15550001111"));
eq("B24 network failure -> 502 with a message", [r.status, typeof r.message], [502, "string"]);

// secrets never leak
const everything = JSON.stringify([r]);
eq("B25 secret not in a response", everything.includes(SECRET), false);
globalThis.fetch = async () => new Response(JSON.stringify({ data: { users: [], total: 0 } }), { status: 200 });
const sample = await (await post({ phone: "+19995550000" })).text();
eq("B26 secret not in a success body", sample.includes(SECRET), false);
eq("B27 project id not echoed either", sample.includes(PID), false);

// self-hosted instances are the owner's by definition
process.env.NEXT_PUBLIC_SELF_HOSTED_MODE = "1";
photon = { users: [], enrollStatus: 200, listStatus: 200 };
globalThis.fetch = async (url, init = {}) => new Response(JSON.stringify({ data: { users: [], total: 0 } }), { status: 200 });
r = await json(await get("?phone=%2B15551234567", {}));
eq("B28 self-hosted needs no key", r.status, 200);

console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
