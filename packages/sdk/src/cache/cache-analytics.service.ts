/**
 * Analytics calculation service for statistical computations
 */

export interface PeriodData {
  period: string;
  quantitySold: number;
  revenue: number;
  avgMonthly: number;
}

export interface TrendResult {
  direction: 'upward' | 'downward' | 'stable' | 'volatile';
  growthRate: number;
  momentum: 'accelerating' | 'decelerating' | 'stable';
  volatilityScore: number;
}

export interface PriceDistribution {
  price: number;
  totalQuantity: number;
  totalRevenue: number;
}

export interface PriceStats {
  min: number;
  max: number;
  avg: number;
  median: number;
  stdDev: number;
  variancePct: number;
}

export interface DiscountInfo {
  hasDiscounts: boolean;
  avgDiscountPct: number | null;
  discountFrequency: number;
}

/**
 * Cache analytics service for statistical calculations
 */
export class CacheAnalyticsService {
  /**
   * Calculate mean (average) of values
   */
  calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  }

  /**
   * Calculate median of values
   */
  calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Calculate standard deviation
   */
  calculateStdDev(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    if (values.length === 1) return 0;
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    const avgSquaredDiff = this.calculateMean(squaredDiffs);
    return Math.sqrt(avgSquaredDiff);
  }

  /**
   * Calculate variance
   */
  calculateVariance(values: number[]): number {
    const mean = this.calculateMean(values);
    return this.calculateStdDev(values, mean);
  }

  /**
   * Calculate growth rate between two values
   */
  calculateGrowthRate(earliest: number, latest: number): number {
    if (earliest === 0) return latest > 0 ? 1 : 0;
    return (latest - earliest) / earliest;
  }

  /**
   * Calculate coefficient of variation (volatility)
   */
  calculateVolatility(values: number[]): number {
    const mean = this.calculateMean(values);
    if (mean === 0) return 0;
    const stdDev = this.calculateStdDev(values, mean);
    return stdDev / Math.abs(mean);
  }

  /**
   * Determine momentum from period changes
   */
  determineMomentum(periodChanges: number[]): 'accelerating' | 'decelerating' | 'stable' {
    if (periodChanges.length < 2) return 'stable';

    const accelerationChanges: number[] = [];
    for (let i = 1; i < periodChanges.length; i++) {
      accelerationChanges.push(periodChanges[i] - periodChanges[i - 1]);
    }

    const avgAcceleration = this.calculateMean(accelerationChanges);
    const threshold = 0.05;

    if (avgAcceleration > threshold) return 'accelerating';
    if (avgAcceleration < -threshold) return 'decelerating';
    return 'stable';
  }

  /**
   * Detect trend from period data
   */
  detectTrend(periods: PeriodData[]): TrendResult {
    if (periods.length === 0) {
      return {
        direction: 'stable',
        growthRate: 0,
        momentum: 'stable',
        volatilityScore: 0,
      };
    }

    const avgMonthlyValues = periods.map((p) => p.avgMonthly);
    const first = avgMonthlyValues[0];
    const last = avgMonthlyValues[avgMonthlyValues.length - 1];

    const growthRate = this.calculateGrowthRate(first, last);
    const volatilityScore = this.calculateVolatility(avgMonthlyValues);

    const periodChanges: number[] = [];
    for (let i = 1; i < avgMonthlyValues.length; i++) {
      if (avgMonthlyValues[i - 1] !== 0) {
        periodChanges.push(
          (avgMonthlyValues[i] - avgMonthlyValues[i - 1]) / avgMonthlyValues[i - 1]
        );
      }
    }

    const momentum = this.determineMomentum(periodChanges);

    let direction: TrendResult['direction'];
    const growthThreshold = 0.1;
    const volatilityThreshold = 0.3;

    if (volatilityScore > volatilityThreshold) {
      direction = 'volatile';
    } else if (growthRate > growthThreshold) {
      direction = 'upward';
    } else if (growthRate < -growthThreshold) {
      direction = 'downward';
    } else {
      direction = 'stable';
    }

    return {
      direction,
      growthRate,
      momentum,
      volatilityScore,
    };
  }

  /**
   * Calculate price statistics from distribution
   */
  calculatePriceStats(distribution: PriceDistribution[]): PriceStats {
    if (distribution.length === 0) {
      return { min: 0, max: 0, avg: 0, median: 0, stdDev: 0, variancePct: 0 };
    }

    const prices = distribution.map((d) => d.price);

    const min = Math.min(...prices);
    const max = Math.max(...prices);

    const weightedSum = distribution.reduce((sum, d) => sum + d.price * d.totalQuantity, 0);
    const totalQuantity = distribution.reduce((sum, d) => sum + d.totalQuantity, 0);
    const avg = totalQuantity > 0 ? weightedSum / totalQuantity : 0;

    const median = this.calculateMedian(prices);
    const stdDev = this.calculateStdDev(prices, avg);
    const variancePct = avg !== 0 ? (stdDev / Math.abs(avg)) * 100 : 0;

    return { min, max, avg, median, stdDev, variancePct };
  }

  /**
   * Detect discounts from price distribution
   */
  detectDiscounts(distribution: PriceDistribution[]): DiscountInfo {
    if (distribution.length === 0) {
      return { hasDiscounts: false, avgDiscountPct: null, discountFrequency: 0 };
    }

    const totalQty = distribution.reduce((sum, d) => sum + d.totalQuantity, 0);
    if (totalQty === 0) {
      return { hasDiscounts: false, avgDiscountPct: null, discountFrequency: 0 };
    }

    const maxQty = Math.max(...distribution.map((d) => d.totalQuantity));
    const modePrice = distribution.find((d) => d.totalQuantity === maxQty);

    if (!modePrice) {
      return { hasDiscounts: false, avgDiscountPct: null, discountFrequency: 0 };
    }

    const discountedItems = distribution.filter((d) => d.price < modePrice.price);
    const discountQty = discountedItems.reduce((sum, d) => sum + d.totalQuantity, 0);

    const hasDiscounts = discountedItems.length > 0;
    const discountFrequency = discountQty / totalQty;

    let avgDiscountPct: number | null = null;
    if (hasDiscounts && modePrice.price > 0) {
      const totalDiscount = discountedItems.reduce(
        (sum, d) => sum + (modePrice.price - d.price) * d.totalQuantity,
        0
      );
      const baseRevenue = modePrice.price * discountQty;
      avgDiscountPct = baseRevenue > 0 ? (totalDiscount / baseRevenue) * 100 : 0;
    }

    return { hasDiscounts, avgDiscountPct, discountFrequency };
  }

  /**
   * Calculate Herfindahl-Hirschman Index (market concentration)
   * 0 = fragmented, 1 = monopolized
   */
  calculateHerfindahlIndex(shares: number[]): number {
    if (shares.length === 0) return 0;
    const decimalShares = shares.map(s => s / 100);
    return decimalShares.reduce((sum, s) => sum + s * s, 0);
  }

  /**
   * Calculate top N share percentage
   */
  calculateTopShare(shares: number[], topN: number): number {
    const sorted = [...shares].sort((a, b) => b - a);
    const top = sorted.slice(0, Math.min(topN, sorted.length));
    return top.reduce((sum, s) => sum + s, 0);
  }

  /**
   * Simple moving average forecast
   */
  forecastMovingAverage(history: number[], periods: number): number[] {
    const avg = this.calculateMean(history);
    return Array(periods).fill(avg);
  }

  /**
   * Apply trend adjustment to forecast
   */
  applyTrendAdjustment(forecast: number[], growthRate: number): number[] {
    return forecast.map((value, i) => value * (1 + growthRate * (i + 1)));
  }

  /**
   * Determine confidence level based on volatility and data points
   */
  determineConfidence(volatility: number, dataPoints: number): 'high' | 'medium' | 'low' {
    if (volatility < 0.1 && dataPoints >= 6) return 'high';
    if (volatility <= 0.2 && dataPoints >= 3) return 'medium';
    return 'low';
  }

  /**
   * Calculate days between two dates
   */
  private daysBetween(date1: string, date2: string): number {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return Math.abs(Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)));
  }

  /**
   * Calculate days since a date
   */
  private daysSince(date: string): number {
    const d = new Date(date);
    const now = new Date();
    return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  }

  /**
   * Match Estimates to Invoices and calculate cycle time
   */
  calculateCycleTime(patterns: Array<{
    doc_id: string;
    issue_date: string;
    customer_id: string;
    context_id: number;
    doc_number: number;
  }>): {
    avg_estimate_to_invoice_days: number;
    median_days: number;
  } {
    const estimates = patterns.filter(p => p.context_id === 4);
    const invoices = patterns.filter(p => p.context_id === 5);

    if (estimates.length === 0 || invoices.length === 0) {
      return { avg_estimate_to_invoice_days: 0, median_days: 0 };
    }

    // Try doc_number matching first
    const matches = estimates.flatMap(est => {
      const matching = invoices.find(
        inv => inv.doc_number === est.doc_number && inv.customer_id === est.customer_id
      );
      return matching ? [this.daysBetween(est.issue_date, matching.issue_date)] : [];
    });

    if (matches.length === 0) {
      return { avg_estimate_to_invoice_days: 0, median_days: 0 };
    }

    return {
      avg_estimate_to_invoice_days: Math.round(this.calculateMean(matches) * 10) / 10,
      median_days: Math.round(this.calculateMedian(matches) * 10) / 10,
    };
  }

  /**
   * Calculate win/loss metrics
   */
  calculateWinRate(patterns: Array<{
    doc_id: string;
    issue_date: string;
    customer_id: string;
    context_id: number;
    doc_number: number;
  }>): {
    estimates_created: number;
    converted_to_invoice: number;
    still_open_estimate: number;
    lost_estimate: number;
    win_rate: number;
  } {
    const estimates = patterns.filter(p => p.context_id === 4);
    const invoices = patterns.filter(p => p.context_id === 5);

    if (estimates.length === 0) {
      return {
        estimates_created: 0,
        converted_to_invoice: 0,
        still_open_estimate: 0,
        lost_estimate: 0,
        win_rate: 0,
      };
    }

    // Match Estimates to Invoices
    const convertedIds = new Set<string>();

    for (const est of estimates) {
      const matching = invoices.find(
        inv => inv.doc_number === est.doc_number && inv.customer_id === est.customer_id
      );
      if (matching) {
        convertedIds.add(est.doc_id);
      }
    }

    const converted = convertedIds.size;
    const stillOpen = estimates.filter(e => {
      const age = this.daysSince(e.issue_date);
      return !convertedIds.has(e.doc_id) && age <= 30;
    }).length;

    const lost = estimates.filter(e => {
      const age = this.daysSince(e.issue_date);
      return !convertedIds.has(e.doc_id) && age > 30;
    }).length;

    const total = estimates.length;
    const winRate = total > 0 ? Math.round((converted / total) * 1000) / 1000 : 0;

    return {
      estimates_created: total,
      converted_to_invoice: converted,
      still_open_estimate: stillOpen,
      lost_estimate: lost,
      win_rate: winRate,
    };
  }
}
