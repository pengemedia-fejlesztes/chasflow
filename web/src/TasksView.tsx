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
  isOpen,
  canEditTask,
  canDeleteTask,
  DEFAULT_PERM,
  ADMIN_PERM,
  type TaskPerm,
} from '../../shared/tasks';
import { toCsv } from '../../shared/stock';
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
  const [mode, setMode] = useState<'kanban' | 'day' | 'week' | 'list' | 'table'>(() => (localStorage.getItem('cf-task-mode') as any) || 'kanban');
  const setM = (m: 'kanban' | 'day' | 'week' | 'list' | 'table') => {
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
  const [permsOpen, setPermsOpen] = useState(false);
  const { pName } = useTaskHelpers();
  const nq = normalizeText(q);
  const base = all
    .filter((t) => who === 'all' || String(t.assignee_id) === who)
    .filter((t) => !nq || normalizeText(`${t.title} ${t.note || ''} ${pName(t.partner_key)}`).includes(nq));
  const filtered = base.filter((t) => !types.size || types.has(t.type)).filter((t) => showDone || isOpen(t.status));
  const ws = weekStart(day);
  const days = weekDays(ws);
  const inRange = (t: Task) => (mode === 'week' ? days.some((d) => onDay(t, d)) : mode === 'day' ? onDay(t, day) : true);
  const cards = TASK_TYPES.filter(([k]) => k !== 'egyeb').map(([k, l]) => ({
    k,
    l,
    n: base.filter((t) => t.type === k && inRange(t)).length,
    open: base.filter((t) => t.type === k && isOpen(t.status)).length,
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
        {isAdmin && <Pill onClick={() => setPermsOpen(true)}>Jogosultságok</Pill>}
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
            ['kanban', 'Kanban'],
            ['day', 'Nap'],
            ['week', 'Hét'],
            ['list', 'Lista'],
            ['table', 'Táblázat'],
          ]}
        />
        {(mode === 'day' || mode === 'week') && (
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
      {mode === 'table' && <TaskTable tasks={all} onEdit={setEdit} />}
      {mode === 'kanban' && <Kanban tasks={filtered} onEdit={setEdit} />}
      {edit && (
        <TaskEditor
          task={edit === 'new' ? null : edit}
          defaults={{ due_date: mode === 'list' || mode === 'table' ? today : day }}
          onClose={() => setEdit(null)}
        />
      )}
      {permsOpen && <PermsDialog onClose={() => setPermsOpen(false)} />}
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
  const done = !isOpen(t.status);
  const perm = data.myTaskPerm || { ...DEFAULT_PERM, write: canEdit };
  const mayEdit = canEdit && canEditTask(t, data.me, perm);
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
          {mayEdit && t.status === 'nyitott' && (
            <RoundBtn label="Folyamatban" bg={C.blue} onClick={() => setStatus('folyamatban')}>
              ▶
            </RoundBtn>
          )}
          {mayEdit && !done && (
            <>
              <RoundBtn label="Kész" bg={C.inc} onClick={() => setStatus('kesz')}>
                ✓
              </RoundBtn>
              <RoundBtn label="Elmaradt" bg="#E3A33B" onClick={() => setStatus('elmaradt')}>
                ✕
              </RoundBtn>
            </>
          )}
          {mayEdit && done && (
            <Pill small onClick={() => setStatus('nyitott')}>
              Újranyitás
            </Pill>
          )}
          {mayEdit && (
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
                          opacity: isOpen(t.status) ? 0.9 : 1,
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
  const myPerm = data.myTaskPerm || { ...(isAdmin ? ADMIN_PERM : DEFAULT_PERM), write: true };
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
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={sel} disabled={!myPerm.assign}>
              {(data.taskUsers || [])
                .filter((u) => myPerm.assign || u.id === data.me.id || String(u.id) === assignee)
                .map((u) => (
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
          {task && canDeleteTask(task, data.me, myPerm) && (
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
  const open = all.filter((t) => isOpen(t.status));
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

export { useMyTaskCount } from './useMyTaskCount';

/** táblázat nézet szűrőpanellel (létrehozás dátuma, státusz, leírás, megbízó, megbízott, rendezés) és XLS-exporttal */
function TaskTable({ tasks, onEdit }: { tasks: Task[]; onEdit: (t: Task) => void }) {
  const { data, run, canEdit } = useStore();
  const { pName, uName } = useTaskHelpers();
  const perm = data.myTaskPerm || { ...DEFAULT_PERM, write: canEdit };
  const [open, setOpen] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | 'open' | TaskStatus>('open');
  const [text, setText] = useState('');
  const [by, setBy] = useState('');
  const [to2, setTo2] = useState('');
  const [sortBy, setSortBy] = useState<'due' | 'created' | 'status' | 'assignee'>('due');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const created = (t: Task) => new Date(t.created_at).toISOString().slice(0, 10);
  const nq = normalizeText(text);
  const rows = tasks
    .filter((t) => (!from || created(t) >= from) && (!to || created(t) <= to))
    .filter((t) => (status === '' ? true : status === 'open' ? isOpen(t.status) : t.status === status))
    .filter((t) => !nq || normalizeText(`${t.title} ${t.note || ''} ${pName(t.partner_key)}`).includes(nq))
    .filter((t) => !by || String(t.created_by ?? 'sys') === by)
    .filter((t) => !to2 || String(t.assignee_id) === to2)
    .sort((a, b) => {
      const k =
        sortBy === 'created'
          ? a.created_at - b.created_at
          : sortBy === 'status'
            ? TASK_STATUS_LABEL[a.status].localeCompare(TASK_STATUS_LABEL[b.status], 'hu')
            : sortBy === 'assignee'
              ? uName(a.assignee_id).localeCompare(uName(b.assignee_id), 'hu')
              : taskOrder(a, b);
      return (dir === 'asc' ? 1 : -1) * (k || taskOrder(a, b));
    });
  const exportCsv = () => {
    const csv = toCsv([
      ['Határidő', 'Időpont', 'Típus', 'Partner', 'Rövid leírás', 'Megbízó', 'Megbízott', 'Státusz', 'Létrehozva', 'Megjegyzés'],
      ...rows.map((t) => [
        t.due_date,
        t.due_time || '',
        TASK_TYPE_LABEL[t.type],
        pName(t.partner_key),
        t.title,
        t.created_by === null ? 'Rendszer' : uName(t.created_by),
        uName(t.assignee_id),
        TASK_STATUS_LABEL[t.status],
        created(t),
        t.note || '',
      ]),
    ]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `feladatok-${data.today}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const sel: CSSProperties = { ...inputStyle, height: 42 };
  const users = data.taskUsers || [];
  const STATUS_BG: Record<TaskStatus, [string, string]> = {
    nyitott: ['#7C8288', '#fff'],
    folyamatban: [C.blue, '#fff'],
    kesz: [C.inc, '#fff'],
    elmaradt: ['#E3A33B', '#fff'],
  };
  const COLS = '120px minmax(120px,0.9fr) minmax(120px,0.9fr) minmax(200px,2fr) 130px 96px';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...card, padding: '14px 18px' }}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            border: 0,
            background: 'transparent',
            padding: '2px 0',
            cursor: 'pointer',
            borderBottom: open ? `1px solid ${C.line}` : 0,
            paddingBottom: open ? 12 : 2,
          }}
        >
          <span style={{ font: `600 16px ${FONT}`, color: C.navy }}>⏷ Szűrés</span>
          <span style={{ font: `400 13px ${FONT}`, color: C.muted }}>({rows.length} db találat)</span>
          <span style={{ marginLeft: 'auto', color: C.neg }}>{open ? '⌃' : '⌄'}</span>
        </button>
        {open && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, paddingTop: 14 }}>
            <Field label="Létrehozás dátuma (-tól)">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={sel} />
            </Field>
            <Field label="Létrehozás dátuma (-ig)">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={sel} />
            </Field>
            <Field label="Státusz">
              <select value={status} onChange={(e) => setStatus(e.target.value as any)} style={sel}>
                <option value="open">Nyitott (kiosztott + folyamatban)</option>
                {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABEL[s]}
                  </option>
                ))}
                <option value="">Mind</option>
              </select>
            </Field>
            <Field label="Leírás">
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Keresett szöveg" style={sel} />
            </Field>
            <Field label="Megbízó">
              <select value={by} onChange={(e) => setBy(e.target.value)} style={sel}>
                <option value="">Mindenki</option>
                <option value="sys">Rendszer (automatikus)</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Megbízott">
              <select value={to2} onChange={(e) => setTo2(e.target.value)} style={sel}>
                <option value="">Mindenki</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Rendezés">
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} style={sel}>
                <option value="due">Határidő</option>
                <option value="created">Létrehozás</option>
                <option value="status">Státusz</option>
                <option value="assignee">Megbízott</option>
              </select>
            </Field>
            <Field label="Rendezés módja">
              <select value={dir} onChange={(e) => setDir(e.target.value as any)} style={sel}>
                <option value="asc">Növekvő</option>
                <option value="desc">Csökkenő</option>
              </select>
            </Field>
          </div>
        )}
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ minWidth: 860 }}>
          <div style={{ display: 'grid', gridTemplateColumns: `${COLS} 120px`, alignItems: 'center', background: C.navy, color: '#fff' }}>
            {['Határidő', 'Megbízó', 'Megbízott', 'Rövid leírás', 'Státusz', 'Típus'].map((h) => (
              <span key={h} style={{ padding: '14px 12px', font: `600 14px ${FONT}` }}>
                {h}
              </span>
            ))}
            <span style={{ padding: '8px 12px', textAlign: 'right' }}>
              <button
                type="button"
                onClick={exportCsv}
                aria-label="Exportálás CSV-be (Excel)"
                title="Exportálás CSV-be (Excel)"
                style={{ width: 36, height: 36, border: 0, borderRadius: 6, background: '#2E9E4F', color: '#fff', font: `700 12px ${FONT}`, cursor: 'pointer' }}
              >
                XLS
              </button>
            </span>
          </div>
          {!rows.length && (
            <div style={{ padding: 24, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Nincs a szűrésnek megfelelő feladat.</div>
          )}
          {rows.map((t) => {
            const late = isOverdue(t, data.today);
            const mayEdit = canEdit && canEditTask(t, data.me, perm);
            const mayDel = canEdit && canDeleteTask(t, data.me, perm);
            const [bg, fg] = STATUS_BG[t.status];
            return (
              <div
                key={t.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `${COLS} 120px`,
                  alignItems: 'center',
                  borderTop: `1px solid ${C.line3}`,
                  background: late ? C.negBg : '#fff',
                }}
              >
                <span style={{ padding: '12px', font: `500 14px ${FONT}`, color: late ? C.neg : C.ink }}>
                  {hu(t.due_date)}
                  {t.due_time ? <span style={{ display: 'block', font: `400 12.5px ${FONT}`, color: C.muted }}>{t.due_time}</span> : null}
                </span>
                <span style={{ padding: '12px', font: `400 14px ${FONT}`, color: C.ink }}>{t.created_by === null ? 'Rendszer' : uName(t.created_by)}</span>
                <span style={{ padding: '12px', font: `400 14px ${FONT}`, color: C.ink }}>{uName(t.assignee_id)}</span>
                <span style={{ padding: '12px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ font: `500 14.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                  </span>
                  {t.partner_key && <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>{pName(t.partner_key)}</span>}
                </span>
                <span style={{ padding: '12px' }}>
                  <span style={{ display: 'inline-block', padding: '6px 16px', borderRadius: 999, background: bg, color: fg, font: `600 13px ${FONT}` }}>
                    {TASK_STATUS_LABEL[t.status]}
                  </span>
                </span>
                <span style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: 6, font: `500 13px ${FONT}`, color: TYPE_COLOR[t.type] }}>
                  <TypeIcon type={t.type} size={16} /> {TASK_TYPE_LABEL[t.type]}
                </span>
                <span style={{ padding: '8px 12px', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {mayEdit && (
                    <button
                      type="button"
                      onClick={() => onEdit(t)}
                      aria-label="Szerkesztés"
                      title="Szerkesztés"
                      style={{
                        width: 36,
                        height: 36,
                        border: 0,
                        borderRadius: 6,
                        background: '#2E9E4F',
                        color: '#fff',
                        cursor: 'pointer',
                        font: `600 15px ${FONT}`,
                      }}
                    >
                      ✎
                    </button>
                  )}
                  {mayDel && (
                    <button
                      type="button"
                      aria-label="Törlés"
                      title="Törlés"
                      onClick={() =>
                        confirm(`Törlöd a feladatot: ${t.title}?`) &&
                        run(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' }), 'Feladat törölve')
                      }
                      style={{
                        width: 36,
                        height: 36,
                        border: 0,
                        borderRadius: 6,
                        background: C.neg,
                        color: '#fff',
                        cursor: 'pointer',
                        font: `600 15px ${FONT}`,
                      }}
                    >
                      🗑
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** admin: felhasználónkénti feladat-jogosultságok */
function PermsDialog({ onClose }: { onClose: () => void }) {
  const { data, run } = useStore();
  const users = (data.taskUsers || []).filter((u) => u.role !== 'admin');
  const admins = (data.taskUsers || []).filter((u) => u.role === 'admin');
  const [perms, setPerms] = useState<Record<string, TaskPerm>>(() =>
    Object.fromEntries(users.map((u) => [String(u.id), data.taskPerms?.[String(u.id)] || DEFAULT_PERM])),
  );
  const set = (id: number, k: keyof TaskPerm, v: unknown) => setPerms({ ...perms, [String(id)]: { ...perms[String(id)], [k]: v } });
  const sel: CSSProperties = { ...inputStyle, height: 38 };
  const save = async () => {
    if (await run(() => api('/api/task-perms', { method: 'PUT', body: perms }), 'Jogosultságok mentve')) onClose();
  };
  return (
    <Modal onClose={onClose} width={860} title="Feladat-jogosultságok" label="Feladat-jogosultságok">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 24px 24px' }}>
        <span style={{ font: `400 13.5px/1.5 ${FONT}`, color: C.muted }}>
          Adminok mindent látnak és módosíthatnak{admins.length ? ` (${admins.map((a) => a.name).join(', ')})` : ''}. Az olvasó szerepkörű felhasználó csak a
          sajátját látja és nem módosít. A felhasználók szerepköre a Beállítások › Felhasználók alatt állítható.
        </span>
        {!users.length && <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>Nincs nem admin felhasználó.</span>}
        {users.map((u) => {
          const p = perms[String(u.id)];
          return (
            <div
              key={u.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(140px,1fr) repeat(4, minmax(150px, 1fr))',
                gap: 10,
                alignItems: 'end',
                borderTop: `1px solid ${C.line3}`,
                paddingTop: 10,
              }}
            >
              <b style={{ font: `600 14.5px ${FONT}`, color: C.navy, paddingBottom: 10 }}>
                {u.name}
                {u.role === 'viewer' ? <span style={{ font: `400 12px ${FONT}`, color: C.muted }}> · olvasó</span> : null}
              </b>
              <Field label="Mit lát">
                <select value={p.view} onChange={(e) => set(u.id, 'view', e.target.value)} style={sel}>
                  <option value="own">Csak a sajátját</option>
                  <option value="all">Mindenki feladatát</option>
                </select>
              </Field>
              <Field label="Kioszthat másnak">
                <select value={p.assign ? '1' : '0'} onChange={(e) => set(u.id, 'assign', e.target.value === '1')} style={sel}>
                  <option value="1">Igen</option>
                  <option value="0">Nem (csak magának)</option>
                </select>
              </Field>
              <Field label="Más feladatát szerkesztheti">
                <select value={p.editOthers ? '1' : '0'} onChange={(e) => set(u.id, 'editOthers', e.target.value === '1')} style={sel}>
                  <option value="0">Nem</option>
                  <option value="1">Igen (amit lát)</option>
                </select>
              </Field>
              <Field label="Törölhet">
                <select value={p.del} onChange={(e) => set(u.id, 'del', e.target.value)} style={sel}>
                  <option value="own">Amit ő hozott létre</option>
                  <option value="all">Bármit, amit lát</option>
                  <option value="none">Semmit</option>
                </select>
              </Field>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={save}
            style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '11px 24px', font: `600 14.5px ${FONT}`, cursor: 'pointer' }}
          >
            Mentés
          </button>
          <Pill small onClick={onClose}>
            Mégse
          </Pill>
        </div>
      </div>
    </Modal>
  );
}

type KanbanBy = 'status' | 'assignee' | 'type';

/** Kanban tábla: oszloponként státusz (vagy felelős, típus); kártya áthúzásával módosul a mező */
function Kanban({ tasks, onEdit }: { tasks: Task[]; onEdit: (t: Task) => void }) {
  const { data, run, canEdit } = useStore();
  const { pName, uName } = useTaskHelpers();
  const perm = data.myTaskPerm || { ...DEFAULT_PERM, write: canEdit };
  const [by, setBy0] = useState<KanbanBy>(() => {
    try {
      return (localStorage.getItem('cf-kanban-by') as KanbanBy) || 'status';
    } catch {
      return 'status';
    }
  });
  const setBy = (v: KanbanBy) => {
    setBy0(v);
    try {
      localStorage.setItem('cf-kanban-by', v);
    } catch {
      /* privát mód */
    }
  };
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const cols: { key: string; label: string; color: string }[] =
    by === 'status'
      ? (Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((k) => ({
          key: k,
          label: TASK_STATUS_LABEL[k],
          color: k === 'kesz' ? C.inc : k === 'elmaradt' ? '#E3A33B' : k === 'folyamatban' ? C.blue : '#7C8288',
        }))
      : by === 'type'
        ? TASK_TYPES.map(([k, l]) => ({ key: k, label: l, color: TYPE_COLOR[k] }))
        : [
            ...(data.taskUsers || []).map((u) => ({ key: String(u.id), label: u.name, color: C.navy })),
            { key: 'none', label: 'Nincs felelős', color: '#7C8288' },
          ];
  const keyOf = (t: Task) => (by === 'status' ? t.status : by === 'type' ? t.type : t.assignee_id === null ? 'none' : String(t.assignee_id));
  const move = (t: Task, key: string) => {
    if (keyOf(t) === key) return;
    if (by === 'assignee' && !perm.assign && key !== String(data.me.id)) return alert('Másnak nem oszthatsz ki feladatot.');
    const body = by === 'status' ? { status: key } : by === 'type' ? { type: key } : { assignee_id: key === 'none' ? null : Number(key) };
    const back = by === 'status' ? { status: t.status } : by === 'type' ? { type: t.type } : { assignee_id: t.assignee_id };
    const label = cols.find((c) => c.key === key)?.label || key;
    run(
      () => api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'PUT', body }),
      `${t.title} → ${label}`,
      () => api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'PUT', body: back }),
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: `500 13.5px ${FONT}`, color: C.muted }}>Oszlopok:</span>
        <Seg
          small
          value={by}
          onChange={setBy}
          options={[
            ['status', 'Státusz'],
            ['assignee', 'Felelős'],
            ['type', 'Típus'],
          ]}
        />
        <span style={{ marginLeft: 'auto', font: `400 13px ${FONT}`, color: C.muted }}>Húzd a kártyát másik oszlopba · kattintás = szerkesztés</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(250px, 1fr)',
          gap: 12,
          overflowX: 'auto',
          paddingBottom: 6,
          alignItems: 'start',
        }}
      >
        {cols.map((c) => {
          const list = tasks.filter((t) => keyOf(t) === c.key).sort(taskOrder);
          const late = list.filter((t) => isOverdue(t, data.today)).length;
          return (
            <div
              key={c.key}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                setOver(c.key);
              }}
              onDragLeave={() => setOver((o) => (o === c.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const t = tasks.find((x) => x.id === drag);
                setDrag(null);
                setOver(null);
                if (t) move(t, c.key);
              }}
              style={{
                background: over === c.key ? C.bg2 : '#EEECE6',
                borderRadius: 10,
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                minHeight: 160,
                outline: over === c.key ? `2px dashed ${C.blue}` : 'none',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 4px 6px', borderBottom: `3px solid ${c.color}` }}>
                <b style={{ font: `700 15px ${FONT}`, color: C.navy }}>{c.label}</b>
                <span style={{ font: `400 12.5px ${FONT}`, color: late ? C.neg : C.muted }}>
                  {list.length} feladat{late ? ` · ${late} lejárt` : ''}
                </span>
              </div>
              {list.map((t) => {
                const mayEdit = canEdit && canEditTask(t, data.me, perm);
                const lateT = isOverdue(t, data.today);
                return (
                  <div
                    key={t.id}
                    draggable={mayEdit}
                    onDragStart={(e) => {
                      setDrag(t.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => (setDrag(null), setOver(null))}
                    onClick={() => mayEdit && onEdit(t)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${t.title} – ${TASK_STATUS_LABEL[t.status]}`}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && mayEdit && (e.preventDefault(), onEdit(t))}
                    style={{
                      background: '#fff',
                      border: `1px solid ${C.line}`,
                      borderTop: `3px solid ${TYPE_COLOR[t.type]}`,
                      borderRadius: 8,
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      cursor: mayEdit ? 'grab' : 'default',
                      opacity: drag === t.id ? 0.5 : !isOpen(t.status) && by !== 'status' ? 0.65 : 1,
                      boxShadow: '0 1px 2px rgba(20,35,58,.06)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <b style={{ flex: 1, font: `600 14px/1.35 ${FONT}`, color: C.navy }}>{t.title}</b>
                      <span title={TASK_TYPE_LABEL[t.type]}>
                        <TypeIcon type={t.type} size={17} />
                      </span>
                    </div>
                    {t.partner_key && <span style={{ font: `400 12.5px ${FONT}`, color: C.ink }}>{pName(t.partner_key)}</span>}
                    <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>{by !== 'assignee' ? uName(t.assignee_id) : TASK_STATUS_LABEL[t.status]}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, font: `500 12.5px ${FONT}`, color: lateT ? C.neg : C.muted }}>
                      ⚑ {hu(t.due_date)}
                      {t.due_time ? ` ${t.due_time}` : ''}
                      {lateT ? ' · lejárt' : ''}
                    </span>
                  </div>
                );
              })}
              {!list.length && <span style={{ font: `400 12.5px ${FONT}`, color: C.faint, padding: '6px 4px' }}>Nincs feladat.</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
