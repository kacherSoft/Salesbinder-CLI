/**
 * Customers (Accounts) types for SalesBinder API
 */

import type { ListParams, ListResponse, ContextId } from './common.types.js';

/** Customer resource */
export interface Customer {
  id: string;
  context_id: ContextId;
  customer_number: number;
  name: string;
  office_email?: string;
  office_phone?: string;
  office_fax?: string;
  url?: string;
  billing_address_1?: string;
  billing_address_2?: string;
  billing_city?: string;
  billing_region?: string;
  billing_country?: string;
  billing_postal_code?: string;
  shipping_address_1?: string;
  shipping_address_2?: string;
  shipping_city?: string;
  shipping_region?: string;
  shipping_country?: string;
  shipping_postal_code?: string;
  created: string;
  modified: string;
}

/** Create customer DTO */
export interface CreateCustomerDto {
  context_id: number;
  name: string;
  office_email?: string;
  office_phone?: string;
  office_fax?: string;
  url?: string;
  billing_address_1?: string;
  billing_address_2?: string;
  billing_city?: string;
  billing_region?: string;
  billing_country?: string;
  billing_postal_code?: string;
  shipping_address_1?: string;
  shipping_address_2?: string;
  shipping_city?: string;
  shipping_region?: string;
  shipping_country?: string;
  shipping_postal_code?: string;
}

/** Update customer DTO */
export interface UpdateCustomerDto extends Partial<CreateCustomerDto> {}

/** List parameters for customers */
export interface CustomerListParams extends ListParams {
  contextId?: ContextId;
}

/** List response for customers */
export interface CustomerListResponse extends ListResponse {
  customers?: Customer[];
}
