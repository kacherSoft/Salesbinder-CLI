import type {
  OfficialV3SyncPageEnvelope,
  OfficialV3SyncResult,
  OfficialV3SyncResource,
  OfficialV3SyncStore,
} from './official-v3-sync.types.js';
import type { V3ExactItemHydratorService } from './v3-exact-item-hydrator.service.js';

export interface OfficialV3SyncTransport {
  read(
    params:
      | { since: string | number; resources: readonly OfficialV3SyncResource[]; limit: number }
      | { cursor: string; limit: number }
  ): Promise<OfficialV3SyncPageEnvelope>;
}

export interface OfficialV3DocumentReadPort {
  get(contextId: 4 | 5 | 11, id: string): Promise<unknown>;
}

export interface OfficialV3SyncDependencies {
  store: OfficialV3SyncStore;
  sync: OfficialV3SyncTransport;
  documents: OfficialV3DocumentReadPort;
  hydrator: Pick<V3ExactItemHydratorService, 'hydrate'>;
  now?: () => number;
  guard?: () => void | Promise<void>;
  onProgress?: (progress: OfficialV3SyncProgress) => void;
  pageLimit?: number;
  maxPagesPerRun?: number;
  maxResponseBytes?: number;
  categoryNames?: Map<string, string> | null;
  loadCategoryNames?: () => Promise<Map<string, string> | null>;
}

export interface OfficialV3SyncOptions {
  accountIdentity: string;
  since?: string | number;
  resume?: boolean;
  onProgress?: (progress: OfficialV3SyncProgress) => void;
}

export interface OfficialV3SyncProgress {
  runId: string;
  phase: 'ingestion' | 'tasks' | 'coverage' | 'complete';
  event: string;
  completed: number;
  total: number;
  failed: number;
}

export interface OfficialV3TaskExecution {
  deps: OfficialV3SyncDependencies;
  runId: string;
  now: () => number;
  guard: () => Promise<void>;
  progress: (event: string) => Promise<void>;
}

export type { OfficialV3SyncResult };
