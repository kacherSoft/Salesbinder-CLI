/** Read-only SalesBinder API v3 account resources used by reference refresh. */

import type { AxiosInstance } from 'axios';
import { ContextId } from '../types/common.types.js';
import type { V3ListResponse } from '../types/items.types.js';
import { validateV3ListResponse } from './v3-items.resource.js';

export type V3AccountResourceName = 'customers' | 'prospects' | 'suppliers';

export interface V3AccountListParams {
  page?: number;
  limit?: number;
}

export interface V3Account {
  id: string;
  object: 'customer' | 'prospect' | 'supplier';
  customer_number?: number | null;
  name: string;
  office_email?: string | null;
  office_phone?: string | null;
  office_fax?: string | null;
  url?: string | null;
  billing_address_1?: string | null;
  billing_address_2?: string | null;
  billing_city?: string | null;
  billing_region?: string | null;
  billing_postal_code?: string | null;
  billing_country?: string | null;
  shipping_address_1?: string | null;
  shipping_address_2?: string | null;
  shipping_city?: string | null;
  shipping_region?: string | null;
  shipping_postal_code?: string | null;
  shipping_country?: string | null;
  vat_number?: string | null;
  archived?: boolean;
  last_invoice_date?: string | null;
  created_at?: string;
  updated_at?: string;
}

export const V3_ACCOUNT_RESOURCE_CONTEXT: Record<V3AccountResourceName, ContextId> = {
  customers: ContextId.Customer,
  prospects: ContextId.Prospect,
  suppliers: ContextId.Supplier,
};

export class V3AccountsResource {
  constructor(private readonly client: AxiosInstance) {}

  async list(
    resource: V3AccountResourceName,
    params?: V3AccountListParams
  ): Promise<V3ListResponse<V3Account>> {
    const response = await this.client.get<unknown>(`/${resource}`, { params });
    return validateV3ListResponse<V3Account>(response.data, resource);
  }
}
