// Terv–tény havi pillanatkép (month_stats) végponttól végpontig: a valódi backend számolja, és ugyanannyinak kell lennie,
// mint amit az Áttekintés (buildIndex) és a kliens Terv vs. tény nézete (planVsActual) ugyanarra a hónapra mutat.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIndex, sumMonths } from '../../src/shared/model';
import { closedMonth, planVsActual } from '../../src/shared/planactual';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 2026. november 7., délelőtt (Budapest)
  vi.setSystemTime(new Date('2026-11-07T09:00:00Z'));
});
afterEach(() => {
  t?.close();
  t = undefined;
  vi.useRealTimers();
});

function seed(app: TestApp) {
  const s = app.sql;
  s.prepare("INSERT INTO groups (id, section, label, sort) VALUES ('tg_in', 'in', 'Teszt ügyfelek', 0), ('tg_out', 'out', 'Teszt költségek', 1)").run();
  s.prepare(
    `INSERT INTO leaves (id, group_id, label, sort, archived) VALUES
     ('tl_minta', 'tg_in', 'Minta Kft.', 0, 0),
     ('tl_berlet', 'tg_out', 'Iroda bérlés', 0, 0),
     ('tl_keret', 'tg_out', 'Előre nem látható költség', 1, 0)`,
  ).run();
  const ins = s.prepare(
    'INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, link_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
  );
  const rows: [string, string, string, string, string, number, number, number, string, string | null][] = [
    // október: lezárt hónap
    ['p_okt_minta', 'plan', '2026-10-10', 'tl_minta', 'Havi díj – 2026. október', 800000, 1, 0, 'manual', 'a_okt_minta'],
    ['a_okt_minta', 'actual', '2026-10-12', 'tl_minta', 'Minta Kft.', 800000, 0, 0, 'bank', null],
    ['p_okt_berlet', 'plan', '2026-10-05', 'tl_berlet', 'Bérleti díj – 2026. október', -250000, 1, 0, 'manual', 'a_okt_berlet'],
    ['a_okt_berlet', 'actual', '2026-10-05', 'tl_berlet', 'Ingatlan Kft.', -250000, 0, 0, 'bank', null],
    // keret 50 000, ebből fogy egy 4 051 Ft-os számla (nyitott) – a hónap terve 50 000, nem 54 051
    ['p_okt_keret', 'plan', '2026-10-30', 'tl_keret', 'Előre nem látható költség – 2026. október', -50000, 0, 0, 'import', null],
    ['p_okt_xp', 'plan', '2026-10-15', 'tl_keret', 'Szoftver Kft. – 2026. október', -4051, 0, 0, 'nav', null],
    // november: folyó hónap
    ['p_nov_minta', 'plan', '2026-11-10', 'tl_minta', 'Havi díj – 2026. november', 800000, 0, 0, 'manual', null],
    ['p_nov_ajanlat', 'plan', '2026-11-20', 'tl_minta', 'Kampány', 300000, 0, 1, 'manual', null],
    ['p_nov_berlet', 'plan', '2026-11-05', 'tl_berlet', 'Bérleti díj – 2026. november', -250000, 0, 0, 'manual', null],
    ['p_nov_keret', 'plan', '2026-11-30', 'tl_keret', 'Előre nem látható költség – 2026. november', -50000, 0, 0, 'import', null],
    ['a_nov_futar', 'actual', '2026-11-04', 'tl_keret', 'Futár', -12000, 0, 0, 'bank', null],
  ];
  for (const r of rows) ins.run(...r);
}

