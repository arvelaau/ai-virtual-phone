import type { CalendarOwnerType, CalendarScheduleItem, CalendarWeekPlan } from "./calendar-types";
import {
  CALENDAR_HOUR_END,
  CALENDAR_HOUR_START,
  formatIsoDate,
  getOwnerStorageKey,
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  pickScheduleColorKey,
  sortScheduleItems,
  timeToMinutes,
} from "./calendar-utils";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_calendar_plans_v1";
const CALENDAR_CONFIG_KEY = "ai_phone_calendar_config_v1";
registerKvMigration(STORAGE_KEY);
registerKvMigration(CALENDAR_CONFIG_KEY);

type PersistedCalendarStore = {
  plans: CalendarWeekPlan[];
};

export type CalendarConfig = {
  autoGenerateEnabled: boolean;
  theme: string;
};

const DEFAULT_CALENDAR_CONFIG: CalendarConfig = {
  autoGenerateEnabled: false,
  theme: "ocean",
};

function loadStore(): PersistedCalendarStore {
  if (typeof window === "undefined") return { plans: [] };
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { plans: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedCalendarStore>;
    return { plans: Array.isArray(parsed.plans) ? parsed.plans : [] };
  } catch {
    return { plans: [] };
  }
}

function saveStore(store: PersistedCalendarStore): void {
  if (typeof window === "undefined") return;
  kvSet(STORAGE_KEY, JSON.stringify(store));
}

export function loadCalendarConfig(): CalendarConfig {
  if (typeof window === "undefined") return { ...DEFAULT_CALENDAR_CONFIG };
  try {
    const raw = kvGet(CALENDAR_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CALENDAR_CONFIG };
    return { ...DEFAULT_CALENDAR_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CALENDAR_CONFIG };
  }
}

export function saveCalendarConfig(config: CalendarConfig): void {
  if (typeof window === "undefined") return;
  kvSet(CALENDAR_CONFIG_KEY, JSON.stringify(config));
}

export function loadCalendarWeekPlan(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): CalendarWeekPlan | null {
  const store = loadStore();
  const plan = store.plans.find(
    entry => entry.ownerType === ownerType && entry.ownerId === ownerId && entry.weekStart === weekStart,
  );
  if (!plan) return null;
  return {
    ...plan,
    items: sortScheduleItems((plan.items || [])
      .filter(item => isCalendarTimeRangeAllowed(item.startTime, item.endTime))
      .map(item => ({
        ...item,
        weekday: item.weekday || getWeekdayLabel(item.date),
        colorKey: item.colorKey || pickScheduleColorKey(item.startTime),
      }))),
  };
}

