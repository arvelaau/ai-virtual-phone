/**
 * Small lunar-calendar labels for the month view: an Intl-based Chinese-calendar lookup, zero
 * data tables. Modern browsers (Chromium / Safari / Firefox) all support the "zh-u-ca-chinese"
 * calendar; where it isn't supported this silently returns null and the calendar just shows no
 * lunar label -- nothing else breaks.
 *
 * Labels are rendered as ordinal numbers ("1st", "15th", "Leap 4th Month") rather than the
 * traditional Chinese day/month names (初一, 正月, 腊月, ...) -- those names carry cultural
 * meaning a literal word-for-word translation would lose or misrepresent, and a numbered form is
 * how bilingual/English lunar-calendar apps conventionally render the same information.
 */

export type LunarInfo = {
  /** Month label, e.g. "1st Month" / "Leap 4th Month" / "12th Month". */
  monthLabel: string;
  /** Day label, e.g. "1st" / "15th" / "23rd". */
  dayLabel: string;
  /** Whether this day is the first of the lunar month (the cell shows the month label then). */
  isFirstDay: boolean;
  /** The small label shown in a month-view cell: the month label on the 1st, the day label otherwise. */
  cellLabel: string;
};

let lunarFormatter: Intl.DateTimeFormat | null | undefined;
const lunarCache = new Map<string, LunarInfo | null>();
const LUNAR_CACHE_LIMIT = 800;

function getFormatter(): Intl.DateTimeFormat | null {
  if (lunarFormatter !== undefined) return lunarFormatter;
  try {
    lunarFormatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "numeric",
      day: "numeric",
    });
    // Quick self-check: only usable if it actually formats and yields a day part.
    const parts = lunarFormatter.formatToParts(new Date(2024, 1, 10));
    if (!parts.some(part => part.type === "day")) lunarFormatter = null;
  } catch {
    lunarFormatter = null;
  }
  return lunarFormatter;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Gets a given day's lunar info; returns null when the environment doesn't support it. */
export function getLunarInfo(date: Date): LunarInfo | null {
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  if (lunarCache.has(key)) return lunarCache.get(key) ?? null;

  const formatter = getFormatter();
  let info: LunarInfo | null = null;
  if (formatter) {
    try {
      const parts = formatter.formatToParts(date);
      const monthPart = parts.find(part => part.type === "month")?.value ?? "";
      const dayPart = parts.find(part => part.type === "day")?.value ?? "";
      const dayNumber = Number(dayPart);
      if (dayNumber >= 1 && dayNumber <= 30) {
        // The month part can come back as "4", "闰4" (leap), or similar -- resolveMonthNumber()
        // normalizes any of those shapes to a plain 1-12 month number.
        const isLeap = monthPart.includes("闰");
        const monthText = monthPart.replace("闰", "").replace("月", "");
        const monthNumber = resolveMonthNumber(monthText);
        const monthLabel = monthNumber >= 1
          ? `${isLeap ? "Leap " : ""}${ordinal(monthNumber)} Month`
          : `${isLeap ? "Leap " : ""}Month ${monthText}`;
        const dayLabel = ordinal(dayNumber);
        info = {
          monthLabel,
          dayLabel,
          isFirstDay: dayNumber === 1,
          cellLabel: dayNumber === 1 ? monthLabel : dayLabel,
        };
      }
    } catch {
      info = null;
    }
  }

  if (lunarCache.size >= LUNAR_CACHE_LIMIT) lunarCache.clear();
  lunarCache.set(key, info);
  return info;
}

/** Normalizes a Chinese-calendar month part (which can arrive as a plain number or one of
 *  several traditional month-name forms) to a plain 1-12 month number, or -1 if unrecognized. */
function resolveMonthNumber(text: string): number {
  const numeric = Number(text);
  if (numeric >= 1 && numeric <= 12) return numeric;
  if (text === "正" || text === "一") return 1;
  if (text === "冬" || text === "十一") return 11;
  if (text === "腊" || text === "十二") return 12;
  if (text === "十") return 10;
  const base = ["二", "三", "四", "五", "六", "七", "八", "九"].indexOf(text);
  if (base >= 0) return base + 2;
  return -1;
}

/** Convenience entry point taking an ISO (YYYY-MM-DD) date string. */
export function getLunarInfoByIso(isoDate: string): LunarInfo | null {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return getLunarInfo(date);
}
