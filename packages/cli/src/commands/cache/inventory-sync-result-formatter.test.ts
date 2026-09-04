import { formatInventoryChangeFeedIssues } from './inventory-sync-result-formatter.js';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

describe('formatInventoryChangeFeedIssues', () => {
  it('keeps the strongest newest issue per item', () => {
    expect(
      formatInventoryChangeFeedIssues([
        {
          itemId: ITEM_A,
          eventSeq: '10',
          state: 'retry',
          reason: 'Older retry',
          attempts: 1,
        },
        {
          itemId: ITEM_A,
          eventSeq: '11',
          state: 'dead_letter',
          reason: 'Newest dead letter',
          attempts: 2,
        },
        {
          itemId: ITEM_A,
          eventSeq: '12',
          state: 'retry',
          reason: 'Newer but weaker retry',
          attempts: 3,
        },
      ])
    ).toEqual([
      {
        itemId: ITEM_A,
        eventSeq: '11',
        state: 'dead_letter',
        reason: 'Newest dead letter',
        attempts: 2,
      },
    ]);
  });

  it('sanitizes private details and orders output deterministically', () => {
    expect(
      formatInventoryChangeFeedIssues([
        {
          itemId: ITEM_B,
          eventSeq: '3',
          state: 'retry',
          reason: 'Bearer secret-token-value',
        },
        {
          itemId: ITEM_A,
          eventSeq: '2',
          state: 'blocked',
          reason: 'Blocked by earlier event',
        },
      ])
    ).toEqual([
      {
        itemId: ITEM_A,
        eventSeq: '2',
        state: 'blocked',
        reason: 'Blocked by earlier event',
      },
      {
        itemId: ITEM_B,
        eventSeq: '3',
        state: 'retry',
        reason: 'Inventory item will be retried.',
      },
    ]);
  });
});
