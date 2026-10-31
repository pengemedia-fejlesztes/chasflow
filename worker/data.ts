// Adat végpontok: teljes adatcsomag, tétel-módosítások, kategóriák, beállítások, xls import.
import { MONTHLY_RX, withMonth } from '../shared/monthname';
import { groupId, groupSortKey, hash, leafId, normalizeImportRow, type ImportRow } from '../shared/categories';
import { partnerKey } from '../shared/match';
import { partnerIdOf } from '../shared/partners';
import { sheetIdOf } from '../shared/worktime';
import type { DataBundle, Entry, EntryBatch, Section, Series } from '../shared/types';
import { publicUser, requireRole, type User } from './auth';
import { navEnabled } from './nav';
import { refreshMonthStats } from './stats';
import { describeEntries, logChange, rowsById } from './changelog';
import { Env, HttpError, audit, json, now, readJson, setSetting, todayHu } from './util';

/** Fizetési nap szabály ellenőrzése: első / utolsó munkanap, vagy N. nap. */
function cleanPayRule(v: unknown): string | null {
  const r = v == null ? '' : String(v);
  return /^(first_workday|last_workday|day:([1-9]|[12]\d|3[01])|inv:\d{1,3})$/.test(r) ? r : null;
}

/** Van-e már az entries.period oszlop (0016-os migráció). A telepítés a migráció hibája esetén is kirakja a kódot – addig nélküle fut. */
let periodCol: boolean | null = null;
async function hasPeriod(env: Env) {
  if (periodCol === null) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('entries') WHERE name = 'period'").first<{ n: number }>();
    periodCol = !!r?.n;
  }
  return periodCol;
}

