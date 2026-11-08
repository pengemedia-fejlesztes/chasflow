// Feladatok: napi idővonal, heti ütemező (mikor mi történik) és lista. Típus (telefon, e-mail, megbeszélés,
// megrendelés, szerződés), partner, felelős, nap + óra, állapot (nyitott / kész / elmaradt). Admin felhasználónként szűrhet.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { normalizeText } from '../../shared/categories';
import {
  TASK_STATUS_LABEL,
  TASK_TYPES,
  TASK_TYPE_LABEL,
  isOverdue,
  onDay,
  taskOrder,
  weekDays,
  weekStart,
  type Task,
  type TaskStatus,
  type TaskType,
} from '../../shared/tasks';
import { addDays, dayNameHu } from '../../shared/workdays';
import { api } from './api';
import { useAllPartners } from './PartnerCard';
import { useStore } from './store';
import { C, FONT, FONT_H, Field, Modal, Pill, Seg, card, inputStyle, R } from './ui';

export const TYPE_COLOR: Record<TaskType, string> = {
  telefon: '#B4651E',
  email: '#1F6FB2',
  megbeszeles: '#7A4FA8',
  megrendeles: '#1D6A46',
  szerzodes: '#14233A',
  egyeb: '#626A75',
};

export function TypeIcon({ type, size = 18, color }: { type: TaskType; size?: number; color?: string }) {
  const c = color || TYPE_COLOR[type];
  const p = { fill: 'none', stroke: c, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {type === 'telefon' && (
        <>
          <rect x="7" y="2.5" width="10" height="19" rx="2" {...p} />
          <path d="M11 18.5h2" {...p} />
        </>
      )}
      {type === 'email' && (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" {...p} />
          <path d="M3.5 6.5 12 13l8.5-6.5" {...p} />
        </>
      )}
      {type === 'megbeszeles' && (
        <>
          <circle cx="8" cy="8" r="3" {...p} />
          <circle cx="16" cy="8" r="3" {...p} />
          <path d="M2.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M10.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" {...p} />
        </>
      )}
      {type === 'megrendeles' && (
        <>
          <path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H7" {...p} />
          <circle cx="9.5" cy="19" r="1.4" {...p} />
          <circle cx="17" cy="19" r="1.4" {...p} />
        </>
      )}
      {type === 'szerzodes' && (
        <>
          <path d="M6 2.5h8l4 4v15H6z" {...p} />
          <path d="M14 2.5v4h4M9 12h6M9 16h4" {...p} />
        </>
      )}
      {type === 'egyeb' && (
        <>
          <circle cx="12" cy="12" r="9" {...p} />
          <path d="M8 12h8M12 8v8" {...p} />
        </>
      )}
    </svg>
  );
}

