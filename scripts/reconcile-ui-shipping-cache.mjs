import fs from 'fs';
import pg from 'pg';
for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,''); }
const live=JSON.parse(fs.readFileSync('/home/kacher/.openclaw/workspace/tmp/live-ui-shipping-targets.json','utf8'));
const liveSet=new Set(live.targets.map(t=>Number(t.doc_number)));
const client=new pg.Client({connectionString:process.env.SALESBINDER_DB_URL});
await client.connect();
const cache=(await client.query(`SELECT doc_id, api_doc_id, doc_number, issue_date, status_name, shipped_percent, is_cancelled, account_name, total_price FROM documents WHERE context_id=5 AND shipped_percent >= 0 AND shipped_percent < 100 ORDER BY doc_number DESC`)).rows;
const cacheSet=new Set(cache.map(r=>Number(r.doc_number)));
const extra=cache.filter(r=>!liveSet.has(Number(r.doc_number)));
const missing=live.targets.filter(t=>!cacheSet.has(Number(t.doc_number)));
console.log(JSON.stringify({liveTargets:live.targets.length, liveNot:live.not, livePartial:live.partial, cacheTargets:cache.length, extraCount:extra.length, missingCount:missing.length, extra, missing},null,2));
await client.end();
