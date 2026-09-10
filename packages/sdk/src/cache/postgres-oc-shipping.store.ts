import type { PoolClient } from 'pg';
import type { OCShippingPatch } from './oc-shipping.types.js';
export type { OCShippingPatch } from './oc-shipping.types.js';

interface ShippingProvenance {
  version: 1;
  estimateId: string;
  estimateModified: number;
  sourceDocumentId: string | null;
  authorityId: string | null;
  authorityModified: number | null;
  sourceKind: OCShippingPatch['sourceKind'];
}
export type OCShippingProvenance = Readonly<ShippingProvenance>;
export type OCShippingPatchApplication = 'applied' | 'skipped_missing' | 'skipped_stale';

export interface OCShippingReconciliationStatus {
  version: 1;
  accountIdentity: string;
  status: 'running' | 'success' | 'success_with_warnings' | 'failed';
  startedAt: number;
  updatedAt: number;
  lastSuccessAt?: number;
  finishedAt?: number;
  scanned: number;
  applied: number;
  failed: number;
  errorCode?: string;
}

const keyFor = (estimateId: string): string => `oc_shipping.v1:${estimateId}`;
const PREFIX = 'oc_shipping.v1:';
const RECONCILIATION_STATUS_KEY = 'oc_shipping.reconciliation_status.v1';

/**
 * Applies a fully hydrated OC patch only to the exact cached OC revision and
 * exact line identities.  It never derives allocations from item IDs alone.
 */
export async function applyOCShippingPatch(
  client: PoolClient,
  patch: OCShippingPatch
): Promise<OCShippingPatchApplication> {
  assertOCShippingPatch(patch);
  const row = await client.query<{
    doc_id: string;
    api_doc_id: string | null;
    context_id: number;
    doc_number: number;
    modified: string | number;
    customer_id: string | null;
  }>(
    `SELECT doc_id, api_doc_id, context_id, doc_number, modified, customer_id
     FROM documents WHERE api_doc_id = $1 FOR UPDATE`,
    [patch.estimateId]
  );
  // Invoice-first ordering is normal. The estimate task will apply its current patch later.
  if (row.rows.length === 0) return 'skipped_missing';
  const estimate = row.rows[0]!;
  if (
    estimate.api_doc_id !== patch.estimateId ||
    estimate.context_id !== 4 ||
    estimate.doc_number !== patch.estimateNumber ||
    estimate.customer_id !== patch.customerId ||
    Number(estimate.modified) > patch.estimateModified
  ) {
    throw new Error('OC shipping patch does not match the cached estimate identity or revision.');
  }

  const prior = await readProvenance(client, patch.estimateId);
  const incoming = ocShippingProvenanceFor(patch);
  // An authority can change without an OC revision change. Only order authority
  // revisions within the same authority; an unavailable authority deliberately
  // clears stale derived values instead of being masked by its old timestamp.
  if (prior && compareOCShippingProvenance(prior, incoming) > 0) return 'skipped_stale';

  const cachedLines = await client.query<{
    document_item_id: string | null;
    item_id: string;
    quantity: string | number;
  }>(
    `SELECT document_item_id, item_id, quantity FROM item_documents WHERE doc_id = $1 FOR UPDATE`,
    [estimate.doc_id]
  );
  const matched = new Set<string>();
  for (const line of patch.lines) {
    const found = cachedLines.rows.filter(
      (candidate) =>
        candidate.document_item_id === line.documentItemId &&
        candidate.item_id === line.itemId &&
        Number(candidate.quantity) === line.quantity
    );
    if (found.length !== 1) continue;
    matched.add(line.documentItemId);
    await client.query(
      `UPDATE item_documents SET quantity_shipped = $1
       WHERE doc_id = $2 AND document_item_id = $3 AND item_id = $4 AND quantity = $5`,
      [line.quantityShipped, estimate.doc_id, line.documentItemId, line.itemId, line.quantity]
    );
  }
  // A line without a proof is deliberately unknown, including a removed/replaced line.
  for (const line of cachedLines.rows) {
    if (line.document_item_id && matched.has(line.document_item_id)) continue;
    await client.query(
      `UPDATE item_documents SET quantity_shipped = NULL
       WHERE doc_id = $1 AND document_item_id IS NOT DISTINCT FROM $2 AND item_id = $3 AND quantity = $4`,
      [estimate.doc_id, line.document_item_id, line.item_id, Number(line.quantity)]
    );
  }
  await client.query(
    `UPDATE documents SET associated_document_id = $1, shipped_percent = $2 WHERE doc_id = $3`,
    [patch.associatedDocumentId, patch.shippedPercent, estimate.doc_id]
  );
  await putProvenance(client, incoming);
  return 'applied';
}

