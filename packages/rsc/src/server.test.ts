// @vitest-environment node
import {it,expect} from 'vitest';
import {runWithDomain,readDomain} from './server';
it('isolates concurrent async request scopes',async()=>{const request=new Request('http://localhost/');const values=await Promise.all(['a','b'].map(id=>runWithDomain({state:{id},request},async()=>{await new Promise(r=>setTimeout(r,id==='a'?10:1));return readDomain<{id:string}>().id;})));expect(values).toEqual(['a','b']);expect(()=>readDomain()).toThrow('scope');});
