// Központi állapot: adatcsomag, szűrők, értesítések, visszavonható módosítások.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildIndex, defaultFilters, type Filters, type Index } from '../shared/model';
import type { DataBundle, EntryBatch } from '../shared/types';
import { api } from './api';
import { DATA_SECTIONS, SECTION_FIELDS, mutationSections, type BundlePatch, type DataSection } from '../shared/data-sections';
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
  run: (fn: () => Promise<unknown>, msg?: string | ((result: any) => string), undo?: () => Promise<unknown>) => Promise<boolean>;
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
        // a többi beállítás (ajánlatok, becslés, nézet) megmarad; az időszak csak ezen a böngészőlapon (frissítéskor),
        // új megnyitáskor mindig a mai hónaptól indul – így nem ragad egy régen kiválasztott, távoli időszakon
        const per = JSON.parse(sessionStorage.getItem(FKEY + ':period') || 'null');
        const keepPer = per && per.savedFor === initial.today.slice(0, 7) && per.from && per.to;
        return { ...def, ...saved.f, from: keepPer ? per.from : def.from, to: keepPer ? per.to : def.to };
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
          sessionStorage.setItem(FKEY + ':period', JSON.stringify({ from: n.from, to: n.to, savedFor: initial.today.slice(0, 7) }));
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
  const pending = useRef<Set<DataSection> | null>(null);
  const loading = useRef<Promise<void> | null>(null);
  const refresh = useCallback(
    (sections: DataSection[] = DATA_SECTIONS): Promise<void> => {
      pending.current = new Set([...(pending.current || []), ...sections]);
      if (loading.current) return loading.current;
      loading.current = (async () => {
        while (pending.current) {
          const next = [...pending.current];
          pending.current = null;
          const full = DATA_SECTIONS.every((s) => next.includes(s));
          const requestedRevision = revision.current;
          try {
            const result = await api<DataBundle | BundlePatch>(full ? '/api/data' : '/api/data?sections=' + next.sort().join(','));
            // A mutation completed during this read: retry rather than letting an older response overwrite it.
            if (requestedRevision !== revision.current) {
              pending.current = new Set([...(pending.current || []), ...next]);
              continue;
            }
            if (!full && JSON.stringify(result.myAccess) !== JSON.stringify(dataRef.current.myAccess)) {
              // A revoked grant must clear every previously loaded module, not just the requested section.
              pending.current = new Set(DATA_SECTIONS);
              continue;
            }
            const refreshed = full ? (result as DataBundle) : ({ ...dataRef.current, ...result } as DataBundle);
            if (!full) {
              delete (refreshed as any).sections;
              for (const section of next)
                for (const key of SECTION_FIELDS[section]) {
                  if (result[key] == null) delete (refreshed as any)[key];
                }
            }
            dataRef.current = refreshed;
            setData(refreshed);
          } catch (e: any) {
            showToast({ msg: e.message, error: true });
          }
        }
      })().finally(() => {
        loading.current = null;
      });
      return loading.current;
    },
    [showToast],
  );
  const reload = useCallback(() => refresh(), [refresh]);

  // Collect successful writes for this operation, including multi-request actions and undo.
  // Concurrent operations see the union of their writes, which deliberately over-refreshes.
  const runAndRefresh = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      const sections = new Set<DataSection>();
      let full = false;
      let wrote = false;
      const onMutation = (event: Event) => {
        wrote = true;
        const affected = mutationSections((event as CustomEvent<string>).detail);
        if (!affected) full = true;
        else affected.forEach((s) => sections.add(s));
      };
      window.addEventListener('cf-mutation', onMutation);
      revision.current++;
      try {
        return await fn();
      } finally {
        window.removeEventListener('cf-mutation', onMutation);
        revision.current++;
        // Even a failed multi-step action may have saved its earlier requests.
        await refresh(!wrote || full ? DATA_SECTIONS : [...sections]);
      }
    },
    [refresh],
  );

  // változásfigyelés: percenként egyetlen sor (adat-verzió); a teljes adat csak akkor töltődik újra, ha változott
  // (a teljes újratöltés sok sort olvas – ezért nem percenként fut)
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
        const result = await api<{ versions: Record<string, number>; reload?: boolean }>('/api/entries/batch', {
          body: { ...b, expected, expectedSeries, label: msg },
        });
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
        // sorozat átnevezésekor a többi hónap neve és verziója is változott: teljes újratöltés;
        // a törölt tervek áthúzva megjelennek (kuka) – ehhez elég a pénzügyi adat frissítése
        if (result.reload) reload();
        else if (b.delete?.length && !b.purge) refresh(['ledger']);
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
    [reload, refresh, showToast],
  );

  const run = useCallback(
    async (fn: () => Promise<unknown>, msg?: string | ((result: any) => string), undo?: () => Promise<unknown>) => {
      try {
        const result = await runAndRefresh(fn);
        if (msg)
          showToast({
            msg: typeof msg === 'function' ? msg(result) : msg,
            undo: undo
              ? async () => {
                  setToast(null);
                  try {
                    await runAndRefresh(undo);
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
    [runAndRefresh, showToast],
  );

  const ix = useMemo(() => buildIndex(data), [data.groups, data.leaves, data.entries, data.accounts, data.settings, data.today]);
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
