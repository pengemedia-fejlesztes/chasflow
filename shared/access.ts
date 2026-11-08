// Felhasználói hozzáférés: mely menüpontokat látja és mely érzékeny adatokhoz fér hozzá. Admin mindenhez.
// A szerver a betöltött adatokból kiveszi a nem engedélyezett részeket, és a hozzájuk tartozó végpontokat tiltja.

export const MENUS: [string, string][] = [
  ['overview', 'Áttekintés'],
  ['tasks', 'Feladatok'],
  ['alerts', 'Összevonás'],
  ['income', 'Tervezett bevételek, kiadások'],
  ['cat', 'Kategóriák (oldalsáv)'],
  ['bank', 'Bankszinkron'],
  ['partners', 'Partnertörzs'],
  ['products', 'Termékek, szolgáltatások'],
  ['stock', 'Raktárkészlet'],
  ['breakeven', 'Fedezeti pont'],
  ['settings', 'Beállítások'],
];
export type DataScope = 'bank' | 'payroll' | 'invoices';
export const DATA_SCOPES: [DataScope, string, string][] = [
  ['bank', 'Bankszámlák és egyenlegek', 'banki tranzakciók, egyenlegek, bankösszekötés'],
  ['payroll', 'Bérek és munkaidő', 'munkatársak, ledolgozott idő, órabérek (Fedezeti pont)'],
  ['invoices', 'Számlák', 'Billingo- és NAV-számlák'],
];

export interface Access {
  /** engedélyezett menüpontok */
  menus: string[];
  data: Record<DataScope, boolean>;
}

export const FULL_ACCESS: Access = { menus: MENUS.map((m) => m[0]), data: { bank: true, payroll: true, invoices: true } };
/** új meghívottnak felajánlott alap: banki adatok és beállítások nélkül */
export const INVITE_ACCESS: Access = {
  menus: MENUS.map((m) => m[0]).filter((m) => m !== 'bank' && m !== 'settings'),
  data: { bank: false, payroll: false, invoices: true },
};

const MENU_SET = new Set(MENUS.map((m) => m[0]));

export function cleanAccess(v: unknown): Access {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const menus = Array.isArray(o.menus) ? [...new Set(o.menus.map(String).filter((m: string) => MENU_SET.has(m)))] : FULL_ACCESS.menus;
  const d = (o.data && typeof o.data === 'object' ? o.data : {}) as Record<string, unknown>;
  return { menus: menus as string[], data: { bank: d.bank !== false, payroll: d.payroll !== false, invoices: d.invoices !== false } };
}

/** a felhasználó tényleges hozzáférése (admin: minden; beállítás nélkül: minden, a korábbi működés szerint) */
export function accessOf(u: { id: number; role: string }, all: Record<string, Access>): Access {
  if (u.role === 'admin') return FULL_ACCESS;
  return all[String(u.id)] ? cleanAccess(all[String(u.id)]) : FULL_ACCESS;
}

/** melyik menüpont / adatkör kell a végponthoz (null: nincs külön feltétel) */
export function requirementOf(path: string): { menu?: string[]; data?: DataScope } | null {
  if (/^\/api\/(bank|aggreg8)/.test(path)) return { data: 'bank', menu: ['bank', 'settings'] };
  if (/^\/api\/(worktime|employees)/.test(path)) return { data: 'payroll', menu: ['breakeven'] };
  if (/^\/api\/(billingo|nav)\//.test(path)) return { data: 'invoices' };
  if (/^\/api\/(tasks|task-perms)/.test(path)) return { menu: ['tasks'] };
  if (/^\/api\/(products|partner-products)/.test(path)) return { menu: ['products', 'partners', 'stock'] };
  if (/^\/api\/partner-profile/.test(path)) return { menu: ['partners', 'products'] };
  if (/^\/api\/(warehouses|stock-moves)/.test(path)) return { menu: ['stock'] };
  if (path === '/api/sync') return { menu: ['settings', 'bank', 'income'] };
  if (/^\/api\/(settings|rules|partner-rules|stats\/refresh|diag|import$)/.test(path)) return { menu: ['settings'] };
  return null;
}

export function allowed(path: string, a: Access): boolean {
  const r = requirementOf(path);
  if (!r) return true;
  if (r.data && !a.data[r.data]) return false;
  if (r.menu && !r.menu.some((m) => a.menus.includes(m))) return false;
  return true;
}

export type TwoFaMode = 'off' | 'admin' | 'all';
/** kötelező-e a kétlépcsős azonosítás ennek a felhasználónak */
export const needs2fa = (mode: TwoFaMode, role: string) => mode === 'all' || (mode === 'admin' && role === 'admin');
