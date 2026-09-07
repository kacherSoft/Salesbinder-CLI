import { DocumentRecordError } from '../document-source-validation.js';
import {
  SALESPERSON_DIRECTORY_SOURCE,
  normalizeSalespersonDirectory,
  resolveSalespersonNameForWrite,
  salespersonDirectoryMap,
  type SalespersonDirectoryInput,
} from '../salesperson-directory.js';
import type { DocumentRow } from '../types.js';

const userA = 'b16f844f-4b40-4f05-a468-407106563e03';
const userB = '1d3cf02c-d275-4488-b206-7f18a43a4a49';

const directoryInput = (): SalespersonDirectoryInput => ({
  accountIdentity: 'salesbinder:acme',
  source: SALESPERSON_DIRECTORY_SOURCE,
  fetchedAt: 1788670542,
  users: [
    { userId: userA, displayName: 'Sales User A' },
    { userId: userB, displayName: 'Sales User B' },
  ],
});

const doc = (patch: Partial<DocumentRow> = {}): DocumentRow => ({
  doc_id: 'doc',
  api_doc_id: 'doc',
  context_id: 5,
  doc_number: 1002,
  issue_date: '2026-09-07',
  customer_id: 'customer',
  modified: 1788670542,
  user_id: userA,
  ...patch,
});

describe('salesperson directory validation and document resolution', () => {
  it('normalizes a valid account-bound directory into an ID map', () => {
    const snapshot = normalizeSalespersonDirectory(directoryInput());
    expect(snapshot).toMatchObject({ version: 1, source: 'salesbinder_v2_users' });
    expect(salespersonDirectoryMap(snapshot).get(userA)).toBe('Sales User A');
  });

  it.each([
    { accountIdentity: 'acme' },
    { source: 'v2_users' },
    { fetchedAt: 0 },
    { users: [{ userId: userA, displayName: ' ' }] },
    { users: [{ userId: userA, displayName: 'Sales\u0000User' }] },
    { users: [{ userId: userA, displayName: 'Bad \ud800' }] },
    {
      users: [
        { userId: userA, displayName: 'A' },
        { userId: userA, displayName: 'B' },
      ],
    },
  ])('rejects invalid directory input %#', (patch) => {
    expect(() =>
      normalizeSalespersonDirectory({ ...directoryInput(), ...patch } as SalespersonDirectoryInput)
    ).toThrow(
      /salesperson directory is invalid/i
    );
  });

  it('uses the directory when V3 observes an assigned ID but omits the name', () => {
    expect(resolveSalespersonNameForWrite(doc(), undefined, normalizeSalespersonDirectory(directoryInput()))).toBe(
      'Sales User A'
    );
  });

  it('preserves the current name only when the omitted-name assignment is unchanged', () => {
    expect(
      resolveSalespersonNameForWrite(doc(), { user_id: userA, salesperson_name: 'Existing Name' }, null)
    ).toBe('Existing Name');
    expect(() =>
      resolveSalespersonNameForWrite(doc({ user_id: userB }), { user_id: userA, salesperson_name: 'Existing Name' }, null)
    ).toThrow(DocumentRecordError);
  });

  it('treats explicit unassignment and explicit legacy names as authoritative observations', () => {
    expect(resolveSalespersonNameForWrite(doc({ user_id: null }), { user_id: userA, salesperson_name: 'Old' }, null)).toBeNull();
    expect(
      resolveSalespersonNameForWrite(
        doc({ user_id: userB, salesperson_name: 'Legacy Exact Name' }),
        { user_id: userA, salesperson_name: 'Old' },
        null
      )
    ).toBe('Legacy Exact Name');
  });

  it('does not treat null or blank names as authoritative when an assignment remains', () => {
    const directory = normalizeSalespersonDirectory(directoryInput());
    expect(resolveSalespersonNameForWrite(doc({ salesperson_name: null }), undefined, directory)).toBe(
      'Sales User A'
    );
    expect(resolveSalespersonNameForWrite(doc({ salesperson_name: ' ' }), undefined, directory)).toBe(
      'Sales User A'
    );
  });

  it('rejects malformed explicit names before persistence and clears stale names on unassignment', () => {
    expect(() => resolveSalespersonNameForWrite(doc({ salesperson_name: 'Bad\u0000Name' }), undefined, null)).toThrow(
      DocumentRecordError
    );
    expect(() => resolveSalespersonNameForWrite(doc({ salesperson_name: 'Bad \ud800' }), undefined, null)).toThrow(
      DocumentRecordError
    );
    expect(resolveSalespersonNameForWrite(doc({ user_id: null, salesperson_name: 'Stale Name' }), undefined, null)).toBeNull();
  });

  it('fails record-local when an assigned omitted-name document cannot be resolved', () => {
    expect(() => resolveSalespersonNameForWrite(doc(), undefined, null)).toThrow(DocumentRecordError);
  });
});
