export const PAYMENT_TRANSACTION_COLUMNS = [
  'transaction_id',
  'doc_id',
  'amount',
  'transaction_date',
  'reference',
  'imported_at',
] as const;

export const PAYMENT_SYNC_STATUS_KEY = 'payment_sync_status';
// Official limit is 50 requests/minute and 15 requests/10 seconds. Sequential
// detail reads at this cadence leave headroom for document-list requests.
export const PAYMENT_DETAIL_DELAY_MS = 1_250;
