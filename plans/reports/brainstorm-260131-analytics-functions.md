# Analytics Functions Brainstorm Report

**Date:** 2026-01-31
**Project:** SalesBinder CLI
**Focus:** Single-item deep-dive analytics with JSON output

---

## Problem Statement

User wants to expand analytics capabilities beyond existing `analytics item-sales` command to provide deeper insights for:
- **Sales Performance:** Trend analysis, customer breakdown, forecasting
- **Inventory Optimization:** Stock-out risk, stock/sales ratio, reorder points, overstock detection
- **Operational Insights:** Cycle time, price analysis, order patterns

---

## Existing Capabilities

### Current Command: `analytics item-sales <item-id>`

**Outputs:**
- Current stock (real-time API)
- Latest OC date (Estimate context 4)
- Latest PO date (Purchase Order context 11)
- Sold quantities & revenue for 3/6/12 month periods
- Cache freshness info

**Data Available in Cache:**
| Table | Columns |
|-------|---------|
| `documents` | doc_id, context_id, doc_number, issue_date, customer_id, modified |
| `item_documents` | id, item_id, doc_id, quantity, price |

**Document Context IDs:**
- 4 = Estimate (Order Confirmation)
- 5 = Invoice (Actual sales)
- 11 = Purchase Order (Restocking)

---

## Evaluated Approaches

### Option A: Single Monolithic Command
**Structure:** `analytics item-sales <item-id> --full`

**Pros:**
- Simple CLI interface
- Single API call pattern
- Consistent with existing design

**Cons:**
- Large JSON output may be unwieldy
- Hard to extend without breaking changes
- All-or-nothing data fetching

### Option B: Modular Sub-Commands (RECOMMENDED)
**Structure:**
```
analytics item-sales <item-id>          # Existing basic
analytics trends <item-id>              # New: Trend analysis
analytics customers <item-id>           # New: Customer breakdown
analytics forecast <item-id>            # New: Sales forecasting
analytics inventory <item-id>           # New: Stock health & reorder
analytics pricing <item-id>             # New: Price analysis
analytics patterns <item-id>            # New: Order patterns
```

**Pros:**
- Focused, composable commands
- Easy to extend without breaking existing
- Can pipe/compose outputs in shell
- Each command optimized for its query
- Follows UNIX philosophy

**Cons:**
- More files to maintain
- Slightly more complex CLI surface

### Option C: Flag-Based Modifiers
**Structure:** `analytics item-sales <item-id> --trends --customers --forecast`

**Pros:**
- Single entry point
- Can combine multiple insights

**Cons:**
- Flag soup quickly becomes unmanageable
- Hard to document all combinations
- Output structure varies wildly based on flags

---

## Final Recommendation: Option B (Modular Sub-Commands)

**Rationale:**
- Follows YAGNI: User pays computation cost only for what they need
- Follows KISS: Each command does one thing well
- Follows UNIX philosophy: Composable tools that work together
- Extensible: Add new analytics without touching existing ones
- Testable: Each command has clear inputs/outputs

---

## Proposed Commands

### 1. `analytics trends <item-id>` - Sales Trend Analysis

**Purpose:** Identify if an item is accelerating, decelerating, or stable

**Output Schema:**
```json
{
  "item_id": "string",
  "item_name": "string",
  "analysis_period": "12 months",
  "periods": [
    {
      "period": "months_1_3",
      "quantity_sold": 150,
      "revenue": 4500.00,
      "avg_monthly": 50
    },
    {
      "period": "months_4_6",
      "quantity_sold": 120,
      "revenue": 3600.00,
      "avg_monthly": 40
    },
    {
      "period": "months_7_9",
      "quantity_sold": 180,
      "revenue": 5400.00,
      "avg_monthly": 60
    },
    {
      "period": "months_10_12",
      "quantity_sold": 210,
      "revenue": 6300.00,
      "avg_monthly": 70
    }
  ],
  "trend": {
    "direction": "upward", // "upward" | "downward" | "stable" | "volatile"
    "growth_rate": 0.40, // Percentage change earliest vs latest
    "momentum": "accelerating", // Comparing consecutive periods
    "volatility_score": 0.15 // Standard deviation / mean
  }
}
```

