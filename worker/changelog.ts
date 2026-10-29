// Változásnapló: ki, mikor, mit módosított (tételek, partner-összevonás, partner módosítás, visszaállítás) – visszavonható.
// A visszavonás a rögzített korábbi állapotot állítja vissza; törölni semmit sem töröl véglegesen (a tételek a kukába kerülnek).
import { requireRole, type User } from './auth';
import { Env, HttpError, json, now, readJson } from './util';

type Row = Record<string, unknown>;

export interface ChangeItem {
  op: 'new' | 'edit' | 'del';
  name: string;
  leaf: string;
  date: string;
  amount: number;
  kind: string;
  /** módosításnál a korábbi értékek (csak ami változott) */
  prev?: Partial<{ amount: number; date: string; name: string; leaf: string; done: number; tentative: number; kind: string }>;
}

export type Undo =
  | { type: 'entries'; before: Row[]; created: string[]; seriesBefore: Row[]; seriesCreated: string[] }
  | {
      type: 'leaf.merge';
      from: string;
      into: string;
      intoGroupBefore?: string;
      moved: { entries: string[]; series: string[]; bank_tx: string[]; deleted: number[]; match_rules: string[]; partner_rules: string[] };
      rule: { pattern: string; prev: string | null };
    }
  | { type: 'leaf.update'; id: string; before: Row };

const chunks = <T>(a: T[], n = 90) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Sorok lekérése azonosító szerint (90-es csomagokban – a D1 paraméterkorlátja miatt). */
export async function rowsById(env: Env, table: 'entries' | 'series', ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const c of chunks([...new Set(ids)]))
    out.push(...(await env.DB.prepare(`SELECT * FROM ${table} WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c).all<Row>()).results);
  return out;
}

const MAX_UNDO_BYTES = 800_000;

export async function logChange(
  env: Env,
  userId: number | null,
  action: string,
  summary: string,
  leafIds: string[],
  undo: Undo | null,
  items?: ChangeItem[],
) {
  let u = undo ? JSON.stringify(undo) : null;
  if (u && u.length > MAX_UNDO_BYTES) u = null; // túl nagy (pl. tömeges import) – naplózva, de nem visszavonható
  await env.DB.prepare('INSERT INTO change_log (ts, user_id, action, summary, leaf_ids, items, undo) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(now(), userId, action, summary.slice(0, 500), leafIds.length ? ',' + [...new Set(leafIds)].join(',') + ',' : '', items ? JSON.stringify(items.slice(0, 60)) : null, u)
    .run();
}

/** Tétel-módosítás összefoglalója és tételei a korábbi és az új állapotból. */
export function describeEntries(before: Row[], after: Row[], deleted: string[]): { items: ChangeItem[]; counts: { new: number; edit: number; del: number } } {
  const bMap = new Map(before.map((r) => [String(r.id), r]));
  const items: ChangeItem[] = [];
  const counts = { new: 0, edit: 0, del: 0 };
  const base = (r: Row) => ({ name: String(r.name || ''), leaf: String(r.leaf_id || ''), date: String(r.date || ''), amount: Number(r.amount) || 0, kind: String(r.kind || '') });
  for (const a of after) {
    const b = bMap.get(String(a.id));
    if (!b) {
      counts.new++;
      items.push({ op: 'new', ...base(a) });
      continue;
    }
    const prev: ChangeItem['prev'] = {};
    if (Number(b.amount) !== Number(a.amount)) prev.amount = Number(b.amount);
    if (b.date !== a.date) prev.date = String(b.date);
    if ((b.name || '') !== (a.name || '')) prev.name = String(b.name || '');
    if (b.leaf_id !== a.leaf_id) prev.leaf = String(b.leaf_id);
    if (Number(b.done) !== Number(a.done)) prev.done = Number(b.done);
    if (Number(b.tentative) !== Number(a.tentative)) prev.tentative = Number(b.tentative);
    if (b.kind !== a.kind) prev.kind = String(b.kind);
    counts.edit++;
    items.push({ op: 'edit', ...base(a), prev });
  }
  for (const id of deleted) {
    const b = bMap.get(id);
    if (!b) continue;
    counts.del++;
    items.push({ op: 'del', ...base(b) });
  }
  return { items, counts };
}

/** Egy sor visszaírása (upsert) a megadott oszlopokkal – csak a tábla létező oszlopai. */
async function upsertStmts(env: Env, table: 'entries' | 'series', rows: Row[]): Promise<D1PreparedStatement[]> {
  if (!rows.length) return [];
  const cols = new Set((await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name));
  return rows.map((r) => {
    const keys = Object.keys(r).filter((k) => cols.has(k) && /^\w+$/.test(k));
    return env.DB.prepare(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${keys.filter((k) => k !== 'id').map((k) => `${k} = excluded.${k}`).join(', ')}`,
    ).bind(...keys.map((k) => (r[k] === undefined ? null : r[k])));
  });
}

