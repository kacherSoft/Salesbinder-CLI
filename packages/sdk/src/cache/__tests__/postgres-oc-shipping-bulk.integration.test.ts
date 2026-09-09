import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresCacheService } from '../postgres-cache.service.js';
import { createSalesBinderAccountBinding } from '../types.js';
import type { OCShippingPatch } from '../oc-shipping.types.js';

const { Pool } = pg;
const testUrl = process.env.SALESBINDER_OC_SHIPPING_TEST_DB_URL;
const describeIfPostgres = testUrl ? describe : describe.skip;
const binding = createSalesBinderAccountBinding('oc-shipping-bulk-test');
const customer = '90b266c8-628f-48ce-a83c-21013cb740f6';
const item = '05c86ce5-c234-438b-9908-f518e42d42e4';
const estimateA = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const estimateB = 'a40e5d25-c573-48ec-aa46-9737eddf2513';
const invoiceA = 'b40e5d25-c573-48ec-aa46-9737eddf2513';
const invoiceB = 'd40e5d25-c573-48ec-aa46-9737eddf2513';
const lineA = 'f60d6f78-7550-4ef0-bcbe-3e0ac367aa58';
const lineB = 'e60d6f78-7550-4ef0-bcbe-3e0ac367aa58';
let baseUrl = ''; let admin: InstanceType<typeof Pool> | undefined; const contexts: Context[] = [];

describeIfPostgres('PostgreSQL OC shipping bulk persistence', () => {
  beforeAll(() => { baseUrl = guardedUrl(); admin = new Pool({ connectionString: baseUrl }); });
  afterEach(async () => { while (contexts.length) await cleanup(contexts.pop()); });
  afterAll(async () => { await admin?.end().catch(() => undefined); });

  it('matches sequential results and reports missing/stale work without per-patch writes', async () => {
    const sequential = await context('sequential'); const bulk = await context('bulk');
    for (const ctx of [sequential, bulk]) { await seed(ctx, estimateA, 1001, lineA); await seed(ctx, estimateB, 1002, lineB); }
    const patches = [patch(estimateA, 1001, invoiceA, lineA, 2), patch(estimateB, 1002, invoiceB, lineB, 1)];
    for (const value of patches) await sequential.service.applyOCShippingPatch(value);
    await expect(bulk.service.applyOCShippingPatches(patches)).resolves.toEqual({ applied: 2, skippedMissing: 0, skippedStale: 0 });
    await expect(snapshot(bulk)).resolves.toEqual(await snapshot(sequential));

    await bulk.service.applyOCShippingPatch(patch(estimateA, 1001, invoiceA, lineA, 1, 30));
    const stale = patch(estimateA, 1001, invoiceA, lineA, 0, 29);
    const missing = patch('f40e5d25-c573-48ec-aa46-9737eddf2513', 1003, invoiceB, lineB, 1);
    await expect(bulk.service.applyOCShippingPatches([stale, missing])).resolves.toEqual({ applied: 0, skippedMissing: 1, skippedStale: 1 });
  });

  it('rolls back documents, shipping values, provenance, and payments when a set write fails', async () => {
    const ctx = await context('rollback'); await seed(ctx, estimateA, 1001, lineA); await payment(ctx, estimateA);
    await ctx.pool.query(`CREATE FUNCTION fail_bulk_oc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fail_bulk_oc'; END; $$`);
    await ctx.pool.query(`CREATE TRIGGER fail_bulk_oc BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION fail_bulk_oc()`);
    await expect(ctx.service.applyOCShippingPatches([patch(estimateA, 1001, invoiceA, lineA, 2)])).rejects.toThrow('fail_bulk_oc');
    await expect(ctx.service.getDocument(estimateA)).resolves.toMatchObject({ shipped_percent: null, associated_document_id: null });
    await expect(ctx.service.getItemDocuments(estimateA)).resolves.toEqual([expect.objectContaining({ quantity_shipped: null })]);
    await expect(meta(ctx, estimateA)).resolves.toBeNull(); await expect(payments(ctx, estimateA)).resolves.toBe(1);
  });

  it('clears duplicate cached exact line identities instead of inventing an allocation', async () => {
    const ctx = await context('duplicate-line'); await seed(ctx, estimateA, 1001, lineA);
    await ctx.service.insertItemDocument({ doc_id: estimateA, item_id: item, document_item_id: lineA, quantity: 2, price: 10, quantity_shipped: 1 });
    await expect(ctx.service.applyOCShippingPatches([patch(estimateA, 1001, invoiceA, lineA, 2)])).resolves.toEqual({ applied: 1, skippedMissing: 0, skippedStale: 0 });
    await expect(ctx.service.getItemDocuments(estimateA)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ document_item_id: lineA, quantity_shipped: null }),
      expect.objectContaining({ document_item_id: lineA, quantity_shipped: null }),
    ]));
  });

  it('publishes a representative multi-record batch as one bounded operation', async () => {
    const ctx = await context('representative-batch');
    const patches: OCShippingPatch[] = [];
    for (let index = 0; index < 64; index++) {
      const estimate = randomUUID(); const authority = randomUUID(); const line = randomUUID();
      await seed(ctx, estimate, 2000 + index, line);
      patches.push(patch(estimate, 2000 + index, authority, line, index % 3));
    }
    await expect(ctx.service.applyOCShippingPatches(patches)).resolves.toEqual({ applied: 64, skippedMissing: 0, skippedStale: 0 });
    await expect(ctx.pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM cache_meta WHERE starts_with(key, $1)', ['oc_shipping.v1:'])).resolves.toMatchObject({ rows: [{ count: '64' }] });
  });
});

