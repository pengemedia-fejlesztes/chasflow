import type { DataBundle } from './types';

/** Non-overlapping response fields. Unknown mutations always use the complete bundle. */
export const SECTION_FIELDS = {
  ledger: [
    'groups',
    'leaves',
    'series',
    'entries',
    'accounts',
    'bankTx',
    'billingo',
    'settings',
    'deleted',
    'monthStats',
    'partnerNames',
    'lostOffers',
    'navInvoices',
    'partners',
    'integrations',
    'userAccess',
    'twofaMode',
    'aggreg8Server',
  ],
  catalog: ['products', 'partnerProducts', 'partnerProfiles', 'catalogError'],
  tasks: ['tasks', 'taskUsers', 'myTaskPerm', 'taskPerms', 'tasksError'],
  stock: ['warehouses', 'stockLevels', 'stockMoves', 'stockError'],
  payroll: ['employees', 'worktime'],
} as const satisfies Record<string, readonly (keyof DataBundle)[]>;
export type DataSection = keyof typeof SECTION_FIELDS;
export const DATA_SECTIONS = Object.keys(SECTION_FIELDS) as DataSection[];
export type BundlePatch = Partial<DataBundle> & Pick<DataBundle, 'me' | 'today'> & { sections: DataSection[] };

export function parseSections(value: string | null): DataSection[] | null {
  if (value === null) return null;
  const parts = value.split(',');
  if (!parts.length || parts.some((p) => !Object.hasOwn(SECTION_FIELDS, p))) throw new Error('Hibás adatkör.');
  return [...new Set(parts)] as DataSection[];
}

export function bundlePatch(bundle: DataBundle, sections: DataSection[]): BundlePatch {
  const patch: BundlePatch = { me: bundle.me, today: bundle.today, myAccess: bundle.myAccess, sections };
  // Include absent optional fields, serialized as null, so an old error cannot survive a successful retry.
  for (const section of sections) for (const key of SECTION_FIELDS[section]) (patch as any)[key] = bundle[key] ?? null;
  return patch;
}

export function mutationSections(path: string): DataSection[] | null {
  const p = path.split('?')[0];
  if (/^\/api\/(tasks(?:\/|$)|task-perms$)/.test(p)) return ['tasks'];
  if (/^\/api\/(warehouses|stock-moves)(?:\/|$)/.test(p)) return ['stock'];
  // Product edits also influence stock and generated call tasks; financial/import/sync operations
  // can touch several modules. Keep the full refresh until their dependency graph is explicit.
  return null;
}
