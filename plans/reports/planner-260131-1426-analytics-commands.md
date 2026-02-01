# Analytics Commands Implementation Plan

**Date:** 2026-01-31
**Project:** SalesBinder CLI
**Status:** Ready for Implementation

---

## Executive Summary

Plan to add 6 modular analytics sub-commands for single-item deep-dive analysis. Commands follow YAGNI/KISS/DRY principles, output JSON only, and leverage existing SQLite cache.

**Total Effort:** 12 hours across 4 phases

---

## Command Overview

| Command | Purpose | Output |
|---------|---------|--------|
| `analytics trends <item-id>` | Sales trend analysis | Direction, growth rate, momentum, volatility |
| `analytics inventory <item-id>` | Stock health & reorder | Days of stock, reorder recommendation, overstock |
| `analytics pricing <item-id>` | Price distribution | Stats, variance, discount analysis |
| `analytics customers <item-id>` | Customer breakdown | Top customers, concentration, segmentation |
| `analytics forecast <item-id>` | Sales prediction | 3-month forecast with confidence |
| `analytics patterns <item-id>` | Order patterns | Order frequency, cycle time, win rate |

---

## Implementation Phases

### Phase 1: MVP (4h) - trends, inventory, pricing
**Priority:** High

**Deliverables:**
- `CacheAnalyticsService` - Statistical calculations
- Cache query extensions
- 3 command files
- Type definitions

**Commands:**
1. `analytics trends` - 4-period rolling window analysis
2. `analytics inventory` - Stock health with reorder logic
3. `analytics pricing` - Price distribution with discount detection

### Phase 2: Advanced (4h) - customers, forecast
**Priority:** Medium
**Depends:** Phase 1

**Deliverables:**
- Customer aggregation queries
- Concentration metrics (Herfindahl index)
- Moving average forecast with trend adjustment

**Commands:**
1. `analytics customers` - Customer breakdown, top N, concentration
2. `analytics forecast` - 3-month prediction with confidence

### Phase 3: Patterns (2h) - patterns
**Priority:** Low
**Depends:** Phase 1, 2

**Deliverables:**
- Order pattern queries
- Cycle time matching (Estimate to Invoice)
- Win rate calculation

**Commands:**
1. `analytics patterns` - Order frequency, size distribution, cycle time, win rate

### Phase 4: Testing (2h) - comprehensive tests
**Priority:** High
**Depends:** Phase 1, 2, 3

**Deliverables:**
- Unit tests for CacheAnalyticsService
- Integration tests for cache queries
- Command invocation tests
- Performance validation (<2s)
- README documentation

---

## File Structure

```
packages/
├── sdk/src/cache/
│   ├── sqlite-cache.service.ts      # ADD: 4 new query methods
│   ├── cache-analytics.service.ts   # NEW: 150 lines
│   ├── types.ts                     # ADD: result types
│   └── index.ts                     # UPDATE: export
└── cli/src/commands/analytics/
    ├── index.ts                     # UPDATE: export 6 commands
    ├── item-sales.command.ts        # Existing
    ├── trends.command.ts            # NEW: 130 lines
    ├── inventory.command.ts         # NEW: 140 lines
    ├── pricing.command.ts           # NEW: 130 lines
    ├── customers.command.ts         # NEW: 120 lines
    ├── forecast.command.ts          # NEW: 130 lines
    └── patterns.command.ts          # NEW: 180 lines
```

**Total new code:** ~1,000 lines

---

## Cache Service Additions

### New Query Methods

```typescript
// Rolling window sales by period
getItemSalesByPeriod(itemId, startDate, endDate, contextId)

// Customer aggregation
getItemSalesByCustomer(itemId, startDate, endDate, contextId)

// Price distribution (group by price)
getItemPriceDistribution(itemId, startDate, endDate, contextId)

// Order patterns (Estimates + Invoices)
getItemOrderPatterns(itemId, startDate, endDate)
```

### Analytics Calculations (NEW SERVICE)

`CacheAnalyticsService`:

- **Statistics:** mean, median, std dev, variance, growth rate
- **Trends:** detect direction, momentum, volatility
- **Concentration:** Herfindahl index, top N share
- **Forecasting:** moving average, trend adjustment, confidence

---

## Unresolved Questions

| Question | Impact | Decision Point |
|----------|--------|----------------|
| Customer name resolution | UX vs performance | Decide before Phase 2 (customer_ids only initially) |
| Unit cost for carrying cost | Inventory completeness | Decide in Phase 1 (skip if unavailable) |
| Estimate/Invoice doc_number matching | Cycle time accuracy | Test in Phase 3 |
| Forecast method sophistication | Accuracy vs complexity | Moving average + trend (YAGNI) |

---

## Success Criteria

- [ ] All 6 commands registered and callable
- [ ] JSON output matches specified schemas
- [ ] `--refresh` and `--cached` flags work
- [ ] Queries return in <2 seconds
- [ ] Unit test coverage >80%
- [ ] README documentation complete
- [ ] Edge cases handled (no data, sparse data)

---

## Dependencies

### Required (Existing)
- `better-sqlite3` - Cache queries
- `commander` - CLI framework
- Existing cache schema with `documents` and `item_documents`

### No New Dependencies Required

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Sparse historical data | High | Medium | Add confidence levels, min data checks |
| Cache query performance | Low | Medium | Ensure indexes, use prepared statements |
| Cycle time matching fails | Medium | Low | Graceful degradation, nulls in output |
| Forecast accuracy | Medium | Low | Confidence based on volatility |

---

## Related Files

**Plan Directory:** `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/plans/260131-1426-analytics-commands/`
- `plan.md` - Overview
- `phase-01-trends-inventory-pricing.md` - MVP implementation
- `phase-02-customers-forecast.md` - Advanced analytics
- `phase-03-patterns.md` - Order patterns
- `phase-04-testing.md` - Tests & documentation

**Brainstorm Report:** `/Volumes/OCW-2TB/LocalProjects/Salesbinder CLI/plans/reports/brainstorm-260131-analytics-functions.md`

**Existing Code:**
- `packages/cli/src/commands/analytics/item-sales.command.ts` - Reference pattern
- `packages/sdk/src/cache/sqlite-cache.service.ts` - Extend with queries
- `packages/sdk/src/cache/types.ts` - Add result types

---

## Next Steps

1. Review plan and approve approach
2. Resolve outstanding questions before Phase 2
3. Begin Phase 1 implementation
4. Run `code-simplifier` after each phase
5. Run `tester` in Phase 4
6. Update README.md with final documentation
