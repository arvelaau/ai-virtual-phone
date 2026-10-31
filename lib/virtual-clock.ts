// lib/virtual-clock.ts
// A manual clock for the whole app. The user sets a date and time once, and from then on every
// "what time is it" question inside the app (chat timestamps, story, calendar, the time shown to
// the model, follow-up timers...) gets the virtual answer, with no need to touch the phone's
// own clock.
//
// How: the app reads the time through `Date.now()` / `new Date()` in roughly a thousand places,
// so rather than touching each one, `installVirtualClock()` replaces the global `Date` with a
// proxy. Calls with arguments (`new Date(2026, 0, 1)`, `Date.parse(...)`) pass straight through to
// the real Date; only the "no arguments" forms and `Date.now()` are redirected.
//
// The clock keeps RUNNING from the chosen moment (anchor pair: the real instant when it was set
// and the virtual instant it was set to). It is deliberately never frozen: a frozen clock gives
// every message the same timestamp, which scrambles chat ordering.
//
// Not affected: the real server (iMessage webhook etc.), sandboxed iframes (HTML cards, custom
// apps), and `performance.now()` / timer durations, which are elapsed time, not wall-clock time.

export type VirtualClockState = {
  enabled: boolean;
  /** Real instant (ms since epoch) at which the virtual time was set. */
  anchorReal: number;
  /** Virtual instant (ms since epoch) the clock was set to at that moment. */
  anchorVirtual: number;
};

export const VIRTUAL_CLOCK_STORAGE_KEY = "ai_phone_virtual_clock_v1";
export const VIRTUAL_CLOCK_EVENT = "ai-phone-virtual-clock-changed";

/** Earliest and latest instants the picker accepts (1971-01-01 .. 2999-12-31, UTC). */
export const VIRTUAL_CLOCK_MIN_MS = Date.UTC(1971, 0, 1);
export const VIRTUAL_CLOCK_MAX_MS = Date.UTC(2999, 11, 31, 23, 59, 59);

const MAX_DATE_MS = 8.64e15;
const HOLDER_KEY = "__aiPhoneVirtualClock";

export const DISABLED_VIRTUAL_CLOCK: VirtualClockState = { enabled: false, anchorReal: 0, anchorVirtual: 0 };

type Holder = {
  state: VirtualClockState;
  RealDate: DateConstructor;
  listeners: Set<() => void>;
  installed: boolean;
  storageListening: boolean;
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (no globals, so they can be tested directly)
// ---------------------------------------------------------------------------------------------

export function normalizeVirtualClockState(raw: unknown): VirtualClockState {
  if (!raw || typeof raw !== "object") return DISABLED_VIRTUAL_CLOCK;
  const value = raw as Record<string, unknown>;
  const anchorReal = Number(value.anchorReal);
  const anchorVirtual = Number(value.anchorVirtual);
  if (value.enabled !== true) return DISABLED_VIRTUAL_CLOCK;
  if (!Number.isFinite(anchorReal) || !Number.isFinite(anchorVirtual)) return DISABLED_VIRTUAL_CLOCK;
  if (Math.abs(anchorVirtual) > MAX_DATE_MS) return DISABLED_VIRTUAL_CLOCK;
  return { enabled: true, anchorReal, anchorVirtual };
}

/** The virtual "now" for a given real "now". With the clock off this is the real time. */
export function computeVirtualNow(state: VirtualClockState, realNow: number): number {
  if (!state.enabled) return realNow;
  const value = state.anchorVirtual + (realNow - state.anchorReal);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_DATE_MS) return realNow;
  return value;
}

