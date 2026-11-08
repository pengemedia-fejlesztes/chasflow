// @vitest-environment jsdom
// Banki tétel kártyája (TxCard): a lehetséges dupla import (azonos nap, partner, ±1%) a felületen látszik.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TxCard } from '../../src/client/TxCard';
import { StoreProvider } from '../../src/client/store';

vi.mock('../../src/client/api', () => ({ api: vi.fn(async () => ({})) }));

let root: Root;
let host: HTMLDivElement;
const tx = { id: 't1', account_id: 'acc1', date: '2026-08-25', amount: -18225, currency: 'HUF', partner: 'MINTA TÁRHELY KFT.', memo: 'havidíj', status: 'new', leaf_id: 'l_dom', plan_id: null, actual_id: null };
const initial = (entries: any[]) =>
  ({
    today: '2026-11-07',
    me: { id: 1, role: 'admin' },
    groups: [{ id: 'g_out', section: 'out', label: 'Működési költségek', sort: 0 }],
    leaves: [
      { id: 'l_dom', group_id: 'g_out', label: 'Domain-Tárhely', sort: 0, archived: 0 },
      { id: 'l_unf', group_id: 'g_out', label: 'Előre nem látható költség', sort: 1, archived: 0 },
    ],
    entries,
    series: [],
    accounts: [{ id: 'acc1', provider: 'manual', bank_name: 'Minta Bank', label: 'Folyószámla' }],
    bankTx: [tx],
    billingo: [],
    settings: {},
    integrations: { billingo: false, enableBanking: false },
  }) as any;
const actual = (id: string, amount: number, name: string, leaf = 'l_dom') => ({
  id,
  kind: 'actual',
  date: '2026-08-25',
  leaf_id: leaf,
  name,
  amount,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'import',
  ext_ref: null,
  link_id: null,
  note: null,
});

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(entries: any[], open = false) {
  await act(async () =>
    root.render(
      <StoreProvider initial={initial(entries)}>
        <TxCard t={tx as any} frequent={[]} unforeseen="l_unf" open={open} onToggle={() => {}} />
      </StoreProvider>,
    ),
  );
}

describe('lehetséges dupla import a banki tétel kártyáján', () => {
  it('a 30 Ft-tal eltérő, azonos napi importált tény mellett a sorban és a lenyitott kártyán is jelzi', async () => {
    await render([actual('i1', -18255, 'Minta Tárhely')], true);
    expect(host.textContent).toContain('lehetséges dupla');
    expect(host.textContent).toMatch(/Lehetséges dupla: ugyanezen a napon már van 18\s255 Ft-os tény \(Minta Tárhely\)/);
  });

  it('más partner hasonló összegű ténye mellett nincs jelzés', async () => {
    await render([actual('i2', -18240, 'Példa Szoftver Kft.', 'l_unf')], true);
    expect(host.textContent).not.toMatch(/lehetséges dupl/i);
  });
});
