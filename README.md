# SalesBinder CLI

Command-line interface for [SalesBinder API](https://www.salesbinder.com/api/) - Manage inventory, customers, documents, locations, and categories from your terminal.

## Features

- Full CRUD operations for Items, Customers, Documents, Locations, Categories
- **Sales Analytics** with pluggable cache backend (SQLite local or PostgreSQL shared)
- **Cache Management** with incremental sync, explicit PostgreSQL writes, and optional SQLite mirror pulls
- **Resumable invoice payment backfill** with cache-level payment sync status tracking
- Secure credential storage (0600 permissions)
- Multiple account support
- Pagination and search filters
- Delta sync via `modifiedSince` timestamp
- JSON output for easy parsing
- Self-documenting help system

## Requirements

- Node.js >= 20.0.0
- pnpm >= 8.0.0

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd salesbinder-cli

# Install dependencies
pnpm install

# Build the project
pnpm build
```

## Quick Start

```bash
# 1. Configure with your SalesBinder credentials
node packages/cli/dist/cli.js config:init --subdomain <your-subdomain> --api-key <your-api-key>

# 2. List items
node packages/cli/dist/cli.js items list

# 3. Get help
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js items --help
```

### Adding to PATH (Optional)

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$PATH:/path/to/salesbinder-cli/packages/cli/dist"
```

Then use directly:
```bash
salesbinder items list
```

## Configuration

### Cache Stale Threshold

Configure when the cache is considered stale (default: 3600 seconds = 1 hour).

**Via config file** (`~/.salesbinder/config.json`):
```json
{
  "defaultAccount": "default",
  "accounts": {
    "default": {
      "subdomain": "acme",
      "apiKey": "your-key",
      "apiVersion": "2.0"
    }
  },
  "preferences": {
    "cacheStaleSeconds": 7200,
    "syncLookbackSeconds": 604800
  }
}
```

**Via environment variable** (overrides config):
```bash
export SALESBINDER_CACHE_STALE_SECONDS=7200  # 2 hours
```

**Priority**: Environment variable > Config file > Default (3600s)

### Sync Lookback

Delta sync uses a lookback window so late SalesBinder edits are not missed. Default is `604800` seconds, or 7 days.

Set `preferences.syncLookbackSeconds` in `~/.salesbinder/config.json` to tune this. The same lookback is applied to account, document, item, and deleted-log delta sync.

### Cache Backend

By default, the CLI uses a **local SQLite** database for reads and analytics. For shared/multi-machine setups, you can add a **shared PostgreSQL upstream** via `SALESBINDER_DB_URL`.

**Via environment variable:**
```bash
export SALESBINDER_DB_URL=postgres://user:pass@host:5432/salesbinder
```

**Important:** the current shared PostgreSQL database name is **`salesbinder`**.

When `SALESBINDER_DB_URL` is set, PostgreSQL is the shared source of truth.

- **Writer path:** `cache sync` writes SalesBinder API deltas to PostgreSQL only
- **Reader path:** set `SALESBINDER_READ_BACKEND=postgresql` so analytics read PostgreSQL directly
- **Optional local mirror:** `cache pull` copies PostgreSQL → SQLite when offline/local reads are needed
- **Optional sync-and-pull:** `cache sync --pull` writes PostgreSQL, then refreshes local SQLite
- **Sync status:** `cache_meta.sync_status` records `running`, `success`, or `failed` so readers can detect an active writer

PostgreSQL → SQLite mirror refresh is explicit only; normal reads and normal `cache sync` do not start a background pull.

The PostgreSQL schema is created automatically on first use.

Cache schema v4 stores lifecycle state on accounts, item masters, and documents. Accounts keep their existing active/archived boolean behavior. Items and documents use `0` for active, `1` for archived, and `NULL` when the source cannot report lifecycle state. A later row with unknown state does not erase a known value. PostgreSQL → SQLite pulls preserve the same values. Existing pre-v4 item/document rows remain `NULL` until `cache sync --full` or a CSV import supplies authoritative evidence; sources that do not expose the field cannot complete that backfill. The migration is additive, so rollback uses the previous code without dropping columns or decrementing the SQLite schema version.

| Feature | SQLite (local mirror) | PostgreSQL (shared upstream) |
|---------|------------------------|-------------------------------|
| Role | Local read cache for analytics | Shared source of truth |
| Setup | Zero config | Requires connection URL |
| Storage | `~/.salesbinder/cache/` | Remote database |
| Sharing | Single machine | Multi-machine / shared |
| Performance | Fast local reads | Shared state across machines |

For reader agents:

```bash
export SALESBINDER_READ_BACKEND=postgresql
node packages/cli/dist/cli.js --account phuthaitech analytics item-sales <item-id>
```

Reader agents may query while a writer sync is running. PostgreSQL keeps reads valid, but a report can include a small mix of old/new rows during a writer update. Check `cache status` and its `sync_status` field; if it is `running`, wait/retry for strict reporting.

### Getting Your API Key

1. Login to your SalesBinder account
2. Go to **Settings** > **API Access**
3. Generate or copy your API key

### Config File Location

`~/.salesbinder/config.json` (created with 0600 permissions)

### Multiple Accounts

```bash
# Add production account
node packages/cli/dist/cli.js config:init --subdomain prod --api-key <key> --account-name production

# Add staging account
node packages/cli/dist/cli.js config:init --subdomain staging --api-key <key> --account-name staging

# List configured accounts
node packages/cli/dist/cli.js config:list

# Use specific account
node packages/cli/dist/cli.js items list --account production
```

## Usage

### Items

```bash
# List items (paginated, 50 per page)
node packages/cli/dist/cli.js items list
node packages/cli/dist/cli.js items list --page 2 --limit 10

# Search items
node packages/cli/dist/cli.js items list --search "cutter"

# Filter by category
node packages/cli/dist/cli.js items list --category <category-id>

# Delta sync (items modified since timestamp)
node packages/cli/dist/cli.js items list --modified 1704067200

# Get single item
node packages/cli/dist/cli.js items get <item-id>

# Create item (from file or stdin)
echo '{"name":"New Product","price":29.99,"quantity":100}' | node packages/cli/dist/cli.js items create

# Update item
echo '{"price":39.99}' | node packages/cli/dist/cli.js items update <item-id>

# Delete item
node packages/cli/dist/cli.js items delete <item-id>
```

### Customers

Context IDs: `2=Customer`, `8=Prospect`, `10=Supplier`

```bash
# List customers
node packages/cli/dist/cli.js customers list
node packages/cli/dist/cli.js customers list --context 2
node packages/cli/dist/cli.js customers list --search "Acme"

# Get single customer
node packages/cli/dist/cli.js customers get <customer-id>

# Create customer
echo '{"name":"John Doe","context_id":2,"email":"john@example.com"}' | node packages/cli/dist/cli.js customers create

# Update customer
echo '{"email":"new@example.com"}' | node packages/cli/dist/cli.js customers update <customer-id>

# Delete customer
node packages/cli/dist/cli.js customers delete <customer-id>
```

### Documents

Context IDs: `4=Estimate`, `5=Invoice`, `11=Purchase Order`

```bash
# List documents
node packages/cli/dist/cli.js documents list
node packages/cli/dist/cli.js documents list --context 5
node packages/cli/dist/cli.js documents list --customer <customer-id>

# Get single document
node packages/cli/dist/cli.js documents get <document-id>

# Create invoice
echo '{"context_id":5,"customer_id":"<uuid>","issue_date":"2026-01-27","document_items":[]}' | node packages/cli/dist/cli.js documents create

# Update document
echo '{"notes":"Updated notes"}' | node packages/cli/dist/cli.js documents update <document-id>

# Delete document
node packages/cli/dist/cli.js documents delete <document-id>
```

### Locations

```bash
# List locations
node packages/cli/dist/cli.js locations list

# Get single location
node packages/cli/dist/cli.js locations get <location-id>
```

### Categories

```bash
# List categories
node packages/cli/dist/cli.js categories list

# Get single category
node packages/cli/dist/cli.js categories get <category-id>

# Create category
echo '{"name":"Tools"}' | node packages/cli/dist/cli.js categories create

# Update category
echo '{"name":"Hand Tools"}' | node packages/cli/dist/cli.js categories update <category-id>

# Delete category
node packages/cli/dist/cli.js categories delete <category-id>
```

### Analytics

Generate sales analytics for items using the configured cache backend. By default analytics read the local SQLite mirror. Set `SALESBINDER_READ_BACKEND=postgresql` with `SALESBINDER_DB_URL` when reader agents should query the shared PostgreSQL source of truth directly.

#### Basic Sales

```bash
# Get item sales analytics
node packages/cli/dist/cli.js analytics item-sales <item-id>
```

#### Trend Analysis

```bash
# Analyze sales trends (accelerating, decelerating, stable)
node packages/cli/dist/cli.js analytics trends <item-id>

# Output includes:
# - 4-period breakdown (3-month rolling windows)
# - Trend direction (upward/downward/stable/volatile)
# - Growth rate percentage
# - Momentum indicator
# - Volatility score
```

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "analysis_period": "12 months",
  "periods": [
    { "period": "months_1_3", "quantity_sold": 75, "revenue": 1875, "avg_monthly": 25 },
    { "period": "months_4_6", "quantity_sold": 60, "revenue": 1500, "avg_monthly": 20 },
    { "period": "months_7_9", "quantity_sold": 45, "revenue": 1125, "avg_monthly": 15 },
    { "period": "months_10_12", "quantity_sold": 30, "revenue": 750, "avg_monthly": 10 }
  ],
  "trend": {
    "direction": "downward",
    "growth_rate": -0.6,
    "momentum": "accelerating",
    "volatility_score": 0.15
  }
}
```

#### Inventory Health

```bash
# Check stock levels and reorder recommendations
node packages/cli/dist/cli.js analytics inventory <item-id>

