export type InventoryChangeFeedIssueState = 'retry' | 'dead_letter' | 'blocked';

/** Record-local feed issue safe to include in the command's final JSON result. */
export interface InventoryChangeFeedIssue {
  itemId: string;
  eventSeq: string;
  state: InventoryChangeFeedIssueState;
  reason: string;
  attempts?: number;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REASON_LENGTH = 200;
const PRIVATE_DETAIL =
  /(?:https?:\/\/|postgres(?:ql)?:\/\/|authorization\b|bearer\b|password\b|api[-_ ]?key\b|token\b|secret\b|private[-_ ]?key\b|stack\b|\{[^}]*\}|\[[^\]]*\])/i;

const FALLBACK_REASONS: Record<InventoryChangeFeedIssueState, string> = {
  retry: 'Inventory item will be retried.',
  dead_letter: 'Inventory item requires dead-letter review.',
  blocked: 'Inventory item is blocked.',
};

/** Validate, sanitize and deterministically order inventory feed warnings. */
export function formatInventoryChangeFeedIssues(
  issues: readonly InventoryChangeFeedIssue[]
): InventoryChangeFeedIssue[] {
  if (!Array.isArray(issues)) {
    throw new Error('Inventory change-feed issues must be an array.');
  }
  const projected = issues.map(projectIssue).sort(compareIssues);
  return projected.filter((issue, index) => projected[index - 1]?.itemId !== issue.itemId);
}

function compareIssues(left: InventoryChangeFeedIssue, right: InventoryChangeFeedIssue): number {
  return (
    compareText(left.itemId, right.itemId) ||
    compareEventSequences(left.eventSeq, right.eventSeq) ||
    issueStatePriority(right.state) - issueStatePriority(left.state) ||
    compareText(left.reason, right.reason) ||
    (right.attempts ?? 0) - (left.attempts ?? 0)
  );
}

function issueStatePriority(state: InventoryChangeFeedIssueState): number {
  return { retry: 0, dead_letter: 1, blocked: 2 }[state];
}

function projectIssue(value: InventoryChangeFeedIssue): InventoryChangeFeedIssue {
  if (!value || typeof value !== 'object') {
    throw new Error('Inventory change-feed issue must be an object.');
  }
  if (!CANONICAL_UUID.test(value.itemId)) {
    throw new Error('Inventory change-feed issue itemId must be a canonical UUID.');
  }
  if (!isEventSequence(value.eventSeq) || value.eventSeq === '0') {
    throw new Error(
      'Inventory change-feed issue eventSeq must be a positive PostgreSQL BIGINT decimal string.'
    );
  }
  if (value.state !== 'retry' && value.state !== 'dead_letter' && value.state !== 'blocked') {
    throw new Error('Inventory change-feed issue state is invalid.');
  }
  if (
    value.attempts !== undefined &&
    (!Number.isSafeInteger(value.attempts) || value.attempts <= 0)
  ) {
    throw new Error('Inventory change-feed issue attempts must be a positive integer.');
  }
  return {
    itemId: value.itemId,
    eventSeq: value.eventSeq,
    state: value.state,
    reason: sanitizeReason(value.reason, value.state),
    ...(value.attempts === undefined ? {} : { attempts: value.attempts }),
  };
}

function sanitizeReason(value: unknown, state: InventoryChangeFeedIssueState): string {
  if (typeof value !== 'string') return FALLBACK_REASONS[state];
  const normalized = [...value]
    .map((character) => sanitizeCharacter(character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || PRIVATE_DETAIL.test(normalized)) return FALLBACK_REASONS[state];
  return normalized.slice(0, MAX_REASON_LENGTH);
}

function sanitizeCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  if (
    codePoint === undefined ||
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return ' ';
  }
  return character;
}

function isEventSequence(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

function compareEventSequences(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
