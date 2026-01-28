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

```bash
# Get item sales analytics (syncs cache if stale)
node packages/cli/dist/cli.js analytics item-sales <item-id>

# Specify periods to analyze
node packages/cli/dist/cli.js analytics item-sales <item-id> --months 3,6,12

# Force cache refresh before query
node packages/cli/dist/cli.js analytics item-sales <item-id> --refresh

# Use cached data only (skip sync check)
node packages/cli/dist/cli.js analytics item-sales <item-id> --cached
```

**Output includes:**
- Current stock quantity (real-time from API)
- Latest Order Confirmation (Estimate) date
- Latest Purchase Order date
- Sold quantities and revenue for 3/6/12 month periods
- Cache freshness information

**Example output:**
```json
{
  "item_id": "abc123",
  "item_name": "Product Name",
  "current_stock": 150,
  "latest_oc_date": "2026-01-15",
  "latest_po_date": "2026-01-20",
  "sales_periods": {
    "3_months": { "sold": 45, "revenue": 1350.00 },
    "6_months": { "sold": 120, "revenue": 3600.00 },
    "12_months": { "sold": 280, "revenue": 8400.00 }
  },
  "cache_freshness": {
    "last_sync": "2026-01-28T20:00:00Z",
    "stale": false
  }
}
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
