// Magyar munkanapok és fizetési nap szabályok.
//  pay_rule formátum: 'first_workday' | 'last_workday' | 'day:N' (N. nap; ha munkaszüneti nap, az előtte lévő munkanap)

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Húsvétvasárnap (Gauss / Meeus algoritmus) */
function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

const cache = new Map<number, Set<string>>();
/** Magyarországi munkaszüneti napok (áthelyezett munkanapok nélkül). */
export function holidays(y: number): Set<string> {
  if (cache.has(y)) return cache.get(y)!;
  const s = new Set([`${y}-01-01`, `${y}-03-15`, `${y}-05-01`, `${y}-08-20`, `${y}-10-23`, `${y}-11-01`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`]);
  const e = easter(y).getTime();
  for (const off of [-2, 1, 50]) s.add(iso(new Date(e + off * 86400000))); // nagypéntek, húsvéthétfő, pünkösdhétfő
  cache.set(y, s);
  return s;
}

export function isWorkday(date: string): boolean {
  const d = new Date(date + 'T12:00:00Z');
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(d.getUTCFullYear()).has(date);
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
  if (rule === 'first_workday') return firstWorkday(ym);
  if (rule === 'last_workday') return lastWorkday(ym);
  const mm = rule && rule.match(/^day:(\d{1,2})$/);
  if (mm) {
    let d = `${ym}-${pad(Math.min(last, Math.max(1, Number(mm[1]))))}`;
    while (!isWorkday(d) && d > `${ym}-01`) d = step(d, -1);
    return d;
  }
  return `${ym}-${pad(Math.min(last, Math.max(1, fallbackDay)))}`;
}

export function payRuleLabel(rule: PayRule): string {
  if (rule === 'first_workday') return 'hónap első munkanapja';
  if (rule === 'last_workday') return 'hónap utolsó munkanapja';
  const m = rule && rule.match(/^day:(\d{1,2})$/);
  if (m) return `minden hónap ${m[1]}-ig`;
  return 'nincs szabály';
}

/** A kategória (alkategória) érvényes szabálya: saját, különben a csoporté. */
export function effectiveRule(leaf: { pay_rule?: string | null } | undefined, group: { pay_rule?: string | null } | undefined): PayRule {
  return leaf?.pay_rule || group?.pay_rule || null;
}
