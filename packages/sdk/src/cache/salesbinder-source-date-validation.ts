const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SALESBINDER_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

export function isValidSalesBinderCalendarDateText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  if (year === 0) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const roundTrip = new Date(0);
  roundTrip.setUTCHours(0, 0, 0, 0);
  roundTrip.setUTCFullYear(year, month - 1, day);
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

export function isValidSalesBinderTimestampText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SALESBINDER_TIMESTAMP_PATTERN.exec(value);
  return (
    match !== null &&
    isValidSalesBinderCalendarDateText(match[1]) &&
    Number.isFinite(new Date(value).getTime())
  );
}

export function isValidSalesBinderDateText(value: unknown): value is string {
  return isValidSalesBinderCalendarDateText(value) || isValidSalesBinderTimestampText(value);
}

export function toSalesBinderCalendarDateText(value: string): string {
  return value.slice(0, 10);
}
