import path from 'node:path';
import { writePrivateJson, type PrivateJsonDependencies } from './private-json-file.js';
import type { SchedulerConfig } from './scheduler-config.js';

type EnabledConfig = Extract<SchedulerConfig, { disabled: false }>;

export function writeContainerConfig(
  config: EnabledConfig,
  dependencies: PrivateJsonDependencies = {}
): void {
  const targetPath = path.join(config.homeDirectory, '.salesbinder', 'config.json');
  writePrivateJson(
    targetPath,
    {
      defaultAccount: config.accountName,
      accounts: {
        [config.accountName]: {
          subdomain: config.subdomain,
          apiKey: config.apiKey,
          v3ApiKey: config.v3ApiKey,
          apiVersion: '2.0',
          timeout: 30_000,
        },
      },
    },
    dependencies
  );
}
