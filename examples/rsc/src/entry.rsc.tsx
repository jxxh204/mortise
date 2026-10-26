import React from 'react';
import {renderToReadableStream} from '@vitejs/plugin-rsc/rsc/server';
import {createMortiseHandler,MortiseHttpError} from '@mortise/server';
import domains from 'mortise:server-domains';
import {runWithDomain} from '@mortise/rsc/server';
import Cart from './domains/cart/ui/server/Cart';
import {services} from './server-services';
import type {RscPayload} from '@mortise/rsc/client';
import './style.css';
const rpc=createMortiseHandler({expectedOrigin:import.meta.env.DEV?"http://127.0.0.1:8772":(process.env.MORTISE_ORIGIN??"http://127.0.0.1:8773"),domains,context:()=>({services}),authorize(_req,_ctx,op){if(op.domain!=='cart'||!['cart-main','cart-other'].includes((op.input as any)?.cartId))throw new MortiseHttpError(403,'FORBIDDEN','이 데모 장바구니에 접근할 수 없습니다.');}});
async function handler(request:Request):Promise<Response>{
 const url=new URL(request.url);if(url.pathname.startsWith('/_mortise/'))return rpc(request);
 if(request.method!=='GET')return new Response('Method not allowed',{status:405});
 if(url.pathname!=='/'&&url.pathname!=='/index.rsc')return new Response('Not found',{status:404});
 const revision=Number(url.searchParams.get('__revision')??0);if(!Number.isSafeInteger(revision)||revision<0)return new Response('Invalid revision',{status:400});
 const input={cartId:url.searchParams.get('cart')??'cart-main'};
 const headers=new Headers(request.headers);headers.set('Content-Type','application/json');headers.delete('content-length');
 // This safe GET is adapted to an internal read-only query. Keep cookies/auth,
 // but do not apply browser mutation-origin metadata to the synthetic POST.
 headers.delete('origin');headers.delete('sec-fetch-site');
 const response=await rpc(new Request(new URL('/_mortise/query',url),{method:'POST',headers,signal:request.signal,body:JSON.stringify({domain:'cart',input})}));if(!response.ok)return response;
 const state=(await response.json()).data;const snapshot={state,revision};
 const stream=runWithDomain({state,input,request},()=>renderToReadableStream<RscPayload>({root:<>{import.meta.viteRsc.loadCss()}<Cart snapshot={snapshot}/></>,snapshot},{onError(){return 'Mortise server render failed';}}));
 if(url.pathname==='/index.rsc')return new Response(stream,{headers:{'Content-Type':'text/x-component;charset=utf-8','Cache-Control':'no-store'}});
 const ssr=await import.meta.viteRsc.loadModule<typeof import('./entry.ssr')>('ssr','index');
 return new Response(await ssr.renderHTML(stream),{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
}
export default {fetch:handler};if(import.meta.hot)import.meta.hot.accept();
