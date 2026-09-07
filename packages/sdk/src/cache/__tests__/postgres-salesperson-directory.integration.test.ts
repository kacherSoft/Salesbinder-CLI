import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import {
  SALESPERSON_DIRECTORY_SOURCE,
  type SalespersonDirectoryInput,
  type SalespersonRepairResult,
} from '../salesperson-directory.js';
import {
  createSalesBinderAccountBinding,
  type DocumentRow,
  type ItemDocumentRow,
  type ItemRow,
  type ItemStockLocationRow,
} from '../types.js';
import { normalizeV3DocumentCacheRows } from '../v3-document-cache-normalizer.js';
import type { PaymentTransactionRow } from '../payment-sync.types.js';

const { Pool } = pg;

const testUrl = process.env.SALESBINDER_OFFSET_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('salesperson-directory-test');

const userA = 'b16f844f-4b40-4f05-a468-407106563e03';
const userB = 'f55f00e0-5d71-4d1a-900c-fdcac64f93d0';
const userC = '877686ce-c4f9-4a50-80c6-650465547ef0';
const unknownUser = '9f60761d-b7dd-4634-8bc9-fdd4c7c06f03';
const customerId = '90b266c8-628f-48ce-a83c-21013cb740f6';
const docSameId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const docKnownId = '0896ed5b-f920-4d42-8d37-f54da5a21c8c';
const docChangedId = '2c965d06-1933-4d90-a90b-5f80909105da';
const docUnknownId = 'd1f04079-2d11-4f7a-8868-d6d5448abbb8';
const docAssignmentId = 'bf9bd825-dc32-4ae0-a9f9-12f89325867a';
const itemA = '05c86ce5-c234-438b-9908-f518e42d42e4';
const itemB = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';

