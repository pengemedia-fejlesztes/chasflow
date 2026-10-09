import { describe, expect, it } from 'vitest';
import { avgDelay, billingoDocFor, monthRows } from '../shared/monthrows';
import type { BillingoDoc, Entry } from '../shared/types';

const E = (p: Partial<Entry>): Entry => ({
  id: 'x',
  kind: 'plan',
  date: '2026-10-10',
  leaf_id: 'l',
  name: '',
  amount: 0,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  ...p,
});
const L = new Set(['l']);

describe('havi lista: terv + tény összevonás', () => {
  const plan = E({ id: 'p', date: '2026-10-10', amount: 100000, done: 1, link_id: 'a', name: 'Havi díj', ext_ref: 'billingo:7' });
  const act = E({ id: 'a', kind: 'actual', date: '2026-10-14', amount: 95000, link_id: 'p', name: 'Ügyfél Kft', note: 'Penge / 2026-000056' });
  const open = E({ id: 'o', date: '2026-10-05', amount: 50000, name: 'Lejárt' });
  const offer = E({ id: 'f', date: '2026-10-20', amount: 70000, tentative: 1 });
  it('teljesült terv + tény = egy sor, eltéréssel és napokkal', () => {
    const r = monthRows([plan, act, open, offer], '2026-10', L, '2026-10-15');
    expect(r.map((x) => x.kind)).toEqual(['plan', 'merged', 'offer']);
    const m = r[1];
    expect(m).toMatchObject({ amount: 95000, diff: -5000, dev: true, days: 4, completed: true, name: 'Havi díj' });
    expect(r[0].late).toBe(true);
  });
  it('a más hónapban kifizetett terv a tény hónapjában jelenik meg', () => {
    const late = { ...act, date: '2026-11-02' };
    expect(monthRows([plan, late], '2026-10', L, '2026-11-05')).toHaveLength(0);
    expect(monthRows([plan, late], '2026-11', L, '2026-11-05')[0]).toMatchObject({ kind: 'merged', days: 23 });
  });
  it('átlagos fizetési késés és Billingo számla keresése', () => {
    expect(avgDelay([plan, act], 'l')).toEqual({ avg: 4, n: 1 });
    const docs = [
      { id: 7, number: 'Penge / 2026-000050' },
      { id: 9, number: 'Penge / 2026-000056' },
    ] as BillingoDoc[];
    expect(billingoDocFor(docs, [], plan, act)?.id).toBe(7);
    expect(billingoDocFor(docs, [], undefined, act)?.id).toBe(9);
    const imp = E({ id: 'i', kind: 'actual', date: '2026-10-06', amount: 147649, source: 'import', name: 'Marketing tanácsadás' });
    const bd = [
      { id: 1, number: 'Penge / 2026-000060', partner: 'MR. BIG TEAM KFT.', gross: 147649, paid_date: '2026-10-06', invoice_date: '2026-10-01', cancelled: 0 },
      { id: 2, number: 'Penge / 2026-000061', partner: 'Más Kft.', gross: 147649, paid_date: '2026-10-06', invoice_date: '2026-10-01', cancelled: 0 },
    ] as BillingoDoc[];
    expect(billingoDocFor(bd, [], undefined, imp, 'Mr. Big')?.id).toBe(1);
    expect(billingoDocFor(bd, [], undefined, imp, 'Pharmazone')).toBeNull();
  });
});
