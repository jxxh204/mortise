import type { BoundDomain, ProviderBinding, Schema } from '@mortise/core';

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export type CommitState = boolean | 'unknown';
export type MortiseHandler = (request: Request) => Response | Promise<Response>;
export interface MortiseRequestContext { services: any; principal?: unknown }
export interface MortiseOperation {
  kind: 'query' | 'command';
  domain: string;
  input?: unknown;
  contract?: { id: string; version: number };
  scope?: { name: string; key: string | number };
  command?: string;
  value?: unknown;
}
export interface MortiseHandlerOptions<C extends MortiseRequestContext = MortiseRequestContext> {
  domains: Record<string, BoundDomain>;
  context(request: Request): C | Promise<C>;
  /** Required for every operation. Throw MortiseHttpError to deny access. */
  authorize(request: Request, context: C, operation: Readonly<MortiseOperation>): void | Promise<void>;
  expectedOrigin?: string;
  maxBodyBytes?: number;
  basePath?: string;
}
/** An intentional, safe-to-show HTTP error. Never put secrets in its message. */
export class MortiseHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'MortiseHttpError';
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new Error('Invalid HTTP error status');
  }
}
function fail(status: number, code: string, message: string): never {
  throw new MortiseHttpError(status, code, message);
}
export function errorResponse(error: unknown, committed: CommitState = false): Response {
  const known = error instanceof MortiseHttpError;
  return Response.json({ ok: false, error: {
    code: known ? error.code : 'INTERNAL_ERROR',
    message: known ? error.message : 'The operation could not be completed.',
    committed,
  } }, { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parseInput(schema: Schema<any> | undefined, value: unknown): any {
  if (!schema) return value;
  try { return schema.parse(value); }
  catch { return fail(400, 'INVALID_INPUT', 'The request input does not match its schema.'); }
}
function safePath(value: any, path: string): any {
  let current = value;
  for (const part of path.split('.')) {
    if (!part || ['__proto__', 'constructor', 'prototype'].includes(part) || !record(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
function assertJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 100) throw new Error('Result nesting exceeds the JSON limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) throw new Error('Result must contain only JSON values');
  if (seen.has(value)) throw new Error('Result contains a circular reference');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Result must use plain objects');
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) assertJson(entry, seen, depth + 1);
  seen.delete(value);
}
function success(data: unknown): Response {
  if (data !== undefined) assertJson(data);
  return Response.json(data === undefined ? { ok: true } : { ok: true, data }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
async function readBody(request: Request, limit: number): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > limit) fail(413, 'BODY_TOO_LARGE', 'Request body exceeds the size limit.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_JSON', 'A JSON request body is required.');
  let lengthRead = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lengthRead += value.byteLength;
      if (lengthRead > limit) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', 'Request body exceeds the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(lengthRead);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return fail(400, 'INVALID_JSON', 'The request body must be valid JSON.'); }
}
function operationFrom(body: unknown, kind: 'query' | 'command'): MortiseOperation {
  if (!record(body) || typeof body.domain !== 'string' || !body.domain) fail(400, 'INVALID_REQUEST', 'A domain name is required.');
  const operation: MortiseOperation = { kind, domain: body.domain, input: body.input };
  if (kind === 'query') return operation;
  if (!record(body.contract) || typeof body.contract.id !== 'string' || !body.contract.id ||
      !Number.isSafeInteger(body.contract.version) || (body.contract.version as number) < 1 ||
      typeof body.command !== 'string' || !body.command) fail(400, 'INVALID_REQUEST', 'A contract and command are required.');
  operation.contract = { id: body.contract.id, version: body.contract.version as number };
  operation.command = body.command;
  operation.value = body.value;
  if (body.scope !== undefined) {
    if (!record(body.scope) || typeof body.scope.name !== 'string' || !body.scope.name ||
      !(typeof body.scope.key === 'string' || (typeof body.scope.key === 'number' && Number.isFinite(body.scope.key)))) {
      fail(400, 'INVALID_SCOPE', 'A scope requires a name and a string or finite number key.');
    }
    operation.scope = { name: body.scope.name, key: body.scope.key as string | number };
  }
  return operation;
}
function resolveBinding(domain: BoundDomain, operation: MortiseOperation): ProviderBinding {
  const providers = domain.definition.provides.filter(provider =>
    provider.contract.id === operation.contract!.id && provider.contract.version === operation.contract!.version &&
    provider.scope === operation.scope?.name,
  );
  if (providers.length !== 1) fail(404, 'UNKNOWN_CAPABILITY', 'The requested capability is not available.');
  const provider = providers[0]!;
  if (!Object.hasOwn(provider.contract.commands, operation.command!)) fail(404, 'UNKNOWN_COMMAND', 'The requested command is not available.');
  return provider;
}

/** JSON RPC for client-rendered Mortise domains. This is not an RSC renderer. */
export function createMortiseHandler<C extends MortiseRequestContext>(options: MortiseHandlerOptions<C>): MortiseHandler {
  if (typeof options.authorize !== 'function') throw new Error('createMortiseHandler requires an authorize callback');
  if (typeof options.context !== 'function') throw new Error('createMortiseHandler requires a context callback');
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('maxBodyBytes must be a positive integer');
  const base = (options.basePath ?? '/_mortise').replace(/\/$/, '');
  const fixedOrigin = options.expectedOrigin ? new URL(options.expectedOrigin).origin : undefined;
  return async request => {
    let committed: CommitState = false;
    try {
      const url = new URL(request.url);
      const kind = url.pathname === `${base}/query` ? 'query' : url.pathname === `${base}/command` ? 'command' : null;
      if (!kind) fail(404, 'NOT_FOUND', 'Endpoint not found.');
      if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Use POST for Mortise requests.');
      const origin = request.headers.get('origin');
      if (origin && origin !== (fixedOrigin ?? url.origin)) fail(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
      if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'ORIGIN_REJECTED', 'Cross-site requests are not allowed.');
      const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
      const operation = operationFrom(await readBody(request, limit), kind);
      const context = await options.context(request);
      await options.authorize(request, context, operation);
      if (!Object.hasOwn(options.domains, operation.domain)) fail(404, 'UNKNOWN_DOMAIN', 'The requested domain is not available.');
      const domain = options.domains[operation.domain]!;
      const input = parseInput(domain.query.input, operation.input);
      const executionContext = { ...context, root: undefined, input, signal: request.signal };
      if (kind === 'query') {
        const root = await domain.query.run(input, executionContext);
        if (root === undefined) throw new Error('A domain query must return JSON data');
        return success(root);
      }
      const provider = resolveBinding(domain, operation);
      const command = provider.contract.commands[operation.command!];
      const value = parseInput(command.input, operation.value);
      const target = provider.commands?.[operation.command!] ?? operation.command!;
      if (!Object.hasOwn(domain.actions, target)) fail(404, 'UNKNOWN_COMMAND', 'The requested command is not available.');
      const action = domain.actions[target]!;
      const actionInput = parseInput(action.input, value);
      // Never use a root or scope value supplied by the browser.
      const root = await domain.query.run(input, executionContext);
      let scope: { key: string | number; value: unknown; name: string } | undefined;
      if (operation.scope) {
        const items = safePath(root, provider.scope!);
        if (!Array.isArray(items)) throw new Error('Configured scope is not a collection');
        const matching = items.filter(item => safePath(item, provider.key ?? 'id') === operation.scope!.key);
        if (!matching.length) fail(404, 'SCOPE_NOT_FOUND', 'The requested item is not available.');
        if (matching.length !== 1) throw new Error('Configured scope contains duplicate keys');
        scope = { key: operation.scope.key, value: matching[0], name: operation.scope.name };
      }
      committed = 'unknown';
      const result = await action.run(actionInput, { ...executionContext, root, scope });
      committed = true;
      let output: unknown;
      try {
        output = action.output ? action.output.parse(result) : result;
        output = command.output.parse(output);
        if (output !== undefined) assertJson(output);
      } catch { fail(500, 'INVALID_RESULT', 'The command completed but its result was invalid.'); }
      return success(output);
    } catch (error) { return errorResponse(error, committed); }
  };
}
