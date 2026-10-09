// Adat végpontok: teljes adatcsomag, tétel-módosítások, kategóriák, beállítások, xls import.
import { groupId, groupSortKey, hash, leafId, normalizeImportRow, type ImportRow } from '../shared/categories';
import { partnerKey } from '../shared/match';
import type { DataBundle, Entry, EntryBatch, Section, Series } from '../shared/types';
import { publicUser, requireRole, type User } from './auth';
import { Env, HttpError, audit, json, now, readJson, setSetting, todayHu } from './util';

export async function loadBundle(env: Env, u: User): Promise<DataBundle> {
  const [groups, leaves, series, entries, accounts, bankTx, billingo, settings] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM groups ORDER BY section, sort, label'),
    env.DB.prepare('SELECT * FROM leaves ORDER BY sort, label'),
    env.DB.prepare('SELECT * FROM series'),
    env.DB.prepare(
      'SELECT id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at FROM entries ORDER BY date',
    ),
    env.DB.prepare(
      'SELECT id, provider, bank_name, label, iban, currency, balance, balance_at, valid_until, last_sync, last_error, active FROM bank_accounts ORDER BY bank_name',
    ),
    env.DB.prepare(
      "SELECT id, account_id, date, amount, currency, partner, memo, status, leaf_id, plan_id, actual_id FROM bank_tx WHERE status = 'new' OR date >= date('now', '-60 days') ORDER BY date DESC",
    ),
    env.DB.prepare(
      "SELECT id, number, partner, gross, currency, invoice_date, due_date, payment_status, paid_date, cancelled, plan_id FROM billingo_docs WHERE invoice_date >= date('now', '-400 days') ORDER BY invoice_date DESC",
    ),
    env.DB.prepare('SELECT key, value FROM settings'),
  ]);
  const st: Record<string, string> = {};
  (settings.results as { key: string; value: string }[]).forEach((r) => (st[r.key] = r.value));
  return {
    me: publicUser(u),
    today: todayHu(),
    groups: groups.results as any,
    leaves: leaves.results as any,
    series: series.results as any,
    entries: entries.results as any,
    accounts: accounts.results as any,
    bankTx: bankTx.results as any,
    billingo: billingo.results as any,
    settings: st,
    integrations: { billingo: !!env.BILLINGO_API_KEY, enableBanking: !!(env.EB_APP_ID && env.EB_PRIVATE_KEY) },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanEntry(e: Entry): Entry {
  if (!e || typeof e.id !== 'string' || !/^[\w:-]{1,80}$/.test(e.id)) throw new HttpError(400, 'Hibás tétel azonosító.');
  if (e.kind !== 'actual' && e.kind !== 'plan') throw new HttpError(400, 'Hibás tétel típus.');
  if (!DATE_RE.test(e.date)) throw new HttpError(400, 'Hibás dátum.');
  const amount = Math.round(Number(e.amount));
  if (!isFinite(amount) || Math.abs(amount) > 1e12) throw new HttpError(400, 'Hibás összeg.');
  return {
    ...e,
    amount,
    name: String(e.name || '').slice(0, 200),
    note: e.note ? String(e.note).slice(0, 1000) : null,
    done: e.done ? 1 : 0,
    tentative: e.tentative ? 1 : 0,
    series_id: e.series_id || null,
    link_id: e.link_id || null,
    ext_ref: e.ext_ref || null,
    source: String(e.source || 'manual').slice(0, 20),
  };
}

export async function applyBatch(env: Env, b: EntryBatch, userId: number) {
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const s of b.series || []) {
    const rep = ['once', 'monthly', 'quarterly'].includes(s.rep) ? s.rep : 'once';
    stmts.push(
      env.DB.prepare(
        'INSERT INTO series (id, leaf_id, name, rep, day) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET leaf_id = excluded.leaf_id, name = excluded.name, rep = excluded.rep, day = excluded.day',
      ).bind(String(s.id).slice(0, 80), s.leaf_id, String(s.name || '').slice(0, 200), rep, Math.min(31, Math.max(1, Number(s.day) || 1))),
    );
  }
  for (const raw of b.upsert || []) {
    const e = cleanEntry(raw);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, date = excluded.date, leaf_id = excluded.leaf_id, name = excluded.name,
           amount = excluded.amount, series_id = excluded.series_id, done = excluded.done, tentative = excluded.tentative,
           source = excluded.source, ext_ref = excluded.ext_ref, link_id = excluded.link_id, note = excluded.note,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).bind(e.id, e.kind, e.date, e.leaf_id, e.name, e.amount, e.series_id, e.done, e.tentative, e.source, e.ext_ref, e.link_id, e.note, t, userId),
    );
  }
  // Billingo számla kézi átsorolása → partner szabály tanulása (a következő számlák és banki tételek is ide kerülnek)
  for (const raw of b.upsert || []) {
    if (raw.ext_ref && raw.ext_ref.startsWith('billingo:')) {
      const doc = await env.DB.prepare('SELECT partner FROM billingo_docs WHERE id = ?')
        .bind(Number(raw.ext_ref.slice(9)))
        .first<{ partner: string }>();
      const key = doc?.partner ? partnerKey(doc.partner) : '';
      if (key)
        stmts.push(
          env.DB.prepare(
            'INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(pattern) DO UPDATE SET leaf_id = excluded.leaf_id, updated_at = excluded.updated_at',
          ).bind(key, raw.leaf_id, t),
        );
    }
  }
  for (const id of b.delete || []) stmts.push(env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(String(id)));
  for (const id of b.deleteSeries || []) stmts.push(env.DB.prepare('DELETE FROM series WHERE id = ?').bind(String(id)));
  if (stmts.length > 2000) throw new HttpError(413, 'Túl sok módosítás egyszerre.');
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/** Kategória biztosítása (import, Billingo, bank). */
export class CategoryCache {
  groups = new Set<string>();
  leaves = new Set<string>();
  constructor(private env: Env) {}
  async load() {
    const g = await this.env.DB.prepare('SELECT id FROM groups').all<{ id: string }>();
    g.results.forEach((r) => this.groups.add(r.id));
    const l = await this.env.DB.prepare('SELECT id FROM leaves').all<{ id: string }>();
    l.results.forEach((r) => this.leaves.add(r.id));
    return this;
  }
  stmtsFor(section: Section, group: string, leaf: string): { gid: string; lid: string; stmts: D1PreparedStatement[] } {
    const gid = groupId(section, group);
    const lid = leafId(gid, leaf);
    const stmts: D1PreparedStatement[] = [];
    if (!this.groups.has(gid)) {
      stmts.push(
        this.env.DB.prepare('INSERT OR IGNORE INTO groups (id, section, label, sort) VALUES (?, ?, ?, ?)').bind(gid, section, group, groupSortKey(group)),
      );
      this.groups.add(gid);
    }
    if (!this.leaves.has(lid)) {
      stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO leaves (id, group_id, label, sort) VALUES (?, ?, ?, 0)').bind(lid, gid, leaf));
      this.leaves.add(lid);
    }
    return { gid, lid, stmts };
  }
}

