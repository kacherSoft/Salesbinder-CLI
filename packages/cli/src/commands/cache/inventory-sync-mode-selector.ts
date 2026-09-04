import {
  CACHE_SCHEMA_VERSION,
  INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX,
  INVENTORY_CHANGE_FEED_EVENT_TYPES,
  SALESBINDER_CLI_INVENTORY_CONSUMER,
  type ActiveChangeFeedSyncRun,
  type ChangeFeedContractPreflight,
  type ChangeFeedSyncKind,
  type InventoryChangeFeedState,
  type InventoryVerifiedBaselineProof,
} from '@salesbinder/sdk';
import type { ChangeFeedConfig } from './change-feed-config.js';

export type InventorySyncMode =
  | 'compatibility_snapshot'
  | 'baseline_start'
  | 'baseline_resume'
  | 'replay_resume'
  | 'incremental';
type BaselineRunKind = Extract<ChangeFeedSyncKind, 'initial_full_sync' | 'reconciliation'>;

export type InventorySyncModeErrorCode =
  | 'change_feed_requires_postgresql'
  | 'feed_binding_requires_configuration'
  | 'ledger_preflight_required'
  | 'ledger_schema_mismatch'
  | 'account_binding_mismatch'
  | 'consumer_binding_mismatch'
  | 'ledger_binding_mismatch'
  | 'cache_schema_mismatch'
  | 'active_run_mismatch'
  | 'verified_baseline_mismatch';

/** Mode-selection error safe for stderr/JSON output. */
export class InventorySyncModeError extends Error {
  readonly sanitized = true as const;

  constructor(
    readonly code: InventorySyncModeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InventorySyncModeError';
  }
}

export interface InventorySyncModeSelectorInput {
  backend: 'sqlite' | 'postgresql';
  feedConfig: ChangeFeedConfig | null;
  accountIdentity: string;
  cacheSchemaVersion: number;
  feedBinding: InventoryChangeFeedState | null;
  /** Immutable promoted-baseline proof; independent of the current live materialization. */
  baselineProof: InventoryVerifiedBaselineProof | null;
  ledgerPreflight: ChangeFeedContractPreflight | null;
  activeRun: ActiveChangeFeedSyncRun | null;
  /** Inventory-only force flag; document full/delta selection remains independent. */
  forceFull: boolean;
}

export type InventorySyncModeSelection =
  | {
      kind: 'selected';
      mode: InventorySyncMode;
      runKind: Extract<ChangeFeedSyncKind, 'initial_full_sync' | 'reconciliation'> | null;
      syncRunId: string | null;
      baselineGeneration: string | null;
    }
  | { kind: 'fatal'; mode: 'fatal'; error: InventorySyncModeError };

export function selectInventorySyncMode(
  input: InventorySyncModeSelectorInput
): InventorySyncModeSelection {
  if (!input.feedConfig) {
    return input.feedBinding
      ? fatal(
          'feed_binding_requires_configuration',
          'This cache is change-feed bound; configure the ledger worker connection.'
        )
      : selected('compatibility_snapshot');
  }
  if (input.backend !== 'postgresql') {
    return fatal(
      'change_feed_requires_postgresql',
      'Change-feed inventory sync requires the PostgreSQL cache backend.'
    );
  }
  if (input.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) {
    return fatal('cache_schema_mismatch', 'Cache schema is not ready for change-feed sync.');
  }
  if (!input.ledgerPreflight) {
    return fatal('ledger_preflight_required', 'Change-feed ledger preflight did not complete.');
  }

  const preflightFailure = validatePreflight(input);
  if (preflightFailure) return preflightFailure;
  const bindingFailure = validateFeedBinding(input);
  if (bindingFailure) return bindingFailure;
  const baselineFailure = validateBaselineProof(input);
  if (baselineFailure) return baselineFailure;
  const runFailure = validateActiveRun(input);
  if (runFailure) return runFailure;

  const active = input.activeRun;
  if (active?.status === 'running') {
    return selected('baseline_resume', active.runKind as BaselineRunKind, active.syncRunId);
  }
  if (active) {
    if (!hasVerifiedBaseline(input, active.baselineCacheGeneration)) {
      return fatal(
        'verified_baseline_mismatch',
        'Active ledger replay does not match a verified cache baseline.'
      );
    }
    return selected(
      'replay_resume',
      active.runKind as BaselineRunKind,
      active.syncRunId,
      active.baselineCacheGeneration
    );
  }
  if (input.forceFull) return selected('baseline_start', 'reconciliation');
  if (!hasVerifiedBaseline(input)) return selected('baseline_start', 'initial_full_sync');
  return selected('incremental', null, null, input.baselineProof?.baselineGeneration ?? null);
}

