// @vitest-environment jsdom
// A sorozat-szerkesztő (EntryModal, szerkesztés mód) által küldött batch: nyitott hónapok új összeggel, a teljesült hónap összege és kötése marad.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryModal } from '../../src/client/EntryModal';
import { StoreProvider } from '../../src/client/store';
import { api } from '../../src/client/api';

vi.mock('../../src/client/api', () => ({ api: vi.fn() }));
vi.mock('../../src/client/LeafPicker', () => ({
  LeafPicker: ({ section, onChange }: { section: string; onChange: (id: string) => void }) => (
    <div>{section === 'in' ? <button onClick={() => onChange('l_in')}>Minta Kft.</button> : <button onClick={() => onChange('l_out')}>Szoftver</button>}</div>
  ),
}));

let root: Root;
let host: HTMLDivElement;
const plan = (id: string, date: string, extra: object = {}) => ({
  id,
  kind: 'plan',
  date,
  leaf_id: 'l_in',
  name: `Havi díj – ${date.slice(0, 7)}`,
  amount: 250_000,
  series_id: 's1',
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  updated_at: 100,
  ...extra,
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
      plan('p10', '2026-10-10', { done: 1, link_id: 'a10' }),
      { ...plan('a10', '2026-10-12'), kind: 'actual', series_id: null, link_id: 'p10' },
      plan('p11', '2026-11-10'),
      plan('p12', '2026-12-10'),
    ],
    series: [{ id: 's1', leaf_id: 'l_in', name: 'Havi díj', rep: 'monthly', day: 10 }],
    accounts: [],
    settings: {},
  }) as any;

const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.scrollTo = vi.fn() as any;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, opts?: any) =>
    path.split('?')[0] === '/api/data' ? initial() : { versions: Object.fromEntries((opts?.body?.upsert || []).map((e: any) => [e.id, 101])) },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function openEditor() {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <StoreProvider initial={initial()}>
        <EntryModal edit={{ key: 's1' }} onClose={onClose} />
      </StoreProvider>,
    ),
  );
  return onClose;
}

describe('sorozat-szerkesztő', () => {
  it('összeg módosítása: a nyitott hónapok új összeget kapnak, a teljesült hónap összege és kötése változatlan', async () => {
    const onClose = await openEditor();
    await type(document.querySelector('[aria-label="Összeg forintban"]')!, '270000');
    await click(button('Mentés'));
    expect(onClose).toHaveBeenCalled();
    const body = vi.mocked(api).mock.calls.find((c) => c[0] === '/api/entries/batch')![1]!.body as any;
    const by = Object.fromEntries(body.upsert.map((e: any) => [e.id, e]));
    expect(by.p11.amount).toBe(270_000);
    expect(by.p12.amount).toBe(270_000);
    expect(by.p10).toMatchObject({ amount: 250_000, done: 1, link_id: 'a10' });
    expect(by.a10).toBeUndefined();
    expect(body.expected).toMatchObject({ p10: 100, p11: 100, p12: 100 });
  });

  it('teljesült hónappal rendelkező bevételi sorozat nem tehető át kiadásba (a tény előjele nem illene)', async () => {
    const onClose = await openEditor();
    await click(button('Kiadás'));
    await click(button('Szoftver'));
    await click(button('Mentés'));
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.some((c) => c[0] === '/api/entries/batch')).toBe(false);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('teljesült');
  });

  it('a „Törlés” csak a nyitott hónapokat törli', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openEditor();
    await click(button('Törlés'));
    const body = vi.mocked(api).mock.calls.find((c) => c[0] === '/api/entries/batch')![1]!.body as any;
    expect(body.delete.sort()).toEqual(['p11', 'p12']);
  });
});

describe('éves ütemezés', () => {
  async function openNew() {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <StoreProvider initial={initial()}>
          <EntryModal leaf="l_out" onClose={onClose} />
        </StoreProvider>,
      ),
    );
    return onClose;
  }

  it('új tételnél választható az „Évente”: az időtartam években, 3 év → 3 tétel 12 havonta, éves sorozatként', async () => {
    const onClose = await openNew();
    await type(document.querySelector('[aria-label="Összeg forintban"]')!, '24990');
    await type(document.querySelector('input[placeholder^="Megnevezés"]')!, 'Domain megújítás');
    await click(button('Évente'));
    expect(button('1 év')).toBeTruthy();
    expect(button('3 év').getAttribute('aria-pressed')).toBe('true');
    expect(button('24 hó')).toBeUndefined();
    await click(button('Mentés'));
    expect(onClose).toHaveBeenCalled();
    const body = vi.mocked(api).mock.calls.find((c) => c[0] === '/api/entries/batch')![1]!.body as any;
    expect(body.series).toEqual([expect.objectContaining({ leaf_id: 'l_out', name: 'Domain megújítás', rep: 'yearly', day: 7 })]);
    expect(body.upsert.map((e: any) => e.date)).toEqual(['2026-11-07', '2027-11-07', '2028-11-07']);
    expect(body.upsert.every((e: any) => e.amount === -24_990 && e.series_id === body.series[0].id)).toBe(true);
  });

  it('„Évente” után visszaváltva havira a havi időtartamok jönnek vissza (nem marad 36 hónapos érték)', async () => {
    await openNew();
    await type(document.querySelector('[aria-label="Összeg forintban"]')!, '10000');
    await click(button('Évente'));
    await click(button('Havi'));
    expect(button('6 hó').getAttribute('aria-pressed')).toBe('true');
    await click(button('Mentés'));
    const body = vi.mocked(api).mock.calls.find((c) => c[0] === '/api/entries/batch')![1]!.body as any;
    expect(body.series[0].rep).toBe('monthly');
    expect(body.upsert).toHaveLength(6);
  });

  it('éves sorozat szerkesztésekor látszik az „Évente” ütemezés, és a mentés megtartja', async () => {
    const yearly = initial();
    yearly.series[0].rep = 'yearly';
    yearly.entries = [plan('p11', '2026-11-10'), plan('p27', '2027-11-10')];
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <StoreProvider initial={yearly}>
          <EntryModal edit={{ key: 's1' }} onClose={onClose} />
        </StoreProvider>,
      ),
    );
    expect(document.body.textContent).toContain('Évente');
    await type(document.querySelector('[aria-label="Összeg forintban"]')!, '260000');
    await click(button('Mentés'));
    const body = vi.mocked(api).mock.calls.find((c) => c[0] === '/api/entries/batch')![1]!.body as any;
    expect(body.series[0].rep).toBe('yearly');
    expect(body.upsert.map((e: any) => [e.date, e.amount])).toEqual([
      ['2026-11-10', 260_000],
      ['2027-11-10', 260_000],
    ]);
  });
});
