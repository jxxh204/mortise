import {AsyncLocalStorage} from 'node:async_hooks';
interface DomainScope { state:unknown; input?:unknown; request:Request }
const storage=new AsyncLocalStorage<DomainScope>();
/** Start renderToReadableStream here, not after this callback returns JSX. */
export function runWithDomain<T>(scope:DomainScope,render:()=>T):T{return storage.run(scope,render);}
export function readDomain<T=unknown>():Readonly<T>{const scope=storage.getStore();if(!scope)throw new Error('readDomain requires a Mortise RSC request scope');return scope.state as Readonly<T>;}
export function readDomainInput<T=unknown>():T{const scope=storage.getStore();if(!scope)throw new Error('No Mortise RSC request scope');return scope.input as T;}
