'use client';

import React, {
  createContext, useContext, useEffect, useLayoutEffect, useId, useMemo, useState,
  useSyncExternalStore, type ReactNode,
} from 'react';
import { QueryClient, QueryClientProvider, useQuery, hashKey } from '@tanstack/react-query';
import { RemoteError } from '@mortise/core';
import type { AnyCapability, BoundDomain, ProviderBinding, InferState, Schema } from '@mortise/core';

export type CommandResult<T = unknown> =
  | { ok: true; status: 'success'; committed: true; data: T }
  | { ok: false; status: 'validation-error' | 'action-error'; committed: false | 'unknown'; error: Error }
  | { ok: false; status: 'refresh-error' | 'result-error'; committed: true; error: Error };
export type Command<I = unknown, O = unknown> = {
  execute(input: I): Promise<CommandResult<O>>;
  readonly pending: boolean;
  readonly error: Error | null;
};
type SchemaValue<S> = S extends { parse(value: unknown, ...args: any[]): infer T } ? T : never;
export type CapabilityCommands<C extends AnyCapability> = {
  readonly [K in keyof C['commands']]: Command<SchemaValue<C['commands'][K]['input']>, SchemaValue<C['commands'][K]['output']>>;
};
/** Injected view arguments. The Vite plugin binds this capability to the local domain. */
export type UI<C extends AnyCapability, Props = {}> = {
  readonly state: Readonly<InferState<C>>;
  readonly commands: CapabilityCommands<C>;
  readonly props: Props;
};

/** Per-boundary response ordering, not a database/entity version. */
export interface DomainSnapshot { state: unknown; revision: number }
const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
function checkRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Snapshot revision must be a non-negative safe integer.');
}

type Scope = { name: string; key: string | number; keyField: string };
type CommandState = { pending: number; error: Error | null };
const idleState: CommandState = Object.freeze({ pending: 0, error: null });
const noServices = Object.freeze({});
let runtimeSequence = 0;
const DomainContext = createContext<Runtime | null>(null);
const ScopeContext = createContext<Scope | null>(null);

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
function readPath(value: any, path: string): any {
  return path.split('.').reduce((current, part) => {
    if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error(`Unsafe path: ${path}`);
    return current?.[part];
  }, value);
}
function findScope(root: any, scope: Scope | null): any {
  if (!scope) return root;
  const collection = readPath(root, scope.name);
  if (!Array.isArray(collection)) throw new Error(`Scope "${scope.name}" must be an array.`);
  const item = collection.find(value => readPath(value, scope.keyField) === scope.key);
  if (!item) throw new Error(`Scope "${scope.name}" no longer contains key "${scope.key}".`);
  return item;
}
function bindingFor(runtime: Runtime, contract: AnyCapability, scope: Scope | null): ProviderBinding {
  const candidates = runtime.domain.definition.provides.filter(binding =>
    binding.contract.id === contract.id && binding.contract.version === contract.version &&
    (binding.scope ?? null) === (scope?.name ?? null),
  );
  if (candidates.length !== 1) throw new Error(
    `Expected one provider for ${contract.id}@${contract.version} in ${scope?.name ?? 'root'}; found ${candidates.length}.`,
  );
  return candidates[0]!;
}

