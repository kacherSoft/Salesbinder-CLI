# Brainstorm Report: SalesBinder CLI Tools

**Date:** 2026-01-26
**Project:** SalesBinder CLI
**Status:** Ready for Implementation Planning

---

## Problem Statement

Build a production-grade CLI tool for SalesBinder API integration supporting full CRUD operations across inventory, customers, and documents. Target audience is team/enterprise use requiring operational reliability, multi-account support, and robust error handling.

---

## Requirements Summary

### Functional Requirements
- Full CRUD operations for: Items, Customers (with contexts), Documents/Invoices
- Account management with contextId support (Customers: 2, Prospects: 8, Suppliers: 10)
- Delta sync using `modifiedSince` parameter for incremental updates
- Pagination support (100 items per page, auto-fetch all pages)
- Search and filtering capabilities

### Non-Functional Requirements
- **Runtime:** Node.js (TypeScript)
- **Auth:** Config file storage (`~/.salesbinder/config.json`) supporting multiple accounts/subdomains
- **Output:** JSON-only (machine-readable, pipe-friendly)
- **Error Handling:** Full retry logic with exponential backoff for rate limits (429)
- **Logging:** Request tracing IDs for debugging
- **Testing:** Both unit tests (mocked) and integration tests (real API)
- **Architecture:** Monorepo with extracted SDK for future web app code reuse

---

## Architecture Decisions

### 1. Project Structure (Monorepo)

```
salesbinder-cli/
├── packages/
│   ├── sdk/                 # Shared API client library
│   │   ├── src/
│   │   │   ├── auth/        # Basic Auth, API key management
│   │   │   ├── client/      # Axios client with interceptors
│   │   │   ├── resources/   # Typed API methods (items, customers, documents)
│   │   │   └── retry/       # Rate limit handling, exponential backoff
│   │   └── package.json
│   └── cli/                 # CLI interface
│       ├── src/
│       │   ├── commands/    # Command implementations
│       │   ├── config/      # Config file management
│       │   └── output/      # JSON formatting
│       └── package.json
├── package.json             # Root package.json
└── tsconfig.json            # Shared TypeScript config
```

**Rationale:** Research highlights SDK extraction for web app transition. Doing this upfront avoids duplication later. Monorepo (Turborepo or pnpm workspaces) enables shared TypeScript config and atomic releases.

### 2. CLI Framework

**Decision:** Commander.js + TypeScript

**Rationale:**
- Oclif is overkill for single-purpose CLI (heavy, complex plugin system)
- Commander.js is lightweight, mature, widely adopted
- TypeScript support is excellent
- Research mentions Commander.js explicitly

### 3. Configuration Management

**Config File Structure:** `~/.salesbinder/config.json`

```json
{
  "defaultAccount": "production",
  "accounts": {
    "production": {
      "subdomain": "acme",
      "apiKey": "key_live_xxx",
      "apiVersion": "2.0"
    },
    "sandbox": {
      "subdomain": "acme-sandbox",
      "apiKey": "key_test_xxx",
      "apiVersion": "2.0"
    }
  },
  "preferences": {
    "defaultLimit": 100,
    "timeout": 30000
  }
}
```

**Security:**
- File permissions: `0600` (owner read/write only)
- Permissions check on every CLI launch
- Warning if permissions are too open

**Rationale:** Team/enterprise use requires multiple accounts/subdomains. Config file persists across sessions, avoids repeating setup.

### 4. Authentication Client

**Implementation:** Axios interceptor with Base64 encoding

```typescript
// sdk/src/client/axios.interceptor.ts
const authInterceptor = (config: AxiosRequestConfig) => {
  const credentials = `${apiKey}:x`;
  const encoded = Buffer.from(credentials).toString('base64');
  config.headers['Authorization'] = `Basic ${encoded}`;
  return config;
};
```

**Rationale:** Centralized auth logic reduces errors, supports key rotation without codebase changes.

### 5. Rate Limit Handling

**Strategy:** Exponential backoff with jitter

```
Attempt 1: Immediate
Attempt 2: Wait 1s + random(0-500ms)
Attempt 3: Wait 2s + random(0-1000ms)
Attempt 4: Wait 4s + random(0-2000ms)
Max: 5 attempts
```

**429 Response Handling:**
- Parse `Retry-After` header if present
- Otherwise use exponential backoff
- Log warning with request ID
- After 5 failures: abort with clear error message

**Rationale:** API blocks for 1 minute on sustained violations (60/min) or burst violations (18/10s). Full retry logic prevents lockouts.

### 6. Resource Operations

