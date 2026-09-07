import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeContainerConfig } from './container-config.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

function databaseUrl(database: string): string {
  return ['postgres:', '', 'worker:password@database-host', database].join('/');
}

function enabledConfig(homeDirectory: string) {
  const config = validateSchedulerEnvironment({
    HOME: homeDirectory,
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'configured-account',
    SALESBINDER_SUBDOMAIN: 'configured-subdomain',
    SALESBINDER_API_KEY: 'configured-v2-credential',
    SALESBINDER_V3_API_KEY: 'configured-v3-credential',
    SALESBINDER_DB_URL: databaseUrl('cache'),
    SALESBINDER_CHANGE_FEED_DB_URL: databaseUrl('feed'),
    SALESBINDER_READ_BACKEND: 'postgresql',
  });
  if (config.disabled) throw new Error('Expected enabled configuration.');
  return config;
}

test('writes owner-only container config atomically', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salesbinder-bootstrap-'));
  writeContainerConfig(enabledConfig(home), { uniqueId: () => 'unique' });
  const configPath = path.join(home, '.salesbinder', 'config.json');
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
    defaultAccount: 'configured-account',
    accounts: {
      'configured-account': {
        subdomain: 'configured-subdomain',
        apiKey: 'configured-v2-credential',
        v3ApiKey: 'configured-v3-credential',
        apiVersion: '2.0',
        timeout: 30_000,
      },
    },
  });
  expect(fs.readdirSync(path.dirname(configPath))).toEqual(['config.json']);
});

test('writes a V3-only config without fabricating a V2 credential', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salesbinder-bootstrap-v3-'));
  const config = validateSchedulerEnvironment({
    HOME: home,
    SALESBINDER_SCHEDULER_DISABLED: 'false',
    SALESBINDER_ACCOUNT_NAME: 'configured-account',
    SALESBINDER_SUBDOMAIN: 'configured-subdomain',
    SALESBINDER_V3_API_KEY: 'configured-v3-credential',
    SALESBINDER_DB_URL: databaseUrl('cache'),
    SALESBINDER_READ_BACKEND: 'postgresql',
  });
  if (config.disabled) throw new Error('Expected enabled configuration.');
  writeContainerConfig(config, { uniqueId: () => 'unique' });
  const account = JSON.parse(
    fs.readFileSync(path.join(home, '.salesbinder', 'config.json'), 'utf8')
  ).accounts['configured-account'];
  expect(account).toMatchObject({
    subdomain: 'configured-subdomain',
    v3ApiKey: 'configured-v3-credential',
  });
  expect(account).not.toHaveProperty('apiKey');
});
