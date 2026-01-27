/**
 * SalesBinder SDK - Main entry point
 */

import { createAxiosClient } from '../client/axios.factory.js';
import { loadConfig } from '../config/config.loader.js';
import { ItemsResource } from './items.resource.js';
import { CustomersResource } from './customers.resource.js';
import { DocumentsResource } from './documents.resource.js';
import { LocationsResource } from './locations.resource.js';
import { CategoriesResource } from './categories.resource.js';

/**
 * SalesBinder SDK client
 * Provides access to all API resources
 */
export class SalesBinderClient {
  /** Items resource */
  readonly items: ItemsResource;
  /** Customers resource */
  readonly customers: CustomersResource;
  /** Documents resource */
  readonly documents: DocumentsResource;
  /** Locations resource */
  readonly locations: LocationsResource;
  /** Categories resource */
  readonly categories: CategoriesResource;

  constructor(accountName?: string) {
    const account = loadConfig(accountName);
    const client = createAxiosClient(account);

    this.items = new ItemsResource(client);
    this.customers = new CustomersResource(client);
    this.documents = new DocumentsResource(client);
    this.locations = new LocationsResource(client);
    this.categories = new CategoriesResource(client);
  }
}

// Re-export types for convenience
export * from '../types/common.types.js';
export * from '../types/items.types.js';
export * from '../types/customers.types.js';
export * from '../types/documents.types.js';
export * from '../types/locations.types.js';
export * from '../types/categories.types.js';
export * from '../config/config.schema.js';
