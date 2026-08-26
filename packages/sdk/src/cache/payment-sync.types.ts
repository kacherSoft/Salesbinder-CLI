export interface PaymentTransactionRow {
  transaction_id: string;
  doc_id: string;
  amount: number;
  transaction_date: string;
  reference?: string | null;
  imported_at: number;
}

export type PaymentSyncMode = 'full' | 'delta';
export type PaymentSyncState = 'backfilling' | 'complete' | 'failed';

export interface PaymentSyncStatus {
  status: PaymentSyncState;
  mode: PaymentSyncMode;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastSuccessfulSync?: number;
  cursor: string | null;
  snapshotHash?: string;
  processedDocuments: number;
  totalDocuments: number;
  error?: string;
}

export interface PaymentSyncResult {
  success: boolean;
  mode: PaymentSyncMode;
  resumed: boolean;
  documentsProcessed: number;
  totalDocuments: number;
  transactionsProcessed: number;
  duration: string;
  cursor: string | null;
}
