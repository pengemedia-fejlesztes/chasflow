// Író végpontok: párosítási szabályok (/api/rules, /api/partner-rules) és a partnertörzs (PUT /api/partners/:key).
// Valódi backend; ellenőrizzük a sorokat, a visszaolvasást (GET /api/rules, /api/data), a jogosultságot,
// a hibás bemenetet (részleges írás nélkül) és az idempotenciát.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { setupLeaves } from '../helpers/adatok-client';
import { partnerIdOf } from '../../src/shared/partners';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

const rows = (sql: string, ...args: any[]) => t!.sql.prepare(sql).all(...args) as any[];
const row = (sql: string, ...args: any[]) => t!.sql.prepare(sql).get(...args) as any;
const manual = () => rows("SELECT pattern, leaf_id, auto, merge FROM match_rules WHERE source = 'manual' ORDER BY pattern");

describe('„tartalmazza” szabályok (/api/rules)', () => {
  it('felvétel és visszaolvasás; ugyanaz kétszer nem duplikál, a második kattintás beállítása érvényes', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const r = await t.post('/api/rules', { pattern: 'Adobe Systems', leaf_id: L.szoftver });
    expect(r.status).toBe(200);
    expect(manual()).toEqual([{ pattern: 'adobe systems', leaf_id: L.szoftver, auto: 0, merge: 0 }]);
    const again = await t.post('/api/rules', { pattern: 'ADOBE  systems', leaf_id: L.szoftver, auto: true });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(r.data.id);
    expect(manual()).toEqual([{ pattern: 'adobe systems', leaf_id: L.szoftver, auto: 1, merge: 0 }]);
    const list = (await t.get('/api/rules')).data.contains as any[];
    expect(list.filter((x) => x.pattern === 'adobe systems')).toEqual([expect.objectContaining({ id: r.data.id, leaf_id: L.szoftver, auto: 1 })]);
    // ugyanaz a minta MÁSIK kategóriára: külön szabály (a leghosszabb / első egyezés dönt, ez szándékos)
    expect((await t.post('/api/rules', { pattern: 'adobe systems', leaf_id: L.iroda })).status).toBe(200);
    expect(manual()).toHaveLength(2);
  });

  it('rövid minta / nem létező kategória: 400, nem jön létre szabály', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const short = await t.post('/api/rules', { pattern: ' a ', leaf_id: L.szoftver });
    expect(short.status).toBe(400);
    expect(short.data.error).toMatch(/legalább 2 karaktert/);
    const noLeaf = await t.post('/api/rules', { pattern: 'adobe', leaf_id: 'l_nincs' });
    expect(noLeaf.status).toBe(400);
    expect(noLeaf.data.error).toBe('Válassz kategóriát.');
    expect(manual()).toEqual([]);
  });

  it('módosítás: nem létező szabály 404; hibás kategória 400 és a minta sem változik; helyes módosítás + törlés', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const id = (await t.post('/api/rules', { pattern: 'telekom', leaf_id: L.iroda })).data.id;
    const missing = await t.patch('/api/rules/r_nincs', { auto: true });
    expect(missing.status).toBe(404);
    expect(row('SELECT count(*) AS n FROM match_rules WHERE id = ?', 'r_nincs').n).toBe(0);

    const bad = await t.patch(`/api/rules/${id}`, { pattern: 'magyar telekom', leaf_id: 'l_nincs' });
    expect(bad.status).toBe(400);
    expect(row('SELECT pattern, leaf_id FROM match_rules WHERE id = ?', id)).toEqual({ pattern: 'telekom', leaf_id: L.iroda });
    expect((await t.patch(`/api/rules/${id}`, { pattern: 'x' })).status).toBe(400);

    const ok = await t.patch(`/api/rules/${id}`, { pattern: 'Magyar Telekom', leaf_id: L.szoftver, auto: true, merge: true, note: 'mobilszámla' });
    expect(ok.status).toBe(200);
    expect(row('SELECT pattern, leaf_id, auto, merge, note FROM match_rules WHERE id = ?', id)).toEqual({
      pattern: 'magyar telekom',
      leaf_id: L.szoftver,
      auto: 1,
      merge: 1,
      note: 'mobilszámla',
    });

    expect((await t.del(`/api/rules/${id}`)).status).toBe(200);
    expect(row('SELECT count(*) AS n FROM match_rules WHERE id = ?', id).n).toBe(0);
    expect((await t.del(`/api/rules/${id}`)).status).toBe(200); // ismételt törlés: nincs mit, nem hiba
    expect(rows("SELECT action FROM audit_log WHERE action LIKE 'rule_%' ORDER BY id").map((r) => r.action)).toEqual([
      'rule_created',
      'rule_updated',
      'rule_deleted',
      'rule_deleted',
    ]);
  });
});

