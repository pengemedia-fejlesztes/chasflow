// Központi állapot: adatcsomag, szűrők, értesítések, visszavonható módosítások.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildIndex, defaultFilters, type Filters, type Index } from '../../shared/model';
import type { DataBundle, EntryBatch } from '../../shared/types';
import { api } from './api';
import { applyLocal, inverseOf } from './logic';

export interface Toast {
  msg: string;
  undo?: () => void;
  error?: boolean;
}

interface Store {
  data: DataBundle;
  ix: Index;
  filters: Filters;
  setFilters: (p: Partial<Filters>) => void;
  resetFilters: () => void;
  reload: () => Promise<void>;
  commit: (b: EntryBatch, msg: string, opts?: { undoable?: boolean }) => Promise<boolean>;
  run: (fn: () => Promise<unknown>, msg?: string, undo?: () => Promise<unknown>) => Promise<boolean>;
  toast: Toast | null;
  showToast: (t: Toast | string) => void;
  canEdit: boolean;
  isAdmin: boolean;
  /** a megnyitott partner adatlap (alkategória-azonosító vagy partnerkulcs) */
  partnerCard: string | null;
  openPartner: (leafOrKey: string | null) => void;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider hiányzik');
  return s;
};

const FKEY = 'cf_filters_v1';

export function StoreProvider({ initial, children }: { initial: DataBundle; children: ReactNode }) {
  const [data, setData] = useState(initial);
  const [toast, setToast] = useState<Toast | null>(null);
  const tt = useRef<number>();
  const [filters, setF] = useState<Filters>(() => {
    const def = defaultFilters(initial.today);
    try {
      const raw = localStorage.getItem(FKEY + ':' + initial.me.id);
      if (raw) {
        const saved = JSON.parse(raw);
        // az időszakot nem őrizzük meg napokon át, ha az már a múltba csúszott;
        // a v3 előtti mentésből sem, így mindenki az alapidőszakra (következő 8 hónap) áll
        if (saved.savedFor === initial.today.slice(0, 7) && saved.v === 3) return { ...def, ...saved.f };
        return { ...def, ...saved.f, from: def.from, to: def.to };
      }
    } catch {}
    return def;
  });

  const setFilters = useCallback(
    (p: Partial<Filters>) =>
      setF((f) => {
        const n = { ...f, ...p };
        if (n.from > n.to) n.to = n.from;
        try {
          localStorage.setItem(FKEY + ':' + initial.me.id, JSON.stringify({ f: n, savedFor: initial.today.slice(0, 7), v: 3 }));
        } catch {}
        return n;
      }),
    [initial.me.id, initial.today],
  );
  const resetFilters = useCallback(() => setFilters(defaultFilters(data.today)), [data.today, setFilters]);

  const showToast = useCallback((t: Toast | string) => {
    window.clearTimeout(tt.current);
    setToast(typeof t === 'string' ? { msg: t } : t);
    tt.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const revision = useRef(0);
  const reload = useCallback(async () => {
    const requestedRevision = revision.current;
    try {
      const refreshed = await api<DataBundle>('/api/data');
      if (requestedRevision === revision.current) {
        dataRef.current = refreshed;
        setData(refreshed);
      }
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  }, [showToast]);

  // változásfigyelés: percenként egyetlen sor (adat-verzió); a teljes adat csak akkor töltődik újra, ha változott
  // (a teljes újratöltés sok sort olvas – a Cloudflare D1 napi olvasási kerete ezt nem bírja, ha percenként fut)
  const rev = useRef<string | null>(null);
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const r = await api<{ rev: string }>('/api/version');
        if (rev.current !== null && r.rev !== rev.current) await reload();
        rev.current = r.rev;
      } catch {
        // csendben: a következő ellenőrzés újra próbálja
      } finally {
        busy = false;
      }
    };
    const onFocus = () => check();
    document.addEventListener('visibilitychange', onFocus);
    const iv = window.setInterval(check, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(iv);
    };
  }, [reload]);

  const committing = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;

  const commit = useCallback(
    async (b: EntryBatch, msg: string, opts: { undoable?: boolean } = {}) => {
      const cur = dataRef.current;
      if (committing.current) {
        showToast({ msg: 'Egy mentés még folyamatban van. Várd meg a végét.', error: true });
        return false;
      }
      committing.current = true;
      const inv = inverseOf(cur, b);
      const expected =
        b.expected ||
        Object.fromEntries([
          ...(b.upsert || []).map((e) => [e.id, e.updated_at ?? cur.entries.find((x) => x.id === e.id)?.updated_at ?? null]),
          ...(b.delete || []).map((id) => [id, cur.entries.find((e) => e.id === id)?.updated_at ?? null]),
        ]);
      const seriesVersion = (id: string) => {
        const s = cur.series.find((x) => x.id === id);
        return s ? JSON.stringify([s.leaf_id, s.name, s.rep, s.day]) : null;
      };
      const expectedSeries =
        b.expectedSeries ||
        Object.fromEntries([...(b.series || []).map((s) => [s.id, seriesVersion(s.id)]), ...(b.deleteSeries || []).map((id) => [id, seriesVersion(id)])]);
      try {
        const result = await api<{ versions: Record<string, number> }>('/api/entries/batch', { body: { ...b, expected, expectedSeries, label: msg } });
        revision.current++;
        const saved = applyLocal(dataRef.current, { ...b, upsert: b.upsert?.map((e) => ({ ...e, updated_at: result.versions[e.id] })) });
        dataRef.current = saved;
        setData(saved);
        const undoExpected = Object.fromEntries(Object.keys(expected).map((id) => [id, result.versions[id] ?? null]));
        const undoSeries = Object.fromEntries(
          Object.keys(expectedSeries).map((id) => {
            const s = saved.series.find((x) => x.id === id);
            return [id, s ? JSON.stringify([s.leaf_id, s.name, s.rep, s.day]) : null];
          }),
        );
        // a törölt tervek áthúzva megjelennek (kuka) – ehhez friss adat kell
        if (b.delete?.length && !b.purge) reload();
        const undoable = opts.undoable !== false;
        showToast({
          msg,
          undo: undoable
            ? () => {
                setToast(null);
                commit({ ...inv, expected: undoExpected, expectedSeries: undoSeries, purge: true }, 'Visszavonva', { undoable: false });
              }
            : undefined,
        });
        return true;
      } catch (e: any) {
        showToast({ msg: e.message, error: true });
        await reload();
        return false;
      } finally {
        committing.current = false;
      }
    },
    [reload, showToast],
  );

  const run = useCallback(
    async (fn: () => Promise<unknown>, msg?: string, undo?: () => Promise<unknown>) => {
      try {
        await fn();
        await reload();
        if (msg)
          showToast({
            msg,
            undo: undo
              ? async () => {
                  setToast(null);
                  try {
                    await undo();
                    await reload();
                    showToast('Visszavonva');
                  } catch (e: any) {
                    showToast({ msg: e.message, error: true });
                  }
                }
              : undefined,
          });
        return true;
      } catch (e: any) {
        showToast({ msg: e.message, error: true });
        return false;
      }
    },
    [reload, showToast],
  );

  const ix = useMemo(() => buildIndex(data), [data]);
  const [partnerCard, openPartner] = useState<string | null>(null);
  const role = data.me.role;
  const value: Store = {
    data,
    ix,
    filters,
    setFilters,
    resetFilters,
    reload,
    commit,
    run,
    toast,
    showToast,
    canEdit: role !== 'viewer',
    isAdmin: role === 'admin',
    partnerCard,
    openPartner,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
