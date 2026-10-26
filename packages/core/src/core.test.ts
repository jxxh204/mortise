import { describe,it,expect } from 'vitest';
import { schema,defineCapability,defineDomain,provide,attachDomain,projectState,resolveProvider } from './index';
const Q=defineCapability({id:'quantity',version:1,state:{quantity:schema.integer()},commands:{setQuantity:{input:schema.integer(),output:schema.void()}}});
describe('contract boundaries',()=>{
 it('rejects invalid and nonfinite inputs',()=>{expect(()=>schema.integer().parse(1.2)).toThrow();expect(()=>schema.number().parse(Infinity)).toThrow();expect(schema.integer().parse(2)).toBe(2)});
 it('maps aliases and validates projection',()=>{const p=provide(Q,{state:{quantity:'guests'}});expect(projectState(p,{guests:3})).toEqual({quantity:3});expect(()=>projectState(p,{guests:'3'})).toThrow();expect(()=>projectState(p,{})).toThrow('Missing state')});
 it('rejects ambiguous providers and unknown overrides',()=>{expect(()=>defineDomain({provides:[Q,Q]})).toThrow('Duplicate');expect(()=>defineDomain({provides:[provide(Q,{state:{typo:'guests'}})]})).toThrow('Unknown state')});
 it('rejects missing actions and incompatible scope/version',()=>{const def=defineDomain({id:'cart',provides:[provide(Q,{scope:'items'})]});expect(()=>attachDomain(def,{query:{run:()=>({})},actions:{}})).toThrow('Missing action');const d=attachDomain(def,{query:{run:()=>({})},actions:{setQuantity:{run:()=>{}}}});expect(()=>resolveProvider(d,Q)).toThrow('No quantity');expect(resolveProvider(d,Q,'items').scope).toBe('items');expect(()=>resolveProvider(d,{...Q,version:2},'items')).toThrow('version')});
});
