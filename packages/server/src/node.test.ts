// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMortiseServer } from './node';
import { createMortiseHandler } from './index';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Mortise Node HTTP adapter', () => {
  it('builds Request URLs using trusted publicOrigin, not incoming Host', async () => {
    const server = createMortiseServer(request => Response.json({ url: request.url, body: null }), { publicOrigin: 'https://shop.example' });
    const address = await listen(server);
    const response = await fetch(`${address}/_mortise/query`, { method: 'POST', headers: { Host: 'attacker.example', 'content-type': 'application/json' }, body: '{}' });
    expect(await response.json()).toMatchObject({ url: 'https://shop.example/_mortise/query' });
  });
  it('rejects mismatched browser Origin through a real HTTP request', async () => {
    const handler = createMortiseHandler({ domains: {}, context: () => ({ services: {} }), authorize: () => {} });
    const address = await listen(createMortiseServer(handler, { publicOrigin: 'https://shop.example' }));
    const response = await fetch(`${address}/_mortise/query`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://attacker.example' }, body: '{}' });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ORIGIN_REJECTED');
  });
  it('returns 413 before passing an oversized body to the Fetch handler', async () => {
    const address = await listen(createMortiseServer(() => Response.json({ ok: true }), { publicOrigin: 'https://shop.example', maxBodyBytes: 16 }));
    const response = await fetch(`${address}/_mortise/query`, { method: 'POST', body: 'x'.repeat(17) });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('BODY_TOO_LARGE');
  });
  it('forwards status, body, and multiple Set-Cookie headers', async () => {
    const headers = new Headers(); headers.append('Set-Cookie', 'a=1; HttpOnly'); headers.append('Set-Cookie', 'b=2; HttpOnly');
    const address = await listen(createMortiseServer(() => new Response('created', { status: 201, headers }), { publicOrigin: 'https://shop.example' }));
    const response = await fetch(address);
    expect(response.status).toBe(201); expect(await response.text()).toBe('created');
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
});