const hu = (d: string) => `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}.`;
const md = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}.`;
const SHORT_DAY = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];
const th: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted };

function useTaskHelpers() {
  const { data } = useStore();
  const partners = useAllPartners();
  const pName = (k: string | null) => (k ? partners.find((p) => p.key === k)?.name || k : '');
  const uName = (id: number | null) => (id === null ? '–' : data.taskUsers?.find((u) => u.id === id)?.name || 'ismeretlen');
  return { pName, uName, partners };
}

export function TasksView() {
  const { data, isAdmin, canEdit } = useStore();
  const today = data.today;
  const all = data.tasks || [];
  const [mode, setMode] = useState<'day' | 'week' | 'list'>(() => (localStorage.getItem('cf-task-mode') as any) || 'day');
  const setM = (m: 'day' | 'week' | 'list') => {
    setMode(m);
    try {
      localStorage.setItem('cf-task-mode', m);
    } catch {
      /* privát mód */
    }
  };
  const [day, setDay] = useState(today);
  const [who, setWho] = useState<string>(isAdmin ? 'all' : String(data.me.id));
  const [types, setTypes] = useState<Set<TaskType>>(new Set());
  const [showDone, setShowDone] = useState(true);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Task | 'new' | null>(null);
  const { pName } = useTaskHelpers();
  const nq = normalizeText(q);
  const base = all
    .filter((t) => who === 'all' || String(t.assignee_id) === who)
    .filter((t) => !nq || normalizeText(`${t.title} ${t.note || ''} ${pName(t.partner_key)}`).includes(nq));
  const filtered = base.filter((t) => !types.size || types.has(t.type)).filter((t) => showDone || t.status === 'nyitott');
  const ws = weekStart(day);
  const days = weekDays(ws);
  const inRange = (t: Task) => (mode === 'week' ? days.some((d) => onDay(t, d)) : mode === 'day' ? onDay(t, day) : true);
  const cards = TASK_TYPES.filter(([k]) => k !== 'egyeb').map(([k, l]) => ({
    k,
    l,
    n: base.filter((t) => t.type === k && inRange(t)).length,
    open: base.filter((t) => t.type === k && t.status === 'nyitott').length,
  }));
  const overdue = filtered.filter((t) => isOverdue(t, today)).sort(taskOrder);
  const shift = (n: number) => setDay(addDays(day, mode === 'week' ? 7 * n : n));
  const label = mode === 'week' ? `${hu(days[0])} – ${md(days[6])}` : `${hu(day)} ${dayNameHu(day)}`;
  return (
    <div style={{ padding: '24px 28px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, font: `800 32px/1.05 ${FONT_H}`, color: C.navy }}>Feladatok</h1>
          <p style={{ margin: '8px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted }}>
            Kit kell hívni, kinek kell írni, mi vár megrendelésre vagy szerződésre – napra és órára, felelőssel. A partner adatlapján is látszik.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            className="hov-primary"
            onClick={() => setEdit('new')}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '12px 22px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
          >
            + Új feladat
          </button>
        )}
      </div>
      {data.tasksError && <div style={{ ...card, padding: 14, color: C.neg, font: `500 14px ${FONT}` }}>{data.tasksError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {cards.map((c) => {
          const on = types.has(c.k);
          return (
            <button
              key={c.k}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const n = new Set(types);
                if (on) n.delete(c.k);
                else n.add(c.k);
                setTypes(n);
              }}
              style={{
                ...card,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                textAlign: 'left',
                cursor: 'pointer',
                borderColor: on ? TYPE_COLOR[c.k] : C.line,
                boxShadow: on ? `inset 0 0 0 1px ${TYPE_COLOR[c.k]}` : undefined,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 38, height: 38, borderRadius: 10, background: TYPE_COLOR[c.k] + '14', display: 'grid', placeItems: 'center' }}>
                  <TypeIcon type={c.k} size={22} />
                </span>
                <span style={{ flex: 1, font: `500 13.5px ${FONT}`, color: C.muted }}>{c.l}</span>
                <b style={{ font: `800 26px ${FONT_H}`, color: C.navy }}>{c.n}</b>
              </span>
              <span style={{ font: `500 12.5px ${FONT}`, color: c.open ? C.ink : C.faint, borderTop: `1px solid ${C.line3}`, paddingTop: 6 }}>
                Nyitott: {c.open}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ ...card, padding: '12px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg
          value={mode}
          onChange={setM}
          options={[
            ['day', 'Nap'],
            ['week', 'Hét'],
            ['list', 'Lista'],
          ]}
        />
        {mode !== 'list' && (
          <>
            <Pill small onClick={() => shift(-1)}>
              ‹
            </Pill>
            <b style={{ font: `700 16px ${FONT}`, color: C.navy, minWidth: 190, textAlign: 'center' }}>{label}</b>
            <Pill small onClick={() => shift(1)}>
              ›
            </Pill>
            {day !== today && (
              <Pill small onClick={() => setDay(today)}>
                Ma
              </Pill>
            )}
          </>
        )}
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Felelős" style={{ ...inputStyle, height: 38, width: 200 }}>
          {isAdmin && <option value="all">Mindenki</option>}
          {(data.taskUsers || [])
            .filter((u) => isAdmin || u.id === data.me.id)
            .map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.id === data.me.id ? `${u.name} (én)` : u.name}
              </option>
            ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Keresés: partner, feladat…"
          aria-label="Feladat keresése"
          style={{ ...inputStyle, height: 38, width: 230, borderRadius: 999, padding: '0 14px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, font: `500 13.5px ${FONT}`, color: C.muted }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> lezártak is
        </label>
        {types.size > 0 && (
          <Pill small onClick={() => setTypes(new Set())}>
            Szűrés törlése
          </Pill>
        )}
      </div>

      {mode === 'day' && (
        <DayTimeline
          tasks={filtered.filter((t) => onDay(t, day)).sort(taskOrder)}
          overdue={day === today ? overdue.filter((t) => !onDay(t, day)) : []}
          onEdit={setEdit}
          empty={`${hu(day)}: nincs feladat.`}
        />
      )}
      {mode === 'week' && <WeekGrid tasks={filtered.filter((t) => days.some((d) => onDay(t, d))).sort(taskOrder)} days={days} onEdit={setEdit} />}
      {mode === 'list' && <TaskList tasks={filtered.sort(taskOrder)} onEdit={setEdit} />}
      {edit && <TaskEditor task={edit === 'new' ? null : edit} defaults={{ due_date: mode === 'list' ? today : day }} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** napi idővonal (a mintád szerint): bal oldalt a kártyák, középen a típus ikonja */
function DayTimeline({ tasks, overdue, onEdit, empty }: { tasks: Task[]; overdue: Task[]; onEdit: (t: Task) => void; empty: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {overdue.length > 0 && (
        <>
          <span style={{ ...th, color: C.neg }}>Lejárt, még nyitott ({overdue.length})</span>
          {overdue.map((t) => (
            <TaskCard key={t.id} t={t} onEdit={onEdit} />
          ))}
          <span style={th}>A nap feladatai</span>
        </>
      )}
      {!tasks.length && (
        <div className="empty-state" style={{ ...card, padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>
          {empty}
        </div>
      )}
      {tasks.map((t) => (
        <TaskCard key={t.id} t={t} onEdit={onEdit} />
      ))}
    </div>
  );
}

export function TaskCard({ t, onEdit, hidePartner }: { t: Task; onEdit: (t: Task) => void; hidePartner?: boolean }) {
  const { data, run, canEdit, openPartner } = useStore();
  const { pName, uName } = useTaskHelpers();
  const late = isOverdue(t, data.today);
  const setStatus = (s: TaskStatus) =>
    run(
      () => api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'PUT', body: { status: s } }),
      `${t.title}: ${TASK_STATUS_LABEL[s].toLowerCase()}`,
      () => api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'PUT', body: { status: t.status } }),
    );
  const done = t.status !== 'nyitott';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 52px', gap: 14, alignItems: 'start' }}>
      <div
        style={{
          ...card,
          padding: '14px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: late ? C.negBg : '#fff',
          borderColor: late ? C.negLight : C.line,
          opacity: done ? 0.7 : 1,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!hidePartner && t.partner_key && (
            <button
              type="button"
              onClick={() => openPartner(t.partner_key)}
              style={{
                border: 0,
                borderRadius: 999,
                background: C.blue,
                color: '#fff',
                padding: '3px 10px',
                font: `700 11.5px ${FONT}`,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {pName(t.partner_key)}
            </button>
          )}
          <span style={{ font: `600 12.5px ${FONT}`, color: TYPE_COLOR[t.type] }}>{TASK_TYPE_LABEL[t.type]}</span>
          {done && (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                background: t.status === 'kesz' ? C.incBg || '#E7F2EC' : C.bg,
                font: `600 12px ${FONT}`,
                color: t.status === 'kesz' ? C.inc : C.muted,
              }}
            >
              {TASK_STATUS_LABEL[t.status]}
            </span>
          )}
          {late && <span style={{ font: `600 12.5px ${FONT}`, color: C.neg }}>lejárt</span>}
        </div>
        <b style={{ font: `500 16px/1.4 ${FONT}`, color: C.ink, textDecoration: t.status === 'elmaradt' ? 'line-through' : undefined }}>{t.title}</b>
        {t.note && <span style={{ font: `400 13.5px/1.5 ${FONT}`, color: C.muted, whiteSpace: 'pre-wrap' }}>{t.note}</span>}
        <span style={{ font: `400 13.5px ${FONT}`, color: C.ink }}>
          <b>{uName(t.assignee_id)}</b> <span style={{ color: C.muted }}>(felelős)</span>
          {t.created_by !== null && t.created_by !== t.assignee_id ? <span style={{ color: C.muted }}> · kiosztotta: {uName(t.created_by)}</span> : null}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${C.line3}`, paddingTop: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, font: `500 13.5px ${FONT}`, color: late ? C.neg : C.muted }}>
            ◷ Határidő: {hu(t.due_date)}
            {t.due_time ? ` ${t.due_time}` : ''}
            {t.end_date ? ` – ${hu(t.end_date)}` : ''}
          </span>
          {canEdit && t.status === 'nyitott' && (
            <>
              <RoundBtn label="Kész" bg={C.inc} onClick={() => setStatus('kesz')}>
                ✓
              </RoundBtn>
              <RoundBtn label="Elmaradt" bg="#E3A33B" onClick={() => setStatus('elmaradt')}>
                ✕
              </RoundBtn>
            </>
          )}
          {canEdit && done && (
            <Pill small onClick={() => setStatus('nyitott')}>
              Újranyitás
            </Pill>
          )}
          {canEdit && (
            <RoundBtn label="Szerkesztés" bg={C.muted} onClick={() => onEdit(t)}>
              ✎
            </RoundBtn>
          )}
        </div>
      </div>
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 999,
          background: TYPE_COLOR[t.type],
          display: 'grid',
          placeItems: 'center',
          marginTop: 18,
        }}
        title={TASK_TYPE_LABEL[t.type]}
      >
        <TypeIcon type={t.type} size={22} color="#fff" />
      </span>
    </div>
  );
}