export function isValidVirtualTarget(ms: number): boolean {
  return Number.isFinite(ms) && ms >= VIRTUAL_CLOCK_MIN_MS && ms <= VIRTUAL_CLOCK_MAX_MS;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** "YYYY-MM-DD" in the device's own time zone, for <input type="date">. */
export function formatLocalDateInput(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "HH:mm" in the device's own time zone, for <input type="time">. */
export function formatLocalTimeInput(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Turn the values of a date input and a time input (device time zone) into an instant.
 * Returns null for anything that is not a real calendar moment, e.g. 2026-02-31.
 */
export function parseLocalDateTimeInput(dateText: string, timeText: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateText || "").trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((timeText || "").trim());
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  // A date like 31 Feb rolls over into March; reject it instead of silently picking another day.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const ms = date.getTime();
  return isValidVirtualTarget(ms) ? ms : null;
}

/** "2 days 3 hours ahead of real time", "behind", or "in sync". */
export function describeClockOffset(offsetMs: number): string {
  const abs = Math.abs(offsetMs);
  if (abs < 60_000) return "in sync with real time";
  const totalMinutes = Math.floor(abs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes && days === 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  return `${parts.join(" ")} ${offsetMs > 0 ? "ahead of" : "behind"} real time`;
}

// ---------------------------------------------------------------------------------------------
// Shared state. It lives on the global object so a hot-reloaded copy of this module (dev) and
// the installed Date proxy always read the same clock.
// ---------------------------------------------------------------------------------------------

function readStoredState(g: typeof globalThis): VirtualClockState {
  try {
    const raw = g.localStorage?.getItem(VIRTUAL_CLOCK_STORAGE_KEY);
    if (!raw) return DISABLED_VIRTUAL_CLOCK;
    return normalizeVirtualClockState(JSON.parse(raw));
  } catch {
    return DISABLED_VIRTUAL_CLOCK;
  }
}

function getHolder(g: typeof globalThis = globalThis): Holder {
  const store = g as unknown as Record<string, Holder | undefined>;
  let holder = store[HOLDER_KEY];
  if (!holder) {
    holder = {
      state: readStoredState(g),
      RealDate: g.Date,
      listeners: new Set(),
      installed: false,
      storageListening: false,
    };
    store[HOLDER_KEY] = holder;
  }
  return holder;
}

function notify(holder: Holder, g: typeof globalThis) {
  holder.listeners.forEach(listener => {
    try {
      listener();
    } catch {
      // one broken subscriber must not stop the rest
    }
  });
  try {
    g.dispatchEvent?.(new Event(VIRTUAL_CLOCK_EVENT));
  } catch {
    // no event system (tests, server)
  }
}

function commit(next: VirtualClockState): VirtualClockState {
  const g = globalThis;
  const holder = getHolder(g);
  holder.state = next;
  try {
    if (next.enabled) g.localStorage?.setItem(VIRTUAL_CLOCK_STORAGE_KEY, JSON.stringify(next));
    else g.localStorage?.removeItem(VIRTUAL_CLOCK_STORAGE_KEY);
  } catch {
    // storage blocked: the clock still works for this page load
  }
  notify(holder, g);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** The real wall-clock time, ignoring the virtual clock. */
export function getRealNow(): number {
  return getHolder().RealDate.now();
}

/** The time the app should treat as "now" (virtual if set, otherwise real). */
export function getAppNow(): number {
  const holder = getHolder();
  return computeVirtualNow(holder.state, holder.RealDate.now());
}

export function getVirtualClockState(): VirtualClockState {
  return getHolder().state;
}

/** Virtual time minus real time, in ms. 0 when the clock is off. */
export function getVirtualClockOffset(): number {
  const holder = getHolder();
  const real = holder.RealDate.now();
  return computeVirtualNow(holder.state, real) - real;
}

/** Make the app's "now" equal `targetMs` from this moment on (the clock keeps running). */
export function setVirtualTime(targetMs: number): VirtualClockState | null {
  if (!isValidVirtualTarget(targetMs)) return null;
  return commit({ enabled: true, anchorReal: getRealNow(), anchorVirtual: Math.round(targetMs) });
}

/** Move the app's "now" by `deltaMs`, starting from whatever it currently is. */
export function shiftVirtualTime(deltaMs: number): VirtualClockState | null {
  if (!Number.isFinite(deltaMs)) return null;
  return setVirtualTime(getAppNow() + deltaMs);
}

/** Back to the device's real time. */
export function resetVirtualClock(): VirtualClockState {
  return commit(DISABLED_VIRTUAL_CLOCK);
}

export function subscribeVirtualClock(listener: () => void): () => void {
  const holder = getHolder();
  holder.listeners.add(listener);
  return () => {
    holder.listeners.delete(listener);
  };
}

function createVirtualDate(holder: Holder): DateConstructor {
  const Real = holder.RealDate;
  const now = () => computeVirtualNow(holder.state, Real.now());
  const proxy: DateConstructor = new Proxy(Real, {
    construct(target, args, newTarget) {
      const finalArgs = args.length === 0 ? [now()] : args;
      return Reflect.construct(target, finalArgs, newTarget === proxy ? target : newTarget);
    },
    apply(target) {
      // `Date()` called without `new` returns the current time as a string.
      return new target(now()).toString();
    },
    get(target, prop) {
      if (prop === "now") return now;
      return Reflect.get(target, prop, target);
    },
  });
  // Keep `new Date().constructor === Date` true for code that compares constructors.
  Object.defineProperty(Real.prototype, "constructor", { value: proxy, writable: true, configurable: true });
  return proxy;
}

/**
 * Replace the global `Date` so `Date.now()` and `new Date()` follow the virtual clock.
 * Safe to call more than once. Browser only: call it behind a `typeof window` check.
 */
export function installVirtualClock(g: typeof globalThis = globalThis): void {
  const holder = getHolder(g);
  if (!holder.installed) {
    g.Date = createVirtualDate(holder);
    holder.installed = true;
  }
  if (!holder.storageListening && typeof g.addEventListener === "function") {
    holder.storageListening = true;
    // Another tab changed the clock: follow it.
    g.addEventListener("storage", (event: Event) => {
      const key = (event as StorageEvent).key;
      if (key !== null && key !== VIRTUAL_CLOCK_STORAGE_KEY) return;
      holder.state = readStoredState(g);
      notify(holder, g);
    });
  }
}