const ENTRY_COLS = 'id, kind, date, leaf_id, name, amount, series_id, done, tentative, offer_at, source, ext_ref, link_id, note, updated_at, updated_by';

async function undoChange(env: Env, row: { id: number; ts: number; undo: string }, u: User, force: boolean): Promise<string> {
  const undo = JSON.parse(row.undo) as Undo;
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  if (undo.type === 'entries') {
    const ids = [...undo.before.map((r) => String(r.id)), ...undo.created];
    // ha valaki azóta újra módosította ezeket a tételeket, előbb rákérdezünk
    if (!force) {
      let later = 0;
      for (const c of chunks(ids))
        later += (
          await env.DB.prepare(`SELECT count(*) AS n FROM entries WHERE id IN (${c.map(() => '?').join(',')}) AND updated_at > ?`)
            .bind(...c, row.ts + 2000)
            .first<{ n: number }>()
        )?.n || 0;
      if (later) throw new HttpError(409, `${later} érintett tételt azóta újra módosítottak – a visszavonás felülírja ezeket a későbbi módosításokat.`);
    }
    // az akkor létrehozott tételek a kukába kerülnek
    for (const id of undo.created) {
      stmts.push(
        env.DB.prepare(`INSERT INTO deleted_entries (${ENTRY_COLS}, deleted_at, deleted_by) SELECT ${ENTRY_COLS}, ?, ? FROM entries WHERE id = ?`).bind(t, u.id, id),
        env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id),
      );
    }
    // a korábbi állapot vissza; az akkor törölt tételek kukás másolata kikerül
    stmts.push(...(await upsertStmts(env, 'series', undo.seriesBefore)));
    stmts.push(...(await upsertStmts(env, 'entries', undo.before.map((r) => ({ ...r, updated_at: t, updated_by: u.id })))));
    for (const r of undo.before) stmts.push(env.DB.prepare('DELETE FROM deleted_entries WHERE id = ? AND deleted_at >= ? AND deleted_at <= ?').bind(r.id, row.ts - 60_000, row.ts + 60_000));
    for (const id of undo.seriesCreated) stmts.push(env.DB.prepare('DELETE FROM series WHERE id = ? AND NOT EXISTS (SELECT 1 FROM entries WHERE series_id = ?)').bind(id, id));
  } else if (undo.type === 'leaf.merge') {
    const { from, moved } = undo;
    const back = (table: string, col: string, ids: (string | number)[]) =>
      chunks(ids).map((c) => env.DB.prepare(`UPDATE ${table} SET leaf_id = ? WHERE ${col} IN (${c.map(() => '?').join(',')})`).bind(from, ...c));
    stmts.push(
      ...back('entries', 'id', moved.entries),
      ...back('series', 'id', moved.series),
      ...back('bank_tx', 'id', moved.bank_tx),
      ...back('deleted_entries', 'rowid', moved.deleted),
      ...back('match_rules', 'id', moved.match_rules),
      ...back('partner_rules', 'pattern', moved.partner_rules),
      env.DB.prepare('UPDATE leaves SET archived = 0 WHERE id = ?').bind(from),
    );
    if (undo.rule.prev) stmts.push(env.DB.prepare('UPDATE partner_rules SET leaf_id = ? WHERE pattern = ?').bind(undo.rule.prev, undo.rule.pattern));
    else stmts.push(env.DB.prepare('DELETE FROM partner_rules WHERE pattern = ? AND leaf_id = ?').bind(undo.rule.pattern, undo.into));
    if (undo.intoGroupBefore) stmts.push(env.DB.prepare('UPDATE leaves SET group_id = ? WHERE id = ?').bind(undo.intoGroupBefore, undo.into));
  } else if (undo.type === 'leaf.update') {
    const allowed = ['label', 'archived', 'group_id', 'pay_rule', 'pay_days'];
    const keys = Object.keys(undo.before).filter((k) => allowed.includes(k));
    if (keys.length)
      stmts.push(env.DB.prepare(`UPDATE leaves SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => undo.before[k] ?? null), undo.id));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return undo.type;
}

export async function handleChangelog(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (path === '/api/changelog' && req.method === 'GET') {
    const url = new URL(req.url);
    const from = Number(url.searchParams.get('from')) || 0;
    const to = Number(url.searchParams.get('to')) || 8.64e15;
    const sys = url.searchParams.get('sys') === '1';
    const r = await env.DB.prepare(
      `SELECT c.id, c.ts, c.user_id, uu.name AS user_name, c.action, c.summary, c.leaf_ids, c.items, c.undo IS NOT NULL AS undoable,
              c.undone_at, ub.name AS undone_by_name, c.undo_of
       FROM change_log c LEFT JOIN users uu ON uu.id = c.user_id LEFT JOIN users ub ON ub.id = c.undone_by
       WHERE c.ts BETWEEN ? AND ? ORDER BY c.ts DESC LIMIT 2000`,
    )
      .bind(from, to)
      .all();
    // rendszeresemények (belépés, szinkron, import, szabályok…) – csak megtekintésre
    const s = sys
      ? (
          await env.DB.prepare(
            `SELECT a.id, a.ts, a.user_id, uu.name AS user_name, a.action, a.detail FROM audit_log a LEFT JOIN users uu ON uu.id = a.user_id
             WHERE a.ts BETWEEN ? AND ? AND a.action NOT IN ('leaf.merge', 'leaf_updated', 'trash.restore') ORDER BY a.ts DESC LIMIT 1000`,
          )
            .bind(from, to)
            .all()
        ).results
      : [];
    return json({ items: r.results, system: s });
  }
  const um = path.match(/^\/api\/changelog\/(\d+)\/undo$/);
  if (um && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ force?: boolean }>(req).catch(() => ({}) as { force?: boolean });
    const row = await env.DB.prepare('SELECT id, ts, summary, leaf_ids, undo, undone_at FROM change_log WHERE id = ?')
      .bind(Number(um[1]))
      .first<{ id: number; ts: number; summary: string; leaf_ids: string; undo: string | null; undone_at: number | null }>();
    if (!row) throw new HttpError(404, 'Nincs ilyen naplóbejegyzés.');
    if (!row.undo) throw new HttpError(400, 'Ez a lépés nem vonható vissza.');
    if (row.undone_at) throw new HttpError(400, 'Ezt már visszavonták.');
    await undoChange(env, { id: row.id, ts: row.ts, undo: row.undo }, u, !!b.force);
    const t = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE change_log SET undone_at = ?, undone_by = ? WHERE id = ?').bind(t, u.id, row.id),
      env.DB.prepare('INSERT INTO change_log (ts, user_id, action, summary, leaf_ids, undo_of) VALUES (?, ?, ?, ?, ?, ?)').bind(
        t,
        u.id,
        'undo',
        'Visszavonva: ' + row.summary,
        row.leaf_ids,
        row.id,
      ),
    ]);
    return json({ ok: true });
  }
  return null;
}
