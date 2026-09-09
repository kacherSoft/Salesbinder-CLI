import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  EXCEPTION_STAGE_PATH,
  INVOICE_AUTHORITY_STAGE_PATH,
  LEGACY_EXCEPTION_STAGE_PATH,
  SALES_ORDER_STAGE_PATH,
  STAGE_PATH,
  buildPlan,
  mergeExceptionPatches,
  parseArguments,
  parsePage,
  runRepair,
  sourceDocument,
  sourceLine,
  validateBackup,
} from './repair-oc-shipping.mjs';

const id = 'c40e5d25-c573-48ec-aa46-9737eddf2513';
const customer = 'c40e5d25-c573-48ec-aa46-9737eddf2514';
const lineId = 'c40e5d25-c573-48ec-aa46-9737eddf2515';
const itemId = 'c40e5d25-c573-48ec-aa46-9737eddf2516';
const invoiceId = 'c40e5d25-c573-48ec-aa46-9737eddf2517';
const outsideId = 'c40e5d25-c573-48ec-aa46-9737eddf2518';
const sourceOnlyId = 'c40e5d25-c573-48ec-aa46-9737eddf2519';
function document(patch = {}) { return { id, context_id: 4, document_number: 12, customer_id: customer, modified: '2026-09-09T00:00:00Z', shipped_percent: 25, associated_document_id: null, document_items: [{ id: lineId, document_id: id, item_id: itemId, item_variations_location_id: 9, unit_id: 7, quantity: 3, quantity_partially_shipped: 1 }], ...patch }; }
function stage(documents, invoices = []) { return { version: 1, source: 'salesbinder_v2_documents_list', coverage: 'active_list_only', complete: true, accountIdentity: 'salesbinder:test', contexts: { 4: { documents }, 5: { documents: invoices } } }; }
function row(patch = {}) { return { doc_id: `cache-${patch.api_doc_id ?? id ?? randomUUID()}`, api_doc_id: id, context_id: 4, doc_number: 12, customer_id: customer, modified: 1788912000, associated_document_id: null, shipped_percent: null, ...patch }; }
function cache(rows, lines = new Map(rows.filter((value) => value.api_doc_id === id).map((value) => [value.doc_id, [{ document_item_id: lineId, item_id: itemId, quantity: 3, quantity_shipped: null }]]))) {
  return { byApiId: new Map(rows.filter((value) => value.api_doc_id).map((value) => [value.api_doc_id, value])), allCachedEstimates: rows, linesByDoc: lines, provenance: new Map() };
}
function patch(estimateId = id) { return { estimateId, estimateNumber: 12, estimateModified: 1788912000, customerId: customer, associatedDocumentId: invoiceId, sourceKind: 'invoice', authorityId: invoiceId, authorityModified: 1788912000, shippedPercent: 25, lines: [{ documentItemId: lineId, itemId, quantity: 3, quantityShipped: 1 }] }; }
function v2Invoice(patch = {}) { return sourceDocument(document({ id: invoiceId, context_id: 5, document_number: 44, associated_document_id: id, document_items: [{ id: outsideId, document_id: invoiceId, item_id: itemId, item_variations_location_id: 9, unit_id: 7, quantity: 3, quantity_partially_shipped: 99 }], ...patch }), 5); }
function v3InvoiceAuthority(patch = {}) {
  const source = { id: invoiceId, kind: 'invoice', number: 44, modified: 1788912000, customerId: customer, lines: [{ documentItemId: outsideId, itemId, quantity: 3, itemVariationLocationId: 9, unitId: 7, quantityShipped: 0 }], sourceEstimate: { observed: true, value: { id, estimateNumber: 12 } }, shippedPercent: 0, fulfillmentAuthority: 'invoice', fulfillmentSalesOrderId: null, ...patch };
  return { version: 1, source: 'salesbinder_v3_invoice_authorities', accountIdentity: 'salesbinder:test', complete: true, selectedAt: 1, completedAt: 1, requestedIds: [invoiceId], authorities: [{ id: invoiceId, source }], outcomes: [{ invoiceId, status: 'authority' }] };
}

test('normalizes only validated V2 shipping/link source fields', () => {
  assert.deepEqual(sourceDocument(document(), 4), { id, contextId: 4, documentNumber: 12, customerId: customer, modified: 1788912000, shippedPercent: 25, shippedPercentObserved: true, associatedDocumentId: null, unusableAssociatedDocumentId: false, lines: [{ id: lineId, itemId, variationLocationId: 9, variationLocationObserved: true, unitId: 7, unitObserved: true, quantity: 3, quantityShipped: 1, shippedObserved: true }] });
  assert.equal(sourceDocument(document({ context_id: 5 }), 4), null);
  assert.equal(sourceDocument(document({ document_items: [{ ...document().document_items[0], document_id: customer }] }), 4), null);
  assert.equal(sourceDocument(document({ associated_document_id: '' }), 4)?.unusableAssociatedDocumentId, false);
  assert.equal(sourceDocument(document({ associated_document_id: 'not-a-uuid' }), 4)?.unusableAssociatedDocumentId, true);
});

