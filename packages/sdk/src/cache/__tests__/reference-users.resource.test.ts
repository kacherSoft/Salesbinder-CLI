import { ReferenceUsersResource } from '../reference-users.resource.js';
import { UsersResource } from '../../resources/users.resource.js';

const userA = '10000000-0000-4000-8000-000000000001';
const userB = '10000000-0000-4000-8000-000000000002';

describe('ReferenceUsersResource', () => {
  it('validates paginated users and derives synthetic display names from proven V2 shape', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: {
        users: [[{ id: userA, first_name: 'Sales', last_name: 'User A' }]],
        pagination: { count: '2', page: '1', pages: '2' },
      } })
      .mockResolvedValueOnce({ data: {
        users: [{ id: userB, firstname: 'Sales', lastname: 'User B' }],
        pagination: { count: '2', page: '2', pages: '2' },
      } });
    const resource = new ReferenceUsersResource(new UsersResource({ get } as never));

    await expect(resource.listDirectoryUsers()).resolves.toEqual([
      { userId: userA, displayName: 'Sales User A' },
      { userId: userB, displayName: 'Sales User B' },
    ]);
    expect(get).toHaveBeenNthCalledWith(1, '/users.json', { params: { page: 1, limit: 100 } });
    expect(get).toHaveBeenNthCalledWith(2, '/users.json', { params: { page: 2, limit: 100 } });
  });

  it('rejects duplicate or blank directory users', async () => {
    const get = jest.fn(async () => ({ data: {
      users: [
        { id: userA, name: 'Sales User A' },
        { id: userA, name: 'Sales User Again' },
      ],
      pagination: { count: 2, page: 1, pages: 1 },
    } }));
    const resource = new ReferenceUsersResource(new UsersResource({ get } as never));

    await expect(resource.listDirectoryUsers()).rejects.toThrow(/duplicate/i);
  });
});
