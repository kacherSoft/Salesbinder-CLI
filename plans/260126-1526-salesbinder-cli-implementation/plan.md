# SalesBinder CLI Implementation Plan

**Status:** pending
**Created:** 2026-01-26
**Based on:** [brainstorm-260126-1505-salesbinder-cli.md](../reports/brainstorm-260126-1505-salesbinder-cli.md)

---

## Overview

Production-grade CLI tool for SalesBinder API integration with full CRUD operations. Team/Enterprise use with multi-account support, robust error handling, and delta sync capabilities.

### Key Decisions
- **Runtime:** Node.js 20+ with TypeScript
- **Architecture:** Monorepo with extracted SDK
- **Auth:** Config file (`~/.salesbinder/config.json`)
- **Output:** JSON-only
- **Testing:** Unit + Integration tests
- **CLI Framework:** Commander.js

---

## API Endpoints Reference

### Base URL Pattern
```
https://[subdomain].salesbinder.com/api/2.0/[method].[format]
```

### Rate Limits
| Type | Limit | Penalty |
|------|-------|---------|
| Sustained | 60 req/min | 1-min block |
| Burst | 18 req/10s | 1-min block |

---

### 1. Items (Inventory)

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| List | GET | `/items.json` | List/search items |
| View | GET | `/items/[id].json` | Get single item |
| Create | POST | `/items.json` | Add new item |
| Edit | PUT | `/items/[id].json` | Update item |
| Delete | DELETE | `/items/[id].json` | Delete item |

**List Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| page | numeric | Page number |
| pageLimit | numeric | 1-100 records per page |
| categoryId | string | Filter by category |
| s | string | Search term |
| modifiedSince | epoch | Delta sync timestamp |
| compact | boolean | Reduce nested depth |

**Create Payload Example:**
```json
{
  "item": {
    "name": "My First API Added Item",
    "description": "Hello world.",
    "serial_number": "123456",
    "sku": "ABC123",
    "multiple": "1",
    "quantity": "14.00",
    "threshold": "2",
    "cost": "1200.00",
    "price": "1500.00",
    "category_id": "54f53d13-aa14-48e2-974f-29436882ca98"
  }
}
```

**Response Example:**
```json
{
  "message": "Saved",
  "item": {
    "name": "My First API Added Item",
    "description": "Hello world.",
    "serial_number": "123456",
    "sku": "ABC123",
    "multiple": true,
    "quantity": 14,
    "threshold": 2,
    "cost": 1200,
    "price": 1500,
    "category_id": "54f53d13-aa14-48e2-974f-29436882ca98",
    "account_id": "4d76bc2e-b198-4bd6-95f5-7439b86a92d9",
    "item_number": 5285,
    "created": "2016-11-11T00:50:35+00:00",
    "modified": "2016-11-11T00:50:35+00:00",
    "id": "8eb67f97-8ec1-4ec5-ae49-87be9dec43b0"
  }
}
```

---

### 2. Customers (Accounts)

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| List | GET | `/customers.json` | List/search accounts |
| View | GET | `/customers/[id].json` | Get single account |
| Create | POST | `/customers.json` | Add new account |
| Edit | PUT | `/customers/[id].json` | Update account |
| Delete | DELETE | `/customers/[id].json` | Delete account |

**Context IDs (required):**
| Type | ID | Permission |
|------|----|----|
| Customers | 2 | View/Modify Customers |
| Prospects | 8 | View/Modify Prospects |
| Suppliers | 10 | View/Modify Suppliers |

**List Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| page | numeric | Page number |
| pageLimit | numeric | 1-200 records |
| contextId | numeric | 2, 8, or 10 (required) |
| s | string | Search term |
| modifiedSince | epoch | Delta sync timestamp |

