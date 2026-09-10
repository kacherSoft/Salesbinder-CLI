import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { createSalesBinderAccountBinding, type DocumentRow, type ItemDocumentRow } from '../types.js';
import type { OCShippingPatch } from '../oc-shipping.types.js';
import type { OfficialV3SyncRun } from '../official-v3-sync.types.js';

const { Pool } = pg;
const testUrl = process.env.SALESBINDER_OC_SHIPPING_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('oc-shipping-integration-test');
const customerId = '90b266c8-628f-48ce-a83c-21013cb740f6';
const estimateId = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const estimateTwoId = 'a40e5d25-c573-48ec-aa46-9737eddf2513';
const invoiceId = 'b40e5d25-c573-48ec-aa46-9737eddf2513';
const invoiceTwoId = 'd40e5d25-c573-48ec-aa46-9737eddf2513';
const itemId = '05c86ce5-c234-438b-9908-f518e42d42e4';
const lineId = 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58';
let baseUrl = '';
let admin: InstanceType<typeof Pool> | undefined;
const contexts: Context[] = [];

describeIfPostgres('PostgreSQL OC shipping persistence', () => {
  jest.setTimeout(45_000);

  beforeAll(() => {
    baseUrl = guardedUrl();
    admin = new Pool({ connectionString: baseUrl });
  });
  afterEach(async () => { while (contexts.length) await cleanup(contexts.pop()); });
  afterAll(async () => { await admin?.end().catch(() => undefined); });

  it('updates a cached OC from an invoice patch without changing money, payments, archive, or document timestamp', async () => {
    const ctx = await createContext('invoice');
    await seedEstimate(ctx, estimateId, 20, 1001, 0, { archived: 1, total_price: 99, subtotal: 99 });
    await seedPayment(ctx, estimateId);
    await ctx.service.applyOCShippingPatch(patch(estimateId, 20, invoiceId, 30, 1));

    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({
      associated_document_id: invoiceId, shipped_percent: 50, modified: 20,
      archived: 1, total_price: 99, subtotal: 99,
    });
    await expect(ctx.service.getItemDocuments(estimateId)).resolves.toEqual([
      expect.objectContaining({ document_item_id: lineId, quantity: 2, quantity_shipped: 1 }),
    ]);
    await expect(countPayments(ctx.pool, estimateId)).resolves.toBe(1);
  });

  it('does not let an older same-authority fulfillment overwrite a current OC patch', async () => {
    const ctx = await createContext('stale');
    await seedEstimate(ctx, estimateId, 20, 1001, 0);
    await ctx.service.applyOCShippingPatch(patch(estimateId, 20, invoiceId, 30, 2));
    await ctx.service.applyOCShippingPatch(patch(estimateId, 20, invoiceId, 29, 0));
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: 50 });
    await expect(ctx.service.getItemDocuments(estimateId)).resolves.toEqual([
      expect.objectContaining({ quantity_shipped: 2 }),
    ]);
  });

  it('scopes link changes and deletion clears to the recorded source only', async () => {
    const ctx = await createContext('scoped-clear');
    await seedEstimate(ctx, estimateId, 20, 1001, 0);
    await seedEstimate(ctx, estimateTwoId, 20, 1002, 0);
    await ctx.service.applyOCShippingPatch(patch(estimateId, 20, invoiceId, 30, 2));
    await ctx.service.applyOCShippingPatch(patch(estimateTwoId, 20, invoiceTwoId, 30, 1));
    // A verified relation update reassigns the first OC before the old invoice disappears.
    await ctx.service.applyOCShippingPatch(patch(estimateId, 20, invoiceTwoId, 31, 1));
    await ctx.service.clearOCShippingAuthority(invoiceId);
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: 50 });
    await ctx.service.clearOCShippingAuthority(invoiceTwoId);
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: null });
    await expect(ctx.service.getDocument(estimateTwoId)).resolves.toMatchObject({ shipped_percent: null });
    // Reconciliation absence is uncertain: it clears derived numbers but retains the observed link.
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ associated_document_id: invoiceTwoId });
  });

  it('clears an OC association only for a confirmed official source delete', async () => {
    const ctx = await createContext('official-delete-link');
    await seedEstimate(ctx, estimateId, 20, 1001, 0);
    await ctx.service.insertDocument(document(invoiceId, 5, 2001, 30));
    await ctx.service.applyOCShippingPatch(patch(estimateId, 20, invoiceId, 30, 1));
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();
    await store.beginRun(run);
    await store.sealPage(run.runId, { kind: 'since', value: '1' }, page(run.runId), [
      { resource: 'invoice', id: invoiceId, operation: 'delete' },
    ]);
    await store.applyDocumentDelete(run.runId, (await store.listTasks(run.runId))[0]!);
    await expect(ctx.service.getDocument(invoiceId)).resolves.toBeUndefined();
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({
      associated_document_id: null, shipped_percent: null,
    });
  });

  it('rejects malformed direct patch quantities before mutating the cached OC', async () => {
    const ctx = await createContext('patch-boundary');
    await seedEstimate(ctx, estimateId, 20, 1001, 0);
    const invalid = patch(estimateId, 20, invoiceId, 30, 3);
    await expect(ctx.service.applyOCShippingPatch(invalid)).rejects.toThrow('Invalid OC shipping line patch');
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: null });
  });

  it('records a nonblocking official shipping warning, advances the receipt, and clears it after recovery', async () => {
    const ctx = await createContext('official-warning');
    await seedEstimate(ctx, estimateId, 20, 1001, 0); await seedPayment(ctx, estimateId);
    const store = ctx.service.getOfficialV3SyncStore(); const run = officialRun();
    await store.beginRun(run);
    await store.sealPage(run.runId, { kind: 'since', value: '1' }, page(run.runId), [{ resource: 'invoice', id: invoiceId, operation: 'upsert' }]);
    const unknown = { ...patch(estimateId, 20, invoiceId, 30, 0), shippedPercent: null, lines: [{ documentItemId: lineId, itemId, quantity: 2, quantityShipped: null }] };
    await store.applyDocumentUpsert(run.runId, (await store.listTasks(run.runId))[0]!, document(invoiceId, 5, 2001, 30), [], unknown, { contextId: 5, documentId: invoiceId, code: 'shipping_unknown', updatedAt: 30 });
    await expect(store.advanceAppliedPrefix(run.runId)).resolves.toMatchObject({ appliedGeneration: 1 });
    await expect(ctx.service.getOCShippingPendingWarnings()).resolves.toEqual([expect.objectContaining({ contextId: 5, documentId: invoiceId })]);
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: null });
    await expect(countPayments(ctx.pool, estimateId)).resolves.toBe(1);

    await store.finishRun({ ...run, status: 'success', ingestionComplete: true, pageCount: 1, finishedAt: 31, updatedAt: 31 });
    const recovered: OfficialV3SyncRun = { ...run, runId: `run-${randomUUID()}`, entry: { kind: 'cursor', value: '2' }, status: 'running', pageCount: 0, ingestionComplete: false, updatedAt: 32 };
    await store.beginRun(recovered);
    await store.sealPage(recovered.runId, { kind: 'since', value: '2' }, page(recovered.runId), [{ resource: 'invoice', id: invoiceId, operation: 'upsert' }]);
    await store.applyDocumentUpsert(recovered.runId, (await store.listTasks(recovered.runId))[0]!, document(invoiceId, 5, 2001, 31), [], patch(estimateId, 20, invoiceId, 31, 1));
    await expect(ctx.service.getOCShippingPendingWarnings()).resolves.toEqual([]);
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: 50 });
  });

  it('clears stale OC shipment values for a patchless estimate warning but retains its observed link', async () => {
    const ctx = await createContext('official-estimate-warning');
    await seedEstimate(ctx, estimateId, 20, 1001, 1, {
      associated_document_id: invoiceId,
      shipped_percent: 50,
    });
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();
    await store.beginRun(run);
    await store.sealPage(run.runId, { kind: 'since', value: '1' }, page(run.runId), [
      { resource: 'estimate', id: estimateId, operation: 'upsert' },
    ]);
    const task = (await store.listTasks(run.runId))[0]!;
    await store.applyDocumentUpsert(
      run.runId,
      task,
      document(estimateId, 4, 1001, 21, { associated_document_id: invoiceId }),
      [line(estimateId, 1)],
      null,
      { contextId: 4, documentId: estimateId, code: 'shipping_unknown', updatedAt: 21 }
    );

    await expect(store.listTasks(run.runId)).resolves.toEqual([
      expect.objectContaining({ taskId: task.taskId, status: 'done' }),
    ]);
    await expect(store.advanceAppliedPrefix(run.runId)).resolves.toMatchObject({ appliedGeneration: 1 });
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({
      associated_document_id: invoiceId,
      shipped_percent: null,
    });
    await expect(ctx.service.getItemDocuments(estimateId)).resolves.toEqual([
      expect.objectContaining({ document_item_id: lineId, quantity_shipped: null }),
    ]);
  });

  it('keeps an omitted association but accepts an explicit null clear', async () => {
    const ctx = await createContext('association-continuity');
    await ctx.service.insertDocument(document(invoiceId, 5, 2001, 10, { associated_document_id: estimateId }));
    const omitted = document(invoiceId, 5, 2001, 11) as DocumentRow;
    delete (omitted as Partial<DocumentRow>).associated_document_id;
    await ctx.service.replaceDocumentBundle(omitted, []);
    await expect(ctx.service.getDocument(invoiceId)).resolves.toMatchObject({ associated_document_id: estimateId });
    await ctx.service.replaceDocumentBundle(
      document(invoiceId, 5, 2001, 12, { associated_document_id: null }), []
    );
    await expect(ctx.service.getDocument(invoiceId)).resolves.toMatchObject({ associated_document_id: null });
  });

  it('rolls back document publication, shipping patch, and official task receipt together', async () => {
    const ctx = await createContext('atomic-receipt');
    await seedEstimate(ctx, estimateId, 20, 1001, 0);
    const store = ctx.service.getOfficialV3SyncStore();
    const run = officialRun();
    await store.beginRun(run);
    await store.sealPage(run.runId, { kind: 'since', value: '1' }, page(run.runId), [
      { resource: 'invoice', id: invoiceId, operation: 'upsert' },
    ]);
    const task = (await store.listTasks(run.runId))[0]!;
    await ctx.pool.query(`CREATE FUNCTION fail_oc_shipping_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fail_oc_shipping_line'; END; $$`);
    await ctx.pool.query(`CREATE TRIGGER fail_oc_shipping_line BEFORE UPDATE ON item_documents FOR EACH ROW EXECUTE FUNCTION fail_oc_shipping_line()`);

    await expect(store.applyDocumentUpsert(
      run.runId, task, document(invoiceId, 5, 2001, 30), [], patch(estimateId, 20, invoiceId, 30, 1)
    )).rejects.toThrow('fail_oc_shipping_line');
    await expect(ctx.service.getDocument(invoiceId)).resolves.toBeUndefined();
    await expect(ctx.service.getDocument(estimateId)).resolves.toMatchObject({ shipped_percent: null });
    await expect(store.listTasks(run.runId)).resolves.toEqual([
      expect.objectContaining({ taskId: task.taskId, status: 'pending' }),
    ]);
  });
});

