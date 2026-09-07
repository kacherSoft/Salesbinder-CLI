import { isWithinBusinessHours, nextBusinessHoursStart } from './business-hours-schedule.js';

const schedule = {
  timezone: 'Asia/Ho_Chi_Minh',
  days: [1, 2, 3, 4, 5, 6],
  startHour: 7,
  endHour: 22,
};

test('applies Ho Chi Minh weekday and hour boundaries under a UTC host clock', () => {
  expect(isWithinBusinessHours(Date.parse('2026-09-06T23:59:00Z'), schedule)).toBe(false); // Monday 06:59
  expect(isWithinBusinessHours(Date.parse('2026-09-07T00:00:00Z'), schedule)).toBe(true); // Monday 07:00
  expect(isWithinBusinessHours(Date.parse('2026-09-07T14:59:00Z'), schedule)).toBe(true); // Monday 21:59
  expect(isWithinBusinessHours(Date.parse('2026-09-07T15:00:00Z'), schedule)).toBe(false); // Monday 22:00
  expect(isWithinBusinessHours(Date.parse('2026-09-06T03:00:00Z'), schedule)).toBe(false); // Sunday
});

test('sleeps across the Saturday close and Sunday to Monday at 07:00 local time', () => {
  expect(nextBusinessHoursStart(Date.parse('2026-09-05T15:00:00Z'), schedule)).toBe(
    Date.parse('2026-09-07T00:00:00Z')
  );
  expect(nextBusinessHoursStart(Date.parse('2026-09-06T03:00:00Z'), schedule)).toBe(
    Date.parse('2026-09-07T00:00:00Z')
  );
});
