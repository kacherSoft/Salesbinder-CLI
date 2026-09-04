export const SALESBINDER_CLI_INVENTORY_CONSUMER = 'salesbinder-cli-inventory-v1' as const;

export const INVENTORY_CHANGE_FEED_EVENT_TYPE_PREFIX = 'inventory.' as const;

export const INVENTORY_CHANGE_FEED_EVENT_TYPES = Object.freeze([
  'inventory.item_created',
  'inventory.item_deleted',
  'inventory.item_updated',
  'inventory.low_stock',
] as const);

export type ChangeFeedInventoryEventType = (typeof INVENTORY_CHANGE_FEED_EVENT_TYPES)[number];

export const INVENTORY_CHANGE_FEED_API_VERSION = 'v3' as const;
export const INVENTORY_CHANGE_FEED_OBJECT_TYPE = 'inventory' as const;