export async function loadBundle(env: Env, u: User): Promise<DataBundle> {
  const P = (await hasPeriod(env)) ? 'period, ' : '';
  const [
    groups,
    leaves,
    series,
    entries,
    accounts,
    bankTx,
    billingo,
    settings,
    deleted,
    monthStats,
    partnerNames,
    lostOffers,
    navInvoices,
    partners,
    employees,
    worktime,
  ] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM groups ORDER BY section, sort, label'),
    env.DB.prepare('SELECT * FROM leaves ORDER BY sort, label'),
    env.DB.prepare('SELECT * FROM series'),
    env.DB.prepare(
      `SELECT id, kind, date, leaf_id, name, amount, plan_amount, bill_amount, series_id, done, tentative, was_offer, offer_at, accepted_at, ${P}source, ext_ref, link_id, note, updated_at FROM entries ORDER BY date`,
    ),
    env.DB.prepare(
      'SELECT id, provider, bank_name, label, iban, currency, balance, balance_at, valid_until, last_sync, last_error, active FROM bank_accounts ORDER BY bank_name',
    ),
    env.DB.prepare(
      "SELECT id, account_id, date, amount, currency, partner, memo, status, leaf_id, plan_id, actual_id FROM bank_tx WHERE status = 'new' OR date >= date('now', '-60 days') ORDER BY date DESC",
    ),
    env.DB.prepare(
      "SELECT id, number, partner, partner_tax, gross, currency, invoice_date, due_date, payment_status, paid_date, cancelled, plan_id FROM billingo_docs WHERE invoice_date >= date('now', '-400 days') ORDER BY invoice_date DESC",
    ),
    env.DB.prepare('SELECT key, value FROM settings'),
    env.DB.prepare(
      `SELECT d.rowid AS rid, d.id, d.kind, d.date, d.leaf_id, d.name, d.amount, d.series_id, d.done, d.tentative, d.source, d.ext_ref, d.link_id, d.note, d.deleted_at
       FROM deleted_entries d
       WHERE d.kind = 'plan' AND d.date >= date('now', '-62 days') AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = d.id)
         AND d.rowid = (SELECT max(x.rowid) FROM deleted_entries x WHERE x.id = d.id)
       ORDER BY d.date LIMIT 2000`,
    ),
    env.DB.prepare('SELECT ym, plan_in, plan_out, offer_in, offer_out, act_in, act_out, closed, computed_at FROM month_stats ORDER BY ym'),
    // partnerek banki (számlázási) nevei kategóriánként
    env.DB.prepare(
      `SELECT leaf_id, partner, count(*) AS n, max(date) AS last FROM bank_tx
       WHERE leaf_id IS NOT NULL AND partner <> '' AND status = 'approved' GROUP BY leaf_id, partner`,
    ),
    // elvesztett (törölt) ajánlatok – a megvalósulási arányhoz
    env.DB.prepare(
      `SELECT d.id, d.name, d.leaf_id, d.amount, d.date, d.series_id, d.deleted_at, d.offer_at FROM deleted_entries d
       WHERE d.rejected = 1 AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = d.id)
         AND d.rowid = (SELECT max(x.rowid) FROM deleted_entries x WHERE x.id = d.id)
       ORDER BY d.deleted_at DESC LIMIT 300`,
    ),
    // NAV bejövő számlák (terv nélküliek mind, a többi az elmúlt fél évből)
    env.DB.prepare(
      `SELECT id, invoice_number, operation, partner_tax, partner_name, issue_date, payment_date, payment_method, gross, leaf_id, plan_id, actual_id, status, created_at
       FROM nav_invoices WHERE status = 'new' OR issue_date >= date('now', '-200 days') ORDER BY issue_date DESC LIMIT 1000`,
    ),
    env.DB.prepare('SELECT key, name, kind, aliases, tax_number, note, updated_at FROM partners'),
    env.DB.prepare('SELECT key, name, cost_leaf_id, sheet_url FROM employees ORDER BY name'),
    env.DB.prepare('SELECT employee, ym, project, tag, minutes, eur FROM worktime ORDER BY ym'),
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
    deleted: deleted.results as any,
    monthStats: monthStats.results as any,
    partnerNames: partnerNames.results as any,
    lostOffers: lostOffers.results as any,
    navInvoices: navInvoices.results as any,
    partners: (partners.results as any[]).map((p) => ({ ...p, aliases: JSON.parse(p.aliases || '[]') })),
    employees: employees.results as any,
    worktime: worktime.results as any,
    integrations: { billingo: !!env.BILLINGO_API_KEY, enableBanking: !!(env.EB_APP_ID && env.EB_PRIVATE_KEY), nav: navEnabled(env) },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanEntry(e: Entry): Entry {
  const ent = cleanEntryRaw(e);
  if (ent.kind !== 'plan') return ent;
  // ismétlődő tétel (havidíj, munkabér, bérleti díj…): a név a hónappal („Munkabér – 2026. október”); a hónap (period) rögzül,
  // így a fizetés napja szabadon mozgatható, a név (melyik hónapé) marad
  const ym = ent.period || ent.date.slice(0, 7);
  const recurring = !!ent.series_id || MONTHLY_RX.test(ent.name);
  const name = withMonth(ent.name, ym, recurring);
  return name !== ent.name || (recurring && !ent.period) ? { ...ent, name: name.slice(0, 200), period: ym } : ent;
}

function cleanEntryRaw(e: Entry): Entry {
  if (!e || typeof e.id !== 'string' || !/^[\w:-]{1,80}$/.test(e.id)) throw new HttpError(400, 'Hibás tétel azonosító.');
  if (e.kind !== 'actual' && e.kind !== 'plan') throw new HttpError(400, 'Hibás tétel típus.');
  if (!DATE_RE.test(e.date)) throw new HttpError(400, 'Hibás dátum.');
  const amount = Number(e.amount);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 1e12) throw new HttpError(400, 'Hibás összeg.');
  return {
    ...e,
    amount,
    name: String(e.name || '').slice(0, 200),
    note: e.note ? String(e.note).slice(0, 1000) : null,
    done: e.done ? 1 : 0,
    tentative: e.tentative ? 1 : 0,
    period: typeof e.period === 'string' && /^\d{4}-\d{2}$/.test(e.period) ? e.period : null,
    series_id: e.series_id || null,
    link_id: e.link_id || null,
    ext_ref: e.ext_ref || null,
    source: String(e.source || 'manual').slice(0, 20),
  };
}

const ENTRY_COLS = 'id, kind, date, leaf_id, name, amount, series_id, done, tentative, offer_at, source, ext_ref, link_id, note, updated_at, updated_by';

