import { attachDomain, defineDomain, type DomainDefinition, type BoundDomain } from './index.js';

/** A remote failure records what the server can confirm, not whether delivery succeeded. */
export class RemoteError extends Error {
  readonly name = 'RemoteError';
  constructor(message: string, readonly code: string, readonly committed: boolean | 'unknown' = 'unknown', readonly status?: number) {
    super(message);
  }
}
export interface RemoteDomainOptions {
  id: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

/** Create browser-safe functions from contract metadata. No Query/Action implementation is imported. */
export function createRemoteDomain(definition: DomainDefinition, options: RemoteDomainOptions): BoundDomain {
  const normalized = defineDomain(definition);
  const id = normalized.id ?? options.id;
  const endpoint = (options.endpoint ?? '/_mortise').replace(/\/$/, '');
  const request = async (kind: 'query' | 'command', body: object, signal?: AbortSignal): Promise<unknown> => {
    const fetcher = options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetcher(`${endpoint}/${kind}`, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new RemoteError('The server could not be reached. Check the latest state before retrying a command.', 'NETWORK_ERROR');
    }
    let envelope: any;
    try { envelope = await response.json(); }
    catch { throw new RemoteError('The server returned an invalid response.', 'INVALID_RESPONSE', 'unknown', response.status); }
    if (!response.ok || envelope?.ok !== true) {
      const error = envelope?.error;
      const committed = error?.committed === true || error?.committed === false ? error.committed : 'unknown';
      throw new RemoteError(typeof error?.message === 'string' ? error.message : 'The request failed.', typeof error?.code === 'string' ? error.code : 'REMOTE_ERROR', committed, response.status);
    }
    return envelope.data;
  };
  const actions: BoundDomain['actions'] = {};
  for (const provider of normalized.provides) {
    for (const name of Object.keys(provider.contract.commands)) {
      const target = provider.commands?.[name] ?? name;
      // Different scopes can bind the same action name. Dispatch by the active scope at runtime.
      if (actions[target]) continue;
      actions[target] = {
        async run(value, ctx) {
          const active = normalized.provides.filter(p =>
            p.scope === ctx.scope?.name && Object.entries(p.contract.commands).some(([key]) => (p.commands?.[key] ?? key) === target));
          if (active.length !== 1) throw new Error(`Ambiguous remote action ${target}; use distinct action targets for different contracts.`);
          const binding = active[0]!;
          const member = Object.keys(binding.contract.commands).find(key => (binding.commands?.[key] ?? key) === target)!;
          const descriptor = binding.contract.commands[member];
          const parsed = descriptor.input.parse(value);
          const data = await request('command', {
            domain: id, input: ctx.input,
            contract: { id: binding.contract.id, version: binding.contract.version },
            scope: ctx.scope ? { name: binding.scope, key: ctx.scope.key } : undefined,
            command: member, value: parsed,
          });
          try { return descriptor.output.parse(data); }
          catch { throw new RemoteError('The command completed, but its result did not match the contract.', 'RESULT_ERROR', true); }
        },
      };
    }
  }
  return attachDomain(normalized, {
    id,
    query: { run(input, ctx) { return request('query', { domain:id, input }, ctx.signal); } },
    actions,
  });
}
