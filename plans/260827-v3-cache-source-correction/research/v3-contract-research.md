# SalesBinder API v3 Contract Research: Cache Correctness

Research date: 2026-08-27

Scope: official public SalesBinder API v3 documentation only, with limited v2 comparison for incremental and deleted-record behavior. No account APIs called. No credentials inspected.

## Executive Summary

SalesBinder API v3 is not a drop-in replacement for v2. It uses `/api/v3`, JSON-only request/response bodies, Bearer-token authentication, direct resource objects for retrieve/create/update, and a standard list envelope with `object`, `url`, `has_more`, `data`, and `pagination`.

For inventory cache correctness, the authoritative item archive field is `archived` on the v3 item object. The default `GET /api/v3/items` list is active-only. A cache that must preserve archived inventory must explicitly request `archived=true` or `archived=all`; missing records from an active-only list are not deletion evidence.

For stock, parent item fields are authoritative for basic item totals, while variation/location stock is authoritative on variation objects with `locations` included. The variation-location row identifier is `item_variation_location_id`, not `location_id`; cache both.

No v3 incremental item/category sync or deleted-record feed is documented. v2 has `modifiedSince` on item list and `deletedSince` on deleted-log list; v3 docs expose `updated_at` fields but no query parameter to filter by them. Safe v3-only cache refresh therefore requires complete, validated snapshots for categories and inventory/variation stock.

## Sources Checked

- SalesBinder API v3 overview: https://www.salesbinder.com/api/v3/
- v3 requests/responses: https://www.salesbinder.com/api/v3/requests-and-responses/
- v3 authentication: https://www.salesbinder.com/api/v3/authentication/
- v3 pagination: https://www.salesbinder.com/api/v3/pagination/
- v3 inventory items: https://www.salesbinder.com/api/v3/items/
- v3 item categories: https://www.salesbinder.com/api/v3/item-categories/
- v3 inventory locations: https://www.salesbinder.com/api/v3/locations/
- v3 changelog: https://www.salesbinder.com/api/v3/changelog/
- v2 item list comparison: https://www.salesbinder.com/api/v2/inventory/list/
- v2 deleted-log comparison: https://www.salesbinder.com/api/v2/deleted-log/list/
- v2 category list comparison: https://www.salesbinder.com/api/v2/categories/list/

OpenAPI check: the v3 overview links `https://www.salesbinder.com/api/v3/openapi.json`, but `curl -I` returned HTTP `404` on 2026-08-27. The rendered resource guides/page-data were used as the authoritative current public contract.

## v3 API Conventions

Base URL:

```text
https://yourbusiness.salesbinder.com/api/v3
```

Authentication:

```http
Authorization: Bearer YOUR_API_KEY
```

Request conventions:

| Concern | v3 contract |
| --- | --- |
| Auth | `Authorization: Bearer YOUR_API_KEY` |
| Request content type | `Content-Type: application/json` |
| Response content type | `application/json` |
| URL suffixes | No `.json` or `.xml` suffix |
| API-key prefix | v3 keys begin with `sb_live_`; prefix is not safe to publish |

Resource object envelope:

```json
{
  "id": "uuid",
  "object": "item"
}
```

List envelope:

```json
{
  "object": "list",
  "url": "/api/v3/items",
  "has_more": false,
  "data": [],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total_pages": 1,
    "total_records": 0
  }
}
```

Pagination parameters and fields:

| Name | Meaning |
| --- | --- |
| `page` | 1-based page number; defaults to `1` |
| `limit` | page size; defaults to `20`; allowed `1` to `100`; values above `100` are capped |
| `has_more` | true when another page follows |
| `pagination.page` | current requested page |
| `pagination.per_page` | effective page size |
| `pagination.total_pages` | total pages at current page size |
| `pagination.total_records` | total records matching filter and visibility boundary |

Cache implication: process by stable `id`; do not rely on page position because the v3 pagination docs warn that records can change while paging.

