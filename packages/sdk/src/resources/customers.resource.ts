/**
 * Customers (Accounts) resource for SalesBinder API
 */

import type { AxiosInstance } from 'axios';
import type {
  Customer,
  CreateCustomerDto,
  UpdateCustomerDto,
  CustomerListParams,
  CustomerListResponse,
} from '../types/customers.types.js';

/**
 * Customers resource class
 * Provides CRUD operations for customer accounts
 */
export class CustomersResource {
  constructor(private client: AxiosInstance) {}

  /**
   * List customers with optional filtering
   */
  async list(params?: CustomerListParams): Promise<CustomerListResponse> {
    const response = await this.client.get<CustomerListResponse>('/customers.json', { params });
    return response.data;
  }

  /**
   * Get single customer by ID
   */
  async get(id: string): Promise<Customer> {
    const response = await this.client.get<{ customer: Customer }>(`/customers/${id}.json`);
    return response.data.customer;
  }

  /**
   * Create new customer
   */
  async create(data: CreateCustomerDto): Promise<Customer> {
    if (!data.context_id) {
      throw new Error('context_id is required (2=Customer, 8=Prospect, 10=Supplier)');
    }
    const validContextIds = [2, 8, 10];
    if (!validContextIds.includes(data.context_id)) {
      throw new Error(
        `Invalid context_id: ${data.context_id}. Must be 2 (Customer), 8 (Prospect), or 10 (Supplier)`
      );
    }
    const response = await this.client.post<{ customer: Customer }>(
      '/customers.json',
      { customer: data }
    );
    return response.data.customer;
  }

  /**
   * Update existing customer
   */
  async update(id: string, data: UpdateCustomerDto): Promise<Customer> {
    const response = await this.client.put<{ customer: Customer }>(
      `/customers/${id}.json`,
      { customer: data }
    );
    return response.data.customer;
  }

  /**
   * Delete customer
   */
  async delete(id: string): Promise<void> {
    await this.client.delete(`/customers/${id}.json`);
  }
}
