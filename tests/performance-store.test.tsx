// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider, useStore } from '../web/src/store';
import { api } from '../web/src/api';
import { FULL_ACCESS, NO_ACCESS } from '../shared/access';
import type { DataBundle } from '../shared/types';

const initial = (): DataBundle => ({
  today: '2026-11-08',
  me: { id: 1, email: 'test@example.test', name: 'Test', role: 'member', totp_enabled: 1, must_change_pw: 0 },
  groups: [{ id: 'g', section: 'in', label: 'Test', sort: 0 }],
  leaves: [{ id: 'l', group_id: 'g', label: 'Test', sort: 0, archived: 0 }],
  entries: [
    {
      id: 'e',
      kind: 'actual',
      date: '2026-11-01',
      leaf_id: 'l',
      name: 'Saved',
      amount: 100,
      done: 0,
      tentative: 0,
      series_id: null,
      link_id: null,
      source: 'manual',
      ext_ref: null,
      note: null,
      updated_at: 1,
    },
  ],
  series: [],
  accounts: [],
  bankTx: [],
  billingo: [],
  settings: {},
  integrations: { billingo: false, enableBanking: false },
  tasks: [],
  stockMoves: [],
  myAccess: FULL_ACCESS,
});
let root: Root, host: HTMLDivElement, store: ReturnType<typeof useStore>;
function Probe() {
  store = useStore();
  return <span>{store.data.entries[0]?.amount}</span>;
}
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <StoreProvider initial={initial()}>
        <Probe />
      </StoreProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('targeted refresh and asynchronous write races', () => {
  it('refreshes tasks without replacing financial rows or rebuilding the financial index', async () => {
    const entries = store!.data.entries,
      ix = store!.ix;
    const fetcher = vi.fn(async (path: any) =>
      reply(
        String(path).includes('?sections=tasks')
          ? { me: initial().me, today: initial().today, myAccess: FULL_ACCESS, sections: ['tasks'], tasks: [{ id: 't' }] }
          : { ok: true },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      expect(await store!.run(() => api('/api/tasks', { body: { title: 'Test' } }))).toBe(true);
    });
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/tasks', '/api/data?sections=tasks']);
    expect(store!.data.tasks).toEqual([{ id: 't' }]);
    expect(store!.data.entries).toBe(entries);
    expect(store!.ix).toBe(ix);
  });
  it('refreshes the successful steps of a partially failed multi-request operation', async () => {
    const fetcher = vi.fn(async (path: any) =>
      reply(
        String(path).includes('?sections=stock')
          ? { me: initial().me, today: initial().today, myAccess: FULL_ACCESS, sections: ['stock'], stockMoves: [{ id: 'move' }] }
          : { ok: true },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      expect(
        await store!.run(async () => {
          await api('/api/stock-moves', { body: {} });
          throw new Error('Second step failed');
        }),
      ).toBe(false);
    });
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/stock-moves', '/api/data?sections=stock']);
    expect(store!.data.stockMoves).toEqual([{ id: 'move' }]);
    expect(store!.toast?.error).toBe(true);
  });
  it('fully clears cached modules if a scoped read reports changed permissions', async () => {
    const denied = { ...initial(), myAccess: NO_ACCESS, entries: [], groups: [], leaves: [], tasks: [] };
    const fetcher = vi.fn(async (path: any) =>
      reply(
        path === '/api/data'
          ? denied
          : String(path).includes('?sections=tasks')
            ? { me: initial().me, today: initial().today, myAccess: NO_ACCESS, sections: ['tasks'], tasks: [] }
            : {},
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      await store!.run(() => api('/api/tasks', { body: {} }));
    });
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/tasks', '/api/data?sections=tasks', '/api/data']);
    expect(store!.data.entries).toEqual([]);
    expect(store!.data.myAccess).toEqual(NO_ACCESS);
  });
  it('discards a slow read that started before a successful financial edit and retries', async () => {
    let release!: (r: Response) => void;
    let reads = 0;
    const updated = { ...initial(), entries: [{ ...initial().entries[0], amount: 200, updated_at: 2 }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: any) => {
        if (path === '/api/entries/batch') return reply({ versions: { e: 2 } });
        if (++reads === 1)
          return new Promise<Response>((r) => {
            release = r;
          });
        return reply(updated);
      }),
    );
    let loading!: Promise<void>;
    await act(async () => {
      loading = store!.reload();
    });
    await act(async () => {
      await store!.commit({ upsert: updated.entries }, 'Saved');
    });
    expect(store!.data.entries[0].amount).toBe(200);
    await act(async () => {
      release(reply(initial()));
      await loading;
    });
    expect(reads).toBe(2);
    expect(store!.data.entries[0].amount).toBe(200);
  });
  it('retains both modules when independent mutations overlap', async () => {
    let finishTask!: () => void;
    const taskPending = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: any) => {
        if (!String(path).startsWith('/api/data')) return reply({ ok: true });
        const sections = new URL(String(path), 'https://test.invalid').searchParams.get('sections')!.split(',');
        return reply({
          me: initial().me,
          today: initial().today,
          myAccess: FULL_ACCESS,
          sections,
          ...(sections.includes('tasks') ? { tasks: [{ id: 'task' }] } : {}),
          ...(sections.includes('stock') ? { stockMoves: [{ id: 'move' }] } : {}),
        });
      }),
    );
    let first!: Promise<boolean>;
    await act(async () => {
      first = store!.run(async () => {
        await api('/api/tasks', { body: {} });
        await taskPending;
      });
    });
    await act(async () => {
      await store!.run(() => api('/api/stock-moves', { body: {} }));
    });
    await act(async () => {
      finishTask();
      await first;
    });
    expect(store!.data.tasks).toEqual([{ id: 'task' }]);
    expect(store!.data.stockMoves).toEqual([{ id: 'move' }]);
    expect(store!.data.entries).toEqual(initial().entries);
  });
});