test('rejects malformed source lines and unstable V2 pagination', () => {
  assert.equal(sourceLine({ id: lineId, document_id: customer, item_id: itemId, quantity: 1 }, id), null);
  assert.equal(sourceDocument(document({ shipped_percent: '' }), 4), null);
  assert.deepEqual(sourceLine({ id: lineId, document_id: id, item_id: null, unit_id: 7, quantity: 1 }, id), { id: lineId, itemId: null, variationLocationId: null, variationLocationObserved: false, unitId: null, unitObserved: false, quantity: 1, quantityShipped: null, shippedObserved: false });
  assert.deepEqual(parsePage({ page: '1', pages: '1', count: '1', documents: [[document()]] }, 1), { page: 1, pages: 1, count: 1, rows: [document()] });
  assert.throws(() => parsePage({ page: 2, pages: 2, count: 1, documents: [[document()]] }, 1), /pagination drift/);
  assert.throws(() => parsePage({ page: 1, pages: 2, count: 2, documents: [[]] }, 1), /incomplete/);
});

test('accepts only guarded operator commands', () => {
  assert.deepEqual(parseArguments(['--stage']), { mode: 'stage', resume: false });
  assert.deepEqual(parseArguments(['--stage', '--resume-stage']), { mode: 'stage', resume: true });
  assert.deepEqual(parseArguments([]), { mode: 'dry-run' });
  assert.deepEqual(parseArguments(['--apply', '--confirm-oc-shipping-repair', '--backup-manifest', '/private/tmp/manifest.json']), { mode: 'apply', backupManifest: '/private/tmp/manifest.json' });
  assert.throws(() => parseArguments(['--apply']), /Usage/);
});

test('plans only exact cache identity and line fences', () => {
  const source = sourceDocument(document(), 4);
  const cached = row({ doc_id: 'cache-doc' });
  const snapshot = cache([cached]);
  assert.equal(buildPlan(stage([source]), snapshot).patches.length, 1);
  assert.equal(buildPlan(stage([source]), cache([{ ...cached, customer_id: id }])).exclusions.cacheIdentityMismatch, 1);
  assert.equal(buildPlan(stage([source]), { ...snapshot, linesByDoc: new Map([['cache-doc', []]]) }).exclusions.lineIdentityMismatch, 1);
});

test('accounts for every cached OC and keeps source-only absence separate', () => {
  const source = sourceDocument(document(), 4);
  const sourceOnly = sourceDocument(document({ id: sourceOnlyId, document_number: 13, document_items: [{ ...document().document_items[0], id: sourceOnlyId, document_id: sourceOnlyId }] }), 4);
  const rows = [row(), row({ doc_id: 'outside', api_doc_id: outsideId }), row({ doc_id: 'missing-api', api_doc_id: null })];
  const plan = buildPlan(stage([source, sourceOnly]), cache(rows));
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.exclusions.cachedOutsideActiveSource, 1);
  assert.equal(plan.exclusions.cachedMissingApiIdentity, 1);
  assert.equal(plan.sourceAbsentFromCache, 1);
  assert.equal(plan.accountedCachedCount, 3);
  assert.equal(plan.cachedEstimateCount, 3);
});

test('excludes malformed non-empty V2 associations instead of treating them as unconverted', () => {
  const source = sourceDocument(document({ associated_document_id: 'not-a-uuid' }), 4);
  const plan = buildPlan(stage([source]), cache([row()]));
  assert.equal(plan.patches.length, 0);
  assert.equal(plan.exclusions.malformedAssociation, 1);
  assert.equal(plan.accountedCachedCount, 1);
});

test('rejects source stages whose account-bound companion stages mismatch', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  assert.throws(() => buildPlan(stage([source]), cache([row()]), { version: 1, source: 'salesbinder_v3_sales_orders', accountIdentity: 'salesbinder:other', salesOrders: [] }), /account binding differs/);
});

test('uses V3 direct invoice authorities for shipping values and requires their stage', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  const invoice = v2Invoice();
  assert.throws(() => buildPlan(stage([source], [invoice]), cache([row()])), /Complete V3 invoice authority stage/);
  const plan = buildPlan(stage([source], [invoice]), cache([row()]), null, v3InvoiceAuthority());
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.patches[0].shippedPercent, 0);
  assert.equal(plan.patches[0].lines[0].quantityShipped, 0);
});