describe('Terv vs. tény pillanatkép (month_stats)', () => {
  it('a pillanatkép = az Áttekintés terve és ténye ugyanarra a hónapra (keret-tervvel is)', async () => {
    t = await createTestApp();
    seed(t);
    const r = await t.post('/api/stats/refresh', {});
    expect(r.status).toBe(200);
    const stats = t.sql.prepare('SELECT * FROM month_stats ORDER BY ym').all() as any[];
    const okt = stats.find((s) => s.ym === '2026-10');
    const nov = stats.find((s) => s.ym === '2026-11');
    expect(okt).toMatchObject({ plan_in: 800000, act_in: 800000, plan_out: 250000 + 50000, act_out: 250000, closed: 1 });
    expect(nov).toMatchObject({ plan_in: 800000, offer_in: 300000, plan_out: 250000 + 50000, act_out: 12000, closed: 0 });

    // ugyanez a kliens oldali modellből (az /api/data csomagból)
    const d = (await t.get('/api/data')).data;
    expect(d.today).toBe('2026-11-07');
    const ix = buildIndex(d);
    const planOut = (ym: string) => -[...ix.plan].filter(([l]) => ix.sectionOf(l) === 'out').reduce((a, [, m]) => a + sumMonths(m, [ym]), 0);
    expect(planOut('2026-10')).toBe(okt.plan_out);
    expect(planOut('2026-11')).toBe(nov.plan_out);
    const live = planVsActual(d.entries, ix.sectionOf, ['2026-10', '2026-11'], (l) => ix.leafById[l]?.label || '');
    expect(live.map((m) => m.planOut)).toEqual([okt.plan_out, nov.plan_out]);
    // a folyó hónapban még nyitott: a bérlet + a keretből még hátralévő 38 000
    expect(live[1].openOut).toBe(250000 + 38000);
    expect(d.monthStats.map((s: any) => s.ym)).toEqual(['2026-10', '2026-11']);
  });
});

describe('lezárt hónap: a terv befagy, a tény élő', () => {
  it('a lezárás után jóváhagyott októberi banki tétel megjelenik az október tényében, az utólag módosított terv nem írja felül a pillanatképet', async () => {
    t = await createTestApp();
    seed(t);
    await t.post('/api/stats/refresh', {});
    const before = t.sql.prepare("SELECT * FROM month_stats WHERE ym = '2026-10'").get() as any;
    expect(before).toMatchObject({ plan_out: 300000, act_out: 250000, closed: 1 });

    // az október 20-i javítási díj banki tétele csak november elején érkezik meg, és csak a hónap lezárása után hagyják jóvá
    const imp = await t.post('/api/bank/import', {
      bank_name: 'Minta Bank',
      label: 'Üzleti számla',
      rows: [{ date: '2026-10-20', amount: -120000, partner: 'Gépjavító Bt.', memo: 'Klíma javítás' }],
    });
    expect(imp.status).toBe(200);
    const tx = t.sql.prepare('SELECT id FROM bank_tx WHERE amount = -120000').get() as any;
    expect((await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: 'tl_berlet' }] })).status).toBe(200);
    // közben az októberi bérleti díj tervét utólag átírják – a lezárt hónap terve ettől nem változhat
    t.sql.prepare("UPDATE entries SET amount = -260000 WHERE id = 'p_okt_berlet'").run();

    // a felület (a frissítés előtt is) a pillanatkép tervét és az élő tényt mutatja
    const d = (await t.get('/api/data')).data;
    const ix = buildIndex(d);
    const [liveOkt] = planVsActual(d.entries, ix.sectionOf, ['2026-10'], (l) => ix.leafById[l]?.label || '');
    const shown = closedMonth(d.monthStats.find((s: any) => s.ym === '2026-10'), liveOkt);
    expect(shown).toEqual({ planIn: 800000, planOut: 300000, actIn: 800000, actOut: 250000 + 120000 });

    // a reggeli frissítés a lezárt hónap tényét is frissíti, a tervét és a lezárás idejét nem
    await t.post('/api/stats/refresh', {});
    const after = t.sql.prepare("SELECT * FROM month_stats WHERE ym = '2026-10'").get() as any;
    expect(after).toMatchObject({ plan_in: 800000, plan_out: 300000, act_in: 800000, act_out: 370000, closed: 1, computed_at: before.computed_at });
  });
});
