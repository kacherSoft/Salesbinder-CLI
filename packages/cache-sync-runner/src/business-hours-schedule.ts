import type { BusinessHoursSchedule } from './scheduler-config.js';

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
}

function localDateTime(timestamp: number, timezone: string): LocalDateTime {
  const parts = formatter(timezone).formatToParts(timestamp);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  ) as Record<string, string>;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: weekdayNumbers[values.weekday],
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localTimestamp(date: LocalDateTime): number {
  return Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second);
}

function startOfLocalBusinessHour(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string
): number | null {
  const target = Date.UTC(year, month - 1, day, hour);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = localDateTime(candidate, timezone);
    candidate += target - localTimestamp({ ...observed, weekday: 0 });
  }
  const result = localDateTime(candidate, timezone);
  return result.year === year &&
    result.month === month &&
    result.day === day &&
    result.hour === hour
    ? candidate
    : null;
}

export function isWithinBusinessHours(timestamp: number, schedule: BusinessHoursSchedule): boolean {
  const local = localDateTime(timestamp, schedule.timezone);
  return (
    schedule.days.includes(local.weekday) &&
    local.hour >= schedule.startHour &&
    local.hour < schedule.endHour
  );
}

export function nextBusinessHoursStart(timestamp: number, schedule: BusinessHoursSchedule): number {
  const local = localDateTime(timestamp, schedule.timezone);
  const currentLocalMidnight = Date.UTC(local.year, local.month - 1, local.day);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(currentLocalMidnight + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (!schedule.days.includes(weekday)) continue;
    const candidate = startOfLocalBusinessHour(
      year,
      month,
      day,
      schedule.startHour,
      schedule.timezone
    );
    if (candidate !== null && candidate > timestamp) return candidate;
  }
  throw new Error('Could not determine the next configured business-hours start.');
}
