import {
  OCShippingContractError,
  type OCShippingCanonicalEstimate,
  type OCShippingCanonicalLine,
  type OCShippingCanonicalSourceDocument,
  type OCShippingPatch,
  type OCShippingPatchLine,
} from './oc-shipping.types.js';

/**
 * Correlates OC inventory lines only when their immutable fulfillment scope is
 * unique on both documents. Source line IDs intentionally do not participate.
 */
export function createOcShippingPatch(
  estimate: OCShippingCanonicalEstimate,
  source?: OCShippingCanonicalSourceDocument,
  authority?: OCShippingCanonicalSourceDocument
): OCShippingPatch {
  validateEstimate(estimate);
  if (!estimate.convertedDocument.observed) throw invalid('OC conversion relation is unobserved');
  if (estimate.convertedDocument.value === null) {
    if (source !== undefined) throw invalid('Unconverted OC cannot have a source document');
    return unconvertedPatch(estimate);
  }
  if (source === undefined) throw invalid('Converted OC requires its source document');
  validateSourceForEstimate(estimate, source);
  const fulfillmentAuthority = authority ?? source;
  validateAuthority(source, fulfillmentAuthority);

  return {
    estimateId: estimate.id,
    estimateNumber: estimate.number,
    estimateModified: estimate.modified,
    customerId: estimate.customerId,
    associatedDocumentId: source.id,
    sourceKind: source.kind,
    authorityId: fulfillmentAuthority.id,
    ...(fulfillmentAuthority.modified === undefined
      ? {}
      : { authorityModified: fulfillmentAuthority.modified }),
    shippedPercent: knownPercent(fulfillmentAuthority.shippedPercent),
    lines: matchLines(estimate.lines, fulfillmentAuthority.lines),
  };
}

/** Creates a reportable clear when the source is proven but its linked authority is unavailable. */
export function createUnknownOCShippingPatch(
  estimate: OCShippingCanonicalEstimate,
  source: OCShippingCanonicalSourceDocument
): OCShippingPatch {
  validateEstimate(estimate);
  if (!estimate.convertedDocument.observed || estimate.convertedDocument.value === null) {
    throw invalid('Unknown OC shipping requires an observed converted document');
  }
  validateSourceForEstimate(estimate, source);
  return unknownPatch(estimate, source.id, source.kind);
}

/** Clears shipment when the OC's own observed conversion relation is the only proof available. */
export function createUnknownOCShippingPatchFromEstimate(
  estimate: OCShippingCanonicalEstimate
): OCShippingPatch {
  validateEstimate(estimate);
  const relation = estimate.convertedDocument;
  if (!relation.observed || relation.value === null) {
    throw invalid('Unknown OC shipping requires an observed converted document');
  }
  return unknownPatch(estimate, relation.value.id, relation.value.kind);
}

function unknownPatch(
  estimate: OCShippingCanonicalEstimate,
  associatedDocumentId: string,
  sourceKind: OCShippingCanonicalSourceDocument['kind']
): OCShippingPatch {
  return {
    estimateId: estimate.id,
    estimateNumber: estimate.number,
    estimateModified: estimate.modified,
    customerId: estimate.customerId,
    associatedDocumentId,
    sourceKind,
    shippedPercent: null,
    lines: estimate.lines.map(clearLine),
  };
}

function validateEstimate(estimate: OCShippingCanonicalEstimate): void {
  if (
    estimate.kind !== 'estimate' ||
    !uuid(estimate.id) ||
    !uuid(estimate.customerId) ||
    !documentNumber(estimate.number) ||
    !epochSeconds(estimate.modified)
  ) {
    throw invalid('Invalid OC identity');
  }
  validateLines(estimate.lines);
  const relation = estimate.convertedDocument;
  if (relation.observed && relation.value !== null) {
    if (!uuid(relation.value.id) || !documentNumber(relation.value.number)) {
      throw invalid('Invalid OC conversion relation');
    }
  }
}

function validateSourceForEstimate(
  estimate: OCShippingCanonicalEstimate,
  source: OCShippingCanonicalSourceDocument
): void {
  const convertedRelation = estimate.convertedDocument;
  if (!convertedRelation.observed || convertedRelation.value === null) {
    throw invalid('OC source document has no converted relation');
  }
  const converted = convertedRelation.value;
  if (
    converted === null ||
    source.kind !== converted.kind ||
    source.id !== converted.id ||
    source.number !== converted.number ||
    source.customerId !== estimate.customerId
  ) {
    throw invalid('OC source document does not match its conversion relation');
  }
  if (
    !uuid(source.id) ||
    !uuid(source.customerId) ||
    !documentNumber(source.number) ||
    (source.modified !== undefined && !epochSeconds(source.modified))
  ) {
    throw invalid('Invalid OC source identity');
  }
  validateLines(source.lines);
  if (
    source.shippedPercent !== undefined &&
    source.shippedPercent !== null &&
    knownPercent(source.shippedPercent) === null
  ) {
    throw invalid('Invalid source shipped percentage');
  }
  if (!source.sourceEstimate.observed) throw invalid('Source estimate relation is unobserved');
  const sourceEstimate = source.sourceEstimate.value;
  if (
    sourceEstimate === null ||
    sourceEstimate.id !== estimate.id ||
    sourceEstimate.estimateNumber !== estimate.number
  ) {
    throw invalid('Source document does not point to the OC');
  }
}

