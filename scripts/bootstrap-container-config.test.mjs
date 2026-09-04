import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./bootstrap-container-config.mjs', import.meta.url));

function runBootstrap(home, overrides = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...overrides,
    },
  });
}

test('writes an atomic owner-only config without logging credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salesbinder-bootstrap-'));
  const result = runBootstrap(home, {
    SALESBINDER_ACCOUNT_NAME: 'phuthaitech',
    SALESBINDER_SUBDOMAIN: 'phuthaitech',
    SALESBINDER_API_KEY: 'private-v2-value',
    SALESBINDER_V3_API_KEY: 'private-v3-value',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-v[23]-value/);

  const configPath = path.join(home, '.salesbinder', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(config, {
    defaultAccount: 'phuthaitech',
    accounts: {
      phuthaitech: {
        subdomain: 'phuthaitech',
        apiKey: 'private-v2-value',
        v3ApiKey: 'private-v3-value',
        apiVersion: '2.0',
        timeout: 30_000,
      },
    },
  });
});

test('fails closed when the scheduler is enabled with incomplete credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salesbinder-bootstrap-'));
  const result = runBootstrap(home, {
    SALESBINDER_SUBDOMAIN: 'phuthaitech',
    SALESBINDER_API_KEY: '   ',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SALESBINDER_API_KEY/);
  assert.match(result.stderr, /SALESBINDER_V3_API_KEY/);
  assert.doesNotMatch(result.stderr, /phuthaitech/);
  assert.equal(fs.existsSync(path.join(home, '.salesbinder', 'config.json')), false);
});

test('allows an intentionally disabled scheduler without credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salesbinder-bootstrap-'));
  const result = runBootstrap(home, { SALESBINDER_SCHEDULER_DISABLED: 'true' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /explicitly disabled/);
  assert.equal(fs.existsSync(path.join(home, '.salesbinder', 'config.json')), false);
});
