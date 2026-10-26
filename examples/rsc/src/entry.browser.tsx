import React from 'react';
import {hydrateRoot} from 'react-dom/client';
import {createFromReadableStream,createFromFetch} from '@vitejs/plugin-rsc/browser';
import {rscStream} from 'rsc-html-stream/client';
import {RscRoot,type RscPayload} from '@mortise/rsc/client';
async function main(){const payload=await createFromReadableStream<RscPayload>(rscStream);const load=async(revision:number)=>{const url=new URL('/index.rsc',window.location.href);url.search=new URL(window.location.href).search;url.searchParams.set('__revision',String(revision));return createFromFetch<RscPayload>(fetch(url,{headers:{Accept:'text/x-component'},cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('RSC 화면 갱신 실패');return r;}));};hydrateRoot(document.getElementById('root')!,<RscRoot initialPayload={payload} load={load}/>,{onRecoverableError(error){console.error('Mortise hydration recovery',error);}});}
void main().catch(error=>console.error('Mortise bootstrap failed',error));
