"use client";
import React,{createContext,useContext,useRef,useState,startTransition,type ReactNode} from 'react';
import type {DomainSnapshot} from '@mortise/react';
export interface RscPayload {root:ReactNode;snapshot:DomainSnapshot}
const RefreshContext=createContext<(()=>Promise<DomainSnapshot>)|null>(null);
export function useRscRefresh(){const refresh=useContext(RefreshContext);if(!refresh)throw new Error('RSC bridge must be inside RscRoot');return refresh;}
/** Experimental: one domain per root. Stream/cache publication is not an atomic React commit. */
export function RscRoot({initialPayload,load}:{initialPayload:RscPayload;load?:(revision:number)=>Promise<RscPayload>}){
 const [payload,setPayload]=useState(initialPayload);const current=useRef(initialPayload);const sequence=useRef(initialPayload.snapshot.revision);const loadRef=useRef(load);loadRef.current=load;
 const refresh=async()=>{if(!loadRef.current)throw new Error('RSC refresh is unavailable during SSR');const next=await loadRef.current(++sequence.current);if(next.snapshot.revision>current.current.snapshot.revision){current.current=next;startTransition(()=>setPayload(next));}return current.current.snapshot;};
 return <RefreshContext.Provider value={refresh}>{payload.root}</RefreshContext.Provider>;
}
