"use client";

// components/time-control/time-control-app.tsx
// Time Control -- set the date and time the whole app believes it is, instead of changing the
// phone's own clock. Everything that asks "what time is it" (chat timestamps, Story, the time
// the character is told, the calendar, follow-up timers) follows the clock set here. The engine
// lives in lib/virtual-clock.ts; this screen is only its remote control.

import { useEffect, useState } from "react";
import { Clock, RotateCcw, RefreshCw } from "lucide-react";

import { PageShell, Button, Input, GlassCard, Badge } from "@/components/ui";
import {
  describeClockOffset,
  formatLocalDateInput,
  formatLocalTimeInput,
  getAppNow,
  getRealNow,
  getVirtualClockOffset,
  getVirtualClockState,
  parseLocalDateTimeInput,
  resetVirtualClock,
  setVirtualTime,
  shiftVirtualTime,
  subscribeVirtualClock,
  VIRTUAL_CLOCK_MAX_MS,
  VIRTUAL_CLOCK_MIN_MS,
} from "@/lib/virtual-clock";

type Props = {
  onClose: () => void;
  onNotice?: (text: string) => void;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SHIFTS: Array<{ label: string; delta: number }> = [
  { label: "-1 day", delta: -DAY },
  { label: "-1 hour", delta: -HOUR },
  { label: "+30 min", delta: 30 * MINUTE },
  { label: "+1 hour", delta: HOUR },
  { label: "+1 day", delta: DAY },
  { label: "+1 week", delta: 7 * DAY },
];

const TIMES_OF_DAY: Array<{ label: string; time: string }> = [
  { label: "Morning 07:30", time: "07:30" },
  { label: "Noon 12:00", time: "12:00" },
  { label: "Evening 19:00", time: "19:00" },
  { label: "Night 23:30", time: "23:30" },
];

const LONG_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});
const CLOCK_FORMAT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function dateInputBound(ms: number): string {
  return formatLocalDateInput(ms);
}

