/**
 * Locations resource for SalesBinder API
 */

import type { AxiosInstance } from 'axios';
import type {
  Location,
  LocationListParams,
  LocationListResponse,
} from '../types/locations.types.js';

/**
 * Locations resource class
 */
export class LocationsResource {
  constructor(private client: AxiosInstance) {}

  /**
   * List locations with optional filtering
   */
  async list(params?: LocationListParams): Promise<LocationListResponse> {
    const response = await this.client.get<LocationListResponse>('/locations.json', { params });
    return response.data;
  }

  /**
   * Get single location by ID
   */
  async get(id: string): Promise<Location> {
    const response = await this.client.get<{ location: Location }>(`/locations/${id}.json`);
    return response.data.location;
  }
}
