import { readFileSync } from 'fs';
import { resolve } from 'path';
import { requiresFullItemSync } from './cache.commands.js';

describe('cache sync scope', () => {
  it('preserves item full-sync intent when document full sync resumes', () => {
    expect(requiresFullItemSync(false, 'full')).toBe(true);
  });

  it('keeps ordinary matched-cache deltas incremental', () => {
    expect(requiresFullItemSync(false, 'delta')).toBe(false);
  });

  it('honors an explicit item full request', () => {
    expect(requiresFullItemSync(true, 'delta')).toBe(true);
  });

  it('routes every analytics command through the read-before-write cache helper', () => {
    const analyticsCommands = [
      'customers.command.ts',
      'forecast.command.ts',
      'inventory.command.ts',
      'item-sales.command.ts',
      'patterns.command.ts',
      'pricing.command.ts',
      'trends.command.ts',
    ];
    for (const file of analyticsCommands) {
      const source = readFileSync(resolve(__dirname, '..', 'analytics', file), 'utf8');
      expect(source).toContain('prepareAnalyticsCache');
      expect(source).not.toContain('createCacheService(accountName, undefined, !options.cached)');
    }
  });
});
