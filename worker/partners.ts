// Partnertörzs: a partner adatlapjának mentése (név, típus, alternatív nevek, adószám, megjegyzés).
// Az alternatív nevek „tartalmazza” párosítási szabályokká válnak a partner összes alkategóriájára (bevételi és kiadási
// oldalon is), így a banki, NAV és Billingo tételek ezek alapján kerülnek a partnerhez (pl. „OMV 135”, „Shell 27” → Tankolás).
import { normalizeText } from '../shared/categories';
import { partnerIdOf } from '../shared/partners';
import type { Partner } from '../shared/types';
import { requireRole, type User } from './auth';
import { reapplyRules } from './bank';
import { rematchNav } from './nav';
import { Env, HttpError, audit, json, now, randomId, readJson } from './util';

const KINDS = new Set(['vevo', 'szallito', 'mindketto']);

export function cleanAliases(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const s = String(a ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const n = normalizeText(s);
    if (n.length < 2 || seen.has(n)) continue;
    seen.add(n);
    out.push(s);
    if (out.length >= 30) break;
  }
  return out;
}

export async function loadPartners(env: Env): Promise<Partner[]> {
  const r = await env.DB.prepare('SELECT key, name, kind, aliases, tax_number, note, updated_at FROM partners').all<any>();
  return r.results.map((p) => ({ ...p, aliases: JSON.parse(p.aliases || '[]') }));
}

export async function handlePartners(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  const m = path.match(/^\/api\/partners\/([^/]+)$/);
  if (!m || req.method !== 'PUT') return null;
  requireRole(u, 'admin', 'member');
  const key = decodeURIComponent(m[1]).slice(0, 120);
  const b = await readJson(req);
  const leaves = (await env.DB.prepare('SELECT id, group_id, label FROM leaves').all<{ id: string; group_id: string; label: string }>()).results.filter(
    (l) => partnerIdOf(l.label) === key,
  );
  const cur = await env.DB.prepare('SELECT * FROM partners WHERE key = ?').bind(key).first<any>();
  if (!leaves.length && !cur) throw new HttpError(404, 'Nincs ilyen partner.');
  const stmts: D1PreparedStatement[] = [];
  const t = now();

  let name: string = cur?.name || leaves[0]?.label || key;
  let newKey = key;
  if (b.name !== undefined) {
    const n = String(b.name).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!n) throw new HttpError(400, 'Adj meg nevet.');
    if (n !== name || leaves.some((l) => l.label !== n)) {
      for (const l of leaves) {
        if (l.label === n) continue;
        const clash = await env.DB.prepare('SELECT id FROM leaves WHERE group_id = ? AND label = ? AND id <> ?').bind(l.group_id, n, l.id).first();
        if (clash) throw new HttpError(409, `Ebben a projektben már van „${n}” nevű partner – előbb vond össze őket.`);
        stmts.push(env.DB.prepare('UPDATE leaves SET label = ? WHERE id = ?').bind(n, l.id));
      }
      name = n;
      newKey = partnerIdOf(n) || key;
    }
  }
  const kind = b.kind !== undefined ? (KINDS.has(String(b.kind)) ? String(b.kind) : null) : (cur?.kind ?? null);
  const aliases = b.aliases !== undefined ? cleanAliases(b.aliases) : JSON.parse(cur?.aliases || '[]');
  const tax =
    b.tax_number !== undefined
      ? String(b.tax_number || '')
          .trim()
          .slice(0, 20) || null
      : (cur?.tax_number ?? null);
  const note =
    b.note !== undefined
      ? String(b.note || '')
          .trim()
          .slice(0, 1000) || null
      : (cur?.note ?? null);

  if (newKey !== key) stmts.push(env.DB.prepare('DELETE FROM partners WHERE key = ?').bind(key));
  stmts.push(
    env.DB.prepare(
      `INSERT INTO partners (key, name, kind, aliases, tax_number, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, kind = excluded.kind, aliases = excluded.aliases, tax_number = excluded.tax_number, note = excluded.note, updated_at = excluded.updated_at`,
    ).bind(newKey, name, kind, JSON.stringify(aliases), tax, note, t),
  );

  // alternatív nevek → párosítási szabályok a partner minden alkategóriájára (a régi alias-szabályok helyett)
  const aliasChanged = b.aliases !== undefined;
  if (aliasChanged && leaves.length) {
    const ids = leaves.map((l) => l.id);
    stmts.push(env.DB.prepare(`DELETE FROM match_rules WHERE source = 'alias' AND leaf_id IN (${ids.map(() => '?').join(',')})`).bind(...ids));
    for (const a of aliases)
      for (const l of leaves)
        stmts.push(
          env.DB.prepare("INSERT INTO match_rules (id, pattern, leaf_id, auto, merge, note, source, updated_at) VALUES (?, ?, ?, 0, 0, ?, 'alias', ?)").bind(
            randomId('r'),
            normalizeText(a),
            l.id,
            `${name} – alternatív név`,
            t,
          ),
        );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await audit(env, u.id, 'partner_updated', { key, newKey, name, kind, aliases: aliases.length });
  // a még jóváhagyásra váró banki tételek és NAV-számlák újrapárosítása az új nevek alapján
  if (aliasChanged) {
    await reapplyRules(env).catch(() => null);
    await rematchNav(env).catch(() => null);
  }
  return json({ ok: true, key: newKey });
}
