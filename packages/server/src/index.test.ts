import { describe, it, expect, vi } from 'vitest';
import { attachDomain, defineDomain, defineCapability, provide, schema } from '@mortise/core';
import { createMortiseHandler, MortiseHttpError, type MortiseHandler } from './index';

const Quantity = defineCapability({ id: 'quantity', version: 1,
  state: { quantity: schema.integer() },
  commands: { setQuantity: { input: schema.integer(), output: schema.void() } },
});
function setup() {
  let saved = 2;
  const services = { secret: 'server-only' };
  const query = vi.fn((_input: unknown, ctx: any) => {
    expect(ctx.services).toBe(services);
    return { id: 'cart-1', items: [{ id: 'item-1', quantity: saved }] };
  });
  const action = vi.fn((next: number, ctx: any) => {
    expect(ctx.scope).toEqual({ name: 'items', key: 'item-1', value: { id: 'item-1', quantity: saved } });
    expect(ctx.root.id).toBe('cart-1');
    expect(ctx.services).toBe(services);
    saved = next;
  });
  const domain = attachDomain(defineDomain({ provides: [provide(Quantity, { scope: 'items' })] }), {
    id: 'cart', query: { input: schema.object({ cartId: schema.string() }), run: query },
    actions: { setQuantity: { run: action }, destroyEverything: { run: vi.fn() } },
  });
  const authorize = vi.fn(() => {});
  const handler = createMortiseHandler({ domains: { cart: domain }, context: () => ({ services, principal: 'user-1' }), authorize });
  const body = { domain: 'cart', input: { cartId: 'cart-1' }, contract: { id: 'quantity', version: 1 }, scope: { name: 'items', key: 'item-1' }, command: 'setQuantity', value: 3 };
  return { handler, body, query, action, authorize, domain, services, saved: () => saved };
}
function request(body: unknown, endpoint = 'command', options: RequestInit = {}) {
  return new Request(`http://localhost:8770/_mortise/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8770' },
    body: JSON.stringify(body), ...options,
  });
}
async function result(handler: MortiseHandler, req: Request) {
  const response = await handler(req);
  return { response, body: await response.json() };
}

describe('Mortise server RPC', () => {
  it('requires explicit authorization wiring', () => {
    expect(() => createMortiseHandler({ domains: {}, context: () => ({ services: {} }) } as any)).toThrow('authorize');
  });
  it('runs a query with server context and returns no-store JSON', async () => {
    const f = setup();
    const r = await result(f.handler, request({ domain: 'cart', input: { cartId: 'cart-1' } }, 'query'));
    expect(r.response.status).toBe(200);
    expect(r.response.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toEqual({ ok: true, data: { id: 'cart-1', items: [{ id: 'item-1', quantity: 2 }] } });
    expect(f.authorize).toHaveBeenCalledOnce();
  });
  it('resolves scope from a fresh server query instead of forged browser data', async () => {
    const f = setup();
    const r = await result(f.handler, request({ ...f.body, root: { id: 'hacked' }, services: { secret: 'hacked' }, scope: { ...f.body.scope, value: { quantity: 999 } } }));
    expect(r.body).toEqual({ ok: true });
    expect(f.saved()).toBe(3);
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.action).toHaveBeenCalledOnce();
  });
  it('denies unauthorized access before fetching any domain data', async () => {
    const f = setup();
    f.authorize.mockImplementation(() => { throw new MortiseHttpError(403, 'FORBIDDEN', 'Access denied.'); });
    const r = await result(f.handler, request(f.body));
    expect(r.response.status).toBe(403);
    expect(r.body.error).toEqual({ code: 'FORBIDDEN', message: 'Access denied.', committed: false });
    expect(f.query).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
  });
  it.each([
    ['unknown domain', { domain: 'missing' }, 404],
    ['prototype domain', { domain: '__proto__' }, 404],
    ['unknown version', { contract: { id: 'quantity', version: 2 } }, 404],
    ['unexposed action', { command: 'destroyEverything' }, 404],
    ['prototype command', { command: 'constructor' }, 404],
    ['wrong scope', { scope: { name: 'private', key: 'item-1' } }, 404],
    ['missing item', { scope: { name: 'items', key: 'other-user-item' } }, 404],
    ['invalid value', { value: 1.5 }, 400],
    ['invalid query input', { input: { cartId: 123 } }, 400],
  ])('rejects %s without invoking an action', async (_name, override, status) => {
    const f = setup();
    const r = await result(f.handler, request({ ...f.body, ...override }));
    expect(r.response.status).toBe(status);
    expect(r.body.ok).toBe(false); expect(r.body.error.committed).toBe(false);
    expect(f.action).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.example', 'null', 'not a URL'])('rejects mismatched Origin %s', async origin => {
    const f = setup();
    const r = await result(f.handler, request(f.body, 'command', { headers: { 'content-type': 'application/json', origin } }));
    expect(r.response.status).toBe(403); expect(f.authorize).not.toHaveBeenCalled();
  });
  it('allows no-Origin server clients while still authorizing', async () => {
    const f = setup();
    const r = await result(f.handler, request(f.body, 'command', { headers: { 'content-type': 'application/json' } }));
    expect(r.response.status).toBe(200); expect(f.authorize).toHaveBeenCalledOnce();
  });
  it('enforces expectedOrigin independent of the Request URL', async () => {
    const f = setup();
    const handler = createMortiseHandler({ domains: { cart: f.domain }, context: () => ({ services: f.services }), authorize: f.authorize, expectedOrigin: 'https://shop.example' });
    const r = await result(handler, request(f.body));
    expect(r.response.status).toBe(403);
  });
  it('rejects GET, non-JSON, malformed JSON and oversized bodies', async () => {
    const f = setup();
    expect((await f.handler(new Request('http://localhost:8770/_mortise/query'))).status).toBe(405);
    expect((await f.handler(request(f.body, 'command', { headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
    expect((await f.handler(request(f.body, 'command', { body: '{broken' }))).status).toBe(400);
    expect((await f.handler(request(f.body, 'command', { body: JSON.stringify({ data: 'x'.repeat(65536) }) }))).status).toBe(413);
    expect(f.action).not.toHaveBeenCalled();
  });
  it('limits streamed bodies without relying on Content-Length', async () => {
    const f = setup();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(40000)); controller.close(); } });
    const req = new Request('http://localhost:8770/_mortise/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect((await f.handler(req)).status).toBe(413);
  });
  it('sanitizes unexpected action errors and reports unknown commit outcome', async () => {
    const f = setup();
    f.action.mockImplementation(() => { throw new Error('postgres://password@private-host'); });
    const r = await result(f.handler, request(f.body));
    expect(r.response.status).toBe(500);
    expect(r.body.error.committed).toBe('unknown');
    expect(JSON.stringify(r.body)).not.toContain('password');
  });
  it('marks invalid output after a returned action as committed', async () => {
    const f = setup();
    f.domain.actions.setQuantity!.run = async () => 'invalid void output';
    const r = await result(f.handler, request(f.body));
    expect(r.body.error).toMatchObject({ code: 'INVALID_RESULT', committed: true });
  });
  it('never converts explicit action errors into definite no-write results', async () => {
    const f = setup();
    f.action.mockImplementation(() => { throw new MortiseHttpError(409, 'CONFLICT', 'Please reload.'); });
    const r = await result(f.handler, request(f.body));
    expect(r.response.status).toBe(409); expect(r.body.error.committed).toBe('unknown');
  });
  it('rejects non-JSON query output without leaking the serialization error', async () => {
    const f = setup();
    f.domain.query.run = () => ({ created: new Date() });
    const r = await result(f.handler, request({ domain: 'cart', input: { cartId: 'cart-1' } }, 'query'));
    expect(r.response.status).toBe(500); expect(r.body.error.code).toBe('INTERNAL_ERROR');
  });
});
