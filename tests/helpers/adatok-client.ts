// Kliens-szimuláció a terület-tesztekhez: a store.tsx commit() lépései (verziók, visszavonás) a valódi backend ellen.
// Egy „böngészőfül” állapota: a /api/data csomag, amit a store optimistán frissít (applyLocal + a szerver által adott verziók).
import { applyLocal, inverseOf } from '../../src/client/logic';
import type { DataBundle, EntryBatch } from '../../src/shared/types';
import type { TestApp } from './app';

export interface Tab {
  data: DataBundle;
  /** mint a store.commit: a batch-et a helyi verziókkal küldi, siker esetén helyben alkalmazza; visszaadja a visszavonót */
  commit(b: EntryBatch, label?: string): Promise<{ status: number; error?: string; undo: () => Promise<{ status: number; error?: string }> }>;
  reload(): Promise<DataBundle>;
}

export async function openTab(t: TestApp): Promise<Tab> {
  const tab: Tab = {
    data: (await t.get('/api/data')).data,
    async reload() {
      tab.data = (await t.get('/api/data')).data;
      return tab.data;
    },
    async commit(b, label = 'teszt') {
      const cur = tab.data;
      const inv = inverseOf(cur, b);
      const expected =
        b.expected ||
        Object.fromEntries([
          ...(b.upsert || []).map((e) => [e.id, e.updated_at ?? cur.entries.find((x) => x.id === e.id)?.updated_at ?? null]),
          ...(b.delete || []).map((id) => [id, cur.entries.find((e) => e.id === id)?.updated_at ?? null]),
        ]);
      const sv = (d: DataBundle, id: string) => {
        const s = d.series.find((x) => x.id === id);
        return s ? JSON.stringify([s.leaf_id, s.name, s.rep, s.day]) : null;
      };
      const expectedSeries =
        b.expectedSeries || Object.fromEntries([...(b.series || []).map((s) => [s.id, sv(cur, s.id)]), ...(b.deleteSeries || []).map((id) => [id, sv(cur, id)])]);
      const r = await t.post('/api/entries/batch', { ...b, expected, expectedSeries, label });
      if (r.status !== 200) {
        await tab.reload();
        return { status: r.status, error: r.data?.error, undo: async () => ({ status: 0 }) };
      }
      const versions: Record<string, number> = r.data.versions || {};
      tab.data = applyLocal(tab.data, { ...b, upsert: b.upsert?.map((e) => ({ ...e, updated_at: versions[e.id] })) });
      if ((b.delete?.length && !b.purge) || r.data.reload) await tab.reload();
      const saved = tab.data;
      const undoExpected = Object.fromEntries(Object.keys(expected).map((id) => [id, versions[id] ?? null]));
      const undoSeries = Object.fromEntries(Object.keys(expectedSeries).map((id) => [id, sv(saved, id)]));
      return {
        status: 200,
        undo: async () => {
          const u = await tab.commit({ ...inv, expected: undoExpected, expectedSeries: undoSeries, purge: true }, 'Visszavonva');
          return { status: u.status, error: u.error };
        },
      };
    },
  };
  return tab;
}

/** Kategóriák felvétele az API-n át: { in: 'Bevétel-mappa', out: 'Kiadás-mappa' } + alkategóriák. */
export async function setupLeaves(t: TestApp) {
  const gin = (await t.post('/api/groups', { section: 'in', label: 'Projektek' })).data.id as string;
  const gout = (await t.post('/api/groups', { section: 'out', label: '3 Működési költségek' })).data.id as string;
  const gwage = (await t.post('/api/groups', { section: 'out', label: '1 Munkatársak jövedelmei' })).data.id as string;
  const minta = (await t.post('/api/leaves', { group_id: gin, label: 'Minta Kft.' })).data.id as string;
  const alfa = (await t.post('/api/leaves', { group_id: gin, label: 'Alfa Bt.' })).data.id as string;
  const szoftver = (await t.post('/api/leaves', { group_id: gout, label: 'Szoftver, beszerzés' })).data.id as string;
  const iroda = (await t.post('/api/leaves', { group_id: gout, label: 'Iroda bérlés, rezsi' })).data.id as string;
  const ber = (await t.post('/api/leaves', { group_id: gwage, label: 'Munkabér' })).data.id as string;
  return { gin, gout, gwage, minta, alfa, szoftver, iroda, ber };
}
