// Fixture for the manual clock (Time Control): the pure helpers, the global Date replacement
// (driven for real, in this process), persistence, the other-tab sync, and the wiring that makes
// the app reachable. It patches this process's own Date, so it must stay a standalone script.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)));
};
const yes = (name, cond, info = "") => { cond ? pass++ : (fail++, console.log("FAIL", name, info)); };
const near = (name, got, want, tol = 250) => yes(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} +/- ${tol}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Browser stand-ins, set up before the module is first used.
const RealDate = globalThis.Date;
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
const handlers = {};
globalThis.addEventListener = (type, fn) => { (handlers[type] ||= []).push(fn); };
globalThis.dispatchEvent = () => true;

const jiti = require("jiti")(import.meta.url, { alias: { "@": path.resolve(".") } });
const C = jiti("./lib/virtual-clock.ts");
const KEY = C.VIRTUAL_CLOCK_STORAGE_KEY;

// ---- A: pure helpers ------------------------------------------------------------------------
eq("A1 garbage -> disabled", C.normalizeVirtualClockState("x"), C.DISABLED_VIRTUAL_CLOCK);
eq("A2 null -> disabled", C.normalizeVirtualClockState(null), C.DISABLED_VIRTUAL_CLOCK);
eq("A3 enabled false -> disabled", C.normalizeVirtualClockState({ enabled: false, anchorReal: 1, anchorVirtual: 2 }), C.DISABLED_VIRTUAL_CLOCK);
eq("A4 non-numeric anchor -> disabled", C.normalizeVirtualClockState({ enabled: true, anchorReal: "a", anchorVirtual: 2 }), C.DISABLED_VIRTUAL_CLOCK);
eq("A5 out of Date range -> disabled", C.normalizeVirtualClockState({ enabled: true, anchorReal: 1, anchorVirtual: 9e15 }), C.DISABLED_VIRTUAL_CLOCK);
eq("A6 valid kept", C.normalizeVirtualClockState({ enabled: true, anchorReal: 5, anchorVirtual: 9 }), { enabled: true, anchorReal: 5, anchorVirtual: 9 });
eq("A7 off -> real time", C.computeVirtualNow(C.DISABLED_VIRTUAL_CLOCK, 1234), 1234);
eq("A8 on -> keeps running", C.computeVirtualNow({ enabled: true, anchorReal: 1000, anchorVirtual: 50000 }, 1600), 50600);
eq("A9 overflow falls back to real", C.computeVirtualNow({ enabled: true, anchorReal: 0, anchorVirtual: 8.6399e15 }, 1e12), 1e12);

eq("A10 valid local input parses and round-trips", (() => {
  const ms = C.parseLocalDateTimeInput("2026-10-31", "14:05");
  return [ms !== null, C.formatLocalDateInput(ms), C.formatLocalTimeInput(ms)];
})(), [true, "2026-10-31", "14:05"]);
eq("A11 31 Feb rejected", C.parseLocalDateTimeInput("2026-02-31", "10:00"), null);
eq("A12 month 13 rejected", C.parseLocalDateTimeInput("2026-13-01", "10:00"), null);
eq("A13 hour 24 rejected", C.parseLocalDateTimeInput("2026-10-31", "24:00"), null);
eq("A14 empty rejected", C.parseLocalDateTimeInput("", ""), null);
eq("A15 before 1971 rejected", C.parseLocalDateTimeInput("1960-01-01", "10:00"), null);
eq("A16 after 2999 rejected", C.parseLocalDateTimeInput("3000-01-01", "10:00"), null);
yes("A17 leap day accepted", C.parseLocalDateTimeInput("2028-02-29", "12:00") !== null);
eq("A18 29 Feb in a common year rejected", C.parseLocalDateTimeInput("2027-02-29", "12:00"), null);
eq("A19 seconds accepted", C.formatLocalTimeInput(C.parseLocalDateTimeInput("2026-10-31", "14:05:30")), "14:05");
const H = 3600e3, D = 86400e3;
eq("A20 describe in sync", C.describeClockOffset(30e3), "in sync with real time");
eq("A21 describe ahead", C.describeClockOffset(2 * D + 3 * H), "2 days 3 hours ahead of real time");
eq("A22 describe behind singular", C.describeClockOffset(-(D + H)), "1 day 1 hour behind real time");
eq("A23 describe minutes only when under a day", C.describeClockOffset(90 * 60e3), "1 hour 30 minutes ahead of real time");
eq("A24 multi-word text survives (no whitespace stripping)", C.describeClockOffset(5 * D), "5 days ahead of real time");

