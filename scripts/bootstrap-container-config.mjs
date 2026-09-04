import fs from 'node:fs';
import path from 'node:path';

const credentialNames = ['SALESBINDER_SUBDOMAIN', 'SALESBINDER_API_KEY', 'SALESBINDER_V3_API_KEY'];

if (process.env.SALESBINDER_SCHEDULER_DISABLED === 'true') {
  console.log('SalesBinder scheduler is explicitly disabled.');
  process.exit(0);
}

const missingNames = credentialNames.filter((name) => !process.env[name]?.trim());
if (missingNames.length > 0) {
  throw new Error(`Missing required scheduler environment variables: ${missingNames.join(', ')}`);
}

const accountName =
  process.env.SALESBINDER_ACCOUNT_NAME?.trim() || process.env.SALESBINDER_SUBDOMAIN.trim();
const configDirectory = path.join(process.env.HOME, '.salesbinder');
const configPath = path.join(configDirectory, 'config.json');
const temporaryPath = path.join(configDirectory, `.config.${process.pid}.tmp`);
const config = {
  defaultAccount: accountName,
  accounts: {
    [accountName]: {
      subdomain: process.env.SALESBINDER_SUBDOMAIN.trim(),
      apiKey: process.env.SALESBINDER_API_KEY.trim(),
      v3ApiKey: process.env.SALESBINDER_V3_API_KEY.trim(),
      apiVersion: '2.0',
      timeout: 30_000,
    },
  },
};

fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });

try {
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, configPath);
  fs.chmodSync(configPath, 0o600);
  console.log('SalesBinder config initialized.');
} finally {
  fs.rmSync(temporaryPath, { force: true });
}
