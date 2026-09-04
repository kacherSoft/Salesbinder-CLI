import { createRequire } from 'node:module';

const requireFromSdk = createRequire(new URL('../packages/sdk/package.json', import.meta.url));
const Database = requireFromSdk('better-sqlite3');
const database = new Database(':memory:');

try {
  const result = database.prepare('SELECT 1 AS healthy').get();
  if (result?.healthy !== 1) {
    throw new Error('SQLite runtime probe returned an unexpected result.');
  }
} finally {
  database.close();
}

await import('../packages/sdk/dist/index.js');
await import('../packages/cli/dist/index.js');

console.log('SalesBinder container runtime verified.');
