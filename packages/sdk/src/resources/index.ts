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
import { DeletedLogResource } from './deleted-log.resource.js';
import { createV3AxiosClient } from '../client/v3-axios.factory.js';
import { V3ItemsResource } from './v3-items.resource.js';
import { V3CategoriesResource } from './v3-categories.resource.js';

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
  /** Deleted log resource */
  readonly deletedLog: DeletedLogResource;

  constructor(accountName?: string) {
    const account = loadConfig(accountName);
    const client = createAxiosClient(account);

    this.items = new ItemsResource(client);
    this.customers = new CustomersResource(client);
    this.documents = new DocumentsResource(client);
    this.locations = new LocationsResource(client);
    this.categories = new CategoriesResource(client);
    this.deletedLog = new DeletedLogResource(client);
  }
}

/** Read-only API v3 client used for inventory and category snapshots. */
export class SalesBinderV3Client {
  readonly items: V3ItemsResource;
  readonly categories: V3CategoriesResource;

  constructor(accountName?: string) {
    const account = loadConfig(accountName);
    if (!account.v3ApiKey) {
      throw new Error('SalesBinder API v3 key is not configured for this account');
    }
    const client = createV3AxiosClient(account);
    this.items = new V3ItemsResource(client);
    this.categories = new V3CategoriesResource(client);
  }
}

// Re-export types for convenience
export * from '../types/common.types.js';
export * from '../types/items.types.js';
export * from '../types/customers.types.js';
export * from '../types/documents.types.js';
export * from '../types/locations.types.js';
export * from '../types/categories.types.js';
export * from '../types/deleted-log.types.js';
export * from '../config/config.schema.js';
