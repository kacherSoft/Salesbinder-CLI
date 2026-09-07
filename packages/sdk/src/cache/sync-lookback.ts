const DEFAULT_SYNC_LOOKBACK_SECONDS = 604800;

/** Resolve a configured delta overlap without permitting silent future/NaN cutoffs. */
export function resolveSyncLookbackSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_SYNC_LOOKBACK_SECONDS;

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Sync lookback seconds must be a non-negative safe integer.');
  }
  return parsed;
}
