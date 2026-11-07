// Párosítási szabályok (Beállítások › Párosítások) és a várakozó tételek újrapárosítása.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { L, addEntry, day, importRows, seedTree, txBy } from '../helpers/bank-fixtures';

let t: TestApp | undefined;
afterEach(() => t?.close());

describe('párosítási szabályok', () => {
  it('a „Havi összevonás” kapcsoló menti az állapotot – „tartalmazza” és tanult partner-szabálynál is', async () => {
    t = await createTestApp();
    seedTree(t);
    const c = await t.post('/api/rules', { pattern: 'Minta Bankkártya díj', leaf_id: L.bank, auto: true, merge: false });
    expect(c.status).toBe(200);
    await t.patch(`/api/rules/${c.data.id}`, { merge: true });
    expect((t.sql.prepare('SELECT merge FROM match_rules WHERE id = ?').get(c.data.id) as any).merge).toBe(1);

    t.sql.prepare("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('minta tarhely', ?, 1, 0)").run(L.dom);
    await t.patch('/api/partner-rules', { pattern: 'minta tarhely', merge: true });
    expect((t.sql.prepare("SELECT merge FROM partner_rules WHERE pattern = 'minta tarhely'").get() as any).merge).toBe(1);
  });

  it('új szabály a várakozó tételek kategóriáját is átírja; automatikusnál azonnal tény lesz', async () => {
    t = await createTestApp();
    seedTree(t);
    await importRows(t, [{ date: day(-3), amount: -4990, partner: 'Minta Tárhely Kft.', memo: 'havidíj' }]);
    const tx = txBy(t, 'amount = -4990');
    expect(tx.status).toBe('new');
    await t.post('/api/rules', { pattern: 'minta tarhely', leaf_id: L.dom, auto: true });
    const after = txBy(t, `id = '${tx.id}'`);
    expect(after).toMatchObject({ status: 'approved', leaf_id: L.dom });
  });
});

describe('a várakozó tételek tervjavaslata', () => {
  it('a később létrejött (vagy a megszűnt helyett új) terv is javaslat lesz – a szabályok alkalmazásakor és szinkronkor', async () => {
    t = await createTestApp();
    seedTree(t);
    t.sql.prepare("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('nav afa', ?, 1, 0)").run(L.afa);
    await importRows(t, [{ date: day(-2), amount: -399000, partner: 'NAV Áfa', memo: 'adószám' }]);
    const tx = txBy(t, 'amount = -399000');
    expect(tx).toMatchObject({ leaf_id: L.afa, plan_id: null });
    // a havi ÁFA-terv csak később jön létre; a régi javaslat (törölt terv) is lecserélődik
    t.sql.prepare("UPDATE bank_tx SET plan_id = 'torolt_terv' WHERE id = ?").run(tx.id);
    addEntry(t, { id: 'p_afa', kind: 'plan', date: day(-5), leaf_id: L.afa, amount: -420000, name: 'ÁFA' });
    await t.post('/api/rules/apply', {});
    expect(txBy(t, `id = '${tx.id}'`).plan_id).toBe('p_afa');
  });
});
