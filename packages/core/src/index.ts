export interface Schema<T> { parse(value: unknown, path?: string): T }
export type Infer<T> = T extends Schema<infer V> ? V : never;
function check<T>(expected: string, accept: (value: unknown) => boolean): Schema<T> {
  return { parse(value, path = 'value') {
    if (!accept(value)) throw new Error(`${path}: expected ${expected}`);
    return value as T;
  } };
}
export const schema = {
  integer: () => check<number>('finite integer', v => typeof v === 'number' && Number.isSafeInteger(v)),
  number: () => check<number>('finite number', v => typeof v === 'number' && Number.isFinite(v)),
  string: () => check<string>('string', v => typeof v === 'string'),
  boolean: () => check<boolean>('boolean', v => typeof v === 'boolean'),
  void: () => check<void>('undefined', v => v === undefined),
  object: <S extends Record<string, Schema<any>>>(shape: S): Schema<{[K in keyof S]: Infer<S[K]>}> => ({
    parse(value, path = 'value') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected object`);
      return Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.parse((value as Record<string, unknown>)[k], `${path}.${k}`)])) as {[K in keyof S]: Infer<S[K]>};
    },
  }),
};
export interface CommandSchema<I = any, O = any> { input: Schema<I>; output: Schema<O> }
export interface Capability<S extends Record<string, Schema<any>> = Record<string, Schema<any>>, C extends Record<string, CommandSchema> = Record<string, CommandSchema>> {
  readonly id: string; readonly version: number; readonly state: S; readonly commands: C;
}
export type AnyCapability = Capability<any, any>;
export type InferState<C extends AnyCapability> = C extends Capability<infer S, any> ? Readonly<{[K in keyof S]: Infer<S[K]>}> : never;
export type InferCommands<C extends AnyCapability> = C extends Capability<any, infer M> ? {[K in keyof M]: {input: Infer<M[K]['input']>; output: Infer<M[K]['output']>}} : never;
export function defineCapability<S extends Record<string, Schema<any>>, C extends Record<string, CommandSchema>>(contract: Capability<S,C>): Capability<S,C> {
  if (!contract.id.trim() || !Number.isSafeInteger(contract.version) || contract.version < 1) throw new Error('Capability needs a non-empty id and positive integer version');
  return Object.freeze({...contract, state:Object.freeze({...contract.state}),commands:Object.freeze({...contract.commands})});
}
export interface ProviderOptions { scope?: string; key?: string; state?: Record<string,string>; commands?: Record<string,string> }
export interface ProviderBinding extends ProviderOptions { contract: AnyCapability }
export function provide(contract: AnyCapability, options: ProviderOptions = {}): ProviderBinding { return {contract,...options}; }
export interface DomainDefinition { id?: string; provides: readonly (ProviderBinding | AnyCapability)[] }
export interface NormalizedDomainDefinition { id?: string; provides: readonly ProviderBinding[] }
export function defineDomain(definition: DomainDefinition): NormalizedDomainDefinition {
  const provides = definition.provides.map(p => 'contract' in p ? p as ProviderBinding : provide(p as AnyCapability));
  const seen = new Set<string>();
  for (const p of provides) {
    if (p.key && !p.scope) throw new Error('An item key requires a collection scope');
    const key = `${p.scope ?? '$root'}:${p.contract.id}`;
    if (seen.has(key)) throw new Error(`Duplicate capability provider: ${key}`);
    seen.add(key);
    for (const name of Object.keys(p.state ?? {})) if (!(name in p.contract.state)) throw new Error(`Unknown state member: ${name}`);
    for (const name of Object.keys(p.commands ?? {})) if (!(name in p.contract.commands)) throw new Error(`Unknown command member: ${name}`);
  }
  return {...definition,provides};
}
export interface ExecutionContext { root: any; scope?: {key: string | number; value: any; name?: string}; services: any; input: any; signal?: AbortSignal }
export interface QueryDefinition<I = any, O = any> { input?: Schema<I>; run(input: I, ctx: ExecutionContext): O | Promise<O> }
export interface ActionDefinition<I = any, O = any> { input?: Schema<I>; output?: Schema<O>; run(input: I, ctx: ExecutionContext): O | Promise<O> }
export function defineQuery<I = void, O = unknown>(query: QueryDefinition<I,O>): QueryDefinition<I,O> { return query; }
export function defineAction<I = any, O = void>(action: ActionDefinition<I,O>): ActionDefinition<I,O> { return action; }
export interface BoundDomain { id: string; definition: NormalizedDomainDefinition; query: QueryDefinition; actions: Record<string,ActionDefinition> }
export function attachDomain(definition: DomainDefinition, discovered: {id?: string; query: QueryDefinition; actions: Record<string,ActionDefinition>}): BoundDomain {
  const normalized = defineDomain(definition);
  if (!discovered.query || typeof discovered.query.run !== 'function') throw new Error('Domain needs queries/state.ts with a default defineQuery export');
  for (const provider of normalized.provides) {
    for (const name of Object.keys(provider.contract.commands)) {
      const target = provider.commands?.[name] ?? name;
      if (!Object.hasOwn(discovered.actions,target) || typeof discovered.actions[target]?.run !== 'function') throw new Error(`Missing action "${target}" for ${provider.contract.id}.${name}`);
    }
  }
  const id = normalized.id ?? discovered.id;
  if (!id) throw new Error('Domain needs an id or a discovered folder name');
  return {id,definition:normalized,query:discovered.query,actions:discovered.actions};
}
export function resolveProvider(domain: BoundDomain, contract: AnyCapability, scope?: string): ProviderBinding {
  const provider = domain.definition.provides.find(p => p.contract.id === contract.id && p.scope === scope);
  if (!provider) throw new Error(`No ${contract.id} provider in scope ${scope ?? '$root'} of domain ${domain.id}`);
  if (provider.contract.version !== contract.version) throw new Error(`Contract version mismatch for ${contract.id}`);
  return provider;
}
export function projectState(provider: ProviderBinding, source: unknown): Record<string,unknown> {
  if (!source || typeof source !== 'object') throw new Error(`Missing state for ${provider.contract.id}`);
  return Object.fromEntries(Object.entries(provider.contract.state as Record<string,Schema<unknown>>).map(([key,s])=> {
    const target = provider.state?.[key] ?? key;
    if (!Object.hasOwn(source,target)) throw new Error(`Missing state member ${target} for ${provider.contract.id}.${key}`);
    return [key,s.parse((source as Record<string,unknown>)[target],`${provider.contract.id}.${key}`)];
  }));
}

export { createRemoteDomain, RemoteError, type RemoteDomainOptions } from "./http.js";
