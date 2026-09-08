"use client";

import { Check, ChevronLeft, Trash2 } from "lucide-react";
import { Input } from "../ui/form";
import type { CalendarColorKey } from "@/lib/calendar-types";
import { CALENDAR_COLOR_KEYS } from "@/lib/calendar-utils";

export type CalendarEventDraft = {
  id?: string;
  date: string;
  /** End date (inclusive); left blank means a single day. Saving a multi-day range generates one item per day. */
  endDate?: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
  emoji: string;
  colorKey?: CalendarColorKey;
};

const EMOJI_PRESETS = [
  "📌", "💼", "📚", "💻", "🏃", "🏋️", "🍽️", "☕", "🎬",
  "🎮", "🎵", "🛒", "🛍️", "✈️", "🏥", "📞", "💤", "❤️",
  "🎂", "🎨", "🧹", "🐾",
];

const COLOR_LABELS: Record<CalendarColorKey, string> = {
  blue: "Blue",
  green: "Green",
  amber: "Amber",
  rose: "Rose",
  violet: "Violet",
  teal: "Teal",
  slate: "Slate",
  lilac: "Lilac",
};

export function CalendarEventEditModal({
  draft,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: CalendarEventDraft;
  onChange: (next: CalendarEventDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay calendar-edit-modal-overlay" onClick={onClose}>
      <div className="calendar-edit-modal" data-ui="calendar-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" data-ui="modal-header">
          <button onClick={onClose} className="modal-header-btn modal-header-btn-muted" aria-label="Back">
            <ChevronLeft size={18} />
          </button>
          <span className="modal-header-title">{draft.id ? "Edit Event" : "New Event"}</span>
          <button onClick={onSave} className="modal-header-btn modal-header-btn-action" aria-label="Save">
            <Check size={18} />
          </button>
        </div>

        <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10" data-ui="modal-body">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">Start Date</label>
              <Input
                type="date"
                value={draft.date}
                onChange={e => {
                  const nextDate = e.target.value;
                  const currentEnd = draft.endDate || draft.date;
                  // The end date follows the start date, unless the user already pushed the end date later.
                  onChange({ ...draft, date: nextDate, endDate: currentEnd > nextDate ? currentEnd : nextDate });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">End Date</label>
              <Input
                type="date"
                value={draft.endDate || draft.date}
                min={draft.date}
                onChange={e => onChange({ ...draft, endDate: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">Start Time</label>
              <Input
                type="time"
                value={draft.startTime}
                onChange={e => onChange({ ...draft, startTime: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="menu-desc ml-1">End Time</label>
              <Input
                type="time"
                value={draft.endTime}
                onChange={e => onChange({ ...draft, endTime: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">Activity</label>
            <Input
              value={draft.title}
              onChange={e => onChange({ ...draft, title: e.target.value })}
              placeholder="e.g. Weekly team meeting"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">Location</label>
            <Input
              value={draft.location}
              onChange={e => onChange({ ...draft, location: e.target.value })}
              placeholder="e.g. Office / Home / Mall"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">Icon (tap to pick, tap again to clear)</label>
            <div className="calendar-emoji-row">
              {draft.emoji && !EMOJI_PRESETS.includes(draft.emoji) ? (
                <button
                  type="button"
                  className="calendar-emoji-preset"
                  data-active="true"
                  onClick={() => onChange({ ...draft, emoji: "" })}
                  aria-label={`Clear ${draft.emoji}`}
                >
                  {draft.emoji}
                </button>
              ) : null}
              {EMOJI_PRESETS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="calendar-emoji-preset"
                  data-active={draft.emoji === emoji ? "true" : undefined}
                  onClick={() => onChange({ ...draft, emoji: draft.emoji === emoji ? "" : emoji })}
                  aria-label={`Use ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">Color</label>
            <div className="calendar-color-picker">
              <button
                type="button"
                className="calendar-color-swatch calendar-color-swatch-auto"
                data-active={!draft.colorKey ? "true" : undefined}
                onClick={() => onChange({ ...draft, colorKey: undefined })}
              >
                Auto
              </button>
              {CALENDAR_COLOR_KEYS.map(key => (
                <button
                  key={key}
                  type="button"
                  className="calendar-color-swatch"
                  data-color={key}
                  data-active={draft.colorKey === key ? "true" : undefined}
                  onClick={() => onChange({ ...draft, colorKey: key })}
                  aria-label={`Color: ${COLOR_LABELS[key]}`}
                  title={COLOR_LABELS[key]}
                />
              ))}
            </div>
          </div>

          {draft.id ? (
            <button type="button" className="ui-btn ui-btn-outline calendar-delete-btn" onClick={onDelete}>
              <Trash2 size={16} />
              Delete This Event
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