/** Clears a previous derived patch only when this authority was its recorded source. */
export async function reconcileOCShippingAuthority(
  client: PoolClient,
  authorityId: string,
  associatedDocumentId: string | null
): Promise<void> {
  if (!authorityId) return;
  const result = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM cache_meta
     WHERE starts_with(key, $1)
       AND (value::jsonb ->> 'authorityId' = $2 OR value::jsonb ->> 'sourceDocumentId' = $2)
     FOR UPDATE`,
    [PREFIX, authorityId]
  );
  for (const entry of result.rows) {
    const prior = parseOCShippingProvenance(entry.value);
    if (prior.authorityId !== authorityId && prior.sourceDocumentId !== authorityId) continue;
    if (associatedDocumentId === prior.estimateId) continue;
    await clearEstimateShipping(client, prior.estimateId);
    await client.query(`DELETE FROM cache_meta WHERE key = $1`, [entry.key]);
  }
}

export async function clearOCShippingAuthority(client: PoolClient, authorityId: string): Promise<void> {
  await reconcileOCShippingAuthority(client, authorityId, null);
}

/** Removes stale provenance when an OC payload is known but shipping cannot be verified. */
export async function clearOCShippingEstimateProvenance(
  client: PoolClient,
  estimateId: string
): Promise<void> {
  await client.query(`DELETE FROM cache_meta WHERE key = $1`, [keyFor(estimateId)]);
}

/** A known OC with unverified shipping retains its observed link but no derived shipment values. */
export async function clearOCShippingEstimateUnknown(
  client: PoolClient,
  estimateId: string
): Promise<void> {
  await clearEstimateShipping(client, estimateId);
  await clearOCShippingEstimateProvenance(client, estimateId);
}

/** A confirmed document tombstone may also remove the exact stale OC link. */
export async function clearOCShippingDeletedSource(client: PoolClient, authorityId: string): Promise<void> {
  if (!authorityId) return;
  const result = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM cache_meta
     WHERE starts_with(key, $1)
       AND (value::jsonb ->> 'authorityId' = $2 OR value::jsonb ->> 'sourceDocumentId' = $2)
     FOR UPDATE`,
    [PREFIX, authorityId]
  );
  for (const entry of result.rows) {
    const prior = parseOCShippingProvenance(entry.value);
    if (prior.authorityId !== authorityId && prior.sourceDocumentId !== authorityId) continue;
    await clearEstimateShipping(client, prior.estimateId, authorityId);
    await client.query(`DELETE FROM cache_meta WHERE key = $1`, [entry.key]);
  }
}

export async function readOCShippingKnownLinks(
  client: PoolClient
): Promise<readonly ShippingProvenance[]> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key`,
    [PREFIX]
  );
  return result.rows.map((row) => parseOCShippingProvenance(row.value));
}

export async function readOCShippingReconciliationStatus(
  client: PoolClient
): Promise<OCShippingReconciliationStatus | null> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM cache_meta WHERE key = $1`,
    [RECONCILIATION_STATUS_KEY]
  );
  return result.rows[0] ? parseReconciliationStatus(result.rows[0].value) : null;
}

export async function writeOCShippingReconciliationStatus(
  client: PoolClient,
  value: OCShippingReconciliationStatus
): Promise<void> {
  assertReconciliationStatus(value);
  await client.query(
    `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [RECONCILIATION_STATUS_KEY, JSON.stringify(value)]
  );
}

async function clearEstimateShipping(
  client: PoolClient,
  estimateId: string,
  deletedSourceId?: string
): Promise<void> {
  const result = await client.query<{ doc_id: string }>(
    `SELECT doc_id FROM documents WHERE api_doc_id = $1 AND context_id = 4 FOR UPDATE`,
    [estimateId]
  );
  const docId = result.rows[0]?.doc_id;
  if (!docId) return;
  await client.query(`UPDATE documents SET shipped_percent = NULL WHERE doc_id = $1`, [docId]);
  await client.query(`UPDATE item_documents SET quantity_shipped = NULL WHERE doc_id = $1`, [docId]);
  if (deletedSourceId) {
    await client.query(
      `UPDATE documents SET associated_document_id = NULL
       WHERE doc_id = $1 AND associated_document_id = $2`,
      [docId, deletedSourceId]
    );
  }
}

async function readProvenance(client: PoolClient, estimateId: string): Promise<ShippingProvenance | null> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM cache_meta WHERE key = $1 FOR UPDATE`,
    [keyFor(estimateId)]
  );
  return result.rows[0] ? parseOCShippingProvenance(result.rows[0].value) : null;
}

