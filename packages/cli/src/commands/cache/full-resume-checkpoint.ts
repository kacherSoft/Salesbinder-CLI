import { createHash, randomUUID } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type FullResumeSyncTarget = 'sqlite' | 'postgresql';
export type FullResumePhase = 'accounts' | 'categories' | 'documents' | 'items' | 'deleted-log';

export interface ResumeCacheSnapshot {
  accountName: string;
  schemaVersion: number;
  accountCount: number;
  categoryCount: number;
  categoryStatus: 'complete' | 'uninitialized';
  categoryCompletedAt: number | null;
  categorySchemaVersion: number | null;
  categoryGeneration: string | null;
  categoryFingerprint: string | null;
  inventoryStatus: 'complete' | 'uninitialized';
  inventoryCompletedAt: number | null;
  inventorySchemaVersion: number | null;
  inventorySourceApiVersion: '3' | null;
  inventoryGeneration: string | null;
  inventoryFingerprint: string | null;
  documentCount: number;
  itemDocumentCount: number;
  paymentTransactionCount: number;
  paymentSyncStatusFingerprint: string | null;
  itemCount: number;
  stockLocationCount: number;
  lastAccountSync: number | null;
  lastItemSync: number | null;
  lastDeletedSync: number | null;
}

export interface FullResumeCheckpoint {
  version: 4;
  runType: 'full-resume';
  accountName: string;
  syncTarget: FullResumeSyncTarget;
  schemaVersion: number;
  cacheIdentity: string;
  startedAt: number;
  updatedAt: number;
  phase: string;
  completedPhases: FullResumePhase[];
  phaseEvidence: Partial<Record<FullResumePhase, ResumeCacheSnapshot>>;
  documents?: { contextId?: number; page?: number; docIndex?: number };
  items?: { page?: number; itemIndex?: number };
  lastError?: string;
}

export interface ResumePaymentSyncStatus {
  status: string;
  mode: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastSuccessfulSync?: number;
  cursor: string | null;
  snapshotHash?: string;
  processedDocuments: number;
  totalDocuments: number;
}

interface CheckpointStoreOptions {
  accountName: string;
  syncTarget: FullResumeSyncTarget;
  schemaVersion: number;
  cacheIdentity: string;
  cacheDirectory?: string;
}

interface CacheIdentityOptions {
  accountName: string;
  syncTarget: FullResumeSyncTarget;
  cacheDirectory?: string;
  databaseUrl?: string;
}

const CHECKPOINT_VERSION = 4;
const PHASES: FullResumePhase[] = ['accounts', 'categories', 'documents', 'items', 'deleted-log'];
const SNAPSHOT_COUNT_FIELDS: Array<keyof ResumeCacheSnapshot> = [
  'accountCount',
  'categoryCount',
  'documentCount',
  'itemDocumentCount',
  'paymentTransactionCount',
  'itemCount',
  'stockLocationCount',
];
const SNAPSHOT_WATERMARK_FIELDS: Array<keyof ResumeCacheSnapshot> = ['lastAccountSync', 'lastItemSync', 'lastDeletedSync'];
const SNAPSHOT_PAYMENT_FIELDS: Array<keyof ResumeCacheSnapshot> = ['paymentSyncStatusFingerprint'];
const SNAPSHOT_CATEGORY_FIELDS: Array<keyof ResumeCacheSnapshot> = [
  'categoryStatus',
  'categoryCompletedAt',
  'categorySchemaVersion',
  'categoryGeneration',
  'categoryFingerprint',
];
const SNAPSHOT_INVENTORY_FIELDS: Array<keyof ResumeCacheSnapshot> = [
  'inventoryStatus',
  'inventoryCompletedAt',
  'inventorySchemaVersion',
  'inventorySourceApiVersion',
  'inventoryGeneration',
  'inventoryFingerprint',
];
const SNAPSHOT_FIELDS = [
  ...SNAPSHOT_COUNT_FIELDS,
  ...SNAPSHOT_WATERMARK_FIELDS,
  ...SNAPSHOT_PAYMENT_FIELDS,
  ...SNAPSHOT_CATEGORY_FIELDS,
  ...SNAPSHOT_INVENTORY_FIELDS,
];
const PHASE_FIELDS: Record<FullResumePhase, Array<keyof ResumeCacheSnapshot>> = {
  accounts: ['accountCount', 'lastAccountSync'],
  categories: ['categoryCount', ...SNAPSHOT_CATEGORY_FIELDS],
  documents: ['documentCount', 'itemDocumentCount', 'paymentTransactionCount', 'paymentSyncStatusFingerprint'],
  items: ['itemCount', 'stockLocationCount', 'lastItemSync', ...SNAPSHOT_INVENTORY_FIELDS],
  'deleted-log': ['lastDeletedSync'],
};
const DELETED_LOG_MUTABLE_COUNT_FIELDS = new Set<keyof ResumeCacheSnapshot>([
  'accountCount',
  'documentCount',
  'itemDocumentCount',
  'paymentTransactionCount',
  'itemCount',
  'stockLocationCount',
]);

