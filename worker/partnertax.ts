// Adószám-alapú partnerazonosítás: a partnertörzs adószáma a NAV- és Billingo-számlákból töltődik ki, és a beérkező
// számla ez alapján kerül a partnerhez – megelőzve a név/kategória szabályokat (pl. „Tibeko” ne az „IT szolgáltatás”-ba menjen).
import { namesMatch } from '../shared/billingopay';
import { normalizeText } from '../shared/categories';
import { compactName } from '../shared/identity';
import { partnerIdOf } from '../shared/partners';
import { Env, getSetting, now, randomId } from './util';

/** adószám → törzsszám (az első 8 számjegy), így a 12345678-2-13 és a 12345678 is egyezik */
export const taxBase = (t: string | null | undefined) =>
  String(t || '')
    .replace(/\D/g, '')
    .slice(0, 8);

/** törzsszám → a partner bevételi / kiadási alkategóriája (a partnertörzsben megadott adószám alapján) */
export async function taxLeafMap(env: Env): Promise<Map<string, { in?: string; out?: string }>> {
  const [pR, lR] = await env.DB.batch([
    env.DB.prepare("SELECT key, tax_number FROM partners WHERE tax_number IS NOT NULL AND tax_number <> ''"),
    env.DB.prepare('SELECT l.id, l.label, g.section FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.archived = 0'),
  ]);
  const byKey = new Map<string, { in?: string; out?: string }>();
  for (const l of lR.results as any[]) {
    const k = partnerIdOf(l.label);
    const x = byKey.get(k) || {};
    if (!x[l.section as 'in' | 'out']) x[l.section as 'in' | 'out'] = l.id;
    byKey.set(k, x);
  }
  const out = new Map<string, { in?: string; out?: string }>();
  for (const p of pR.results as any[]) {
    const b = taxBase(p.tax_number);
    const x = byKey.get(p.key);
    if (b.length === 8 && x) out.set(b, x);
  }
  return out;
}

/**
 * A partnertörzs üres adószámainak kitöltése a NAV- és Billingo-számlákból: a számla partnerneve a partner nevével vagy
 * alternatív nevével egyezik (a kategória-jellegű alkategóriák, pl. „IT szolgáltatás”, így nem kapnak adószámot).
 */