export async function applyBatch(env: Env, b: EntryBatch, userId: number) {
  const t = now();
  const P = await hasPeriod(env);
  const stmts: D1PreparedStatement[] = [];
  const entryIds = [...new Set([...(b.upsert || []).map((e) => e.id), ...(b.delete || [])])];
  const seriesIds = [...new Set([...(b.series || []).map((s) => s.id), ...(b.deleteSeries || [])])];
  for (const id of entryIds) {
    const version = b.expected?.[id];
    if (version !== null && (!Number.isSafeInteger(version) || Number(version) < 0)) throw new HttpError(409, 'Hiányzó tételverzió. Frissítsd az oldalt.');
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mutation_guard (ok)
      SELECT CASE WHEN (SELECT updated_at FROM entries WHERE id = ?) IS ? THEN 1 ELSE 0 END`,
      ).bind(id, version),
    );
  }
  for (const id of seriesIds) {
    const version = b.expectedSeries?.[id];
    if (version !== null && typeof version !== 'string') throw new HttpError(409, 'Hiányzó sorozatverzió. Frissítsd az oldalt.');
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mutation_guard (ok)
      SELECT CASE WHEN (SELECT json_array(leaf_id, name, rep, day) FROM series WHERE id = ?) IS ? THEN 1 ELSE 0 END`,
      ).bind(id, version),
    );
  }
  for (const s of b.series || []) {
    const rep = ['once', 'monthly', 'quarterly', 'yearly'].includes(s.rep) ? s.rep : 'once';
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
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, was_offer, offer_at, ${P ? 'period, ' : ''}source, ext_ref, link_id, note, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${P ? '?, ' : ''}?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, date = excluded.date, leaf_id = excluded.leaf_id, name = excluded.name,
           amount = excluded.amount, series_id = excluded.series_id, done = excluded.done, tentative = excluded.tentative,
           was_offer = MAX(entries.was_offer, excluded.was_offer), offer_at = COALESCE(entries.offer_at, excluded.offer_at),
           accepted_at = CASE WHEN excluded.tentative = 1 AND excluded.done = 0 THEN NULL
             WHEN entries.accepted_at IS NULL AND entries.tentative = 1 AND (excluded.tentative = 0 OR excluded.done = 1)
             THEN excluded.updated_at ELSE entries.accepted_at END,
           ${P ? 'period = excluded.period, ' : ''}source = excluded.source, ext_ref = excluded.ext_ref, link_id = excluded.link_id, note = excluded.note,
           updated_at = MAX(entries.updated_at + 1, excluded.updated_at), updated_by = excluded.updated_by`,
      ).bind(
        e.id,
        e.kind,
        e.date,
        e.leaf_id,
        e.name,
        e.amount,
        e.series_id,
        e.done,
        e.tentative,
        e.tentative || (raw as any).was_offer ? 1 : 0,
        e.tentative ? t : null,
        ...(P ? [e.period ?? null] : []),
        e.source,
        e.ext_ref,
        e.link_id,
        e.note,
        t,
        userId,
      ),
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
  for (const id of b.delete || []) {
    // törlés előtt a kukába (visszakereshető, visszaállítható)
    stmts.push(
      env.DB.prepare(
        `INSERT INTO deleted_entries (${ENTRY_COLS}, deleted_at, deleted_by, rejected) SELECT ${ENTRY_COLS}, ?, ?, ? FROM entries
         WHERE id = ? AND NOT (? = 1 AND updated_by = ? AND updated_at > ?)`,
      ).bind(t, userId, b.rejected ? 1 : 0, String(id), b.purge ? 1 : 0, userId, t - 15 * 60_000),
    );
    stmts.push(env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(String(id)));
  }
  for (const id of b.deleteSeries || []) stmts.push(env.DB.prepare('DELETE FROM series WHERE id = ?').bind(String(id)));
  if (stmts.length > 2000) throw new HttpError(413, 'Túl sok módosítás egyszerre.');
  stmts.push(env.DB.prepare('DELETE FROM mutation_guard'));
  const versionIds = (b.upsert || []).map((e) => e.id);
  for (const id of versionIds) stmts.push(env.DB.prepare('SELECT id, updated_at FROM entries WHERE id = ?').bind(id));
  let results: D1Result[];
  // D1 batch is a single transaction: any stale version rolls back every statement.
  try {
    results = await env.DB.batch(stmts);
  } catch (e: any) {
    if (String(e?.message).includes('entry_version_conflict'))
      throw new HttpError(409, 'Ezt a tételt vagy sorozatot közben módosították. Frissítsd az adatokat, és ellenőrizd a változtatást.');
    throw e;
  }
  const versions = Object.fromEntries(results.slice(results.length - versionIds.length).flatMap((r) => r.results.map((e: any) => [e.id, e.updated_at])));
  return { changes: stmts.length, versions: versionIds.length ? versions : {} };
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
    // naplóhoz: a módosítás előtti állapot (visszavonáshoz)
    const touched = [...(b.upsert || []).map((e) => String(e.id)), ...(b.delete || []).map(String)];
    const before = await rowsById(env, 'entries', touched);
    const seriesIds = [...(b.series || []).map((x) => String(x.id)), ...(b.deleteSeries || []).map(String)];
    const seriesBefore = await rowsById(env, 'series', seriesIds);
    const n = await applyBatch(env, b, u.id);
    const after = (b.upsert || []).map((e) => e as unknown as Record<string, unknown>);
    const { items, counts } = describeEntries(before, after, (b.delete || []).map(String));
    const had = new Set(before.map((r) => String(r.id)));
    const sHad = new Set(seriesBefore.map((r) => String(r.id)));
    const parts = [
      counts.new && `${counts.new} új`,
      counts.edit && `${counts.edit} módosítva`,
      counts.del && `${counts.del} ${b.rejected ? 'elutasítva' : 'törölve'}`,
    ].filter(Boolean);
    const label = String(b.label || '').trim();
    if (parts.length || seriesIds.length)
      await logChange(
        env,
        u.id,
        b.purge ? 'entries.undo' : 'entries',
        (label ? label + ' · ' : '') + (parts.join(', ') || 'ismétlődés módosítva'),
        [...before, ...after].map((r) => String(r.leaf_id || '')).filter(Boolean),
        {
          type: 'entries',
          expected: Object.fromEntries(touched.map((id) => [id, n.versions[id] ?? null])),
          expectedSeries: Object.fromEntries(
            seriesIds.map((id) => {
              const s = b.series?.find((x) => x.id === id);
              return [id, s ? JSON.stringify([s.leaf_id, s.name, s.rep, s.day]) : null];
            }),
          ),
          before,
          created: (b.upsert || []).map((e) => String(e.id)).filter((id) => !had.has(id)),
          seriesBefore,
          seriesCreated: (b.series || []).map((x) => String(x.id)).filter((id) => !sHad.has(id)),
        },
        items,
      );
    return json({ ok: true, ...n });
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
    const prev = await env.DB.prepare(
      'SELECT l.label, l.archived, l.group_id, l.pay_rule, l.pay_days, g.label AS glabel FROM leaves l LEFT JOIN groups g ON g.id = l.group_id WHERE l.id = ?',
    )
      .bind(lm[1])
      .first<Record<string, unknown>>();
    if (!prev) throw new HttpError(404, 'Ismeretlen partner.');
    if (b.label !== undefined) await env.DB.prepare('UPDATE leaves SET label = ? WHERE id = ?').bind(String(b.label).trim().slice(0, 80), lm[1]).run();
    if (b.archived !== undefined)
      await env.DB.prepare('UPDATE leaves SET archived = ? WHERE id = ?')
        .bind(b.archived ? 1 : 0, lm[1])
        .run();
    if (b.group_id !== undefined) await env.DB.prepare('UPDATE leaves SET group_id = ? WHERE id = ?').bind(String(b.group_id), lm[1]).run();
    if (b.pay_rule !== undefined) await env.DB.prepare('UPDATE leaves SET pay_rule = ? WHERE id = ?').bind(cleanPayRule(b.pay_rule), lm[1]).run();
    if (b.pay_days !== undefined) {
      const n = b.pay_days === null || b.pay_days === '' ? null : Math.min(180, Math.max(0, Math.round(Number(b.pay_days)) || 0));
      await env.DB.prepare('UPDATE leaves SET pay_days = ? WHERE id = ?').bind(n, lm[1]).run();
    }
    if (b.group_id !== undefined || b.pay_rule !== undefined || b.pay_days !== undefined) await audit(env, u.id, 'leaf_updated', { id: lm[1], ...b });
    const keys = ['label', 'archived', 'group_id', 'pay_rule', 'pay_days'].filter((k) => b[k] !== undefined);
    if (keys.length) {
      const what: string[] = [];
      if (b.label !== undefined && String(b.label).trim() !== prev.label) what.push(`átnevezve: ${prev.label} → ${String(b.label).trim()}`);
      if (b.group_id !== undefined && b.group_id !== prev.group_id) {
        const g = await env.DB.prepare('SELECT label FROM groups WHERE id = ?').bind(String(b.group_id)).first<{ label: string }>();
        what.push(`mappa: ${prev.glabel} → ${g?.label || b.group_id}`);
      }
      if (b.archived !== undefined && (b.archived ? 1 : 0) !== prev.archived) what.push(b.archived ? 'megszüntetve (archiválva)' : 'újra aktív');
      if (b.pay_rule !== undefined || b.pay_days !== undefined) what.push('fizetési szabály módosítva');
      if (what.length)
        await logChange(env, u.id, 'leaf.update', `${prev.label}: ${what.join(', ')}`, [lm[1]], {
          type: 'leaf.update',
          id: lm[1],
          before: Object.fromEntries(keys.map((k) => [k, prev[k] ?? null])),
        });
    }
    return json({ ok: true });
  }
  const gm = path.match(/^\/api\/groups\/([\w-]+)$/);
  if (gm && req.method === 'PATCH') {
    requireRole(u, 'admin', 'member');
    const b = await readJson(req);
    if (b.pay_rule !== undefined) await env.DB.prepare('UPDATE groups SET pay_rule = ? WHERE id = ?').bind(cleanPayRule(b.pay_rule), gm[1]).run();
    if (b.label !== undefined && String(b.label).trim())
      await env.DB.prepare('UPDATE groups SET label = ? WHERE id = ?').bind(String(b.label).trim().slice(0, 80), gm[1]).run();
    await audit(env, u.id, 'group_updated', { id: gm[1], ...b });
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

  // munkatárs: név + a költségét hordozó kiadási alkategória
  if (path === '/api/employees' && req.method === 'PUT') {
    requireRole(u, 'admin');
    const b = await readJson<{ key?: string; name: string; cost_leaf_id?: string | null; sheet_url?: string | null }>(req);
    const name = String(b.name || '')
      .trim()
      .slice(0, 100);
    if (!name) throw new HttpError(400, 'Hiányzó név.');
    const key = String(b.key || partnerIdOf(name)).slice(0, 80);
    // a link csak akkor változik, ha a kérés hozza (a régi hívások nem törlik)
    const url = b.sheet_url === undefined ? undefined : String(b.sheet_url || '').trim();
    if (url && !sheetIdOf(url)) throw new HttpError(400, 'Google-táblázat linket adj meg (https://docs.google.com/spreadsheets/d/…).');
    await env.DB.prepare(
      `INSERT INTO employees (key, name, cost_leaf_id, sheet_url, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, cost_leaf_id = excluded.cost_leaf_id, sheet_url = CASE WHEN ? THEN excluded.sheet_url ELSE employees.sheet_url END,
         updated_at = excluded.updated_at`,
    )
      .bind(key, name, b.cost_leaf_id || null, url || null, now(), url === undefined ? 0 : 1)
      .run();
    return json({ ok: true, key });
  }
  // az elszámoló Google-tábla letöltése a linkről (xlsx, base64) – a böngésző olvassa be, mint a feltöltött fájlt
  if (path === '/api/worktime/fetch' && req.method === 'POST') {
    requireRole(u, 'admin');
    const b = await readJson<{ employee: string }>(req);
    const row = await env.DB.prepare('SELECT name, sheet_url FROM employees WHERE key = ?')
      .bind(String(b.employee || ''))
      .first<{ name: string; sheet_url: string | null }>();
    const id = sheetIdOf(row?.sheet_url);
    if (!row || !id) throw new HttpError(400, 'Ehhez a partnerhez nincs megadva elszámoló tábla link.');
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('spreadsheetml'))
      throw new HttpError(
        400,
        `${row.name}: nem érem el a táblát. A Google-táblázatban: Megosztás → Általános hozzáférés → „Bárki, akinek megvan a link” – Megtekintő.`,
      );
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return json({ ok: true, xlsx: btoa(bin) });
  }
  // munkaidő import: a feltöltött hónapok sorai felülírják az adott munkatárs korábbi sorait azokra a hónapokra
  if (path === '/api/worktime/import' && req.method === 'POST') {
    requireRole(u, 'admin');
    const b = await readJson<{ employee: string; rows: { ym: string; project: string; tag: string; minutes: number; eur?: number }[] }>(req);
    const emp = String(b.employee || '').slice(0, 80);
    if (!emp || !(await env.DB.prepare('SELECT 1 FROM employees WHERE key = ?').bind(emp).first())) throw new HttpError(400, 'Ismeretlen munkatárs.');
    const rows = (b.rows || []).filter((r) => /^\d{4}-\d{2}$/.test(r.ym) && r.project && Number(r.minutes) > 0).slice(0, 5000);
    const months = [...new Set(rows.map((r) => r.ym))];
    const stmts = months.map((m) => env.DB.prepare('DELETE FROM worktime WHERE employee = ? AND ym = ?').bind(emp, m));
    for (const r of rows)
      stmts.push(
        env.DB.prepare(
          'INSERT INTO worktime (employee, ym, project, tag, minutes, eur) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET minutes = worktime.minutes + excluded.minutes, eur = worktime.eur + excluded.eur',
        ).bind(
          emp,
          r.ym,
          String(r.project).slice(0, 120),
          String(r.tag || '').slice(0, 60),
          Math.round(Number(r.minutes)),
          Math.max(0, Math.round((Number(r.eur) || 0) * 100) / 100),
        ),
      );
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    await audit(env, u.id, 'worktime_import', { employee: emp, months: months.length, rows: rows.length });
    return json({ ok: true, months: months.length, rows: rows.length });
  }
  if (path === '/api/settings' && req.method === 'PUT') {
    requireRole(u, 'admin');
    const b = await readJson<Record<string, unknown>>(req);
    const allowed = [
      'opening_balance',
      'billingo_leaf_default',
      'profit_target',
      'default_pay_days',
      'default_oneoff_days',
      'default_pay_days_in',
      'default_pay_days_out',
      'default_oneoff_days_in',
      'default_oneoff_days_out',
    ];
    for (const k of allowed) if (k in b) await setSetting(env, k, b[k] == null ? null : String(b[k]).slice(0, 200));
    await audit(env, u.id, 'settings', b);
    return json({ ok: true });
  }

  if (path === '/api/stats/refresh' && req.method === 'POST') {
    // kézi frissítés: a folyó hónap (és a még nem lezárt múltbeliek); `all` (admin): a lezártakat is újraszámolja
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ all?: boolean }>(req).catch(() => ({}) as { all?: boolean });
    if (b.all) requireRole(u, 'admin');
    const r = await refreshMonthStats(env, u.id, !!b.all);
    await audit(env, u.id, 'stats.refresh', { ...r, all: !!b.all });
    return json(r);
  }

  const mg = path.match(/^\/api\/leaves\/([\w-]+)\/merge$/);
  if (mg && req.method === 'POST') {
    // partner összevonása: a forrás minden tétele, sorozata, banki tétele és szabálya a célhoz kerül
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ into: string }>(req);
    const from = mg[1],
      into = String(b.into || '');
    if (!into || into === from) throw new HttpError(400, 'Válassz másik partnert.');
    const [f, t] = await Promise.all([
      env.DB.prepare('SELECT l.id, l.label, g.section FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.id = ?')
        .bind(from)
        .first<{ id: string; label: string; section: string }>(),
      env.DB.prepare('SELECT l.id, l.label, g.section FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.id = ?')
        .bind(into)
        .first<{ id: string; label: string; section: string }>(),
    ]);
    if (!f || !t) throw new HttpError(404, 'Ismeretlen partner.');
    if (f.section !== t.section) {
      // bevétel ↔ kiadás: nem mozgatható, csak azonos névre hozzuk (egy partnerként látszik a statisztikában)
      await env.DB.prepare('UPDATE leaves SET label = ? WHERE id = ?').bind(t.label, f.id).run();
      await audit(env, u.id, 'leaf.link', { from: f, into: t });
      return json({ ok: true, linked: true });
    }
    // naplóhoz: mi került át (visszavonáshoz)
    const ids = async (sql: string) => (await env.DB.prepare(sql).bind(f.id).all<{ k: string | number }>()).results.map((r) => r.k);
    const moved = {
      entries: (await ids('SELECT id AS k FROM entries WHERE leaf_id = ?')) as string[],
      series: (await ids('SELECT id AS k FROM series WHERE leaf_id = ?')) as string[],
      bank_tx: (await ids('SELECT id AS k FROM bank_tx WHERE leaf_id = ?')) as string[],
      deleted: (await ids('SELECT rowid AS k FROM deleted_entries WHERE leaf_id = ?')) as number[],
      match_rules: (await ids('SELECT id AS k FROM match_rules WHERE leaf_id = ?')) as string[],
      partner_rules: (await ids('SELECT pattern AS k FROM partner_rules WHERE leaf_id = ?')) as string[],
    };
    const ruleKey = partnerKey(f.label);
    const prevRule = await env.DB.prepare('SELECT leaf_id FROM partner_rules WHERE pattern = ?').bind(ruleKey).first<{ leaf_id: string }>();
    // ajánlat-mappában lévő sorba vont projekt: a cél a projekt mappájába kerül (különben eltűnne a projektek közül)
    const grp = await env.DB.prepare('SELECT l.id, l.group_id, g.label FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.id IN (?, ?)')
      .bind(f.id, t.id)
      .all<{ id: string; group_id: string; label: string }>();
    const fg = grp.results.find((r) => r.id === f.id),
      tg = grp.results.find((r) => r.id === t.id);
    const OFFER = /aj[áa]nlat/i;
    const moveInto = fg && tg && OFFER.test(tg.label) && !OFFER.test(fg.label) ? fg.group_id : null;
    await env.DB.batch([
      ...(moveInto ? [env.DB.prepare('UPDATE leaves SET group_id = ? WHERE id = ?').bind(moveInto, t.id)] : []),
      env.DB.prepare('UPDATE entries SET leaf_id = ? WHERE leaf_id = ?').bind(t.id, f.id),
      env.DB.prepare('UPDATE series SET leaf_id = ? WHERE leaf_id = ?').bind(t.id, f.id),
      env.DB.prepare('UPDATE bank_tx SET leaf_id = ? WHERE leaf_id = ?').bind(t.id, f.id),
      env.DB.prepare('UPDATE deleted_entries SET leaf_id = ? WHERE leaf_id = ?').bind(t.id, f.id),
      env.DB.prepare('UPDATE match_rules SET leaf_id = ? WHERE leaf_id = ?').bind(t.id, f.id),
      env.DB.prepare('UPDATE partner_rules SET leaf_id = ? WHERE leaf_id = ?').bind(t.id, f.id),
      // a régi név is ide párosul a jövőben (Billingo / bank)
      env.DB.prepare(
        'INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(pattern) DO UPDATE SET leaf_id = excluded.leaf_id, updated_at = excluded.updated_at',
      ).bind(partnerKey(f.label), t.id, now()),
      env.DB.prepare('UPDATE leaves SET archived = 1 WHERE id = ?').bind(f.id),
    ]);
    await audit(env, u.id, 'leaf.merge', { from: f, into: t });
    await logChange(
      env,
      u.id,
      'leaf.merge',
      `Összevonás: ${f.label} → ${t.label} (${moved.entries.length} tétel)${moveInto ? ` · ${t.label} a(z) ${fg!.label} mappába került` : ''}`,
      [f.id, t.id],
      {
        type: 'leaf.merge',
        from: f.id,
        into: t.id,
        intoGroupBefore: moveInto ? tg!.group_id : undefined,
        moved,
        rule: { pattern: ruleKey, prev: prevRule?.leaf_id ?? null },
      },
    );
    return json({ ok: true, moved: moveInto ? fg!.label : null });
  }

  if (path === '/api/trash' && req.method === 'GET') {
    // törölt tételek keresése (név, kategória, összeg, ki törölte)
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    const offers = url.searchParams.get('offers') === '1';
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const digits = q.replace(/\D/g, '');
    const r = await env.DB.prepare(
      `SELECT d.rowid AS rid, d.*, l.label AS leaf_label, u.name AS deleted_by_name
       FROM deleted_entries d LEFT JOIN leaves l ON l.id = d.leaf_id LEFT JOIN users u ON u.id = d.deleted_by
       WHERE (? = '' OR lower(d.name) LIKE ? OR lower(COALESCE(d.note, '')) LIKE ? OR lower(COALESCE(l.label, '')) LIKE ?
              OR (? <> '' AND CAST(abs(d.amount) AS TEXT) LIKE ?))
         AND (? = 0 OR d.tentative = 1)
         AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.id = d.id)
       ORDER BY d.deleted_at DESC, d.date LIMIT 2000`,
    )
      .bind(q, like, like, like, digits, '%' + digits + '%', offers ? 1 : 0)
      .all();
    return json({ items: r.results });
  }

  if (path === '/api/trash/restore' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ rids: number[] }>(req);
    const rids = (Array.isArray(b.rids) ? b.rids : []).map(Number).filter(Number.isFinite).slice(0, 500);
    const restored = rids.length
      ? (
          await env.DB.prepare(`SELECT id, name, leaf_id, date, amount, kind FROM deleted_entries WHERE rowid IN (${rids.map(() => '?').join(',')})`)
            .bind(...rids)
            .all<Record<string, unknown>>()
        ).results
      : [];
    const stmts: D1PreparedStatement[] = [];
    for (const rid of rids) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO entries (${ENTRY_COLS}) SELECT id, kind, date, leaf_id, name, amount, series_id, done, tentative, offer_at, source, ext_ref, link_id, note, ?, ?
           FROM deleted_entries WHERE rowid = ? AND leaf_id IN (SELECT id FROM leaves) ON CONFLICT(id) DO NOTHING`,
        ).bind(now(), u.id, rid),
      );
      stmts.push(env.DB.prepare('DELETE FROM deleted_entries WHERE rowid = ? AND id IN (SELECT id FROM entries)').bind(rid));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    await audit(env, u.id, 'trash.restore', { rids });
    const back = restored.filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
    if (back.length)
      await logChange(
        env,
        u.id,
        'trash.restore',
        `Kukából visszaállítva · ${back.length} tétel`,
        back.map((r) => String(r.leaf_id)),
        { type: 'entries', before: [], created: back.map((r) => String(r.id)), seriesBefore: [], seriesCreated: [] },
        back.map((r) => ({
          op: 'new' as const,
          name: String(r.name || ''),
          leaf: String(r.leaf_id),
          date: String(r.date),
          amount: Number(r.amount),
          kind: String(r.kind),
        })),
      );
    return json({ ok: true });
  }

  if (path === '/api/flags/ack' && req.method === 'POST') {
    // riasztás „rendben” jelölése (közös minden felhasználónak) – vagy visszavonása
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ ids: string[]; undo?: boolean }>(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => String(x).slice(0, 120)).slice(0, 200);
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'flags_ack'").first<{ value: string }>();
    let cur: string[] = [];
    try {
      cur = JSON.parse(row?.value || '[]');
    } catch {}
    const set = new Set(cur);
    ids.forEach((id) => (b.undo ? set.delete(id) : set.add(id)));
    await setSetting(env, 'flags_ack', JSON.stringify([...set].slice(-2000)));
    await audit(env, u.id, b.undo ? 'flags.unack' : 'flags.ack', { ids });
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
