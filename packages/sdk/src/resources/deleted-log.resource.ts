import type { AxiosInstance } from 'axios';
import type { DeletedLogListParams, DeletedLogListResponse } from '../types/deleted-log.types.js';

export class DeletedLogResource {
  constructor(private client: AxiosInstance) {}

  async list(params?: DeletedLogListParams): Promise<DeletedLogListResponse> {
    const response = await this.client.get<DeletedLogListResponse>('/deleted_log.json', { params });
    return response.data;
  }
}
