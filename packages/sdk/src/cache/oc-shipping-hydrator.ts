import {
  createOcShippingPatch,
  createUnknownOCShippingPatch,
  createUnknownOCShippingPatchFromEstimate,
} from './oc-shipping-matcher.js';
import {
  normalizeV3OCShippingEstimate,
  normalizeV3OCShippingSourceDocument,
  v3DocumentObjectKind,
} from './oc-shipping-v3-normalizer.js';
import { OCShippingContractError } from './oc-shipping.types.js';
import type {
  OCShippingCanonicalEstimate,
  OCShippingCanonicalSourceDocument,
  OCShippingDocumentsReadPort,
  OCShippingHydrationIssue,
  OCShippingHydrationResult,
} from './oc-shipping.types.js';

/**
 * Hydrates an OC shipping patch from an estimate or invoice detail response.
 * A missing relation is reportable rather than evidence that a document is standalone.
 */
export async function hydrateOcShippingPatch(
  documents: OCShippingDocumentsReadPort,
  currentPayload: unknown
): Promise<OCShippingHydrationResult> {
  const kind = v3DocumentObjectKind(currentPayload);
  if (kind === 'estimate') return hydrateFromEstimate(documents, normalizeV3OCShippingEstimate(currentPayload));
  if (kind === 'invoice') return hydrateFromInvoice(documents, normalizeV3OCShippingSourceDocument(currentPayload));
  throw new Error('OC shipping hydration accepts estimate or invoice payloads');
}

/**
 * Converts only a related-document contract conflict into a reportable shipping issue.
 * The initiating payload is validated before the guarded hydration begins.
 */
export async function hydrateOcShippingPatchSafely(
  documents: OCShippingDocumentsReadPort,
  currentPayload: unknown
): Promise<OCShippingHydrationResult> {
  const documentId = validatedInitiatingDocumentId(currentPayload);
  try {
    return await hydrateOcShippingPatch(documents, currentPayload);
  } catch (error) {
    if (error instanceof OCShippingContractError) {
      return issueOnly('shipping_contract_invalid', documentId);
    }
    throw error;
  }
}

/** Reconciles a freshly listed Sales Order by proving its OC conversion relation first. */
export async function hydrateOcShippingFromSalesOrder(
  documents: OCShippingDocumentsReadPort,
  salesOrderPayload: unknown
): Promise<OCShippingHydrationResult> {
  const source = normalizeV3OCShippingSourceDocument(salesOrderPayload);
  if (source.kind !== 'sales_order') throw new Error('Expected sales order payload');
  const relation = source.sourceEstimate;
  if (!relation.observed) return issueOnly('source_estimate_unobserved', source.id);
  if (relation.value === null) return { patch: null, issues: [] };
  return hydrateFromSalesOrderSource(documents, source);
}

async function hydrateFromEstimate(
  documents: OCShippingDocumentsReadPort,
  estimate: OCShippingCanonicalEstimate
): Promise<OCShippingHydrationResult> {
  const converted = estimate.convertedDocument;
  if (!converted.observed) return issueOnly('converted_document_unobserved', estimate.id);
  if (converted.value === null) return { patch: createOcShippingPatch(estimate), issues: [] };
  const source = await readSource(documents, converted.value.kind, converted.value.id);
  if (source === null) {
    return {
      patch: createUnknownOCShippingPatchFromEstimate(estimate),
      issues: [{ code: 'source_document_not_found', documentId: converted.value.id }],
    };
  }
  return patchFromSource(documents, estimate, source);
}