**Create Payload Example:**
```json
{
  "customer": {
    "context_id": "2",
    "name": "API Created Customer",
    "office_email": "sales@acme-company.com",
    "office_phone": "(604) 555-5555",
    "office_fax": "",
    "url": "acme-company.com",
    "billing_address_1": "Suite 100 - 1234 West 4th Avenue",
    "billing_city": "Vancouver",
    "billing_region": "BC",
    "billing_country": "Canada",
    "billing_postal_code": "V6P 6W5",
    "shipping_address_1": "Suite 100 - 1234 West 4th Avenue",
    "shipping_city": "Vancouver",
    "shipping_region": "BC",
    "shipping_country": "Canada",
    "shipping_postal_code": "V6P 6W5"
  }
}
```

---

### 3. Documents (Invoices/Estimates/POs)

| Operation | Method | Endpoint | Description |
|-----------|--------|----------|-------------|
| List | GET | `/documents.json` | List/search docs |
| View | GET | `/documents/[id].json` | Get single doc |
| Create | POST | `/documents.json` | Add new doc |
| Edit | PUT | `/documents/[id].json` | Update doc |
| Delete | DELETE | `/documents/[id].json` | Delete doc |

**Context IDs (required):**
| Type | ID | Permission |
|------|----|----|
| Estimates | 4 | View/Modify Estimates |
| Invoices | 5 | View/Modify Invoices |
| Purchase Orders | 11 | View/Modify POs |

**List Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| page | numeric | Page number |
| pageLimit | numeric | 1-200 records |
| contextId | numeric | 4, 5, or 11 (required) |
| customerId | string | Filter by customer |
| accountNumber | numeric | Filter by account # |
| documentNumber | numeric | Filter by doc # |
| modifiedSince | epoch | Delta sync timestamp |
| s | string | Search term |
| field | string | Specific field search |
| exact | boolean | Exact match only |
| compact | boolean | Reduce nested depth |

**Create Payload Example:**
```json
{
  "document": {
    "context_id": 5,
    "customer_id": "549490bc-d15c-433c-8e48-03d8a2d10228",
    "issue_date": "2017-02-08",
    "document_items": [
      {
        "quantity": 2,
        "tax": 8,
        "price": 134,
        "weight": 1,
        "item_id": "58014db1-8dd8-4133-87ca-337f6882ca98"
      }
    ]
  }
}
```

---

## Project Structure

```
salesbinder-cli/
├── packages/
│   ├── sdk/                      # Shared API client
│   │   ├── src/
│   │   │   ├── auth/
│   │   │   │   ├── api-key.service.ts
│   │   │   │   └── basic-auth.interceptor.ts
│   │   │   ├── client/
│   │   │   │   ├── axios.factory.ts
│   │   │   │   └── retry.handler.ts
│   │   │   ├── config/
│   │   │   │   ├── config.schema.ts
│   │   │   │   └── config.loader.ts
│   │   │   ├── resources/
│   │   │   │   ├── items.resource.ts
│   │   │   │   ├── customers.resource.ts
│   │   │   │   ├── documents.resource.ts
│   │   │   │   └── index.ts
│   │   │   ├── types/
│   │   │   │   ├── items.types.ts
│   │   │   │   ├── customers.types.ts
│   │   │   │   ├── documents.types.ts
│   │   │   │   └── common.types.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cli/                      # CLI interface
│       ├── src/
│       │   ├── commands/
│       │   │   ├── items/
│       │   │   │   ├── items.list.command.ts
│       │   │   │   ├── items.get.command.ts
│       │   │   │   ├── items.create.command.ts
│       │   │   │   ├── items.update.command.ts
│       │   │   │   └── items.delete.command.ts
│       │   │   ├── customers/
│       │   │   │   ├── customers.list.command.ts
│       │   │   │   ├── customers.get.command.ts
│       │   │   │   ├── customers.create.command.ts
│       │   │   │   ├── customers.update.command.ts
│       │   │   │   └── customers.delete.command.ts
│       │   │   ├── documents/
│       │   │   │   ├── documents.list.command.ts
│       │   │   │   ├── documents.get.command.ts
│       │   │   │   ├── documents.create.command.ts
│       │   │   │   ├── documents.update.command.ts
│       │   │   │   └── documents.delete.command.ts
│       │   │   ├── config/
│       │   │   │   ├── config.init.command.ts
│       │   │   │   └── config.list.command.ts
│       │   │   └── sync/
│       │   │       └── sync.command.ts
│       │   ├── output/
│       │   │   └── json.formatter.ts
│       │   ├── utils/
│       │   │   ├── request-id.generator.ts
│       │   │   └── logger.ts
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── package.json                   # Root with pnpm workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

---

## Implementation Phases

### Phase 1: Project Setup & Foundation
**Status:** completed
**Priority:** Critical

**Tasks:**
1. Initialize monorepo with pnpm workspaces
2. Setup TypeScript configuration
3. Configure ESLint, Prettier
4. Create package.json structure
5. Setup Jest for testing

**Commands:**
```bash
pnpm init
pnpm add -D typescript @types/node ts-node
pnpm add -D eslint prettier @typescript-eslint/parser
pnpm add -D jest @types/jest ts-jest
```

**Files to Create:**
- `package.json` (root)
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `packages/sdk/package.json`
- `packages/cli/package.json`
- `.eslintrc.js`
- `.prettierrc`
- `jest.config.js`

---

### Phase 2: SDK - Auth & Config
**Status:** pending
**Priority:** Critical

**Tasks:**
1. Implement config file schema
2. Create config loader with permissions check
3. Implement Basic Auth interceptor
4. Create axios factory with retry handler
5. Add request ID generator

**Config Schema:**
```typescript
interface SalesBinderConfig {
  defaultAccount: string;
  accounts: Record<string, AccountConfig>;
  preferences?: {
    defaultLimit?: number;
    timeout?: number;
  };
}