function validateAuthority(
  source: OCShippingCanonicalSourceDocument,
  authority: OCShippingCanonicalSourceDocument
): void {
  if (source.fulfillmentAuthority === 'sales_order') {
    if (
      authority.kind !== 'sales_order' ||
      source.fulfillmentSalesOrderId !== authority.id ||
      authority.customerId !== source.customerId
    ) {
      throw invalid('Invoice fulfillment authority does not match its sales order');
    }
    const authoritySource = authority.sourceEstimate;
    const sourceEstimate = source.sourceEstimate;
    if (
      !authoritySource.observed ||
      authoritySource.value === null ||
      !sourceEstimate.observed ||
      sourceEstimate.value === null ||
      authoritySource.value.id !== sourceEstimate.value.id ||
      authoritySource.value.estimateNumber !== sourceEstimate.value.estimateNumber
    ) {
      throw invalid('Fulfillment sales order does not point to the OC');
    }
  } else if (authority !== source) {
    throw invalid('Standalone source must be its own fulfillment authority');
  }
  if (!uuid(authority.id) || (authority.modified !== undefined && !epochSeconds(authority.modified))) {
    throw invalid('Invalid authority identity');
  }
  validateLines(authority.lines);
  if (
    authority.shippedPercent !== undefined &&
    authority.shippedPercent !== null &&
    knownPercent(authority.shippedPercent) === null
  ) {
    throw invalid('Invalid authority shipped percentage');
  }
}

function matchLines(
  estimateLines: readonly OCShippingCanonicalLine[],
  authorityLines: readonly OCShippingCanonicalLine[]
): readonly OCShippingPatchLine[] {
  return estimateLines.map((line) => {
    const scope = lineScope(line);
    if (
      scope === null ||
      countScope(estimateLines, scope) !== 1 ||
      countScope(authorityLines, scope) !== 1
    ) {
      return clearLine(line);
    }
    const candidates = authorityLines.filter(
      (authorityLine) => lineScope(authorityLine) === scope && authorityLine.quantity === line.quantity
    );
    const candidate = candidates[0];
    return candidate === undefined ? clearLine(line) : shippedLine(line, candidate);
  });
}

function shippedLine(
  estimateLine: OCShippingCanonicalLine,
  authorityLine: OCShippingCanonicalLine
): OCShippingPatchLine {
  return { ...clearLine(estimateLine), quantityShipped: knownQuantity(authorityLine.quantityShipped, authorityLine.quantity) };
}

function clearLine(line: OCShippingCanonicalLine): OCShippingPatchLine {
  return {
    documentItemId: line.documentItemId,
    itemId: line.itemId,
    quantity: line.quantity,
    quantityShipped: null,
  };
}

function lineScope(line: OCShippingCanonicalLine): string | null {
  if (!Object.hasOwn(line, 'itemVariationLocationId') || !Object.hasOwn(line, 'unitId')) return null;
  return JSON.stringify([line.itemId, line.itemVariationLocationId, line.unitId]);
}

function countScope(lines: readonly OCShippingCanonicalLine[], scope: string): number {
  return lines.filter((line) => lineScope(line) === scope).length;
}

function validateLines(lines: readonly OCShippingCanonicalLine[]): void {
  const ids = new Set<string>();
  for (const line of lines) {
    if (!uuid(line.documentItemId) || !uuid(line.itemId) || !quantity(line.quantity) || ids.has(line.documentItemId)) {
      throw invalid('Invalid OC shipping line');
    }
    ids.add(line.documentItemId);
    for (const key of ['itemVariationLocationId', 'unitId'] as const) {
      if (!Object.hasOwn(line, key)) continue;
      const value = line[key];
      if (value !== null && !(key === 'itemVariationLocationId' ? integer(value) : integerOrText(value))) {
        throw invalid('Invalid OC shipping line scope');
      }
    }
    if (
      line.quantityShipped !== undefined &&
      line.quantityShipped !== null &&
      knownQuantity(line.quantityShipped, line.quantity) === null
    ) {
      throw invalid('Invalid source shipped quantity');
    }
  }
}

function unconvertedPatch(estimate: OCShippingCanonicalEstimate): OCShippingPatch {
  return {
    estimateId: estimate.id,
    estimateNumber: estimate.number,
    estimateModified: estimate.modified,
    customerId: estimate.customerId,
    associatedDocumentId: null,
    sourceKind: 'none',
    shippedPercent: null,
    lines: estimate.lines.map(clearLine),
  };
}

function knownPercent(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : quantity(value) && value <= 100 ? value : null;
}

function knownQuantity(value: number | null | undefined, maximum: number): number | null {
  return value === undefined || value === null ? null : quantity(value) && value <= maximum ? value : null;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function documentNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function epochSeconds(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function quantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function integerOrText(value: unknown): boolean {
  return integer(value) || (typeof value === 'string' && value.length > 0);
}

function invalid(message: string): OCShippingContractError {
  return new OCShippingContractError(message);
}