// ---- B: the global Date replacement ---------------------------------------------------------
yes("B0 not patched before install", globalThis.Date === RealDate);
C.installVirtualClock();
yes("B1 install replaces Date", globalThis.Date !== RealDate);
C.installVirtualClock();
const once = globalThis.Date;
C.installVirtualClock();
yes("B2 install is idempotent", globalThis.Date === once);

near("B3 off: Date.now is the real time", Date.now(), RealDate.now());
near("B4 off: new Date() is the real time", new Date().getTime(), RealDate.now());

const target = C.parseLocalDateTimeInput("2031-03-15", "23:30");
const set = C.setVirtualTime(target);
yes("B5 setVirtualTime accepted", set && set.enabled === true);
near("B6 Date.now follows the virtual time", Date.now(), target);
near("B7 new Date() follows the virtual time", new Date().getTime(), target);
eq("B8 formatted date matches what was set", [new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()], [2031, 3, 15]);
near("B9 getAppNow agrees", C.getAppNow(), target);
near("B10 getRealNow ignores the virtual clock", C.getRealNow(), RealDate.now());

// Calls with arguments are untouched.
eq("B11 new Date(0) is the epoch", new Date(0).getTime(), 0);
eq("B12 new Date(y,m,d) is not redirected", new Date(2020, 0, 1).getFullYear(), 2020);
eq("B13 new Date(string)", new Date("2020-06-01T00:00:00Z").toISOString(), "2020-06-01T00:00:00.000Z");
eq("B14 Date.UTC passes through", Date.UTC(2020, 0, 1), RealDate.UTC(2020, 0, 1));
eq("B15 Date.parse passes through", Date.parse("2020-01-01T00:00:00Z"), RealDate.parse("2020-01-01T00:00:00Z"));
eq("B16 new Date(undefined) stays an invalid date, like the real one", Number.isNaN(new Date(undefined).getTime()), true);

// Identity checks other code relies on.
yes("B17 new Date() instanceof Date", new Date() instanceof Date);
yes("B18 a real Date instance is instanceof Date", new RealDate(5) instanceof Date);
yes("B19 constructor comparison holds", new Date().constructor === Date);
eq("B20 Date() without new is a string", typeof Date(), "string");
eq("B21 toString tag", Object.prototype.toString.call(new Date()), "[object Date]");
eq("B22 JSON round trip", JSON.parse(JSON.stringify({ at: new Date(86400000) })).at, "1970-01-02T00:00:00.000Z");
class Sub extends Date {}
const sub = new Sub();
yes("B23 subclass is a Sub and a Date", sub instanceof Sub && sub instanceof Date);
near("B24 subclass zero-arg follows the virtual time", sub.getTime(), target);

// The clock keeps running from the anchor.
const before = Date.now();
await sleep(120);
const after = Date.now();
yes("B25 virtual time advances with real time", after - before >= 100 && after - before < 400, `advanced ${after - before}`);
yes("B26 two reads are not frozen together", new Date().getTime() >= before);

// ---- C: changing the clock ------------------------------------------------------------------
const base = Date.now();
C.shiftVirtualTime(2 * D);
near("C1 shift forward from the current virtual time", Date.now(), base + 2 * D);
C.shiftVirtualTime(-5 * H);
near("C2 shift back", Date.now(), base + 2 * D - 5 * H);
near("C3 offset reports virtual minus real", C.getVirtualClockOffset(), (base + 2 * D - 5 * H) - RealDate.now());

const keep = JSON.stringify(C.getVirtualClockState());
eq("C4 out of range target rejected", C.setVirtualTime(Date.UTC(3500, 0, 1)), null);
eq("C5 NaN target rejected", C.setVirtualTime(NaN), null);
eq("C6 state untouched by a rejected set", JSON.stringify(C.getVirtualClockState()), keep);
eq("C7 shift out of range rejected", C.shiftVirtualTime(1000 * 365 * D), null);
eq("C8 state untouched by a rejected shift", JSON.stringify(C.getVirtualClockState()), keep);

// ---- D: persistence, listeners, other tabs ---------------------------------------------------
yes("D1 state saved to storage", store.has(KEY));
const saved = JSON.parse(store.get(KEY));
eq("D2 saved state reloads identically", C.normalizeVirtualClockState(saved), C.getVirtualClockState());

