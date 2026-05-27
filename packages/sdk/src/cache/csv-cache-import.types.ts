export type CsvRow = Record<string, string>;

export interface CsvImportOptions {
  dryRun?: boolean;
  accountName: string;
}

export interface CsvImportWarnings {
  unmatched_account_names: number;
  ambiguous_account_names: number;
  unmatched_item_numbers: number;
}

export interface CsvImportResult {
  success: boolean;
  mode: 'dry_run' | 'import';
  files_checked: number;
  accounts: {
    customers: number;
    suppliers: number;
    total: number;
  };
  documents: {
    invoices: number;
    purchase_orders: number;
    total: number;
  };
  line_items: {
    invoice_lines: number;
    po_lines: number;
    total: number;
  };
  items: {
    item_rows: number;
    stock_location_rows: number;
    locations: number;
    categories: number;
  };
  warnings: CsvImportWarnings;
  duration: string;
}

export interface ParsedCsvFile {
  headers: string[];
  rows: CsvRow[];
}
