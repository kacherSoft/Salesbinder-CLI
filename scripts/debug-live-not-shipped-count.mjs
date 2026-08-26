import fs from 'fs';
import { SalesBinderClient, DocumentContextId } from '../packages/sdk/dist/resources/index.js';
if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,''); }
const delay = ms => new Promise(r=>setTimeout(r,ms));
const flat = x => Array.isArray(x?.[0]) ? x.flat() : (x || []);
const client = new SalesBinderClient('default');
let page=1, total=0, not=0, partial=0, shipped=0, missing=0; const byStatus={}; const samples=[];
const maxPages=Number(process.argv.find(a=>a.startsWith('--max-pages='))?.split('=')[1]||180);
while(page<=maxPages){
  try{
    const res=await client.documents.list({contextId:DocumentContextId.Invoice,page,pageLimit:50});
    const docs=flat(res.documents); if(!docs.length) break;
    for(const d of docs){
      total++; const pct=d.shipped_percent; const st=d.status?.name || String(d.status_id||'unknown');
      byStatus[st] ||= {total:0, not:0, partial:0, shipped:0, missing:0}; byStatus[st].total++;
      if(pct == null){missing++; byStatus[st].missing++;}
      else if(Number(pct) <= 0){not++; byStatus[st].not++; if(samples.length<20) samples.push({doc_number:d.document_number, status:st, shipped_percent:pct, issue_date:d.issue_date, account:d.customer?.name});}
      else if(Number(pct)<100){partial++; byStatus[st].partial++;}
      else {shipped++; byStatus[st].shipped++;}
    }
    if(page%20===0) console.error(`page=${page} total=${total} not=${not} partial=${partial} shipped=${shipped} missing=${missing}`);
    page++; await delay(350);
  }catch(e){ if(e?.response?.status===404) break; console.error('err page',page,e?.message||e); if(e?.response?.status===429) await delay(60000); else await delay(2000); }
}
console.log(JSON.stringify({pagesScanned:page-1,total,not,partial,shipped,missing,byStatus,samples},null,2));