**Implementation Notes:**
- Compare 3-month rolling windows over 12 months
- Calculate growth rate: (latest - earliest) / earliest
- Detect acceleration: are period-over-period changes increasing?
- Volatility: coefficient of variation across periods

---

### 2. `analytics customers <item-id>` - Customer Breakdown

**Purpose:** Understand customer concentration and identify top buyers

**Output Schema:**
```json
{
  "item_id": "string",
  "item_name": "string",
  "period": "12 months",
  "total_customers": 15,
  "total_quantity": 660,
  "total_revenue": 19800.00,
  "top_customers": [
    {
      "customer_id": "string",
      "quantity": 200,
      "revenue": 6000.00,
      "share_pct": 30.3,
      "order_count": 8,
      "avg_order_size": 25
    }
  ],
  "concentration": {
    "top_3_share_pct": 68.2,
    "top_5_share_pct": 85.5,
    "herfindahl_index": 0.18 // 0=fragmented, 1=monopolized
  },
  "customer_segments": {
    "large": 3,  // >10% share
    "medium": 5, // 3-10% share
    "small": 7   // <3% share
  }
}
```

**Implementation Notes:**
- Query Invoices by customer_id for the item
- Calculate market concentration metrics
- Herfindahl-Hirschman Index: sum(squared market shares)

**Data Gap:** Customer names not in cache (only customer_id)
- **Mitigation:** Add optional `--resolve-names` flag to fetch from API
- **Or:** Output customer_ids only, let user resolve separately

---

### 3. `analytics forecast <item-id>` - Sales Forecasting

**Purpose:** Predict future demand based on historical patterns

**Output Schema:**
```json
{
  "item_id": "string",
  "item_name": "string",
  "method": "moving_average",
  "historical_period": "6 months",
  "forecast": [
    {
      "month": "2026-02",
      "predicted_quantity": 75,
      "predicted_revenue": 2250.00,
      "confidence": "medium" // "high" | "medium" | "low"
    },
    {
      "month": "2026-03",
      "predicted_quantity": 78,
      "predicted_revenue": 2340.00,
      "confidence": "medium"
    }
  ],
  "summary": {
    "avg_monthly_sales": 70,
    "trend_adjustment": 1.08, // Multiplier based on trend
    "seasonality_factor": 1.0, // Placeholder for seasonal adj
    "volatility": 0.12
  }
}
```

**Implementation Notes:**
- Start simple: Moving average with trend adjustment
- Forecast 3 months ahead
- Confidence based on historical volatility
- **Later enhancement:** Add seasonality if sufficient historical data (18+ months)

---

### 4. `analytics inventory <item-id>` - Stock Health & Reorder

**Purpose:** Assess stock levels and recommend reorder actions

**Output Schema:**
```json
{
  "item_id": "string",
  "item_name": "string",
  "current_stock": 45,
  "stock_health": {
    "status": "adequate", // "critical" | "low" | "adequate" | "overstock"
    "days_of_stock": 67,
    "stock_to_sales_ratio": 1.5,
    "risk_level": "low" // "high" | "medium" | "low"
  },
  "consumption": {
    "avg_daily_sales": 0.67, // Based on last 90 days
    "max_daily_sales": 2.0,
    "recent_trend": "stable"
  },
  "reorder_recommendation": {
    "should_reorder": false,
    "suggested_qty": null,
    "urgency": null, // "immediate" | "soon" | "monitor"
    "rationale": "Current stock covers 67 days at recent sales rate"
  },
  "overstock_assessment": {
    "is_overstocked": false,
    "excess_units": 0,
    "excess_value": 0.00,
    "carrying_cost_estimate": 0.00
  }
}
```

**Implementation Notes:**
- Days of stock = current_stock / avg_daily_sales
- Low stock threshold: <30 days
- Critical: <14 days
- Overstock: >90 days AND declining sales trend
- Carrying cost: excess_units * unit_cost * 0.25 (annual storage ~25%)

**Data Gap:** Unit cost not in cache
- **Mitigation:** Skip carrying cost or add `--include-cost` flag

---

### 5. `analytics pricing <item-id>` - Price Analysis

**Purpose:** Understand price distribution and variance