async function importRows(env: Env, kind: 'actual' | 'plan', rows: ImportRow[], replacePlans: boolean, userId: number) {
  const cache = await new CategoryCache(env).load();
  const stmts: D1PreparedStatement[] = [];
  const seen: Record<string, number> = {};
  let imported = 0,
    skipped = 0,
    minDate = '9999-12-31';
  const t = now();
  const prepared: { lid: string; n: ReturnType<typeof normalizeImportRow> & {}; ext: string }[] = [];
  for (const r of rows) {
    const n = normalizeImportRow(r, kind);
    if (!n) {
      skipped++;
      continue;
    }
    const { lid, stmts: cs } = cache.stmtsFor(n.section, n.group, n.leaf);
    stmts.push(...cs);
    const base = [kind, n.date, n.group, n.leaf, n.name, n.amount].join('|');
    seen[base] = (seen[base] || 0) + 1;
    const ext = `imp:${kind}:${hash(base)}:${seen[base]}`;
    prepared.push({ lid, n, ext });
    if (n.date < minDate) minDate = n.date;
  }
  if (kind === 'plan' && replacePlans && prepared.length) {
    // az új tervfájl felülírja a korábban importált, még nyitott terveket az időszakában
    stmts.push(env.DB.prepare("DELETE FROM entries WHERE kind = 'plan' AND source = 'import' AND done = 0 AND date >= ?").bind(minDate));
  }
  for (const { lid, n, ext } of prepared) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, ext_ref, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'import', ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind('i' + hash(ext) + hash(ext + '#'), kind, n.date, lid, n.name, n.amount, n.tentative ? 1 : 0, ext, t, userId),
    );
    imported++;
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { imported, skipped };
}