## Inventory Items

List endpoint:

```text
GET /api/v3/items
Required scope: items:read
```

Documented query parameters:

| Parameter | Type | Cache significance |
| --- | --- | --- |
| `page` | integer | pagination |
| `limit` | integer | max `100` |
| `q` | string | search name/SKU/barcode/serial number; numeric also exact item number |
| `category_id` | string | category UUID filter |
| `type` | string | `quantity` or `unique` |
| `archived` | string or boolean | active by default; `true` returns archived items; `all` includes active + archived |
| `location_id` | string | includes `location_inventory` totals for requested active location |
| `include` | string | `photos` only for item list |

Item object cache-relevant fields:

| Field | Type / meaning |
| --- | --- |
| `id` | item UUID |
| `object` | `item` |
| `item_number` | account-assigned number |
| `name`, `description`, `sku`, `barcode`, `serial_number` | identity/search fields |
| `inventory_type` | `quantity` or `unique` |
| `category_id`, `category_name` | category reference and cached name |
| `status_id` | lifecycle: `12` available, `13` unavailable, `14` sold |
| `location_id`, `zone_id` | primary direct location/zone |
| `unit_of_measure_id`, `unit_of_measure` | unit metadata |
| `price`, `cost` | decimal strings; `cost` omitted without permission |
| `quantity` | current item quantity |
| `quantity_reserved` | reserved quantity |
| `quantity_incoming` | incoming quantity |
| `quantity_estimates` | estimate quantity or null |
| `threshold` | low-stock threshold |
| `location_inventory` | only on `location_id` filtered lists |
| `variation_count` | number of item variations |
| `weight`, `published`, `archived` | item metadata |
| `custom_field_values` | `{ custom_field_id, value }` pairs |
| `purchase_date`, `sold_date` | unique-item dates |
| `created_at`, `updated_at` | ISO 8601 timestamps |

Archive authority:

- Use the item object's `archived` boolean as the authoritative archived state.
- `status_id` is lifecycle state, not a replacement for `archived`, although docs state archived items remain status `13`.
- Archive/unarchive endpoints return the item object with `archived` set to the final state:
  - `POST /api/v3/items/{item_id}/archive`
  - `POST /api/v3/items/{item_id}/unarchive`
- Parent inventory item deletion is not available in v3; SalesBinder says to archive a parent item instead.

Stock authority for non-variation/basic items:

- Use the item object fields `quantity`, `quantity_reserved`, `quantity_incoming`, `quantity_estimates`, and `threshold`.
- If list filtered by `location_id`, `location_inventory` contains `location_id`, `quantity`, `quantity_reserved`, `quantity_available`, `quantity_incoming`, and `threshold`. Those are server-computed totals for that requested location and do not replace canonical item quantity fields.

Retrieve endpoint:

```text
GET /api/v3/items/{item_id}
Required scope: items:read
```

Direct retrieval can return archived items and sold unique items when UUID is known and visible. This matters because the discoverability of sold unique items via list filters is not fully specified; see uncertainties.

## Variations and Location Stock

Variation object fields:

| Field | Type / meaning |
| --- | --- |
| `id` | variation UUID |
| `object` | `item_variation` |
| `item_id` | parent item UUID |
| `barcode` | variation barcode/SKU |
| `attributes` | published attribute values keyed by attribute name |
| `image_id` | variation image UUID or null |
| `unit_price_override`, `unit_cost_override` | price/cost overrides; cost permission-sensitive |
| `quantity` | total on-hand across visible location rows |
| `quantity_reserved` | total reserved across visible location rows |
| `quantity_incoming` | total incoming across visible location rows |
| `in_transit` | total in transit across visible location rows |
| `location_count` | visible location-row count used in totals |
| `created_at` | ISO timestamp or null |
| `locations` | visible location details; included only on detail retrieval or list with `include=locations` |

Variation-location object fields:

