// Magyar munkanapok és fizetési nap szabályok.
//  pay_rule formátum: 'month_start' | 'month_end' | 'first_workday' | 'last_workday' | 'day:N' (N. nap; ha munkaszüneti nap, az előtte lévő munkanap)

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Húsvétvasárnap (Gauss / Meeus algoritmus) */
function easter(y: number): Date {
  const a = y % 19,
    b = Math.floor(y / 100),
    c = y % 100,
    d = Math.floor(b / 4),
    e = b % 4;
  const f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

/**
 * Munkarend-naptár: évente kihirdetett áthelyezések (NGM rendelet). `rest` = áthelyezett pihenőnap (hétköznap, de nem
 * munkanap), `work` = ledolgozós szombat (munkanap). 2027-re a rendelet még nem jelent meg (2026. 10. 31.) – ha megjelenik,
 * ide kell felvenni; addig 2027-ben csak a törvényes ünnepek számítanak.
 */
export const WORK_CALENDAR: Record<number, { rest: string[]; work: string[] }> = {
  2024: { rest: ['2024-08-19', '2024-12-24', '2024-12-27'], work: ['2024-08-03', '2024-12-07', '2024-12-14'] },
  2025: { rest: ['2025-05-02', '2025-10-24', '2025-12-24'], work: ['2025-05-17', '2025-10-18', '2025-12-13'] },
  2026: { rest: ['2026-01-02', '2026-08-21', '2026-12-24'], work: ['2026-01-10', '2026-08-08', '2026-12-12'] },
  2027: { rest: [], work: [] },
};

const cache = new Map<number, Set<string>>();
/** Magyarországi munkaszüneti napok: törvényes ünnepek (Mt. 102. §) + az évi áthelyezett pihenőnapok. */
export function holidays(y: number): Set<string> {
  if (cache.has(y)) return cache.get(y)!;
  const s = new Set([`${y}-01-01`, `${y}-03-15`, `${y}-05-01`, `${y}-08-20`, `${y}-10-23`, `${y}-11-01`, `${y}-12-25`, `${y}-12-26`]);
  const e = easter(y).getTime();
  for (const off of [-2, 1, 50]) s.add(iso(new Date(e + off * 86400000))); // nagypéntek, húsvéthétfő, pünkösdhétfő
  for (const d of WORK_CALENDAR[y]?.rest || []) s.add(d);
  cache.set(y, s);
  return s;
}

export function isWorkday(date: string): boolean {
  const d = new Date(date + 'T12:00:00Z');
  const y = d.getUTCFullYear();
  if (WORK_CALENDAR[y]?.work.includes(date)) return true; // ledolgozós szombat
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(y).has(date);
}

const DAYS_HU = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
/** a nap neve: „hétfő” … ; munkaszüneti napnál „(munkaszüneti nap)”, ledolgozós szombatnál „(munkanap)” jelzéssel */
export function dayNameHu(date: string, mark = false): string {
  const d = new Date(date + 'T12:00:00Z');
  const n = DAYS_HU[d.getUTCDay()];
  if (!mark) return n;
  const wd = d.getUTCDay();
  if (WORK_CALENDAR[d.getUTCFullYear()]?.work.includes(date)) return `${n} (munkanap)`;
  if (wd !== 0 && wd !== 6 && holidays(d.getUTCFullYear()).has(date)) return `${n} (munkaszüneti nap)`;
  return n;
}

function step(date: string, dir: 1 | -1): string {
  return iso(new Date(Date.parse(date + 'T12:00:00Z') + dir * 86400000));
}

export function firstWorkday(ym: string): string {
  let d = `${ym}-01`;
  while (!isWorkday(d)) d = step(d, 1);
  return d;
}

export function lastWorkday(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  let d = iso(new Date(Date.UTC(y, m, 0)));
  while (!isWorkday(d)) d = step(d, -1);
  return d;
}

export type PayRule = string | null | undefined;

/** Az adott hónapra a szabály szerinti fizetési dátum; ha nincs szabály, a megadott nap. */
export function payDate(ym: string, rule: PayRule, fallbackDay: number): string {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (rule === 'month_start') return `${ym}-01`;
  if (rule === 'month_end') return `${ym}-${pad(last)}`;
  if (rule === 'first_workday') return firstWorkday(ym);
  if (rule === 'last_workday') return lastWorkday(ym);
  // számlázás a hónap első munkanapján, fizetés N nappal később
  const inv = rule && rule.match(/^inv:(\d{1,3})$/);
  if (inv) return addDays(firstWorkday(ym), Number(inv[1]));
  const mm = rule && rule.match(/^day:(\d{1,2})$/);
  if (mm) {
    let d = `${ym}-${pad(Math.min(last, Math.max(1, Number(mm[1]))))}`;
    while (!isWorkday(d) && d > `${ym}-01`) d = step(d, -1);
    return d;
  }
  return `${ym}-${pad(Math.min(last, Math.max(1, fallbackDay)))}`;
}

export function payRuleLabel(rule: PayRule): string {
  if (rule === 'month_start') return 'hónap eleje (1.)';
  if (rule === 'month_end') return 'hónap vége (utolsó nap)';
  if (rule === 'first_workday') return 'hónap első munkanapja';
  if (rule === 'last_workday') return 'hónap utolsó munkanapja';
  const m = rule && rule.match(/^day:(\d{1,2})$/);
  if (m) return `minden hónap ${m[1]}-ig`;
  const inv = rule && rule.match(/^inv:(\d{1,3})$/);
  if (inv) return `számlázás a hónap első munkanapján + ${inv[1]} nap`;
  return 'nincs szabály';
}

/** A kategória (alkategória) érvényes szabálya: saját, különben a csoporté. */
export function effectiveRule(leaf: { pay_rule?: string | null } | undefined, group: { pay_rule?: string | null } | undefined): PayRule {
  return leaf?.pay_rule || group?.pay_rule || null;
}

// ── Dátum-segédek a gyors átütemezéshez (mindig hétfőre) ──
const toD = (d: string) => new Date(d + 'T00:00:00Z');
const fromD = (t: Date) => t.toISOString().slice(0, 10);
export function addDays(d: string, n: number): string {
  const t = toD(d);
  t.setUTCDate(t.getUTCDate() + n);
  return fromD(t);
}
export const dayDiff = (a: string, b: string) => Math.round((toD(b).getTime() - toD(a).getTime()) / 86400000);
/** Ugyanaz a nap n hónappal később (hónap végén az utolsó napra igazítva). */
export function addMonthsDate(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return fromD(t);
}
/** Az adott dátum utáni n. hét hétfője (1 = jövő hét hétfő). */
export function mondayAfter(d: string, weeks: number): string {
  const wd = (toD(d).getUTCDay() + 6) % 7; // hétfő = 0
  return addDays(d, 7 * weeks - wd);
}
/** A dátum, ha hétfő, különben a következő hétfő. */
export function mondayOnOrAfter(d: string): string {
  const wd = (toD(d).getUTCDay() + 6) % 7;
  return wd === 0 ? d : addDays(d, 7 - wd);
}

/** Partner alapértelmezett fizetési határideje (nap, a számla kiállításától). */
export const DEFAULT_PAY_DAYS = 8;
/** Egyszeri szolgáltatás: a felviteltől ennyi nap a várható fizetés. */
export const ONEOFF_DAYS = 14;
/** Rendszeres tétel várható fizetése az adott hónapban: első munkanap (számlázás) + fizetési határidő. */
export const invoiceDue = (ym: string, payDays: number) => addDays(firstWorkday(ym), payDays);
