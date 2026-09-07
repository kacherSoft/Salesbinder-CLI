import type { DocumentsResource } from '../resources/documents.resource.js';
import type { CacheService } from './cache.interface.js';
import type {
  DocumentOffsetRun,
  DocumentOffsetStore,
  DocumentOffsetTask,
  OffsetTaskKind,
} from './document-offset-sync.types.js';
import type { V3ExactItemHydratorService } from './v3-exact-item-hydrator.service.js';

export interface DocumentOffsetSyncProgress {
  runId: string;
  phase: 'discovery' | 'documents' | 'items' | 'complete';
  event: string;
  completed: number;
  total: number;
  failed: number;
}

export interface DocumentOffsetSyncOptions {
  accountIdentity: string;
  days?: number;
  resume?: boolean;
  onProgress?: (progress: DocumentOffsetSyncProgress) => void;
}

export interface DocumentOffsetSyncDependencies {
  cache: Pick<CacheService, 'getDocumentByApiId' | 'getDocumentByNumber'>;
  store: DocumentOffsetStore;
  documentsV2: Pick<DocumentsResource, 'list'>;
  documentsV3: { get(contextId: 4 | 5 | 11, id: string): Promise<unknown> };
  hydrator: Pick<V3ExactItemHydratorService, 'hydrate'>;
  /** Epoch seconds, matching persisted cache timestamps. */
  now?: () => number;
  /** Milliseconds. */
  sleep?: (milliseconds: number) => Promise<void>;
  guard?: () => void | Promise<void>;
  onProgress?: (progress: DocumentOffsetSyncProgress) => void;
}

export interface DocumentOffsetTaskCounts {
  discovered: number;
  applied: number;
  failed: number;
  pending: number;
}

export interface DocumentOffsetSyncResult {
  run: DocumentOffsetRun;
  documents: DocumentOffsetTaskCounts;
  items: DocumentOffsetTaskCounts;
  failures: { kind: OffsetTaskKind; id: string; contextId?: number; code: string }[];
  coverageLimitations: string[];
}

export interface OffsetExecution {
  deps: DocumentOffsetSyncDependencies;
  run: DocumentOffsetRun;
  now: () => number;
  guard: () => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  progress: (
    phase: DocumentOffsetSyncProgress['phase'],
    event: string,
    tasks?: DocumentOffsetTask[]
  ) => Promise<void>;
}