| Field | Authority |
| --- | --- |
| `object` | `item_variation_location` |
| `item_variation_location_id` | authoritative integer row identifier for selected variation + inventory location |
| `location_id` | inventory location UUID |
| `location_name` | current location name or null |
| `location_active` | whether location remains active |
| `zone_id`, `zone_name` | zone reference/name |
| `quantity` | on-hand quantity at this location |
| `quantity_reserved` | reserved quantity at this location |
| `quantity_incoming` | incoming quantity at this location |
| `in_transit` | in-transit quantity at this location |
| `threshold` | low-stock threshold or null |

Variation stock read endpoints:

```text
GET /api/v3/items/{item_id}/variations
GET /api/v3/items/{item_id}/variations?include=locations
GET /api/v3/items/{item_id}/variations/{variation_id}
```

The plain variation list returns compact variation objects and omits `locations`. Use `include=locations` or per-variation retrieval to populate location-level stock. Variation totals are calculated from visible location rows; location-restricted users see only permitted rows.

Variation/location mutation endpoints are not snapshot sources, but clarify invariants:

- `POST /api/v3/items/{item_id}/variations/{variation_id}/locations` creates configuration only; stock balances start at zero.
- `PATCH /api/v3/items/{item_id}/variations/{variation_id}/locations/{location_id}` changes only `threshold` and `zone_id`; it cannot change quantities.
- `POST /api/v3/items/{item_id}/variations/{variation_id}/locations/{location_id}/adjustments` is the quantity-change endpoint and returns a recalculated variation object with `locations`.
- `DELETE /api/v3/items/{item_id}/variations/{variation_id}/locations/{location_id}` returns `{ object, item_id, variation_id, location_id, deleted: true }` when successful.

Cache implication: for current stock by warehouse/location, v3 variation `locations` is the authoritative snapshot source. Cache `item_variation_location_id` as the stable row ID where present; do not synthesize identity from `location_id` alone.

## Categories

List endpoint:

```text
GET /api/v3/item-categories
Required scope: items:read
```

Documented query parameters:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `page` | integer | pagination |
| `limit` | integer | `1` to `100`, default `20` |
| `q` | string | category-name search |
| `parent_id` | string | direct children of category UUID; `root` for root categories |

Item category object fields:

| Field | Type / meaning |
| --- | --- |
| `id` | category UUID |
| `object` | `item_category` |
| `name` | category name |
| `parent_id` | parent category UUID or null |
| `inventory_type` | `quantity` or `unique` |
| `custom_fields` | ordered definitions |

Each custom-field definition contains:

- `id`
- `name`
- `display_order`
- `display_on_inventory_list`
- `publish_on_documents`

Category deletion is not available through v3. Docs say to use SalesBinder to delete an item category. There is no `updated_at`, `created_at`, `modified`, `deleted`, or incremental query parameter documented for v3 categories.

Cache implication: category correctness requires a complete v3 category snapshot. Fetch every page under the intended filter scope, validate pagination consistency, then atomically replace the cached category set. Do not treat partial category fetches as authoritative.

## Locations

List endpoint:

```text
GET /api/v3/locations
Required scope: items:read
```

Location object fields:

| Field | Meaning |
| --- | --- |
| `id` | inventory-location UUID |
| `object` | `location` |
| `name` | full name |
| `short_name` | short label |

Only active accessible locations are listed. Zone endpoint:

```text
GET /api/v3/locations/{location_id}/zones
```

Zone object fields are `id`, `object`, `location_id`, `name`, `short_name`, and `description`.

Cache implication: v3 `locations` discovers active location/zone UUIDs, but variation stock rows may include `location_active`; historical or inactive stock references should be retained from variation-location rows when returned.

## Incremental and Deleted Feeds

v3 finding:

