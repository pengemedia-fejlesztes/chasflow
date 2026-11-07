// A számla-szinkron (Billingo, NAV) és a banki jóváhagyás SQL-jei élesben MySQL-en futnak: a fordítónak az ütközési cél
// nélküli „ON CONFLICT DO NOTHING”-ot is kezelnie kell (különben a Billingo-szinkron teljes kötege elbukik).
import { describe, expect, it } from 'vitest';
import { translate } from '../../src/server/runtime/d1-mysql.mjs';

describe('MySQL fordítás – ON CONFLICT', () => {
  it('cél nélküli ON CONFLICT DO NOTHING → INSERT IGNORE (Billingo új terv / „fizetve” tény)', () => {
    const sql = translate(
      `INSERT INTO entries (id, kind, date, leaf_id, name, amount, bill_amount, done, tentative, source, ext_ref, updated_at)
           VALUES (?, 'plan', ?, ?, ?, ?, ?, 0, 0, 'billingo', ?, ?) ON CONFLICT DO NOTHING`,
    );
    expect(sql).toMatch(/^\s*INSERT IGNORE INTO entries/);
    expect(sql).not.toMatch(/ON\s+CONFLICT/i);
    expect(sql).not.toMatch(/DO\s+NOTHING/i);
  });
  it('céllal megadott ON CONFLICT(id) DO NOTHING továbbra is INSERT IGNORE', () => {
    const sql = translate('INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
    expect(sql).toBe('INSERT IGNORE INTO t (id, v) VALUES (?, ?)');
  });
  it('ON CONFLICT(id) DO UPDATE → ON DUPLICATE KEY UPDATE, excluded → VALUES()', () => {
    const sql = translate('INSERT INTO billingo_docs (id, gross) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET gross = excluded.gross');
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE gross = VALUES\(`?gross`?\)/);
  });
  it('cél nélküli ON CONFLICT DO UPDATE is fordul', () => {
    const sql = translate('INSERT INTO w (k, m) VALUES (?, ?) ON CONFLICT DO UPDATE SET m = w.m + excluded.m');
    expect(sql).not.toMatch(/ON\s+CONFLICT/i);
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE m = w\.m \+ VALUES\(`?m`?\)/);
  });
});

describe('MySQL-ben nem létező SQLite-függvények a szerver SQL-jeiben', () => {
  it('julianday() nincs (a banki jóváhagyás „Billingo: fizetve” keresése MySQL-en elbukott)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = 'src/server/app';
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /julianday\s*\(/i.test(readFileSync(`${dir}/${f}`, 'utf8')));
    expect(hits).toEqual([]);
  });
});