export function sanitizeCheckpointAccountName(accountName: string): string {
  return accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getFullResumeCheckpointPath(
  accountName: string,
  cacheDirectory = join(homedir(), '.salesbinder', 'cache'),
): string {
  return join(cacheDirectory, `full-resume-${sanitizeCheckpointAccountName(accountName)}.json`);
}

export function buildFullResumeCacheIdentity(options: CacheIdentityOptions): string {
  if (options.syncTarget === 'postgresql') {
    if (!options.databaseUrl) throw new Error('PostgreSQL checkpoint identity requires a database URL.');
    const digest = createHash('sha256').update(options.databaseUrl).digest('hex');
    return `postgresql:sha256:${digest}`;
  }
  const cacheDirectory = options.cacheDirectory ?? join(homedir(), '.salesbinder', 'cache');
  return `sqlite:${join(cacheDirectory, `salesbinder-${sanitizeCheckpointAccountName(options.accountName)}.db`)}`;
}

export function buildPaymentSyncStatusFingerprint(status: ResumePaymentSyncStatus | null): string | null {
  if (!status) return null;
  const stableEvidence = [
    status.status,
    status.mode,
    status.startedAt,
    status.updatedAt,
    status.finishedAt ?? null,
    status.lastSuccessfulSync ?? null,
    status.cursor,
    status.snapshotHash ?? null,
    status.processedDocuments,
    status.totalDocuments,
  ];
  return createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex');
}

export class FullResumeCheckpointStore {
  readonly checkpointPath: string;
  private readonly options: CheckpointStoreOptions;

  constructor(options: CheckpointStoreOptions) {
    this.options = options;
    this.checkpointPath = getFullResumeCheckpointPath(options.accountName, options.cacheDirectory);
  }

  loadOrCreate(): FullResumeCheckpoint {
    if (!existsSync(this.checkpointPath)) {
      const now = nowInSeconds();
      const checkpoint: FullResumeCheckpoint = {
        version: CHECKPOINT_VERSION,
        runType: 'full-resume',
        accountName: this.options.accountName,
        syncTarget: this.options.syncTarget,
        schemaVersion: this.options.schemaVersion,
        cacheIdentity: this.options.cacheIdentity,
        startedAt: now,
        updatedAt: now,
        phase: 'init',
        completedPhases: [],
        phaseEvidence: {},
      };
      this.save(checkpoint);
      return checkpoint;
    }

    try {
      chmodSync(dirname(this.checkpointPath), 0o700);
      chmodSync(this.checkpointPath, 0o600);
      const parsed: unknown = JSON.parse(readFileSync(this.checkpointPath, 'utf8'));
      return this.validateCheckpoint(parsed);
    } catch (error) {
      if (error instanceof Error && error.message.includes('--reset-checkpoint')) throw error;
      throw this.invalidCheckpoint(`malformed JSON or unreadable file: ${errorMessage(error)}`);
    }
  }

  reset(): void {
    rmSync(this.checkpointPath, { force: true });
  }

  markPhaseStarted(checkpoint: FullResumeCheckpoint, phase: FullResumePhase): void {
    checkpoint.phase = phase;
    delete checkpoint.lastError;
    this.save(checkpoint);
  }

  markDocumentPosition(
    checkpoint: FullResumeCheckpoint,
    position: { contextId: number; page: number; docIndex: number },
  ): void {
    checkpoint.phase = 'documents';
    checkpoint.documents = position;
    this.save(checkpoint);
  }

  markItemPosition(checkpoint: FullResumeCheckpoint, position: { page: number; itemIndex: number }): void {
    checkpoint.phase = 'items';
    checkpoint.items = position;
    this.save(checkpoint);
  }

  markPhaseComplete(
    checkpoint: FullResumeCheckpoint,
    phase: FullResumePhase,
    result: object,
    cacheState: ResumeCacheSnapshot,
  ): void {
    if ('success' in result && result.success === false) {
      throw new Error(`${phase} indexer returned an unsuccessful result.`);
    }
    if (!checkpoint.completedPhases.includes(phase)) checkpoint.completedPhases.push(phase);
    checkpoint.phaseEvidence[phase] = cacheState;
    checkpoint.phase = `${phase}:complete`;
    if (phase === 'documents') delete checkpoint.documents;
    if (phase === 'items') delete checkpoint.items;
    this.save(checkpoint);
  }

  isPhaseComplete(checkpoint: FullResumeCheckpoint, phase: FullResumePhase): boolean {
    return checkpoint.completedPhases.includes(phase);
  }

  validateCompletedPhases(checkpoint: FullResumeCheckpoint, current: ResumeCacheSnapshot): void {
    this.validateCacheIdentity(current);
    if (this.isPhaseComplete(checkpoint, 'deleted-log')) {
      this.validatePhaseSnapshot(checkpoint, current, 'deleted-log', SNAPSHOT_FIELDS);
      return;
    }
    if (checkpoint.phase === 'deleted-log') {
      this.validateDeletedLogResume(checkpoint, current);
      return;
    }
    for (const phase of checkpoint.completedPhases) {
      this.validatePhaseSnapshot(checkpoint, current, phase, PHASE_FIELDS[phase]);
    }
  }

  recordFailure(checkpoint: FullResumeCheckpoint, error: unknown): void {
    checkpoint.lastError = errorMessage(error);
    this.save(checkpoint);
  }

  removeAfterSuccess(): void {
    this.reset();
  }

  private save(checkpoint: FullResumeCheckpoint): void {
    const directory = dirname(this.checkpointPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    checkpoint.updatedAt = nowInSeconds();
    const temporaryPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, this.checkpointPath);
      chmodSync(this.checkpointPath, 0o600);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private validateCacheIdentity(current: ResumeCacheSnapshot): void {
    if (current.accountName !== this.options.accountName || current.schemaVersion !== this.options.schemaVersion) {
      throw this.invalidCheckpoint('cache account or schema changed');
    }
  }

  private validatePhaseSnapshot(
    checkpoint: FullResumeCheckpoint,
    current: ResumeCacheSnapshot,
    phase: FullResumePhase,
    fields: Array<keyof ResumeCacheSnapshot>,
  ): void {
    const evidence = checkpoint.phaseEvidence[phase];
    if (!evidence) throw this.invalidCheckpoint(`${phase} phase evidence is missing`);
    for (const field of fields) {
      if (current[field] !== evidence[field]) {
        throw this.invalidCheckpoint(`${phase} cache state changed at ${field}`);
      }
    }
  }

  private validateDeletedLogResume(
    checkpoint: FullResumeCheckpoint,
    current: ResumeCacheSnapshot,
  ): void {
    let latestEvidence: ResumeCacheSnapshot | undefined;
    for (const phase of checkpoint.completedPhases) {
      if (phase === 'deleted-log') continue;
      const evidence = checkpoint.phaseEvidence[phase];
      if (!evidence) throw this.invalidCheckpoint(`${phase} phase evidence is missing`);
      latestEvidence = evidence;
      for (const field of PHASE_FIELDS[phase]) {
        if (DELETED_LOG_MUTABLE_COUNT_FIELDS.has(field)) {
          // A failed deleted-log pass can already have applied idempotent deletes.
          // Permit those decreases, but reject additions from another cache writer.
          if (Number(current[field]) > Number(evidence[field])) {
            throw this.invalidCheckpoint(`${phase} cache state increased at ${field}`);
          }
          continue;
        }
        if (current[field] !== evidence[field]) {
          throw this.invalidCheckpoint(`${phase} cache state changed at ${field}`);
        }
      }
    }

    if (latestEvidence && current.lastDeletedSync !== latestEvidence.lastDeletedSync) {
      throw this.invalidCheckpoint('deleted-log cache state changed at lastDeletedSync');
    }
  }

  private validateCheckpoint(value: unknown): FullResumeCheckpoint {
    if (!isRecord(value)) throw this.invalidCheckpoint('root value is not an object');
    const expected = this.options;
    if (value.version !== CHECKPOINT_VERSION) throw this.invalidCheckpoint('checkpoint version changed');
    if (value.runType !== 'full-resume') throw this.invalidCheckpoint('run type changed');
    if (value.accountName !== expected.accountName) throw this.invalidCheckpoint('account changed');
    if (value.syncTarget !== expected.syncTarget) throw this.invalidCheckpoint('backend changed');
    if (value.schemaVersion !== expected.schemaVersion) throw this.invalidCheckpoint('schema changed');
    if (value.cacheIdentity !== expected.cacheIdentity) throw this.invalidCheckpoint('cache identity changed');
    if (!validTimestamp(value.startedAt) || !validTimestamp(value.updatedAt) || value.updatedAt < value.startedAt) {
      throw this.invalidCheckpoint('timestamps are invalid');
    }
    if (!Array.isArray(value.completedPhases)) throw this.invalidCheckpoint('completed phases are invalid');
    const completed = value.completedPhases;
    if (!completed.every((phase, index) => phase === PHASES[index])) throw this.invalidCheckpoint('completed phases are out of order');
    if (!isRecord(value.phaseEvidence)) throw this.invalidCheckpoint('phase evidence is invalid');
    const checkpoint = value as unknown as FullResumeCheckpoint;
    for (const phase of checkpoint.completedPhases) {
      const evidence = checkpoint.phaseEvidence[phase];
      if (!validSnapshot(evidence) || evidence.accountName !== expected.accountName || evidence.schemaVersion !== expected.schemaVersion) {
        throw this.invalidCheckpoint(`${phase} phase evidence is invalid`);
      }
    }
    if (!validPhase(checkpoint.phase) || !validDocuments(checkpoint.documents) || !validItems(checkpoint.items)) {
      throw this.invalidCheckpoint('phase or resume position is invalid');
    }
    if (checkpoint.lastError !== undefined && typeof checkpoint.lastError !== 'string') {
      throw this.invalidCheckpoint('last error is invalid');
    }
    return checkpoint;
  }

  private invalidCheckpoint(reason: string): Error {
    return new Error(
      `Full-resume checkpoint at ${this.checkpointPath} is malformed or stale (${reason}). ` +
      'Run "salesbinder cache sync --full-resume --reset-checkpoint" to discard it safely.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validPhase(value: unknown): value is string {
  return value === 'init' || PHASES.some((phase) => value === phase || value === `${phase}:complete`);
}

function validDocuments(value: FullResumeCheckpoint['documents']): boolean {
  if (value === undefined) return true;
  return isRecord(value) && (value.contextId === undefined || [4, 5, 11].includes(value.contextId)) &&
    (value.page === undefined || validPositiveInteger(value.page)) &&
    (value.docIndex === undefined || validNonNegativeInteger(value.docIndex));
}

function validItems(value: FullResumeCheckpoint['items']): boolean {
  if (value === undefined) return true;
  return isRecord(value) && (value.page === undefined || validPositiveInteger(value.page)) &&
    (value.itemIndex === undefined || validNonNegativeInteger(value.itemIndex));
}

function validSnapshot(value: unknown): value is ResumeCacheSnapshot {
  if (!isRecord(value) || typeof value.accountName !== 'string' || !validNonNegativeInteger(value.schemaVersion)) return false;
  return SNAPSHOT_COUNT_FIELDS.every((field) => validNonNegativeInteger(value[field])) &&
    SNAPSHOT_WATERMARK_FIELDS.every((field) => value[field] === null || validNonNegativeInteger(value[field])) &&
    (value.categoryStatus === 'complete' || value.categoryStatus === 'uninitialized') &&
    (value.categoryCompletedAt === null || validNonNegativeInteger(value.categoryCompletedAt)) &&
    (value.categorySchemaVersion === null || validNonNegativeInteger(value.categorySchemaVersion)) &&
    (value.categoryGeneration === null || typeof value.categoryGeneration === 'string') &&
    (value.categoryFingerprint === null || typeof value.categoryFingerprint === 'string') &&
    (value.inventoryStatus === 'complete' || value.inventoryStatus === 'uninitialized') &&
    (value.inventoryCompletedAt === null || validNonNegativeInteger(value.inventoryCompletedAt)) &&
    (value.inventorySchemaVersion === null || validNonNegativeInteger(value.inventorySchemaVersion)) &&
    (value.inventorySourceApiVersion === null || value.inventorySourceApiVersion === '3') &&
    (value.inventoryGeneration === null || typeof value.inventoryGeneration === 'string') &&
    (value.inventoryFingerprint === null || typeof value.inventoryFingerprint === 'string') &&
    (value.paymentSyncStatusFingerprint === null ||
      (typeof value.paymentSyncStatusFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.paymentSyncStatusFingerprint)));
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function validNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