test('selects reciprocal same-customer V2 invoices even when V2 shipping header is invalid', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  const invoice = v2Invoice({ shipped_percent: 150 });
  const plan = buildPlan(stage([source], [invoice]), cache([row()]), null, v3InvoiceAuthority());
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.exclusions.invoiceRelationUnverified, 0);
  assert.equal(plan.accountedCachedCount, 1);
});

test('rejects authority-stage contradictions and excludes contract-invalid authorities', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  const invoice = v2Invoice();
  assert.throws(() => buildPlan(stage([source], [invoice]), cache([row()]), null, { ...v3InvoiceAuthority(), outcomes: [{ invoiceId, status: 'issue:invalid_record' }] }), /outcomes do not match/);
  assert.throws(() => buildPlan(stage([source], [invoice]), cache([row()]), null, { ...v3InvoiceAuthority(), authorities: [], outcomes: [{ invoiceId, status: 'issue:unknown' }] }), /issue outcome is invalid/);
  const invalidAuthority = v3InvoiceAuthority({ lines: [{ documentItemId: outsideId, itemId, quantity: 3, itemVariationLocationId: 9, unitId: 7, quantityShipped: 4 }] });
  const plan = buildPlan(stage([source], [invoice]), cache([row()]), null, invalidAuthority);
  assert.equal(plan.patches.length, 0);
  assert.equal(plan.exclusions.authorityContractInvalid, 1);
  assert.equal(plan.accountedCachedCount, 1);
});

test('accepted exception patch reduces its original exclusion and preserves denominator accounting', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  const initial = buildPlan(stage([source]), cache([row()]));
  assert.equal(initial.exclusions.salesOrderRelationUnverified, 1);
  const exception = { version: 2, accountIdentity: 'salesbinder:test', source: 'salesbinder_v3_exception_details', observedAt: 1788912000, complete: true, requestedEstimateIds: [id], outcomeCount: 1, patches: [patch()], issues: {}, outcomes: [{ estimateId: id, status: 'patch', patch: patch() }] };
  const merged = mergeExceptionPatches(initial, exception, cache([row()]));
  assert.equal(merged.patches.length, 1);
  assert.equal(merged.exceptionApplied, 1);
  assert.equal(merged.exclusions.salesOrderRelationUnverified, 0);
  assert.equal(merged.accountedCachedCount, 1);
});

test('validated old exception patches do not override rows resolved by canonical authority', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  const invoice = v2Invoice({ shipped_percent: 150 });
  const cached = row({ associated_document_id: invoiceId, shipped_percent: 0 });
  const snapshot = cache([cached], new Map([[cached.doc_id, [{ document_item_id: lineId, item_id: itemId, quantity: 3, quantity_shipped: 0 }]]]));
  snapshot.provenance.set(id, JSON.stringify({ sourceKind: 'invoice', authorityModified: 1788912000, authorityId: invoiceId, sourceDocumentId: invoiceId, estimateModified: 1788912000, estimateId: id, version: 1 }));
  const initial = buildPlan(stage([source], [invoice]), snapshot, null, v3InvoiceAuthority());
  assert.equal(initial.unchanged, 1);
  assert.deepEqual(initial.exceptionIds, []);
  const exception = { version: 2, accountIdentity: 'salesbinder:test', source: 'salesbinder_v3_exception_details', observedAt: 1788912000, complete: true, requestedEstimateIds: [id], outcomeCount: 1, patches: [patch()], issues: {}, outcomes: [{ estimateId: id, status: 'patch', patch: patch() }] };
  const merged = mergeExceptionPatches(initial, exception, snapshot);
  assert.equal(merged.patches.length, 0);
  assert.equal(merged.unchanged, 1);
  assert.equal(merged.exceptionApplied, 0);
  assert.equal(merged.exceptionExcluded, 1);
  assert.equal(merged.accountedCachedCount, 1);
});

