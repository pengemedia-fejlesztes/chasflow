// Banki tesztek közös alapadatai: egy kis, valószerű kategóriafa (kitalált partnerekkel) és segédek
// tervek / tények / banki tételek felviteléhez. A dátumok a mai naphoz igazodnak, mert a szerver
// lekérdezései date('now')-hoz mért ablakokkal dolgoznak (pl. az utolsó 120 nap tervei).
import type { TestApp } from './app';

export const L = {
  alfa: 'l_alfa', // bevétel: Alfa Kft. (projekt)
  beta: 'l_beta', // bevétel: Béta Bt. (projekt)
  bank: 'l_bank', // kiadás: Bank költség
  unf: 'l_unf', // kiadás: Előre nem látható költség
  dom: 'l_dom', // kiadás: Domain-Tárhely (több szolgáltató közös kategóriája)
  konyv: 'l_konyv', // kiadás: Könyvelés
  afa: 'l_afa', // kiadás: ÁFA
};

export function seedTree(t: TestApp) {
  const s = t.sql;
  s.exec(`INSERT INTO groups (id, section, label, sort) VALUES
    ('g_in', 'in', 'Projektek', 1), ('g_out', 'out', 'Működési költségek', 2), ('g_tax', 'out', 'Adók', 3)`);
  s.exec(`INSERT INTO leaves (id, group_id, label, sort) VALUES
    ('${L.alfa}', 'g_in', 'Alfa Kft.', 1), ('${L.beta}', 'g_in', 'Béta Bt.', 2),
    ('${L.bank}', 'g_out', 'Bank költség', 1), ('${L.unf}', 'g_out', 'Előre nem látható költség', 2),
    ('${L.dom}', 'g_out', 'Domain-Tárhely', 3), ('${L.konyv}', 'g_out', 'Könyvelés', 4), ('${L.afa}', 'g_tax', 'ÁFA', 1)`);
}

/** A mai nap (UTC, ahogy a SQLite date('now') látja) ± n nap, YYYY-MM-DD. */
export function day(n = 0): string {
  return new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
}

export function addEntry(
  t: TestApp,
  e: { id: string; kind: 'plan' | 'actual'; date: string; leaf_id: string; amount: number; name?: string; done?: number; link_id?: string | null; source?: string; ext_ref?: string | null },
) {
  t.sql
    .prepare(
      `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, source, ext_ref, link_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.id, e.kind, e.date, e.leaf_id, e.name ?? '', e.amount, e.done ?? 0, e.source ?? 'manual', e.ext_ref ?? null, e.link_id ?? null, Date.now());
}

export const entry = (t: TestApp, id: string) => t.sql.prepare('SELECT * FROM entries WHERE id = ?').get(id) as any;
export const txs = (t: TestApp) => t.sql.prepare('SELECT * FROM bank_tx ORDER BY date, amount').all() as any[];
export const txBy = (t: TestApp, where: string) => t.sql.prepare(`SELECT * FROM bank_tx WHERE ${where}`).get() as any;

export type Row = { date: string; amount: number; partner?: string; memo?: string; ext?: string };

/** Kézi kivonat-import (Beállítások › Bank › Kivonat feltöltése) – ugyanaz a végpont, amit a felület hív. */
export async function importRows(t: TestApp, rows: Row[], bank = 'Minta Bank', label = 'Üzleti számla') {
  const r = await t.post('/api/bank/import', { bank_name: bank, label, rows });
  if (r.status !== 200) throw new Error(`import: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
