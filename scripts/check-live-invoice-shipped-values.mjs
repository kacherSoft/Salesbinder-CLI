import { SalesBinderClient } from '../packages/sdk/dist/resources/index.js';
const client = new SalesBinderClient('default');
const list = await client.documents.list({ contextId: 5, limit: 20 });
const docs = (list.documents || []).flat();
for (const d of docs) {
  const items = d.document_items || [];
  console.log(JSON.stringify({
    invoice: d.document_number,
    issue_date: d.issue_date,
    status: d.status?.name,
    shipped_percent: d.shipped_percent,
    date_sent: d.date_sent,
    line_count: items.length,
    line_ship_samples: items.slice(0,5).map(x => ({ qty: x.quantity, qps: x.quantity_partially_shipped, qpr: x.quantity_partially_received, item_id: x.item_id, desc: (x.description || x.name || '').slice(0,80) }))
  }));
}
