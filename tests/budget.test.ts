import { describe, expect, it } from 'vitest';
import { budgetMonth } from '../shared/budget';
import { buildIndex } from '../shared/model';
import type { Entry } from '../shared/types';

const E = (p: Partial<Entry>): Entry =>
  ({
    id: 'x',
    kind: 'plan',
    date: '2026-10-30',
    leaf_id: 'u',
    name: '',
    amount: 0,
    series_id: null,
    done: 0,
    tentative: 0,
    source: 'manual',
    ext_ref: null,
    link_id: null,
    note: null,
    ...p,
  }) as Entry;

describe('keret-terv (Előre nem látható költség)', () => {
  const keret = E({ id: 'k', name: 'Előre nem látható költség – 2026. október', amount: -50000 });
  const xpage = E({ id: 'xp', name: 'X-Page Kft.', date: '2026-10-15', amount: -4051 });
  it('a besorolt tétel a keretből fogy: 50 000-ből 4 051, maradt 45 949', () => {
    const b = budgetMonth([keret, xpage], 'Előre nem látható költség', '2026-10')!;
    expect(b).toMatchObject({ budget: 50000, used: 4051, plan: 50000, left: 45949 });
  });
  it('az indexben a hónap terve a keret, nem a kettő összege', () => {
    const ix = buildIndex({
      groups: [{ id: 'g', section: 'out', label: 'Működési', sort: 0 }],
      leaves: [{ id: 'u', group_id: 'g', label: 'Előre nem látható költség', sort: 0, archived: 0 }],
      entries: [keret, xpage],
      accounts: [],
      settings: {},
      today: '2026-10-20',
    } as any);
    expect(ix.plan.get('u')?.get('2026-10')).toBe(-50000);
    expect(ix.openPlan.get('u')?.get('2026-10')).toBe(-50000);
  });
});