function validatePreflight(
  input: InventorySyncModeSelectorInput
): InventorySyncModeSelection | null {
  const preflight = input.ledgerPreflight;
  if (!preflight) return null;
  if (
    preflight.contractVersion !== 2 ||
    preflight.eventTypePrefix !== INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX ||
    preflight.subscribedEventTypes.length !== INVENTORY_CHANGE_FEED_EVENT_TYPES.length ||
    INVENTORY_CHANGE_FEED_EVENT_TYPES.some(
      (eventType) => !preflight.subscribedEventTypes.includes(eventType)
    )
  ) {
    return fatal('ledger_schema_mismatch', 'Change-feed ledger contract is incompatible.');
  }
  if (preflight.accountIdentity !== input.accountIdentity) {
    return fatal('account_binding_mismatch', 'Change-feed ledger account binding does not match.');
  }
  if (
    preflight.consumerName !== SALESBINDER_CLI_INVENTORY_CONSUMER ||
    input.feedConfig?.consumerName !== SALESBINDER_CLI_INVENTORY_CONSUMER
  ) {
    return fatal('consumer_binding_mismatch', 'Change-feed consumer binding does not match.');
  }
  return null;
}

function validateFeedBinding(
  input: InventorySyncModeSelectorInput
): InventorySyncModeSelection | null {
  const binding = input.feedBinding;
  const ledger = input.ledgerPreflight;
  if (!binding || !ledger) return null;
  if (binding.accountIdentity !== input.accountIdentity) {
    return fatal('account_binding_mismatch', 'Cache change-feed account binding does not match.');
  }
  if (binding.consumerName !== SALESBINDER_CLI_INVENTORY_CONSUMER) {
    return fatal('consumer_binding_mismatch', 'Cache change-feed consumer binding does not match.');
  }
  if (binding.ledgerDatabaseId.toLowerCase() !== ledger.ledgerDatabaseId.toLowerCase()) {
    return fatal('ledger_binding_mismatch', 'Cache and change-feed ledger bindings do not match.');
  }
  return null;
}

function validateActiveRun(
  input: InventorySyncModeSelectorInput
): InventorySyncModeSelection | null {
  const run = input.activeRun;
  if (!run) return null;
  if (run.accountIdentity !== input.accountIdentity) {
    return fatal('account_binding_mismatch', 'Active change-feed account binding does not match.');
  }
  if (run.consumerName !== SALESBINDER_CLI_INVENTORY_CONSUMER) {
    return fatal(
      'consumer_binding_mismatch',
      'Active change-feed consumer binding does not match.'
    );
  }
  if (run.runKind !== 'initial_full_sync' && run.runKind !== 'reconciliation') {
    return fatal('active_run_mismatch', 'Active change-feed run binding does not match.');
  }
  return null;
}

function validateBaselineProof(
  input: InventorySyncModeSelectorInput
): InventorySyncModeSelection | null {
  const proof = input.baselineProof;
  if (!proof) return null;
  if (proof.accountIdentity !== input.accountIdentity) {
    return fatal('account_binding_mismatch', 'Verified baseline account binding does not match.');
  }
  if (proof.consumerName !== SALESBINDER_CLI_INVENTORY_CONSUMER) {
    return fatal('consumer_binding_mismatch', 'Verified baseline consumer binding does not match.');
  }
  if (
    proof.ledgerDatabaseId.toLowerCase() !==
      input.ledgerPreflight?.ledgerDatabaseId.toLowerCase() ||
    (input.feedBinding &&
      proof.ledgerDatabaseId.toLowerCase() !== input.feedBinding.ledgerDatabaseId.toLowerCase())
  ) {
    return fatal('ledger_binding_mismatch', 'Verified baseline ledger binding does not match.');
  }
  if (proof.baselineGeneration !== proof.meta.generation) {
    return fatal('verified_baseline_mismatch', 'Verified baseline generation does not match.');
  }
  return null;
}

function hasVerifiedBaseline(
  input: InventorySyncModeSelectorInput,
  expectedGeneration?: string | null
): boolean {
  const binding = input.feedBinding;
  const proof = input.baselineProof;
  const baseline = proof?.meta;
  if (!binding?.baselineGeneration || !proof || !baseline) return false;
  const generation = expectedGeneration ?? binding.baselineGeneration;
  return (
    generation !== null &&
    binding.baselineGeneration === generation &&
    proof.baselineGeneration === generation &&
    baseline.generation === generation &&
    baseline.accountIdentity === input.accountIdentity &&
    baseline.schemaVersion === CACHE_SCHEMA_VERSION &&
    baseline.version === 2 &&
    baseline.status === 'complete' &&
    baseline.warningCount === 0 &&
    baseline.omittedItemCount === 0 &&
    baseline.preservedItemCount === 0 &&
    baseline.lastCompleteAt === baseline.completedAt
  );
}

function selected(
  mode: InventorySyncMode,
  runKind: BaselineRunKind | null = null,
  syncRunId: string | null = null,
  baselineGeneration: string | null = null
): InventorySyncModeSelection {
  return { kind: 'selected', mode, runKind, syncRunId, baselineGeneration };
}

function fatal(code: InventorySyncModeErrorCode, message: string): InventorySyncModeSelection {
  return { kind: 'fatal', mode: 'fatal', error: new InventorySyncModeError(code, message) };
}
