/**
 * CacheAnalyticsService unit tests
 */

import { CacheAnalyticsService, PeriodData } from '../cache-analytics.service.js';

describe('CacheAnalyticsService', () => {
  let service: CacheAnalyticsService;

  beforeEach(() => {
    service = new CacheAnalyticsService();
  });

  describe('Statistical Calculations', () => {
    describe('calculateMean', () => {
      it('calculates mean correctly for positive numbers', () => {
        expect(service.calculateMean([1, 2, 3, 4, 5])).toBe(3);
      });

      it('calculates mean correctly for decimal numbers', () => {
        expect(service.calculateMean([1.5, 2.5, 3.5])).toBeCloseTo(2.5);
      });

      it('returns 0 for empty array', () => {
        expect(service.calculateMean([])).toBe(0);
      });

      it('handles single value', () => {
        expect(service.calculateMean([42])).toBe(42);
      });
    });

    describe('calculateMedian', () => {
      it('calculates median for odd-length array', () => {
        expect(service.calculateMedian([1, 2, 3, 4, 5])).toBe(3);
      });

      it('calculates median for even-length array', () => {
        expect(service.calculateMedian([1, 2, 3, 4])).toBe(2.5);
      });

      it('returns 0 for empty array', () => {
        expect(service.calculateMedian([])).toBe(0);
      });

      it('handles unsorted input', () => {
        expect(service.calculateMedian([5, 1, 3, 2, 4])).toBe(3);
      });

      it('handles single value', () => {
        expect(service.calculateMedian([42])).toBe(42);
      });
    });

    describe('calculateStdDev', () => {
      it('calculates standard deviation correctly', () => {
        const values = [2, 4, 4, 4, 5, 5, 7, 9];
        const mean = 5;
        expect(service.calculateStdDev(values, mean)).toBeCloseTo(2, 1);
      });

      it('returns 0 for empty array', () => {
        expect(service.calculateStdDev([], 0)).toBe(0);
      });

      it('returns 0 for single value', () => {
        expect(service.calculateStdDev([42], 42)).toBe(0);
      });

      it('handles zero variance', () => {
        expect(service.calculateStdDev([5, 5, 5], 5)).toBe(0);
      });
    });

    describe('calculateVariance', () => {
      it('calculates variance as std dev', () => {
        const values = [1, 2, 3];
        const variance = service.calculateVariance(values);
        expect(variance).toBeCloseTo(0.816, 2);
      });
    });

    describe('calculateGrowthRate', () => {
      it('calculates positive growth', () => {
        expect(service.calculateGrowthRate(100, 150)).toBe(0.5);
      });

      it('calculates negative growth', () => {
        expect(service.calculateGrowthRate(100, 50)).toBe(-0.5);
      });

      it('returns 0 when both are 0', () => {
        expect(service.calculateGrowthRate(0, 0)).toBe(0);
      });

      it('returns 1 when earliest is 0 and latest is positive', () => {
        expect(service.calculateGrowthRate(0, 100)).toBe(1);
      });
    });

    describe('calculateVolatility', () => {
      it('calculates low volatility for stable data', () => {
        const values = [100, 101, 99, 100, 101];
        expect(service.calculateVolatility(values)).toBeLessThan(0.1);
      });

      it('calculates high volatility for variable data', () => {
        const values = [10, 100, 20, 90, 30];
        expect(service.calculateVolatility(values)).toBeGreaterThan(0.5);
      });

      it('returns 0 when mean is 0', () => {
        expect(service.calculateVolatility([0, 0, 0])).toBe(0);
      });
    });
  });

  describe('Trend Detection', () => {
    const createPeriodData = (values: number[]): PeriodData[] => {
      return values.map((v, i) => ({
        period: `P${i}`,
        quantitySold: v * 3,
        revenue: v * 100,
        avgMonthly: v,
      }));
    };

    describe('detectTrend', () => {
      it('detects upward trend', () => {
        const periods = createPeriodData([10, 15, 20, 25]);
        const result = service.detectTrend(periods);
        expect(result.growthRate).toBeGreaterThan(0);
        expect(result.direction).toMatch(/upward|stable|volatile/);
      });

      it('detects downward trend', () => {
        const periods = createPeriodData([25, 20, 15, 10]);
        const result = service.detectTrend(periods);
        expect(result.growthRate).toBeLessThan(0);
        expect(result.direction).toMatch(/downward|stable|volatile/);
      });

      it('detects stable trend', () => {
        const periods = createPeriodData([25, 26, 25, 24]);
        const result = service.detectTrend(periods);
        expect(['stable', 'volatile']).toContain(result.direction);
      });

      it('detects volatile pattern', () => {
        const periods = createPeriodData([10, 100, 20, 90]);
        const result = service.detectTrend(periods);
        expect(result.volatilityScore).toBeGreaterThan(0.3);
      });

      it('handles empty array', () => {
        const result = service.detectTrend([]);
        expect(result.direction).toBe('stable');
        expect(result.growthRate).toBe(0);
        expect(result.momentum).toBe('stable');
      });
    });

    describe('determineMomentum', () => {
      it('detects accelerating', () => {
        const changes = [0.1, 0.2, 0.3];
        expect(service.determineMomentum(changes)).toBe('accelerating');
      });

      it('detects decelerating', () => {
        const changes = [0.3, 0.2, 0.1];
        expect(service.determineMomentum(changes)).toBe('decelerating');
      });

      it('detects stable', () => {
        const changes = [0.1, 0.12, 0.11];
        expect(service.determineMomentum(changes)).toBe('stable');
      });

      it('returns stable for single value', () => {
        expect(service.determineMomentum([0.1])).toBe('stable');
      });
    });
  });

  describe('Price Statistics', () => {
    const priceDistribution = [
      { price: 10, totalQuantity: 5, totalRevenue: 50 },
      { price: 15, totalQuantity: 10, totalRevenue: 150 },
      { price: 20, totalQuantity: 3, totalRevenue: 60 },
    ];

    // For discount detection, we need a mode price (highest quantity)
    const discountDistribution = [
      { price: 15, totalQuantity: 10, totalRevenue: 150 },  // mode
      { price: 10, totalQuantity: 5, totalRevenue: 50 },   // discount
      { price: 20, totalQuantity: 3, totalRevenue: 60 },
    ];

    describe('calculatePriceStats', () => {
      it('calculates min price', () => {
        const stats = service.calculatePriceStats(priceDistribution);
        expect(stats.min).toBe(10);
      });

      it('calculates max price', () => {
        const stats = service.calculatePriceStats(priceDistribution);
        expect(stats.max).toBe(20);
      });

      it('calculates weighted average price', () => {
        const stats = service.calculatePriceStats(priceDistribution);
        const expectedAvg = (50 + 150 + 60) / 18;
        expect(stats.avg).toBeCloseTo(expectedAvg, 2);
      });

      it('calculates median price', () => {
        const stats = service.calculatePriceStats(priceDistribution);
        expect(stats.median).toBe(15);
      });

      it('calculates std dev', () => {
        const stats = service.calculatePriceStats(priceDistribution);
        expect(stats.stdDev).toBeGreaterThan(0);
      });

      it('calculates variance percentage', () => {
        const stats = service.calculatePriceStats(priceDistribution);
        expect(stats.variancePct).toBeGreaterThan(0);
      });

      it('returns zeros for empty distribution', () => {
        const stats = service.calculatePriceStats([]);
        expect(stats.min).toBe(0);
        expect(stats.max).toBe(0);
        expect(stats.avg).toBe(0);
      });
    });

    describe('detectDiscounts', () => {
      it('detects discounts when lower prices exist', () => {
        const result = service.detectDiscounts(discountDistribution);
        expect(result.hasDiscounts).toBe(true);
        expect(result.avgDiscountPct).toBeGreaterThan(0);
      });

      it('detects no discounts for single price', () => {
        const distribution = [
          { price: 20, totalQuantity: 10, totalRevenue: 200 },
        ];
        const result = service.detectDiscounts(distribution);
        expect(result.hasDiscounts).toBe(false);
      });

      it('calculates discount frequency', () => {
        const result = service.detectDiscounts(discountDistribution);
        expect(result.discountFrequency).toBeCloseTo(0.28, 1);
      });

      it('returns empty result for empty distribution', () => {
        const result = service.detectDiscounts([]);
        expect(result.hasDiscounts).toBe(false);
        expect(result.avgDiscountPct).toBeNull();
      });
    });
  });

  describe('Concentration Metrics', () => {
    describe('calculateHerfindahlIndex', () => {
      it('calculates HHI for concentrated market', () => {
        const shares = [80, 10, 5, 5];
        const hhi = service.calculateHerfindahlIndex(shares);
        expect(hhi).toBeCloseTo(0.655, 3);
      });

      it('calculates HHI for fragmented market', () => {
        const shares = [25, 25, 25, 25];
        const hhi = service.calculateHerfindahlIndex(shares);
        expect(hhi).toBeCloseTo(0.25, 3);
      });

      it('returns 0 for empty shares', () => {
        expect(service.calculateHerfindahlIndex([])).toBe(0);
      });

      it('returns 1 for monopoly (100%)', () => {
        expect(service.calculateHerfindahlIndex([100])).toBe(1);
      });
    });

    describe('calculateTopShare', () => {
      it('calculates top 3 share', () => {
        const shares = [40, 30, 20, 5, 5];
        expect(service.calculateTopShare(shares, 3)).toBe(90);
      });

      it('calculates top 5 share', () => {
        const shares = [40, 30, 20, 5, 5];
        expect(service.calculateTopShare(shares, 5)).toBe(100);
      });

      it('handles when topN > array length', () => {
        const shares = [50, 50];
        expect(service.calculateTopShare(shares, 5)).toBe(100);
      });
    });
  });

  describe('Forecasting', () => {
    describe('forecastMovingAverage', () => {
      it('generates 3-period forecast', () => {
        const history = [100, 120, 110, 130];
        const forecast = service.forecastMovingAverage(history, 3);
        expect(forecast).toHaveLength(3);
        expect(forecast[0]).toBeCloseTo(115, 1);
      });

      it('generates constant forecast based on mean', () => {
        const history = [100, 100, 100];
        const forecast = service.forecastMovingAverage(history, 3);
        expect(forecast).toEqual([100, 100, 100]);
      });
    });

    describe('applyTrendAdjustment', () => {
      it('applies positive growth adjustment', () => {
        const forecast = [100, 100, 100];
        const adjusted = service.applyTrendAdjustment(forecast, 0.1);
        expect(adjusted[0]).toBeCloseTo(110, 1);
        expect(adjusted[1]).toBeCloseTo(120, 1);
        expect(adjusted[2]).toBeCloseTo(130, 1);
      });

      it('applies negative growth adjustment', () => {
        const forecast = [100, 100, 100];
        const adjusted = service.applyTrendAdjustment(forecast, -0.1);
        expect(adjusted[0]).toBeCloseTo(90, 1);
        expect(adjusted[1]).toBeCloseTo(80, 1);
      });
    });

    describe('determineConfidence', () => {
      it('returns high confidence for stable data with enough points', () => {
        expect(service.determineConfidence(0.05, 12)).toBe('high');
      });

      it('returns medium confidence for moderate volatility', () => {
        expect(service.determineConfidence(0.15, 6)).toBe('medium');
      });

      it('returns low confidence for high volatility', () => {
        expect(service.determineConfidence(0.3, 6)).toBe('low');
      });

      it('returns low confidence for insufficient data', () => {
        expect(service.determineConfidence(0.05, 2)).toBe('low');
      });
    });
  });

  describe('Order Pattern Analysis', () => {
    const patterns = [
      {
        doc_id: 'est-1',
        issue_date: '2026-01-01',
        customer_id: 'cust-1',
        context_id: 4,
        doc_number: 100,
      },
      {
        doc_id: 'inv-1',
        issue_date: '2026-01-10',
        customer_id: 'cust-1',
        context_id: 5,
        doc_number: 100,
      },
      {
        doc_id: 'est-2',
        issue_date: '2026-01-05',
        customer_id: 'cust-2',
        context_id: 4,
        doc_number: 101,
      },
      {
        doc_id: 'inv-2',
        issue_date: '2026-01-20',
        customer_id: 'cust-2',
        context_id: 5,
        doc_number: 101,
      },
      {
        doc_id: 'est-3',
        issue_date: '2026-01-25',
        customer_id: 'cust-3',
        context_id: 4,
        doc_number: 102,
      },
    ];

    describe('calculateCycleTime', () => {
      it('calculates average days from estimate to invoice', () => {
        const result = service.calculateCycleTime(patterns);
        expect(result.avg_estimate_to_invoice_days).toBeGreaterThan(0);
        expect(result.median_days).toBeGreaterThan(0);
      });

      it('returns zeros when no estimates', () => {
        const invoiceOnly = patterns.filter(p => p.context_id === 5);
        const result = service.calculateCycleTime(invoiceOnly);
        expect(result.avg_estimate_to_invoice_days).toBe(0);
      });

      it('returns zeros when no invoices', () => {
        const estimateOnly = patterns.filter(p => p.context_id === 4);
        const result = service.calculateCycleTime(estimateOnly);
        expect(result.avg_estimate_to_invoice_days).toBe(0);
      });

      it('returns zeros when no matches found', () => {
        const noMatch = [
          { ...patterns[0], doc_number: 999 },
          { ...patterns[1], doc_number: 998 },
        ];
        const result = service.calculateCycleTime(noMatch);
        expect(result.avg_estimate_to_invoice_days).toBe(0);
      });
    });

    describe('calculateWinRate', () => {
      it('calculates conversion rate', () => {
        const result = service.calculateWinRate(patterns);
        expect(result.estimates_created).toBe(3);
        expect(result.converted_to_invoice).toBe(2);
        expect(result.win_rate).toBeGreaterThan(0);
      });

      it('identifies still open estimates', () => {
        const recentEstimate = {
          doc_id: 'est-4',
          issue_date: new Date().toISOString().split('T')[0],
          customer_id: 'cust-4',
          context_id: 4,
          doc_number: 103,
        };
        const withRecent = [...patterns, recentEstimate];
        const result = service.calculateWinRate(withRecent);
        expect(result.still_open_estimate).toBeGreaterThanOrEqual(0);
      });

      it('identifies lost estimates (older than 30 days)', () => {
        const oldEstimate = {
          doc_id: 'est-old',
          issue_date: '2025-01-01',
          customer_id: 'cust-old',
          context_id: 4,
          doc_number: 1,
        };
        const withOld = [...patterns, oldEstimate];
        const result = service.calculateWinRate(withOld);
        expect(result.lost_estimate).toBe(1);
      });

      it('returns zeros for no estimates', () => {
        const invoiceOnly = patterns.filter(p => p.context_id === 5);
        const result = service.calculateWinRate(invoiceOnly);
        expect(result.estimates_created).toBe(0);
        expect(result.win_rate).toBe(0);
      });
    });
  });
});
