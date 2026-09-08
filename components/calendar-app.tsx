"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronLeft, HeartPulse, Plus, Trash2, Wand2, X } from "lucide-react";
import { Avatar } from "./ui/primitives";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { CALENDAR_CSS_EXAMPLE } from "@/lib/css-examples";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";
import { Input } from "./ui/form";
import type { CalendarOwnerType, CalendarScheduleItem, CalendarWeekPlan } from "@/lib/calendar-types";
import {
  CALENDAR_DAYS_PER_PAGE_OPTIONS,
  CALENDAR_THEME_IDS,
  deleteCalendarScheduleItem,
  loadCalendarConfig,
  loadOwnerCalendarPlans,
  saveCalendarConfig,
  upsertCalendarScheduleItem,
  validateScheduleDraft,
} from "@/lib/calendar-storage";
import { createDefaultScheduleDraft, generateWeeklyCalendarSchedule } from "@/lib/calendar-engine";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
  formatIsoDate,
  getWeekStartIso,
  parseIsoDate,
  pickScheduleColorKey,
  sanitizeScheduleEmoji,
} from "@/lib/calendar-utils";
import {
  buildMenstrualDayMap,
  cancelFinishCurrentPeriod,
  cancelCurrentPeriodStart,
  finishCurrentPeriod,
  deleteMenstrualRecord,
  getMenstrualSummary,
  loadMenstrualConfig,
  loadMenstrualRecords,
  saveMenstrualConfig,
  startCurrentPeriod,
  validateMenstrualSettings,
  type MenstrualRecord,
} from "@/lib/menstrual-storage";
import { CalendarMonthPage } from "./calendar/month-page";
import { CalendarDetailPage } from "./calendar/detail-page";
import { CalendarEventEditModal, type CalendarEventDraft } from "./calendar/event-edit-modal";

type OwnerOption = {
  key: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  name: string;
  avatar?: string | null;
};

const CALENDAR_THEMES: Array<{ id: (typeof CALENDAR_THEME_IDS)[number]; name: string }> = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "cream", name: "Cream" },
  { id: "mint", name: "Mint" },
  { id: "mist", name: "Mist" },
  { id: "sakura", name: "Sakura" },
];

function buildOwnerOptions(): OwnerOption[] {
  const options: OwnerOption[] = [];
  const identity = resolveUserIdentity(undefined, "calendar") ?? resolveUserIdentity() ?? null;
  options.push({
    key: "user:me",
    ownerType: "user",
    ownerId: "self",
    name: identity?.name?.trim() || "Me",
    avatar: identity?.avatarUrl || null,
  });
  for (const char of loadCharacters()) {
    options.push({
      key: `character:${char.id}`,
      ownerType: "character",
      ownerId: char.id,
      name: char.name,
      avatar: char.avatar,
    });
  }
  return options;
}

type PeriodCareCharacterOption = {
  characterId: string;
  name: string;
  avatar?: string | null;
};

