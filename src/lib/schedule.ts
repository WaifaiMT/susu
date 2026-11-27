import type { Frequency } from "@/db/schema";

// Dates here are calendar dates ("2027-01-31"), not instants. Ghana is on GMT
// all year with no daylight saving, so UTC is the group's local time.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Rejects dates that roll over, like 2027-02-30
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayIso(now = new Date()): string {
  return toIsoDate(now);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Due date of every round in a cycle. Monthly rounds keep the start day and
 * fall back to the month's last day when it's shorter: a cycle starting on
 * 31 January is due on 28 (or 29) February, then 31 March, 30 April.
 */
export function roundDueDates(startsOn: string, frequency: Frequency, count: number): string[] {
  const start = parseIsoDate(startsOn);
  if (!start) throw new Error(`Invalid date: ${startsOn}`);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();

  return Array.from({ length: count }, (_, i) => {
    if (frequency === "daily") return toIsoDate(new Date(Date.UTC(year, month, day + i)));
    if (frequency === "weekly") return toIsoDate(new Date(Date.UTC(year, month, day + 7 * i)));
    const targetMonth = month + i;
    const y = year + Math.floor(targetMonth / 12);
    const m = ((targetMonth % 12) + 12) % 12;
    return toIsoDate(new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m)))));
  });
}

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** "2027-01-31" → "Sun, 31 Jan 2027" */
export function formatDay(iso: string): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
