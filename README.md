# SalesBinder CLI

Command-line interface for [SalesBinder API](https://www.salesbinder.com/api/) - Manage inventory, customers, documents, locations, and categories from your terminal.

## Features

- Full CRUD operations for Items, Customers, Documents, Locations, Categories
- **Sales Analytics** with local SQLite caching for fast queries
- **Cache Management** with incremental sync and auto-refresh
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
    "cacheStaleSeconds": 7200
  }
}
```

**Via environment variable** (overrides config):
```bash
export SALESBINDER_CACHE_STALE_SECONDS=7200  # 2 hours
```

**Priority**: Environment variable > Config file > Default (3600s)

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

Generate sales analytics for items using a local SQLite cache for fast queries.

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

# With customer names (slower, requires API calls)
node packages/cli/dist/cli.js analytics customers <item-id> --resolve-names

# Output includes:
# - Total customers and revenue
# - Top customers by revenue
# - Concentration metrics (top 3/5 share, Herfindahl index)
# - Customer segmentation (large/medium/small)
```

**Example output (with `--resolve-names`):**
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

**Note:** `--resolve-names` makes additional API calls for each customer, which is slower but provides more readable output. Use without the flag for fastest results (customer IDs only).

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

Manage the local SQLite cache for analytics data.

```bash
# Sync cache (incremental by default)
node packages/cli/dist/cli.js cache sync

# Force full resync (re-download all documents)
node packages/cli/dist/cli.js cache sync --full

# Check cache status
node packages/cli/dist/cli.js cache status

# Delete cache file
node packages/cli/dist/cli.js cache clear
```

**Performance:**
- First sync: 5-10 minutes (~33K documents)
- Delta sync: <1 minute (changes only)
- Cached queries: <100ms
- Cache location: `~/.salesbinder/cache/salesbinder-<account>.db`

## Recommended Workflow

For daily operations involving item sales analytics:

1. **Initial Setup** (one-time):
   ```bash
   # Full sync to build cache
   node packages/cli/dist/cli.js cache sync
   ```

2. **Daily Analytics** (fast, uses cached data):
   ```bash
   # Quick query from cache (auto-syncs if stale >1 hour)
   node packages/cli/dist/cli.js analytics item-sales <item-id>
   ```

3. **Weekly Maintenance**:
   ```bash
   # Check cache status
   node packages/cli/dist/cli.js cache status

   # Manual refresh if needed
   node packages/cli/dist/cli.js cache sync
   ```

4. **Adjust Stale Threshold** (optional):
   - Set to 7200 (2 hours) for less frequent syncs
   - Set to 1800 (30 minutes) for fresher data
   - Use `SALESBINDER_CACHE_STALE_SECONDS` environment variable for per-session override

**Why this workflow?**
- Cache sync is the bottleneck (~5-10 minutes for full sync)
- Cached queries are instant (<100ms)
- Auto-sync only triggers when cache is stale
- `--cached` flag skips sync check for fastest queries
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
| `salesbinder cache sync` | Sync document cache |
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
│   │   │   ├── cache/        # SQLite cache service and indexer
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

### Cache file location

Cache files are stored at `~/.salesbinder/cache/salesbinder-<account>.db`

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
