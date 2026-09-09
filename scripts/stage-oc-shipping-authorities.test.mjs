import assert from 'node:assert/strict';
import test from 'node:test';
import {
  V2_STAGE_PATH,
  classifyError,
  selectInvoiceAuthorities,
  validateProgress,
} from './stage-oc-shipping-authorities.mjs';

const OC = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';
const OTHER_INVOICE = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const OTHER_CUSTOMER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = 'salesbinder:phuthaitech';

function v2Stage({ invoiceCustomer = CUSTOMER, reciprocal = OC, percent = null } = {}) {
  return {
    version: 1,
    source: 'salesbinder_v2_documents_list',
    coverage: 'active_list_only',
    complete: true,
    accountIdentity: ACCOUNT,
    contexts: {
      4: { documents: [{ id: OC, associatedDocumentId: INVOICE, customerId: CUSTOMER }, { id: OTHER_INVOICE, associatedDocumentId: null, customerId: CUSTOMER }] },
      5: { documents: [{ id: INVOICE, associatedDocumentId: reciprocal, customerId: invoiceCustomer, shippedPercentObserved: percent !== undefined, shippedPercent: percent }] },
    },
  };
}

function progress() {
  return {
    version: 1,
    source: 'salesbinder_v3_invoice_authorities',
    accountIdentity: ACCOUNT,
    v2StagePath: V2_STAGE_PATH,
    selectedAt: 1,
    requestedIds: [INVOICE, OTHER_INVOICE],
    authorities: [{ id: INVOICE, source: { id: INVOICE, kind: 'invoice' } }],
    outcomes: [
      { invoiceId: INVOICE, status: 'authority' },
      { invoiceId: OTHER_INVOICE, status: 'issue:not_found' },
    ],
    complete: false,
  };
}

test('selects reciprocal same-customer invoices even when V2 header values are missing or invalid', () => {
  assert.deepEqual(selectInvoiceAuthorities(v2Stage(), ACCOUNT).requestedIds, [INVOICE]);
  assert.deepEqual(selectInvoiceAuthorities(v2Stage({ percent: 101 }), ACCOUNT).requestedIds, [INVOICE]);
  assert.deepEqual(selectInvoiceAuthorities(v2Stage({ percent: undefined }), ACCOUNT).requestedIds, [INVOICE]);
  assert.deepEqual(selectInvoiceAuthorities(v2Stage({ reciprocal: null }), ACCOUNT).requestedIds, []);
  assert.deepEqual(selectInvoiceAuthorities(v2Stage({ invoiceCustomer: OTHER_CUSTOMER }), ACCOUNT).requestedIds, []);
});

test('keeps retry exhaustion and transport errors resumable while naming safe record outcomes', () => {
  assert.equal(classifyError({ response: { status: 429 } }), null);
  assert.equal(classifyError({ response: { status: 401 } }), null);
  assert.equal(classifyError({ response: { status: 500 } }), null);
  assert.equal(classifyError({ response: { status: 400 } }), 'source_client_error');
  assert.equal(classifyError({ response: { status: 404 } }), 'not_found');
  assert.equal(classifyError({ name: 'OCShippingContractError' }), 'invalid_record');
});

test('validates one-to-one checkpoint sources and permits only a request-set extension', () => {
  assert.equal(validateProgress(progress(), ACCOUNT, [INVOICE, OTHER_INVOICE, OC]).outcomes.length, 2);
  assert.throws(() => validateProgress(progress(), ACCOUNT, [INVOICE]));
  const duplicate = progress();
  duplicate.outcomes.push({ invoiceId: INVOICE, status: 'authority' });
  assert.throws(() => validateProgress(duplicate, ACCOUNT, [INVOICE, OTHER_INVOICE]));
  const missingSource = progress();
  missingSource.authorities = [];
  assert.throws(() => validateProgress(missingSource, ACCOUNT, [INVOICE, OTHER_INVOICE]));
});

test('rejects malformed account-bound checkpoint metadata', () => {
  const invalid = progress();
  invalid.accountIdentity = 'salesbinder:other';
  assert.throws(() => validateProgress(invalid, ACCOUNT, [INVOICE, OTHER_INVOICE]));
  invalid.accountIdentity = ACCOUNT;
  invalid.v2StagePath = '/tmp/other.json';
  assert.throws(() => validateProgress(invalid, ACCOUNT, [INVOICE, OTHER_INVOICE]));
});
