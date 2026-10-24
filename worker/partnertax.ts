// Adószám-alapú partnerazonosítás: a partnertörzs adószáma a NAV- és Billingo-számlákból töltődik ki, és a beérkező
// számla ez alapján kerül a partnerhez – megelőzve a név/kategória szabályokat (pl. „Tibeko” ne az „IT szolgáltatás”-ba menjen).
import { namesMatch } from '../shared/billingopay';
import { partnerIdOf } from '../shared/partners';
import { Env, now } from './util';

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
  const found = new Map<string, string>(); // partner kulcs → adószám
  const taxOwners = new Map<string, Set<string>>(); // törzsszám → partner kulcsok (több partner = kétes)
  for (const r of [...(nR.results as any[]), ...(bR.results as any[])]) {
    const b = taxBase(r.tax);
    if (b.length !== 8 || !r.name) continue;
    for (const [k, ns] of names) {
      if (![...ns].some((n) => namesMatch(n, r.name))) continue;
      if (!found.has(k)) found.set(k, r.tax);
      (taxOwners.get(b) || taxOwners.set(b, new Set()).get(b)!).add(k);
    }
  }
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const [k, tax] of found) {
    if (partners.get(k)?.tax) continue;
    if ((taxOwners.get(taxBase(tax))?.size || 0) > 1) continue;
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