async function putProvenance(client: PoolClient, value: ShippingProvenance): Promise<void> {
  await client.query(
    `INSERT INTO cache_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [keyFor(value.estimateId), JSON.stringify(value)]
  );
}

export function ocShippingProvenanceFor(patch: OCShippingPatch): ShippingProvenance {
  return {
    version: 1,
    estimateId: patch.estimateId,
    estimateModified: patch.estimateModified,
    sourceDocumentId: patch.associatedDocumentId,
    authorityId: patch.authorityId ?? null,
    authorityModified: patch.authorityModified ?? null,
    sourceKind: patch.sourceKind,
  };
}

export function compareOCShippingProvenance(left: ShippingProvenance, right: ShippingProvenance): number {
  if (left.estimateModified !== right.estimateModified) {
    return left.estimateModified - right.estimateModified;
  }
  if (left.authorityId !== right.authorityId) return 0;
  if (right.authorityModified == null) return 0;
  return (left.authorityModified ?? -1) - right.authorityModified;
}

export function parseOCShippingProvenance(value: string): ShippingProvenance {
  try {
    const parsed = JSON.parse(value) as ShippingProvenance;
    if (
      parsed?.version !== 1 ||
      typeof parsed.estimateId !== 'string' ||
      !Number.isSafeInteger(parsed.estimateModified) ||
      (parsed.sourceDocumentId !== null && typeof parsed.sourceDocumentId !== 'string') ||
      (parsed.authorityId !== null && typeof parsed.authorityId !== 'string') ||
      (parsed.authorityModified !== null && !Number.isSafeInteger(parsed.authorityModified)) ||
      !['invoice', 'sales_order', 'none'].includes(parsed.sourceKind)
    ) throw new Error();
    return parsed;
  } catch {
    throw new Error('Invalid persisted OC shipping provenance.');
  }
}

export function assertOCShippingPatch(patch: OCShippingPatch): void {
  if (
    !patch ||
    !isUuid(patch.estimateId) ||
    !isUuid(patch.customerId) ||
    !Number.isSafeInteger(patch.estimateNumber) || patch.estimateNumber < 0 ||
    !Number.isSafeInteger(patch.estimateModified) || patch.estimateModified < 0 ||
    (patch.associatedDocumentId !== null && !isUuid(patch.associatedDocumentId)) ||
    (patch.authorityId !== undefined && !isUuid(patch.authorityId)) ||
    (patch.authorityModified !== undefined && (!Number.isSafeInteger(patch.authorityModified) || patch.authorityModified < 0)) ||
    !['invoice', 'sales_order', 'none'].includes(patch.sourceKind) ||
    (patch.shippedPercent !== null && (!Number.isFinite(patch.shippedPercent) || patch.shippedPercent < 0 || patch.shippedPercent > 100)) ||
    !Array.isArray(patch.lines)
  ) throw new Error('Invalid OC shipping patch.');
  const lineIds = new Set<string>();
  for (const line of patch.lines) {
    if (
      !line || !isUuid(line.documentItemId) || !isUuid(line.itemId) ||
      !Number.isFinite(line.quantity) || line.quantity < 0 ||
      (line.quantityShipped !== null &&
        (!Number.isFinite(line.quantityShipped) || line.quantityShipped < 0 || line.quantityShipped > line.quantity))
    ) throw new Error('Invalid OC shipping line patch.');
    if (line.documentItemId.length === 0 || line.itemId.length === 0 || lineIds.has(line.documentItemId))
      throw new Error('Duplicate or empty OC shipping line identity.');
    lineIds.add(line.documentItemId);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function parseReconciliationStatus(value: string): OCShippingReconciliationStatus {
  try {
    const parsed = JSON.parse(value) as OCShippingReconciliationStatus;
    assertReconciliationStatus(parsed);
    return parsed;
  } catch {
    throw new Error('Invalid persisted OC shipping reconciliation status.');
  }
}

function assertReconciliationStatus(value: OCShippingReconciliationStatus): void {
  if (
    !value || value.version !== 1 || typeof value.accountIdentity !== 'string' ||
    !['running', 'success', 'success_with_warnings', 'failed'].includes(value.status) ||
    !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.updatedAt) ||
    !Number.isSafeInteger(value.scanned) || value.scanned < 0 ||
    !Number.isSafeInteger(value.applied) || value.applied < 0 ||
    !Number.isSafeInteger(value.failed) || value.failed < 0 ||
    (value.lastSuccessAt !== undefined && !Number.isSafeInteger(value.lastSuccessAt)) ||
    (value.finishedAt !== undefined && !Number.isSafeInteger(value.finishedAt)) ||
    (value.errorCode !== undefined && !/^[a-z0-9_]+$/.test(value.errorCode))
  ) throw new Error('Invalid OC shipping reconciliation status.');
}