function RoundBtn({ children, bg, onClick, label }: { children: ReactNode; bg: string; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 34,
        height: 34,
        borderRadius: 999,
        border: 0,
        background: bg,
        color: '#fff',
        font: `700 16px ${FONT}`,
        cursor: 'pointer',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {children}
    </button>
  );
}

/** heti ütemező: soronként egy feladat, oszloponként a hét napjai; a sáv a kezdő és a záró nap között */
function WeekGrid({ tasks, days, onEdit }: { tasks: Task[]; days: string[]; onEdit: (t: Task) => void }) {
  const { data } = useStore();
  const { pName, uName } = useTaskHelpers();
  const COLS = `minmax(280px,2fr) 96px 96px 56px repeat(${days.length}, minmax(56px, 1fr))`;
  const weekend = (i: number) => i >= 5;
  return (
    <div style={{ ...card, overflowX: 'auto' }}>
      <div style={{ minWidth: 900 }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, borderBottom: `1px solid ${C.line}`, background: C.bg }}>
          <span style={{ ...th, padding: '12px 14px' }}>Feladat</span>
          <span style={{ ...th, padding: '12px 6px' }}>Kezdés</span>
          <span style={{ ...th, padding: '12px 6px' }}>Vége</span>
          <span style={{ ...th, padding: '12px 6px', textAlign: 'center' }}>Kész</span>
          {days.map((d, i) => (
            <span
              key={d}
              style={{
                padding: '8px 4px',
                textAlign: 'center',
                borderLeft: `1px solid ${C.line3}`,
                background: d === data.today ? C.bg2 : weekend(i) ? '#ECEAE4' : undefined,
                font: `600 12.5px/1.3 ${FONT}`,
                color: d === data.today ? C.blueDark : C.navy,
              }}
            >
              {md(d)}
              <br />
              <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>{SHORT_DAY[i]}</span>
            </span>
          ))}
        </div>
        {!tasks.length && <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Ezen a héten nincs feladat.</div>}
        {tasks.map((t) => {
          const late = isOverdue(t, data.today);
          return (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: COLS, borderTop: `1px solid ${C.line3}`, alignItems: 'stretch', minHeight: 50 }}>
              <button
                type="button"
                onClick={() => onEdit(t)}
                style={{
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  padding: '8px 14px',
                  cursor: 'pointer',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  minWidth: 0,
                }}
              >
                <TypeIcon type={t.type} />
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <b style={{ font: `600 14px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.partner_key ? `${pName(t.partner_key)} · ` : ''}
                    {t.title}
                  </b>
                  <span style={{ font: `400 12.5px ${FONT}`, color: late ? C.neg : C.muted }}>
                    {uName(t.assignee_id)}
                    {t.due_time ? ` · ${t.due_time}` : ''}
                    {late ? ' · lejárt' : ''}
                  </span>
                </span>
              </button>
              <span style={{ padding: '0 6px', alignSelf: 'center', font: `400 13px ${FONT}`, color: C.ink }}>{hu(t.due_date)}</span>
              <span style={{ padding: '0 6px', alignSelf: 'center', font: `400 13px ${FONT}`, color: C.ink }}>{hu(t.end_date || t.due_date)}</span>
              <span
                style={{
                  alignSelf: 'center',
                  textAlign: 'center',
                  font: `700 15px ${FONT}`,
                  color: t.status === 'kesz' ? C.inc : t.status === 'elmaradt' ? C.neg : C.faint,
                }}
              >
                {t.status === 'kesz' ? '✓' : t.status === 'elmaradt' ? '✕' : '–'}
              </span>
              {days.map((d, i) => {
                const on = onDay(t, d);
                const first = on && (d === t.due_date || i === 0);
                const last = on && (d === (t.end_date || t.due_date) || i === days.length - 1);
                return (
                  <span
                    key={d}
                    onClick={on ? () => onEdit(t) : undefined}
                    style={{
                      borderLeft: `1px solid ${C.line3}`,
                      background: d === data.today ? C.bg2 + '80' : weekend(i) ? '#F1EFEA' : undefined,
                      padding: '12px 0',
                      cursor: on ? 'pointer' : 'default',
                    }}
                  >
                    {on && (
                      <span
                        title={`${TASK_TYPE_LABEL[t.type]} · ${t.title}`}
                        style={{
                          display: 'block',
                          height: '100%',
                          minHeight: 24,
                          marginLeft: first ? 4 : 0,
                          marginRight: last ? 4 : 0,
                          borderRadius: `${first ? 6 : 0}px ${last ? 6 : 0}px ${last ? 6 : 0}px ${first ? 6 : 0}px`,
                          background: t.status === 'kesz' ? '#7BC79A' : t.status === 'elmaradt' ? '#D9D5CC' : late ? '#E59A8D' : TYPE_COLOR[t.type],
                          opacity: t.status === 'nyitott' ? 0.9 : 1,
                          color: '#fff',
                          font: `600 11.5px/24px ${FONT}`,
                          textAlign: 'center',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {first && t.due_time ? t.due_time : ''}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskList({ tasks, onEdit }: { tasks: Task[]; onEdit: (t: Task) => void }) {
  const { data } = useStore();
  const groups = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      const k = isOverdue(t, data.today) ? 'Lejárt' : t.due_date;
      m.set(k, [...(m.get(k) || []), t]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === 'Lejárt' ? -1 : b[0] === 'Lejárt' ? 1 : a[0].localeCompare(b[0])));
  }, [tasks, data.today]);
  if (!tasks.length) return <div style={{ ...card, padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Nincs feladat.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {groups.map(([k, ts]) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ ...th, color: k === 'Lejárt' ? C.neg : C.muted }}>
            {k === 'Lejárt' ? 'Lejárt, még nyitott' : `${hu(k)} ${dayNameHu(k)}${k === data.today ? ' · ma' : ''}`}
          </span>
          {ts.map((t) => (
            <TaskCard key={t.id} t={t} onEdit={onEdit} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** új / szerkesztett feladat */
export function TaskEditor({ task, defaults, onClose }: { task: Task | null; defaults?: Partial<Task>; onClose: () => void }) {
  const { data, run, isAdmin } = useStore();
  const { partners, pName } = useTaskHelpers();
  const d = { ...defaults, ...(task || {}) };
  const [type, setType] = useState<TaskType>((d.type as TaskType) || 'telefon');
  const [title, setTitle] = useState(d.title || '');
  const [note, setNote] = useState(d.note || '');
  const [partner, setPartner] = useState(d.partner_key ? pName(d.partner_key) : '');
  const [assignee, setAssignee] = useState(String(d.assignee_id ?? data.me.id));
  const [due, setDue] = useState(d.due_date || data.today);
  const [time, setTime] = useState(d.due_time || '');
  const [end, setEnd] = useState(d.end_date || '');
  const [status, setStatus] = useState<TaskStatus>((d.status as TaskStatus) || 'nyitott');
  const [busy, setBusy] = useState(false);
  const pMatch = partners.find((p) => normalizeText(p.name) === normalizeText(partner));
  const save = async () => {
    if (busy) return;
    if (partner.trim() && !pMatch) {
      alert('Nincs ilyen partner – válassz a listából, vagy hagyd üresen.');
      return;
    }
    setBusy(true);
    const body = {
      type,
      title,
      note,
      partner_key: pMatch?.key || null,
      assignee_id: Number(assignee) || null,
      due_date: due,
      due_time: time || null,
      end_date: end || null,
      status,
    };
    const ok = await run(
      () => api(task ? `/api/tasks/${encodeURIComponent(task.id)}` : '/api/tasks', { method: task ? 'PUT' : 'POST', body }),
      task ? 'Feladat mentve' : 'Feladat felvéve',
    );
    setBusy(false);
    if (ok) onClose();
  };
  const remove = async () => {
    if (!task || !confirm(`Törlöd a feladatot: ${task.title}?`)) return;
    if (await run(() => api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }), 'Feladat törölve')) onClose();
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  return (
    <Modal onClose={onClose} width={640} title={task ? 'Feladat szerkesztése' : 'Új feladat'} label={task ? 'Feladat szerkesztése' : 'Új feladat'}>
      <form onSubmit={(e) => (e.preventDefault(), save())} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 24px 24px' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label="Típus">
          {TASK_TYPES.map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={type === k}
              onClick={() => setType(k)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                borderRadius: R.lg,
                border: `1.5px solid ${type === k ? TYPE_COLOR[k] : C.line2}`,
                background: type === k ? TYPE_COLOR[k] + '12' : '#fff',
                font: `600 13.5px ${FONT}`,
                color: type === k ? TYPE_COLOR[k] : C.ink,
                cursor: 'pointer',
              }}
            >
              <TypeIcon type={k} size={16} /> {l}
            </button>
          ))}
        </div>
        <Field label="Mi a feladat?">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={300}
            autoFocus
            placeholder="pl. Ajánlat egyeztetése, szerződés aláíratása"
            style={sel}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Field label="Partner">
            <input value={partner} onChange={(e) => setPartner(e.target.value)} list="cf-task-partners" placeholder="Kezdd gépelni…" style={sel} />
            <datalist id="cf-task-partners">
              {partners
                .filter((p) => !p.leaves.every((l) => l.archived))
                .map((p) => (
                  <option key={p.key} value={p.name} />
                ))}
            </datalist>
          </Field>
          <Field label="Felelős (ki csinálja)">
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              style={sel}
              disabled={!isAdmin && !!task && task.assignee_id !== data.me.id && task.created_by !== data.me.id}
            >
              {(data.taskUsers || []).map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nap">
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} required style={sel} />
          </Field>
          <Field label="Időpont (nem kötelező)">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={sel} />
          </Field>
          <Field label="Záró nap (több napos feladat)">
            <input type="date" value={end} min={due} onChange={(e) => setEnd(e.target.value)} style={sel} />
          </Field>
          <Field label="Állapot">
            <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} style={sel}>
              {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Megjegyzés">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={4000}
            style={{ ...inputStyle, height: 'auto', padding: 10, resize: 'vertical' }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className={busy ? 'is-loading' : undefined}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '11px 24px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
          >
            {task ? 'Mentés' : 'Felvétel'}
          </button>
          <Pill small onClick={onClose}>
            Mégse
          </Pill>
          {task && (
            <button
              type="button"
              onClick={remove}
              style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: C.neg, font: `600 14px ${FONT}`, cursor: 'pointer' }}
            >
              Törlés
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** partner adatlap · Feladatok fül: ki hívja, mikor, mi a teendő */
export function PartnerTasks({ partnerKey }: { partnerKey: string }) {
  const { data, canEdit } = useStore();
  const [edit, setEdit] = useState<Task | 'new' | null>(null);
  const [showDone, setShowDone] = useState(false);
  const all = (data.tasks || []).filter((t) => t.partner_key === partnerKey).sort(taskOrder);
  const open = all.filter((t) => t.status === 'nyitott');
  const list = showDone ? all : open;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ font: `700 19px ${FONT_H}`, color: C.navy, flex: 1 }}>Feladatok</b>
        <span style={{ font: `400 13.5px ${FONT}`, color: C.muted }}>
          {open.length} nyitott · {all.length - open.length} lezárt
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, font: `500 13.5px ${FONT}`, color: C.muted }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> lezártak is
        </label>
        {canEdit && (
          <Pill small kind="primary" onClick={() => setEdit('new')}>
            + Új feladat
          </Pill>
        )}
      </div>
      {!list.length && (
        <div className="empty-state" style={{ ...card, padding: 18, color: C.muted, font: `400 14px ${FONT}` }}>
          Nincs {showDone ? '' : 'nyitott '}feladat ennél a partnernél.
        </div>
      )}
      {list.map((t) => (
        <TaskCard key={t.id} t={t} onEdit={setEdit} hidePartner />
      ))}
      {edit && <TaskEditor task={edit === 'new' ? null : edit} defaults={{ partner_key: partnerKey, due_date: data.today }} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** a menüpont jelvénye: a saját, mára esedékes vagy lejárt nyitott feladatok száma */
export function useMyTaskCount() {
  const { data } = useStore();
  return (data.tasks || []).filter((t) => t.status === 'nyitott' && t.assignee_id === data.me.id && t.due_date <= data.today).length;
}