**Output Schema:**
```json
{
  "item_id": "string",
  "item_name": "string",
  "period": "12 months",
  "price_stats": {
    "min": 25.00,
    "max": 35.00,
    "avg": 30.50,
    "median": 30.00,
    "std_dev": 2.50,
    "variance_pct": 8.2 // Coefficient of variation
  },
  "price_distribution": [
    {
      "price": 30.00,
      "quantity": 350,
      "revenue": 10500.00,
      "frequency_pct": 53.0
    },
    {
      "price": 32.00,
      "quantity": 200,
      "revenue": 6400.00,
      "frequency_pct": 30.3
    }
  ],
  "discounts": {
    "has_discounts": true,
    "avg_discount_pct": 6.7,
    "discount_frequency": 0.25 // % of orders with discount
  }
}
```

**Implementation Notes:**
- Group by price values from item_documents
- Discount detection: compare to mode/most common price
- Variance % indicates pricing stability

---

### 6. `analytics patterns <item-id>` - Order Patterns & Cycle Time

**Purpose:** Understand order behavior and sales cycle metrics

**Output Schema:**
```json
{
  "item_id": "string",
  "item_name": "string",
  "period": "12 months",
  "order_patterns": {
    "total_orders": 28,
    "avg_quantity_per_order": 23.6,
    "median_quantity_per_order": 20,
    "min_order_size": 5,
    "max_order_size": 100,
    "order_frequency_days": 13 // Avg days between orders
  },
  "size_distribution": {
    "small": 8,   // < avg/2
    "medium": 15, // avg/2 to avg*2
    "large": 5    // > avg*2
  },
  "cycle_time": {
    "avg_estimate_to_invoice_days": 4.5,
    "median_days": 3,
    "conversion_rate": 0.85 // Invoices / (Invoices + Estimates)
  },
  "win_loss": {
    "estimates_created": 33,
    "converted_to_invoice": 28,
    "still_open_estimate": 3,
    "lost_estimate": 2, // Estimates without matching invoice after 30 days
    "win_rate": 0.85
  }
}
```

**Implementation Notes:**
- Order frequency: days between first and last order / order count
- Cycle time: Match Estimate doc_numbers to Invoice doc_numbers (if same numbering)
- **Fallback:** Use issue_date difference between Estimate and Invoice for same customer+item
- Win rate: Invoices / (Invoices + open Estimates >30 days old)

---

## Implementation Considerations

### Phase 1: Core Analytics (MVP)
1. `analytics trends` - Trend analysis
2. `analytics inventory` - Stock health
3. `analytics pricing` - Price stats

### Phase 2: Customer & Forecasting
4. `analytics customers` - Customer breakdown
5. `analytics forecast` - Sales prediction

### Phase 3: Advanced Patterns
6. `analytics patterns` - Order patterns & cycle time

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Sparse historical data | Low accuracy | Add confidence levels, require min 3 months data |
| Cache misses for new items | No analytics | Graceful degradation, clear error messages |
| Expensive queries for large inventories | Slow performance | Ensure indexes on (item_id, issue_date), use prepared statements |
| Customer name resolution adds latency | API rate limits | Make optional via `--resolve-names` flag |
| Seasonality detection needs 18+ months | Not useful initially | Start simple, add later when data available |

---

## Success Metrics

- **Completeness:** All 6 commands implemented with documented schemas
- **Performance:** Each command returns in <2 seconds for single item
- **Accuracy:** Forecast error <30% for stable items
- **Usability:** JSON output is parseable and predictable
- **Test Coverage:** >80% for new analytics functions

---

## Next Steps

1. Review and approve this brainstorm
2. Create detailed implementation plan with `/plan`
3. Implement Phase 1 commands (trends, inventory, pricing)
4. Add comprehensive tests
5. Document output schemas in README
6. Iterate based on real-world usage

---

## Unresolved Questions

1. **Customer names:** Should we add API-based name resolution (costly) or output customer_ids only?
2. **Unit cost:** Is carrying cost calculation needed? Requires cost data not in cache.
3. **Cycle time matching:** Are Estimate and Invoice doc_numbers guaranteed to match when converted?
4. **Forecast method preference:** Moving average sufficient, or need exponential smoothing?
5. **Output consolidation:** Should we add a `--summary` flag to all commands for brief output?