function guardedUrl(): string { if (!testUrl) throw new Error('missing test URL'); const url = new URL(testUrl); if (!['localhost','127.0.0.1'].includes(url.hostname) || !/test|integration/i.test(url.pathname)) throw new Error('isolated localhost test DB required'); return url.toString(); }
async function context(label: string): Promise<Context> { if (!admin) throw new Error('admin unavailable'); const schema = `oc_bulk_${label}_${randomUUID().replaceAll('-','_')}`; await admin.query(`CREATE SCHEMA "${schema}"`); const url = new URL(baseUrl); url.searchParams.set('options', `-c search_path=${schema}`); const service = new PostgresCacheService(url.toString()); const pool = new Pool({connectionString:url.toString()}); const value={schema,service,pool}; contexts.push(value); await service.ensureAccountBinding(binding); return value; }
async function cleanup(ctx: Context | undefined) { if (!ctx || !admin) return; await ctx.service.close().catch(()=>undefined); await ctx.pool.end().catch(()=>undefined); await admin.query(`DROP SCHEMA IF EXISTS "${ctx.schema}" CASCADE`).catch(()=>undefined); }
async function seed(ctx: Context, id: string, number: number, line: string) { await ctx.service.insertDocument({doc_id:id,api_doc_id:id,context_id:4,doc_number:number,issue_date:'2026-01-01',customer_id:customer,modified:20,cache_source:'api'}); await ctx.service.insertItemDocument({doc_id:id,item_id:item,document_item_id:line,quantity:2,price:10,quantity_shipped:null}); }
function patch(id:string, number:number, authority:string,line:string,shipped:number,authorityModified=30): OCShippingPatch { return {estimateId:id,estimateNumber:number,estimateModified:20,customerId:customer,associatedDocumentId:authority,sourceKind:'invoice',authorityId:authority,authorityModified,shippedPercent:50,lines:[{documentItemId:line,itemId:item,quantity:2,quantityShipped:shipped}]}; }
async function snapshot(ctx: Context) { return Promise.all([ctx.service.getDocument(estimateA),ctx.service.getDocument(estimateB),ctx.service.getItemDocuments(estimateA),ctx.service.getItemDocuments(estimateB),meta(ctx,estimateA),meta(ctx,estimateB)]); }
async function meta(ctx: Context,id:string) { const result=await ctx.pool.query<{value:string}>('SELECT value FROM cache_meta WHERE key = $1',[`oc_shipping.v1:${id}`]); return result.rows[0] ? JSON.parse(result.rows[0].value) : null; }
async function payment(ctx: Context,id:string) { await ctx.pool.query(`INSERT INTO payment_transactions(transaction_id,doc_id,amount,transaction_date,imported_at) VALUES($1,$2,1,'2026-01-01',1)`,[randomUUID(),id]); }
async function payments(ctx: Context,id:string) { return Number((await ctx.pool.query<{count:string}>('SELECT COUNT(*) AS count FROM payment_transactions WHERE doc_id=$1',[id])).rows[0]?.count ?? 0); }
interface Context { schema:string; service:PostgresCacheService; pool:InstanceType<typeof Pool>; }
