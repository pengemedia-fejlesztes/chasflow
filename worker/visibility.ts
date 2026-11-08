import { hasLedgerAccess, hasMenu, type Access } from '../shared/access';
import type { DataBundle } from '../shared/types';

const DISPLAY_SETTINGS = [
  'opening_balance',
  'profit_target',
  'billingo_leaf_default',
  'flags_ack',
  'default_pay_days',
  'default_oneoff_days',
  'default_pay_days_in',
  'default_pay_days_out',
  'default_oneoff_days_in',
  'default_oneoff_days_out',
];
const ADMIN_SETTINGS = ['billingo_last_sync', 'billingo_autopay_last', 'nav_last_sync', 'nav_last_error', 'server_errors'];

/** Explicit response allowlists: never serialize the settings table or an unclassified ledger wholesale. */
export function visibleBundle(bundle: DataBundle, a: Access): DataBundle {
  const b = { ...bundle, settings: {} as Record<string, string> };
  const settings = bundle.settings as Record<string, string | undefined>;
  const ledger = hasLedgerAccess(a);
  b.myAccess = { ...a, menus: a.menus.filter((m) => !['overview', 'charts', 'alerts', 'income', 'cat', 'breakeven'].includes(m) || ledger) };
  if (ledger) for (const k of DISPLAY_SETTINGS) if (typeof settings[k] === 'string') b.settings[k] = settings[k]!;
  if (bundle.me.role === 'admin') for (const k of ADMIN_SETTINGS) if (typeof settings[k] === 'string') b.settings[k] = settings[k]!;
  if (!ledger) Object.assign(b, { groups: [], leaves: [], entries: [], series: [], deleted: [], lostOffers: [], monthStats: [], partnerNames: [] });
  if (!a.data.bank || !hasMenu(a, ['bank', 'settings'])) Object.assign(b, { accounts: [], bankTx: [] });
  if (!a.data.payroll || !hasMenu(a, ['breakeven'])) Object.assign(b, { employees: [], worktime: [] });
  if (!a.data.invoices || !hasMenu(a, ['income', 'partners', 'bank', 'settings', 'alerts'])) Object.assign(b, { billingo: [], navInvoices: [] });
  if (!hasMenu(a, ['partners'])) Object.assign(b, { partners: [], partnerProfiles: {}, partnerProducts: [] });
  if (!hasMenu(a, ['products', 'partners', 'stock'])) Object.assign(b, { products: [], partnerProducts: [] });
  if (!hasMenu(a, ['stock'])) Object.assign(b, { warehouses: [], stockLevels: [], stockMoves: [] });
  if (!hasMenu(a, ['tasks']))
    Object.assign(b, { tasks: [], taskUsers: [], myTaskPerm: { view: 'own', assign: false, edit: 'own', delete: 'own', write: false } });
  // A partnerprofil bankszámlaszáma is bankadat; a menüpont önmagában nem ad jogot hozzá.
  if (!a.data.bank) b.partnerProfiles = Object.fromEntries(Object.entries(b.partnerProfiles || {}).map(([k, p]) => [k, { ...p, bank_account: '' }]));
  return b;
}
