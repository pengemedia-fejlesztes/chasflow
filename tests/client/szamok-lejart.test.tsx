// @vitest-environment jsdom
// Bevételek / kiadások nézet „Lejárt” doboza: ugyanaz a lejárt-definíció (6 hónapos ablak, Billingo-számla régebbről is),
// mint a záró egyenlegé és a riasztásé.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IncomeView } from '../../src/client/IncomeView';
import { StoreProvider } from '../../src/client/store';
import { api } from '../../src/client/api';
import { isOverdue } from '../../src/shared/model';

vi.mock('../../src/client/api', () => ({ api: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
const plan = (id: string, date: string, amount: number, extra: object = {}) => ({
  id,
  kind: 'plan',
  date,
  leaf_id: 'l_in',
  name: 'Projekt díj',
  amount,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  updated_at: 100,
  ...extra,
});
const entries = [
  plan('p_maj', '2026-05-02', 120_000),
  plan('p_apr', '2026-04-28', 70_000), // az ablak előtt
  plan('p_bil', '2026-04-15', 300_000, { source: 'billingo' }),
  plan('p_okt', '2026-10-15', 80_000),
  plan('p_aj', '2026-10-20', 500_000, { tentative: 1 }),
  plan('p_nov', '2026-11-20', 900_000),
];
const initial = () =>
  ({
    today: '2026-11-07',
    me: { id: 1, role: 'admin' },
    groups: [{ id: 'g_in', section: 'in', label: 'Projektek', sort: 0 }],
    leaves: [{ id: 'l_in', group_id: 'g_in', label: 'Minta Kft.', sort: 0, archived: 0 }],
    entries,
    series: [],
    accounts: [],
    bankTx: [],
    billingo: [],
    settings: {},
    integrations: { billingo: false, enableBanking: false },
  }) as any;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = vi.fn() as any;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => (path === '/api/data' ? initial() : {}));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Bevételek nézet: „Lejárt” doboz', () => {
  it('a lejárt tételek összege és darabszáma = a közös lejárt-definíció', async () => {
    await act(async () =>
      root.render(
        <StoreProvider initial={initial()}>
          <IncomeView />
        </StoreProvider>,
      ),
    );
    const late = entries.filter((e) => isOverdue(e as any, '2026-11-07'));
    expect(late.map((e) => e.id)).toEqual(['p_maj', 'p_bil', 'p_okt']);
    const chip = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Lejárt'))!;
    const sp = (s: string) => s.replace(/\s/g, ' ');
    expect(sp(chip.textContent!)).toContain(sp(`${(120_000 + 300_000 + 80_000).toLocaleString('hu-HU')} Ft · 3`));
  });
});

describe('Kiadások nézet: lezárt hónap keret-terve', () => {
  it('a fel nem használt októberi keret nem jelenik meg (kész), a belőle fogyó nyitott számla lejártként igen', async () => {
    const keret = { id: 'l_keret', group_id: 'g_out', label: 'Előre nem látható költség', sort: 0, archived: 0 };
    const data = {
      ...initial(),
      groups: [...initial().groups, { id: 'g_out', section: 'out', label: 'Működési költségek', sort: 1 }],
      leaves: [...initial().leaves, keret],
      entries: [
        plan('k_okt', '2026-10-30', -50_000, { leaf_id: 'l_keret', name: 'Előre nem látható költség – 2026. október' }),
        plan('k_szamla', '2026-10-15', -4_051, { leaf_id: 'l_keret', name: 'Szoftver Kft.' }),
      ],
    };
    vi.mocked(api).mockImplementation(async (path: string) => (path === '/api/data' ? data : {}));
    await act(async () =>
      root.render(
        <StoreProvider initial={data}>
          <IncomeView />
        </StoreProvider>,
      ),
    );
    const out = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Kiadások')!;
    await act(async () => void out.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const sp = (s: string) => s.replace(/\s/g, ' ');
    const chip = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Lejárt'))!;
    expect(sp(chip.textContent!)).toContain(sp(`${(4_051).toLocaleString('hu-HU')} Ft · 1`));
    expect(document.body.textContent).toContain('Szoftver Kft.');
    expect(document.body.textContent).not.toContain('Előre nem látható költség – 2026. október');
  });
});