**Items (Inventory):**
- `items list [--page] [--limit] [--category] [--search] [--modified]`
- `items get <id>`
- `items create <data.json>`
- `items update <id> <data.json>`
- `items delete <id>`

**Customers (with contexts):**
- `customers list [--context 2|8|10] [--search]`
- `customers get <id>`
- `customers create <data.json> --context 2|8|10`
- `customers update <id> <data.json>`
- `customers delete <id>`

**Documents (Invoices/POs):**
- `documents list [--type invoice|estimate|po]`
- `documents get <id>`
- `documents create <data.json>` (complex nested payload)
- `documents update <id> <data.json>`
- `documents delete <id>`

**Rationale:** Maps directly to SalesBinder REST endpoints. Context flag for customers matches API requirements.

### 7. Sync Implementation

**Delta Sync Workflow:**

```typescript
// State file: ~/.salesbinder/state.json
{
  "lastSync": {
    "items": 1706263200,
    "customers": 1706263200,
    "documents": 1706263200
  }
}

// Sync command
async syncResource(resource: string) {
  const lastSync = state.lastSync[resource];
  const timestamp = Math.floor(Date.now() / 1000);

  // Fetch modified since lastSync
  const changes = await api.get(`/${resource}.json`, {
    params: { modifiedSince: lastSync }
  });

  // Update local system
  await processChanges(changes);

  // Record timestamp BEFORE request started (not after)
  state.lastSync[resource] = lastSync;
  saveState(state);
}
```

**Rationale:** Research emphasizes this pattern for high-volume stores. Recording start timestamp prevents missing records modified during transfer.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Document payload complexity | High | Validate JSON structure in tests, provide examples in docs |
| Rate limit lockouts | Medium | Exponential backoff, respect both limits (60/min, 18/10s) |
| Config file security | Medium | Permission checks, warn on insecure configs |
| API breaking changes | Low | Version pinning in config, monitor changelog |
| Sync edge cases | Medium | Extensive integration tests, error recovery |

---

## Implementation Phases

### Phase 1: Foundation
1. Initialize monorepo (pnpm workspaces)
2. Setup TypeScript, ESLint, Jest
3. Implement SDK auth client
4. Implement config file management
5. Basic CLI scaffold with Commander.js

### Phase 2: Core Operations
1. Items CRUD commands
2. Customer CRUD with contexts
3. Pagination handling
4. JSON output formatting
5. Request tracing IDs

### Phase 3: Advanced Features
1. Document CRUD (complex payloads)
2. Delta sync engine
3. Rate limit retry logic
4. State file management

### Phase 4: Enterprise Hardening
1. Comprehensive error handling
2. Structured logging
3. Security audit
4. Integration test suite

---

## Tech Stack

| Category | Choice | Version |
|----------|--------|---------|
| Runtime | Node.js | 20+ LTS |
| Language | TypeScript | 5.x |
| Package Manager | pnpm | 8.x |
| Monorepo | pnpm workspaces | - |
| HTTP Client | axios | 1.x |
| CLI Framework | commander | 11.x |
| Testing | jest | 29.x |
| Auth | HTTP Basic (axios) | - |

---

## Success Criteria

- [ ] All CRUD operations work for Items, Customers, Documents
- [ ] Delta sync respects `modifiedSince` parameter
- [ ] Rate limit retry logic prevents lockouts
- [ ] Config file supports multiple accounts with proper permissions
- [ ] Output is valid JSON parseable by `jq`
- [ ] Integration tests pass against real API
- [ ] Unit tests cover critical paths (auth, retry, pagination)
- [ ] Request IDs logged for debugging

---

## Open Questions

1. **Document payloads:** Research mentions "complex nested payloads" for documents. Need example JSON structure to design create/update commands properly.

2. **Webhook support:** Not in initial scope, but should CLI include webhook endpoint registration commands for future use?

3. **Bulk operations:** Does SalesBinder API support bulk create/update? If yes, should CLI expose this for efficiency?

---

## Next Steps

1. **Get document payload examples** from SalesBinder API docs or support
2. **Create detailed implementation plan** using `/plan` command
3. **Set up monorepo structure** with pnpm workspaces
4. **Implement auth client** as first concrete task
5. **Build integration test suite** early to validate against real API

---

## Recommendation

Proceed with implementation. User understands risks of full CRUD scope, has realistic requirements, and chose pragmatic tech stack. Monorepo with SDK extraction is forward-looking without being over-engineered. Config file + rate limit handling + request tracing IDs are appropriate for team/enterprise use.

**Go decision:** Ready for `/plan` command to create detailed implementation phases.
