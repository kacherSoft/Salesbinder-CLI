#!/usr/bin/env node
/**
 * Read-only V3 invoice authority snapshot for the one-time OC shipping repair.
 * V2 identifies reciprocal OC/invoice pairs only; V3 is the shipping authority.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSalesBinderAccountBinding, loadConfig } from '../packages/sdk/dist/index.js';
import { createV3AxiosClient } from '../packages/sdk/dist/client/v3-axios.factory.js';
import { V3DocumentsReadResource } from '../packages/sdk/dist/resources/v3-documents-read.resource.js';
import { normalizeV3OCShippingSourceDocument } from '../packages/sdk/dist/cache/oc-shipping-v3-normalizer.js';
import { OCShippingContractError } from '../packages/sdk/dist/cache/oc-shipping.types.js';

export const ACCOUNT = 'phuthaitech';
export const V2_STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v2-stage-phuthaitech.json';
export const STAGE_PATH = '/private/tmp/salesbinder-oc-shipping-v3-authorities-phuthaitech.json';
export const PROGRESS_PATH = '/private/tmp/salesbinder-oc-shipping-v3-authorities-phuthaitech.progress.json';
export const CHECKPOINT_DIR = '/private/tmp/salesbinder-oc-shipping-v3-authorities-phuthaitech.checkpoints';
export const CONCURRENCY = 4;
export const CHECKPOINT_INTERVAL = 50;
export const PROGRESS_INTERVAL = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const report = (event, detail = {}) => console.error(JSON.stringify({ event, ...detail }));

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--stage') return { resume: false };
  if (argv.length === 1 && argv[0] === '--resume') return { resume: true };
  throw new Error('Usage: node --env-file=.env scripts/stage-oc-shipping-authorities.mjs --stage|--resume');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** Select the only V2 relationships eligible for a V3 invoice-authority read. */
export function selectInvoiceAuthorities(v2Stage, accountIdentity) {
  if (!isRecord(v2Stage) || v2Stage.version !== 1 ||
    v2Stage.source !== 'salesbinder_v2_documents_list' ||
    v2Stage.coverage !== 'active_list_only' || v2Stage.complete !== true ||
    v2Stage.accountIdentity !== accountIdentity || !isRecord(v2Stage.contexts) ||
    !Array.isArray(v2Stage.contexts[4]?.documents) || !Array.isArray(v2Stage.contexts[5]?.documents)) {
    throw new Error('Complete, account-bound V2 source stage is required.');
  }
  const estimates = v2Stage.contexts[4].documents;
  const invoices = new Map(v2Stage.contexts[5].documents.map((invoice) => [invoice?.id, invoice]));
  if (invoices.size !== v2Stage.contexts[5].documents.length ||
    new Set(estimates.map((estimate) => estimate?.id)).size !== estimates.length ||
    !estimates.every((estimate) => isRecord(estimate) && isUuid(estimate.id)) ||
    ![...invoices.keys()].every(isUuid)) {
    throw new Error('V2 source stage document identities are invalid.');
  }
  const rejected = { missingInvoice: 0, nonReciprocal: 0, customerMismatch: 0 };
  const invoiceIds = new Set();
  for (const estimate of estimates) {
    const invoice = invoices.get(estimate.associatedDocumentId);
    if (!invoice) { rejected.missingInvoice += 1; continue; }
    if (invoice.associatedDocumentId !== estimate.id) { rejected.nonReciprocal += 1; continue; }
    if (invoice.customerId !== estimate.customerId) { rejected.customerMismatch += 1; continue; }
    invoiceIds.add(invoice.id);
  }
  return { requestedIds: [...invoiceIds].sort(), rejected };
}

async function privateFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Private authority artifact is unsafe.');
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Private authority checkpoint directory is unsafe.');
  }
}