interface AccountConfig {
  subdomain: string;
  apiKey: string;
  apiVersion: string;
}
```

**Files to Create:**
- `packages/sdk/src/config/config.schema.ts`
- `packages/sdk/src/config/config.loader.ts`
- `packages/sdk/src/auth/basic-auth.interceptor.ts`
- `packages/sdk/src/client/axios.factory.ts`
- `packages/sdk/src/client/retry.handler.ts`

---

### Phase 3: SDK - Items Resource
**Status:** pending
**Priority:** High

**Tasks:**
1. Define Item TypeScript types
2. Implement items list with pagination
3. Implement items get
4. Implement items create
5. Implement items update
6. Implement items delete

**Files to Create:**
- `packages/sdk/src/types/items.types.ts`
- `packages/sdk/src/resources/items.resource.ts`

**Public API:**
```typescript
class ItemsResource {
  list(params?: ItemListParams): Promise<ItemListResponse>;
  get(id: string): Promise<Item>;
  create(data: CreateItemDto): Promise<Item>;
  update(id: string, data: UpdateItemDto): Promise<Item>;
  delete(id: string): Promise<void>;
}
```

---

### Phase 4: SDK - Customers Resource
**Status:** pending
**Priority:** High

**Tasks:**
1. Define Customer TypeScript types
2. Implement customers list with contextId
3. Implement customers get
4. Implement customers create with context
5. Implement customers update
6. Implement customers delete

**Files to Create:**
- `packages/sdk/src/types/customers.types.ts`
- `packages/sdk/src/resources/customers.resource.ts`

---

### Phase 5: SDK - Documents Resource
**Status:** pending
**Priority:** High

**Tasks:**
1. Define Document TypeScript types
2. Implement documents list with contextId
3. Implement documents get
4. Implement documents create with items
5. Implement documents update
6. Implement documents delete

**Files to Create:**
- `packages/sdk/src/types/documents.types.ts`
- `packages/sdk/src/resources/documents.resource.ts`

---

### Phase 6: CLI - Framework & Config Commands
**Status:** pending
**Priority:** High

**Tasks:**
1. Setup Commander.js
2. Implement global options (--account, --json)
3. Create config init command
4. Create config list command
5. Add JSON output formatter

**Files to Create:**
- `packages/cli/src/index.ts`
- `packages/cli/src/commands/config/config.init.command.ts`
- `packages/cli/src/commands/config/config.list.command.ts`
- `packages/cli/src/output/json.formatter.ts`

---

### Phase 7: CLI - Items Commands
**Status:** pending
**Priority:** High

**Tasks:**
1. items list command
2. items get command
3. items create command (stdin/file input)
4. items update command (stdin/file input)
5. items delete command

**Files to Create:**
- `packages/cli/src/commands/items/items.list.command.ts`
- `packages/cli/src/commands/items/items.get.command.ts`
- `packages/cli/src/commands/items/items.create.command.ts`
- `packages/cli/src/commands/items/items.update.command.ts`
- `packages/cli/src/commands/items/items.delete.command.ts`

---

### Phase 8: CLI - Customers Commands
**Status:** pending
**Priority:** High

**Tasks:**
1. customers list command (--context flag)
2. customers get command
3. customers create command
4. customers update command
5. customers delete command

**Files to Create:**
- `packages/cli/src/commands/customers/*.command.ts`

---

### Phase 9: CLI - Documents Commands
**Status:** pending
**Priority:** High

**Tasks:**
1. documents list command (--context flag)
2. documents get command
3. documents create command (stdin/file with items)
4. documents update command
5. documents delete command

**Files to Create:**
- `packages/cli/src/commands/documents/*.command.ts`

---

### Phase 10: CLI - Sync Command
**Status:** pending
**Priority:** Medium

**Tasks:**
1. Implement state file management
2. Create sync command for items
3. Create sync command for customers
4. Create sync command for documents
5. Handle timestamps correctly

**Files to Create:**
- `packages/cli/src/commands/sync/sync.command.ts`
- State file: `~/.salesbinder/state.json`

---

### Phase 11: Testing
**Status:** pending
**Priority:** High

**Tasks:**
1. Unit tests for auth client
2. Unit tests for retry handler
3. Unit tests for each resource
4. Unit tests for CLI commands
5. Integration tests against real API
6. Test rate limit handling

**Files to Create:**
- `packages/sdk/**/*.test.ts`
- `packages/cli/**/*.test.ts`
- `packages/sdk/__integration__/**/*.test.ts`

---

### Phase 12: Enterprise Hardening
**Status:** pending
**Priority:** Medium

**Tasks:**
1. Structured logging with request IDs
2. Config file permission validation
3. Error message formatting
4. Security audit (API key handling)
5. Documentation

---

## CLI Usage Examples

```bash
# Initialize config
salesbinder config init

