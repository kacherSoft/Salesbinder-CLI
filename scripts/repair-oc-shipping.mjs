#!/usr/bin/env node
/**
 * Stage the explicit V2 shipping source for the OC cache repair.
 *
 * This operator deliberately has no database mutation path yet. `--stage` is
 * read-only against SalesBinder and writes a private, resumable source snapshot
 * that a separately reviewed dry-run/apply phase may consume.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresCacheService, createSalesBinderAccountBinding, loadConfig } from '../packages/sdk/dist/index.js';
import { createAxiosClient } from '../packages/sdk/dist/client/axios.factory.js';
import { DocumentsResource } from '../packages/sdk/dist/resources/documents.resource.js';
import { createV3AxiosClient } from '../packages/sdk/dist/client/v3-axios.factory.js';
import { V3DocumentsReadResource } from '../packages/sdk/dist/resources/v3-documents-read.resource.js';
import { createOcShippingPatch } from '../packages/sdk/dist/cache/oc-shipping-matcher.js';
import { applyOCShippingPatches } from '../packages/sdk/dist/cache/postgres-oc-shipping-bulk.store.js';
import { ocShippingProvenanceFor, parseOCShippingProvenance } from '../packages/sdk/dist/cache/postgres-oc-shipping.store.js';
import { normalizeV3OCShippingSourceDocument } from '../packages/sdk/dist/cache/oc-shipping-v3-normalizer.js';
import { hydrateOcShippingPatch } from '../packages/sdk/dist/cache/oc-shipping-hydrator.js';

export const ACCOUNT = 'phuthaitech';
export const STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v2-stage-phuthaitech.json';
export const PROGRESS_PATH = '/private/tmp/salesbinder-oc-shipping-v2-stage-phuthaitech.progress.json';
export const SALES_ORDER_STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v3-sales-orders-phuthaitech.json';
export const INVOICE_AUTHORITY_STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v3-authorities-phuthaitech.json';
export const LEGACY_EXCEPTION_STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v3-exceptions-phuthaitech.json';
export const EXCEPTION_STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v3-exceptions-v2-phuthaitech.json';
export const CONTEXTS = [4, 5];
export const CHECKPOINT_INTERVAL = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const report = (event, detail = {}) => console.error(JSON.stringify({ event, ...detail }));
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const uuid = (value) => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const integer = (value) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const timestamp = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
  : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Math.floor(Date.parse(value) / 1000) : null;

export function parseArguments(argv) {
  if (argv.length === 0 || argv.length === 1 && argv[0] === '--dry-run') return { mode: 'dry-run' };
  const args = new Set(argv);
  if (args.has('--stage')) {
    if (![...args].every((arg) => arg === '--stage' || arg === '--resume-stage')) throw new Error(usage());
    return { mode: 'stage', resume: args.has('--resume-stage') };
  }
  if (argv.length === 1 && argv[0] === '--stage-sales-orders') return { mode: 'stage-sales-orders' };
  if (argv.length === 1 && argv[0] === '--stage-v3-exceptions') return { mode: 'stage-v3-exceptions' };
  const backup = argv.indexOf('--backup-manifest');
  if (args.has('--apply') && args.has('--confirm-oc-shipping-repair') && backup >= 0 && backup + 1 < argv.length && argv.length === 4) {
    return { mode: 'apply', backupManifest: argv[backup + 1] };
  }
  throw new Error(usage());
}

export function sourceLine(value, documentId) {
  const line = record(value);
  const id = uuid(line?.id);
  const itemId = line?.item_id == null ? null : uuid(line.item_id);
  const quantity = finite(line?.quantity);
  const shippedObserved = Object.prototype.hasOwnProperty.call(line ?? {}, 'quantity_partially_shipped');
  const quantityShipped = shippedObserved && line.quantity_partially_shipped != null ? finite(line.quantity_partially_shipped) : null;
  if (!line || !id || line.document_id !== documentId || quantity == null || (line.item_id != null && !itemId) || (shippedObserved && line.quantity_partially_shipped != null && quantityShipped == null)) return null;
  // Service and discount lines are retained for source completeness but cannot
  // match an inventory cache line. Their legacy unit metadata is not an item scope.
  if (!itemId) return { id, itemId: null, variationLocationId: null, variationLocationObserved: false, unitId: null, unitObserved: false, quantity, quantityShipped, shippedObserved };
  const variationObserved = Object.prototype.hasOwnProperty.call(line, 'item_variations_location_id');
  const unitObserved = Object.prototype.hasOwnProperty.call(line, 'unit_id');
  const variationLocationId = line.item_variations_location_id == null ? null : integer(line.item_variations_location_id);
  const unitId = line.unit_id == null ? null : integer(line.unit_id);
  if ((line.item_variations_location_id != null && variationLocationId == null) || (line.unit_id != null && unitId == null)) return null;
  return { id, itemId, variationLocationId, variationLocationObserved: variationObserved, unitId, unitObserved, quantity, quantityShipped, shippedObserved };
}

/** Retain only shipping/link fields needed for a later reviewed cache plan. */
export function sourceDocument(value, expectedContextId) {
  const raw = record(value);
  const id = uuid(raw?.id);
  const contextId = integer(raw?.context_id);
  const documentNumber = integer(raw?.document_number);
  const customerId = uuid(raw?.customer_id);
  const modified = timestamp(raw?.modified);
  const shippedPercentObserved = Object.prototype.hasOwnProperty.call(raw ?? {}, 'shipped_percent');
  const shippedPercent = shippedPercentObserved && raw.shipped_percent != null ? finite(raw.shipped_percent) : null;
  if (!raw || !id || contextId !== expectedContextId || documentNumber == null || !customerId || modified == null || !shippedPercentObserved || (raw.shipped_percent != null && shippedPercent == null) || !Array.isArray(raw.document_items)) return null;
  const lines = raw.document_items.map((line) => sourceLine(line, id));
  if (lines.some((line) => line == null) || new Set(lines.map((line) => line.id)).size !== lines.length) return null;
  const rawAssociation = raw.associated_document_id;
  // The V2 estimate list uses both null and an empty string for an unconverted
  // estimate. Both mean "no relation"; neither is an invalid source link.
  const associatedDocumentId = rawAssociation == null || rawAssociation === '' ? null : uuid(rawAssociation);
  return {
    id, contextId, documentNumber, customerId, modified, shippedPercent, shippedPercentObserved,
    associatedDocumentId,
    unusableAssociatedDocumentId: rawAssociation != null && rawAssociation !== '' && associatedDocumentId == null,
    lines,
  };
}