# Output includes:
# - Current stock (real-time from API)
# - Days of stock remaining
# - Stock health status (critical/low/adequate/overstock)
# - Reorder recommendation with urgency
# - Overstock assessment
```

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "current_stock": 150,
  "stock_health": {
    "status": "adequate",
    "days_of_stock": 45,
    "stock_to_sales_ratio": 1.5,
    "risk_level": "low"
  },
  "consumption": {
    "avg_daily_sales": 3.33,
    "max_daily_sales": 10,
    "recent_trend": "stable"
  },
  "reorder_recommendation": {
    "should_reorder": false,
    "suggested_qty": null,
    "urgency": null,
    "rationale": "No reorder needed at this time"
  },
  "overstock_assessment": {
    "is_overstocked": false,
    "excess_units": 0,
    "excess_value": 0,
    "carrying_cost_estimate": null
  }
}
```

#### Price Analysis

```bash
# Analyze price distribution and discounts
node packages/cli/dist/cli.js analytics pricing <item-id>

# Output includes:
# - Price statistics (min/max/avg/median/stddev)
# - Price variance percentage
# - Price distribution by price point
# - Discount analysis
```

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "period": "12 months",
  "price_stats": {
    "min": 20.00,
    "max": 25.00,
    "avg": 23.33,
    "median": 22.50,
    "std_dev": 2.50,
    "variance_pct": 10.7
  },
  "price_distribution": [
    { "price": 20.00, "quantity": 10, "revenue": 200.00, "frequency_pct": 16.7 },
    { "price": 25.00, "quantity": 50, "revenue": 1250.00, "frequency_pct": 83.3 }
  ],
  "discounts": {
    "has_discounts": true,
    "avg_discount_pct": 13.3,
    "discount_frequency": 0.167
  }
}
```

#### Customer Breakdown

```bash
# Analyze customer concentration
node packages/cli/dist/cli.js analytics customers <item-id>

