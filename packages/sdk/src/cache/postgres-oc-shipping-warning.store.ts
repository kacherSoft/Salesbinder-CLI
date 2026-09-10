import type { PoolClient } from 'pg';

export interface OCShippingWarning {
  contextId: 4 | 5;
  documentId: string;
  code: 'shipping_unknown';
  updatedAt: number;
}

const PREFIX = 'oc_shipping.warning.v1:';

export async function readOCShippingWarnings(client: PoolClient): Promise<readonly OCShippingWarning[]> {
  const result = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key`, [PREFIX]
  );
  return result.rows.map(({ key, value }) => {
    const warning = parseWarning(value);
    if (key !== warningKey(warning.contextId, warning.documentId)) {
      throw new Error('Invalid persisted OC shipping warning identity.');
    }
    return warning;
  });
}

export async function writeOCShippingWarning(client: PoolClient, warning: OCShippingWarning): Promise<void> {
  assertWarning(warning);
  await client.query(
    `INSERT INTO cache_meta(key, value) VALUES($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [warningKey(warning.contextId, warning.documentId), JSON.stringify(warning)]
  );
}

export async function deleteOCShippingWarning(
  client: PoolClient,
  contextId: 4 | 5,
  documentId: string
): Promise<void> {
  assertIdentity(contextId, documentId);
  await client.query(`DELETE FROM cache_meta WHERE key = $1`, [warningKey(contextId, documentId)]);
}

function warningKey(contextId: 4 | 5, documentId: string): string {
  return `${PREFIX}${contextId}:${documentId}`;
}

function parseWarning(value: string): OCShippingWarning {
  try {
    const warning = JSON.parse(value) as OCShippingWarning;
    assertWarning(warning);
    return warning;
  } catch {
    throw new Error('Invalid persisted OC shipping warning.');
  }
}

function assertWarning(value: OCShippingWarning): void {
  if (!value || value.code !== 'shipping_unknown' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw new Error('Invalid OC shipping warning.');
  }
  assertIdentity(value.contextId, value.documentId);
}

function assertIdentity(contextId: unknown, documentId: unknown): asserts contextId is 4 | 5 {
  if (
    (contextId !== 4 && contextId !== 5) ||
    typeof documentId !== 'string' ||
    documentId.length === 0 ||
    documentId.includes('\0')
  ) {
    throw new Error('Invalid OC shipping warning identity.');
  }
}
