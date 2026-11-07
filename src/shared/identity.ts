// Partner-azonosság: ugyanaz a cég több néven fut – a partnertörzs neve és alternatív nevei, a NAV- és a Billingo-számla
// cégneve (adószámmal), a munkaidő-elszámolás projektneve és a banki név. Ezek egy partnerhez tartoznak, ha a név
// (jogi forma, írásjel, ékezet nélkül) egyezik, az egyik tartalmazza a másikat, vagy az adószám azonos.
import { namesMatch } from './billingopay';
import { partnerKey } from './match';
import type { Leaf, Partner } from './types';

/** név → összehasonlítható alak (pl. „Mr. Big Kft.” → „mrbig”) */
export const compactName = (s: string) => partnerKey(s || '').replace(/[^a-z0-9]/g, '');
const taxBase = (t: string | null | undefined) =>
  String(t || '')
    .replace(/\D/g, '')
    .slice(0, 8);

export interface PartnerRef {
  key: string;
  name: string;
}

export interface Resolver {
  /** a név (és ha van, az adószám) melyik partnerhez tartozik; null, ha egyikhez sem */
  resolve(name: string, tax?: string | null): PartnerRef | null;
  partners: PartnerRef[];
  /** a partner összes ismert neve (alkategória, törzs neve, alternatív nevek) */
  namesOf(key: string): string[];
}

export function partnerResolver(leaves: Leaf[], partners: Partner[]): Resolver {
  const names = new Map<string, Set<string>>();
  const display = new Map<string, string>();
  for (const l of leaves) {
    if (l.archived) continue;
    const k = compactName(l.label);
    if (k.length < 2) continue;
    if (!names.has(k)) names.set(k, new Set());
    names.get(k)!.add(l.label);
    if (!display.has(k)) display.set(k, l.label);
  }
  const byTax = new Map<string, string>();
  for (const p of partners) {
    // a törzs kulcsa az alkategória nevéből jön (partnerIdOf = compactName)
    if (!names.has(p.key)) names.set(p.key, new Set());
    [p.name, ...(p.aliases || [])].forEach((n) => n && names.get(p.key)!.add(n));
    display.set(p.key, p.name || display.get(p.key) || p.key);
    const b = taxBase(p.tax_number);
    if (b.length === 8) byTax.set(b, p.key);
  }
  const exact = new Map<string, string>();
  for (const [k, ns] of names) for (const n of ns) if (!exact.has(compactName(n))) exact.set(compactName(n), k);
  const ref = (k: string): PartnerRef => ({ key: k, name: display.get(k) || k });
  return {
    resolve(name, tax) {
      const b = taxBase(tax);
      if (b.length === 8 && byTax.has(b)) return ref(byTax.get(b)!);
      const c = compactName(name);
      if (c.length < 3) return null;
      if (exact.has(c)) return ref(exact.get(c)!);
      // „Pharmazone Gyógyszer Kft.” ↔ „Pharmazone”: az egyik név a másik szavait tartalmazza – csak ha egyértelmű
      const hits = [...names].filter(([, ns]) => [...ns].some((n) => namesMatch(n, name))).map(([k]) => k);
      return hits.length === 1 ? ref(hits[0]) : null;
    },
    partners: [...names.keys()].map(ref).sort((a, b) => a.name.localeCompare(b.name, 'hu')),
    namesOf: (k) => [...(names.get(k) || [])],
  };
}

/** A legvalószínűbb partner egy ismeretlen névhez (közös szavak / betűsor alapján) – csak javaslat. */
export function suggestPartner(r: Resolver, name: string): PartnerRef | null {
  const words = (s: string) =>
    partnerKey(s)
      .split(' ')
      .filter((w) => w.length >= 4);
  const ws = words(name);
  const c = compactName(name);
  let best: PartnerRef | null = null,
    score = 0;
  for (const p of r.partners) {
    for (const n of r.namesOf(p.key)) {
      const pw = words(n);
      let s = ws.filter((w) => pw.includes(w)).length * 2;
      const pc = compactName(n);
      // közös eleje (elírás, rövidítés: „Pharmazon Gyógyszer” ↔ „Pharmazone”)
      let k = 0;
      while (k < pc.length && k < c.length && pc[k] === c[k]) k++;
      if (k >= 6) s += 3;
      if (s > score) {
        score = s;
        best = p;
      }
    }
  }
  return score >= 2 ? best : null;
}
