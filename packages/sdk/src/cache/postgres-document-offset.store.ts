import type { PoolClient } from 'pg';
import type {
  DocumentOffsetRun,
  DocumentOffsetStore,
  DocumentOffsetTask,
  OffsetTaskKind,
} from './document-offset-sync.types.js';
import type { DocumentRow, ItemDocumentRow, ItemRow, ItemStockLocationRow } from './types.js';
import { assertCanonicalV3SourceId } from './v3-inventory-source-validation.js';
import {
  OFFSET_CURRENT_KEY,
  offsetRunKey,
  offsetTaskKey,
  offsetTaskPrefix,
  assertOffsetRun,
  assertOffsetRunId,
  assertOffsetKind,
  assertOffsetTask,
  assertOffsetTimestamp,
} from './postgres-document-offset.validation.js';

type Transaction = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
export interface PostgresDocumentOffsetOptions {
  withVerifiedWrite: Transaction;
  withReadOnlyTransaction: Transaction;
  accountIdentity: () => string;
  resolveDocument: (client: PoolClient, doc: DocumentRow) => Promise<DocumentRow>;
  writeDocument: (
    client: PoolClient,
    doc: DocumentRow,
    lines: Omit<ItemDocumentRow, 'id'>[]
  ) => Promise<void>;
  validateInventory: (item: ItemRow, rows: ItemStockLocationRow[]) => void;
  writeInventory: (
    client: PoolClient,
    item: ItemRow,
    rows: ItemStockLocationRow[]
  ) => Promise<void>;
}

export class PostgresDocumentOffsetStore implements DocumentOffsetStore {
  constructor(private readonly options: PostgresDocumentOffsetOptions) {}

  async getOffsetSyncRun(): Promise<DocumentOffsetRun | null> {
    return this.options.withReadOnlyTransaction((client) => this.readRun(client));
  }

  async saveOffsetSyncRun(run: DocumentOffsetRun): Promise<void> {
    assertOffsetRun(run);
    this.assertAccount(run);
    await this.options.withVerifiedWrite(async (client) => {
      const current = await this.readRun(client);
      if (current?.runId === run.runId) {
        if (
          current.startedAt !== run.startedAt ||
          current.cutoff !== run.cutoff ||
          current.days !== run.days ||
          current.updatedAt > run.updatedAt
        ) {
          throw new Error('Offset run immutable state or progress conflicts.');
        }
        if (current.discoveryComplete && !run.discoveryComplete) {
          const result = await client.query<{ value: string }>(
            'SELECT key, value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key',
            [offsetTaskPrefix(run.runId, 'document')]
          );
          const canRediscover = result.rows.some((row) => {
            const task = parseJson(row.value) as DocumentOffsetTask;
            assertOffsetTask('document', task);
            return task.status === 'failed' && task.errorCode === 'invalid_selection_record';
          });
          if (!canRediscover) throw new Error('Offset discovery completion cannot move backwards.');
        }
      } else {
        if (current && current.status !== 'success')
          throw new Error('An incomplete offset run must be resumed.');
        if (await readJson(client, offsetRunKey(run.runId)))
          throw new Error('Offset run ID already exists.');
        if (run.status !== 'running') throw new Error('New offset run must be running.');
      }
      if (run.status === 'success') {
        const result = await client.query<{ key: string; value: string }>(
          'SELECT key, value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key',
          [`document_offset_sync.task.v1:${run.runId}:`]
        );
        const tasks = result.rows.map((row) => {
          const task = parseJson(row.value) as DocumentOffsetTask;
          const kind = row.key.startsWith(offsetTaskPrefix(run.runId, 'document'))
            ? 'document'
            : 'item';
          assertOffsetTask(kind, task);
          if (row.key !== offsetTaskKey(run.runId, kind, task))
            throw new Error('Invalid persisted offset task identity.');
          return task;
        });
        if (!run.discoveryComplete || tasks.some((task) => task.status !== 'done')) {
          throw new Error('Offset success requires completed discovery and tasks.');
        }
      }
      await putJson(client, offsetRunKey(run.runId), run);
      await putJson(client, OFFSET_CURRENT_KEY, run);
    });
  }

