# Phase 02: SQLite Cache Infrastructure

**Priority:** P2
**Status:** pending
**Effort:** 3h
**Dependencies:** Phase 01 complete

## Overview

Implement core SQLite cache service with connection management, schema initialization, and CRUD operations. Establish robust error handling and multi-account support.

## Context Links

- Parent plan: [plan.md](./plan.md)
- Previous phase: [phase-01-environment-and-types.md](./phase-01-environment-and-types.md)
- Database schema: [plan.md#database-schema](./plan.md#database-schema)

## Requirements

### Functional
- SQLite connection management with WAL mode
- Automatic schema initialization and migrations
- CRUD operations for documents, item_documents, cache_meta
- Multi-account isolation (separate cache per account)
- Graceful error handling and recovery

### Non-Functional
- Synchronous operations (better-sqlite3)
- Connection pooling for concurrent queries
- Automatic cache directory creation
- Schema version validation and migration support

## Architecture

```
SQLiteCacheService
├── Connection Management
│   ├── Open/create database file
│   ├── WAL mode enable
│   └── Connection close
├── Schema Management
│   ├── Create tables
│   ├── Create indexes
│   └── Version migrations
└── CRUD Operations
    ├── Documents (insert, update, delete, query)
    ├── Item Documents (insert, update, delete, query)
    └── Cache Meta (get, set, delete)
```

## Related Code Files

### New Files
- `packages/sdk/src/cache/sqlite-cache.service.ts` - Main cache service

### Dependencies
- `packages/sdk/src/cache/types.ts` - Type definitions (Phase 01)

## Implementation Steps

1. **Create cache directory utility**
   - Resolve cache path: `~/.salesbinder/cache/`
   - Account-specific file: `salesbinder-{account}.db`
   - Create directory if missing
   - Set secure permissions (0700 for dir, 0600 for file)

2. **Implement SQLiteCacheService class**
   - Constructor: account name, database path
   - Connection initialization with WAL mode
   - Schema creation/migration
   - Graceful shutdown

3. **Implement document CRUD operations**
   - `insertDocument(doc: DocumentRow)` - Insert or replace
   - `getDocument(docId: string)` - Fetch single document
   - `getDocumentsByContext(contextId: number)` - Fetch by context
   - `getDocumentsModifiedSince(timestamp: number)` - Delta sync query
   - `deleteDocument(docId: string)` - Remove document (cascade to item_documents)

4. **Implement item_document CRUD operations**
   - `insertItemDocument(item: ItemDocumentRow)` - Insert line item
   - `getItemDocuments(docId: string)` - Fetch all line items for document
   - `getItemDocumentsForPeriod(itemId: string, startDate: string, endDate: string, contextId: number)` - Analytics query
   - `deleteItemDocuments(docId: string)` - Remove all line items for document

5. **Implement cache metadata operations**
   - `getCacheState()` - Load full cache state
   - `setCacheState(state: CacheState)` - Save cache state
   - `getLastSyncTime()` - Get last sync timestamp
   - `updateLastSyncTime(timestamp: number)` - Update sync time

6. **Implement batch operations**
   - `batchInsertDocuments(docs: DocumentRow[])` - Transactional insert
   - `batchInsertItemDocuments(items: ItemDocumentRow[])` - Transactional insert
   - `batchDeleteDocuments(docIds: string[])` - Transactional delete

## Implementation Details

### Connection Management

```typescript
class SQLiteCacheService {
  private db: Database.Database;
  private readonly accountName: string;
  private readonly dbPath: string;

  constructor(accountName: string) {
    this.accountName = accountName;
    this.dbPath = this.resolveCachePath(accountName);
    this.db = this.connect();
    this.initializeSchema();
  }

  private resolveCachePath(accountName: string): string {
    const cacheDir = path.join(os.homedir(), '.salesbinder', 'cache');
    fs.mkdirSync(cacheDir, { mode: 0o700, recursive: true });
    return path.join(cacheDir, `salesbinder-${accountName}.db`);
  }

  private connect(): Database.Database {
    const db = new Database(this.dbPath, {
      fileMustExist: false,
      verbose: process.env.DEBUG ? console.log : undefined
    });
    db.pragma('journal_mode = WAL'); // Enable Write-Ahead Logging
    db.pragma('foreign_keys = ON');  // Enable FK constraints
    fs.chmodSync(this.dbPath, 0o600); // Secure file permissions
    return db;
  }

  close(): void {
    this.db.close();
  }
}
```

### Schema Initialization

```typescript
private initializeSchema(): void {
  const currentVersion = this.db.pragma('user_version', { simple: true }) as number;

  if (currentVersion === 0) {
    this.createSchema();
    this.db.pragma('user_version = 1');
  }
  // Future migration logic here
}

private createSchema(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      context_id INTEGER NOT NULL,
      doc_number INTEGER NOT NULL,
      issue_date TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      modified INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_item_documents_item
      ON item_documents(item_id);
    CREATE INDEX IF NOT EXISTS idx_documents_context
      ON documents(context_id);
    CREATE INDEX IF NOT EXISTS idx_documents_modified
      ON documents(modified);
    CREATE INDEX IF NOT EXISTS idx_item_documents_doc
      ON item_documents(doc_id);
  `);
}
```

### Document CRUD Operations

```typescript
insertDocument(doc: DocumentRow): void {
  const stmt = this.db.prepare(`
    INSERT OR REPLACE INTO documents
    (doc_id, context_id, doc_number, issue_date, customer_id, modified)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(doc.doc_id, doc.context_id, doc.doc_number,
           doc.issue_date, doc.customer_id, doc.modified);
}

getDocument(docId: string): DocumentRow | undefined {
  const stmt = this.db.prepare(`
    SELECT * FROM documents WHERE doc_id = ?
  `);
  return stmt.get(docId) as DocumentRow | undefined;
}

getDocumentsModifiedSince(timestamp: number): DocumentRow[] {
  const stmt = this.db.prepare(`
    SELECT * FROM documents WHERE modified > ?
    ORDER BY modified ASC
  `);
  return stmt.all(timestamp) as DocumentRow[];
}

deleteDocument(docId: string): void {
  const stmt = this.db.prepare(`DELETE FROM documents WHERE doc_id = ?`);
  stmt.run(docId); // CASCADE deletes item_documents
}
```

### Analytics Query Helper

```typescript
/**
 * Get item sales for a specific period and document context
 * Used for calculating sold quantities over 3/6/12 month periods
 */
getItemDocumentsForPeriod(
  itemId: string,
  startDate: string,
  endDate: string,
  contextId: number
): ItemDocumentRow[] {
  const stmt = this.db.prepare(`
    SELECT id.* FROM item_documents id
    JOIN documents d ON d.doc_id = id.doc_id
    WHERE id.item_id = ?
      AND d.context_id = ?
      AND d.issue_date BETWEEN ? AND ?
    ORDER BY d.issue_date DESC
  `);
  return stmt.all(itemId, contextId, startDate, endDate) as ItemDocumentRow[];
}

/**
 * Get latest document date for an item by context
 * Used for finding latest OC (context=4) or PO (context=11)
 */
getLatestItemDocumentDate(
  itemId: string,
  contextId: number
): string | undefined {
  const stmt = this.db.prepare(`
    SELECT MAX(d.issue_date) as latest_date
    FROM item_documents id
    JOIN documents d ON d.doc_id = id.doc_id
    WHERE id.item_id = ? AND d.context_id = ?
  `);
  const result = stmt.get(itemId, contextId) as { latest_date: string } | undefined;
  return result?.latest_date;
}
```

### Batch Operations

```typescript
batchInsertDocuments(docs: DocumentRow[]): void {
  const insert = this.db.prepare(`
    INSERT OR REPLACE INTO documents
    (doc_id, context_id, doc_number, issue_date, customer_id, modified)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const transaction = this.db.transaction((documents) => {
    for (const doc of documents) {
      insert.run(doc.doc_id, doc.context_id, doc.doc_number,
                 doc.issue_date, doc.customer_id, doc.modified);
    }
  });
  transaction(docs);
}
```

### Cache Metadata

```typescript
getCacheState(): CacheState | null {
  const stmt = this.db.prepare(`
    SELECT value FROM cache_meta WHERE key = 'state'
  `);
  const row = stmt.get() as CacheMetaRow | undefined;
  if (!row) return null;
  return JSON.parse(row.value) as CacheState;
}

setCacheState(state: CacheState): void {
  const stmt = this.db.prepare(`
    INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('state', ?)
  `);
  stmt.run(JSON.stringify(state));
}
```

## Todo List

- [ ] Create SQLiteCacheService class skeleton
- [ ] Implement connection management (resolveCachePath, connect)
- [ ] Implement schema initialization (createSchema, initializeSchema)
- [ ] Implement document CRUD operations
- [ ] Implement item_document CRUD operations
- [ ] Implement cache metadata operations
- [ ] Implement batch operations
- [ ] Add error handling and validation
- [ ] Add TypeScript types for better-sqlite3
- [ ] Verify WAL mode and FK constraints enabled
- [ ] Test multi-account isolation
- [ ] Verify secure file permissions

## Success Criteria

- [ ] Database file created in ~/.salesbinder/cache/
- [ ] Schema initialized with all tables and indexes
- [ ] CRUD operations work correctly
- [ ] Batch operations use transactions
- [ ] Multi-account caches are isolated
- [ ] File permissions are secure (0600)
- [ ] WAL mode enabled for concurrency
- [ ] FK constraints enforce referential integrity
- [ ] TypeScript compiles without errors
- [ ] Linting passes

## Risk Assessment

**Risk:** Database corruption from concurrent access
**Mitigation:** WAL mode enabled, file locking by SQLite, test concurrent reads

**Risk:** Permission errors on cache directory
**Mitigation:** Create directory with 0700, handle EACCES gracefully

**Risk:** Large database memory footprint
**Mitigation:** better-sqlite3 is memory-efficient, monitor cache size

## Security Considerations

- Cache file at 0600 permissions (owner read/write only)
- Cache directory at 0700 permissions
- No sensitive data in database filenames
- Validate account names to prevent path traversal
- SQL injection prevention via prepared statements

## Next Steps

After completion, proceed to [Phase 03: Document Indexer and Sync](./phase-03-document-indexer-and-sync.md)