async function readPrivate(path) {
  if (!await privateFile(path)) return null;
  const handle = await open(path, 'r');
  try { return JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
}

async function writePrivate(path, value, exclusive) {
  if (exclusive && await privateFile(path)) throw new Error('Private authority artifact already exists; refusing to overwrite it.');
  if (!exclusive && !await privateFile(path)) throw new Error('Private authority checkpoint disappeared.');
  await privateDirectory(CHECKPOINT_DIR);
  const temporary = `${CHECKPOINT_DIR}/${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

function initialProgress(accountIdentity, selection) {
  return {
    version: 1,
    source: 'salesbinder_v3_invoice_authorities',
    accountIdentity,
    v2StagePath: V2_STAGE_PATH,
    selectedAt: Math.floor(Date.now() / 1000),
    requestedIds: selection.requestedIds,
    selection: { rejected: selection.rejected },
    authorities: [],
    outcomes: [],
    complete: false,
  };
}

export function validateProgress(progress, accountIdentity, requestedIds) {
  if (!isRecord(progress) || progress.version !== 1 || progress.source !== 'salesbinder_v3_invoice_authorities' ||
    progress.accountIdentity !== accountIdentity || progress.v2StagePath !== V2_STAGE_PATH ||
    progress.complete !== false || !Array.isArray(progress.requestedIds) || !Array.isArray(progress.authorities) ||
    !Array.isArray(progress.outcomes) || !progress.requestedIds.every(isUuid) ||
    new Set(progress.requestedIds).size !== progress.requestedIds.length ||
    progress.requestedIds.some((id) => !requestedIds.includes(id))) {
    throw new Error('Authority checkpoint is invalid or belongs to a different V2 source snapshot.');
  }
  const outcomeIds = new Set(progress.outcomes.map((outcome) => outcome?.invoiceId));
  const authorityIds = new Set(progress.authorities.map((authority) => authority?.id));
  const authorityOutcomeIds = new Set(progress.outcomes
    .filter((outcome) => outcome?.status === 'authority')
    .map((outcome) => outcome.invoiceId));
  if (outcomeIds.size !== progress.outcomes.length || authorityIds.size !== progress.authorities.length ||
    authorityOutcomeIds.size !== authorityIds.size ||
    ![...outcomeIds].every((id) => progress.requestedIds.includes(id)) ||
    ![...authorityOutcomeIds].every((id) => authorityIds.has(id)) ||
    !progress.outcomes.every((outcome) => isRecord(outcome) &&
      (outcome.status === 'authority' || ['issue:not_found', 'issue:invalid_record', 'issue:source_client_error'].includes(outcome.status)))) {
    throw new Error('Authority checkpoint outcomes are invalid.');
  }
  for (const authority of progress.authorities) {
    if (!isRecord(authority) || !isUuid(authority.id) || !isRecord(authority.source) ||
      authority.source.id !== authority.id || authority.source.kind !== 'invoice' ||
      !authorityOutcomeIds.has(authority.id)) {
      throw new Error('Authority checkpoint sources are invalid.');
    }
  }
  return progress;
}

export function classifyError(error) {
  const status = error?.response?.status;
  if (error instanceof OCShippingContractError || error?.name === 'OCShippingContractError') return 'invalid_record';
  if (status === 401 || status === 403 || status === 429 || status >= 500 || status == null) return null;
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'source_client_error';
  return null;
}

async function readOne(resource, invoiceId) {
  try {
    const source = normalizeV3OCShippingSourceDocument(
      await resource.get(5, invoiceId),
      { id: invoiceId, kind: 'invoice' }
    );
    return { invoiceId, status: 'authority', source };
  } catch (error) {
    const issue = classifyError(error);
    if (!issue) throw error;
    return { invoiceId, status: `issue:${issue}` };
  }
}

function summary(progress) {
  const outcomes = {};
  for (const result of progress.outcomes) outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
  return { requestedCount: progress.requestedIds.length, completedCount: progress.outcomes.length, authorityCount: progress.authorities.length, outcomes };
}

export async function stageAuthorities(resource, accountIdentity, selection, { resume = false } = {}) {
  if (await privateFile(STAGE_PATH)) throw new Error('Complete V3 authority stage already exists; retain it for repair review.');
  const existing = await readPrivate(PROGRESS_PATH);
  if (existing && !resume) throw new Error('An incomplete authority stage exists; use --resume.');
  if (!existing && resume) throw new Error('No incomplete authority stage exists to resume.');
  const progress = existing ? validateProgress(existing, accountIdentity, selection.requestedIds) : initialProgress(accountIdentity, selection);
  const expanded = Boolean(existing && progress.requestedIds.length !== selection.requestedIds.length);
  if (expanded) {
    progress.requestedIds = selection.requestedIds;
    progress.selection = { rejected: selection.rejected, expandedAt: Math.floor(Date.now() / 1000) };
  }
  if (!existing) await writePrivate(PROGRESS_PATH, progress, true);
  if (expanded) await writePrivate(PROGRESS_PATH, progress, false);

  const completed = new Set(progress.outcomes.map((outcome) => outcome.invoiceId));
  const pending = progress.requestedIds.filter((id) => !completed.has(id));
  let next = 0;
  let checkpointedAt = progress.outcomes.length;
  let fatal;
  const checkpoint = async () => {
    await writePrivate(PROGRESS_PATH, progress, false);
    checkpointedAt = progress.outcomes.length;
  };
  const worker = async () => {
    while (!fatal) {
      const invoiceId = pending[next++];
      if (!invoiceId) return;
      try {
        const result = await readOne(resource, invoiceId);
        progress.outcomes.push({ invoiceId: result.invoiceId, status: result.status });
        if (result.status === 'authority') progress.authorities.push({ id: result.invoiceId, source: result.source });
        if (progress.outcomes.length - checkpointedAt >= CHECKPOINT_INTERVAL) await checkpoint();
        if (progress.outcomes.length % PROGRESS_INTERVAL === 0) report('authority_progress', summary(progress));
      } catch (error) {
        fatal ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (fatal) {
    if (progress.outcomes.length !== checkpointedAt) await checkpoint();
    throw fatal;
  }
  if (progress.outcomes.length !== progress.requestedIds.length) throw new Error('Authority stage did not complete every requested invoice.');
  validateProgress(progress, accountIdentity, selection.requestedIds);
  const terminal = { ...progress, authorities: [...progress.authorities].sort((a, b) => a.id.localeCompare(b.id)), outcomes: [...progress.outcomes].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId)), complete: true, completedAt: Math.floor(Date.now() / 1000) };
  await writePrivate(STAGE_PATH, terminal, true);
  report('authority_complete', summary(terminal));
  return { ...summary(terminal), stagePath: STAGE_PATH };
}

async function main() {
  const { resume } = parseArguments(process.argv.slice(2));
  if (!process.env.SALESBINDER_V3_API_KEY) throw new Error('SALESBINDER_V3_API_KEY is required from the native environment file.');
  const configured = loadConfig(ACCOUNT);
  const account = { ...configured, v3ApiKey: process.env.SALESBINDER_V3_API_KEY };
  const binding = createSalesBinderAccountBinding(account.subdomain);
  const v2Stage = await readPrivate(V2_STAGE_PATH);
  const selection = selectInvoiceAuthorities(v2Stage, binding.accountIdentity);
  const resource = new V3DocumentsReadResource(createV3AxiosClient(account));
  report('authority_start', { requestedCount: selection.requestedIds.length, resume });
  const result = await stageAuthorities(resource, binding.accountIdentity, selection, { resume });
  report('authority_result', result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    report('authority_failed', { code: error?.response?.status ?? error?.name ?? 'error' });
    process.exitCode = 1;
  });
}