let calls = 0;
const stop = C.subscribeVirtualClock(() => { calls++; });
C.setVirtualTime(target);
eq("D3 listener told about a change", calls, 1);
stop();
C.setVirtualTime(target);
eq("D4 unsubscribed listener not called again", calls, 1);
C.subscribeVirtualClock(() => { throw new Error("boom"); });
let survived = true;
try { C.setVirtualTime(target); } catch { survived = false; }
yes("D5 a throwing listener does not break the change", survived);

// Another tab writes a new state, then fires `storage`.
yes("D6 storage listener registered", (handlers.storage || []).length === 1);
const otherTarget = C.parseLocalDateTimeInput("2040-01-02", "03:04");
store.set(KEY, JSON.stringify({ enabled: true, anchorReal: RealDate.now(), anchorVirtual: otherTarget }));
handlers.storage[0]({ key: KEY });
near("D7 follows another tab's change", Date.now(), otherTarget);
store.set(KEY, JSON.stringify({ enabled: true, anchorReal: RealDate.now(), anchorVirtual: target }));
handlers.storage[0]({ key: "some_other_key" });
near("D8 ignores unrelated storage keys", Date.now(), otherTarget);
store.delete(KEY);
handlers.storage[0]({ key: KEY });
near("D9 another tab resetting turns the clock off here", Date.now(), RealDate.now());

// ---- E: reset -------------------------------------------------------------------------------
C.setVirtualTime(target);
C.resetVirtualClock();
near("E1 reset returns to real time (Date.now)", Date.now(), RealDate.now());
near("E2 reset returns to real time (new Date)", new Date().getTime(), RealDate.now());
yes("E3 reset clears storage", !store.has(KEY));
eq("E4 offset is zero after reset", Math.abs(C.getVirtualClockOffset()) < 5, true);

// Storage that throws must not break the clock.
const goodSet = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new Error("quota"); };
const blocked = C.setVirtualTime(target);
yes("E5 clock still works when storage throws", blocked && Math.abs(Date.now() - target) < 250);
globalThis.localStorage.setItem = goodSet;
C.resetVirtualClock();

// ---- F: wiring ------------------------------------------------------------------------------
const read = p => fs.readFileSync(p, "utf8");
const layout = read("app/layout.tsx");
yes("F1 layout renders the bootstrap", /<VirtualClockBootstrap \/>/.test(layout));
yes("F2 the bootstrap is the first thing in <body>", /<body>\s*<VirtualClockBootstrap \/>/.test(layout));
const boot = read("components/virtual-clock-bootstrap.tsx");
yes("F3 bootstrap installs at module load, only in a browser", /if \(typeof window !== "undefined"\) \{\s*installVirtualClock\(\);\s*\}/.test(boot));
const cfg = read("lib/desktop-config.ts");
yes("F4 icon id registered", /\| "timecontrol"/.test(cfg) && /timecontrol: \{ id: "timecontrol"/.test(cfg));
yes("F5 icon is on a default page", /PAGE_2_DEFAULT[^;]*"timecontrol"/s.test(cfg));
yes("F6 page 3 untouched (a 5th icon would get a negative column)", /PAGE_3_DEFAULT: IconId\[\] = \["worldbuilder", "mixology", "studio", "review"\]/.test(cfg));
yes("F7 glyph mapped", /timecontrol: mdiClockEditOutline/.test(read("components/icon-glyph.tsx")));
const shell = read("components/desktop-shell.tsx");
yes("F8 shell imports and opens the app", /import \{ TimeControlApp \}/.test(shell) && /activeApp === "timecontrol"/.test(shell));
yes("F9 the app file exists", fs.existsSync("components/time-control/time-control-app.tsx"));
const lib = read("lib/virtual-clock.ts");
yes("F10 never offers a frozen mode (it would give every message one timestamp)", !/frozen|freeze/i.test(lib.replace(/\/\/.*$/gm, "")));
yes("F11 no control characters in new files", ["lib/virtual-clock.ts", "components/virtual-clock-bootstrap.tsx", "components/time-control/time-control-app.tsx"].every(f => {
  const b = fs.readFileSync(f);
  for (const c of b) if (c < 9 || (c > 13 && c < 32) || c === 127) return false;
  return true;
}));

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