class Runtime {
  readonly queryKey: readonly unknown[];
  private queue: Promise<unknown> = Promise.resolve();
  private states = new Map<string, CommandState>();
  private listeners = new Map<string, Set<() => void>>();
  private executors = new Map<string, (input: unknown) => Promise<CommandResult>>();
  active = true;
  refresh: (() => Promise<DomainSnapshot>) | undefined;
  private revision: number;
  constructor(
    readonly domain: BoundDomain,
    readonly input: unknown,
    readonly services: unknown,
    readonly client: QueryClient,
    instanceId: string,
    readonly initialState: unknown,
    initialRevision: number | undefined,
  ) {
    if (initialRevision !== undefined) checkRevision(initialRevision);
    this.revision = initialState === undefined ? -1 : (initialRevision ?? 0);
    this.queryKey = ['mortise', domain.id, instanceId, ++runtimeSequence, input];
  }
  applySnapshot(snapshot: DomainSnapshot): boolean {
    checkRevision(snapshot.revision);
    if (snapshot.state === undefined) throw new Error('A refreshed domain snapshot must contain state.');
    if (!this.active || snapshot.revision <= this.revision) return false;
    // Cancellation occurs before publication; old fetch results cannot replace this snapshot.
    void this.client.cancelQueries({ queryKey: this.queryKey, exact: true });
    this.client.setQueryData(this.queryKey, snapshot.state);
    this.revision = snapshot.revision;
    return true;
  }
  options = () => ({
    queryKey: this.queryKey,
    initialData: this.initialState,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const input = this.domain.query.input ? this.domain.query.input.parse(this.input) : this.input;
      const context = { root: undefined, services: this.services, input, signal };
      return this.domain.query.run(input, context);
    },
    staleTime: Infinity,
    retry: false as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  snapshot = (key: string) => this.states.get(key) ?? idleState;
  subscribe = (key: string, listener: () => void) => {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key); };
  };
  private update(key: string, next: CommandState) {
    this.states.set(key, next);
    this.listeners.get(key)?.forEach(listener => listener());
  }
  commandKey(contract: AnyCapability, scope: Scope | null, name: string) {
    return JSON.stringify([contract.id, contract.version, scope?.name, scope?.key, name]);
  }
  executor(contract: AnyCapability, binding: ProviderBinding, scope: Scope | null, name: string) {
    const key = this.commandKey(contract, scope, name);
    let execute = this.executors.get(key);
    if (execute) return execute;
    execute = (rawInput: unknown) => {
      let parsed: unknown;
      try {
        if (!this.active) throw new Error('This domain instance has been unmounted.');
        parsed = contract.commands[name]!.input.parse(rawInput);
      } catch (reason) {
        const error = asError(reason);
        this.update(key, { ...this.snapshot(key), error });
        return Promise.resolve({ ok: false, status: 'validation-error', committed: false, error } as const);
      }
      this.update(key, { pending: this.snapshot(key).pending + 1, error: null });
      const task = async (): Promise<CommandResult> => {
        let committed = false;
        let phase: 'action' | 'result' | 'refresh' = 'action';
        try {
          if (!this.active) throw new Error('This domain instance has been unmounted.');
          await this.client.cancelQueries({ queryKey: this.queryKey, exact: true });
          const root = this.client.getQueryData(this.queryKey);
          const value = findScope(root, scope);
          const actionName = binding.commands?.[name] ?? name;
          const action = this.domain.actions[actionName];
          if (!action) throw new Error(`Action "${actionName}" is not registered in ${this.domain.id}.`);
          const actionInput = action.input ? action.input.parse(parsed) : parsed;
          const output = await action.run(actionInput, {
            root, scope: scope ? { key: scope.key, value, name: scope.name } : undefined,
            services: this.services, input: this.input,
          });
          committed = true;
          phase = 'result';
          const actionOutput = action.output ? action.output.parse(output) : output;
          const data = contract.commands[name]!.output.parse(actionOutput);
          phase = 'refresh';
          if (this.active) {
            await this.client.cancelQueries({ queryKey: this.queryKey, exact: true });
            if (this.refresh) {
              const previousRevision = this.revision;
              const snapshot = await this.refresh();
              checkRevision(snapshot.revision);
              if (snapshot.revision <= previousRevision && this.revision <= previousRevision) {
                throw new Error('Refresh did not provide a newer snapshot revision.');
              }
              this.applySnapshot(snapshot);
            } else {
              await this.client.fetchQuery({ ...this.options(), staleTime: 0 });
            }
          }
          this.update(key, { pending: this.snapshot(key).pending - 1, error: null });
          return { ok: true, status: 'success', committed: true, data };
        } catch (reason) {
          const error = asError(reason);
          this.update(key, { pending: this.snapshot(key).pending - 1, error });
          const confirmed = error instanceof RemoteError ? error.committed : committed;
          return confirmed === true
            ? { ok: false, status: phase !== 'refresh' ? 'result-error' : 'refresh-error', committed: true, error }
            : { ok: false, status: 'action-error', committed: confirmed, error };
        }
      };
      const result = this.queue.then(task, task);
      this.queue = result;
      return result;
    };
    this.executors.set(key, execute);
    return execute;
  }
}

