// @vitest-environment jsdom
// Összevonás → „Előjel-ellenőrzés” fül: a pozitív kiadás- és negatív bevétel-tények listája, „Rendben” jelöléssel; javítani nem javít.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsView } from '../../src/client/AlertsView';
import { StoreProvider } from '../../src/client/store';
import { api } from '../../src/client/api';

vi.mock('../../src/client/api', () => ({ api: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let ack: string[] = [];
const actual = (id: string, leaf: string, name: string, amount: number, date: string, source = 'import') => ({
  id,
  kind: 'actual',
  date,
  leaf_id: leaf,
  name,
  amount,
  series_id: null,
  done: 0,
  tentative: 0,
  source,
  ext_ref: null,
  link_id: null,
  note: null,
  updated_at: 100,
});
const initial = () =>
  ({
    today: '2026-11-07',
    me: { id: 1, role: 'admin' },
    groups: [
      { id: 'g_in', section: 'in', label: 'Projektek', sort: 0 },
      { id: 'g_out', section: 'out', label: '3 Működési költségek', sort: 30 },
    ],
    leaves: [
      { id: 'l_in', group_id: 'g_in', label: 'Minta Kft.', sort: 0, archived: 0 },
      { id: 'l_out', group_id: 'g_out', label: 'Szoftver', sort: 0, archived: 0 },
    ],
    entries: [
      actual('a1', 'l_out', 'Felhő szoftver', 176_000, '2026-08-03'),
      actual('a2', 'l_out', 'Bútorbolt visszatérítés', 12_990, '2026-09-05', 'bank'),
      actual('a3', 'l_out', 'Szerverbérlés', -49_000, '2026-09-10'),
      actual('a4', 'l_in', 'Havi díj', 250_000, '2026-09-12'),
      actual('a5', 'l_in', 'Túlfizetés visszautalva', -40_000, '2026-09-20'),
      // terv nem számít, csak tény
      { ...actual('p1', 'l_in', 'Jóváírás', -10_000, '2026-12-10'), kind: 'plan' },
    ],
    series: [],
    accounts: [],
    bankTx: [],
    billingo: [],
    navInvoices: [],
    partners: [],
    worktime: [],
    integrations: {},
    settings: { flags_ack: JSON.stringify(ack) },
  }) as any;

const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;
const rows = () => [...document.querySelectorAll('[data-sign-check]')].map((r) => r.getAttribute('data-sign-check'));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = vi.fn() as any;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  try {
    localStorage.clear();
  } catch {}
  ack = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, opts?: any) => {
    if (path === '/api/flags/ack') ack = opts.body.undo ? ack.filter((id) => !opts.body.ids.includes(id)) : [...ack, ...opts.body.ids];
    return path === '/api/data' ? initial() : { ok: true };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function openSignTab() {
  await act(async () =>
    root.render(
      <StoreProvider initial={initial()}>
        <AlertsView />
      </StoreProvider>,
    ),
  );
  const tab = button('Előjel-ellenőrzés');
  expect(tab.textContent).toContain('3');
  await click(tab);
}

describe('előjel-ellenőrzés fül', () => {
  it('listázza a pozitív kiadás- és a negatív bevétel-tényeket (a terveket és a helyes előjelűeket nem)', async () => {
    await openSignTab();
    expect(rows()).toEqual(['a2', 'a1', 'a5']);
    expect(document.body.textContent).toContain('Pozitív összegű kiadás (2)');
    expect(document.body.textContent).toContain('Negatív összegű bevétel (1)');
    expect(document.querySelector('[data-sign-check="a1"]')!.textContent).toContain('+176');
  });

  it('„Rendben”: csak a jelölést menti (nem módosít tételt), és a tétel eltűnik a listáról', async () => {
    await openSignTab();
    await click(button('Rendben', document.querySelector('[data-sign-check="a2"]')!));
    const calls = vi.mocked(api).mock.calls.map((c) => c[0]);
    expect(calls).toContain('/api/flags/ack');
    expect(calls).not.toContain('/api/entries/batch');
    expect(ack).toEqual(['sign:a2:12990']);
    expect(rows()).toEqual(['a1', 'a5']);
  });
});
