/**
 * Locations types for SalesBinder API
 */

import type { ListParams, ListResponse } from './common.types.js';

/** Location object */
export interface Location {
  id: string;
  name: string;
  short_name: string;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  manager: string | null;
  item_count: number;
  zone_count: number;
  zones: unknown[];
}

/** List parameters for locations */
export interface LocationListParams extends ListParams {}

/** List response for locations */
export interface LocationListResponse extends ListResponse {
  locations?: Location[][];
}
