import { resolveSyncLookbackSeconds } from '../sync-lookback.js';

describe('resolveSyncLookbackSeconds', () => {
  it('uses the seven-day default only when the value is absent', () => {
    expect(resolveSyncLookbackSeconds(undefined)).toBe(604800);
  });

  it.each([
    [0, 0],
    [60, 60],
    ['0', 0],
    [' 604800 ', 604800],
  ])('accepts a canonical non-negative integer value %p', (value, expected) => {
    expect(resolveSyncLookbackSeconds(value)).toBe(expected);
  });

  it.each([null, '', ' ', '-1', '+1', '1.5', 'junk', -1, 1.5, Number.NaN, Infinity])(
    'rejects invalid lookback value %p',
    (value) => {
      expect(() => resolveSyncLookbackSeconds(value)).toThrow(/lookback/i);
    }
  );

  it('rejects integers outside the safe range', () => {
    expect(() => resolveSyncLookbackSeconds(Number.MAX_SAFE_INTEGER + 1)).toThrow(/lookback/i);
    expect(() => resolveSyncLookbackSeconds('9007199254740992')).toThrow(/lookback/i);
  });
});
