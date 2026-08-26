# Official SalesBinder Archive/Lifecycle Contract

- Research date: 2026-08-26.
- Scope: official SalesBinder docs only. No account API calls. No source edits.
- Local context read: `README.md`; prior report `plans/260724-1358-salesbinder-api-v3-migration/research/researcher-official-v3-contract.md`.
- Docs-seeker check: Context7 had no SalesBinder docs entry; fallback used live official SalesBinder pages.

## Sources Checked

- v3 home / OpenAPI note: https://www.salesbinder.com/api/v3/
- v3 conventions: https://www.salesbinder.com/api/v3/requests-and-responses/
- v3 pagination: https://www.salesbinder.com/api/v3/pagination/
- v3 changelog: https://www.salesbinder.com/api/v3/changelog/
- v3 accounts: https://www.salesbinder.com/api/v3/customers/ , https://www.salesbinder.com/api/v3/prospects/ , https://www.salesbinder.com/api/v3/suppliers/ , https://www.salesbinder.com/api/v3/contacts/
- v3 inventory/reference: https://www.salesbinder.com/api/v3/items/ , https://www.salesbinder.com/api/v3/item-categories/ , https://www.salesbinder.com/api/v3/units-of-measure/ , https://www.salesbinder.com/api/v3/locations/ , https://www.salesbinder.com/api/v3/kits/ , https://www.salesbinder.com/api/v3/stock-transfers/
- v3 documents: https://www.salesbinder.com/api/v3/invoices/ , https://www.salesbinder.com/api/v3/estimates/ , https://www.salesbinder.com/api/v3/purchase-orders/ , https://www.salesbinder.com/api/v3/sales-orders/
- v2 legacy index/list docs: https://www.salesbinder.com/api/v2/ , https://www.salesbinder.com/api/v2/accounts/list/ , https://www.salesbinder.com/api/v2/documents/list/ , https://www.salesbinder.com/api/v2/inventory/list/ , https://www.salesbinder.com/api/v2/deleted-log/list/ , https://www.salesbinder.com/api/v2/categories/list/ , https://www.salesbinder.com/api/v2/locations/list/

## OpenAPI Availability

- v3 home now advertises `OpenAPI 3.1 JSON description` at `/api/v3/openapi.json`.
- Live checks on 2026-08-26:
  - `GET https://www.salesbinder.com/api/v3/openapi.json` -> `404 text/html; charset=utf-8`.
  - `HEAD https://www.salesbinder.com/api/v3/openapi.json` -> `404`.
  - `GET` with `Accept: application/json` -> `404 text/html; charset=utf-8`.
- Implication: v3 link exists in docs, but schema download unavailable at checked time. Do not automate contract generation from OpenAPI yet.

## v2/v3 Matrix