# List items
salesbinder items list --page 1 --limit 50

# Get single item
salesbinder items get 8eb67f97-8ec1-4ec5-ae49-87be9dec43b0

# Create item from file
salesbinder items create ./item.json

# Create item from stdin
echo '{"item":{"name":"Test"}}' | salesbinder items create

# List customers by context
salesbinder customers list --context 2

# List invoices
salesbinder documents list --context 5

# Create document
salesbinder documents create ./invoice.json

# Sync modified items
salesbinder sync items
```

---

## Success Criteria

- [ ] All CRUD operations work for Items, Customers, Documents
- [ ] Delta sync respects `modifiedSince` parameter
- [ ] Rate limit retry logic prevents lockouts
- [ ] Config file supports multiple accounts
- [ ] Output is valid JSON
- [ ] Integration tests pass
- [ ] Unit tests cover critical paths
- [ ] Request IDs logged
- [ ] Config file permissions validated

---

## Open Questions

1. **Bulk operations:** Does API support bulk create/update? Not mentioned in docs.
2. **Webhook registration:** Should CLI include webhook management for future use?

---

## Sources

- [API Documentation](https://www.salesbinder.com/api/)
- [List & Search Inventory Items](https://www.salesbinder.com/api/inventory/list/)
- [Add Inventory Item](https://www.salesbinder.com/api/inventory/add/)
- [Add Account](https://www.salesbinder.com/api/accounts/add/)
- [List & Search Documents](https://www.salesbinder.com/api/documents/list/)
- [Add Document](https://www.salesbinder.com/api/documents/add/)
