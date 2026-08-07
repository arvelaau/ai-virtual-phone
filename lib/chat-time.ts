const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function padTwo(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

export function formatChatUiTime(dateStr: string): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const hhmm = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    if (date.getTime() >= todayStart.getTime()) {
        return hhmm;
    }
    if (date.getTime() >= yesterdayStart.getTime()) {
        return `Yesterday ${hhmm}`;
    }

    const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 86400000);
    if (date.getTime() >= sevenDaysAgo.getTime()) {
        return `${WEEKDAY_NAMES[date.getDay()]} ${hhmm}`;
    }

    if (date.getFullYear() === now.getFullYear()) {
        return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${hhmm}`;
    }

    return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()} ${hhmm}`;
}