# Cached customer names are used automatically when present.
# This flag only fills old/null-name rows by API.
node packages/cli/dist/cli.js analytics customers <item-id> --resolve-names

# Output includes:
# - Total customers and revenue
# - Top customers by revenue
# - Concentration metrics (top 3/5 share, Herfindahl index)
# - Customer segmentation (large/medium/small)
```

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "period": "12 months",
  "total_customers": 2,
  "total_quantity": 70,
  "total_revenue": 1750.00,
  "top_customers": [
    {
      "customer_id": "cust-1",
      "customer_name": "Acme Corporation",
      "quantity": 30,
      "revenue": 750.00,
      "share_pct": 42.9,
      "order_count": 2,
      "avg_order_size": 15
    },
    {
      "customer_id": "cust-2",
      "customer_name": "Beta Industries",
      "quantity": 40,
      "revenue": 1000.00,
      "share_pct": 57.1,
      "order_count": 3,
      "avg_order_size": 13.33
    }
  ],
  "concentration": {
    "top_3_share_pct": 100.0,
    "top_5_share_pct": 100.0,
    "herfindahl_index": 0.51
  },
  "customer_segments": {
    "large": 0,
    "medium": 2,
    "small": 0
  }
}
```

#### Sales Forecast

```bash
# Forecast 3-month sales
node packages/cli/dist/cli.js analytics forecast <item-id>

# Output includes:
# - 3-month forecast (quantity and revenue)
# - Confidence level per month
# - Historical average
# - Trend adjustment factor
# - Volatility metric
```

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "method": "moving_average",
  "historical_period": "6 months",
  "forecast": [
    { "month": "2026-02", "predicted_quantity": 13, "predicted_revenue": 325, "confidence": "medium" },
    { "month": "2026-03", "predicted_quantity": 14, "predicted_revenue": 350, "confidence": "medium" },
    { "month": "2026-04", "predicted_quantity": 15, "predicted_revenue": 375, "confidence": "medium" }
  ],
  "summary": {
    "avg_monthly_sales": 12.33,
    "trend_adjustment": 0.5,
    "volatility": 0.15
  }
}
```

#### Order Patterns

```bash
# Analyze order patterns and cycle time
node packages/cli/dist/cli.js analytics patterns <item-id>

