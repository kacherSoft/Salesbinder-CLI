# Phase 01: Environment and Types Setup

**Priority:** P2
**Status:** pending
**Effort:** 1.5h
**Dependencies:** None

## Overview

Install dependencies, define TypeScript interfaces for cache system, establish type safety for SQLite operations.

## Context Links

- Parent plan: [plan.md](./plan.md)
- Schema definition in [plan.md](./plan.md#database-schema)

## Requirements

### Functional
- Install `better-sqlite3` and its TypeScript types
- Define comprehensive TypeScript interfaces for cache schema
- Create types for sync state and metadata
- Export types from SDK package

### Non-Functional
- Type-safe database operations
- Clear interface contracts
- Documentation for all types

## Architecture

```
packages/sdk/src/cache/
├── types.ts           # All cache-related interfaces
├── sqlite-cache.service.ts    # Phase 02
└── document-indexer.service.ts # Phase 03
```

## Related Code Files

### New Files
- `packages/sdk/src/cache/types.ts` - Cache type definitions
- `packages/sdk/src/cache/index.ts` - Cache module exports

### Modified Files
- `packages/sdk/src/index.ts` - Re-export cache types
- `packages/sdk/package.json` - Add better-sqlite3 dependency

## Implementation Steps

1. **Install dependencies**
   ```bash
   pnpm add --filter @salesbinder/sdk better-sqlite3
   pnpm add --filter @salesbinder/sdk -D @types/better-sqlite3
   ```

2. **Create cache types** (`packages/sdk/src/cache/types.ts`)
   - DocumentRow interface
   - ItemDocumentRow interface
   - CacheMetaRow interface
   - CacheState interface
   - SyncOptions interface
   - AnalyticsResult interface

3. **Create cache module exports** (`packages/sdk/src/cache/index.ts`)
   - Export all types
   - Prepare for service exports

4. **Update SDK main exports** (`packages/sdk/src/index.ts`)
   - Add cache module export

## Implementation Details

### Type Definitions

```typescript
// packages/sdk/src/cache/types.ts

/** Database schema row for documents table */
export interface DocumentRow {
  doc_id: string;
  context_id: number; // 4=Estimate, 5=Invoice, 11=PO
  doc_number: number;
  issue_date: string; // YYYY-MM-DD
  customer_id: string;
  modified: number; // Unix timestamp
}

/** Database schema row for item_documents table */
export interface ItemDocumentRow {
  id: number;
  item_id: string;
  doc_id: string;
  quantity: number;
  price: number;
}

/** Database schema row for cache_meta table */
export interface CacheMetaRow {
  key: string;
  value: string;
}

/** Cache sync state metadata */
export interface CacheState {
  lastSync: number; // Unix timestamp
  lastFullSync: number; // Unix timestamp
  documentCount: number;
  itemDocumentCount: number;
  accountName: string;
  schemaVersion: number;
}

/** Options for cache sync operations */
export interface SyncOptions {
  full?: boolean; // Force full sync
  onProgress?: (current: number, total: number) => void; // Progress callback
}

/** Sales analytics result for a single item */
export interface ItemSalesAnalytics {
  item_id: string;
  item_name?: string;
  current_stock: number;
  latest_oc_date?: string; // YYYY-MM-DD
  latest_po_date?: string; // YYYY-MM-DD
  sales_periods: {
    [months: string]: {
      sold: number;
      revenue: number;
    };
  };
  cache_freshness: {
    last_sync: string; // ISO 8601
    stale: boolean;
  };
}

/** Context ID enum for documents */
export enum DocumentContext {
  ESTIMATE = 4,
  INVOICE = 5,
  PURCHASE_ORDER = 11,
}
```

### SDK Export Updates

```typescript
// packages/sdk/src/index.ts

export { SalesBinderClient } from './resources/index.js';

// Re-export types for convenience
export * from './types/common.types.js';
export * from './types/items.types.js';
export * from './types/customers.types.js';
export * from './types/documents.types.js';
export * from './types/locations.types.js';
export * from './types/categories.types.js';
export * from './config/config.schema.js';

// Export cache types
export * from './cache/types.js';
```

## Todo List

- [ ] Install better-sqlite3 dependency
- [ ] Install @types/better-sqlite3 dev dependency
- [ ] Create packages/sdk/src/cache/types.ts with all interfaces
- [ ] Create packages/sdk/src/cache/index.ts with exports
- [ ] Update packages/sdk/src/index.ts to re-export cache types
- [ ] Verify TypeScript compilation
- [ ] Run linting

## Success Criteria

- [ ] TypeScript compiles without errors
- [ ] All cache types properly exported from SDK
- [ ] Linting passes
- [ ] Types can be imported in CLI package

## Risk Assessment

**Risk:** Type mismatch with existing document types
**Mitigation:** Align with existing Document type from documents.types.ts, use consistent naming

**Risk:** better-sqlite3 native compilation issues
**Mitigation:** Use prebuilt binaries, document installation requirements

## Security Considerations

- Cache file permissions (0600) - sensitive sales data
- Path traversal protection when resolving cache directory
- Validate schema version on cache open

## Next Steps

After completion, proceed to [Phase 02: SQLite Cache Infrastructure](./phase-02-sqlite-cache-infrastructure.md)