- No documented v3 `modifiedSince`, `updated_since`, `updatedSince`, `deletedSince`, or deleted-log endpoint.
- `updated_at` exists on items and many other resources, but no official v3 list query parameter filters on it.
- `deleted: true` appears as a response shape for successful DELETE operations on some resources or subresources; it is not a feed.
- v3 parent inventory item deletion is explicitly unavailable; archive is the lifecycle mechanism for parent inventory items.

v2 comparison:

- `GET /api/2.0/items.json` supports `modifiedSince` based on the v2 `modified` field.
- `GET /api/2.0/deleted_log.json` supports `deletedSince` and returns `deletedlog` entries with `id`, `context_id`, `record_id`, and `created`.
- v2 category list includes `modified` and `created` fields, but the v2 category list page does not document a category `modifiedSince` query parameter.

Safe cache strategies:

1. v3-only full snapshot
   - Fetch `GET /api/v3/item-categories` all pages.
   - Fetch `GET /api/v3/items?archived=all` all pages.
   - For each item with `variation_count > 0`, fetch `GET /api/v3/items/{item_id}/variations?include=locations` all pages.
   - Only mark rows absent/deleted after the entire relevant snapshot completed and passed pagination validation.

2. Hybrid v2/v3 incremental
   - Can use v2 `modifiedSince` and `deletedSince` as hints for records that need v3 refresh.
   - Must not treat v2 as authoritative for v3-only fields, v3 response envelopes, or v3 variation-location row IDs.
   - Must still periodically run full v3 snapshots, because v3 has no documented incremental contract for variation-location quantity changes, category changes/deletions, or all archive transitions.

3. Unsafe shortcuts to avoid
   - Do not infer deletion from missing active-list results.
   - Do not overwrite known archive state from an active-only v3 list.
   - Do not treat `location_inventory` as a replacement for variation-location rows.
   - Do not use v2 `modified`/`created` names in v3 cache mappers; v3 uses `updated_at`/`created_at`.

## Endpoint Matrix for Cache Sources

| Cache concern | Safe v3 source | Notes |
| --- | --- | --- |
| Active and archived item master | `GET /api/v3/items?archived=all` | `archived` field authoritative |
| Archived-only backfill/check | `GET /api/v3/items?archived=true` | returns archived items per docs |
| Single known item | `GET /api/v3/items/{item_id}` | can retrieve archived/sold unique item when visible |
| Basic item stock | item object | `quantity`, `quantity_reserved`, `quantity_incoming`, `quantity_estimates`, `threshold` |
| Location-filtered item totals | `GET /api/v3/items?location_id={id}` | `location_inventory` is server-computed per requested location |
| Variation totals | variation object | totals are across visible location rows |
| Variation location stock | `GET /api/v3/items/{item_id}/variations?include=locations` or variation detail | `locations[]` carries authoritative location balances |
| Variation-location row ID | `locations[].item_variation_location_id` | integer, distinct from `location_id` |
| Categories | `GET /api/v3/item-categories` | full snapshot needed |
| Active locations/zones | `GET /api/v3/locations`, `GET /api/v3/locations/{id}/zones` | active accessible only |
| Parent item hard deletes | none in v3 | parent item deletion not available; archive instead |
| Incremental updated items | none in v3 | v2 has `modifiedSince`; use only as hybrid hint |
| Deleted-record feed | none in v3 | v2 has `deleted_log` with `deletedSince` |

## Uncertainties

- Official v3 OpenAPI JSON is linked but currently unavailable at `/api/v3/openapi.json`; exact machine-readable schemas could not be verified.
- The v3 item list docs state the default list contains active quantity items and active unique items that have not been sold. They do not document a `status_id` filter or explicitly state whether `archived=all` includes sold unique items. If sold unique-item discovery matters, verify with SalesBinder support or a non-sensitive test account.
- The docs do not state whether `archived=false` is accepted; they only document active default behavior, `archived=true`, and `archived=all`.
- No v3 category deletion endpoint exists, but the docs do not describe how category deletions surface to API consumers except by absence from a full list snapshot.