export interface DomainProviderProps {
  domain: BoundDomain;
  input?: unknown;
  services?: unknown;
  children: ReactNode;
  fallback?: ReactNode;
  errorFallback?: ReactNode | ((error: Error) => ReactNode);
  queryClient?: QueryClient;
  /** Server snapshot used for first render/hydration without a browser query. */
  initialState?: unknown;
  /** A larger revision publishes a later external snapshot without remounting UI. */
  revision?: number;
  /** Experimental RSC bridge: refresh the tree and return its authoritative snapshot. */
  onRefresh?: () => Promise<DomainSnapshot>;
}
export function DomainProvider({ queryClient, ...props }: DomainProviderProps) {
  const [ownClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient ?? ownClient}>
    <DomainBoundary {...props} client={queryClient ?? ownClient} />
  </QueryClientProvider>;
}
function DomainBoundary({ domain, input, services = noServices, client, children, fallback = null, errorFallback, initialState, revision, onRefresh }: Omit<DomainProviderProps, 'queryClient'> & { client: QueryClient }) {
  const id = useId();
  const inputHash = hashKey([input]);
  const runtime = useMemo(() => new Runtime(domain, input, services, client, id, initialState, revision), [domain, inputHash, services, client, id]);
  useCommitEffect(() => {
    runtime.refresh = onRefresh;
    if (revision !== undefined && initialState !== undefined) runtime.applySnapshot({ state: initialState, revision });
  }, [runtime, onRefresh, initialState, revision]);
  useEffect(() => {
    runtime.active = true;
    return () => {
      runtime.active = false;
      void client.cancelQueries({ queryKey: runtime.queryKey, exact: true });
    };
  }, [runtime, client]);
  const query = useQuery(runtime.options());
  if (query.data === undefined) {
    if (query.error) {
      if (errorFallback !== undefined) return <>{typeof errorFallback === 'function' ? errorFallback(asError(query.error)) : errorFallback}</>;
      throw query.error;
    }
    return <>{fallback}</>;
  }
  return <DomainContext.Provider value={runtime}><ScopeContext.Provider value={null}>{children}</ScopeContext.Provider></DomainContext.Provider>;
}
function useRuntime() {
  const runtime = useContext(DomainContext);
  if (!runtime) throw new Error('Mortise UI must be rendered inside a DomainProvider.');
  return runtime;
}
export function Each({ scope, keyBy, children }: { scope: string; keyBy?: string; children: ReactNode }) {
  const runtime = useRuntime();
  const configuredKeys = [...new Set(runtime.domain.definition.provides.filter(binding => binding.scope === scope).map(binding => binding.key ?? 'id'))];
  if (configuredKeys.length > 1) throw new Error(`Conflicting item keys for scope "${scope}".`);
  const keyField = keyBy ?? configuredKeys[0] ?? 'id';
  const select = useMemo(() => (root: any) => {
    const items = readPath(root, scope);
    if (!Array.isArray(items)) throw new Error(`Scope "${scope}" must be an array.`);
    const keys = items.map(item => readPath(item, keyField));
    if (keys.some(key => typeof key !== 'string' && typeof key !== 'number')) throw new Error(`Scope "${scope}" requires stable string/number keys.`);
    if (new Set(keys).size !== keys.length) throw new Error(`Scope "${scope}" contains duplicate keys.`);
    return keys as (string | number)[];
  }, [scope, keyField]);
  const query = useQuery({ ...runtime.options(), select });
  if (query.error && query.data === undefined) throw query.error;
  return <>{query.data?.map(key => <ScopeContext.Provider key={`${typeof key}:${key}`} value={{ name: scope, key, keyField }}>{children}</ScopeContext.Provider>)}</>;
}

export function useCapability<C extends AnyCapability>(contract: C): {
  readonly state: Readonly<InferState<C>>;
  readonly commands: CapabilityCommands<C>;
} {
  const runtime = useRuntime();
  const scope = useContext(ScopeContext);
  const scopeName = scope?.name;
  const scopeKey = scope?.key;
  const keyField = scope?.keyField;
  const stableScope = useMemo(() => scope, [scopeName, scopeKey, keyField]);
  const binding = useMemo(() => bindingFor(runtime, contract, stableScope), [runtime, contract, stableScope]);
  const select = useMemo(() => (root: any) => {
    const source = findScope(root, stableScope);
    const result: Record<string, unknown> = {};
    for (const [field, validator] of Object.entries(contract.state as Record<string, Schema<unknown>>)) {
      result[field] = validator.parse(readPath(source, binding.state?.[field] ?? field), field);
    }
    return Object.freeze(result) as Readonly<InferState<C>>;
  }, [contract, binding, stableScope]);
  const query = useQuery({ ...runtime.options(), select });
  const commandNames = Object.keys(contract.commands);
  const store = useMemo(() => {
    const keys = commandNames.map(name => runtime.commandKey(contract, stableScope, name));
    let previous: CommandState[] = [];
    return {
      subscribe(listener: () => void) {
        const cleanups = keys.map(key => runtime.subscribe(key, listener));
        return () => cleanups.forEach(cleanup => cleanup());
      },
      snapshot() {
        const next = keys.map(key => runtime.snapshot(key));
        if (next.length !== previous.length || next.some((value, i) => value !== previous[i])) previous = next;
        return previous;
      },
    };
  }, [runtime, contract, stableScope]);
  const states = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const commands = useMemo(() => Object.fromEntries(commandNames.map((name, index) => [name, {
    execute: runtime.executor(contract, binding, stableScope, name),
    pending: states[index]!.pending > 0,
    error: states[index]!.error,
  }])) as CapabilityCommands<C>, [runtime, contract, binding, stableScope, states]);
  if (query.error && query.data === undefined) throw query.error;
  if (!query.data) throw new Error(`Capability ${contract.id} has no state.`);
  return { state: query.data, commands };
}

/** Subscribe to a projection of the domain root snapshot (not the item scope). */
export function useDomain<T>(select: (root: any) => T): T {
  const runtime = useRuntime();
  const query = useQuery({ ...runtime.options(), select });
  if (query.error && query.data === undefined) throw query.error;
  if (query.data === undefined) throw new Error('The domain query returned no data.');
  return query.data;
}