  async listOffsetSyncTasks(runId: string, kind: OffsetTaskKind): Promise<DocumentOffsetTask[]> {
    assertOffsetRunId(runId);
    assertOffsetKind(kind);
    return this.options.withReadOnlyTransaction(async (client) => {
      await this.requireRun(client, runId);
      const prefix = offsetTaskPrefix(runId, kind);
      const result = await client.query<{ key: string; value: string }>(
        'SELECT key, value FROM cache_meta WHERE starts_with(key, $1) ORDER BY key',
        [prefix]
      );
      return result.rows.map((row) => {
        const task = parseJson(row.value) as DocumentOffsetTask;
        assertOffsetTask(kind, task);
        if (row.key !== offsetTaskKey(runId, kind, task))
          throw new Error('Invalid persisted offset task identity.');
        return task;
      });
    });
  }

  async saveOffsetSyncTasks(
    runId: string,
    kind: OffsetTaskKind,
    tasks: DocumentOffsetTask[]
  ): Promise<void> {
    assertOffsetRunId(runId);
    assertOffsetKind(kind);
    tasks.forEach((task) => assertOffsetTask(kind, task));
    await this.options.withVerifiedWrite(async (client) => {
      await this.requireRun(client, runId, true);
      for (const task of tasks) {
        const prior = await this.readTask(client, runId, kind, task);
        // Enumeration restarts from page one: never undo completed work for the same version.
        if (
          prior &&
          prior.errorCode !== 'invalid_selection_record' &&
          task.status === 'pending' &&
          task.attempts === 0 &&
          prior.selectedModified === task.selectedModified &&
          prior.documentNumber === task.documentNumber
        )
          continue;
        const next = { ...task, attempts: Math.max(prior?.attempts ?? 0, task.attempts) };
        if (
          prior &&
          kind === 'document' &&
          task.documentNumber !== undefined &&
          task.selectedModified !== undefined &&
          (prior.selectedModified !== task.selectedModified ||
            prior.documentNumber !== task.documentNumber)
        ) {
          next.status = 'pending';
          delete next.errorCode;
        }
        await putJson(client, offsetTaskKey(runId, kind, task), next);
      }
    });
  }

