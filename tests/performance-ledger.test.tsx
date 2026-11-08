// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useLedger } from '../web/src/LedgerView';
import { api } from '../web/src/api';

const state = vi.hoisted(() => ({ data: {} as any }));
vi.mock('../web/src/store', () => ({ useStore: () => state }));
vi.mock('../web/src/api', () => ({ api: vi.fn(async () => ({ accounts: [], months: [], tx: [] })) }));

it('a graph/history hook ignores task-only refreshes and reloads after financial changes', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.data = { accounts: [], bankTx: [], entries: [], billingo: [], navInvoices: [], settings: {}, today: '2026-11-08', tasks: [] };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    useLedger('2026-11', '');
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(api).toHaveBeenCalledTimes(1);
    state.data = { ...state.data, tasks: [{ id: 'new-task' }], stockMoves: [{ id: 'new-move' }] };
    await act(async () => root.render(<Probe />));
    expect(api).toHaveBeenCalledTimes(1);
    state.data = { ...state.data, bankTx: [{ id: 'new-bank-row' }] };
    await act(async () => root.render(<Probe />));
    expect(api).toHaveBeenCalledTimes(2);
    state.data = { ...state.data, entries: [{ id: 'new-actual' }] };
    await act(async () => root.render(<Probe />));
    expect(api).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