test('rejects incomplete or wrong-account V3 exception stages', () => {
  const source = sourceDocument(document({ associated_document_id: invoiceId }), 4);
  const initial = buildPlan(stage([source]), cache([row()]));
  assert.throws(() => mergeExceptionPatches(initial, { version: 1, patches: [patch()] }, cache([row()])), /Complete V3 exception stage/);
  assert.throws(() => mergeExceptionPatches(initial, { version: 2, accountIdentity: 'salesbinder:other', source: 'salesbinder_v3_exception_details', observedAt: 1, complete: true, requestedEstimateIds: [id], outcomeCount: 1, patches: [], issues: {}, outcomes: [{ estimateId: id, status: 'issues', codes: ['invalid_record'] }] }, cache([row()])), /account binding differs/);
  assert.throws(() => mergeExceptionPatches(initial, { version: 2, accountIdentity: 'salesbinder:test', source: 'salesbinder_v3_exception_details', observedAt: 1, complete: true, requestedEstimateIds: [id], outcomeCount: 1, patches: [patch(outsideId)], issues: {}, outcomes: [{ estimateId: id, status: 'issues', codes: ['invalid_record'] }] }, cache([row()])), /patches are not bound/);
  assert.throws(() => mergeExceptionPatches(initial, { version: 2, accountIdentity: 'salesbinder:test', source: 'salesbinder_v3_exception_details', observedAt: 1, complete: true, requestedEstimateIds: [id], outcomeCount: 1, patches: [patch()], issues: {}, outcomes: [{ estimateId: id, status: 'issues', codes: ['invalid_record'] }] }, cache([row()])), /patch outcomes are invalid/);
});

test('detects unchanged rows with reordered PostgreSQL jsonb provenance text', () => {
  const source = sourceDocument(document(), 4);
  const cached = row();
  const snapshot = cache([cached]);
  snapshot.provenance.set(id, JSON.stringify({ sourceKind: 'none', authorityModified: null, authorityId: null, sourceDocumentId: null, estimateModified: 1788912000, estimateId: id, version: 1 }));
  const plan = buildPlan(stage([source]), snapshot);
  assert.equal(plan.patches.length, 0);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.accountedCachedCount, 1);
});

test('validates backup restore flags, account binding, and dump checksum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-backup-test-'));
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dumpFile = join(dir, 'dump.bin');
    await writeFile(dumpFile, 'verified dump\n');
    await chmod(dumpFile, 0o600);
    const dumpSha256 = createHash('sha256').update('verified dump\n').digest('hex');
    const binding = { accountIdentity: 'salesbinder:test', accountSubdomain: 'test' };
    const manifest = {
      disposableRestoreSucceeded: true,
      restoredBindingMatches: true,
      fullDecodeSucceeded: true,
      containsCredentials: false,
      containsDataValues: false,
      dumpFile,
      dumpBytes: 14,
      dumpSha256,
      accountIdentitySha256: createHash('sha256').update(binding.accountIdentity).digest('hex'),
      accountSubdomainSha256: createHash('sha256').update(binding.accountSubdomain).digest('hex'),
    };
    const manifestFile = join(dir, 'manifest.json');
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await chmod(manifestFile, 0o600);
    await validateBackup(manifestFile, binding);
    await writeFile(manifestFile, `${JSON.stringify({ ...manifest, fullDecodeSucceeded: false })}\n`);
    await assert.rejects(() => validateBackup(manifestFile, binding), /backup manifest is invalid/);
    await writeFile(manifestFile, `${JSON.stringify({ ...manifest, dumpSha256: `${'0'.repeat(64)}` })}\n`);
    await assert.rejects(() => validateBackup(manifestFile, binding), /checksum differs/);
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(() => validateBackup(manifestFile, { ...binding, accountIdentity: 'salesbinder:other' }), /backup manifest is invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dry-run does not enter backup, lock, or write paths', async () => {
  const source = sourceDocument(document(), 4);
  const snapshot = cache([row()]);
  const calls = [];
  const service = {
    verifyAccountBinding: async () => calls.push('verify'),
    tryAcquireSyncLock: async () => { calls.push('lock'); return true; },
    withVerifiedWrite: async () => { calls.push('write'); throw new Error('write path reached'); },
    releaseSyncLock: async () => calls.push('release'),
    close: async () => calls.push('close'),
  };
  const result = await runRepair({ mode: 'dry-run' }, {
    account: { subdomain: 'test' },
    binding: { accountIdentity: 'salesbinder:test', accountSubdomain: 'test' },
    service,
    readPrivate: async (path) => path === STAGE_PATH ? stage([source]) : path === LEGACY_EXCEPTION_STAGE_PATH ? { version: 1 } : null,
    cacheSnapshot: async () => snapshot,
  });
  assert.equal(result.eligible, 1);
  assert.equal(result.cacheAccountingComplete, true);
  assert.equal(result.legacyExceptionStageIgnored, true);
  assert.deepEqual(calls, ['verify', 'close']);
  assert.equal(EXCEPTION_STAGE_PATH.endsWith('exceptions-v2-phuthaitech.json'), true);
  assert.equal(SALES_ORDER_STAGE_PATH.endsWith('sales-orders-phuthaitech.json'), true);
  assert.equal(INVOICE_AUTHORITY_STAGE_PATH.endsWith('authorities-phuthaitech.json'), true);
});
