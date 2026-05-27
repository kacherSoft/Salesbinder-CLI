import { readFile } from 'fs/promises';
import type { CsvRow, ParsedCsvFile } from './csv-cache-import.types.js';

export async function parseCsvFile(filePath: string, requiredHeaders: string[]): Promise<ParsedCsvFile> {
  const content = await readFile(filePath, 'utf8');
  const rows = parseCsv(content);
  if (rows.length === 0) {
    throw new Error(`CSV file is empty: ${filePath}`);
  }

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, '').trim());
  validateHeaders(headers, requiredHeaders, filePath);

  return {
    headers,
    rows: rows.slice(1)
      .filter((row) => row.some((value) => value.trim() !== ''))
      .map((row) => rowToObject(headers, row)),
  };
}

export function validateHeaders(headers: string[], requiredHeaders: string[], filePath: string): void {
  const headerSet = new Set(headers);
  const missing = requiredHeaders.filter((header) => !headerSet.has(header));
  if (missing.length > 0) {
    throw new Error(`CSV header mismatch in ${filePath}: missing ${missing.join(', ')}`);
  }
}

function rowToObject(headers: string[], values: string[]): CsvRow {
  const row: CsvRow = {};
  headers.forEach((header, index) => {
    row[header] = values[index] ?? '';
  });
  return row;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