function guardedUrl(): string {
  if (!testUrl) throw new Error('SALESBINDER_OC_SHIPPING_TEST_DB_URL is not configured.');
  const url = new URL(testUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/(test|integration)/i.test(database)) {
    throw new Error('OC shipping integration tests require an isolated localhost test database.');
  }
  return url.toString();
}

async function createContext(label: string): Promise<Context> {
  if (!admin) throw new Error('Test pool is unavailable.');
  const schema = `oc_shipping_${label}_${randomUUID().replaceAll('-', '_')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const service = new PostgresCacheService(url.toString());
  const pool = new Pool({ connectionString: url.toString() });
  const context = { schema, service, pool };
  contexts.push(context);
  await service.ensureAccountBinding(binding);
  return context;
}

async function cleanup(ctx: Context | undefined): Promise<void> {
  if (!ctx || !admin) return;
  await ctx.service.close().catch(() => undefined);
  await ctx.pool.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS "${ctx.schema}" CASCADE`).catch(() => undefined);
}

async function seedEstimate(ctx: Context, id: string, modified: number, number: number, shipped: number, overrides: Partial<DocumentRow> = {}): Promise<void> {
  await ctx.service.insertDocument(document(id, 4, number, modified, overrides));
  await ctx.service.insertItemDocument(line(id, shipped));
}

