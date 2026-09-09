/** A relation whose omission differs from an explicit source clear. */
export type ObservedOCShippingValue<T> =
  | { observed: false }
  | { observed: true; value: T | null };

export type OCShippingSourceKind = 'invoice' | 'sales_order' | 'none';

export interface OCShippingConvertedDocument {
  id: string;
  kind: Exclude<OCShippingSourceKind, 'none'>;
  number: number;
}

export interface OCShippingSourceEstimate {
  id: string;
  estimateNumber: number;
}

/** The exact immutable scope used to correlate an OC line to its authority line. */
export interface OCShippingCanonicalLine {
  documentItemId: string;
  itemId: string;
  quantity: number;
  itemVariationLocationId?: number | null;
  unitId?: number | string | null;
  quantityShipped?: number | null;
}

export interface OCShippingCanonicalEstimate {
  id: string;
  kind: 'estimate';
  number: number;
  modified: number;
  customerId: string;
  lines: readonly OCShippingCanonicalLine[];
  convertedDocument: ObservedOCShippingValue<OCShippingConvertedDocument>;
}

export interface OCShippingCanonicalSourceDocument {
  id: string;
  kind: Exclude<OCShippingSourceKind, 'none'>;
  number: number;
  modified?: number;
  customerId: string;
  lines: readonly OCShippingCanonicalLine[];
  sourceEstimate: ObservedOCShippingValue<OCShippingSourceEstimate>;
  shippedPercent?: number | null;
  fulfillmentAuthority?: 'invoice' | 'sales_order';
  fulfillmentSalesOrderId?: string | null;
}

export interface OCShippingPatchLine {
  documentItemId: string;
  itemId: string;
  quantity: number;
  quantityShipped: number | null;
}

/** A persistence-neutral replacement of the OC's derived shipping state. */
export interface OCShippingPatch {
  estimateId: string;
  estimateNumber: number;
  estimateModified: number;
  customerId: string;
  associatedDocumentId: string | null;
  sourceKind: OCShippingSourceKind;
  authorityId?: string;
  authorityModified?: number;
  shippedPercent: number | null;
  lines: readonly OCShippingPatchLine[];
}

export type OCShippingHydrationIssueCode =
  | 'shipping_contract_invalid'
  | 'converted_document_unobserved'
  | 'source_estimate_unobserved'
  | 'fulfillment_authority_unobserved'
  | 'source_document_not_found'
  | 'authority_not_found'
  | 'estimate_not_found';

export interface OCShippingHydrationIssue {
  code: OCShippingHydrationIssueCode;
  documentId: string;
}

export interface OCShippingHydrationResult {
  patch: OCShippingPatch | null;
  issues: readonly OCShippingHydrationIssue[];
}

/** Read-only subset required to hydrate the authoritative fulfillment document. */
export interface OCShippingDocumentsReadPort {
  get(contextId: 4 | 5, id: string): Promise<unknown>;
  getSalesOrder(id: string): Promise<unknown>;
}

export class OCShippingContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OCShippingContractError';
  }
}
