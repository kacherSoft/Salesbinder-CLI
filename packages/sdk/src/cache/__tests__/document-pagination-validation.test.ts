import { assertDocumentScanBounds } from '../document-pagination-validation.js';

describe('document pagination safety bounds', () => {
  it('stops a metadata-free scan before requesting an unbounded page', () => {
    expect(() => assertDocumentScanBounds(10_001, 10_000)).toThrow(
      'Document snapshot exceeds safety bounds'
    );
  });

  it('stops a metadata-free scan after the cumulative record bound', () => {
    expect(() => assertDocumentScanBounds(1, 1_000_001)).toThrow(
      'Document snapshot exceeds safety bounds'
    );
  });
});
