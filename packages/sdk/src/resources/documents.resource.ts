/**
 * Documents (Invoices/Estimates/POs) resource for SalesBinder API
 */

import type { AxiosInstance } from 'axios';
import type {
  Document,
  CreateDocumentDto,
  UpdateDocumentDto,
  DocumentListParams,
  DocumentListResponse,
} from '../types/documents.types.js';
import { ApiResponseValidationError } from './api-response-validation.error.js';

/**
 * Documents resource class
 * Provides CRUD operations for documents (invoices, estimates, POs)
 */
export class DocumentsResource {
  constructor(private client: AxiosInstance) {}

  /**
   * List documents with optional filtering
   */
  async list(params?: DocumentListParams): Promise<DocumentListResponse> {
    const response = await this.client.get<DocumentListResponse>('/documents.json', { params });
    return validateDocumentListResponse(response.data);
  }

  /**
   * Get single document by ID
   */
  async get(id: string): Promise<Document> {
    const response = await this.client.get<{ document: Document }>(
      `/documents/${encodeURIComponent(id)}.json`
    );
    // Handle error responses that don't have the expected structure
    if (!response.data?.document) {
      throw new ApiResponseValidationError(
        `Invalid API response for document ${id}: expected a document body`
      );
    }
    return response.data.document;
  }

  /**
   * Create new document
   */
  async create(data: CreateDocumentDto): Promise<Document> {
    if (!data.context_id) {
      throw new Error('context_id is required (4=Estimate, 5=Invoice, 11=Purchase Order)');
    }
    const validContextIds = [4, 5, 11];
    if (!validContextIds.includes(data.context_id)) {
      throw new Error(
        `Invalid context_id: ${data.context_id}. Must be 4 (Estimate), 5 (Invoice), or 11 (Purchase Order)`
      );
    }
    if (!data.customer_id) {
      throw new Error('customer_id is required');
    }
    if (!data.issue_date) {
      throw new Error('issue_date is required (YYYY-MM-DD format)');
    }
    if (!data.document_items || data.document_items.length === 0) {
      throw new Error('document_items is required and must contain at least one item');
    }
    const response = await this.client.post<{ document: Document }>('/documents.json', {
      document: data,
    });
    return response.data.document;
  }

  /**
   * Update existing document
   */
  async update(id: string, data: UpdateDocumentDto): Promise<Document> {
    const response = await this.client.put<{ document: Document }>(
      `/documents/${encodeURIComponent(id)}.json`,
      { document: data }
    );
    return response.data.document;
  }

  /**
   * Delete document
   */
  async delete(id: string): Promise<void> {
    await this.client.delete(`/documents/${encodeURIComponent(id)}.json`);
  }
}

/** Validate the v2 list envelope without serializing response/config data. */
export function validateDocumentListResponse(value: unknown): DocumentListResponse {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    throw new ApiResponseValidationError(
      'Invalid API response for documents list: expected a documents array'
    );
  }
  const rows = value.documents as unknown[];
  const nested = rows.every(Array.isArray);
  const flat = rows.every(isRecord);
  if (!nested && !flat) {
    throw new ApiResponseValidationError(
      'Invalid API response for documents list: expected a consistent document array'
    );
  }
  for (const field of ['count', 'page', 'pages'] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isNonNegativeIntegerLike(fieldValue)) {
      throw new ApiResponseValidationError(
        'Invalid API response for documents list: expected numeric pagination'
      );
    }
  }
  const paginationFields = [value.count, value.page, value.pages];
  const paginationFieldCount = paginationFields.filter((field) => field !== undefined).length;
  if (paginationFieldCount !== 0 && paginationFieldCount !== paginationFields.length) {
    throw new ApiResponseValidationError(
      'Invalid API response for documents list: expected complete pagination'
    );
  }
  return value as unknown as DocumentListResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeIntegerLike(value: unknown): boolean {
  return (
    (typeof value === 'number' || typeof value === 'string') &&
    /^\d+$/.test(String(value)) &&
    Number.isSafeInteger(Number(value))
  );
}
