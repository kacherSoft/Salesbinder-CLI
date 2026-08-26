import fs from 'fs';
import { SalesBinderClient, DocumentContextId } from '../packages/sdk/dist/resources/index.js';
if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,''); }
const delay = ms => new Promise(r=>setTimeout(r,ms));
const flat = x => Array.isArray(x?.[0]) ? x.flat() : (x || []);
const client = new SalesBinderClient('default');
const targets=[]; let page=1,total=0,not=0,partial=0,shipped=0;
while(true){
  try{
    const res=await client.documents.list({contextId:DocumentContextId.Invoice,page,pageLimit:50});
    const docs=flat(res.documents); if(!docs.length) break;
    for(const d of docs){ total++; const pct=Number(d.shipped_percent??0); if(pct<=0){not++; targets.push({doc_number:d.document_number,id:d.id,status:d.status?.name,pct,issue_date:d.issue_date});} else if(pct<100){partial++; targets.push({doc_number:d.document_number,id:d.id,status:d.status?.name,pct,issue_date:d.issue_date});} else shipped++; }
    if(page%100===0) console.error(`page=${page} not=${not} partial=${partial}`);
    page++; await delay(250);
  } catch(e){ if(e?.response?.status===404) break; console.error('err',page,e?.message||e); if(e?.response?.status===429) await delay(60000); else await delay(2000); }
}
fs.writeFileSync('/home/kacher/.openclaw/workspace/tmp/live-ui-shipping-targets.json', JSON.stringify({total,not,partial,shipped,targets},null,2));
console.log(JSON.stringify({total,not,partial,shipped,targets:targets.length},null,2));
