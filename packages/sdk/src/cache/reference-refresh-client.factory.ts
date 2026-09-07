import type { AccountConfig, V3AccountConfig } from '../config/config.schema.js';
import { createAxiosClient } from '../client/axios.factory.js';
import { createV3AxiosClient } from '../client/v3-axios.factory.js';
import type { ClientRuntimeOptions } from '../client/salesbinder-rate-limiter.js';
import { V3AccountsResource } from '../resources/v3-accounts.resource.js';
import { V3CategoriesResource } from '../resources/v3-categories.resource.js';
import { UsersResource } from '../resources/users.resource.js';
import { ReferenceRefreshService, type ReferenceRefreshCache } from './reference-refresh.service.js';
import { ReferenceUsersResource } from './reference-users.resource.js';

export type ReferenceRefreshAccountConfig = V3AccountConfig & Partial<Pick<AccountConfig, 'apiKey'>>;

export function createReferenceRefreshService(
  account: ReferenceRefreshAccountConfig,
  cache: ReferenceRefreshCache,
  runtimeOptions: ClientRuntimeOptions = {},
  guard?: () => void | Promise<void>
): ReferenceRefreshService {
  const v3Client = createV3AxiosClient(account, runtimeOptions);
  const v2Users =
    typeof account.apiKey === 'string' && account.apiKey.trim()
      ? new ReferenceUsersResource(
          new UsersResource(createAxiosClient(account as AccountConfig, runtimeOptions))
        )
      : undefined;
  return new ReferenceRefreshService({
    cache,
    categories: { categories: new V3CategoriesResource(v3Client) },
    accounts: new V3AccountsResource(v3Client),
    users: v2Users,
    guard,
  });
}