describe('tanult partner-szabályok (/api/partner-rules)', () => {
  it('módosítás / törlés; ismeretlen minta 404, nem létező kategória 400 – változás nélkül', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    t.sql.prepare("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('minta szolgaltato', ?, 3, 1)").run(L.szoftver);
    expect((await t.patch('/api/partner-rules', { pattern: 'nincs ilyen', auto: true })).status).toBe(404);
    const bad = await t.patch('/api/partner-rules', { pattern: 'minta szolgaltato', leaf_id: 'l_nincs', auto: true });
    expect(bad.status).toBe(400);
    expect(row("SELECT leaf_id, auto FROM partner_rules WHERE pattern = 'minta szolgaltato'")).toEqual({ leaf_id: L.szoftver, auto: 0 });

    expect((await t.patch('/api/partner-rules', { pattern: 'minta szolgaltato', leaf_id: L.iroda, auto: true })).status).toBe(200);
    const learned = (await t.get('/api/rules')).data.learned as any[];
    expect(learned).toEqual([expect.objectContaining({ pattern: 'minta szolgaltato', leaf_id: L.iroda, auto: 1, hits: 3 })]);

    expect((await t.del('/api/partner-rules', { pattern: 'minta szolgaltato' })).status).toBe(200);
    expect(rows('SELECT * FROM partner_rules')).toEqual([]);
  });
});

describe('szabályok jogosultsága', () => {
  it('olvasó: 403 minden szabály-író végponton, semmi nem változik; szerkesztő írhat', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const id = (await t.post('/api/rules', { pattern: 'telekom', leaf_id: L.iroda })).data.id;
    t.sql.prepare("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('minta szolgaltato', ?, 3, 1)").run(L.szoftver);
    await t.addUser('olvaso@minta.hu', 'viewer');
    await t.loginAs('olvaso@minta.hu');
    for (const [m, p, b] of [
      ['POST', '/api/rules', { pattern: 'adobe', leaf_id: L.szoftver }],
      ['PATCH', `/api/rules/${id}`, { auto: true }],
      ['DELETE', `/api/rules/${id}`, {}],
      ['PATCH', '/api/partner-rules', { pattern: 'minta szolgaltato', auto: true }],
      ['DELETE', '/api/partner-rules', { pattern: 'minta szolgaltato' }],
      ['POST', '/api/rules/apply', {}],
    ] as const) {
      const r = await t.call(m, p, b);
      expect([m, p, r.status]).toEqual([m, p, 403]);
    }
    expect(manual()).toEqual([{ pattern: 'telekom', leaf_id: L.iroda, auto: 0, merge: 0 }]);
    expect(row('SELECT auto FROM partner_rules').auto).toBe(0);
    await t.addUser('szerk@minta.hu', 'member');
    await t.loginAs('szerk@minta.hu');
    expect((await t.patch(`/api/rules/${id}`, { auto: true })).status).toBe(200);
    expect((await t.del('/api/partner-rules', { pattern: 'minta szolgaltato' })).status).toBe(200);
  });
});

