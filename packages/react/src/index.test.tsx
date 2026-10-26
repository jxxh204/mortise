// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { attachDomain, defineDomain, defineCapability, provide, schema } from '@mortise/core';
import { DomainProvider, Each, useCapability, useDomain, type CommandResult } from './index';

afterEach(cleanup);
const Quantity = defineCapability({ id: 'quantity', version: 1,
  state: { quantity: schema.integer() },
  commands: { setQuantity: { input: schema.integer(), output: schema.void() } },
});
const noServices = {};
function fixture(scoped = false) {
  let root: any = scoped ? { items: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 2 }] } : { quantity: 1 };
  const query = vi.fn(async () => structuredClone(root));
  const action = vi.fn(async (next: number, ctx: any) => {
    if (scoped) root.items.find((item: any) => item.id === ctx.scope.key).quantity = next;
    else root.quantity = next;
  });
  const domain = attachDomain(defineDomain({ provides: [provide(Quantity, scoped ? { scope: 'items' } : {})] }), {
    id: 'test', query: { run: query }, actions: { setQuantity: { run: action } },
  });
  return { domain, query, action, getRoot: () => root, setRoot: (next: any) => { root = next; } };
}
function Counter({ label = 'quantity', onResult }: { label?: string; onResult?: (result: CommandResult) => void }) {
  const { state, commands } = useCapability(Quantity);
  const [draft, setDraft] = useState('');
  return <div>
    <output data-testid={label}>{state.quantity}</output>
    <input aria-label={`draft-${state.quantity}`} value={draft} onChange={e => setDraft(e.target.value)} />
    <button disabled={commands.setQuantity.pending} onClick={async () => onResult?.(await commands.setQuantity.execute(state.quantity + 1))}>{label}</button>
    <span data-testid={`${label}-pending`}>{String(commands.setQuantity.pending)}</span>
    {commands.setQuantity.error && <span role="alert">{commands.setQuantity.error.message}</span>}
  </div>;
}