export function parsePage(data, expectedPage, expectedPages, expectedCount) {
  const envelope = record(data);
  if (!envelope || !Array.isArray(envelope.documents)) throw new Error('V2 document list response is invalid.');
  const page = integer(envelope.page); const pages = integer(envelope.pages); const count = integer(envelope.count);
  if (page !== expectedPage || pages == null || pages < 1 || count == null ||
    (expectedPages != null && pages !== expectedPages) || (expectedCount != null && count !== expectedCount)) {
    throw new Error('V2 document pagination drift.');
  }
  const rows = envelope.documents.flat();
  if (!rows.every(record) || (expectedPage < pages && rows.length === 0)) throw new Error('V2 document list is incomplete.');
  return { page, pages, count, rows };
}

async function privateFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Private operator artifact is unsafe.');
    return true;
  } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function readPrivate(path) {
  if (!await privateFile(path)) return null;
  const handle = await open(path, 'r');
  try { return JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
}
async function writePrivate(path, value, exclusive) {
  if (exclusive && await privateFile(path)) throw new Error('Private operator artifact already exists; refusing to overwrite it.');
  if (!exclusive && !await privateFile(path)) throw new Error('Private operator checkpoint disappeared.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

function initialStage(accountIdentity) {
  return {
    version: 1, accountIdentity, source: 'salesbinder_v2_documents_list', coverage: 'active_list_only',
    archiveExcludedReason: 'V2 documents list response has no validated archived coverage parameter.',
    contexts: Object.fromEntries(CONTEXTS.map((contextId) => [contextId, { nextPage: 1, pages: null, count: null, documents: [] }])),
    complete: false,
  };
}
function validateStage(stage, accountIdentity) {
  if (!stage || stage.version !== 1 || stage.accountIdentity !== accountIdentity || !stage.contexts || stage.complete === true) throw new Error('Stage checkpoint is invalid or already complete.');
  for (const contextId of CONTEXTS) {
    const context = stage.contexts[contextId];
    if (!context || !Number.isSafeInteger(context.nextPage) || context.nextPage < 1 || !Array.isArray(context.documents)) throw new Error('Stage checkpoint is invalid.');
  }
  return stage;
}
function summary(stage) {
  const documents = CONTEXTS.flatMap((contextId) => stage.contexts[contextId].documents);
  return {
    documentCount: documents.length,
    lineCount: documents.reduce((total, document) => total + document.lines.length, 0),
    associatedCount: documents.filter((document) => document.associatedDocumentId).length,
    unusableAssociatedCount: documents.filter((document) => document.unusableAssociatedDocumentId).length,
    contexts: Object.fromEntries(CONTEXTS.map((contextId) => [contextId, {
      documentCount: stage.contexts[contextId].documents.length,
      sourceCount: stage.contexts[contextId].count,
      pages: stage.contexts[contextId].pages,
    }])),
  };
}

export async function stageSources(resource, accountIdentity, { resume = false } = {}) {
  if (await privateFile(STAGE_PATH)) throw new Error('Complete source stage already exists; retain it for the reviewed repair.');
  const existing = await readPrivate(PROGRESS_PATH);
  if (existing && !resume) throw new Error('An incomplete source stage exists; use --stage --resume-stage.');
  if (!existing && resume) throw new Error('No incomplete source stage exists to resume.');
  const stage = existing ? validateStage(existing, accountIdentity) : initialStage(accountIdentity);
  if (!existing) await writePrivate(PROGRESS_PATH, stage, true);
  for (const contextId of CONTEXTS) {
    const state = stage.contexts[contextId];
    for (let page = state.nextPage; state.pages == null || page <= state.pages; page += 1) {
      const response = await resource.list({ contextId, page, pageLimit: 100 });
      const parsed = parsePage(response, page, state.pages, state.count);
      state.pages ??= parsed.pages; state.count ??= parsed.count;
      const documents = parsed.rows.map((row) => sourceDocument(row, contextId));
      if (documents.some((document) => document == null) || new Set([...state.documents, ...documents].map((document) => document.id)).size !== state.documents.length + documents.length) throw new Error('V2 source document validation failed.');
      state.documents.push(...documents);
      state.nextPage = page + 1;
      if (page % CHECKPOINT_INTERVAL === 0 || page === state.pages) {
        await writePrivate(PROGRESS_PATH, stage, false);
        report('stage_checkpoint', { contextId, page, pages: state.pages, documents: state.documents.length });
      }
    }
    if (state.documents.length !== state.count) throw new Error('V2 source document count is incomplete.');
  }
  stage.complete = true;
  stage.completedAt = Math.floor(Date.now() / 1000);
  await writePrivate(PROGRESS_PATH, stage, false);
  await writePrivate(STAGE_PATH, stage, true);
  return summary(stage);
}

export async function stageSalesOrders(resource, binding) {
  if (await privateFile(SALES_ORDER_STAGE_PATH)) throw new Error('Sales Order source stage already exists; retain it for the reviewed repair.');
  const summaries = [];
  let pages = null; let total = null;
  for (let page = 1; pages == null || page <= pages; page += 1) {
    const result = await resource.listSalesOrders({ page, limit: 50 });
    const records = result.data;
    if (!Array.isArray(records) || (page < (pages ?? Infinity) && records.length === 0)) throw new Error('V3 Sales Order list is incomplete.');
    pages ??= result.pagination.total_pages; total ??= result.pagination.total_records;
    if (!Number.isSafeInteger(pages) || !Number.isSafeInteger(total) || pages < 1 || total < records.length || result.pagination.page !== page) throw new Error('V3 Sales Order pagination drift.');
    summaries.push(...records);
  }
  if (summaries.length !== total || new Set(summaries.map((row) => row.id)).size !== summaries.length) throw new Error('V3 Sales Order list is incomplete.');
  const salesOrders = [];
  for (const summary of summaries) salesOrders.push(normalizeV3OCShippingSourceDocument(await resource.getSalesOrder(summary.id), { id: summary.id, kind: 'sales_order' }));
  const stage = { version: 1, accountIdentity: binding.accountIdentity, source: 'salesbinder_v3_sales_orders', observedAt: Math.floor(Date.now() / 1000), salesOrders };
  await writePrivate(SALES_ORDER_STAGE_PATH, stage, true);
  return { salesOrderCount: salesOrders.length, stagePath: SALES_ORDER_STAGE_PATH };
}

export async function stageV3Exceptions(resource, binding, exceptionIds) {
  if (await privateFile(EXCEPTION_STAGE_PATH)) throw new Error('V3 exception stage already exists; retain it for the reviewed repair.');
  const requestIds = [...new Set(exceptionIds)].sort();
  const patches = []; const issues = {}; const outcomes = [];
  const port = { get: (contextId, id) => resource.get(contextId, id), getSalesOrder: (id) => resource.getSalesOrder(id) };
  for (const id of requestIds) {
    try {
      const hydrated = await hydrateOcShippingPatch(port, await resource.get(4, id));
      if (hydrated.patch && hydrated.issues.length === 0) {
        patches.push(hydrated.patch);
        outcomes.push({ estimateId: id, status: 'patch', patch: hydrated.patch });
      } else {
        const codes = hydrated.issues.map((issue) => issue.code);
        for (const code of codes) issues[code] = (issues[code] ?? 0) + 1;
        outcomes.push({ estimateId: id, status: 'issues', codes });
      }
    } catch (error) {
      const status = error?.response?.status;
      let code = 'invalid_record';
      if (status === 404) code = 'estimate_not_found';
      else if (error?.name === 'OCShippingContractError') code = 'invalid_record';
      else if (status === 401 || status === 403 || status >= 500 || status == null) throw error;
      issues[code] = (issues[code] ?? 0) + 1;
      outcomes.push({ estimateId: id, status: 'issues', codes: [code] });
    }
  }
  const stage = {
    version: 2,
    accountIdentity: binding.accountIdentity,
    source: 'salesbinder_v3_exception_details',
    observedAt: Math.floor(Date.now() / 1000),
    complete: true,
    requestedEstimateIds: requestIds,
    outcomeCount: outcomes.length,
    patches,
    issues,
    outcomes,
  };
  await writePrivate(EXCEPTION_STAGE_PATH, stage, true);
  return { requestedCount: requestIds.length, patchCount: patches.length, issueCounts: issues, stagePath: EXCEPTION_STAGE_PATH };
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function canonicalLine(line, { includeShipping = false } = {}) {
  if (!line.itemId) return null;
  return {
    documentItemId: line.id, itemId: line.itemId, quantity: line.quantity,
    ...(line.variationLocationObserved ? { itemVariationLocationId: line.variationLocationId } : {}),
    ...(line.unitObserved ? { unitId: line.unitId } : {}),
    ...(includeShipping && line.shippedObserved ? { quantityShipped: line.quantityShipped } : {}),
  };
}
function canonicalEstimate(source) {
  return {
    id: source.id, kind: 'estimate', number: source.documentNumber, modified: source.modified,
    customerId: source.customerId, lines: source.lines.map((line) => canonicalLine(line)).filter(Boolean),
    convertedDocument: { observed: true, value: null },
  };
}
function sourceSnapshot(stage, salesOrderStage = null, invoiceAuthorityStage = null) {
  if (stage?.version !== 1 || stage.source !== 'salesbinder_v2_documents_list' || stage.coverage !== 'active_list_only' || !stage.complete || stage.accountIdentity == null || !stage.contexts?.[4] || !stage.contexts?.[5]) throw new Error('Complete private V2 source stage is required.');
  const estimates = stage.contexts[4].documents;
  const invoices = stage.contexts[5].documents;
  if (!Array.isArray(estimates) || !Array.isArray(invoices) || new Set(estimates.map((row) => row.id)).size !== estimates.length || new Set(invoices.map((row) => row.id)).size !== invoices.length) throw new Error('Private V2 source stage is malformed.');
  if (salesOrderStage && (salesOrderStage.version !== 1 || salesOrderStage.source !== 'salesbinder_v3_sales_orders' || salesOrderStage.accountIdentity !== stage.accountIdentity || !Array.isArray(salesOrderStage.salesOrders))) throw new Error('Sales Order source stage account binding differs.');
  const invoiceIds = validDirectInvoiceAuthorityIds(estimates, invoices);
  const authorityInvoices = invoiceAuthoritySnapshot(invoiceAuthorityStage, invoiceIds, stage.accountIdentity);
  const salesOrders = salesOrderStage ? new Map(salesOrderStage.salesOrders.map((row) => [row.id, row])) : new Map();
  return { estimates, invoices: new Map(invoices.map((row) => [row.id, row])), authorityInvoices, salesOrders };
}

function validDirectInvoiceAuthorityIds(estimates, invoices) {
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  return [...new Set(estimates.flatMap((estimate) => {
    if (!estimate.associatedDocumentId) return [];
    const invoice = byId.get(estimate.associatedDocumentId);
    if (!invoice || invoice.associatedDocumentId !== estimate.id || invoice.customerId !== estimate.customerId) return [];
    return [invoice.id];
  }))].sort();
}

function invoiceAuthoritySnapshot(stage, expectedInvoiceIds, accountIdentity) {
  if (expectedInvoiceIds.length === 0) return new Map();
  if (stage?.version !== 1 || stage.source !== 'salesbinder_v3_invoice_authorities' || stage.complete !== true || stage.accountIdentity !== accountIdentity || !Array.isArray(stage.requestedIds) || !Array.isArray(stage.authorities) || !stage.outcomes) throw new Error('Complete V3 invoice authority stage is required.');
  const requested = [...stage.requestedIds].sort();
  if (requested.length !== expectedInvoiceIds.length || requested.some((id, index) => id !== expectedInvoiceIds[index]) || requested.some((id) => !uuid(id))) throw new Error('V3 invoice authority stage requested IDs differ from the current repair plan.');
  const outcomeList = Array.isArray(stage.outcomes)
    ? stage.outcomes
    : Object.entries(stage.outcomes).map(([invoiceId, outcome]) => ({ invoiceId, ...outcome }));
  const outcomeIds = outcomeList.map((outcome) => outcome?.invoiceId).sort();
  if (outcomeIds.length !== requested.length || outcomeIds.some((id, index) => id !== requested[index])) throw new Error('V3 invoice authority stage outcomes are incomplete.');
  const authorities = new Map();
  const authorityIds = new Set();
  for (const entry of stage.authorities) {
    if (!entry || !uuid(entry.id) || !validInvoiceAuthoritySource(entry.source, entry.id) || authorityIds.has(entry.id) || !requested.includes(entry.id)) throw new Error('V3 invoice authority entry is invalid.');
    authorityIds.add(entry.id);
    authorities.set(entry.id, entry.source);
  }
  const authorityOutcomeIds = new Set(outcomeList.filter((outcome) => outcome?.status === 'authority').map((outcome) => outcome.invoiceId));
  if (authorityOutcomeIds.size !== authorities.size || [...authorities.keys()].some((id) => !authorityOutcomeIds.has(id))) throw new Error('V3 invoice authority outcomes do not match authority entries.');
  for (const id of requested) {
    const outcome = outcomeList.find((entry) => entry.invoiceId === id);
    if (!outcome || !(outcome.status === 'authority' || outcome.status === 'issues' || typeof outcome.status === 'string' && outcome.status.startsWith('issue:'))) throw new Error('V3 invoice authority stage outcome identity is invalid.');
    if (outcome.status === 'authority' && !authorities.has(id)) throw new Error('V3 invoice authority outcome is invalid.');
    if (typeof outcome.status === 'string' && outcome.status.startsWith('issue:') && !['issue:invalid_record', 'issue:not_found', 'issue:source_client_error'].includes(outcome.status)) throw new Error('V3 invoice authority issue outcome is invalid.');
    if (outcome.status === 'issues' && (!Array.isArray(outcome.codes) || outcome.codes.length === 0 || !outcome.codes.every((code) => typeof code === 'string' && code.length > 0))) throw new Error('V3 invoice authority issue outcome is invalid.');
  }
  return authorities;
}

function validInvoiceAuthoritySource(source, id) {
  return source && source.id === id && source.kind === 'invoice' && uuid(source.customerId) &&
    Number.isSafeInteger(source.number) && source.number >= 0 &&
    Array.isArray(source.lines) && source.sourceEstimate &&
    typeof source.sourceEstimate === 'object' &&
    typeof source.sourceEstimate.observed === 'boolean' &&
    (source.shippedPercent === undefined || source.shippedPercent === null || typeof source.shippedPercent === 'number' && Number.isFinite(source.shippedPercent) && source.shippedPercent >= 0 && source.shippedPercent <= 100);
}
export async function cacheSnapshot(service) {
  const client = await service.pool.connect();
  try {
    const documents = await client.query(`SELECT doc_id, api_doc_id, context_id, doc_number, modified, customer_id, associated_document_id, shipped_percent FROM documents WHERE context_id IN (4, 5)`);
    const estimates = await client.query(`SELECT doc_id, api_doc_id, context_id, doc_number, modified, customer_id, associated_document_id, shipped_percent FROM documents WHERE context_id = 4`);
    const lines = await client.query(`SELECT doc_id, document_item_id, item_id, quantity, quantity_shipped FROM item_documents`);
    const byApiId = new Map(); const linesByDoc = new Map();
    for (const row of documents.rows) {
      if (row.api_doc_id) {
        if (byApiId.has(row.api_doc_id)) byApiId.set(row.api_doc_id, null); else byApiId.set(row.api_doc_id, row);
      }
    }
    for (const line of lines.rows) (linesByDoc.get(line.doc_id) ?? linesByDoc.set(line.doc_id, []).get(line.doc_id)).push(line);
    const provenanceResult = await client.query(`SELECT key, value FROM cache_meta WHERE starts_with(key, 'oc_shipping.v1:')`);
    return { byApiId, allCachedEstimates: estimates.rows, linesByDoc, provenance: new Map(provenanceResult.rows.map((row) => [row.key.slice('oc_shipping.v1:'.length), row.value])) };
  } finally { client.release(); }
}
function exactCacheLines(source, cached) {
  const expected = source.lines.filter((line) => line.itemId);
  if (cached.length !== expected.length) return false;
  return expected.every((line) => cached.filter((row) => row.document_item_id === line.id && row.item_id === line.itemId && Number(row.quantity) === line.quantity).length === 1);
}

function cacheRowsByApiId(rows) {
  const indexed = new Map();
  for (const row of rows) {
    if (!row.api_doc_id) continue;
    if (indexed.has(row.api_doc_id)) indexed.set(row.api_doc_id, null);
    else indexed.set(row.api_doc_id, row);
  }
  return indexed;
}

function emptyExclusions() {
  return {
    cachedOutsideActiveSource: 0,
    cachedMissingApiIdentity: 0,
    sourceIdentityUnknown: 0,
    cacheIdentityMismatch: 0,
    lineIdentityMismatch: 0,
    malformedAssociation: 0,
    authorityContractInvalid: 0,
    invoiceCustomerMismatch: 0,
    invoiceRelationUnverified: 0,
    salesOrderRelationUnverified: 0,
    authorityCacheNewer: 0,
  };
}

function exclusionTotal(exclusions) {
  return Object.values(exclusions).reduce((total, value) => total + value, 0);
}

function patchMatchesCache(patch, target, cache) {
  if ((target.associated_document_id ?? null) !== patch.associatedDocumentId) return false;
  const actualPercent = target.shipped_percent == null ? null : Number(target.shipped_percent);
  if (actualPercent !== patch.shippedPercent) return false;
  const patchLines = new Map(patch.lines.map((line) => [line.documentItemId, line]));
  for (const line of cache.linesByDoc.get(target.doc_id) ?? []) {
    const patchLine = line.document_item_id ? patchLines.get(line.document_item_id) : null;
    const expected = patchLine && patchLine.itemId === line.item_id && Number(line.quantity) === patchLine.quantity ? patchLine.quantityShipped : null;
    const actual = line.quantity_shipped == null ? null : Number(line.quantity_shipped);
    if (actual !== expected) return false;
  }
  const prior = cache.provenance.get(patch.estimateId);
  if (!prior) return false;
  try { return sameProvenance(parseOCShippingProvenance(prior), ocShippingProvenanceFor(patch)); }
  catch { return false; }
}

function sameProvenance(left, right) {
  return left.version === right.version &&
    left.estimateId === right.estimateId &&
    left.estimateModified === right.estimateModified &&
    left.sourceDocumentId === right.sourceDocumentId &&
    left.authorityId === right.authorityId &&
    left.authorityModified === right.authorityModified &&
    left.sourceKind === right.sourceKind;
}

function addPatchOrUnchanged(plan, patch, target, cache) {
  if (patchMatchesCache(patch, target, cache)) plan.unchanged += 1;
  else plan.patches.push(patch);
}

function authorityCacheNewer(cache, patch) {
  if (!patch.authorityId || patch.authorityModified == null) return false;
  const cachedAuthority = cache.byApiId.get(patch.authorityId);
  return !!cachedAuthority && Number(cachedAuthority.modified) > patch.authorityModified;
}

function patchOrExclude(exclude, estimateId, factory) {
  try { return factory(); }
  catch (error) {
    if (error?.name !== 'OCShippingContractError') throw error;
    exclude('authorityContractInvalid', estimateId, true);
    return null;
  }
}

/** Builds cache-first repair patches; every cached OC is accounted. */
export function buildPlan(stage, cache, salesOrderStage = null, invoiceAuthorityStage = null) {
  const { estimates, invoices, authorityInvoices, salesOrders } = sourceSnapshot(stage, salesOrderStage, invoiceAuthorityStage);
  const sourceById = new Map(estimates.map((estimate) => [estimate.id, estimate]));
  const estimateCacheByApiId = cacheRowsByApiId(cache.allCachedEstimates);
  const patches = []; const exceptionIds = []; const exclusions = emptyExclusions(); const exclusionByEstimateId = new Map();
  const plan = { patches, exclusions, exceptionIds, exclusionByEstimateId, unchanged: 0 };
  const exclude = (key, estimateId, exception = false) => {
    exclusions[key] += 1;
    if (estimateId) exclusionByEstimateId.set(estimateId, key);
    if (exception && estimateId) exceptionIds.push(estimateId);
  };
  for (const target of cache.allCachedEstimates) {
    if (!target.api_doc_id) { exclude('cachedMissingApiIdentity'); continue; }
    const estimate = sourceById.get(target.api_doc_id);
    if (!estimate) { exclude(estimateCacheByApiId.get(target.api_doc_id) === null ? 'sourceIdentityUnknown' : 'cachedOutsideActiveSource', target.api_doc_id); continue; }
    if (estimateCacheByApiId.get(target.api_doc_id) !== target || Number(target.context_id) !== 4 || Number(target.doc_number) !== estimate.documentNumber || target.customer_id !== estimate.customerId || Number(target.modified) > estimate.modified) { exclude('cacheIdentityMismatch', estimate.id); continue; }
    const lines = cache.linesByDoc.get(target.doc_id) ?? [];
    if (!exactCacheLines(estimate, lines)) { exclude('lineIdentityMismatch', estimate.id, true); continue; }
    if (estimate.unusableAssociatedDocumentId) { exclude('malformedAssociation', estimate.id, true); continue; }
    const canonical = canonicalEstimate(estimate);
    if (estimate.associatedDocumentId == null) { addPatchOrUnchanged(plan, createOcShippingPatch(canonical), target, cache); continue; }
    const v2Invoice = invoices.get(estimate.associatedDocumentId);
    if (!v2Invoice) {
      const salesOrder = salesOrders.get(estimate.associatedDocumentId);
      if (!salesOrder || salesOrder.customerId !== estimate.customerId || !salesOrder.sourceEstimate.observed || salesOrder.sourceEstimate.value == null || salesOrder.sourceEstimate.value.id !== estimate.id || salesOrder.sourceEstimate.value.estimateNumber !== estimate.documentNumber) { exclude('salesOrderRelationUnverified', estimate.id, true); continue; }
      canonical.convertedDocument.value = { id: salesOrder.id, kind: 'sales_order', number: salesOrder.number };
      const patch = patchOrExclude(exclude, estimate.id, () => createOcShippingPatch(canonical, salesOrder));
      if (!patch) continue;
      if (authorityCacheNewer(cache, patch)) { exclude('authorityCacheNewer', estimate.id); continue; }
      addPatchOrUnchanged(plan, patch, target, cache);
      continue;
    }
    if (v2Invoice.associatedDocumentId !== estimate.id) { exclude('invoiceRelationUnverified', estimate.id, true); continue; }
    if (v2Invoice.customerId !== estimate.customerId) { exclude('invoiceCustomerMismatch', estimate.id, true); continue; }
    const invoice = authorityInvoices.get(v2Invoice.id);
    if (!invoice || invoice.kind !== 'invoice' || invoice.customerId !== estimate.customerId || !invoice.sourceEstimate.observed || invoice.sourceEstimate.value == null || invoice.sourceEstimate.value.id !== estimate.id || invoice.sourceEstimate.value.estimateNumber !== estimate.documentNumber) { exclude('invoiceRelationUnverified', estimate.id, true); continue; }
    canonical.convertedDocument.value = { id: invoice.id, kind: 'invoice', number: invoice.number };
    let patch;
    if (invoice.fulfillmentAuthority === 'sales_order') {
      const salesOrder = invoice.fulfillmentSalesOrderId ? salesOrders.get(invoice.fulfillmentSalesOrderId) : null;
      if (!salesOrder) { exclude('salesOrderRelationUnverified', estimate.id, true); continue; }
      patch = patchOrExclude(exclude, estimate.id, () => createOcShippingPatch(canonical, invoice, salesOrder));
    } else if (invoice.fulfillmentAuthority === 'invoice') {
      patch = patchOrExclude(exclude, estimate.id, () => createOcShippingPatch(canonical, invoice));
    } else {
      exclude('invoiceRelationUnverified', estimate.id, true); continue;
    }
    if (!patch) continue;
    if (authorityCacheNewer(cache, patch)) { exclude('authorityCacheNewer', estimate.id); continue; }
    addPatchOrUnchanged(plan, patch, target, cache);
  }
  const cachedSourceIds = new Set(cache.allCachedEstimates.map((row) => row.api_doc_id).filter(Boolean));
  const sourceAbsentFromCache = estimates.filter((estimate) => !cachedSourceIds.has(estimate.id)).length;
  return {
    patches,
    exclusions,
    exceptionIds: [...new Set(exceptionIds)].sort(),
    exclusionByEstimateId,
    unchanged: plan.unchanged,
    accountIdentity: stage.accountIdentity,
    stagedEstimateCount: estimates.length,
    cachedEstimateCount: cache.allCachedEstimates.length,
    sourceAbsentFromCache,
    cachedExclusionTotal: exclusionTotal(exclusions),
    accountedCachedCount: patches.length + plan.unchanged + exclusionTotal(exclusions),
  };
}
export function mergeExceptionPatches(plan, exceptionStage, cache) {
  if (!exceptionStage) return { ...plan, exceptionApplied: 0, exceptionExcluded: 0, exceptionIssues: {} };
  validateExceptionStage(exceptionStage, plan.exceptionIds, plan.accountIdentity);
  const ids = new Set(plan.patches.map((patch) => patch.estimateId)); let accepted = 0; let excluded = 0;
  const currentExceptionIds = new Set(plan.exceptionIds);
  for (const patch of exceptionStage.patches) {
    if (!currentExceptionIds.has(patch.estimateId)) { excluded++; continue; }
    const target = cache.byApiId.get(patch.estimateId);
    const lines = target ? cache.linesByDoc.get(target.doc_id) ?? [] : [];
    const exact = target && Number(target.context_id) === 4 && Number(target.doc_number) === patch.estimateNumber && target.customer_id === patch.customerId && Number(target.modified) <= patch.estimateModified && patch.lines.length === lines.length && patch.lines.every((line) => lines.filter((row) => row.document_item_id === line.documentItemId && row.item_id === line.itemId && Number(row.quantity) === line.quantity).length === 1);
    if (!exact || ids.has(patch.estimateId) || authorityCacheNewer(cache, patch)) { excluded++; continue; }
    const old = plan.exclusionByEstimateId.get(patch.estimateId);
    if (old) plan.exclusions[old] -= 1;
    ids.add(patch.estimateId);
    addPatchOrUnchanged(plan, patch, target, cache);
    accepted++;
  }
  return {
    ...plan,
    exceptionApplied: accepted,
    exceptionExcluded: excluded,
    exceptionIssues: exceptionStage.issues ?? {},
    cachedExclusionTotal: exclusionTotal(plan.exclusions),
    accountedCachedCount: plan.patches.length + plan.unchanged + exclusionTotal(plan.exclusions),
  };
}

function validateExceptionStage(stage, expectedIds, accountIdentity) {
  if (stage.version !== 2 || stage.source !== 'salesbinder_v3_exception_details' || stage.complete !== true || !Array.isArray(stage.requestedEstimateIds) || !Array.isArray(stage.outcomes) || !Array.isArray(stage.patches) || !Number.isSafeInteger(stage.observedAt)) throw new Error('Complete V3 exception stage is required.');
  if (stage.accountIdentity !== accountIdentity) throw new Error('V3 exception stage account binding differs.');
  const requested = [...stage.requestedEstimateIds];
  if (requested.length !== new Set(requested).size || !requested.every(uuid)) throw new Error('V3 exception stage requested IDs are invalid.');
  if (!Array.isArray(expectedIds) || expectedIds.length !== new Set(expectedIds).size || !expectedIds.every(uuid)) throw new Error('Current repair exception IDs are invalid.');
  if (stage.outcomeCount !== requested.length || stage.outcomes.length !== requested.length) throw new Error('V3 exception stage outcomes are incomplete.');
  const seen = new Set();
  const patchIds = new Set(stage.patches.map((patch) => patch.estimateId));
  if (patchIds.size !== stage.patches.length || [...patchIds].some((id) => !requested.includes(id))) throw new Error('V3 exception stage patches are not bound to requested IDs.');
  const outcomePatchIds = new Set(stage.outcomes.filter((outcome) => outcome?.status === 'patch').map((outcome) => outcome.estimateId));
  if (outcomePatchIds.size !== patchIds.size || [...patchIds].some((id) => !outcomePatchIds.has(id))) throw new Error('V3 exception stage patch outcomes are invalid.');
  for (const outcome of stage.outcomes) {
    if (!outcome || !requested.includes(outcome.estimateId) || seen.has(outcome.estimateId) || !['patch', 'issues'].includes(outcome.status)) throw new Error('V3 exception stage outcome identity is invalid.');
    seen.add(outcome.estimateId);
    if (outcome.status === 'patch') {
      const patch = stage.patches.find((candidate) => candidate.estimateId === outcome.estimateId);
      if (!outcome.patch || !patch || !sameJson(outcome.patch, patch)) throw new Error('V3 exception stage patch outcome is invalid.');
    }
    if (outcome.status === 'issues' && (!Array.isArray(outcome.codes) || outcome.codes.length === 0 || !outcome.codes.every((code) => typeof code === 'string' && code.length > 0))) throw new Error('V3 exception stage issue outcome is invalid.');
  }
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function validateBackup(path, binding) {
  const manifest = await readPrivate(path);
  if (!manifest || manifest.disposableRestoreSucceeded !== true || manifest.restoredBindingMatches !== true || manifest.fullDecodeSucceeded !== true || manifest.containsCredentials !== false || manifest.containsDataValues !== false || typeof manifest.dumpFile !== 'string' || !Number.isSafeInteger(manifest.dumpBytes) || !/^[0-9a-f]{64}$/.test(manifest.dumpSha256 ?? '') || manifest.accountIdentitySha256 !== sha256(binding.accountIdentity) || manifest.accountSubdomainSha256 !== sha256(binding.accountSubdomain)) throw new Error('Verified external backup manifest is invalid.');
  const dumpPath = resolve(dirname(resolve(path)), manifest.dumpFile);
  const dump = await lstat(dumpPath);
  if (!dump.isFile() || dump.isSymbolicLink() || dump.size !== manifest.dumpBytes) throw new Error('Verified external backup dump is invalid.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(dumpPath)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.dumpSha256) throw new Error('Verified external backup dump checksum differs.');
}
async function writeBeforeImages(binding, plan, cache) {
  const rows = plan.patches.map((patch) => {
    const cacheDocument = cache.byApiId.get(patch.estimateId) ?? null;
    return { estimateId: patch.estimateId, patch, cacheDocument, cacheLines: cacheDocument ? cache.linesByDoc.get(cacheDocument.doc_id) ?? [] : [], priorProvenance: cache.provenance.get(patch.estimateId) ?? null };
  });
  const artifact = { version: 1, accountIdentity: binding.accountIdentity, createdAt: Math.floor(Date.now() / 1000), planHash: sha256(JSON.stringify(plan.patches)), rows };
  const path = '/private/tmp/salesbinder-oc-shipping-before-images-phuthaitech.json';
  await writePrivate(path, artifact, true);
  return path;
}

export async function runRepair(options, dependencies = {}) {
  if (!dependencies.service && !process.env.SALESBINDER_DB_URL) throw new Error('SALESBINDER_DB_URL is required.');
  const account = dependencies.account ?? loadConfig(ACCOUNT);
  const binding = dependencies.binding ?? createSalesBinderAccountBinding(account.subdomain);
  const service = dependencies.service ?? new PostgresCacheService(process.env.SALESBINDER_DB_URL);
  const readArtifact = dependencies.readPrivate ?? readPrivate;
  const readCache = dependencies.cacheSnapshot ?? cacheSnapshot;
  try {
    await service.verifyAccountBinding(binding);
    const stage = await readArtifact(STAGE_PATH);
    if (stage?.accountIdentity !== binding.accountIdentity) throw new Error('Source stage account binding differs.');
    const salesOrders = await readArtifact(SALES_ORDER_STAGE_PATH);
    const invoiceAuthorities = await readArtifact(INVOICE_AUTHORITY_STAGE_PATH);
    const exceptionStage = await readArtifact(EXCEPTION_STAGE_PATH);
    const legacyExceptionStageIgnored = !exceptionStage && !!(await readArtifact(LEGACY_EXCEPTION_STAGE_PATH));
    const cache = await readCache(service);
    const plan = mergeExceptionPatches(buildPlan(stage, cache, salesOrders, invoiceAuthorities), exceptionStage, cache);
    if (options.mode === 'dry-run') return dryRunResult(plan, legacyExceptionStageIgnored);
    if (plan.accountedCachedCount !== plan.cachedEstimateCount) throw new Error('OC shipping repair plan does not account for every cached OC.');
    await validateBackup(options.backupManifest, binding);
    const held = await service.tryAcquireSyncLock(`salesbinder-cache-oc-shipping-repair:${binding.accountIdentity}`);
    if (!held) throw new Error('Another cache writer is active.');
    try {
      const lockedCache = await readCache(service); const lockedPlan = mergeExceptionPatches(buildPlan(stage, lockedCache, salesOrders, invoiceAuthorities), exceptionStage, lockedCache);
      if (lockedPlan.accountedCachedCount !== lockedPlan.cachedEstimateCount) throw new Error('OC shipping repair plan does not account for every cached OC.');
      const beforePath = await writeBeforeImages(binding, lockedPlan, lockedCache);
      const result = await service.withVerifiedWrite(async (client) => {
        const total = { applied: 0, skippedMissing: 0, skippedStale: 0 };
        for (let index = 0; index < lockedPlan.patches.length; index += 1000) {
          const batch = await applyOCShippingPatches(client, lockedPlan.patches.slice(index, index + 1000));
          total.applied += batch.applied; total.skippedMissing += batch.skippedMissing; total.skippedStale += batch.skippedStale;
        }
        return total;
      });
      const verifiedCache = await readCache(service);
      const verifiedPlan = mergeExceptionPatches(buildPlan(stage, verifiedCache, salesOrders, invoiceAuthorities), exceptionStage, verifiedCache);
      return { mode: 'apply', ...result, attempted: lockedPlan.patches.length, exclusions: lockedPlan.exclusions, beforePath, postApply: dryRunResult(verifiedPlan, legacyExceptionStageIgnored) };
    } finally { await service.releaseSyncLock(`salesbinder-cache-oc-shipping-repair:${binding.accountIdentity}`).catch(() => undefined); }
  } finally { await service.close().catch(() => undefined); }
}

function dryRunResult(plan, legacyExceptionStageIgnored = false) {
  return {
    mode: 'dry_run',
    eligible: plan.patches.length,
    unchanged: plan.unchanged,
    exclusions: plan.exclusions,
    cachedExclusionTotal: plan.cachedExclusionTotal,
    accountedCachedCount: plan.accountedCachedCount,
    cacheAccountingComplete: plan.accountedCachedCount === plan.cachedEstimateCount,
    sourceAbsentFromCache: plan.sourceAbsentFromCache,
    exceptionApplied: plan.exceptionApplied,
    exceptionExcluded: plan.exceptionExcluded,
    exceptionIssues: plan.exceptionIssues,
    stagedEstimateCount: plan.stagedEstimateCount,
    cachedEstimateCount: plan.cachedEstimateCount,
    legacyExceptionStageIgnored,
  };
}

function usage() { return 'Usage: node --env-file=.env scripts/repair-oc-shipping.mjs [--dry-run | --stage [--resume-stage] | --stage-sales-orders | --stage-v3-exceptions | --apply --confirm-oc-shipping-repair --backup-manifest PATH]'; }
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!process.execArgv.includes('--env-file=.env')) throw new Error('Run with Node’s native --env-file=.env loader.');
  if (options.mode !== 'stage') {
    if (options.mode === 'stage-sales-orders') {
      const account = loadConfig(ACCOUNT); const binding = createSalesBinderAccountBinding(account.subdomain);
      if (!process.env.SALESBINDER_V3_API_KEY) throw new Error('SALESBINDER_V3_API_KEY is required.');
      report('sales_order_stage_complete', await stageSalesOrders(new V3DocumentsReadResource(createV3AxiosClient({ ...account, v3ApiKey: process.env.SALESBINDER_V3_API_KEY })), binding));
      return;
    }
    if (options.mode === 'stage-v3-exceptions') {
      const account = loadConfig(ACCOUNT); const binding = createSalesBinderAccountBinding(account.subdomain);
      if (!process.env.SALESBINDER_V3_API_KEY) throw new Error('SALESBINDER_V3_API_KEY is required.');
      const service = new PostgresCacheService(process.env.SALESBINDER_DB_URL);
      try {
        await service.verifyAccountBinding(binding);
        const stage = await readPrivate(STAGE_PATH); const salesOrders = await readPrivate(SALES_ORDER_STAGE_PATH); const invoiceAuthorities = await readPrivate(INVOICE_AUTHORITY_STAGE_PATH);
        const plan = buildPlan(stage, await cacheSnapshot(service), salesOrders, invoiceAuthorities);
        report('v3_exception_stage_complete', await stageV3Exceptions(new V3DocumentsReadResource(createV3AxiosClient({ ...account, v3ApiKey: process.env.SALESBINDER_V3_API_KEY })), binding, plan.exceptionIds));
      } finally { await service.close().catch(() => undefined); }
      return;
    }
    report('plan', await runRepair(options)); return;
  }
  const account = loadConfig(ACCOUNT);
  const identity = createSalesBinderAccountBinding(account.subdomain).accountIdentity;
  const result = await stageSources(new DocumentsResource(createAxiosClient(account)), identity, options);
  report('stage_complete', { ...result, coverage: 'active_list_only', stagePath: STAGE_PATH, progressPath: PROGRESS_PATH });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => { report('failed', { reason: 'validation_or_transport_failure' }); process.exitCode = 1; });
}
