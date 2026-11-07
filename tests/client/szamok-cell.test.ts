// Áttekintő táblázat: a terv cellába beírt összeg pontosan az legyen, amit utána a cella mutat.
import { describe, expect, it } from 'vitest';
import { setCellValue, applyLocal } from '../../src/client/logic';
import { buildIndex, buildMatrix, defaultFilters } from '../../src/shared/model';
import type { DataBundle, Entry } from '../../src/shared/types';

const E = (p: Partial<Entry>): Entry =>
  ({ id: 'x', kind: 'plan', date: '2026-12-08', leaf_id: 'ugyfel', name: '', amount: 0, series_id: null, done: 0, tentative: 0, source: 'manual', ext_ref: null, link_id: null, note: null, ...p }) as Entry;

const bundle = (entries: Entry[]): DataBundle =>
  ({
    me: { id: 1, email: 'a@teszt.hu', name: 'a', role: 'admin', totp_enabled: 0, must_change_pw: 0 },
    today: '2026-11-07',
    groups: [{ id: 'gin', section: 'in', label: 'Ügyfelek', sort: 0 }],
    leaves: [{ id: 'ugyfel', group_id: 'gin', label: 'Minta Kft.', sort: 0, archived: 0 }],
    series: [],
    entries,
    accounts: [],
    bankTx: [],
    billingo: [],
    settings: {},
    integrations: { billingo: false, enableBanking: false },
  }) as DataBundle;

const cell = (d: DataBundle, key: string) => {
  const ix = buildIndex(d);
  const m = buildMatrix(ix, { ...defaultFilters(d.today), to: '2027-01', estimate: false });
  const i = m.columns.findIndex((c) => c.key === key);
  return m.rows.find((r) => r.type === 'leaf' && r.id === 'ugyfel')?.cells[i].v ?? 0;
};

describe('terv cella szerkesztése', () => {
  it('jövőbeli hónap, előre kifizetett (kész) tervvel: a beírt összeg = a cella új értéke', () => {
    const d = bundle([
      E({ id: 'a1', kind: 'actual', date: '2026-11-06', amount: 400_000 }),
      E({ id: 'p_kesz', amount: 400_000, done: 1, link_id: 'a1', name: 'Havi díj – 2026. december' }),
      E({ id: 'p_nyitott', amount: 250_000, name: 'Kampány – 2026. december' }),
    ]);
    expect(cell(d, '2026-12p')).toBe(250_000);
    const b = setCellValue(d, 'ugyfel', 'in', '2026-12', 300_000)!;
    // a kész (kifizetett) terv érintetlen marad
    expect(b.upsert!.map((e) => e.id)).toEqual(['p_nyitott']);
    expect(cell(applyLocal(d, b), '2026-12p')).toBe(300_000);
  });
  it('folyó hónap: a cella a hónap teljes terve (a kész is), a beírt összeg ahhoz igazodik', () => {
    const d = bundle([
      E({ id: 'p1', date: '2026-11-05', amount: 400_000, done: 1 }),
      E({ id: 'p2', date: '2026-11-20', amount: 100_000 }),
    ]);
    expect(cell(d, '2026-11p')).toBe(500_000);
    const b = setCellValue(d, 'ugyfel', 'in', '2026-11', 600_000)!;
    expect(cell(applyLocal(d, b), '2026-11p')).toBe(600_000);
  });
});
