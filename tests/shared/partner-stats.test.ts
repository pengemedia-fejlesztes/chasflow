// Partnerstatisztika: melyik Billingo-számla melyik partnerhez tartozik (fizetési fegyelem, kintlévőség), és mi számít a
// partner bevételének / kiadásának.
import { describe, expect, it } from 'vitest';
import { partnerStats } from '../../src/shared/partners';
import type { BillingoDoc, Entry, Group, Leaf, Partner } from '../../src/shared/types';

const groups: Group[] = [
  { id: 'gp', section: 'in', label: 'Projektek', sort: 1 },
  { id: 'gk', section: 'out', label: '3 Működési költségek', sort: 2 },
  { id: 'ge', section: 'out', label: '4 Egyéb kiadás', sort: 3 },
];
const leaves: Leaf[] = [
  { id: 'ado', group_id: 'ge', label: 'Adó', sort: 1, archived: 0 },
  { id: 'mol', group_id: 'gp', label: 'MOL', sort: 1, archived: 0 },
  { id: 'bwt', group_id: 'gp', label: 'BWT', sort: 2, archived: 0 },
  { id: 'minta', group_id: 'gp', label: 'Minta Bútor', sort: 3, archived: 0 },
  { id: 'tanacs', group_id: 'gp', label: 'Tanácsadó Plusz', sort: 4, archived: 0 },
];
const act = (leaf_id: string, amount: number, date = '2026-09-10'): Entry => ({
  id: leaf_id + date + amount,
  kind: 'actual',
  date,
  leaf_id,
  name: 'Havi díj',
  amount,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'bank',
  ext_ref: null,
  link_id: null,
  note: null,
});
let id = 100;
const doc = (partner: string, gross: number, extra: Partial<BillingoDoc> = {}): BillingoDoc => ({
  id: ++id,
  number: 'PM-2026-' + id,
  partner,
  gross,
  currency: 'HUF',
  invoice_date: '2026-09-01',
  due_date: '2026-09-09',
  payment_status: 'outstanding',
  paid_date: null,
  cancelled: 0,
  plan_id: null,
  ...extra,
});
const entries = [act('ado', -250_000), act('mol', 420_000), act('bwt', 448_000), act('minta', 635_000), act('tanacs', 190_500)];
const info: Partner[] = [
  { key: 'mintabutor', name: 'Minta Bútor', kind: 'vevo', aliases: ['Minta Bútorgyártó Kft.'], tax_number: null, note: null, updated_at: 0 },
];
const run = (docs: BillingoDoc[], partners = info) => partnerStats(entries, leaves, groups, docs, '2026-10-20', [], partners, true);
const docsOf = (st: ReturnType<typeof run>, key: string) => st.find((p) => p.key === key)?.invoices.map((i) => i.doc.partner) || [];

describe('Billingo-számla → partner', () => {
  it('szórészlet nem elég: a „Tanácsadó” nem az „Adó”, a „Molnár” nem a „MOL” számlája', () => {
    const st = run([doc('Tanácsadó Plusz Kft.', 190_500), doc('Molnár és Társa Bt.', 127_000), doc('Kaffa Kávézó Kft.', 63_500)]);
    expect(docsOf(st, 'ado')).toEqual([]);
    expect(docsOf(st, 'mol')).toEqual([]);
    expect(docsOf(st, 'tanacsadoplusz')).toEqual(['Tanácsadó Plusz Kft.']);
    // a tévesen hozzárendelt számla lejárt kintlévőségként az „Adó” sort terhelné
    expect(st.find((p) => p.key === 'ado')!.outstanding).toBe(0);
  });

  it('egész szavas egyezés és alternatív név: „BWT Hungária Kft.” → BWT, „Minta Bútorgyártó Kft.” → Minta Bútor', () => {
    const st = run([doc('BWT Hungária Víztechnikai Kft.', 448_000), doc('Minta Bútorgyártó Kft.', 635_000), doc('MOL Nyrt.', 420_000)]);
    expect(docsOf(st, 'bwt')).toEqual(['BWT Hungária Víztechnikai Kft.']);
    expect(docsOf(st, 'mintabutor')).toEqual(['Minta Bútorgyártó Kft.']);
    expect(docsOf(st, 'mol')).toEqual(['MOL Nyrt.']);
  });

  it('alkategória nélküli (árva) törzsrekord alternatív neve nem viszi el a számlát a valódi partnertől', () => {
    const orphan: Partner = { key: 'minta butorgyarto', name: 'MINTA BÚTORGYÁRTÓ KFT.', kind: null, aliases: ['Minta Bútorgyártó Kft'], tax_number: null, note: null, updated_at: 0 };
    const st = run([doc('Minta Bútorgyártó Kft.', 635_000)], [orphan, ...info]);
    expect(docsOf(st, 'mintabutor')).toEqual(['Minta Bútorgyártó Kft.']);
  });

  it('megszüntetett (archivált) régi név: a számla az utódpartnerhez megy, akinek ez alternatív neve', () => {
    const ls: Leaf[] = [...leaves, { id: 'regi', group_id: 'gp', label: 'Példa Lakberendező', sort: 9, archived: 1 }];
    const ps: Partner[] = [{ ...info[0], aliases: ['Minta Bútorgyártó Kft.', 'Példa Lakberendező Kft.'] }];
    const st = partnerStats(entries, ls, groups, [doc('Példa Lakberendező Kft.', 473_000)], '2026-10-20', [], ps, true);
    expect(docsOf(st, 'mintabutor')).toEqual(['Példa Lakberendező Kft.']);
  });
});
