import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { createSalesBinderAccountBinding, type DocumentRow } from '../types.js';
import { normalizeV3DocumentCacheRows } from '../v3-document-cache-normalizer.js';

const { Pool } = pg;

const testUrl = process.env.SALESBINDER_OFFSET_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('document-cost-continuity-test');

const documentId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const newDocumentId = 'e88ecfef-8c77-4428-b6c8-bc2f670ba8a1';
const inventoryLineId = '8a2762d9-d10b-4aef-8c40-536879e74f58';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';
const customerId = '709d2a43-12a9-4d85-a9d9-cb16e66cef53';
const changedCustomerId = 'e217602b-2d10-4641-89e9-f106ab178d2d';

describeIfPostgres('PostgresCacheService document cost continuity integration', () => {
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

  it('replaces a legacy document with V3 historical costs without losing CSV shipping location', async () => {
    const ctx = await createContext('legacy_v3_rewrite');
    await ctx.service.replaceDocumentBundle(legacyDocument(), [
      {
        item_id: itemId,
        doc_id: 'legacy-doc',
        document_item_id: 'old-line',
        quantity: 1,
        price: 1,
        cost: 999,
        total_amount: 1,
      },
    ]);

    const v3 = normalizeV3DocumentCacheRows(v3Invoice(), {
      id: documentId,
      contextId: 5,
      documentNumber: 9001,
    });
    await ctx.service.replaceDocumentBundle(v3.docRow, v3.itemRows);

    await expect(ctx.service.getDocument('legacy-doc')).resolves.toMatchObject({
      doc_id: 'legacy-doc',
      api_doc_id: documentId,
      total_price: 115,
      total_cost: 80,
      subtotal: 115,
      status_id: 9,
      shipping_location: 'CSV Dock',
      account_number: 77,
      customer_number: 77,
      archived: 1,
    });
    await expect(ctx.service.getDocumentByApiId(documentId)).resolves.toMatchObject({
      doc_id: 'legacy-doc',
    });
    await expect(ctx.service.getItemDocuments('legacy-doc')).resolves.toEqual([
      expect.objectContaining({
        item_id: itemId,
        document_item_id: inventoryLineId,
        quantity: 2,
        price: 50,
        cost: 25,
        total_amount: 90,
        discounted_price: 45,
        quantity_shipped: 1,
      }),
    ]);
  });

  it('clears omitted account numbers when the resolved account identity changes', async () => {
    const ctx = await createContext('changed_account_missing_party');
    await ctx.service.replaceDocumentBundle(legacyDocument(), []);
    const source = v3Invoice();
    source.customer_id = changedCustomerId;
    source.customer_name = 'Changed Customer';
    const v3 = normalizeV3DocumentCacheRows(source, {
      id: documentId,
      contextId: 5,
      documentNumber: 9001,
    });

    await ctx.service.replaceDocumentBundle(v3.docRow, v3.itemRows);

    await expect(ctx.service.getDocument('legacy-doc')).resolves.toMatchObject({
      customer_id: changedCustomerId,
      account_number: null,
      customer_number: null,
    });
  });

  it('inserts missing-party account numbers as unknown for new documents', async () => {
    const ctx = await createContext('new_missing_party');
    const source = v3Invoice();
    source.id = newDocumentId;
    source.invoice_number = 9002;
    for (const line of source.lines as Record<string, unknown>[]) {
      line.id = randomUUID();
      line.invoice_id = newDocumentId;
    }
    const v3 = normalizeV3DocumentCacheRows(source, {
      id: newDocumentId,
      contextId: 5,
      documentNumber: 9002,
    });

    await ctx.service.replaceDocumentBundle(v3.docRow, v3.itemRows);

    await expect(ctx.service.getDocument(newDocumentId)).resolves.toMatchObject({
      account_number: null,
      customer_number: null,
    });
  });

  it('clears stored account numbers when V3 explicitly observes party account_number null', async () => {
    const ctx = await createContext('observed_null_party_number');
    await ctx.service.replaceDocumentBundle(legacyDocument(), []);
    const source = v3Invoice();
    source.party = { account_number: null };
    const v3 = normalizeV3DocumentCacheRows(source, {
      id: documentId,
      contextId: 5,
      documentNumber: 9001,
    });

    await ctx.service.replaceDocumentBundle(v3.docRow, v3.itemRows);

    await expect(ctx.service.getDocument('legacy-doc')).resolves.toMatchObject({
      account_number: null,
      customer_number: null,
    });
  });

  it('leaves a legacy bundle unchanged when V3 cost authority is missing before replace', async () => {
    const ctx = await createContext('missing_cost_rejected');
    await ctx.service.replaceDocumentBundle(legacyDocument(), [
      {
        item_id: itemId,
        doc_id: 'legacy-doc',
        document_item_id: 'old-line',
        quantity: 1,
        price: 1,
        cost: 999,
        total_amount: 1,
      },
    ]);

    const malformed = v3Invoice();
    delete ((malformed.lines as Record<string, unknown>[])[0]!).unit_cost;
    expect(() =>
      normalizeV3DocumentCacheRows(malformed, {
        id: documentId,
        contextId: 5,
        documentNumber: 9001,
      })
    ).toThrow(/V3 document failed source validation/);

    await expect(ctx.service.getDocument('legacy-doc')).resolves.toMatchObject({
      doc_id: 'legacy-doc',
      api_doc_id: null,
      total_price: 1,
      total_cost: 999,
      subtotal: 1,
      status_id: 1,
      shipping_location: 'CSV Dock',
      archived: 1,
    });
    await expect(ctx.service.getItemDocuments('legacy-doc')).resolves.toEqual([
      expect.objectContaining({
        item_id: itemId,
        document_item_id: 'old-line',
        quantity: 1,
        price: 1,
        cost: 999,
        total_amount: 1,
      }),
    ]);
  });

  it('keeps explicit public-writer shipping clears distinct from V3 omission', async () => {
    const ctx = await createContext('shipping_clear');
    await ctx.service.replaceDocumentBundle(legacyDocument(), []);
    await ctx.service.replaceDocumentBundle({ ...legacyDocument(), shipping_location: null }, []);

    await expect(ctx.service.getDocument('legacy-doc')).resolves.toMatchObject({
      shipping_location: null,
    });
  });

  async function createContext(label: string): Promise<TestContext> {
    if (!adminPool) throw new Error('admin pool unavailable');
    const schema = `document_cost_${label}_${randomUUID().replaceAll('-', '_')}`;
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const service = new PostgresCacheService(scopedUrl(baseUrl, schema));
    await service.ensureAccountBinding(binding);
    contexts.push({ schema, service });
    return { schema, service };
  }

  async function cleanup(context: TestContext | undefined): Promise<void> {
    if (!context) return;
    await context.service.close().catch(() => undefined);
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(context.schema)} CASCADE`);
  }
});

interface TestContext {
  schema: string;
  service: PostgresCacheService;
}

function legacyDocument(): DocumentRow {
  return {
    doc_id: 'legacy-doc',
    api_doc_id: null,
    context_id: 5,
    doc_number: 9001,
    issue_date: '2026-09-05',
    customer_id: customerId,
    modified: 100,
    cache_source: 'csv',
    total_price: 1,
    total_cost: 999,
    subtotal: 1,
    status_id: 1,
    shipping_location: 'CSV Dock',
    account_number: 77,
    customer_number: 77,
    archived: 1,
  };
}

function v3Invoice(): Record<string, unknown> {
  return {
    id: documentId,
    object: 'invoice',
    invoice_number: 9001,
    customer_id: customerId,
    customer_name: 'Example Customer',
    salesperson_id: null,
    issue_date: '2026-09-05',
    updated_at: '2026-09-06T04:00:49+00:00',
    status_id: 9,
    status: 'Sent',
    subtotal: '115.0000',
    total: '124.2000',
    lines: [
      {
        id: inventoryLineId,
        object: 'invoice_line',
        item_id: itemId,
        line_type: 'inventory',
        name: 'Widget',
        description: 'Blue widget',
        quantity: 2,
        quantity_shipped: 1,
        unit_price: '50.0000',
        discounted_unit_price: '45.0000',
        subtotal: '90.0000',
        unit_cost: '25.0000',
        total_cost: '50.0000',
      },
      {
        id: '9c554a11-3071-42e5-9598-79a3a2f86896',
        object: 'invoice_line',
        item_id: null,
        line_type: 'service',
        name: 'Setup',
        quantity: 3,
        unit_price: '10.0000',
        subtotal: '30.0000',
        unit_cost: '10.0000',
        total_cost: '30.0000',
      },
      {
        id: '3b116bb6-83d1-4946-8898-ce6503945d9a',
        object: 'invoice_line',
        item_id: null,
        line_type: 'discount',
        name: 'Discount',
        quantity: 1,
        unit_price: '-5.0000',
        subtotal: '-5.0000',
        unit_cost: null,
        total_cost: null,
      },
    ],
  };
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

function guardedUrl(): string {
  if (!testUrl) throw new Error('SALESBINDER_OFFSET_TEST_DB_URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid test URL.');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Document cost integration tests require localhost PostgreSQL.');
  }
  if (!/(offset|test|integration)/i.test(database)) {
    throw new Error('Document cost integration tests require an isolated test database.');
  }
  return url.toString();
}

function scopedUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', `sb-doc-cost-${schema.slice(-24)}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