# Output includes:
# - Order statistics (total, avg size, frequency)
# - Order size distribution (small/medium/large)
# - Cycle time (Estimate to Invoice days)
# - Win/loss metrics (conversion rate)
```

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "period": "12 months",
  "order_patterns": {
    "total_orders": 2,
    "avg_quantity_per_order": 12.5,
    "median_quantity_per_order": 12.5,
    "min_order_size": 10,
    "max_order_size": 15,
    "order_frequency_days": 15
  },
  "size_distribution": {
    "small": 0,
    "medium": 2,
    "large": 0
  },
  "cycle_time": {
    "avg_estimate_to_invoice_days": 30,
    "median_days": 30,
    "conversion_rate": 1.0
  },
  "win_loss": {
    "estimates_created": 1,
    "converted_to_invoice": 1,
    "still_open_estimate": 0,
    "lost_estimate": 0,
    "win_rate": 1.0
  }
}
```

#### Common Options

All analytics commands support:

```bash
--refresh         # Force cache refresh before query
--cached          # Use cache without checking freshness
--resolve-names   # (customers only) Fetch customer names from API
```

**Note:** customer names are cached by CSV import and forward sync. `--resolve-names` is now a fallback for old rows where `customer_name` is still null.

#### Example Workflow

```bash
# 1. Initial cache sync (one-time)
node packages/cli/dist/cli.js cache sync

# 2. Quick trend check
node packages/cli/dist/cli.js analytics trends <item-id>

# 3. Check inventory health
node packages/cli/dist/cli.js analytics inventory <item-id>

# 4. See price history
node packages/cli/dist/cli.js analytics pricing <item-id>

# 5. Analyze customer concentration (with names)
node packages/cli/dist/cli.js analytics customers <item-id> --resolve-names

# 6. Get sales forecast
node packages/cli/dist/cli.js analytics forecast <item-id>

# 7. Understand order patterns
node packages/cli/dist/cli.js analytics patterns <item-id>
```

### Cache Management

Manage the cache backend (SQLite or PostgreSQL) for analytics data.

```bash
# Seed cache from local CSV exports without API calls
node packages/cli/dist/cli.js --account phuthaitech cache import-export data/ --dry-run
node packages/cli/dist/cli.js --account phuthaitech cache import-export data/

# Sync cache (incremental by default; no local mirror pull unless --pull is used)
node packages/cli/dist/cli.js cache sync

# Sync cache and also refresh local SQLite mirror
node packages/cli/dist/cli.js cache sync --pull

# Force full resync (re-download all documents)
node packages/cli/dist/cli.js cache sync --full

# Backfill invoice payment transactions (resumable)
node packages/cli/dist/cli.js cache sync-payments

# Check cache status (shows backend type, document counts, payment sync status, last sync)
node packages/cli/dist/cli.js cache status

# Clear cache data
node packages/cli/dist/cli.js cache clear
```

Use `cache sync-payments` once per account to populate `payment_transactions` and `cache_meta.payment_sync_status` for historical payment reporting. If the command stops partway through, rerun it; it resumes from the saved cursor. After the cache reaches `complete`, run `cache sync` once to catch invoices modified during the backfill; later normal syncs continue refreshing invoice payment rows.

The CSV import expects these local export files under the import directory: customers, suppliers, 2024/2025/2026 invoice line items, 2025-2026 PO line items, and inventory variations. The importer validates headers, reports counts/warnings only, and does not print customer, supplier, item, document, or price rows. `Archived` remains required for customer/supplier exports and is optional for inventory/document exports; when omitted, item/document lifecycle state stays unknown or preserves an already-known cache value. Conflicting explicit `Archived` values for repeated rows are rejected.

Expected PhuthaiTech seed counts:

