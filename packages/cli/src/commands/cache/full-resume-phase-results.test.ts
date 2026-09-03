import {
  canonicalSyncRecordIssueMessage,
  sanitizeFullResumePhaseResult,
  type FullResumeRecordIssue,
} from './full-resume-phase-results.js';

describe('sanitizeFullResumePhaseResult', () => {
  it('exposes resource-specific warning and message-helper types', () => {
    const documentIssue: FullResumeRecordIssue = {
      resource: 'document',
      id: 'document-id',
      context_id: 5,
      code: 'invalid_record',
      message: 'Document failed source validation',
      attempts: 2,
      outcome: 'omitted_new',
    };
    const itemIssue: FullResumeRecordIssue = {
      resource: 'item',
      id: 'item-id',
      code: 'invalid_variations',
      message: 'Item variations failed source validation',
      attempts: 2,
      outcome: 'preserved_last_known_good',
    };
    // @ts-expect-error Document warnings cannot use item-only recovery codes.
    const invalidDocumentIssue: FullResumeRecordIssue = {
      ...documentIssue,
      code: 'invalid_variations',
    };
    // @ts-expect-error Item warnings cannot carry document context.
    const invalidItemIssue: FullResumeRecordIssue = {
      ...itemIssue,
      context_id: 5,
    };
    if (false) {
      // @ts-expect-error Document message projection accepts only document warning codes.
      canonicalSyncRecordIssueMessage('document', 'content_changed');
    }

    expect([documentIssue, itemIssue]).toHaveLength(2);
    void invalidDocumentIssue;
    void invalidItemIssue;
  });

  it('keeps only the v5 document summary and safe issue fields', () => {
    const result = sanitizeFullResumePhaseResult('documents', {
      success: true,
      type: 'full',
      documentsProcessed: 2,
      documentsDeleted: 1,
      lineItemsProcessed: 3,
      duration: '1.0s',
      syncLookbackSeconds: 60,
      payload: { authorization: 'secret' },
      recordIssues: [
        {
          resource: 'document',
          id: 'doc-1',
          context_id: 11,
          code: 'invalid_record',
          message: 'Authorization: Bearer source-secret https://private.example/body',
          attempts: 2,
          outcome: 'preserved_last_known_good',
          customer_name: 'must not persist',
        },
      ],
    });

    expect(result).toEqual({
      success: true,
      type: 'full',
      documentsProcessed: 2,
      documentsDeleted: 1,
      lineItemsProcessed: 3,
      duration: '1.0s',
      syncLookbackSeconds: 60,
      recordIssues: [
        {
          resource: 'document',
          id: 'doc-1',
          context_id: 11,
          code: 'invalid_record',
          message: 'Document failed source validation',
          attempts: 2,
          outcome: 'preserved_last_known_good',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/source-secret|private\.example|Authorization/);
  });

  it('stores no category snapshot payload', () => {
    expect(
      sanitizeFullResumePhaseResult('categories', {
        categoriesProcessed: 4,
        snapshot: { rows: [{ id: 'category-secret' }] },
      })
    ).toEqual({ categoriesProcessed: 4, snapshot: null });
  });

  it('keeps only sorted context-plus-API-ID document tombstones', () => {
    expect(
      sanitizeFullResumePhaseResult('deleted-log', {
        deletedRecordsProcessed: 3,
        documentTombstones: [
          { contextId: 11, apiDocumentId: 'z', created: 'private timestamp' },
          { contextId: 4, apiDocumentId: 'é', authorization: 'private token' },
          { contextId: 4, apiDocumentId: 'z' },
        ],
        payload: { customer_name: 'private customer' },
      })
    ).toEqual({
      deletedRecordsProcessed: 3,
      documentTombstones: [
        { contextId: 4, apiDocumentId: 'z' },
        { contextId: 4, apiDocumentId: 'é' },
        { contextId: 11, apiDocumentId: 'z' },
      ],
    });
  });

  it('rejects an old completed deleted-log result without tombstone identities', () => {
    expect(() =>
      sanitizeFullResumePhaseResult('deleted-log', { deletedRecordsProcessed: 0 })
    ).toThrow(/documentTombstones must be an array/);
  });

  it.each([
    ['non-array list', {}],
    ['invalid context', [{ contextId: 6, apiDocumentId: 'item-id' }]],
    ['empty API ID', [{ contextId: 5, apiDocumentId: '' }]],
    ['trimmed API ID', [{ contextId: 5, apiDocumentId: ' invoice-id' }]],
    ['control API ID', [{ contextId: 5, apiDocumentId: 'invoice\u0000id' }]],
    ['unpaired high surrogate API ID', [{ contextId: 5, apiDocumentId: 'invoice-\ud800' }]],
    ['unpaired low surrogate API ID', [{ contextId: 5, apiDocumentId: 'invoice-\udc00' }]],
    ['oversized API ID', [{ contextId: 5, apiDocumentId: 'i'.repeat(257) }]],
    [
      'duplicate identity',
      [
        { contextId: 5, apiDocumentId: 'invoice-id' },
        { contextId: 5, apiDocumentId: 'invoice-id' },
      ],
    ],
  ])('rejects a malformed deleted-log tombstone %s', (_label, documentTombstones) => {
    expect(() =>
      sanitizeFullResumePhaseResult('deleted-log', {
        deletedRecordsProcessed: 0,
        documentTombstones,
      })
    ).toThrow(/tombstone|documentTombstones/);
  });

  it('rejects unsuccessful completed document phases', () => {
    expect(() =>
      sanitizeFullResumePhaseResult('documents', {
        success: false,
        type: 'delta',
        documentsProcessed: 0,
        lineItemsProcessed: 0,
        duration: '0s',
      })
    ).toThrow(/did not succeed/);
  });

  it.each([1, 999])('rejects document warning attempts=%i instead of restoring it', (attempts) => {
    expect(() =>
      sanitizeFullResumePhaseResult('documents', {
        success: true,
        type: 'delta',
        documentsProcessed: 0,
        lineItemsProcessed: 0,
        duration: '0s',
        recordIssues: [
          {
            resource: 'document',
            id: 'document-id',
            context_id: 5,
            code: 'not_found',
            message: 'untrusted',
            attempts,
            outcome: 'omitted_new',
          },
        ],
      })
    ).toThrow(/attempts must equal 2/);
  });

  it.each(['invalid_variations', 'content_changed'])(
    'rejects item-only warning code %s for a document phase',
    (code) => {
      expect(() =>
        sanitizeFullResumePhaseResult('documents', {
          success: true,
          type: 'delta',
          documentsProcessed: 0,
          lineItemsProcessed: 0,
          duration: '0s',
          recordIssues: [
            {
              resource: 'document',
              id: 'document-id',
              context_id: 5,
              code,
              message: 'untrusted',
              attempts: 2,
              outcome: 'omitted_new',
            },
          ],
        })
      ).toThrow(/record issue code is invalid/);
    }
  );

  it('retains the item-only content_changed warning code', () => {
    expect(
      sanitizeFullResumePhaseResult('items', {
        itemsProcessed: 0,
        stockRowsProcessed: 0,
        recordIssues: [
          {
            resource: 'item',
            id: 'item-id',
            code: 'content_changed',
            message: 'untrusted',
            attempts: 2,
            outcome: 'preserved_last_known_good',
          },
        ],
      }).recordIssues
    ).toEqual([
      expect.objectContaining({
        resource: 'item',
        code: 'content_changed',
        message: 'Item changed during snapshot verification',
      }),
    ]);
  });

  it('rejects exact duplicate issue IDs', () => {
    expect(() =>
      sanitizeFullResumePhaseResult('items', {
        itemsProcessed: 0,
        stockRowsProcessed: 0,
        recordIssues: [
          {
            resource: 'item',
            id: 'item-1',
            code: 'not_found',
            message: 'Missing',
            attempts: 2,
            outcome: 'omitted_new',
          },
          {
            resource: 'item',
            id: 'item-1',
            code: 'not_found',
            message: 'Missing',
            attempts: 2,
            outcome: 'omitted_new',
          },
        ],
      })
    ).toThrow(/duplicate record issue/);
  });

  it('rejects conflicting duplicate document IDs with inconsistent contexts', () => {
    expect(() =>
      sanitizeFullResumePhaseResult('documents', {
        success: true,
        type: 'full',
        documentsProcessed: 0,
        lineItemsProcessed: 0,
        duration: '0s',
        recordIssues: [
          {
            resource: 'document',
            id: 'document-1',
            context_id: 4,
            code: 'not_found',
            message: 'Missing',
            attempts: 2,
            outcome: 'omitted_new',
          },
          {
            resource: 'document',
            id: 'document-1',
            context_id: 5,
            code: 'not_found',
            message: 'Missing',
            attempts: 2,
            outcome: 'omitted_new',
          },
        ],
      })
    ).toThrow(/conflicting record issue/);
  });

  it('sorts Unicode issue IDs by UTF-16 code units', () => {
    const result = sanitizeFullResumePhaseResult('items', {
      itemsProcessed: 4,
      stockRowsProcessed: 0,
      recordIssues: ['é', '😀', 'ä', 'z'].map((id) => ({
        resource: 'item',
        id,
        code: 'not_found',
        message: 'Missing',
        attempts: 2,
        outcome: 'omitted_new',
      })),
    });

    expect(result.recordIssues.map((issue) => issue.id)).toEqual(['z', 'ä', 'é', '😀']);
  });

  it.each([201, 256])('preserves canonical source IDs with %i characters', (length) => {
    const id = 'i'.repeat(length);
    const result = sanitizeFullResumePhaseResult('items', {
      itemsProcessed: 0,
      stockRowsProcessed: 0,
      recordIssues: [
        {
          resource: 'item',
          id,
          code: 'not_found',
          message: 'untrusted',
          attempts: 2,
          outcome: 'omitted_new',
        },
      ],
    });

    expect(result.recordIssues[0].id).toBe(id);
  });

  it('rejects source IDs longer than 256 characters', () => {
    expect(() =>
      sanitizeFullResumePhaseResult('items', {
        itemsProcessed: 0,
        stockRowsProcessed: 0,
        recordIssues: [
          {
            resource: 'item',
            id: 'i'.repeat(257),
            code: 'not_found',
            message: 'untrusted',
            attempts: 2,
            outcome: 'omitted_new',
          },
        ],
      })
    ).toThrow(/record issue id is invalid/);
  });

  it.each(['', ' leading', 'trailing ', 'control\u0000character', 'high-\ud800', 'low-\udc00'])(
    'rejects non-canonical source ID %j',
    (id) => {
      expect(() =>
        sanitizeFullResumePhaseResult('items', {
          itemsProcessed: 0,
          stockRowsProcessed: 0,
          recordIssues: [
            {
              resource: 'item',
              id,
              code: 'not_found',
              message: 'untrusted',
              attempts: 2,
              outcome: 'omitted_new',
            },
          ],
        })
      ).toThrow(/record issue id is invalid/);
    }
  );

  it('preserves paired UTF-16 surrogate source IDs', () => {
    const result = sanitizeFullResumePhaseResult('items', {
      itemsProcessed: 1,
      stockRowsProcessed: 0,
      recordIssues: [
        {
          resource: 'item',
          id: 'item-\ud83d\ude00',
          code: 'not_found',
          message: 'untrusted',
          attempts: 2,
          outcome: 'omitted_new',
        },
      ],
    });

    expect(result.recordIssues[0].id).toBe('item-😀');
  });
});
