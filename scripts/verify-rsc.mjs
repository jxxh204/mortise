import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const base=process.argv[2]??'http://127.0.0.1:8773';
async function rpc(kind,body){const response=await fetch(base+'/_mortise/'+kind,{method:'POST',headers:{'Content-Type':'application/json','Origin':base},body:JSON.stringify(body)});assert.equal(response.status,200);return (await response.json()).data;}
const input={cartId:'cart-main'};
const initial=await rpc('query',{domain:'cart',input});const old=initial.items[0].quantity;const next=old===10?1:old+1;
const command={domain:'cart',input,contract:{id:'quantity-editable',version:1},scope:{name:'items',key:'keyboard'},command:'setQuantity'};
await rpc('command',{...command,value:next});
try{
 const navigation=await fetch(base+'/',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(navigation.status,200,'safe cross-site navigation');
 const rejected=await fetch(base+'/_mortise/command',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.invalid','Sec-Fetch-Site':'cross-site'},body:JSON.stringify({...command,value:next})});assert.equal(rejected.status,403,'cross-site mutation rejected');
 const htmlResponse=await fetch(base+'/');assert.match(htmlResponse.headers.get('content-type'),/text\/html/);const html=await htmlResponse.text();
 const visible=html.split('<script')[0];assert.match(visible,/RSC 서버 합계/);assert(visible.includes(`키보드 ${next}개`));assert(visible.includes((next*50000+20000).toLocaleString('ko-KR')));
 const responses=await Promise.all(['cart-main','cart-other'].map(id=>fetch(base+'/index.rsc?cart='+id+'&__revision=5')));
 for(let i=0;i<responses.length;i++){const r=responses[i];assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/x-component/);const flight=await r.text();const id=i===0?'cart-main':'cart-other';const other=i===0?'cart-other':'cart-main';assert(flight.includes(id));assert(!flight.includes(other),'cross-request scope leak');assert(!flight.includes(':E{'),'Flight render error');assert(flight.includes('RSC 서버 합계'));}
 const dir='examples/rsc/dist/client';const chunks=[];function walk(d){for(const f of fs.readdirSync(d,{withFileTypes:true})){const file=path.join(d,f.name);if(f.isDirectory())walk(file);else if(file.endsWith('.js'))chunks.push(fs.readFileSync(file,'utf8'));}}walk(dir);const browserCode=chunks.join('\n');
 for(const secret of ['MORTISE_PRIVATE_REPOSITORY_V02','readDomain requires a Mortise RSC request scope','node:async_hooks','Unknown demo cart'])assert(!browserCode.includes(secret),'server implementation in client: '+secret);
 console.log('PASS: actual Flight, async SSR HTML, mutation re-render, concurrent scope isolation, server code excluded');
}finally{await rpc('command',{...command,value:old});}