describeIfPostgres('PostgresCacheService salesperson directory integration', () => {
  jest.setTimeout(45_000);

  let baseUrl = '';
  let adminPool: InstanceType<typeof Pool> | undefined;
  const contexts: TestContext[] = [];

  beforeAll(() => {
    baseUrl = guardedUrl();
    adminPool = new Pool({ connectionString: baseUrl });
  });

  afterEach(async () => {
    while (contexts.length) await cleanup(contexts.pop());
  });

  afterAll(async () => {
    await adminPool?.end().catch(() => undefined);
  });

  it('preserves an existing salesperson name when normalized V3 repeats the same assigned ID without a name', async () => {
    const ctx = await createContext('preserve_same_id');
    const existing = document('same-id-canonical', 5, 75206, {
      api_doc_id: docSameId,
      user_id: userA,
      salesperson_name: 'Existing Rep',
    });
    const update = normalizedInvoice(docSameId, 75206, userA, { itemId: itemA });

    expect(update.docRow).not.toHaveProperty('salesperson_name');
    await ctx.service.replaceDocumentBundle(existing, [line('same-id-item', existing.doc_id)]);
    await ctx.service.replaceDocumentBundle(update.docRow, update.itemRows);

    await expect(ctx.service.getDocument('same-id-canonical')).resolves.toMatchObject({
      doc_id: 'same-id-canonical',
      api_doc_id: docSameId,
      user_id: userA,
      salesperson_name: 'Existing Rep',
    });
  });

  it('resolves a normalized V3 new assignment from the account-bound directory', async () => {
    const ctx = await createContext('known_new_assignment');
    const update = normalizedInvoice(docKnownId, 75207, userB, { itemId: itemA });

    await setDirectory(ctx.service, directory([{ userId: userB, displayName: 'Directory Rep' }]));
    await ctx.service.replaceDocumentBundle(update.docRow, update.itemRows);

    await expect(ctx.service.getDocument(docKnownId)).resolves.toMatchObject({
      user_id: userB,
      salesperson_name: 'Directory Rep',
    });
  });

  it('uses directory names for normalized V3 changed assignments and clears explicit unassignment', async () => {
    const ctx = await createContext('changed_and_unassigned');

    await setDirectory(ctx.service, directory([{ userId: userB, displayName: 'Changed Rep' }]));
    await ctx.service.replaceDocumentBundle(
      document('changed-canonical', 5, 75208, {
        api_doc_id: docChangedId,
        user_id: userA,
        salesperson_name: 'Original Rep',
      }),
      [line('changed-item', 'changed-canonical')]
    );

    const changed = normalizedInvoice(docChangedId, 75208, userB, { itemId: itemA });
    await ctx.service.replaceDocumentBundle(changed.docRow, changed.itemRows);

    await expect(ctx.service.getDocument('changed-canonical')).resolves.toMatchObject({
      doc_id: 'changed-canonical',
      api_doc_id: docChangedId,
      user_id: userB,
      salesperson_name: 'Changed Rep',
    });

    const unassigned = normalizedInvoice(docChangedId, 75208, null, { itemId: itemB });
    expect(unassigned.docRow).toMatchObject({ user_id: null });
    expect(unassigned.docRow).not.toHaveProperty('salesperson_name');
    await ctx.service.replaceDocumentBundle(unassigned.docRow, unassigned.itemRows);

    await expect(ctx.service.getDocument('changed-canonical')).resolves.toMatchObject({
      user_id: null,
      salesperson_name: null,
    });
  });

  it('rejects a normalized V3 unresolved new assignment without inheriting a prior name', async () => {
    const ctx = await createContext('unknown_assignment');
    const unresolved = normalizedInvoice(docUnknownId, 75209, unknownUser, { itemId: itemA });

    await setDirectory(ctx.service, directory([{ userId: userA, displayName: 'Known Rep' }]));
    await ctx.service.replaceDocumentBundle(
      document('unknown-canonical', 5, 75209, {
        api_doc_id: docUnknownId,
        user_id: userA,
        salesperson_name: 'Known Rep',
      }),
      [line('unknown-item', 'unknown-canonical')]
    );

    await expect(
      ctx.service.replaceDocumentBundle(unresolved.docRow, unresolved.itemRows)
    ).rejects.toThrow(/salesperson|directory|unresolved/i);

    await expect(ctx.service.getDocument('unknown-canonical')).resolves.toMatchObject({
      user_id: userA,
      salesperson_name: 'Known Rep',
    });
    await expect(ctx.service.getItemDocuments('unknown-canonical')).resolves.toEqual([
      expect.objectContaining({ item_id: 'unknown-item' }),
    ]);
  });

  it('distinguishes omitted V3 assignment keys from explicit null unassignment through the shared writer', async () => {
    const ctx = await createContext('v3_assignment_key');

    expect(() =>
      normalizeV3DocumentCacheRows(
        v3InvoicePayload(docAssignmentId, 75210, userA, { omitAssignment: true }),
        {
          id: docAssignmentId,
          contextId: 5,
          documentNumber: 75210,
        }
      )
    ).toThrow(/V3 document failed source validation|invalid/i);

    await ctx.service.replaceDocumentBundle(
      document(docAssignmentId, 5, 75210, { user_id: userA, salesperson_name: 'Prior Rep' }),
      [line('prior-assignment-line', docAssignmentId)]
    );
    const unassigned = normalizedInvoice(docAssignmentId, 75210, null, { itemId: itemB });
    expect(unassigned.docRow).toMatchObject({ user_id: null });
    expect(unassigned.docRow).not.toHaveProperty('salesperson_name');

    await ctx.service.replaceDocumentBundle(unassigned.docRow, unassigned.itemRows);

    await expect(ctx.service.getDocument(docAssignmentId)).resolves.toMatchObject({
      user_id: null,
      salesperson_name: null,
    });
  });

  it('repairs only blank salesperson names in contexts 4, 5, and 11 and leaves other cache state untouched', async () => {
    const ctx = await createContext('repair_contexts');
    const candidates = [
      document('estimate-blank', 4, 4101, { user_id: userA, salesperson_name: 'Seed A' }),
      document('invoice-null', 5, 5101, { user_id: userB, salesperson_name: 'Seed B' }),
      document('po-blank', 11, 1101, { user_id: userC, salesperson_name: 'Seed C' }),
      document('invoice-unresolved', 5, 5102, {
        user_id: unknownUser,
        salesperson_name: 'Seed Unknown',
      }),
      document('invoice-named', 5, 5103, { user_id: userA, salesperson_name: 'Already Named' }),
      document('customer-context', 2, 2101, { user_id: userA, salesperson_name: 'Seed Context 2' }),
    ];

    await setDirectory(
      ctx.service,
      directory([
        { userId: userA, displayName: 'Rep A' },
        { userId: userB, displayName: 'Rep B' },
        { userId: userC, displayName: 'Rep C' },
      ])
    );
    for (const doc of candidates) {
      await ctx.service.replaceDocumentBundle(
        doc,
        [line(`${doc.doc_id}-line`, doc.doc_id)],
        [payment(`${doc.doc_id}-payment`, doc.doc_id)]
      );
    }
    await setSalespersonName(ctx.pool, 'estimate-blank', '');
    await setSalespersonName(ctx.pool, 'invoice-null', null);
    await setSalespersonName(ctx.pool, 'po-blank', '   ');
    await setSalespersonName(ctx.pool, 'invoice-unresolved', null);
    await setSalespersonName(ctx.pool, 'customer-context', null);
    await ctx.service.insertItem(item('stock-item'));
    await ctx.service.insertItemStockLocation(stock('stock-row', 'stock-item'));
    await putMeta(ctx.pool, 'state', JSON.stringify({ untouched: 'state' }));
    await putMeta(ctx.pool, 'document_offset_sync.run.v1', JSON.stringify({ untouched: 'offset' }));
    await putMeta(ctx.pool, 'official_v3_sync.run.v1', JSON.stringify({ untouched: 'official' }));
    const before = await fingerprints(ctx.pool);

    const first = await repair(ctx.service);
    const afterFirst = await fingerprints(ctx.pool);

    expect(first).toEqual({
      updatedCount: 3,
      unresolvedUserCounts: { [unknownUser]: 1 },
    });
    expect(afterFirst.documentsExceptSalespersonName).toBe(before.documentsExceptSalespersonName);
    expect(afterFirst.itemDocuments).toBe(before.itemDocuments);
    expect(afterFirst.payments).toBe(before.payments);
    expect(afterFirst.stock).toBe(before.stock);
    expect(afterFirst.runMeta).toBe(before.runMeta);
    await expect(ctx.service.getDocument('estimate-blank')).resolves.toMatchObject({
      salesperson_name: 'Rep A',
    });
    await expect(ctx.service.getDocument('invoice-null')).resolves.toMatchObject({
      salesperson_name: 'Rep B',
    });
    await expect(ctx.service.getDocument('po-blank')).resolves.toMatchObject({
      salesperson_name: 'Rep C',
    });
    await expect(ctx.service.getDocument('invoice-unresolved')).resolves.toMatchObject({
      salesperson_name: null,
    });
    await expect(ctx.service.getDocument('invoice-named')).resolves.toMatchObject({
      salesperson_name: 'Already Named',
    });
    await expect(ctx.service.getDocument('customer-context')).resolves.toMatchObject({
      salesperson_name: null,
    });

    const second = await repair(ctx.service);
    expect(second).toEqual({ updatedCount: 0, unresolvedUserCounts: { [unknownUser]: 1 } });
    await expect(fingerprints(ctx.pool)).resolves.toEqual(afterFirst);
  });

  it('atomically persists a supplied directory and repairs names in one transaction', async () => {
    const ctx = await createContext('repair_with_directory');

    await ctx.service.replaceDocumentBundle(
      document('atomic-doc', 5, 5401, { user_id: userB, salesperson_name: 'Seed B' }),
      [line('atomic-line', 'atomic-doc')]
    );
    await setSalespersonName(ctx.pool, 'atomic-doc', null);

    await expect(
      repair(ctx.service, directory([{ userId: userB, displayName: 'Atomic Rep' }]))
    ).resolves.toEqual({ updatedCount: 1, unresolvedUserCounts: {} });

    await expect(getDirectory(ctx.service)).resolves.toMatchObject({
      users: [{ userId: userB, displayName: 'Atomic Rep' }],
    });
    await expect(ctx.service.getDocument('atomic-doc')).resolves.toMatchObject({
      salesperson_name: 'Atomic Rep',
    });
  });

  it('rolls back supplied directory persistence and name repair when a document update fails', async () => {
    const ctx = await createContext('repair_rollback');
    const priorDirectory = directory([{ userId: userA, displayName: 'Prior Rep' }]);
    const replacementDirectory = directory([{ userId: userA, displayName: 'Replacement Rep' }]);

    await setDirectory(ctx.service, priorDirectory);
    await ctx.service.replaceDocumentBundle(
      document('rollback-doc', 5, 5201, { user_id: userA, salesperson_name: 'Seed A' }),
      [line('rollback-line', 'rollback-doc')]
    );
    await setSalespersonName(ctx.pool, 'rollback-doc', null);
    const priorSnapshot = await getDirectory(ctx.service);
    const before = await fingerprints(ctx.pool, { includeSalespersonName: true });
    await installFailingSalespersonUpdateTrigger(ctx.pool);

    await expect(repair(ctx.service, replacementDirectory)).rejects.toThrow(
      'fail_salesperson_repair'
    );

    await expect(getDirectory(ctx.service)).resolves.toEqual(priorSnapshot);
    await expect(fingerprints(ctx.pool, { includeSalespersonName: true })).resolves.toEqual(before);
  });

  it('fails closed on retained writer lock loss during atomic directory repair without partial publication', async () => {
    const ctx = await createContext('repair_lock_loss');
    const priorDirectory = directory([{ userId: userA, displayName: 'Prior Rep' }]);
    const replacementDirectory = directory([
      { userId: userA, displayName: 'Rep A' },
      { userId: userB, displayName: 'Rep B' },
    ]);
    const blockerKey = `salesperson-block-${randomUUID()}`;

    await setDirectory(ctx.service, priorDirectory);
    await ctx.service.replaceDocumentBundle(
      document('lock-doc-a', 5, 5301, { user_id: userA, salesperson_name: 'Seed A' }),
      [line('lock-line-a', 'lock-doc-a')]
    );
    await ctx.service.replaceDocumentBundle(
      document('lock-doc-b', 5, 5302, { user_id: userB, salesperson_name: 'Seed B' }),
      [line('lock-line-b', 'lock-doc-b')]
    );
    await setSalespersonName(ctx.pool, 'lock-doc-a', null);
    await setSalespersonName(ctx.pool, 'lock-doc-b', null);
    await installBlockingSalespersonUpdateTrigger(ctx.pool, blockerKey, 'lock-doc-a');
    const priorSnapshot = await getDirectory(ctx.service);
    const before = await fingerprints(ctx.pool, { includeSalespersonName: true });
    const blocker = await ctx.pool.connect();

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [blockerKey]);
      const inFlight = repair(ctx.service, replacementDirectory)
        .then(() => ({ completed: true, error: undefined }))
        .catch((error: Error) => ({ completed: false, error }));

      const pid = await waitForBlockedOwner(ctx.pool, ctx.applicationName);
      await ctx.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      const result = await inFlight;

      expect(result.completed).toBe(false);
      expect(result.error?.message).toBe('PostgreSQL sync lock lost.');
      await expect(getDirectory(ctx.service)).resolves.toEqual(priorSnapshot);
      await expect(fingerprints(ctx.pool, { includeSalespersonName: true })).resolves.toEqual(
        before
      );
      await expect(repair(ctx.service)).rejects.toThrow('PostgreSQL sync lock lost.');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('rejects account-mismatched and malformed directories without replacing the prior directory', async () => {
    const ctx = await createContext('directory_validation');

    await setDirectory(ctx.service, directory([{ userId: userA, displayName: 'Original Rep' }]));
    await expect(getDirectory(ctx.service)).resolves.toMatchObject({
      accountIdentity: binding.accountIdentity,
      source: SALESPERSON_DIRECTORY_SOURCE,
      users: [{ userId: userA, displayName: 'Original Rep' }],
    });

    await expect(
      setDirectory(ctx.service, {
        ...directory([{ userId: userB, displayName: 'Wrong Account Rep' }]),
        accountIdentity: createSalesBinderAccountBinding('other-salesbinder-account')
          .accountIdentity,
      })
    ).rejects.toThrow(/account|binding|identity/i);
    await expect(
      setDirectory(
        ctx.service,
        directory([
          { userId: userA, displayName: 'Duplicate One' },
          { userId: userA, displayName: 'Duplicate Two' },
        ])
      )
    ).rejects.toThrow(/duplicate|salesperson|directory/i);
    await expect(
      setDirectory(ctx.service, {
        ...directory([{ userId: userB, displayName: 'Wrong Source Rep' }]),
        source: 'legacy_document_user' as SalespersonDirectoryInput['source'],
      })
    ).rejects.toThrow(/source|directory/i);
    await expect(
      setDirectory(ctx.service, directory([{ userId: userB, displayName: '   ' }]))
    ).rejects.toThrow(/display|name|directory/i);

    await expect(getDirectory(ctx.service)).resolves.toMatchObject({
      accountIdentity: binding.accountIdentity,
      source: SALESPERSON_DIRECTORY_SOURCE,
      users: [{ userId: userA, displayName: 'Original Rep' }],
    });
  });

  async function createContext(label: string): Promise<TestContext> {
    if (!adminPool) throw new Error('PostgreSQL admin pool was not initialized.');
    const schema = `salesperson_${label}_${randomUUID().replaceAll('-', '_')}`;
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const url = scopedUrl(baseUrl, schema);
    const service = new PostgresCacheService(url);
    const pool = new Pool({ connectionString: url });
    const applicationName = `sb-salesperson-${schema.slice(-24)}`;
    const ctx = { schema, url, applicationName, service, pool };
    contexts.push(ctx);
    await service.ensureAccountBinding(binding);
    await expect(service.tryAcquireSyncLock('cache-sync')).resolves.toBe(true);
    return ctx;
  }

  async function cleanup(ctx: TestContext | undefined): Promise<void> {
    if (!ctx || !adminPool) return;
    await ctx.service.close().catch(() => undefined);
    await ctx.pool.end().catch(() => undefined);
    await adminPool
      .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(ctx.schema)} CASCADE`)
      .catch(() => undefined);
  }
});

interface TestContext {
  schema: string;
  url: string;
  applicationName: string;
  service: PostgresCacheService;
  pool: InstanceType<typeof Pool>;
}

interface SalespersonDirectoryApi {
  setSalespersonDirectory(directory: SalespersonDirectoryInput): Promise<void>;
  getSalespersonDirectory(): Promise<SalespersonDirectoryInput | null>;
  repairMissingSalespersonNames(
    directory?: SalespersonDirectoryInput
  ): Promise<SalespersonRepairResult>;
}

const salespersonApi = (service: PostgresCacheService): SalespersonDirectoryApi =>
  service as unknown as SalespersonDirectoryApi;

const setDirectory = (
  service: PostgresCacheService,
  input: SalespersonDirectoryInput
): Promise<void> => salespersonApi(service).setSalespersonDirectory(input);

const getDirectory = (service: PostgresCacheService): Promise<SalespersonDirectoryInput | null> =>
  salespersonApi(service).getSalespersonDirectory();

const repair = (
  service: PostgresCacheService,
  input?: SalespersonDirectoryInput
): Promise<SalespersonRepairResult> => salespersonApi(service).repairMissingSalespersonNames(input);

function directory(users: SalespersonDirectoryInput['users']): SalespersonDirectoryInput {
  return {
    accountIdentity: binding.accountIdentity,
    source: SALESPERSON_DIRECTORY_SOURCE,
    fetchedAt: 1788670542,
    users,
  };
}

function document(
  docId: string,
  contextId: number,
  docNumber: number,
  overrides: Partial<DocumentRow> = {}
): DocumentRow {
  return {
    doc_id: docId,
    api_doc_id: docId,
    context_id: contextId,
    doc_number: docNumber,
    issue_date: '2026-09-07',
    customer_id: customerId,
    modified: 1788670542,
    cache_source: 'api',
    document_name: `Document ${docNumber}`,
    total_price: 100,
    subtotal: 100,
    imported_at: 100,
    ...overrides,
  };
}

function normalizedInvoice(
  id: string,
  documentNumber: number,
  salespersonId: string | null,
  options: { itemId?: string } = {}
) {
  return normalizeV3DocumentCacheRows(
    v3InvoicePayload(id, documentNumber, salespersonId, options),
    {
      id,
      contextId: 5,
      documentNumber,
    }
  );
}

function v3InvoicePayload(
  id: string,
  documentNumber: number,
  salespersonId: string | null,
  options: { itemId?: string; omitAssignment?: boolean } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id,
    object: 'invoice',
    invoice_number: documentNumber,
    name: `Invoice ${documentNumber}`,
    customer_id: customerId,
    customer_name: 'Example Customer',
    customer_kind: 'customer',
    issue_date: '2026-09-07',
    updated_at: '2026-09-07T02:03:04+00:00',
    status_id: 9,
    status: 'Sent',
    party: { account_number: String(documentNumber) },
    subtotal: '10.0000',
    total: '10.0000',
    salesperson_id: salespersonId,
    lines: [
      {
        id: randomUUID(),
        object: 'invoice_line',
        invoice_id: id,
        line_type: 'inventory',
        item_id: options.itemId ?? itemA,
        name: 'Widget',
        quantity: '1.0000',
        unit_price: '10.0000',
        subtotal: '10.0000',
      },
    ],
  };
  if (options.omitAssignment) delete payload['salesperson_id'];
  return payload;
}

function line(itemId: string, docId: string): Omit<ItemDocumentRow, 'id'> {
  return {
    item_id: itemId,
    doc_id: docId,
    document_item_id: `${docId}:${itemId}`,
    quantity: 2,
    price: 5,
    item_name: itemId,
  };
}

function payment(transactionId: string, docId: string): PaymentTransactionRow {
  return {
    transaction_id: transactionId,
    doc_id: docId,
    amount: 7,
    transaction_date: '2026-09-07',
    reference: transactionId,
    imported_at: 100,
  };
}

function item(itemId: string): ItemRow {
  return {
    item_id: itemId,
    name: itemId,
    quantity: 1,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 100,
  };
}

function stock(stockRowId: string, itemId: string): ItemStockLocationRow {
  return {
    stock_row_id: stockRowId,
    item_id: itemId,
    quantity_on_hand: 1,
    quantity_reserved: null,
    quantity_available: null,
    quantity_incoming: null,
    in_transit: null,
    cache_source: 'api',
    source_api_version: '3',
    imported_at: 100,
  };
}

const documentFingerprintColumns = (includeSalespersonName = false): string[] =>
  [
    'doc_id',
    'context_id',
    'doc_number',
    'issue_date',
    'customer_id',
    'modified',
    'api_doc_id',
    'cache_source',
    'document_name',
    'custom_doc_number',
    'account_id',
    'account_context_id',
    'account_name',
    'account_number',
    'user_id',
    includeSalespersonName ? 'salesperson_name' : null,
    'customer_name',
    'customer_number',
    'supplier_name',
    'supplier_number',
    'status_id',
    'status_name',
    'total_price',
    'total_cost',
    'subtotal',
    'associated_document_id',
    'external_po_number',
    'shipping_location',
    'date_sent',
    'shipped_percent',
    'is_cancelled',
    'archived',
    'imported_at',
  ].filter((column): column is string => Boolean(column));

async function fingerprints(
  pool: InstanceType<typeof Pool>,
  options: { includeSalespersonName?: boolean } = {}
): Promise<Record<string, string>> {
  return {
    documentsExceptSalespersonName: await tableDigest(
      pool,
      `SELECT ${documentFingerprintColumns(options.includeSalespersonName).join(', ')}
       FROM documents ORDER BY doc_id`
    ),
    itemDocuments: await tableDigest(pool, 'SELECT * FROM item_documents ORDER BY doc_id, item_id'),
    payments: await tableDigest(pool, 'SELECT * FROM payment_transactions ORDER BY transaction_id'),
    stock: await tableDigest(pool, 'SELECT * FROM item_stock_locations ORDER BY stock_row_id'),
    runMeta: await tableDigest(
      pool,
      `SELECT key, value FROM cache_meta
       WHERE key IN ('state', 'sync_status', 'document_offset_sync.run.v1', 'official_v3_sync.run.v1')
       ORDER BY key`
    ),
  };
}

async function tableDigest(pool: InstanceType<typeof Pool>, sql: string): Promise<string> {
  const result = await pool.query<Record<string, unknown>>(sql);
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex');
}

async function putMeta(pool: InstanceType<typeof Pool>, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function setSalespersonName(
  pool: InstanceType<typeof Pool>,
  docId: string,
  name: string | null
): Promise<void> {
  await pool.query('UPDATE documents SET salesperson_name = $2 WHERE doc_id = $1', [docId, name]);
}

async function installFailingSalespersonUpdateTrigger(
  pool: InstanceType<typeof Pool>
): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_salesperson_repair_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.salesperson_name IS DISTINCT FROM OLD.salesperson_name THEN
        RAISE EXCEPTION 'fail_salesperson_repair';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_salesperson_repair
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION fail_salesperson_repair_fn();
  `);
}

async function installBlockingSalespersonUpdateTrigger(
  pool: InstanceType<typeof Pool>,
  lockKey: string,
  docId: string
): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION block_salesperson_repair_fn()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.doc_id = ${quoteLiteral(docId)}
         AND NEW.salesperson_name IS DISTINCT FROM OLD.salesperson_name THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(${quoteLiteral(lockKey)}, 0));
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER block_salesperson_repair
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION block_salesperson_repair_fn();
  `);
}

async function waitForBlockedOwner(
  pool: InstanceType<typeof Pool>,
  applicationName: string
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid
       FROM pg_locks AS lock
       JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
       WHERE lock.locktype = 'advisory'
         AND lock.granted = FALSE
         AND activity.application_name = $1
       LIMIT 1`,
      [applicationName]
    );
    const pid = result.rows[0]?.pid;
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for blocked salesperson repair lock owner.');
}

function guardedUrl(): string {
  if (!testUrl) throw new Error('SALESBINDER_OFFSET_TEST_DB_URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid test URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Salesperson directory integration tests require localhost PostgreSQL.');
  }
  if (!/(offset|salesperson|test|integration)/i.test(database)) {
    throw new Error('Salesperson directory integration tests require an isolated test database.');
  }
  return url.toString();
}

function scopedUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', `sb-salesperson-${schema.slice(-24)}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
