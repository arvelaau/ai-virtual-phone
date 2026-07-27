import type { CalendarColorKey, CalendarScheduleItem } from "./calendar-types";

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

export const CALENDAR_HOUR_START = 8;
export const CALENDAR_HOUR_END = 23;
const CALENDAR_MINUTE_START = CALENDAR_HOUR_START * 60;
const CALENDAR_MINUTE_END = CALENDAR_HOUR_END * 60;

export function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseIsoDate(dateText: string): Date {
  return new Date(`${dateText}T00:00:00`);
}

export function startOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function getWeekStartIso(date: Date): string {
  return formatIsoDate(startOfWeek(date));
}

export function getWeekDates(weekStart: string): string[] {
  const base = parseIsoDate(weekStart);
  return Array.from({ length: 7 }, (_, idx) => {
    const current = new Date(base);
    current.setDate(base.getDate() + idx);
    return formatIsoDate(current);
  });
}

export function getWeekdayLabel(dateOrIso: Date | string): string {
  const date = typeof dateOrIso === "string" ? parseIsoDate(dateOrIso) : dateOrIso;
  return WEEKDAY_LABELS[date.getDay()];
}

export function formatMonthDay(dateOrIso: Date | string): string {
  const date = typeof dateOrIso === "string" ? parseIsoDate(dateOrIso) : dateOrIso;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function getMonthMatrix(anchorDate: string): string[][] {
  const focus = parseIsoDate(anchorDate);
  const firstDay = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const gridStart = startOfWeek(firstDay);
  return Array.from({ length: 6 }, (_, weekIdx) =>
    Array.from({ length: 7 }, (_, dayIdx) => {
      const current = new Date(gridStart);
      current.setDate(gridStart.getDate() + weekIdx * 7 + dayIdx);
      return formatIsoDate(current);
    }),
  );
}

export function isSameMonth(dateA: string, dateB: string): boolean {
  return dateA.slice(0, 7) === dateB.slice(0, 7);
}

export function isDateInWeek(date: string, weekStart: string): boolean {
  return getWeekDates(weekStart).includes(date);
}

export function timeToMinutes(value: string): number {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

export function normalizeTime(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function isCalendarTimeRangeAllowed(startTime: string, endTime: string): boolean {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return false;
  return start >= CALENDAR_MINUTE_START && end <= CALENDAR_MINUTE_END;
}

export function pickScheduleColorKey(startTime: string): CalendarColorKey {
  const minutes = timeToMinutes(startTime);
  if (Number.isNaN(minutes)) return "slate";
  if (minutes < 9 * 60) return "teal";
  if (minutes < 12 * 60) return "blue";
  if (minutes < 15 * 60) return "green";
  if (minutes < 18 * 60) return "amber";
  if (minutes < 21 * 60) return "violet";
  return "rose";
}

export function sortScheduleItems(items: CalendarScheduleItem[]): CalendarScheduleItem[] {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    if (a.endTime !== b.endTime) return a.endTime.localeCompare(b.endTime);
    return a.title.localeCompare(b.title);
  });
}

export function formatWeekRangeLabel(weekStart: string): string {
  const dates = getWeekDates(weekStart);
  const start = parseIsoDate(dates[0]);
  const end = parseIsoDate(dates[6]);
  return `${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`;
}

export function getOwnerStorageKey(ownerType: string, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}