| Dataset | Count |
|---|---:|
| Customers | 4,626 |
| Suppliers | 822 |
| Invoice documents | 28,925 |
| Invoice line rows | 68,618 |
| Purchase order documents | 5,535 |
| Purchase order line rows | 13,010 |
| Item master rows | 33,912 |
| Stock location rows | 218,613 |

Forward sync after the CSV seed caches modified customers/suppliers, invoices/POs/estimates, items, item stock locations from full item detail, and deleted-log removals by stable `record_id`.

Archive state is metadata, not a deletion signal: missing list results and 404 responses do not remove rows. Deleted-log records remain the hard-delete authority. The current official v3 documents contract is active-only and does not expose an `archived` field, so document archive coverage must not be treated as complete. Existing analytics continue to include cached historical records regardless of archive state.

**Performance:**
- CSV import: local only, no historical API fetch
- First API full sync: 5-10 minutes or more depending on account size
- Delta sync to PostgreSQL: <1 minute for small change sets
- PostgreSQL → SQLite full mirror pull: can take several minutes for large caches; run only when needed
- Cached queries: <100ms
- SQLite location: `~/.salesbinder/cache/salesbinder-<account>.db`
- PostgreSQL: set via `SALESBINDER_DB_URL` env var (see [Cache Backend](#cache-backend))

## Recommended Workflow

For daily operations involving item sales analytics with PostgreSQL as the source of truth:

1. **Initial Setup** (one-time):
   ```bash
   # Seed historical data from local exports
   node packages/cli/dist/cli.js --account phuthaitech cache import-export data/ --dry-run
   node packages/cli/dist/cli.js --account phuthaitech cache import-export data/

   # Then keep PostgreSQL fresh
   node packages/cli/dist/cli.js --account phuthaitech cache sync
   ```

2. **Writer Agent**:
   ```bash
   # Fast incremental write: SalesBinder API -> PostgreSQL
   node packages/cli/dist/cli.js --account phuthaitech cache sync
   ```

3. **Reader Agents**:
   ```bash
   # Read directly from PostgreSQL source of truth
   export SALESBINDER_READ_BACKEND=postgresql
   node packages/cli/dist/cli.js analytics item-sales <item-id>
   ```

4. **Optional Local Mirror**:
   ```bash
   # Refresh local SQLite only when offline/local reads are needed
   node packages/cli/dist/cli.js --account phuthaitech cache pull
   ```

5. **Status Check**:
   ```bash
   # Shows backend counts, freshness, and sync_status
   node packages/cli/dist/cli.js --account phuthaitech cache status
   ```

6. **Adjust Stale Threshold** (optional):
   - Set to 7200 (2 hours) for less frequent syncs
   - Set to 1800 (30 minutes) for fresher data
   - Use `SALESBINDER_CACHE_STALE_SECONDS` environment variable for per-session override

**Why this workflow?**
- CSV import avoids historical API fetches.
- Delta sync only requests recent modified accounts/documents/items and deleted-log entries.
- Cached queries are instant (<100ms).
- Writer sync is explicit, so reader agents do not unexpectedly wait for PostgreSQL → SQLite pulls.
- `cache status` shows `sync_status` when a strict report should wait for the writer to finish.
- `--cached` flag skips sync check for fastest queries.
- `--refresh` flag forces fresh data when needed

## Output Format

All commands return JSON:

```json
{
  "items": [
    {
      "id": "abc123",
      "name": "Product Name",
      "description": "Description",
      "quantity": 100,
      "price": 29.99
    }
  ],
  "pagination": {
    "page": 1,
    "pageLimit": 50,
    "totalPages": 10,
    "totalCount": 500
  }
}
```

Parse with `jq`:

```bash
node packages/cli/dist/cli.js items list | jq '.items[] | .name, .quantity'
```

## For AI Agents

When using this CLI via AI agents (Claude, ChatGPT, etc.), the CLI provides comprehensive help via `--help`:

### Key Commands for Agents

| Command | Purpose |
|---------|---------|
| `salesbinder config:init` | Setup credentials |
| `salesbinder items list` | Browse inventory |
| `salesbinder items get <id>` | Get item details |
| `salesbinder customers list` | Browse customers |
| `salesbinder documents list` | Browse invoices/estimates |
| `salesbinder analytics item-sales <id>` | Get item sales analytics |
| `salesbinder cache sync` | Sync SalesBinder API deltas to the configured cache backend |
| `salesbinder cache sync --pull` | Sync to PostgreSQL, then refresh local SQLite mirror |
| `salesbinder cache status` | Check cache status |
| `salesbinder --help` | Show all commands |
| `salesbinder <command> --help` | Command-specific help |

### Common Patterns

**Find item by name:**
```bash
# Search, then get full details
salesbinder items list --search "cutter" | jq -r '.items[0].id' | xargs salesbinder items get
```

**Check stock at location:**
```bash
# Item response includes quantities per location
salesbinder items get <id> | jq '.item_variations[].item_variations_locations'
```

**Find customer invoices:**
```bash
salesbinder documents list --context 5 --customer <customer-id>
```

**Get item sales analytics:**
```bash
# Quick analytics from cache
salesbinder analytics item-sales <item-id> --cached

# Force fresh data
salesbinder analytics item-sales <item-id> --refresh
```

### Context ID Reference

| Type | Context ID |
|------|------------|
| Customer | 2 |
| Prospect | 8 |
| Supplier | 10 |
| Estimate | 4 |
| Invoice | 5 |
| Purchase Order | 11 |

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Watch mode for development
pnpm dev

# Run tests
pnpm test

# Lint
pnpm lint
```

### Project Structure

```
salesbinder-cli/
├── packages/
│   ├── sdk/          # API client library
│   │   ├── src/
│   │   │   ├── cache/
│   │   │   │   ├── cache.interface.ts      # Unified CacheService interface
│   │   │   │   ├── cache.factory.ts        # Selects SQLite or PostgreSQL read backend
│   │   │   │   ├── sqlite-cache.service.ts # Local SQLite backend
│   │   │   │   ├── postgres-cache.service.ts # Shared PostgreSQL backend
│   │   │   │   ├── document-indexer.service.ts
│   │   │   │   └── cache-analytics.service.ts
│   │   │   ├── client/       # HTTP client, auth, retry
│   │   │   ├── config/       # Config loader
│   │   │   ├── resources/    # API resources (items, customers, etc.)
│   │   │   └── types/        # TypeScript types
│   │   └── dist/
│   └── cli/          # Command-line interface
│       ├── src/
│       │   ├── commands/     # Command implementations
│       │   │   ├── analytics/  # Sales analytics commands
│       │   │   ├── cache/      # Cache management commands
│       │   │   └── ...         # Other resource commands
│       │   ├── output/       # JSON formatters
│       │   └── utils/        # Input validation
│       └── dist/
└── package.json
```

## Troubleshooting

### "Configuration already exists"

Edit or remove `~/.salesbinder/config.json` manually:

```bash
rm ~/.salesbinder/config.json
```

### "No configuration found"

Run `config:init` first:

```bash
node packages/cli/dist/cli.js config:init --subdomain <name> --api-key <key>
```

### Permission denied on config

The CLI requires 0600 permissions for security. Fix manually:

```bash
chmod 0600 ~/.salesbinder/config.json
```

### Rate limit errors

The CLI handles rate limiting automatically with exponential backoff. Wait and retry.

### Cache sync issues

If cache sync fails or data seems stale:

```bash
# Check cache status
node packages/cli/dist/cli.js cache status

# Clear and rebuild cache
node packages/cli/dist/cli.js cache clear
node packages/cli/dist/cli.js cache sync --full
```

### Cache location

- **SQLite local mirror**: `~/.salesbinder/cache/salesbinder-<account>.db`
- **PostgreSQL shared upstream**: configured via `SALESBINDER_DB_URL`
- **Current PostgreSQL database name**: `salesbinder`

## API Reference

### Items API

- `GET /items` - List items (supports pagination, search, filters)
- `GET /items/:id` - Get single item
- `POST /items` - Create item
- `PUT /items/:id` - Update item
- `DELETE /items/:id` - Delete item

### Customers API

- `GET /customers` - List customers
- `GET /customers/:id` - Get single customer
- `POST /customers` - Create customer
- `PUT /customers/:id` - Update customer
- `DELETE /customers/:id` - Delete customer

### Documents API

- `GET /documents` - List documents
- `GET /documents/:id` - Get single document
- `POST /documents` - Create document
- `PUT /documents/:id` - Update document
- `DELETE /documents/:id` - Delete document

### Locations API

- `GET /locations` - List locations
- `GET /locations/:id` - Get single location

### Categories API

- `GET /categories` - List categories
- `GET /categories/:id` - Get single category
- `POST /categories` - Create category
- `PUT /categories/:id` - Update category
- `DELETE /categories/:id` - Delete category

## License

MIT
