import { describe, it, expect } from 'vitest';
import { defineCapability,defineDomain,provide,schema,createRemoteDomain,RemoteError } from './index';
const Q=defineCapability({id:'quantity',version:1,state:{quantity:schema.integer()},commands:{setQuantity:{input:schema.integer(),output:schema.void()}}});
describe('remote domains',()=>{
 it('sends only input and scope identity, never client snapshot or services',async()=>{
  const calls:any[]=[];
  const domain=createRemoteDomain(defineDomain({provides:[provide(Q,{scope:'items'})]}),{id:'cart',fetch:async(url,init)=>{calls.push([url,JSON.parse(init!.body as string)]);return new Response(JSON.stringify({ok:true}));}});
  await domain.actions.setQuantity.run(3,{root:{secret:'untrusted-root'},scope:{name:'items',key:'a',value:{secret:'item'}},services:{secret:'token'},input:{cartId:'c'}});
  expect(calls[0]).toEqual(['/_mortise/command',{domain:'cart',input:{cartId:'c'},contract:{id:'quantity',version:1},scope:{name:'items',key:'a'},command:'setQuantity',value:3}]);
 });
 it('reports uncertain delivery on network failure and preserves server commit evidence',async()=>{
  let fail=true;const d=createRemoteDomain({provides:[Q]},{id:'cart',fetch:async()=>{if(fail)throw new Error('lost');return new Response(JSON.stringify({ok:false,error:{message:'Bad result',code:'OUTPUT_ERROR',committed:true}}),{status:500});}});
  const ctx={root:{},services:{},input:undefined};
  await expect(d.actions.setQuantity.run(2,ctx)).rejects.toMatchObject({committed:'unknown',code:'NETWORK_ERROR'});fail=false;
  await expect(d.actions.setQuantity.run(2,ctx)).rejects.toMatchObject({committed:true,code:'OUTPUT_ERROR'});
 });
 it('does not send invalid command input',async()=>{
  let called=false;const d=createRemoteDomain({provides:[Q]},{id:'cart',fetch:async()=>{called=true;return new Response('{}')}});
  await expect(d.actions.setQuantity.run('bad',{root:{},services:{},input:undefined})).rejects.toThrow();expect(called).toBe(false);
 });
});
