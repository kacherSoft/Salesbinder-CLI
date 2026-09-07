/** Read-only SalesBinder v2 users resource used by explicit reference refresh. */

import type { AxiosInstance } from 'axios';
import type { SalesBinderUsersListResponse } from '../types/users.types.js';

export interface UsersListParams {
  page?: number;
  limit?: number;
}

export class UsersResource {
  constructor(private readonly client: AxiosInstance) {}

  async list(params?: UsersListParams): Promise<SalesBinderUsersListResponse> {
    const response = await this.client.get<SalesBinderUsersListResponse>('/users.json', {
      params,
    });
    return response.data;
  }
}