describe('Mortise React runtime', () => {
  it('refreshes before clearing pending and preserves local UI state', async () => {
    const f = fixture();
    let release!: () => void;
    const result = vi.fn();
    render(<DomainProvider domain={f.domain}><Counter onResult={result} /></DomainProvider>);
    await screen.findByTestId('quantity');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep me' } });
    f.query.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ quantity: 2 }); }));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(f.action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(screen.getByTestId('quantity-pending').textContent).toBe('true');
    expect(result).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('quantity').textContent).toBe('2'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('keep me');
    await waitFor(() => expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' })));
  });

  it('isolates two mounted instances even with the same domain', async () => {
    const f = fixture();
    render(<><DomainProvider domain={f.domain}><Counter label="left" onResult={() => {}} /></DomainProvider><DomainProvider domain={f.domain}><Counter label="right" /></DomainProvider></>);
    await screen.findByTestId('left'); await screen.findByTestId('right');
    fireEvent.click(screen.getByRole('button', { name: 'left' }));
    await waitFor(() => expect(screen.getByTestId('left').textContent).toBe('2'));
    expect(screen.getByTestId('right').textContent).toBe('1');
  });

  it('keeps item scope identity through reordering', async () => {
    const f = fixture(true);
    const result = vi.fn();
    f.action.mockImplementation(async (_next, ctx) => { f.setRoot({ items: [{ id: 'b', quantity: 2 }, { id: 'a', quantity: 3 }] }); expect(ctx.scope.key).toBe('a'); });
    render(<DomainProvider domain={f.domain}><Each scope="items"><Counter onResult={result} /></Each></DomainProvider>);
    await screen.findAllByTestId('quantity');
    fireEvent.change(screen.getByLabelText('draft-1'), { target: { value: 'belongs to a' } });
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(screen.getAllByTestId('quantity').map(node => node.textContent)).toEqual(['2', '3']));
    expect((screen.getByLabelText('draft-3') as HTMLInputElement).value).toBe('belongs to a');
  });

  it('reports a saved write separately from failed refresh', async () => {
    const f = fixture();
    const result = vi.fn();
    render(<DomainProvider domain={f.domain}><Counter onResult={result} /></DomainProvider>);
    await screen.findByTestId('quantity');
    f.query.mockRejectedValueOnce(new Error('refresh offline'));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 'refresh-error', committed: true })));
    expect(f.getRoot().quantity).toBe(2);
    expect(screen.getByTestId('quantity').textContent).toBe('1');
    expect(screen.getByRole('alert').textContent).toBe('refresh offline');
  });

  it('validates command input and serializes changes using fresh scope state', async () => {
    const f = fixture();
    let command: ReturnType<typeof useCapability<typeof Quantity>>['commands']['setQuantity'];
    function Access() { command = useCapability(Quantity).commands.setQuantity; return null; }
    render(<DomainProvider domain={f.domain} services={noServices}><Access /></DomainProvider>);
    await waitFor(() => expect(command).toBeDefined());
    let invalid!: CommandResult;
    await act(async () => { invalid = await command.execute(1.5); });
    expect(invalid.status).toBe('validation-error'); expect(f.action).not.toHaveBeenCalled();
    const roots: number[] = [];
    f.action.mockImplementation(async (next, ctx) => { roots.push(ctx.root.quantity); await new Promise(resolve => setTimeout(resolve, 5)); f.setRoot({ quantity: next }); });
    await act(async () => { await Promise.all([command.execute(2), command.execute(3)]); });
    expect(roots).toEqual([1, 2]);
  });

  it('discards an older query response after a successful mutation refresh', async () => {
    const f = fixture();
    const client = new QueryClient();
    const result = vi.fn();
    render(<DomainProvider domain={f.domain} queryClient={client}><Counter onResult={result} /></DomainProvider>);
    await screen.findByTestId('quantity');
    const key = client.getQueryCache().getAll()[0]!.queryKey;
    let resolveOld!: (value: unknown) => void;
    const staleRequest = client.fetchQuery({ queryKey: key, queryFn: () => new Promise(resolve => { resolveOld = resolve; }), staleTime: 0 }).catch(() => undefined);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' })));
    await act(async () => { resolveOld({ quantity: 0 }); await staleRequest; });
    expect(screen.getByTestId('quantity').textContent).toBe('2');
  });

  it('supports renamed fields and commands in another domain', async () => {
    let guests = 4;
    const domain = attachDomain(defineDomain({ provides: [provide(Quantity, { state: { quantity: 'guests' }, commands: { setQuantity: 'changeGuests' } })] }), {
      id: 'booking', query: { run: () => ({ guests }) }, actions: { changeGuests: { run: (next: number) => { guests = next; } } },
    });
    function Total() { const count = useDomain(root => root.guests); return <span data-testid="total">{count}</span>; }
    render(<DomainProvider domain={domain}><Counter onResult={() => {}} /><Total /></DomainProvider>);
    await screen.findByTestId('quantity');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('5'));
  });
});

