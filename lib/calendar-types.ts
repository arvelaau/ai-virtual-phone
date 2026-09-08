export type CalendarOwnerType = "user" | "character";

export type CalendarColorKey =
  | "blue"
  | "green"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "slate"
  | "lilac";

export type CalendarScheduleItem = {
  id: string;
  date: string;       // YYYY-MM-DD
  weekday: string;    // Monday ~ Sunday
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  location: string;
  title: string;
  /** Optional single-emoji icon for the event. */
  emoji?: string;
  colorKey: CalendarColorKey;
  /** "offline_session" -- a factual record of an offline-mode session that happened, written by
   *  chat-room.tsx when the user exits offline mode with a character. Treated like "manual" by
   *  clearGeneratedWeekItems()/cloneWeekPlanWithManualEdits() -- it survives a full-week AI
   *  regeneration instead of being wiped like a "generated" guess, since it records something
   *  that actually happened rather than a speculative AI-authored plan. */
  source: "manual" | "generated" | "offline_session";
  createdAt: string;
  updatedAt: string;
};

export type CalendarWeekPlan = {
  id: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  weekStart: string; // YYYY-MM-DD, Monday
  items: CalendarScheduleItem[];
  updatedAt: string;
};