async function hydrateFromInvoice(
  documents: OCShippingDocumentsReadPort,
  invoice: OCShippingCanonicalSourceDocument
): Promise<OCShippingHydrationResult> {
  if (invoice.fulfillmentAuthority === 'sales_order') {
    const authorityId = invoice.fulfillmentSalesOrderId;
    if (authorityId === undefined || authorityId === null) throw new Error('Linked invoice has no fulfillment sales order identity');
    const authority = await readSource(documents, 'sales_order', authorityId);
    if (authority === null) return issueOnly('authority_not_found', authorityId);
    return hydrateFromSalesOrderSource(documents, authority);
  }
  const relation = invoice.sourceEstimate;
  if (!relation.observed) return issueOnly('source_estimate_unobserved', invoice.id);
  if (relation.value === null) {
    return invoice.fulfillmentAuthority === undefined
      ? issueOnly('fulfillment_authority_unobserved', invoice.id)
      : { patch: null, issues: [] };
  }
  const estimate = await readEstimate(documents, relation.value.id);
  if (estimate === null) return issueOnly('estimate_not_found', relation.value.id);
  return patchFromSource(documents, estimate, invoice);
}

async function hydrateFromSalesOrderSource(
  documents: OCShippingDocumentsReadPort,
  source: OCShippingCanonicalSourceDocument
): Promise<OCShippingHydrationResult> {
  const relation = source.sourceEstimate;
  if (!relation.observed) return issueOnly('source_estimate_unobserved', source.id);
  if (relation.value === null) return { patch: null, issues: [] };
  const estimate = await readEstimate(documents, relation.value.id);
  if (estimate === null) return issueOnly('estimate_not_found', relation.value.id);
  return patchFromSource(documents, estimate, source);
}

async function patchFromSource(
  documents: OCShippingDocumentsReadPort,
  estimate: OCShippingCanonicalEstimate,
  source: OCShippingCanonicalSourceDocument
): Promise<OCShippingHydrationResult> {
  if (!estimate.convertedDocument.observed) return issueOnly('converted_document_unobserved', estimate.id);
  if (!source.sourceEstimate.observed) return issueOnly('source_estimate_unobserved', source.id);
  if (source.kind !== 'invoice') return { patch: createOcShippingPatch(estimate, source), issues: [] };

  if (source.fulfillmentAuthority === undefined) {
    return issueOnly('fulfillment_authority_unobserved', source.id);
  }
  if (source.fulfillmentAuthority === 'invoice') {
    return { patch: createOcShippingPatch(estimate, source), issues: [] };
  }
  const authorityId = source.fulfillmentSalesOrderId;
  if (authorityId === undefined || authorityId === null) {
    throw new Error('Linked invoice has no fulfillment sales order identity');
  }
  const authority = await readSource(documents, 'sales_order', authorityId);
  if (authority === null) {
    return {
      patch: createUnknownOCShippingPatch(estimate, source),
      issues: [{ code: 'authority_not_found', documentId: authorityId }],
    };
  }
  return { patch: createOcShippingPatch(estimate, source, authority), issues: [] };
}

async function readEstimate(
  documents: OCShippingDocumentsReadPort,
  id: string
): Promise<OCShippingCanonicalEstimate | null> {
  try {
    return normalizeV3OCShippingEstimate(await documents.get(4, id));
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function readSource(
  documents: OCShippingDocumentsReadPort,
  kind: 'invoice' | 'sales_order',
  id: string
): Promise<OCShippingCanonicalSourceDocument | null> {
  try {
    const payload = kind === 'invoice' ? await documents.get(5, id) : await documents.getSalesOrder(id);
    return normalizeV3OCShippingSourceDocument(payload, { id, kind });
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

function validatedInitiatingDocumentId(payload: unknown): string {
  const kind = v3DocumentObjectKind(payload);
  return kind === 'estimate'
    ? normalizeV3OCShippingEstimate(payload).id
    : normalizeV3OCShippingSourceDocument(payload).id;
}

function issueOnly(
  code: OCShippingHydrationIssue['code'],
  documentId: string
): OCShippingHydrationResult {
  return { patch: null, issues: [{ code, documentId }] };
}

function notFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'status' in error.response &&
    error.response.status === 404
  );
}