export async function handleData(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (path === '/api/data' && req.method === 'GET') return json(await loadBundle(env, u));

  if (path === '/api/entries/batch' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<EntryBatch>(req);
    const n = await applyBatch(env, b, u.id);
    return json({ ok: true, changes: n });
  }

  if (path === '/api/leaves' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson(req);
    const g = await env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(String(b.group_id)).first<{ id: string }>();
    if (!g) throw new HttpError(400, 'Ismeretlen csoport.');
    const label = String(b.label || '')
      .trim()
      .slice(0, 80);
    if (!label) throw new HttpError(400, 'Adj meg nevet.');
    const id = leafId(g.id, label);
    await env.DB.prepare('INSERT OR IGNORE INTO leaves (id, group_id, label, sort) VALUES (?, ?, ?, 0)').bind(id, g.id, label).run();
    await env.DB.prepare('UPDATE leaves SET archived = 0 WHERE id = ?').bind(id).run();
    return json({ ok: true, id });
  }
  const lm = path.match(/^\/api\/leaves\/([\w-]+)$/);
  if (lm && req.method === 'PATCH') {
    requireRole(u, 'admin', 'member');
    const b = await readJson(req);
    if (b.label !== undefined) await env.DB.prepare('UPDATE leaves SET label = ? WHERE id = ?').bind(String(b.label).trim().slice(0, 80), lm[1]).run();
    if (b.archived !== undefined)
      await env.DB.prepare('UPDATE leaves SET archived = ? WHERE id = ?')
        .bind(b.archived ? 1 : 0, lm[1])
        .run();
    if (b.group_id !== undefined) await env.DB.prepare('UPDATE leaves SET group_id = ? WHERE id = ?').bind(String(b.group_id), lm[1]).run();
    return json({ ok: true });
  }
  if (path === '/api/groups' && req.method === 'POST') {
    requireRole(u, 'admin');
    const b = await readJson(req);
    const section: Section = b.section === 'in' ? 'in' : 'out';
    const label = String(b.label || '')
      .trim()
      .slice(0, 80);
    if (!label) throw new HttpError(400, 'Adj meg nevet.');
    const id = groupId(section, label);
    await env.DB.prepare('INSERT OR IGNORE INTO groups (id, section, label, sort) VALUES (?, ?, ?, ?)').bind(id, section, label, groupSortKey(label)).run();
    return json({ ok: true, id });
  }

  if (path === '/api/settings' && req.method === 'PUT') {
    requireRole(u, 'admin');
    const b = await readJson<Record<string, unknown>>(req);
    const allowed = ['opening_balance', 'billingo_leaf_default'];
    for (const k of allowed) if (k in b) await setSetting(env, k, b[k] == null ? null : String(b[k]).slice(0, 200));
    await audit(env, u.id, 'settings', b);
    return json({ ok: true });
  }

  if (path === '/api/import' && req.method === 'POST') {
    requireRole(u, 'admin');
    const b = await readJson<{ kind: 'actual' | 'plan'; rows: ImportRow[]; replacePlans?: boolean }>(req, 20_000_000);
    if (b.kind !== 'actual' && b.kind !== 'plan') throw new HttpError(400, 'Hibás import típus.');
    if (!Array.isArray(b.rows) || b.rows.length > 50_000) throw new HttpError(400, 'Hibás sorok.');
    const r = await importRows(env, b.kind, b.rows, !!b.replacePlans, u.id);
    await audit(env, u.id, 'import', { kind: b.kind, ...r });
    return json({ ok: true, ...r });
  }

  if (path === '/api/series' && req.method === 'GET') {
    const r = await env.DB.prepare('SELECT * FROM series').all<Series>();
    return json(r.results);
  }
  return null;
}
