import { createRequire } from 'node:module';

const requireFromSdk = createRequire(new URL('../../sdk/package.json', import.meta.url));
const Database = requireFromSdk('better-sqlite3') as new (filename: string) => {
  prepare(sql: string): { get(): { healthy?: number } | undefined };
  close(): void;
};
const database = new Database(':memory:');

try {
  const result = database.prepare('SELECT 1 AS healthy').get();
  if (result?.healthy !== 1) {
    throw new Error('SQLite runtime probe returned an unexpected result.');
  }
} finally {
  database.close();
}

await import('@salesbinder/sdk');
await import('@salesbinder/cli');

console.log('SalesBinder container runtime verified.');
