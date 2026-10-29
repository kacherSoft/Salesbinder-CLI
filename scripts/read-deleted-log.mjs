// Read-only source evidence for the interval reporter. The caller owns checkpoints.
export const DELETED_LOG_CONTEXTS = Object.freeze([
  { contextId: 5, resource: 'invoice' },
  { contextId: 4, resource: 'estimate' },
  { contextId: 11, resource: 'purchase_order' },
  { contextId: 6, resource: 'item' },
  { contextId: 2, resource: 'customer' },
  { contextId: 8, resource: 'prospect' },
  { contextId: 10, resource: 'supplier' },
]);

const PAGE_LIMIT = 200;
const MAX_PAGES = 10_000;
const MAX_RECORDS = 1_000_000;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEpoch = (value) => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error('Invalid deleted-log response'); };

function count(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return isEpoch(value) ? value : null;
}

function canonicalText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 ||
      value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value;
}

function eventId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return invalid();
}

function validCreated(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 &&
    Number(second) < 60 && Number.isFinite(Date.parse(value.replace(' ', 'T')));
}

function readPage(response, contextId, page, previous, seen) {
  if (!isRecord(response)) invalid();
  const hasPrimary = Object.hasOwn(response, 'deletedlog');
  const hasAlias = Object.hasOwn(response, 'deleted_log');
  if (hasPrimary === hasAlias) invalid();
  const envelope = hasPrimary ? response.deletedlog : response.deleted_log;
  if (!Array.isArray(envelope) || (envelope.some(Array.isArray) && !envelope.every(Array.isArray))) invalid();
  const entries = envelope.every(Array.isArray) ? envelope.flat() : envelope;
  const pages = count(response.pages), total = count(response.count), reportedPage = count(response.page);
  if (pages === null || total === null || reportedPage !== page || pages > MAX_PAGES ||
      total > MAX_RECORDS || entries.length > PAGE_LIMIT ||
      (previous && (pages !== previous.pages || total !== previous.total))) invalid();
  const nextCount = (previous?.processed ?? 0) + entries.length;
  if (pages === 0 ? page !== 1 || total !== 0 || entries.length !== 0 :
      page > pages || (page < pages && entries.length === 0) || nextCount > total ||
      (page === pages && nextCount !== total)) invalid();
  const events = entries.map((entry) => {
    if (!isRecord(entry) || entry.context_id !== contextId || !validCreated(entry.created)) invalid();
    const id = eventId(entry.id);
    if (seen.has(id)) invalid();
    seen.add(id);
    return { id, contextId, recordId: canonicalText(entry.record_id), created: entry.created };
  });
  return { pages, total, processed: nextCount, events };
}

/** All source errors are deliberately classified without returning exception text. */
export async function collectDeletedLog(client, { since, now } = {}) {
  const scanStartedAt = now ?? Math.floor(Date.now() / 1000);
  const contexts = DELETED_LOG_CONTEXTS.map((context) => ({ ...context, status: 'unavailable', events: [] }));
  if (!isEpoch(since) || !isEpoch(scanStartedAt) || since > scanStartedAt ||
      typeof client?.deletedLog?.list !== 'function') {
    return { scanStartedAt, since, contexts };
  }
  const sourceIds = new Map();
  for (const result of contexts) {
    const seen = new Set(), events = [];
    let previous = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let response;
      try {
        response = await client.deletedLog.list({ contextId: result.contextId, deletedSince: since, page, pageLimit: PAGE_LIMIT });
      } catch {
        result.status = 'unavailable';
        break;
      }
      let parsed;
      try {
        parsed = readPage(response, result.contextId, page, previous, seen);
      } catch {
        result.status = 'incomplete';
        break;
      }
      events.push(...parsed.events);
      previous = parsed;
      if (parsed.pages === 0 || page === parsed.pages) {
        result.status = 'complete';
        result.events = events;
        break;
      }
    }
    if (result.status !== 'complete') continue;
    for (const event of result.events) {
      const previousContext = sourceIds.get(event.id);
      if (previousContext) {
        previousContext.status = 'incomplete';
        previousContext.events = [];
        result.status = 'incomplete';
      } else sourceIds.set(event.id, result);
    }
    if (result.status !== 'complete') result.events = [];
  }
  return { scanStartedAt, since, contexts };
}