export function loadOwnerCalendarPlans(
  ownerType: CalendarOwnerType,
  ownerId: string,
): CalendarWeekPlan[] {
  const store = loadStore();
  return store.plans
    .filter(entry => entry.ownerType === ownerType && entry.ownerId === ownerId)
    .map(entry => ({
      ...entry,
      items: sortScheduleItems((entry.items || []).filter(item => isCalendarTimeRangeAllowed(item.startTime, item.endTime))),
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function saveCalendarWeekPlan(plan: CalendarWeekPlan): CalendarWeekPlan {
  const store = loadStore();
  const normalized: CalendarWeekPlan = {
    ...plan,
    updatedAt: new Date().toISOString(),
    items: sortScheduleItems(plan.items.map(item => ({
      ...item,
      weekday: item.weekday || getWeekdayLabel(item.date),
      colorKey: item.colorKey || pickScheduleColorKey(item.startTime),
    }))),
  };
  const nextPlans = store.plans.filter(
    entry => !(entry.ownerType === plan.ownerType && entry.ownerId === plan.ownerId && entry.weekStart === plan.weekStart),
  );
  nextPlans.push(normalized);
  saveStore({ plans: nextPlans });
  return normalized;
}

export function replaceCalendarWeekItems(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  items: CalendarScheduleItem[],
): CalendarWeekPlan {
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  const plan: CalendarWeekPlan = {
    id: existing?.id ?? `calendar_week_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerType,
    ownerId,
    weekStart,
    items,
    updatedAt: new Date().toISOString(),
  };
  return saveCalendarWeekPlan(plan);
}

export function upsertCalendarScheduleItem(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  item: Omit<CalendarScheduleItem, "id" | "weekday" | "colorKey" | "createdAt" | "updatedAt"> & Partial<Pick<CalendarScheduleItem, "id" | "weekday" | "colorKey" | "createdAt" | "updatedAt">>,
): CalendarWeekPlan {
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  const existingItems = plan?.items ?? [];
  const now = new Date().toISOString();
  const normalized: CalendarScheduleItem = {
    id: item.id ?? `calendar_item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date: item.date,
    weekday: item.weekday || getWeekdayLabel(item.date),
    startTime: item.startTime,
    endTime: item.endTime,
    location: item.location.trim(),
    title: item.title.trim(),
    colorKey: item.colorKey || pickScheduleColorKey(item.startTime),
    source: item.source,
    createdAt: item.createdAt ?? now,
    updatedAt: now,
  };
  const nextItems = existingItems.filter(entry => entry.id !== normalized.id);
  nextItems.push(normalized);
  return replaceCalendarWeekItems(ownerType, ownerId, weekStart, nextItems);
}

export function deleteCalendarScheduleItem(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  itemId: string,
): CalendarWeekPlan {
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  return replaceCalendarWeekItems(ownerType, ownerId, weekStart, (plan?.items ?? []).filter(item => item.id !== itemId));
}

export function formatCalendarScheduleForPrompt(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): string {
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  if (!plan || plan.items.length === 0) {
    return "No specific schedule for this week yet.";
  }

  const grouped = new Map<string, CalendarScheduleItem[]>();
  for (const item of plan.items) {
    const arr = grouped.get(item.date) || [];
    arr.push(item);
    grouped.set(item.date, arr);
  }

  return getWeekDates(weekStart)
    .map(date => {
      const items = sortScheduleItems(grouped.get(date) || []);
      if (items.length === 0) {
        return `${date} ${getWeekdayLabel(date)}: nothing scheduled`;
      }
      const summary = items
        .map(item => `${item.startTime}-${item.endTime} @${item.location || "TBD"} ${item.title}`)
        .join("; ");
      return `${date} ${getWeekdayLabel(date)}: ${summary}`;
    })
    .join("\n");
}

export function formatCalendarScheduleItemForPrompt(item: Pick<CalendarScheduleItem, "startTime" | "endTime" | "location" | "title">): string {
  return `${item.startTime}-${item.endTime} @${item.location || "TBD"} ${item.title}`;
}

export function getCurrentCalendarScheduleForPrompt(
  ownerType: CalendarOwnerType,
  ownerId: string,
  now = new Date(),
): string {
  const date = formatIsoDate(now);
  const weekStart = getWeekStartIso(now);
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  if (!plan) return "none";

  const activeItems = sortScheduleItems(plan.items).filter(item => {
    if (item.date !== date) return false;
    const start = timeToMinutes(item.startTime);
    const end = timeToMinutes(item.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return start <= currentMinute && currentMinute < end;
  });

  if (activeItems.length === 0) return "none";
  return activeItems.map(formatCalendarScheduleItemForPrompt).join("; ");
}

/**
 * Clear this week's AI-generated entries before regenerating (manual ones are kept).
 * Otherwise the previous result reaches the prompt via the schedule marker and the
 * model copies it verbatim, so "regenerate" never changes anything. Returns the removed
 * entries so they can be restored if generation fails.
 */
export function clearGeneratedWeekItems(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): CalendarScheduleItem[] {
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  const items = existing?.items ?? [];
  const removed = items.filter(item => item.source !== "manual");
  if (removed.length === 0) return [];
  replaceCalendarWeekItems(ownerType, ownerId, weekStart, items.filter(item => item.source === "manual"));
  return removed;
}

/** Put the entries removed by clearGeneratedWeekItems back into the week plan after a failure. */
export function restoreCalendarWeekItems(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  itemsToRestore: CalendarScheduleItem[],
): void {
  if (itemsToRestore.length === 0) return;
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  replaceCalendarWeekItems(ownerType, ownerId, weekStart, sortScheduleItems([
    ...(existing?.items ?? []),
    ...itemsToRestore,
  ]));
}

export function buildCalendarScheduleMarker(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): string {
  const ownerLabel = ownerType === "user" ? "User" : "Character";
  return [
    `Week starting: ${weekStart}`,
    `${ownerLabel} schedule for this week:`,
    formatCalendarScheduleForPrompt(ownerType, ownerId, weekStart),
  ].join("\n");
}

export function normalizeGeneratedScheduleItems(
  rawItems: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
  }>,
): CalendarScheduleItem[] {
  const now = new Date().toISOString();
  return sortScheduleItems(
    rawItems
      .map(item => ({
        id: `calendar_item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        date: item.date,
        weekday: getWeekdayLabel(item.date),
        startTime: normalizeTime(item.startTime) || item.startTime,
        endTime: normalizeTime(item.endTime) || item.endTime,
        location: item.location.trim(),
        title: item.title.trim(),
        colorKey: pickScheduleColorKey(item.startTime),
        source: "generated" as const,
        createdAt: now,
        updatedAt: now,
      }))
      .filter(item => isCalendarTimeRangeAllowed(item.startTime, item.endTime)),
  );
}

export function cloneWeekPlanWithManualEdits(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  generatedItems: CalendarScheduleItem[],
): CalendarWeekPlan {
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  const manualItems = (existing?.items ?? []).filter(item => item.source === "manual");
  const nextItems = [...generatedItems.filter(item => item.source !== "manual")];
  for (const item of manualItems) {
    const collides = nextItems.find(
      entry =>
        entry.date === item.date &&
        entry.startTime === item.startTime &&
        entry.endTime === item.endTime &&
        entry.title === item.title,
    );
    if (!collides) {
      nextItems.push(item);
    }
  }
  return replaceCalendarWeekItems(ownerType, ownerId, weekStart, nextItems);
}

export function validateScheduleDraft(item: {
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
}): string | null {
  const start = normalizeTime(item.startTime);
  const end = normalizeTime(item.endTime);
  if (!item.date) return "Please pick a date";
  if (!start || !end) return "Please enter a valid time format";
  if (start >= end) return "End time must be later than start time";
  if (!isCalendarTimeRangeAllowed(start, end)) {
    return `Schedule times must fall between ${String(CALENDAR_HOUR_START).padStart(2, "0")}:00 and ${String(CALENDAR_HOUR_END).padStart(2, "0")}:00`;
  }
  if (!item.title.trim()) return "Please enter an activity";
  return null;
}

export function getCalendarOwnerLabel(ownerType: CalendarOwnerType, ownerName: string): string {
  return `${ownerName}'s schedule`;
}

export function getCalendarOwnerKey(ownerType: CalendarOwnerType, ownerId: string): string {
  return getOwnerStorageKey(ownerType, ownerId);
}
