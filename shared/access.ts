// Felhasználói hozzáférés: mely menüpontokat látja és mely érzékeny adatokhoz fér hozzá. Admin mindenhez.
// A szerver a betöltött adatokból kiveszi a nem engedélyezett részeket, és a hozzájuk tartozó végpontokat tiltja.

export const MENUS: [string, string][] = [
  ['overview', 'Áttekintés'],
  ['charts', 'Grafikonok'],
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
export const NO_ACCESS: Access = { menus: [], data: { bank: false, payroll: false, invoices: false } };
/** új meghívottnak felajánlott alap: banki adatok és beállítások nélkül */
export const INVITE_ACCESS: Access = {
  menus: MENUS.map((m) => m[0]).filter((m) => m !== 'bank' && m !== 'settings'),
  data: { bank: false, payroll: false, invoices: true },
};

const MENU_SET = new Set(MENUS.map((m) => m[0]));

export function cleanAccess(v: unknown): Access {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const menus = Array.isArray(o.menus) ? [...new Set(o.menus.map(String).filter((m: string) => MENU_SET.has(m)))] : [];
  const d = (o.data && typeof o.data === 'object' ? o.data : {}) as Record<string, unknown>;
  return { menus: menus as string[], data: { bank: d.bank === true, payroll: d.payroll === true, invoices: d.invoices === true } };
}

/** Admin: minden; hiányzó vagy hibás beállítás: tiltás. */
export function accessOf(u: { id: number; role: string }, all: Record<string, Access>): Access {
  if (u.role === 'admin') return FULL_ACCESS;
  return Object.hasOwn(all, String(u.id)) ? cleanAccess(all[String(u.id)]) : cleanAccess(NO_ACCESS);
}

// A közös főkönyv és a belőle számolt összesítések több érzékeny adatkört kevernek.
// Amíg nincs megbízható, soronkénti adatbesorolás, csak az összes érintett engedéllyel adhatók ki.
export const LEDGER_MENUS = ['overview', 'charts', 'alerts', 'income', 'cat', 'breakeven', 'partners'];
const ALL_SCOPES: DataScope[] = ['bank', 'payroll', 'invoices'];
export const hasMenu = (a: Access, menus: string[]) => menus.some((m) => a.menus.includes(m));
export const hasLedgerAccess = (a: Access) => hasMenu(a, LEDGER_MENUS) && ALL_SCOPES.every((s) => a.data[s]);

/** Ismeretlen végpont alapból tiltott. A /data külön, mezőnként szűrt válasz. */
export function requirementOf(path: string): { menu?: string[]; data?: DataScope | DataScope[] } | null {
  if (path === '/api/data' || path === '/api/version') return {};
  if (/^\/api\/(users|security)(?:\/|$)/.test(path)) return { menu: ['settings'] };
  if (/^\/api\/google(?:\/|$)/.test(path)) return { menu: ['settings'] };
  if (/^\/api\/(entries|leaves|groups)(?:\/|$)/.test(path)) return { menu: ['income', 'cat', 'partners', 'alerts'], data: ALL_SCOPES };
  if (path === '/api/series') return { menu: LEDGER_MENUS, data: ALL_SCOPES };
  if (/^\/api\/(trash|changelog)(?:\/|$)/.test(path)) return { menu: ['settings'], data: ALL_SCOPES };
  if (/^\/api\/partners(?:\/|$)/.test(path)) return { menu: ['partners'], data: ALL_SCOPES };
  if (path === '/api/flags/ack') return { menu: ['alerts'], data: ALL_SCOPES };
  if (/^\/api\/ingest(?:\/|$)/.test(path)) return { menu: ['bank', 'settings'], data: 'bank' };
  if (/^\/api\/(bank|aggreg8)/.test(path)) return { data: 'bank', menu: ['bank', 'settings'] };
  if (/^\/api\/(worktime|employees)/.test(path)) return { data: 'payroll', menu: ['breakeven'] };
  if (/^\/api\/(billingo|nav)\//.test(path)) return { data: 'invoices', menu: ['income', 'partners', 'bank', 'settings', 'alerts'] };
  if (/^\/api\/(tasks|task-perms)/.test(path)) return { menu: ['tasks'] };
  if (/^\/api\/(products|partner-products)/.test(path)) return { menu: ['products', 'partners', 'stock'] };
  if (/^\/api\/partner-profile/.test(path)) return { menu: ['partners', 'products'] };
  if (/^\/api\/(warehouses|stock-moves)/.test(path)) return { menu: ['stock'] };
  if (path === '/api/sync') return { menu: ['settings', 'bank', 'income'], data: ALL_SCOPES };
  if (/^\/api\/(settings|rules|partner-rules|stats\/refresh|diag|import$)/.test(path)) return { menu: ['settings'], data: ALL_SCOPES };
  return null;
}

export function allowed(path: string, a: Access): boolean {
  const r = requirementOf(path);
  if (!r) return false;
  if (r.data && !(Array.isArray(r.data) ? r.data : [r.data]).every((s) => a.data[s])) return false;
  if (r.menu && !r.menu.some((m) => a.menus.includes(m))) return false;
  return true;
}

export type TwoFaMode = 'off' | 'admin' | 'all';
/** kötelező-e a kétlépcsős azonosítás ennek a felhasználónak */
export const needs2fa = (mode: TwoFaMode, role: string) => mode === 'all' || (mode === 'admin' && role === 'admin');