  async applyOffsetDocumentBundle(
    runId: string,
    task: DocumentOffsetTask,
    document: DocumentRow,
    lines: Omit<ItemDocumentRow, 'id'>[],
    refreshNotBefore: number
  ): Promise<void> {
    assertOffsetTask('document', task, true);
    assertOffsetTimestamp(refreshNotBefore);
    if (
      document.api_doc_id !== task.id ||
      document.context_id !== task.contextId ||
      document.doc_number !== task.documentNumber ||
      document.cache_source !== 'api' ||
      lines.some((line) => line.doc_id !== document.doc_id)
    )
      throw new Error('Offset document bundle identity mismatch.');
    assertCanonicalV3SourceId(document.doc_id, 'offset document');
    lines.forEach((line) => assertCanonicalV3SourceId(line.item_id, 'offset line item'));
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, 'document', task);
      const resolved = await this.options.resolveDocument(client, document);
      const old = await client.query<{ item_id: string }>(
        'SELECT item_id FROM item_documents WHERE doc_id = $1',
        [resolved.doc_id]
      );
      for (const id of new Set([
        ...old.rows.map((row) => row.item_id),
        ...lines.map((line) => line.item_id),
      ])) {
        const itemTask: DocumentOffsetTask = { id, status: 'pending', attempts: 0 };
        assertOffsetTask('item', itemTask);
        const prior = await this.readTask(client, runId, 'item', itemTask);
        await putJson(client, offsetTaskKey(runId, 'item', itemTask), {
          ...itemTask,
          attempts: prior?.attempts ?? 0,
          verifyAfter: Math.max(prior?.verifyAfter ?? 0, refreshNotBefore),
        });
      }
      await this.options.writeDocument(
        client,
        resolved,
        lines.map((line) => ({ ...line, doc_id: resolved.doc_id }))
      );
      await this.complete(client, runId, 'document', task, persisted);
    });
  }

  async applyOffsetInventoryBundle(
    runId: string,
    task: DocumentOffsetTask,
    item: ItemRow,
    rows: ItemStockLocationRow[]
  ): Promise<void> {
    assertOffsetTask('item', task);
    if (task.id !== item.item_id) throw new Error('Offset inventory task identity mismatch.');
    this.options.validateInventory(item, rows);
    await this.options.withVerifiedWrite(async (client) => {
      const persisted = await this.requireTask(client, runId, 'item', task);
      await this.options.writeInventory(client, item, rows);
      await this.complete(client, runId, 'item', task, persisted);
    });
  }

  private async readRun(client: PoolClient): Promise<DocumentOffsetRun | null> {
    const run = (await readJson(client, OFFSET_CURRENT_KEY)) as DocumentOffsetRun | null;
    if (run !== null) {
      assertOffsetRun(run);
      this.assertAccount(run);
    }
    return run;
  }

  private assertAccount(run: DocumentOffsetRun): void {
    if (run.accountIdentity !== this.options.accountIdentity())
      throw new Error('Offset account binding mismatch.');
  }

  private async requireRun(client: PoolClient, runId: string, writing = false): Promise<void> {
    assertOffsetRunId(runId);
    const run = await this.readRun(client);
    if (!run || run.runId !== runId || (writing && run.status !== 'running'))
      throw new Error('Offset run is not current and active.');
  }

  private async readTask(
    client: PoolClient,
    runId: string,
    kind: OffsetTaskKind,
    task: DocumentOffsetTask
  ): Promise<DocumentOffsetTask | null> {
    const prior = (await readJson(
      client,
      offsetTaskKey(runId, kind, task)
    )) as DocumentOffsetTask | null;
    if (prior !== null) {
      assertOffsetTask(kind, prior);
      if (prior.id !== task.id || prior.contextId !== task.contextId)
        throw new Error('Offset task storage identity mismatch.');
    }
    return prior;
  }

  private async requireTask(
    client: PoolClient,
    runId: string,
    kind: OffsetTaskKind,
    task: DocumentOffsetTask
  ): Promise<DocumentOffsetTask> {
    await this.requireRun(client, runId, true);
    const prior = await this.readTask(client, runId, kind, task);
    if (
      !prior ||
      prior.selectedModified !== task.selectedModified ||
      prior.documentNumber !== task.documentNumber
    ) {
      throw new Error('Offset task does not match persisted work.');
    }
    return prior;
  }

  private async complete(
    client: PoolClient,
    runId: string,
    kind: OffsetTaskKind,
    task: DocumentOffsetTask,
    prior: DocumentOffsetTask
  ): Promise<void> {
    const done = { ...prior, status: 'done', attempts: Math.max(prior.attempts, task.attempts) };
    delete done.errorCode;
    await putJson(client, offsetTaskKey(runId, kind, task), done);
  }
}

async function readJson(client: PoolClient, key: string): Promise<unknown> {
  const result = await client.query<{ value: string }>(
    'SELECT value FROM cache_meta WHERE key = $1',
    [key]
  );
  return result.rows[0] ? parseJson(result.rows[0].value) : null;
}

function parseJson(value: string): unknown {
  try {
    const result: unknown = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new Error('Invalid persisted offset state.');
  }
}

async function putJson(client: PoolClient, key: string, value: unknown): Promise<void> {
  await client.query(
    'INSERT INTO cache_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}