| Family | v2 documented fields/filters | v2 archive visibility | v3 documented fields/filters | v3 archive visibility | Cache implication |
|---|---|---|---|---|---|
| Customers | `/customers.[format]`, `contextId=2`, `modifiedSince` epoch, `pageLimit` 1-200. Sample fields include `id`, `customer_number`, `created`, `modified`. | No `archived` field/filter documented. | Object has `archived: boolean`, `created_at`, `updated_at`. List params: `page`, `limit`, `q`; no `archived` filter. Delete allowed only without documents. | Source field exists, but docs do not state whether archived customers are included/excluded by list or retrieve. Archived account records rejected as invoice/estimate targets when docs require active customer/prospect. | Store `archived` as nullable/observable. Missing from v3 list is not enough to delete/tombstone. Need empirical API call or support answer before v3 cache can promise complete archived account coverage. |
| Prospects | `/customers.[format]`, `contextId=8`, same account fields and `modifiedSince`. | No `archived` field/filter documented. | Object has `archived: boolean`, plus prospect fields `sale_opportunity`, `closing_percentage`, `prospect_date`. List params: `page`, `limit`, `q`; no `archived` filter. | Same as customers: field is source-backed; list/archive inclusion unobservable from docs. Estimate creation rejects archived records. | Same as customers; preserve prior rows unless delete is observed. |
| Suppliers | `/customers.[format]`, `contextId=10`, same account fields and `modifiedSince`. | No `archived` field/filter documented. | Object has `archived: boolean`. List params: `page`, `limit`, `q`; no `archived` filter. PO creation requires active supplier. | Field is source-backed; list/archive inclusion unobservable from docs. | Same as customers; supplier archive state can be cached when seen, but absence is ambiguous. |
| Contacts | v2 contacts docs exist, not central to current cache seed. | No archive contract found in checked v2 pages. | No `archived` field. Docs say API v3 does not support archiving/unarchiving contacts. Visibility depends on linked visible account records. | No archive surface. Contacts with no visible relationship are not exposed. | If cached later, visibility gaps are not delete proof. Link to account visibility. |
| Inventory items | `/items.[format]`, `modifiedSince` epoch, `pageLimit` 1-100, filters `categoryId`, `locationId`, `itemIdNumber`, search fields. Sample fields include `published`, `created`, `modified`; no `status_id`/`archived`. | No `archived` field/filter documented. | Object has `archived: boolean` and `status_id: integer`; status values: `12` available, `13` unavailable, `14` sold. List default: active quantity items and active unique items not sold. List filter `archived` accepts `true` or `all`. Retrieve can return sold unique or archived item by UUID. Archive/unarchive endpoints set final state and preserve quantity. | Documented: default excludes archived; `archived=true` returns archived; `archived=all` includes active + archived. Sold unique item visibility in list remains uncertain because default excludes sold unique and there is no `status_id` list filter documented. Direct retrieve works if UUID known and visible. | v3 cache must request `archived=all` for item refresh; cache `status_id` and `archived` separately. Do not derive archive solely from `status_id=13`; docs say archived items remain `13`, but `13` is unavailable lifecycle. Sold unique coverage needs separate strategy or support confirmation. |
| Item variations / variation locations | v2 exposes nested variation/location data in item payloads; no archive field documented. | Parent item archive unobservable in v2 docs. | Variation object has no `archived`; parent archived items/variations remain readable when parent visible. Archived parent items are read-only; variation and location mutations reject archived parents. | Inherits parent item archive behavior. | Store parent item archive state; variation-location rows should not be purged because parent became archived. |
| Categories | v2 `/categories.[format]`; sample has `id`, `account_id`, `modified`, `created`, `item_count`; no archive field. | No archive contract. | v3 `item_category` has `id`, `object`, `name`, `parent_id`, `inventory_type`, `custom_fields`; no archive field. Category deletion not available in v3 API. | No archive surface. | Reference cache can upsert from list. Absence is not necessarily deletion unless v2 deleted-log or explicit v3 behavior later covers categories. |
| Units of measure | Not in checked v2 pages. | N/A. | v3 `unit_of_measure` has `id`, `object`, `full_name`, `short_name`, `display_order`; no archive field. UI manages create/update/reorder/delete. | No archive surface. | Treat as reference snapshot only. |
| Locations/zones | v2 `/locations.[format]`; sample has address/contact fields and `item_count`; no active/archive field. | No archive contract. | v3 location has `id`, `object`, `name`, `short_name`; zones have `id`, `object`, `location_id`, `name`, `short_name`, `description`. Lists return active locations/zones; inactive locations never returned; inactive/cross-boundary retrieve returns `404`. | Inactive is documented as non-returned, not represented by a returned status field. | Cache should track `last_seen`/visibility separately. Missing v3 location/zone can mean inactive or permission boundary, not permanent delete. |
| Invoices | `/documents.[format]`, `contextId=5` per document list; `modifiedSince` epoch; `status_id`, nested `status`, `created`, `modified`; no archive field/filter. | No archive field/filter documented. | Object has `status_id: integer`, `status: string|null`, `can_edit: boolean` and `edit_block_reason` on detail, no `archived` field. Lists return visible active invoices. Retrieve archived invoice returns `404`. API v3 does not support invoice archiving/restoring. Delete eligible invoice returns `{deleted: true}`. | Archived invoices are explicitly not returned. They are unobservable except as `404`/absence, indistinguishable from deleted/permission unless delete response or other source exists. | Do not hard-delete cached invoices from v3 absence/404 alone. Need separate `api_visibility`/`archive_visibility_unknown` semantics or continue v2 deleted-log for permanent deletes. |
| Estimates | `/documents.[format]`, `contextId=4` per document list; `modifiedSince`; `status_id`, nested `status`. | No archive field/filter documented. | Object has `status_id`, `status`, `can_edit`, `edit_block_reason`; no `archived` field. Lists/retrieves only active estimates. Retrieve archived estimate returns `404`. API v3 does not support sending/reopening/archiving/restoring estimates. Delete eligible active open estimate returns `{deleted: true}`. | Archived estimates explicitly not returned. | Same as invoices. Preserve cached rows as hidden/unknown unless permanent delete is observed. |
| Purchase orders | `/documents.[format]`, `contextId=11`; `modifiedSince`; `status_id`, nested `status`. | No archive field/filter documented. | Object has `status_id`, `status`, `can_edit`, `edit_block_reason`; no `archived` field. Lists/retrieves only active POs. Retrieve archived PO returns `404`. API v3 does not support archiving/restoring POs. Delete eligible Not Sent PO returns `{deleted: true}`. | Archived POs explicitly not returned. | Same as invoices. |
| Sales orders | Not in v2 legacy document context list checked. | N/A. | Object has `status_id`, `status`, progress percentages, `can_edit`, `edit_block_reason`; no `archived` field/filter. List has filters but no archive filter. Unsupported ops exclude status changes, closing/reopening, some reversals; no archive operation documented. | No archive support documented; archived visibility not a concept in checked docs. | If added to cache, treat lifecycle as status/progress, not archive. |
| Stock transfers | Not in v2 legacy cached surface. | N/A. | Object has `status_id`, `status`, sent/received dates. No archive field/filter. Delete can be irreversible through API; lifecycle send/receive is forward-only. | No archive support documented. | Cache status/dates; deletion needs explicit delete response or future change feed. |
| Kits/bundles | Not in v2 legacy cached surface. | N/A. | Kit object has no `archived`/`status`; list returns active kit-backed items. Kit references assembled inventory `item_id`. | Parent assembled item archive may affect whether kit is active/listed; no kit archive field. | Cache kit only as active-derived inventory view; parent item `archived` remains authoritative where known. |

