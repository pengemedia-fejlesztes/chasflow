// Főmenü: csoportok ikonnal és lenyíló almenüvel (gépen az oldalsávban, mobilon a kihúzható menüben ugyanez).
// Egy almenüpont egy nézetre visz; ha a nézetnek van belső füle (Bankszinkron, Feladatok), az almenüpont azt is kiválasztja.
import { useState, type ReactNode } from 'react';
import { C, FONT, R } from './ui';

export type NavView = 'overview' | 'charts' | 'tasks' | 'alerts' | 'cat' | 'income' | 'bank' | 'partners' | 'products' | 'stock' | 'breakeven' | 'settings';

export interface NavLeaf {
  id: string;
  view: NavView;
  label: string;
  badge?: number;
  /** a nézet belső füle: [tároló, kulcs, érték] – megnyitás előtt beállítjuk */
  sub?: ['session' | 'local', string, string];
}
interface NavGroup {
  id: string;
  label: string;
  icon: ReactNode;
  items: NavLeaf[];
}

const I = ({ d }: { d: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICON = {
  home: <I d="M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10" />,
  money: <I d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  users: <I d="M16 20v-1.5a4 4 0 00-4-4H6a4 4 0 00-4 4V20M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7M22 20v-1.5a4 4 0 00-3-3.9M16 4.1a3.5 3.5 0 010 6.8" />,
  tasks: <I d="M9 11l2.5 2.5L16 9M4 4h16v16H4z" />,
  box: <I d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8" />,
  gear: <I d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15H3a2 2 0 110-4h.1a1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 009 4.6V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 11h.1a2 2 0 010 4H21z" />,
};

export function navGroups(b: { tasks: number; alerts: number; income: number; bank: number }): NavGroup[] {
  return [
    {
      id: 'g-over',
      label: 'Áttekintés',
      icon: ICON.home,
      items: [
        { id: 'overview', view: 'overview', label: 'Havi áttekintés' },
        { id: 'charts', view: 'charts', label: 'Grafikonok' },
        { id: 'breakeven', view: 'breakeven', label: 'Fedezeti pont' },
      ],
    },
    {
      id: 'g-money',
      label: 'Pénzügyek',
      icon: ICON.money,
      items: [
        { id: 'income', view: 'income', label: 'Tervezett bevételek, kiadások', badge: b.income },
        { id: 'alerts', view: 'alerts', label: 'Összevonás (terv – számla – tény)', badge: b.alerts },
        { id: 'bank-inbox', view: 'bank', label: 'Bankszinkron – új tételek', badge: b.bank, sub: ['session', 'cf-bank-tab', 'inbox'] },
        { id: 'bank-ledger', view: 'bank', label: 'Számlatörténet és készpénz', sub: ['session', 'cf-bank-tab', 'ledger'] },
      ],
    },
    { id: 'g-partners', label: 'Ügyfelek', icon: ICON.users, items: [{ id: 'partners', view: 'partners', label: 'Partnertörzs' }] },
    {
      id: 'g-tasks',
      label: 'Feladatok',
      icon: ICON.tasks,
      items: [
        { id: 'tasks-kanban', view: 'tasks', label: 'Kanban tábla', badge: b.tasks, sub: ['local', 'cf-task-mode', 'kanban'] },
        { id: 'tasks-day', view: 'tasks', label: 'Mai nap', sub: ['local', 'cf-task-mode', 'day'] },
        { id: 'tasks-week', view: 'tasks', label: 'Heti nézet', sub: ['local', 'cf-task-mode', 'week'] },
        { id: 'tasks-table', view: 'tasks', label: 'Táblázat, szűrők', sub: ['local', 'cf-task-mode', 'table'] },
      ],
    },
    {
      id: 'g-stock',
      label: 'Termékek, raktár',
      icon: ICON.box,
      items: [
        { id: 'products', view: 'products', label: 'Termékek, szolgáltatások' },
        { id: 'stock', view: 'stock', label: 'Raktárkészlet' },
      ],
    },
    { id: 'g-settings', label: 'Beállítások', icon: ICON.gear, items: [{ id: 'settings', view: 'settings', label: 'Beállítások' }] },
  ];
}

/** a belső fül beállítása megnyitás előtt */
export function applySub(l: NavLeaf) {
  if (!l.sub) return;
  try {
    (l.sub[0] === 'session' ? sessionStorage : localStorage).setItem(l.sub[1], l.sub[2]);
  } catch {
    /* privát mód: marad az alapfül */
  }
}

function readSub(l: NavLeaf): string | null {
  if (!l.sub) return null;
  try {
    return (l.sub[0] === 'session' ? sessionStorage : localStorage).getItem(l.sub[1]);
  } catch {
    return null;
  }
}

const OPEN_KEY = 'cf-nav-open';

export function NavMenu({
  view,
  allowed,
  badges,
  onPick,
  hide = [],
}: {
  view: string;
  allowed: (v: NavView) => boolean;
  badges: { tasks: number; alerts: number; income: number; bank: number };
  onPick: (l: NavLeaf) => void;
  /** nézetek, amelyek ezen a felületen nem érhetők el */
  hide?: NavView[];
}) {
  const groups = navGroups(badges)
    .map((g) => ({ ...g, items: g.items.filter((l) => allowed(l.view) && !hide.includes(l.view)) }))
    .filter((g) => g.items.length);
  const [open, setOpen0] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
    } catch {
      return {};
    }
  });
  const setOpen = (id: string, v: boolean) => {
    const n = { ...open, [id]: v };
    setOpen0(n);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(n));
    } catch {
      /* nem baj */
    }
  };
  // az aktuális nézet almenüpontja: fülös nézetnél a tárolt fül alapján
  const activeId = (() => {
    const cands = groups.flatMap((g) => g.items).filter((l) => l.view === view);
    return (cands.find((l) => l.sub && readSub(l) === l.sub[2]) || cands[0])?.id;
  })();

  return (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }} aria-label="Főmenü">
      {groups.map((g) => {
        const single = g.items.length === 1;
        const hasActive = g.items.some((l) => l.id === activeId);
        const isOpen = !single && (open[g.id] ?? hasActive);
        const sum = g.items.reduce((s, l) => s + (l.badge || 0), 0);
        return (
          <div key={g.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <button
              className="side-btn"
              aria-expanded={single ? undefined : isOpen}
              aria-current={single && hasActive ? 'page' : undefined}
              onClick={() => (single ? onPick(g.items[0]) : setOpen(g.id, !isOpen))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                border: 0,
                cursor: 'pointer',
                textAlign: 'left',
                padding: '11px 12px',
                borderRadius: R.md,
                background: single && hasActive ? C.navy3 : 'transparent',
                color: '#fff',
                font: `600 14.5px ${FONT}`,
              }}
            >
              <span style={{ display: 'grid', placeItems: 'center', color: hasActive ? '#fff' : C.blue2 }}>{g.icon}</span>
              <span style={{ flex: 1 }}>{g.label}</span>
              {sum > 0 && (!isOpen || single) && <Badge n={sum} warn={g.id === 'g-money' && badges.alerts > 0} />}
              {!single && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  aria-hidden="true"
                  style={{ color: C.muted2, transition: 'transform .2s ease', transform: isOpen ? 'rotate(90deg)' : 'none' }}
                >
                  <path d="M9 5l7 7-7 7" />
                </svg>
              )}
            </button>
            {!single && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateRows: isOpen ? '1fr' : '0fr',
                  transition: 'grid-template-rows .22s ease',
                }}
              >
                <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {g.items.map((l) => {
                    const act = l.id === activeId;
                    return (
                      <button
                        key={l.id}
                        className="side-btn"
                        aria-current={act ? 'page' : undefined}
                        tabIndex={isOpen ? 0 : -1}
                        onClick={() => onPick(l)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          border: 0,
                          cursor: 'pointer',
                          textAlign: 'left',
                          margin: '0 0 0 22px',
                          padding: '8px 12px 8px 20px',
                          borderLeft: `2px solid ${act ? C.blue2 : 'rgba(255,255,255,.12)'}`,
                          borderRadius: `0 ${R.md}px ${R.md}px 0`,
                          background: act ? C.navy3 : 'transparent',
                          color: act ? '#fff' : C.muted2,
                          font: `${act ? 600 : 500} 13.5px ${FONT}`,
                        }}
                      >
                        <span style={{ flex: 1 }}>{l.label}</span>
                        {(l.badge || 0) > 0 && <Badge n={l.badge!} warn={l.view === 'alerts'} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

const Badge = ({ n, warn }: { n: number; warn?: boolean }) => (
  <span
    style={{
      minWidth: 22,
      textAlign: 'center',
      background: warn ? C.negLight : C.blue2,
      color: C.navy,
      borderRadius: 999,
      padding: '1px 7px',
      font: `700 11.5px ${FONT}`,
    }}
  >
    {n}
  </span>
);