describe('partnertörzs (PUT /api/partners/:key)', () => {
  it('adatlap mentése: törzsrekord, alternatív nevekből párosítási szabály, visszaolvasás; ismételt mentés nem duplikál', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const key = partnerIdOf('Minta Kft.');
    const body = { kind: 'vevo', aliases: ['Minta Hungary Zrt.', 'minta hungary zrt', 'x'], tax_number: '12345678-2-41', note: 'Havi retainer' };
    const r = await t.put(`/api/partners/${key}`, body);
    expect(r.status).toBe(200);
    expect(r.data.key).toBe(key);
    const p = (await t.get('/api/data')).data.partners.find((x: any) => x.key === key);
    expect(p).toMatchObject({ name: 'Minta Kft.', kind: 'vevo', aliases: ['Minta Hungary Zrt.'], tax_number: '12345678-2-41', note: 'Havi retainer' });
    const aliasRules = () => rows("SELECT pattern, leaf_id FROM match_rules WHERE source = 'alias'");
    expect(aliasRules()).toEqual([{ pattern: 'minta hungary zrt', leaf_id: L.minta }]);

    expect((await t.put(`/api/partners/${key}`, body)).status).toBe(200);
    expect(rows('SELECT key FROM partners')).toEqual([{ key }]);
    expect(aliasRules()).toHaveLength(1);
    // az alternatív nevek cseréje a régi alias-szabályokat is lecseréli
    expect((await t.put(`/api/partners/${key}`, { aliases: ['Minta Digital'] })).status).toBe(200);
    expect(aliasRules()).toEqual([{ pattern: 'minta digital', leaf_id: L.minta }]);
    expect(row('SELECT kind, tax_number FROM partners WHERE key = ?', key)).toEqual({ kind: 'vevo', tax_number: '12345678-2-41' });
  });

  it('ismeretlen partner 404; üres név / ismeretlen típus 400; névütközés ugyanabban a mappában 409 – mindegyik változás nélkül', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const key = partnerIdOf('Minta Kft.');
    await t.put(`/api/partners/${key}`, { kind: 'vevo', aliases: ['Minta Hungary Zrt.'] });
    const snapshot = () => ({
      partners: rows('SELECT * FROM partners'),
      leaves: rows('SELECT id, label FROM leaves ORDER BY id'),
      rules: rows('SELECT pattern, leaf_id, source FROM match_rules ORDER BY pattern'),
    });
    const before = snapshot();

    const missing = await t.put('/api/partners/nincsilyenpartner', { name: 'Valaki' });
    expect(missing.status).toBe(404);
    expect(missing.data.error).toBe('Nincs ilyen partner.');
    const empty = await t.put(`/api/partners/${key}`, { name: '  ', aliases: ['Más Név'] });
    expect(empty.status).toBe(400);
    expect(empty.data.error).toBe('Adj meg nevet.');
    const badKind = await t.put(`/api/partners/${key}`, { kind: 'beszállító', aliases: ['Más Név'] });
    expect(badKind.status).toBe(400);
    expect(badKind.data.error).toBe('Ismeretlen partnertípus.');
    const clash = await t.put(`/api/partners/${partnerIdOf('Alfa Bt.')}`, { name: 'Minta Kft.', aliases: ['Más Név'] });
    expect(clash.status).toBe(409);
    expect(clash.data.error).toMatch(/vond össze/);
    expect(snapshot()).toEqual(before);
    expect(L.alfa).toBeTruthy();
  });

  it('a típus üresre állítható (automatikus); szerkesztő is mentheti az adatlapot', async () => {
    t = await createTestApp();
    await setupLeaves(t);
    const key = partnerIdOf('Minta Kft.');
    await t.put(`/api/partners/${key}`, { kind: 'szallito' });
    await t.addUser('szerk@minta.hu', 'member');
    await t.loginAs('szerk@minta.hu');
    expect((await t.put(`/api/partners/${key}`, { kind: null })).status).toBe(200);
    expect(row('SELECT kind FROM partners WHERE key = ?', key).kind).toBeNull();
  });
});