export function TimeControlApp({ onClose, onNotice }: Props) {
  const [now, setNow] = useState(() => getAppNow());
  const [state, setState] = useState(() => getVirtualClockState());
  const [dateText, setDateText] = useState(() => formatLocalDateInput(getAppNow()));
  const [timeText, setTimeText] = useState(() => formatLocalTimeInput(getAppNow()));
  const [error, setError] = useState("");

  useEffect(() => {
    const tick = () => setNow(getAppNow());
    const timer = setInterval(tick, 1000);
    const unsubscribe = subscribeVirtualClock(() => {
      setState(getVirtualClockState());
      tick();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "device time zone";
  const offset = getVirtualClockOffset();
  const realNow = getRealNow();

  const syncInputsToNow = () => {
    const current = getAppNow();
    setDateText(formatLocalDateInput(current));
    setTimeText(formatLocalTimeInput(current));
  };

  const applyInputs = () => {
    const target = parseLocalDateTimeInput(dateText, timeText);
    if (target === null) {
      setError("That is not a valid date and time.");
      return;
    }
    setError("");
    setVirtualTime(target);
    onNotice?.("Time set. The clock keeps running from there.");
  };

  const applyTimeOfDay = (time: string) => {
    // Keep the date shown in the box (or today's date if the box is empty).
    const date = dateText || formatLocalDateInput(getAppNow());
    const target = parseLocalDateTimeInput(date, time);
    if (target === null) {
      setError("Pick a valid date first.");
      return;
    }
    setError("");
    setTimeText(time);
    setDateText(date);
    setVirtualTime(target);
    onNotice?.("Time set. The clock keeps running from there.");
  };

  const applyShift = (delta: number) => {
    setError("");
    if (!shiftVirtualTime(delta)) {
      setError("That would leave the supported range (1971 to 2999).");
      return;
    }
    syncInputsToNow();
  };

  const handleReset = () => {
    resetVirtualClock();
    setError("");
    syncInputsToNow();
    onNotice?.("Back to the device's real time.");
  };

  return (
    <PageShell
      title="Time Control"
      onBack={onClose}
      rightAction={
        <Button variant="ghost" aria-label="Reload the app" onClick={() => window.location.reload()}>
          <RefreshCw size={18} strokeWidth={1.8} />
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 4px 24px" }}>
        <GlassCard>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Clock size={16} strokeWidth={1.8} />
            <span style={{ fontWeight: 600 }}>The app thinks it is</span>
            <Badge>{state.enabled ? "Custom time" : "Real time"}</Badge>
          </div>
          <div
            data-testid="time-control-clock"
            style={{ fontSize: 34, fontWeight: 600, letterSpacing: 1, margin: "10px 0 2px", fontVariantNumeric: "tabular-nums" }}
          >
            {CLOCK_FORMAT.format(new Date(now))}
          </div>
          <div style={{ fontSize: 14 }}>{LONG_FORMAT.format(new Date(now))}</div>
          <div style={{ fontSize: 12.5, opacity: 0.65, marginTop: 8 }}>
            {state.enabled ? `${describeClockOffset(offset)}. ` : ""}
            Device time: {CLOCK_FORMAT.format(new Date(realNow))} ({timeZone})
          </div>
        </GlassCard>

        <GlassCard>
          <h3 style={{ margin: "0 0 4px" }}>Set date and time</h3>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "0 0 12px" }}>
            Pick the moment you want. The clock starts from there and keeps ticking, like a phone you
            set by hand.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 150px" }}>
              <span style={{ fontSize: 12.5, opacity: 0.7 }}>Date</span>
              <Input
                type="date"
                value={dateText}
                min={dateInputBound(VIRTUAL_CLOCK_MIN_MS)}
                max={dateInputBound(VIRTUAL_CLOCK_MAX_MS)}
                onChange={event => setDateText(event.target.value)}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 120px" }}>
              <span style={{ fontSize: 12.5, opacity: 0.7 }}>Time</span>
              <Input type="time" value={timeText} onChange={event => setTimeText(event.target.value)} />
            </label>
          </div>
          {error ? (
            <div role="alert" style={{ color: "var(--c-danger, #c0392b)", fontSize: 12.5, marginTop: 8 }}>
              {error}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={applyInputs}>
              Apply
            </Button>
            <Button variant="outline" onClick={syncInputsToNow}>
              Use current
            </Button>
          </div>
        </GlassCard>

        <GlassCard>
          <h3 style={{ margin: "0 0 4px" }}>Time of day</h3>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "0 0 12px" }}>
            Jump to a time on the date above.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {TIMES_OF_DAY.map(item => (
              <Button key={item.time} variant="outline" onClick={() => applyTimeOfDay(item.time)}>
                {item.label}
              </Button>
            ))}
          </div>
        </GlassCard>

        <GlassCard>
          <h3 style={{ margin: "0 0 4px" }}>Quick shift</h3>
          <p style={{ fontSize: 12.5, opacity: 0.7, margin: "0 0 12px" }}>
            Move the clock forward or back from where it is now.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {SHIFTS.map(item => (
              <Button key={item.label} variant="outline" onClick={() => applyShift(item.delta)}>
                {item.label}
              </Button>
            ))}
          </div>
        </GlassCard>

        {state.enabled ? (
          <Button variant="soft-danger" onClick={handleReset}>
            <RotateCcw size={16} strokeWidth={1.8} style={{ marginRight: 6, verticalAlign: "-3px" }} />
            Back to real time
          </Button>
        ) : null}

        <GlassCard>
          <h3 style={{ margin: "0 0 8px" }}>Good to know</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, opacity: 0.75, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>New messages, story turns, calendar entries and the time the character is told all use this clock.</li>
            <li>Messages already saved keep the time they were written at. Going back in time puts new messages "before" older ones.</li>
            <li>The setting is saved on this device and survives a reload. If a screen still shows the old time, use the reload button at the top right.</li>
            <li>It does not reach the server (for example iMessage replies) or the little web pages inside HTML cards and custom apps, which keep using the real time.</li>
          </ul>
        </GlassCard>
      </div>
    </PageShell>
  );
}