function buildPeriodCareCharacterOptions(): PeriodCareCharacterOption[] {
  const characters = loadCharacters();
  const characterById = new Map(characters.map(char => [char.id, char]));
  const latestSessionByCharacter = new Map<string, ReturnType<typeof loadChatSessions>[number]>();
  for (const session of loadChatSessions()) {
    if (session.isGroup) continue;
    const character = characterById.get(session.contactId);
    if (!character) continue;
    const existing = latestSessionByCharacter.get(session.contactId);
    if (!existing || session.updatedAt > existing.updatedAt) {
      latestSessionByCharacter.set(session.contactId, session);
    }
  }
  return Array.from(latestSessionByCharacter.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(session => {
      const character = characterById.get(session.contactId)!;
      return {
        characterId: character.id,
        name: session.alias || character.name,
        avatar: character.avatar,
      };
    });
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatSimpleDate(dateText: string | null): string {
  if (!dateText) return "Not recorded yet";
  const date = parseIsoDate(dateText);
  return `${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
}

export function PhoneCalendarApp({
  onClose,
  onNotice,
}: {
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const todayIso = formatIsoDate(new Date());
  const [owners, setOwners] = useState<OwnerOption[]>(() => buildOwnerOptions());
  const [selectedKey, setSelectedKey] = useState<string>(() => owners[0]?.key ?? "user:me");
  const [view, setView] = useState<"month" | "detail">("month");
  const [selectedDate, setSelectedDate] = useState<string>(todayIso);
  const [detailKey, setDetailKey] = useState(0);
  const [ownerPlans, setOwnerPlans] = useState<CalendarWeekPlan[]>([]);
  const [config, setConfig] = useState(() => loadCalendarConfig());
  const [menstrualConfig, setMenstrualConfig] = useState(() => loadMenstrualConfig());
  const [menstrualRecords, setMenstrualRecords] = useState<MenstrualRecord[]>(() => loadMenstrualRecords());
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [showDaysPanel, setShowDaysPanel] = useState(false);
  const [showMenstrualSettings, setShowMenstrualSettings] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);
  const [showAutoConfirm, setShowAutoConfirm] = useState(false);
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const autoAttemptedRef = useRef<Set<string>>(new Set());
  const [editingItem, setEditingItem] = useState<(CalendarEventDraft & { originalDate?: string }) | null>(null);
  const autoGenerateEnabled = config.autoGenerateEnabled;

  const [menstrualDraft, setMenstrualDraft] = useState<{
    cycleLength: string;
    periodLength: string;
    periodCareEnabled: boolean;
    periodCareCharacterIds: string[];
    periodCareLeadDays: "1" | "2" | "3";
  }>(() => {
    const initial = loadMenstrualConfig();
    return {
      cycleLength: String(initial.cycleLength),
      periodLength: String(initial.periodLength),
      periodCareEnabled: initial.periodCareEnabled,
      periodCareCharacterIds: initial.periodCareCharacterIds,
      periodCareLeadDays: String(initial.periodCareLeadDays) as "1" | "2" | "3",
    };
  });

  const [calendarCustomCss, setCalendarCustomCss] = useState(() =>
    typeof window !== "undefined" ? kvGet("calendar-custom-css") || "" : ""
  );
  const [appliedCalendarCss, setAppliedCalendarCss] = useState(() =>
    typeof window !== "undefined" ? kvGet("calendar-custom-css") || "" : ""
  );
  const handleApplyCalendarCss = () => {
    const trimmed = calendarCustomCss.trim();
    if (trimmed) kvSet("calendar-custom-css", trimmed);
    else kvRemove("calendar-custom-css");
    setAppliedCalendarCss(trimmed);
    window.dispatchEvent(new CustomEvent("calendar-css-updated", { detail: trimmed }));
  };
  // Live-update the calendar's custom CSS from external sources (e.g. the mascot).
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const css = (e as CustomEvent).detail || "";
      setAppliedCalendarCss(css);
      setCalendarCustomCss(css);
    };
    window.addEventListener("calendar-css-updated", onCSSUpdate);
    return () => window.removeEventListener("calendar-css-updated", onCSSUpdate);
  }, []);

  const selectedOwner = useMemo(
    () => owners.find(owner => owner.key === selectedKey) ?? owners[0] ?? null,
    [owners, selectedKey],
  );
  const weekStart = useMemo(() => getWeekStartIso(parseIsoDate(selectedDate)), [selectedDate]);

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarScheduleItem[]>();
    for (const plan of ownerPlans) {
      for (const item of plan.items) {
        const list = map.get(item.date) || [];
        list.push(item);
        map.set(item.date, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    return map;
  }, [ownerPlans]);

  // Cycle markers: covers the month page's +/-1 year range.
  const cycleMap = useMemo(() => {
    if (selectedOwner?.ownerType !== "user") return null;
    const today = parseIsoDate(todayIso);
    const start = formatIsoDate(new Date(today.getFullYear() - 1, today.getMonth(), 1));
    const end = formatIsoDate(new Date(today.getFullYear() + 1, today.getMonth() + 1, 0));
    return buildMenstrualDayMap(start, end, menstrualRecords, menstrualConfig);
  }, [selectedOwner, todayIso, menstrualRecords, menstrualConfig]);

  const menstrualSummary = useMemo(
    () => getMenstrualSummary(menstrualRecords, menstrualConfig, selectedDate),
    [menstrualRecords, menstrualConfig, selectedDate],
  );
  const periodCareCharacterOptions = useMemo(
    () => (showMenstrualSettings ? buildPeriodCareCharacterOptions() : []),
    [showMenstrualSettings],
  );

  useEffect(() => {
    setOwners(buildOwnerOptions());
  }, []);

  const refreshPlans = () => {
    if (!selectedOwner) return;
    setOwnerPlans(loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId));
  };

  useEffect(() => {
    if (!selectedOwner) return;
    setOwnerPlans(loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId));
  }, [selectedOwner]);

  // Refresh after chat/tool calls change the schedule.
  useEffect(() => {
    const handler = () => {
      if (!selectedOwner) return;
      setOwnerPlans(loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId));
    };
    window.addEventListener("calendar-updated", handler);
    return () => window.removeEventListener("calendar-updated", handler);
  }, [selectedOwner]);

  // Weekly auto-generate (characters only).
  useEffect(() => {
    if (!selectedOwner || !autoGenerateEnabled || selectedOwner.ownerType !== "character" || isGenerating) return;
    const autoKey = `${selectedOwner.ownerType}:${selectedOwner.ownerId}:${weekStart}`;
    if (autoAttemptedRef.current.has(autoKey)) return;
    const existing = loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId)
      .find(plan => plan.weekStart === weekStart);
    if (existing && existing.items.length > 0) return;
    void (async () => {
      autoAttemptedRef.current.add(autoKey);
      setIsGenerating(true);
      const result = await generateWeeklyCalendarSchedule(selectedOwner.ownerType, selectedOwner.ownerId, weekStart);
      setIsGenerating(false);
      if (!result.success) {
        onNotice?.(result.error || "Auto-generation failed");
        return;
      }
      refreshPlans();
      onNotice?.("This week's schedule was generated automatically");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateEnabled, isGenerating, selectedOwner, weekStart]);

  // ── Event editing ──
  const openNewDraft = (date: string) => {
    const base = createDefaultScheduleDraft(date);
    setEditingItem({
      date: base.date,
      startTime: base.startTime,
      endTime: base.endTime,
      location: base.location,
      title: base.title,
      emoji: base.emoji,
    });
  };

  const openEditItem = (item: CalendarScheduleItem) => {
    setEditingItem({
      id: item.id,
      date: item.date,
      endDate: item.date,
      originalDate: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      location: item.location,
      title: item.title,
      emoji: item.emoji || "",
      colorKey: item.colorKey,
    });
  };

  const handleSaveDraft = () => {
    if (!selectedOwner || !editingItem) return;
    const error = validateScheduleDraft(editingItem);
    if (error) {
      onNotice?.(error);
      return;
    }
    const startDate = editingItem.date;
    const endDate = editingItem.endDate || editingItem.date;
    if (endDate < startDate) {
      onNotice?.("End date cannot be before the start date");
      return;
    }
    const dayCount = Math.round((parseIsoDate(endDate).getTime() - parseIsoDate(startDate).getTime()) / 86400000) + 1;
    if (dayCount > 31) {
      onNotice?.("You can create at most 31 days of schedule at once");
      return;
    }
    const firstWeekStart = getWeekStartIso(parseIsoDate(startDate));
    // Moved to a different week: remove from the original week first.
    if (editingItem.id && editingItem.originalDate) {
      const originalWeekStart = getWeekStartIso(parseIsoDate(editingItem.originalDate));
      if (originalWeekStart !== firstWeekStart) {
        deleteCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, originalWeekStart, editingItem.id);
      }
    }
    // Multi-day: the first day keeps the original id (edit case), each further day gets its own new item.
    for (let offset = 0; offset < dayCount; offset++) {
      const day = parseIsoDate(startDate);
      day.setDate(day.getDate() + offset);
      const dayIso = formatIsoDate(day);
      upsertCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, getWeekStartIso(parseIsoDate(dayIso)), {
        id: offset === 0 ? editingItem.id : undefined,
        date: dayIso,
        startTime: editingItem.startTime,
        endTime: editingItem.endTime,
        location: editingItem.location,
        title: editingItem.title,
        emoji: sanitizeScheduleEmoji(editingItem.emoji),
        source: "manual",
        colorKey: editingItem.colorKey ?? pickScheduleColorKey(editingItem.startTime),
      });
    }
    setEditingItem(null);
    refreshPlans();
    onNotice?.(dayCount > 1 ? `Created ${dayCount} days of schedule` : "Event saved");
  };

  const handleDeleteItem = () => {
    if (!selectedOwner || !editingItem?.id) return;
    const targetWeekStart = getWeekStartIso(parseIsoDate(editingItem.originalDate || editingItem.date));
    deleteCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, targetWeekStart, editingItem.id);
    setEditingItem(null);
    refreshPlans();
    onNotice?.("Event deleted");
  };

  const handleGenerate = async () => {
    if (!selectedOwner || isGenerating || selectedOwner.ownerType !== "character") return;
    setShowGenerateConfirm(false);
    setIsGenerating(true);
    const result = await generateWeeklyCalendarSchedule(selectedOwner.ownerType, selectedOwner.ownerId, weekStart);
    setIsGenerating(false);
    if (!result.success) {
      onNotice?.(result.error || "Generation failed");
      return;
    }
    refreshPlans();
    onNotice?.("This week's schedule has been generated");
  };

  // ── Menstrual cycle ──
  const refreshMenstrual = () => {
    setMenstrualConfig(loadMenstrualConfig());
    setMenstrualRecords(loadMenstrualRecords());
  };

  const openMenstrualSettings = () => {
    setMenstrualDraft({
      cycleLength: String(menstrualConfig.cycleLength),
      periodLength: String(menstrualConfig.periodLength),
      periodCareEnabled: menstrualConfig.periodCareEnabled,
      periodCareCharacterIds: menstrualConfig.periodCareCharacterIds,
      periodCareLeadDays: String(menstrualConfig.periodCareLeadDays) as "1" | "2" | "3",
    });
    setShowMenstrualSettings(true);
  };

  const togglePeriodCareCharacter = (characterId: string) => {
    setMenstrualDraft(prev => {
      const selected = new Set(prev.periodCareCharacterIds);
      if (selected.has(characterId)) selected.delete(characterId);
      else selected.add(characterId);
      return { ...prev, periodCareCharacterIds: Array.from(selected) };
    });
  };

  const handleSaveMenstrualSettings = () => {
    const cycleLength = Number(menstrualDraft.cycleLength);
    const periodLength = Number(menstrualDraft.periodLength);
    const error = validateMenstrualSettings({ cycleLength, periodLength });
    if (error) {
      onNotice?.(error);
      return;
    }
    const availableCharacterIds = new Set(periodCareCharacterOptions.map(option => option.characterId));
    const periodCareCharacterIds = menstrualDraft.periodCareCharacterIds.filter(id => availableCharacterIds.has(id));
    if (menstrualDraft.periodCareEnabled && periodCareCharacterIds.length === 0) {
      onNotice?.("Please select at least one character you already have a chat with");
      return;
    }
    const savedConfig = saveMenstrualConfig({
      ...menstrualConfig,
      cycleLength,
      periodLength,
      periodCareEnabled: menstrualDraft.periodCareEnabled,
      periodCareCharacterIds,
      periodCareLeadDays: Number(menstrualDraft.periodCareLeadDays) as 1 | 2 | 3,
    });
    setMenstrualConfig(savedConfig);
    window.dispatchEvent(new CustomEvent("menstrual-period-care-updated"));
    setShowMenstrualSettings(false);
    onNotice?.("Cycle settings saved");
  };

  const canCancelSelectedStart = menstrualSummary.currentPeriodStartDate === selectedDate && !menstrualSummary.todayFinished;
  const canStartSelected = !menstrualSummary.todayStarted && !menstrualSummary.isPeriodActive;
  const canCancelSelectedFinish = menstrualSummary.todayFinished;
  const canFinishSelected =
    menstrualSummary.isPeriodActive &&
    !!menstrualSummary.currentPeriodStartDate &&
    selectedDate >= menstrualSummary.currentPeriodStartDate &&
    !menstrualSummary.todayFinished;

  const cycleStateForSelected = cycleMap?.get(selectedDate) ?? null;
  const cycleSummaryLine = cycleStateForSelected
    ? `Cycle · ${cycleStateForSelected.label || cycleStateForSelected.shortLabel}`
    : menstrualSummary.isPeriodActive && menstrualSummary.currentPeriodStartDate
      ? `This period started ${formatSimpleDate(menstrualSummary.currentPeriodStartDate)}`
      : menstrualSummary.latest
        ? null
        : "Tap “Period started” to begin tracking and predicting";

  // Detail page's cycle check-in row (user view only).
  const cyclePanel = selectedOwner?.ownerType === "user" ? (
    <div className="calendar-cycle-line">
      <i className="calendar-cycle-dot" data-type={cycleStateForSelected?.type ?? "period"} aria-hidden="true" />
      <span className="calendar-cycle-line-text">{cycleSummaryLine ?? "Cycle record"}</span>
      {canCancelSelectedStart ? (
        <button type="button" className="calendar-mini-btn" data-variant="primary" onClick={() => {
          setMenstrualConfig(cancelCurrentPeriodStart(selectedDate));
          setMenstrualRecords(loadMenstrualRecords());
          onNotice?.("Undid “period started” for this day");
        }}>Undo start</button>
      ) : (
        <button type="button" className="calendar-mini-btn" data-variant="primary" disabled={!canStartSelected} onClick={() => {
          setMenstrualConfig(startCurrentPeriod(selectedDate));
          setMenstrualRecords(loadMenstrualRecords());
          onNotice?.("Recorded “period started”");
        }}>Period started</button>
      )}
      {canCancelSelectedFinish ? (
        <button type="button" className="calendar-mini-btn" data-variant="primary" onClick={() => {
          const result = cancelFinishCurrentPeriod(selectedDate);
          if (!result.restored) {
            onNotice?.("No “period ended” record for this day yet");
            return;
          }
          setMenstrualConfig(result.config);
          setMenstrualRecords(result.records);
          onNotice?.("Undid “period ended” for this day");
        }}>Undo end</button>
      ) : (
        <button type="button" className="calendar-mini-btn" data-variant="ghost" disabled={!canFinishSelected} onClick={() => {
          const result = finishCurrentPeriod(selectedDate);
          if (!result.saved) {
            onNotice?.("Please record “period started” first");
            return;
          }
          setMenstrualConfig(result.config);
          setMenstrualRecords(result.records);
          onNotice?.("Recorded “period ended”");
        }}>Period ended</button>
      )}
    </div>
  ) : null;

  const ownerStrip = (
    <section className="calendar-owner-strip hide-scrollbar">
      {owners.map(owner => (
        <button
          key={owner.key}
          type="button"
          className="calendar-owner-chip"
          data-active={owner.key === selectedKey ? "true" : undefined}
          onClick={() => {
            setFabMenuOpen(false);
            setSelectedKey(owner.key);
            setSelectedDate(todayIso);
          }}
        >
          <Avatar src={owner.avatar || undefined} name={owner.name} size="md" />
          <span>{owner.name}</span>
        </button>
      ))}
    </section>
  );

  const openDetail = (date: string) => {
    setSelectedDate(date);
    setDetailKey(k => k + 1);
    setView("detail");
  };

  return (
    <div className="calendar-app-shell" data-calendar-theme={config.theme}>
      {appliedCalendarCss && <SessionCustomCSS css={appliedCalendarCss} scope=".calendar-app-shell" />}
      <div className="calendar-app">
        {view === "month" ? (
          <CalendarMonthPage
            todayIso={todayIso}
            itemsByDate={itemsByDate}
            cycleMap={cycleMap}
            ownerStrip={ownerStrip}
            onPickDay={openDetail}
            onClose={onClose}
            onOpenTheme={() => setShowThemePanel(true)}
          />
        ) : (
          <CalendarDetailPage
            key={detailKey}
            initialDate={selectedDate}
            todayIso={todayIso}
            itemsByDate={itemsByDate}
            cycleMap={cycleMap}
            cyclePanel={cyclePanel}
            daysPerPage={config.daysPerPage}
            onOpenDaysPicker={() => setShowDaysPanel(true)}
            onOpenCycleSettings={selectedOwner?.ownerType === "user" ? openMenstrualSettings : null}
            onBack={() => setView("month")}
            onSelectedChange={setSelectedDate}
            onEditItem={openEditItem}
          />
        )}

        {fabMenuOpen ? <div className="calendar-fab-backdrop" onClick={() => setFabMenuOpen(false)} /> : null}
        <div className="calendar-fab-stack">
          {fabMenuOpen && selectedOwner?.ownerType === "character" ? (
            <div className="calendar-fab-menu" role="menu">
              <button
                type="button"
                className="calendar-fab-menu-item"
                onClick={() => {
                  setFabMenuOpen(false);
                  openNewDraft(view === "detail" ? selectedDate : todayIso);
                }}
              >
                <Plus size={15} />
                New Event
              </button>
              <button
                type="button"
                className="calendar-fab-menu-item"
                disabled={isGenerating}
                onClick={() => {
                  setFabMenuOpen(false);
                  setShowGenerateConfirm(true);
                }}
              >
                <Wand2 size={15} />
                {isGenerating ? "Generating…" : "AI Generate This Week"}
              </button>
              <button
                type="button"
                className="calendar-fab-menu-item"
                data-on={autoGenerateEnabled ? "true" : undefined}
                onClick={() => {
                  setFabMenuOpen(false);
                  setShowAutoConfirm(true);
                }}
              >
                <Bot size={15} />
                Weekly Auto-Generate
                <i className="calendar-fab-menu-state">{autoGenerateEnabled ? "On" : "Off"}</i>
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="calendar-fab calendar-fab-primary"
            data-loading={isGenerating ? "true" : undefined}
            onClick={() => {
              if (selectedOwner?.ownerType === "character") {
                setFabMenuOpen(prev => !prev);
              } else {
                openNewDraft(view === "detail" ? selectedDate : todayIso);
              }
            }}
            aria-label={selectedOwner?.ownerType === "character" ? "Schedule actions menu" : "New event"}
            aria-expanded={selectedOwner?.ownerType === "character" ? fabMenuOpen : undefined}
          >
            <Plus size={20} style={{ transform: fabMenuOpen ? "rotate(45deg)" : undefined, transition: "transform 0.2s" }} />
          </button>
        </div>
      </div>

      {showThemePanel && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowThemePanel(false)}>
          <div className="calendar-edit-modal calendar-theme-modal" onClick={e => e.stopPropagation()}>
            <div className="calendar-theme-modal-head">
              <strong>Theme</strong>
              <button type="button" onClick={() => setShowThemePanel(false)} className="calendar-icon-btn" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="calendar-theme-grid">
              {CALENDAR_THEMES.map(theme => (
                <button
                  key={theme.id}
                  type="button"
                  className="calendar-theme-option"
                  data-active={config.theme === theme.id ? "true" : undefined}
                  onClick={() => {
                    const nextConfig = { ...config, theme: theme.id };
                    setConfig(nextConfig);
                    saveCalendarConfig(nextConfig);
                  }}
                >
                  <span className="calendar-theme-swatch" data-theme-id={theme.id} aria-hidden="true" />
                  <span>{theme.name}</span>
                </button>
              ))}
            </div>

            <div className="calendar-theme-css-label">Custom CSS</div>
            <textarea
              className="calendar-css-textarea"
              value={calendarCustomCss}
              onChange={e => setCalendarCustomCss(e.target.value)}
              placeholder="/* Enter CSS to override the calendar's styling... */"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="calendar-theme-css-actions">
              <CSSSchemeBar
                target="calendar"
                currentCSS={calendarCustomCss}
                onLoad={setCalendarCustomCss}
                btnStyle={{
                  width: 30,
                  height: 30,
                  border: "none",
                  background: "var(--c-calendar-surface)",
                  color: "var(--c-calendar-ink)",
                }}
                modalVars={{
                  panel: "var(--c-calendar-bg)",
                  border: "var(--c-calendar-surface-2)",
                  text: "var(--c-calendar-ink)",
                  textDim: "var(--c-calendar-sub)",
                  input: "var(--c-calendar-surface)",
                  inputBorder: "var(--c-calendar-surface-2)",
                  accent: "var(--c-calendar-today)",
                }}
              />
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setCalendarCustomCss(CALENDAR_CSS_EXAMPLE)}>Example</button>
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setCalendarCustomCss("")}>Clear</button>
              <button type="button" className="calendar-block-btn" data-variant="primary" onClick={handleApplyCalendarCss}>Apply</button>
            </div>
          </div>
        </div>
      )}

      {showDaysPanel && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowDaysPanel(false)}>
          <div className="calendar-edit-modal calendar-days-modal" onClick={e => e.stopPropagation()}>
            <div className="calendar-theme-modal-head">
              <strong>Days Per Page</strong>
              <button type="button" onClick={() => setShowDaysPanel(false)} className="calendar-icon-btn" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="calendar-days-options">
              {CALENDAR_DAYS_PER_PAGE_OPTIONS.map(n => (
                <button
                  key={n}
                  type="button"
                  className="calendar-days-option"
                  data-active={config.daysPerPage === n ? "true" : undefined}
                  onClick={() => {
                    const nextConfig = { ...config, daysPerPage: n };
                    setConfig(nextConfig);
                    saveCalendarConfig(nextConfig);
                    setShowDaysPanel(false);
                  }}
                >
                  <b>{n}</b>
                  <span>{n === 1 ? "1 day" : `${n} days`}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {editingItem && (
        <CalendarEventEditModal
          draft={editingItem}
          onChange={next => setEditingItem(prev => (prev ? { ...prev, ...next } : next))}
          onSave={handleSaveDraft}
          onDelete={handleDeleteItem}
          onClose={() => setEditingItem(null)}
        />
      )}

      {showMenstrualSettings && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowMenstrualSettings(false)}>
          <div className="calendar-edit-modal calendar-menstrual-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header" data-ui="modal-header">
              <button onClick={() => setShowMenstrualSettings(false)} className="modal-header-btn modal-header-btn-muted" aria-label="Back">
                <ChevronLeft size={18} />
              </button>
              <span className="modal-header-title">Cycle Settings</span>
              <button onClick={handleSaveMenstrualSettings} className="modal-header-btn modal-header-btn-action" aria-label="Save">
                <Check size={18} />
              </button>
            </div>

            <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10" data-ui="modal-body">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">Cycle Length</label>
                  <Input
                    type="number"
                    min={21}
                    max={60}
                    value={menstrualDraft.cycleLength}
                    onChange={e => setMenstrualDraft(prev => ({ ...prev, cycleLength: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">Period Length</label>
                  <Input
                    type="number"
                    min={2}
                    max={10}
                    value={menstrualDraft.periodLength}
                    onChange={e => setMenstrualDraft(prev => ({ ...prev, periodLength: e.target.value }))}
                  />
                </div>
              </div>

              <div className="calendar-menstrual-care-panel">
                <button
                  type="button"
                  className="calendar-menstrual-care-toggle"
                  data-active={menstrualDraft.periodCareEnabled ? "true" : undefined}
                  onClick={() => setMenstrualDraft(prev => ({ ...prev, periodCareEnabled: !prev.periodCareEnabled }))}
                >
                  <span className="calendar-menstrual-care-toggle-icon">
                    <HeartPulse size={16} />
                  </span>
                  <span className="calendar-menstrual-care-toggle-copy">
                    <strong>Let them look out for my period</strong>
                    <span>Only shows characters you already have a chat with</span>
                  </span>
                  <span className="calendar-menstrual-pill-switch" aria-hidden="true">
                    <span className="calendar-menstrual-pill-switch-thumb" />
                  </span>
                </button>

                {menstrualDraft.periodCareEnabled ? (
                  <div className="calendar-menstrual-care-body">
                    <div className="calendar-menstrual-care-section">
                      <label className="menu-desc ml-1">How Far Ahead to Check In</label>
                      <div className="calendar-period-care-lead-row">
                        {(["1", "2", "3"] as const).map(value => (
                          <button
                            key={value}
                            type="button"
                            className="calendar-period-care-lead"
                            data-active={menstrualDraft.periodCareLeadDays === value ? "true" : undefined}
                            onClick={() => setMenstrualDraft(prev => ({ ...prev, periodCareLeadDays: value }))}
                          >
                            {value}d
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="calendar-menstrual-care-section">
                      <label className="menu-desc ml-1">Choose Characters</label>
                      {periodCareCharacterOptions.length > 0 ? (
                        <div className="calendar-period-care-avatars">
                          {periodCareCharacterOptions.map(option => {
                            const selected = menstrualDraft.periodCareCharacterIds.includes(option.characterId);
                            return (
                              <button
                                key={option.characterId}
                                type="button"
                                className="calendar-period-care-avatar"
                                data-active={selected ? "true" : undefined}
                                onClick={() => togglePeriodCareCharacter(option.characterId)}
                              >
                                <Avatar src={option.avatar || undefined} name={option.name} size="md" />
                                <span>{option.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="calendar-menstrual-empty">Characters you already have a chat with will show up here.</div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              {menstrualRecords.length > 0 ? (
                <div className="calendar-menstrual-modal-history">
                  <label className="menu-desc ml-1">Recently Completed Periods</label>
                  <div className="calendar-menstrual-modal-list">
                    {menstrualRecords.slice(0, 4).map(record => (
                      <div key={record.id} className="calendar-menstrual-modal-item">
                        <div>
                          <strong>{formatSimpleDate(record.startDate)} - {formatSimpleDate(record.endDate)}</strong>
                          <span>{record.startDate} to {record.endDate}</span>
                        </div>
                        <button
                          type="button"
                          className="calendar-menstrual-modal-delete"
                          onClick={() => {
                            setMenstrualRecords(deleteMenstrualRecord(record.id));
                            refreshMenstrual();
                            onNotice?.("Period record deleted");
                          }}
                          aria-label="Delete record"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="calendar-menstrual-empty">No completed periods recorded yet. Tap "Period started" on the schedule page, then "Period ended" when it's over.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {showGenerateConfirm && selectedOwner && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowGenerateConfirm(false)}>
          <div className="calendar-edit-modal calendar-confirm-dialog" onClick={e => e.stopPropagation()}>
            <Wand2 size={26} className="calendar-confirm-icon" />
            <div className="calendar-confirm-title">Generate this week's schedule?</div>
            <div className="calendar-confirm-desc">
              This will generate a week of schedule for <strong>{selectedOwner.name}</strong> and overwrite the current AI-generated plan (manually added events are kept)
            </div>
            <div className="calendar-confirm-footer">
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setShowGenerateConfirm(false)}>Cancel</button>
              <button
                type="button"
                className="calendar-block-btn"
                data-variant="primary"
                data-loading={isGenerating ? "true" : undefined}
                onClick={handleGenerate}
                disabled={isGenerating}
                aria-busy={isGenerating}
              >
                {isGenerating ? "Generating…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAutoConfirm && selectedOwner && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowAutoConfirm(false)}>
          <div className="calendar-edit-modal calendar-confirm-dialog" onClick={e => e.stopPropagation()}>
            <Bot size={26} className="calendar-confirm-icon" />
            <div className="calendar-confirm-title">
              {autoGenerateEnabled ? "Turn off auto-generate?" : "Turn on auto-generate?"}
            </div>
            <div className="calendar-confirm-desc">
              {autoGenerateEnabled
                ? "Once off, a weekly schedule will no longer be generated for this character automatically"
                : <>A weekly schedule will be generated automatically for <strong>{selectedOwner.name}</strong></>}
            </div>
            <div className="calendar-confirm-footer">
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setShowAutoConfirm(false)}>Cancel</button>
              <button
                type="button"
                className="calendar-block-btn"
                data-variant="primary"
                onClick={() => {
                  const next = !autoGenerateEnabled;
                  const nextConfig = { ...config, autoGenerateEnabled: next };
                  setConfig(nextConfig);
                  saveCalendarConfig(nextConfig);
                  setShowAutoConfirm(false);
                  onNotice?.(next ? "Weekly auto-generate turned on" : "Weekly auto-generate turned off");
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