async function seedPayment(ctx: Context, docId: string): Promise<void> {
  await ctx.pool.query(`INSERT INTO payment_transactions (transaction_id, doc_id, amount, transaction_date, imported_at) VALUES ($1,$2,5,'2026-01-01',1)`, [randomUUID(), docId]);
}

function document(id: string, contextId: 4 | 5, docNumber: number, modified: number, overrides: Partial<DocumentRow> = {}): DocumentRow {
  return { doc_id: id, api_doc_id: id, context_id: contextId, doc_number: docNumber, issue_date: '2026-01-01', customer_id: customerId, modified, cache_source: 'api', ...overrides };
}

function line(docId: string, shipped = 0): Omit<ItemDocumentRow, 'id'> {
  return { doc_id: docId, item_id: itemId, document_item_id: lineId, quantity: 2, price: 10, quantity_shipped: shipped || null };
}

function patch(estimate: string, estimateModified: number, authorityId: string, authorityModified: number, shipped: number): OCShippingPatch {
  return { estimateId: estimate, estimateNumber: estimate === estimateId ? 1001 : 1002, estimateModified, customerId, associatedDocumentId: authorityId, sourceKind: 'invoice', authorityId, authorityModified, shippedPercent: 50, lines: [{ documentItemId: lineId, itemId, quantity: 2, quantityShipped: shipped }] };
}

function officialRun(): OfficialV3SyncRun { return { version: 1, runId: `run-${randomUUID()}`, accountIdentity: binding.accountIdentity, entry: { kind: 'since', value: '1' }, status: 'running', ingestionComplete: false, pageCount: 0, startedAt: 1, updatedAt: 1 }; }
function page(runId: string) { return { runId, page: 1, nextCursor: 'cursor', hasMore: false, markerCount: 1, responseHash: `sha256:${'a'.repeat(64)}` }; }
async function countPayments(pool: InstanceType<typeof Pool>, docId: string): Promise<number> { return Number((await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM payment_transactions WHERE doc_id = $1', [docId])).rows[0]?.count ?? 0); }
interface Context { schema: string; service: PostgresCacheService; pool: InstanceType<typeof Pool>; }
