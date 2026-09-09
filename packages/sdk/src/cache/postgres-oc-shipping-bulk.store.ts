import type { PoolClient } from 'pg';
import type { OCShippingPatch } from './oc-shipping.types.js';
import {
  assertOCShippingPatch,
  compareOCShippingProvenance,
  ocShippingProvenanceFor,
  parseOCShippingProvenance,
} from './postgres-oc-shipping.store.js';

export interface OCShippingPatchBulkResult {
  applied: number;
  skippedMissing: number;
  skippedStale: number;
}

/**
 * Publishes a bounded backfill batch in four set-based statements. The caller
 * supplies the writer-fenced transaction; invalid identity/revision state rolls
 * back the entire batch rather than silently mixing document generations.
 */
export async function applyOCShippingPatches(
  client: PoolClient,
  patches: readonly OCShippingPatch[]
): Promise<OCShippingPatchBulkResult> {
  const unique = validateBatch(patches);
  if (unique.length === 0) return { applied: 0, skippedMissing: 0, skippedStale: 0 };

  const ids = unique.map((patch) => patch.estimateId);
  const current = await client.query<{
    doc_id: string;
    api_doc_id: string;
    context_id: number;
    doc_number: number;
    modified: string | number;
    customer_id: string | null;
    value: string | null;
  }>(
    `SELECT d.doc_id, d.api_doc_id, d.context_id, d.doc_number, d.modified, d.customer_id, meta.value
     FROM documents d
     LEFT JOIN cache_meta meta ON meta.key = 'oc_shipping.v1:' || d.api_doc_id
     WHERE d.api_doc_id = ANY($1::text[]) FOR UPDATE OF d`,
    [ids]
  );
  const byId = new Map(current.rows.map((row) => [row.api_doc_id, row]));
  const applicable: OCShippingPatch[] = [];
  let skippedMissing = 0;
  let skippedStale = 0;
  for (const patch of unique) {
    const target = byId.get(patch.estimateId);
    if (!target) { skippedMissing++; continue; }
    if (
      target.context_id !== 4 || target.doc_number !== patch.estimateNumber ||
      target.customer_id !== patch.customerId || Number(target.modified) > patch.estimateModified
    ) throw new Error('OC shipping patch does not match the cached estimate identity or revision.');
    const prior = target.value ? parseOCShippingProvenance(target.value) : null;
    if (prior && compareOCShippingProvenance(prior, ocShippingProvenanceFor(patch)) > 0) {
      skippedStale++;
      continue;
    }
    applicable.push(patch);
  }
  if (applicable.length === 0) return { applied: 0, skippedMissing, skippedStale };

  const payload = JSON.stringify(applicable);
  await client.query(
    `WITH patches AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(
         "estimateId" text, "associatedDocumentId" text, "shippedPercent" numeric
       )
     )
     UPDATE documents d SET associated_document_id = p."associatedDocumentId", shipped_percent = p."shippedPercent"
     FROM patches p WHERE d.api_doc_id = p."estimateId" AND d.context_id = 4`,
    [payload]
  );
  await client.query(
    `WITH patches AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS p("estimateId" text, lines jsonb)
     ), lines AS (
       SELECT p."estimateId", l."documentItemId", l."itemId", l.quantity, l."quantityShipped"
       FROM patches p CROSS JOIN LATERAL jsonb_to_recordset(p.lines) AS l(
         "documentItemId" text, "itemId" text, quantity numeric, "quantityShipped" numeric
       )
     ), target_lines AS (
       SELECT id.id AS row_id FROM documents d JOIN patches p ON p."estimateId" = d.api_doc_id
       JOIN item_documents id ON id.doc_id = d.doc_id WHERE d.context_id = 4
     ), matched_candidates AS (
       SELECT id.id AS row_id, l."quantityShipped",
         COUNT(*) OVER (PARTITION BY d.doc_id, l."documentItemId", l."itemId", l.quantity) AS exact_count
       FROM documents d JOIN lines l ON l."estimateId" = d.api_doc_id
       JOIN item_documents id ON id.doc_id = d.doc_id
         AND id.document_item_id = l."documentItemId" AND id.item_id = l."itemId" AND id.quantity = l.quantity
       WHERE d.context_id = 4
     ), matched AS (
       SELECT row_id, "quantityShipped" FROM matched_candidates WHERE exact_count = 1
     )
     UPDATE item_documents id SET quantity_shipped = m."quantityShipped"
     FROM target_lines t LEFT JOIN matched m ON m.row_id = t.row_id
     WHERE id.id = t.row_id`,
    [payload]
  );
  await client.query(
    `WITH patches AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(
       "estimateId" text, "estimateModified" bigint, "associatedDocumentId" text,
       "authorityId" text, "authorityModified" bigint, "sourceKind" text
     ))
     INSERT INTO cache_meta(key, value)
     SELECT 'oc_shipping.v1:' || "estimateId", jsonb_build_object(
       'version', 1, 'estimateId', "estimateId", 'estimateModified', "estimateModified",
       'sourceDocumentId', "associatedDocumentId", 'authorityId', "authorityId",
       'authorityModified', "authorityModified", 'sourceKind', "sourceKind"
     )::text FROM patches
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [payload]
  );
  return { applied: applicable.length, skippedMissing, skippedStale };
}

function validateBatch(patches: readonly OCShippingPatch[]): OCShippingPatch[] {
  if (!Array.isArray(patches)) throw new Error('Invalid OC shipping patch batch.');
  const ids = new Set<string>();
  for (const patch of patches) {
    assertOCShippingPatch(patch);
    if (ids.has(patch.estimateId)) throw new Error('Duplicate OC shipping patch estimate identity.');
    ids.add(patch.estimateId);
  }
  return [...patches];
}
