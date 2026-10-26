import assert from 'node:assert/strict';
const base=process.argv[2]??'http://127.0.0.1:8771';
async function rpc(kind,body,origin=base){
 const response=await fetch(base+'/_mortise/'+kind,{method:'POST',headers:{'Content-Type':'application/json','Origin':origin},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
const initial=await rpc('query',{domain:'cart',input:{cartId:'cart-main'}});assert.equal(initial.status,200);
const previous=initial.body.data.items[0].quantity;const next=previous===10?1:previous+1;
const command={domain:'cart',input:{cartId:'cart-main'},contract:{id:'quantity-editable',version:1},scope:{name:'items',key:'keyboard'},command:'setQuantity',value:next,root:{id:'forged'},services:{secret:'forged'}};
assert.equal((await rpc('command',command)).status,200);
const after=await rpc('query',{domain:'cart',input:{cartId:'cart-main'}});assert.equal(after.body.data.items[0].quantity,next);assert.equal(after.body.data.total,next*50000+20000);
const invalid=await rpc('command',{...command,value:11});assert.equal(invalid.status,422);assert.equal(invalid.body.error.code,'QUANTITY_LIMIT');
assert.equal((await rpc('command',command,'https://untrusted.example')).status,403);
assert.equal((await rpc('query',{domain:'cart',input:{cartId:'private-cart'}})).status,403);
const forbidden=await rpc('command',{...command,command:'deleteAll'});assert.equal(forbidden.status,404);
const index=await fetch(base+'/');assert.equal(index.status,200);assert.match(await index.text(),/Mortise Playground/);
await rpc('command',{...command,value:previous});
console.log('PASS: HTTP query, scoped command, server total, invalid input, origin, authorization, command allowlist, static page');