describe('remote outcome propagation',()=>{
 it('preserves an unknown command outcome without retrying the action',async()=>{
  const {RemoteError}=await import('@mortise/core');const f=fixture();const result=vi.fn();
  f.action.mockRejectedValue(new RemoteError('Connection lost','NETWORK_ERROR','unknown'));
  render(<DomainProvider domain={f.domain}><Counter onResult={result}/></DomainProvider>);
  await screen.findByTestId('quantity');fireEvent.click(screen.getByRole('button'));
  await waitFor(()=>expect(result).toHaveBeenCalledWith(expect.objectContaining({status:'action-error',committed:'unknown'})));
  expect(f.action).toHaveBeenCalledTimes(1);expect(screen.getByTestId('quantity').textContent).toBe('1');
 });
 it('preserves confirmed server write when its output validation fails',async()=>{
  const {RemoteError}=await import('@mortise/core');const f=fixture();const result=vi.fn();
  f.action.mockRejectedValue(new RemoteError('Invalid output','INVALID_RESULT',true));
  render(<DomainProvider domain={f.domain}><Counter onResult={result}/></DomainProvider>);
  await screen.findByTestId('quantity');fireEvent.click(screen.getByRole('button'));
  await waitFor(()=>expect(result).toHaveBeenCalledWith(expect.objectContaining({status:'result-error',committed:true})));
  expect(f.action).toHaveBeenCalledTimes(1);
 });
  it('uses a server seed without issuing the initial browser query', async () => {
    const f = fixture();
    render(<DomainProvider domain={f.domain} initialState={{ quantity: 7 }} revision={1}><Counter /></DomainProvider>);
    expect(screen.getByTestId('quantity').textContent).toBe('7');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('publishes only newer external revisions while preserving local UI state', async () => {
    const f = fixture();
    const view = render(<DomainProvider domain={f.domain} initialState={{ quantity: 2 }} revision={2}><Counter /></DomainProvider>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'preserve draft' } });
    view.rerender(<DomainProvider domain={f.domain} initialState={{ quantity: 3 }} revision={3}><Counter /></DomainProvider>);
    await waitFor(() => expect(screen.getByTestId('quantity').textContent).toBe('3'));
    view.rerender(<DomainProvider domain={f.domain} initialState={{ quantity: 1 }} revision={1}><Counter /></DomainProvider>);
    expect(screen.getByTestId('quantity').textContent).toBe('3');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('preserve draft');
    expect(f.query).not.toHaveBeenCalled();
  });

  it('awaits the RSC bridge snapshot instead of a separate query refresh', async () => {
    const f = fixture();
    const result = vi.fn();
    let finish!: (snapshot: { state: unknown; revision: number }) => void;
    const refresh = vi.fn(() => new Promise<{ state: unknown; revision: number }>(resolve => { finish = resolve; }));
    render(<DomainProvider domain={f.domain} initialState={{ quantity: 1 }} revision={1} onRefresh={refresh}><Counter onResult={result} /></DomainProvider>);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByTestId('quantity-pending').textContent).toBe('true');
    expect(result).not.toHaveBeenCalled();
    await act(async () => { finish({ state: { quantity: 2 }, revision: 2 }); });
    await waitFor(() => expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' })));
    expect(screen.getByTestId('quantity').textContent).toBe('2');
    expect(screen.getByTestId('quantity-pending').textContent).toBe('false');
    expect(f.query).not.toHaveBeenCalled();
  });

  it('reports committed refresh failure without discarding the server seed', async () => {
    const f = fixture();
    const result = vi.fn();
    render(<DomainProvider domain={f.domain} initialState={{ quantity: 1 }} revision={1} onRefresh={async () => { throw new Error('RSC offline'); }}><Counter onResult={result} /></DomainProvider>);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 'refresh-error', committed: true })));
    expect(screen.getByTestId('quantity').textContent).toBe('1');
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects a non-advancing refresh revision and uses the latest callback', async () => {
    const f = fixture();
    const result = vi.fn();
    const first = vi.fn(async () => ({ state: { quantity: 2 }, revision: 2 }));
    const latest = vi.fn(async () => ({ state: { quantity: 9 }, revision: 1 }));
    const view = render(<DomainProvider domain={f.domain} initialState={{ quantity: 1 }} revision={1} onRefresh={first}><Counter onResult={result} /></DomainProvider>);
    view.rerender(<DomainProvider domain={f.domain} initialState={{ quantity: 1 }} revision={1} onRefresh={latest}><Counter onResult={result} /></DomainProvider>);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(result).toHaveBeenCalledWith(expect.objectContaining({ status: 'refresh-error', committed: true })));
    expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce();
    expect(screen.getByTestId('quantity').textContent).toBe('1');
  });

  it('hydrates the exact server snapshot without recovery or an initial query', async () => {
    const f = fixture();
    const makeTree = () => <DomainProvider domain={f.domain} initialState={{ quantity: 8 }} revision={4}><Counter /></DomainProvider>;
    const container = document.createElement('div');
    container.innerHTML = renderToString(makeTree());
    document.body.append(container);
    const recover = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => { root = hydrateRoot(container, makeTree(), { onRecoverableError: recover }); });
      expect(container.querySelector('output')?.textContent).toBe('8');
      expect(recover).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root.unmount());
      container.remove();
    }
  });

});
