import type { AxiosInstance } from 'axios';
import { ApiResponseValidationError } from '../api-response-validation.error.js';
import { DocumentsResource } from '../documents.resource.js';

describe('DocumentsResource', () => {
  it('rejects a missing list body without exposing request configuration', async () => {
    const authorization = 'Bearer test-authorization-sentinel';
    const get = jest.fn().mockResolvedValue({
      data: null,
      config: { headers: { Authorization: authorization } },
    });
    const resource = new DocumentsResource({ get } as unknown as AxiosInstance);

    const error = await resource.list().catch((caught: unknown) => caught);

    expect(error).toEqual(
      new ApiResponseValidationError(
        'Invalid API response for documents list: expected a documents array'
      )
    );
    expect(String(error)).not.toContain(authorization);
  });

  it('rejects a missing detail body without exposing response payloads', async () => {
    const authorization = 'Basic test-authorization-sentinel';
    const get = jest.fn().mockResolvedValue({
      data: { config: { headers: { Authorization: authorization } } },
    });
    const resource = new DocumentsResource({ get } as unknown as AxiosInstance);

    const error = await resource.get('document-1').catch((caught: unknown) => caught);

    expect(error).toEqual(
      new ApiResponseValidationError(
        'Invalid API response for document document-1: expected a document body'
      )
    );
    expect(String(error)).not.toContain(authorization);
  });

  it('requires all pagination fields when any one is present', async () => {
    const resource = new DocumentsResource({
      get: jest.fn().mockResolvedValue({ data: { documents: [], count: '0' } }),
    } as unknown as AxiosInstance);

    await expect(resource.list()).rejects.toThrow('expected complete pagination');
  });

  it('encodes document IDs used as URL path segments', async () => {
    const get = jest.fn().mockResolvedValue({ data: { document: {} } });
    const resource = new DocumentsResource({ get } as unknown as AxiosInstance);

    await resource.get('document/with?reserved');

    expect(get).toHaveBeenCalledWith('/documents/document%2Fwith%3Freserved.json');
  });
});
