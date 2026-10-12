export type CharacterTimeContext = {
  systemTime: string;
  systemWeekday: string;
  systemTimeZone: string;
  characterTime: string;
  characterWeekday: string;
  characterTimeZone: string;
  timeContext: string;
  hasDifference: boolean;
};

export type GroupTimeMember = {
  name: string;
  timeZone?: string | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type DateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getSystemTimeZone(): string {
  return readTimeZone();
}

export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeZone = value.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values: Partial<DateParts> = {};
  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year"
      || part.type === "month"
      || part.type === "day"
      || part.type === "hour"
      || part.type === "minute"
      || part.type === "second"
    ) {
      values[part.type] = part.value;
    }
  }
  return {
    year: values.year || "0000",
    month: values.month || "01",
    day: values.day || "01",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00",
  };
}

export function formatZonedPromptTimestamp(date: Date, timeZone: string, includeTimeZone = false): string {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${includeTimeZone ? ` ${timeZone}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Oct 2026, 21:05" -- an unambiguous date-time for prompt text (was a Chinese 年月日 string). */
export function formatZonedLongDateTime(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  return `${Number(parts.day)} ${MONTHS[Math.max(0, Math.min(11, Number(parts.month) - 1))]} ${Number(parts.year)}, ${parts.hour}:${parts.minute}`;
}

export function getZonedWeekday(date: Date, timeZone: string): string {
  try {
    const label = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);
    return label || WEEKDAYS[0];
  } catch {
    return WEEKDAYS[date.getDay()];
  }
}

/** Part of the day for an hour 0-23. Deliberately coarse: it is a hint, not a schedule. */
export function describeDayPart(hour: number): string {
  if (hour < 5) return "deep night";
  if (hour < 7) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

function hourOf(date: Date, timeZone: string): number {
  return Number(getDateParts(date, timeZone).hour) % 24;
}

/** How far `characterTimeZone`'s wall clock is ahead of (+) or behind (-) `systemTimeZone`'s, in hours. */
export function timeZoneOffsetHours(date: Date, characterTimeZone: string, systemTimeZone = getSystemTimeZone()): number {
  const wall = (zone: string) => {
    const p = getDateParts(date, zone);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  };
  return (wall(characterTimeZone) - wall(systemTimeZone)) / 3600000;
}

function describeHours(hours: number): string {
  const a = Math.round(Math.abs(hours) * 10) / 10;
  return `${a} ${a === 1 ? "hour" : "hours"}`;
}

export function hasTimeZoneDifference(date: Date, characterTimeZone: string, systemTimeZone = getSystemTimeZone()): boolean {
  const systemParts = getDateParts(date, systemTimeZone);
  const characterParts = getDateParts(date, characterTimeZone);
  return systemParts.year !== characterParts.year
    || systemParts.month !== characterParts.month
    || systemParts.day !== characterParts.day
    || systemParts.hour !== characterParts.hour
    || systemParts.minute !== characterParts.minute;
}

export function buildCharacterTimeContext(timeZone?: string | null, now = new Date()): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedLongDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const hasDifference = normalizedTimeZone ? hasTimeZoneDifference(now, normalizedTimeZone, systemTimeZone) : false;

  if (!normalizedTimeZone || !hasDifference) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `Current time: ${systemTime}, ${systemWeekday}`,
      hasDifference: false,
    };
  }

  const characterTime = formatZonedLongDateTime(now, normalizedTimeZone);
  const characterWeekday = getZonedWeekday(now, normalizedTimeZone);
  const diff = timeZoneOffsetHours(now, normalizedTimeZone, systemTimeZone);
  const relation = `Your clock is ${describeHours(diff)} ${diff > 0 ? "ahead of" : "behind"} theirs.`;
  const userPart = describeDayPart(hourOf(now, systemTimeZone));
  const charPart = describeDayPart(hourOf(now, normalizedTimeZone));
  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime,
    characterWeekday,
    characterTimeZone: normalizedTimeZone,
    timeContext: [
      "TIME ZONES: you and the user are in different time zones. This is real; keep it in mind in every reply.",
      `Right now for the USER: ${systemWeekday}, ${systemTime} (${userPart}), ${systemTimeZone}.`,
      `Right now for YOU: ${characterWeekday}, ${characterTime} (${charPart}), ${normalizedTimeZone}.`,
      relation,
      "Rules: (1) every timestamp in the conversation history is on the USER's clock; your own local time is what governs your day, your sleep, your meals, your work and your greetings. (2) Anything the user says about the time of day (good morning, going to bed, tonight, at 8) is on THEIR clock: convert it before you react. (3) Never assume it is the same part of the day for both of you.",
    ].join("\n"),
    hasDifference: true,
  };
}

export function buildGroupTimeContext(members: GroupTimeMember[], now = new Date()): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedLongDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const rows = members
    .map(member => {
      const timeZone = normalizeTimeZone(member.timeZone);
      if (!timeZone || !hasTimeZoneDifference(now, timeZone, systemTimeZone)) return null;
      const diff = timeZoneOffsetHours(now, timeZone, systemTimeZone);
      const part = describeDayPart(hourOf(now, timeZone));
      return `${member.name}: ${getZonedWeekday(now, timeZone)}, ${formatZonedLongDateTime(now, timeZone)} (${part}), ${timeZone}, ${describeHours(diff)} ${diff > 0 ? "ahead of" : "behind"} the user`;
    })
    .filter((row): row is string => Boolean(row));

  if (rows.length === 0) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `Current time: ${systemTime}, ${systemWeekday}`,
      hasDifference: false,
    };
  }

  const userPart = describeDayPart(hourOf(now, systemTimeZone));
  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime: "",
    characterWeekday: "",
    characterTimeZone: "",
    timeContext: [
      "TIME ZONES: some members of this group are in a different time zone from the user. This is real; keep it in mind in every reply.",
      `Right now for the USER: ${systemWeekday}, ${systemTime} (${userPart}), ${systemTimeZone}.`,
      "Local time of the members who differ:",
      ...rows,
      "Rules: every timestamp in the conversation history is on the USER's clock. Each character's own local time governs that character's day, sleep, meals, work and greetings. Anything the user says about the time of day is on THEIR clock: convert it before reacting.",
    ].join("\n"),
    hasDifference: true,
  };
}
