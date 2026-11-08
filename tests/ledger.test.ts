import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { handleLedger, ledgerMonth, ledgerSummary } from '../worker/ledger';
import { todayHu } from '../worker/util';

function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
    run: async () => (db.prepare(sql).run(...(args as any[])), { success: true }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.all())) };
}

describe('számlatörténet', () => {
  it('nyitó/záró visszafelé a mostani egyenlegből, számla kapcsolás, készpénz', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE change_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, action TEXT, summary TEXT, leaf_ids TEXT, items TEXT, undo TEXT);
      CREATE TABLE bank_accounts (id TEXT PRIMARY KEY, provider TEXT, bank_name TEXT, label TEXT, iban TEXT, currency TEXT, balance INTEGER, balance_at INTEGER, active INTEGER DEFAULT 1);
      CREATE TABLE bank_tx (id TEXT PRIMARY KEY, account_id TEXT, ext_id TEXT, date TEXT, amount INTEGER, currency TEXT, partner TEXT, memo TEXT, status TEXT, leaf_id TEXT, plan_id TEXT, actual_id TEXT, created_at INTEGER);
      CREATE TABLE billingo_docs (id INTEGER PRIMARY KEY, number TEXT, plan_id TEXT, paid_by_tx TEXT, cancelled INTEGER DEFAULT 0);
      CREATE TABLE nav_invoices (id TEXT, invoice_number TEXT, plan_id TEXT, actual_id TEXT);
      INSERT INTO bank_accounts VALUES ('m','manual','MagNet','Üzleti',NULL,'HUF',1000,${Date.now()},1);`);
    const cur = todayHu().slice(0, 7);
    const [y, mo] = cur.split('-').map(Number);
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const ins = db.prepare("INSERT INTO bank_tx VALUES (?, 'm', ?, ?, ?, 'HUF', ?, '', 'approved', NULL, ?, ?, 1)");
    ins.run('t1', 'e1', prev + '-10', 500, 'Kalmia', 'p1', 'a1');
    ins.run('t2', 'e2', cur + '-02', -200, 'OMV', null, 'a2');
    db.exec("INSERT INTO billingo_docs (number, plan_id) VALUES ('PENGE-1', 'p1'); INSERT INTO nav_invoices VALUES ('n','NAV-9',NULL,'a2');");
    const env = { DB: d1(db) } as any;
    // csak banki adat: a mostani, bank által jelentett egyenleg a mai nappal; korábbi banki egyenleg nincs → nyitó: nincs adat
    let s = await ledgerSummary(env);
    let m = Object.fromEntries(s.months.map((x) => [x.ym, x.accounts.m]));
    expect(m[cur].close).toMatchObject({ amount: 1000, source: 'aggreg8' });
    expect(m[cur].open).toBeNull();
    expect(m[prev]).toMatchObject({ open: null, close: null, inc: 500 });
    // kivonat szerinti záró egyenleg az előző hónapra → ez lesz az előző záró és a mostani nyitó
    const u0 = { id: 1, role: 'admin' } as any;
    await handleLedger(
      env,
      new Request('https://x/api/bank/statement', { method: 'PUT', body: JSON.stringify({ account_id: 'm', date: prev + '-28', amount: 1200 }) }),
      '/api/bank/statement',
      u0,
    );
    s = await ledgerSummary(env);
    m = Object.fromEntries(s.months.map((x) => [x.ym, x.accounts.m]));
    expect(m[prev].close).toMatchObject({ amount: 1200, source: 'kivonat' });
    expect(m[cur].open).toMatchObject({ amount: 1200, source: 'kivonat' });
    const tx = await ledgerMonth(env, prev);
    expect(tx[0].invoices).toEqual([{ kind: 'billingo', number: 'PENGE-1' }]);
    expect((await ledgerMonth(env, cur))[0].invoices).toEqual([{ kind: 'nav', number: 'NAV-9' }]);
    // készpénz: nyitó + tételek
    const u = { id: 1, role: 'admin' } as any;
    const call = (path: string, body: unknown, method = 'POST') =>
      handleLedger(env, new Request('https://x' + path, { method, body: JSON.stringify(body) }), path, u);
    await call('/api/bank/cash/opening', { amount: '50000' }, 'PUT');
    await call('/api/bank/cash', { date: cur + '-05', amount: -3500, partner: 'Posta' });
    const cash = db.prepare("SELECT balance FROM bank_accounts WHERE id = 'cash'").get() as any;
    expect(cash.balance).toBe(46500);
    await expect(call('/api/bank/cash', { date: 'x', amount: 1 })).rejects.toThrow(/dátum/);
  });
});