## Key Contract Differences

- v2 sync support is explicit for cache deltas: accounts, documents, and inventory items expose `modifiedSince`; deleted-log exposes `deletedSince`.
- v3 docs checked expose no `modifiedSince`, `updated_since`, `deletedSince`, deleted-log, or equivalent change-feed page.
- v3 list envelope is flat `object: "list"`, `data`, `pagination`, `has_more`; page size capped at 100. v2 uses nested arrays and `count/page/pages`.
- v3 timestamps use ISO 8601 `created_at`/`updated_at`; v2 uses `created`/`modified` and epoch filters.
- v2 official docs conflict on deleted-log document context IDs: document list says Estimate `4`, Invoice `5`, PO `11`; deleted-log list says Customer `2`, Prospect `8`, Supplier `10`, Item `6`, Invoice `4`, Estimate `5`, PO `11`. Existing README uses Estimate `4`, Invoice `5`, PO `11`.

## Source Field vs Inferred State

- Source-backed fields:
  - v3 accounts: `archived: boolean`.
  - v3 items: `archived: boolean`, `status_id: integer`.
  - v3 invoices/estimates/POs/sales orders/stock transfers: `status_id` + `status` where documented.
  - v3 detail-only edit lifecycle helpers: `can_edit`, `edit_block_reason`, `revision`.
- Inferred state:
  - A v3 invoice/estimate/PO that was cached before and later returns `404` may be archived, deleted, outside assigned-user visibility, or unavailable for another reason. Docs explicitly group archived with missing/inaccessible for retrieve behavior.
  - A v3 location/zone absent from list may be inactive or outside current location permission.
  - `status_id=13` for item means unavailable; archived items remain `13`, but `13` alone is not a complete archive flag.
- Unobservable archived records:
  - v3 invoices, estimates, purchase orders: explicitly not returned.
  - v3 account records: archive field exists, but list inclusion/filter behavior not documented.
  - v3 sold unique items: retrievable by known UUID; list coverage unclear because default excludes sold unique items and no status filter exists.

## Implementation Implications

- Cache schema should model lifecycle separately:
  - `archived` nullable boolean for families where source exposes it.
  - `status_id`/`status` for document/order/transfer lifecycle.
  - `visibility_state` or equivalent for rows no longer observed: `visible`, `not_returned_by_api`, `known_deleted`, `archive_unobservable`.
- For v3 item sync, use `archived=all` on list calls and persist both `archived` and `status_id`.
- Do not purge documents from cache based on v3 list omission or detail `404`; only purge/tombstone on explicit delete response, v2 deleted-log, or a future v3 deletion/change feed.
- Keep v2 as authoritative delete/tombstone source until v3 exposes a documented deleted feed or equivalent. Current v3 docs do not provide a cache-complete delta contract.
- Migration to v3 should not assume v2 context IDs disappear cleanly: accounts split into `/customers`, `/prospects`, `/suppliers`; documents split into `/invoices`, `/estimates`, `/purchase-orders`, plus v3-only `/sales-orders`.
- For archive-aware analytics, historical documents should remain queryable in cache even if no longer visible via API v3; mark freshness/visibility separately from deletion.

## Unresolved Questions

- Do v3 customer/prospect/supplier list endpoints include archived account records by default, or is an undocumented archive filter required?
- Is there any supported v3 way to list sold unique items, or only direct retrieve by UUID?
- Will `/api/v3/openapi.json` become downloadable, and should implementation trust it once available over prose docs?
- Does SalesBinder intend to provide a v3 deleted-log/change-feed equivalent?
- Which v2 deleted-log document context mapping is authoritative: deleted-log page or document list/README?

Status: DONE
Summary: Official v2/v3 archive and lifecycle contract rechecked, including the currently advertised but unavailable v3 OpenAPI JSON link. Report written to the corrected timestamped plan path.
Concerns/Blockers: v3 account archive list behavior, sold unique item list coverage, v3 deleted-feed parity, and conflicting v2 deleted-log document context IDs remain unresolved from official docs alone.