export async function fillPartnerTax(env: Env): Promise<number> {
  const [lR, pR, nR, bR] = await env.DB.batch([
    env.DB.prepare('SELECT id, label FROM leaves WHERE archived = 0'),
    env.DB.prepare('SELECT key, name, aliases, tax_number FROM partners'),
    env.DB.prepare("SELECT DISTINCT partner_tax AS tax, partner_name AS name FROM nav_invoices WHERE partner_tax IS NOT NULL AND partner_tax <> ''"),
    env.DB.prepare("SELECT DISTINCT partner_tax AS tax, partner AS name FROM billingo_docs WHERE partner_tax IS NOT NULL AND partner_tax <> ''"),
  ]);
  const partners = new Map<string, { name: string; aliases: string[]; tax: string | null }>();
  for (const p of pR.results as any[]) partners.set(p.key, { name: p.name, aliases: JSON.parse(p.aliases || '[]'), tax: p.tax_number });
  // partnerek (kulcs → nevek): az alkategória neve + a partnertörzs neve és alternatív nevei
  const names = new Map<string, Set<string>>();
  for (const l of lR.results as any[]) {
    const k = partnerIdOf(l.label);
    if (!names.has(k)) names.set(k, new Set([l.label]));
  }
  for (const [k, p] of partners) {
    const s = names.get(k) || new Set<string>();
    [p.name, ...p.aliases].forEach((n) => s.add(n));
    names.set(k, s);
  }
  // saját név (alkategória / partnertörzs neve) – ez erősebb, mint egy alternatív névvel való egyezés
  const ownNames = new Map<string, string[]>();
  for (const l of lR.results as any[]) {
    const k = partnerIdOf(l.label);
    ownNames.set(k, [...(ownNames.get(k) || []), l.label]);
  }
  for (const [k, p] of partners) ownNames.set(k, [...(ownNames.get(k) || []), p.name]);
  const found = new Map<string, string>(); // partner kulcs → adószám
  const taxOwners = new Map<string, { own: Set<string>; alias: Set<string> }>(); // törzsszám → partner kulcsok
  for (const r of [...(nR.results as any[]), ...(bR.results as any[])]) {
    const b = taxBase(r.tax);
    if (b.length !== 8 || !r.name) continue;
    for (const [k, ns] of names) {
      if (![...ns].some((n) => namesMatch(n, r.name))) continue;
      const own = (ownNames.get(k) || []).some((n) => namesMatch(n, r.name));
      const o = taxOwners.get(b) || taxOwners.set(b, { own: new Set(), alias: new Set() }).get(b)!;
      (own ? o.own : o.alias).add(k);
      if (!found.has(k)) found.set(k, r.tax);
    }
  }
  // egy adószám egy partnerhez: ha több egyezik, a saját nevén egyező nyer; ha így is több, kétes → kimarad
  const winner = (b: string) => {
    const o = taxOwners.get(b);
    if (!o) return null;
    if (o.own.size === 1) return [...o.own][0];
    if (!o.own.size && o.alias.size === 1) return [...o.alias][0];
    return null;
  };
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [k, tax] of found) {
    if (partners.get(k)?.tax) continue;
    if (winner(taxBase(tax)) !== k) continue;
    const name = partners.get(k)?.name || [...(names.get(k) || [])][0] || k;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO partners (key, name, kind, aliases, tax_number, note, updated_at) VALUES (?, ?, NULL, '[]', ?, NULL, ?)
         ON CONFLICT(key) DO UPDATE SET tax_number = excluded.tax_number, updated_at = excluded.updated_at WHERE partners.tax_number IS NULL OR partners.tax_number = ''`,
      ).bind(k, name, tax, t),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/** Az alternatív nevekből „tartalmazza” párosítási szabályok a partner összes alkategóriájára (a régi alias-szabályok helyett). */
export function aliasRuleStmts(env: Env, leafIds: string[], aliases: string[], name: string, t: number): D1PreparedStatement[] {
  if (!leafIds.length) return [];
  const out = [env.DB.prepare(`DELETE FROM match_rules WHERE source = 'alias' AND leaf_id IN (${leafIds.map(() => '?').join(',')})`).bind(...leafIds)];
  for (const a of aliases)
    for (const id of leafIds)
      out.push(
        env.DB.prepare("INSERT INTO match_rules (id, pattern, leaf_id, auto, merge, note, source, updated_at) VALUES (?, ?, ?, 0, 0, ?, 'alias', ?)").bind(
          randomId('r'),
          normalizeText(a),
          id,
          `${name} – alternatív név`,
          t,
        ),
      );
  return out;
}

/**
 * A saját tervhez kötött Billingo-számla adószáma a partneré (ha még nincs adószáma, és más partneré sem ez) – így a számlán
 * szereplő cégnév (pl. „UrgentCare … Kft.” → Orvosmost) is a partner alternatív neve lesz.
 */
async function taxFromLinkedInvoices(env: Env): Promise<number> {
  const [dR, pR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT DISTINCT d.partner_tax AS tax, l.label FROM billingo_docs d JOIN entries e ON e.id = d.plan_id JOIN leaves l ON l.id = e.leaf_id
       WHERE e.plan_amount IS NOT NULL AND d.partner_tax IS NOT NULL AND d.partner_tax <> ''`,
    ),
    env.DB.prepare('SELECT key, tax_number FROM partners'),
  ]);
  const owner = new Map<string, string>();
  for (const p of pR.results as any[]) if (taxBase(p.tax_number).length === 8) owner.set(taxBase(p.tax_number), p.key);
  const taxed = new Set((pR.results as any[]).filter((p) => taxBase(p.tax_number).length === 8).map((p) => p.key as string));
  // egy partnerhez csak egyféle adószám jöhet így (ha több, kétes → kimarad)
  const cand = new Map<string, { label: string; taxes: Set<string>; raw: string }>();
  for (const r of dR.results as any[]) {
    const k = partnerIdOf(r.label);
    const b = taxBase(r.tax);
    if (k.length < 2 || b.length !== 8 || taxed.has(k) || (owner.has(b) && owner.get(b) !== k)) continue;
    const c = cand.get(k) || cand.set(k, { label: r.label, taxes: new Set(), raw: r.tax }).get(k)!;
    c.taxes.add(b);
  }
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [k, c] of cand) {
    if (c.taxes.size !== 1) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO partners (key, name, kind, aliases, tax_number, note, updated_at) VALUES (?, ?, 'vevo', '[]', ?, NULL, ?)
         ON CONFLICT(key) DO UPDATE SET tax_number = excluded.tax_number, updated_at = excluded.updated_at WHERE partners.tax_number IS NULL OR partners.tax_number = ''`,
      ).bind(k, c.label, c.raw, t),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/**
 * Névösszevonás adószám alapján: ha a partnertörzsben van adószám, a NAV- és Billingo-számlákon ugyanezzel az adószámmal
 * szereplő (eltérő) cégnevek a partner alternatív nevei közé kerülnek. Egy nevet csak egyszer vesz fel (a „partner_names_seen”
 * jegyzi), így ha valaki kézzel törli az adatlapról, nem kerül vissza.
 */
export async function mergePartnerNames(env: Env): Promise<number> {
  await taxFromLinkedInvoices(env);
  const [pR, nR, bR, lR] = await env.DB.batch([
    env.DB.prepare("SELECT key, name, aliases, tax_number FROM partners WHERE tax_number IS NOT NULL AND tax_number <> ''"),
    env.DB.prepare("SELECT DISTINCT partner_tax AS tax, partner_name AS name FROM nav_invoices WHERE partner_tax IS NOT NULL AND partner_tax <> ''"),
    env.DB.prepare("SELECT DISTINCT partner_tax AS tax, partner AS name FROM billingo_docs WHERE partner_tax IS NOT NULL AND partner_tax <> ''"),
    env.DB.prepare('SELECT id, label FROM leaves WHERE archived = 0'),
  ]);
  let seen: string[] = [];
  try {
    seen = JSON.parse((await getSetting(env, 'partner_names_seen')) || '[]');
  } catch {}
  const seenSet = new Set(seen);
  const byTax = new Map<string, Set<string>>();
  for (const r of [...(nR.results as any[]), ...(bR.results as any[])]) {
    const b = taxBase(r.tax);
    if (b.length !== 8 || !String(r.name || '').trim()) continue;
    (byTax.get(b) || byTax.set(b, new Set()).get(b)!).add(String(r.name).replace(/\s+/g, ' ').trim());
  }
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let added = 0;
  for (const p of pR.results as any[]) {
    const names = byTax.get(taxBase(p.tax_number));
    if (!names) continue;
    const aliases: string[] = JSON.parse(p.aliases || '[]');
    const leafIds = (lR.results as any[]).filter((l) => partnerIdOf(l.label) === p.key).map((l) => l.id as string);
    const known = new Set([p.name, ...aliases, ...(lR.results as any[]).filter((l) => partnerIdOf(l.label) === p.key).map((l) => l.label)].map(compactName));
    const fresh: string[] = [];
    for (const n of names) {
      const c = compactName(n);
      const mark = `${p.key}|${c}`;
      if (c.length < 3 || known.has(c) || seenSet.has(mark)) continue;
      seenSet.add(mark);
      known.add(c);
      if (aliases.length + fresh.length < 30) fresh.push(n);
    }
    if (!fresh.length) continue;
    const all = [...aliases, ...fresh];
    added += fresh.length;
    stmts.push(env.DB.prepare('UPDATE partners SET aliases = ?, updated_at = ? WHERE key = ?').bind(JSON.stringify(all), t, p.key));
    stmts.push(...aliasRuleStmts(env, leafIds, all, p.name, t));
  }
  if (seenSet.size !== seen.length)
    stmts.push(
      env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(
        'partner_names_seen',
        JSON.stringify([...seenSet].slice(-3000)),
      ),
    );
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return added;
}

/**
 * Partner típusa (vevő / szállító / mindkettő) a forgalomból, ha még nincs megadva: akinek kiállított (Billingo) számlája vagy
 * bevétele van, vevő; akinek beérkezett (NAV) számlája vagy kiadása, szállító. Partnertörzs-sort csak számlás partnernek nyit.
 */
export async function fillPartnerKind(env: Env): Promise<number> {
  const [rowsR, pR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT l.label, g.section, max(CASE WHEN e.source IN ('billingo', 'nav') OR e.ext_ref LIKE 'billingo:%' OR e.ext_ref LIKE 'bpaid:%' THEN 1 ELSE 0 END) AS inv
       FROM entries e JOIN leaves l ON l.id = e.leaf_id JOIN groups g ON g.id = l.group_id
       WHERE COALESCE(e.tentative, 0) = 0 AND (e.kind = 'actual' OR e.source IN ('billingo', 'nav')) GROUP BY l.label, g.section`,
    ),
    env.DB.prepare('SELECT key, kind FROM partners'),
  ]);
  const cur = new Map((pR.results as any[]).map((p) => [p.key as string, p.kind as string | null]));
  const sides = new Map<string, { name: string; in: boolean; out: boolean; inv: boolean }>();
  for (const r of rowsR.results as any[]) {
    const k = partnerIdOf(r.label);
    if (k.length < 2) continue;
    const x = sides.get(k) || sides.set(k, { name: r.label, in: false, out: false, inv: false }).get(k)!;
    if (r.section === 'in') x.in = true;
    else x.out = true;
    if (r.inv) x.inv = true;
  }
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [k, x] of sides) {
    const kind = x.in && x.out ? 'mindketto' : x.in ? 'vevo' : 'szallito';
    if (cur.has(k)) {
      if (!cur.get(k)) stmts.push(env.DB.prepare('UPDATE partners SET kind = ?, updated_at = ? WHERE key = ? AND kind IS NULL').bind(kind, t, k));
    } else if (x.inv)
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO partners (key, name, kind, aliases, tax_number, note, updated_at) VALUES (?, ?, ?, '[]', NULL, NULL, ?)").bind(
          k,
          x.name,
          kind,
          t,
        ),
      );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}
