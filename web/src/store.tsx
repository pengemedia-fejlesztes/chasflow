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
  commit: (b: EntryBatch, msg: string, opts?: { undoable?: boolean }) => Promise<void>;
  run: (fn: () => Promise<unknown>, msg?: string, undo?: () => Promise<unknown>) => Promise<boolean>;
  toast: Toast | null;
  showToast: (t: Toast | string) => void;
  canEdit: boolean;
  isAdmin: boolean;
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
        // az időszakot nem őrizzük meg napokon át, ha az már a múltba csúszott
        if (saved.savedFor === initial.today.slice(0, 7)) return { ...def, ...saved.f };
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
          localStorage.setItem(FKEY + ':' + initial.me.id, JSON.stringify({ f: n, savedFor: initial.today.slice(0, 7) }));
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

  const reload = useCallback(async () => {
    try {
      setData(await api<DataBundle>('/api/data'));
    } catch (e: any) {
      showToast({ msg: e.message, error: true });
    }
  }, [showToast]);

  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onFocus);
    const iv = window.setInterval(() => document.visibilityState === 'visible' && reload(), 120_000);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(iv);
    };
  }, [reload]);

  const dataRef = useRef(data);
  dataRef.current = data;

  const commit = useCallback(
    async (b: EntryBatch, msg: string, opts: { undoable?: boolean } = {}) => {
      const cur = dataRef.current;
      const inv = inverseOf(cur, b);
      setData(applyLocal(cur, b));
      try {
        await api('/api/entries/batch', { body: b });
        const undoable = opts.undoable !== false;
        showToast({
          msg,
          undo: undoable
            ? () => {
                setToast(null);
                commit(inv, 'Visszavonva', { undoable: false });
              }
            : undefined,
        });
      } catch (e: any) {
        showToast({ msg: e.message, error: true });
        reload();
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
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
