import { SalesBinderClient } from '../packages/sdk/dist/resources/index.js';

function collectKeys(obj, prefix = '', out = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  if (Array.isArray(obj)) {
    if (obj[0]) collectKeys(obj[0], `${prefix}[]`, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    if (v && typeof v === 'object') collectKeys(v, p, out, depth + 1);
  }
  return out;
}

function pickInteresting(obj) {
  const keys = [...collectKeys(obj)].sort();
  return keys.filter(k => /ship|fulfill|deliver|receive|status|sent|tracking|location|po|back.?order|complete|closed|transaction|payment|paid|quantity/i.test(k));
}

const client = new SalesBinderClient('default');
const list = await client.documents.list({ contextId: 5, limit: 5 });
const docs = (list.documents || []).flat();
console.log('LIST_TOP_KEYS', Object.keys(list).sort());
console.log('LIST_COUNT', docs.length);
console.log('LIST_DOC_KEYS', docs[0] ? [...collectKeys(docs[0])].sort() : []);
console.log('LIST_INTERESTING_KEYS', docs[0] ? pickInteresting(docs[0]) : []);

for (const d of docs.slice(0, 5)) {
  const full = await client.documents.get(d.id);
  console.log('\n=== INVOICE', full.document_number, full.id, full.issue_date, full.status?.name, '===');
  console.log('INTERESTING_KEYS', pickInteresting(full));
  const summary = {};
  for (const [k, v] of Object.entries(full)) {
    if (/ship|fulfill|deliver|receive|status|sent|tracking|location|po|back.?order|complete|closed|transaction|payment|paid/i.test(k)) summary[k] = v;
  }
  console.log('DOC_INTERESTING_VALUES', JSON.stringify(summary, null, 2));
  console.log('ITEM_SAMPLE', JSON.stringify((full.document_items || []).slice(0, 3), null, 2));
}
