// Feladatok (CRM-események): telefon, e-mail, megbeszélés, megrendelés, szerződés – partnerhez és felhasználóhoz kötve,
// határidővel (nap + óra), opcionális záró nappal (a heti nézetben sávként), állapottal.
import { addDays, firstWorkday, isWorkday } from './workdays';

export type TaskType = 'telefon' | 'email' | 'megbeszeles' | 'megrendeles' | 'szerzodes' | 'egyeb';
export type TaskStatus = 'nyitott' | 'folyamatban' | 'kesz' | 'elmaradt';

export const TASK_TYPES: [TaskType, string][] = [
  ['telefon', 'Telefon'],
  ['email', 'E-mail'],
  ['megbeszeles', 'Megbeszélés'],
  ['megrendeles', 'Megrendelés'],
  ['szerzodes', 'Szerződés'],
  ['egyeb', 'Egyéb'],
];
export const TASK_TYPE_LABEL = Object.fromEntries(TASK_TYPES) as Record<TaskType, string>;
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { nyitott: 'Kiosztott', folyamatban: 'Folyamatban', kesz: 'Kész', elmaradt: 'Elmaradt' };
/** nyitott (még teendő) állapot: kiosztott vagy folyamatban */
export const isOpen = (s: TaskStatus | string) => s === 'nyitott' || s === 'folyamatban';

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  note: string | null;
  partner_key: string | null;
  assignee_id: number | null;
  created_by: number | null;
  /** határidő napja (YYYY-MM-DD) */
  due_date: string;
  /** időpont (HH:MM), opcionális */
  due_time: string | null;
  /** záró nap többnapos feladatnál (heti nézet sávja) */
  end_date: string | null;
  status: TaskStatus;
  done_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskUser {
  id: number;
  name: string;
  role?: string;
}

export const isOverdue = (t: Pick<Task, 'status' | 'due_date' | 'end_date'>, today: string) => isOpen(t.status) && (t.end_date || t.due_date) < today;

/** a feladat érinti-e a napot (kezdő és záró nap között) */
export const onDay = (t: Pick<Task, 'due_date' | 'end_date'>, day: string) => t.due_date <= day && (t.end_date || t.due_date) >= day;

/** a hét hétfője (YYYY-MM-DD) */
export function weekStart(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  const wd = (d.getUTCDay() + 6) % 7;
  return addDays(day, -wd);
}

export const weekDays = (start: string, n = 7) => Array.from({ length: n }, (_, i) => addDays(start, i));

/** rendezés: nap, időpont (időpont nélküliek a nap végén), létrehozás */
export const taskOrder = (a: Task, b: Task) =>
  a.due_date.localeCompare(b.due_date) || (a.due_time || '99').localeCompare(b.due_time || '99') || a.created_at - b.created_at;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TYPES = new Set(TASK_TYPES.map((t) => t[0]));
const STATUSES = new Set(['nyitott', 'folyamatban', 'kesz', 'elmaradt']);

/** a beküldött feladat ellenőrzése; hibánál magyar üzenetet dob */
export function cleanTask(b: Record<string, unknown>, cur?: Partial<Task>): Omit<Task, 'id' | 'created_by' | 'created_at' | 'updated_at' | 'done_at'> {
  const pick = <K extends keyof Task>(k: K) => (b[k] !== undefined ? b[k] : cur?.[k]);
  const type = String(pick('type') || 'egyeb');
  const title = String(pick('title') ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const due = String(pick('due_date') || '');
  const time = pick('due_time') ? String(pick('due_time')) : null;
  const end = pick('end_date') ? String(pick('end_date')) : null;
  const status = String(pick('status') || 'nyitott');
  const aid = pick('assignee_id');
  if (!title) throw new Error('Adj meg rövid leírást (mi a feladat).');
  if (!DATE.test(due)) throw new Error('Hibás határidő.');
  if (time && !TIME.test(time)) throw new Error('Hibás időpont (ÓÓ:PP).');
  if (end && (!DATE.test(end) || end < due)) throw new Error('A záró nap nem lehet a kezdő előtt.');
  const note = pick('note') ? String(pick('note')).trim().slice(0, 4000) || null : null;
  const partner = pick('partner_key') ? String(pick('partner_key')).trim().slice(0, 120) || null : null;
  return {
    type: (TYPES.has(type as TaskType) ? type : 'egyeb') as TaskType,
    title,
    note,
    partner_key: partner,
    assignee_id: aid === null || aid === undefined || aid === '' ? null : Number(aid) || null,
    due_date: due,
    due_time: time,
    end_date: end && end !== due ? end : null,
    status: (STATUSES.has(status) ? status : 'nyitott') as TaskStatus,
  };
}

// ── telefonos emlékeztető a számlázás előtt ──

/** a választható előfutási idők (nap) */
export const CALL_DAYS = [1, 3, 5, 7, 14, 21, 30, 45, 60];

/** alapértelmezés az ütem szerint (évente 30 nap, negyed- és félévente 7 nap; havi és egyszeri: nincs) */
export const defaultCallDays = (billing: string): number | null => (billing === 'eves' ? 30 : billing === 'negyedeves' || billing === 'felevi' ? 7 : null);

/** hívás napja: a számlázási hónap első munkanapja előtt N nappal, a megelőző munkanapra igazítva */
export function callDate(billingYm: string, days: number): string {
  let d = addDays(firstWorkday(billingYm), -days);
  for (let i = 0; i < 10 && !isWorkday(d); i++) d = addDays(d, -1);
  return d;
}

// ── jogosultságok ──

export interface TaskPerm {
  /** own: a neki kiosztott és az általa létrehozott feladatok; all: mindenki feladata */
  view: 'own' | 'all';
  /** kioszthat-e feladatot másnak */
  assign: boolean;
  /** szerkesztheti-e a más által létrehozott, nem neki kiosztott (de látható) feladatot */
  editOthers: boolean;
  /** törlés: none: semmit; own: amit ő hozott létre; all: bármit, amit lát */
  del: 'none' | 'own' | 'all';
}

export const DEFAULT_PERM: TaskPerm = { view: 'own', assign: true, editOthers: false, del: 'own' };
export const ADMIN_PERM: TaskPerm = { view: 'all', assign: true, editOthers: true, del: 'all' };

export function cleanPerm(v: unknown): TaskPerm {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    view: o.view === 'all' ? 'all' : 'own',
    assign: o.assign === undefined ? DEFAULT_PERM.assign : !!o.assign,
    editOthers: !!o.editOthers,
    del: o.del === 'all' || o.del === 'none' ? o.del : 'own',
  };
}

/** a felhasználó tényleges jogai (admin: minden; olvasó: csak a sajátját látja, nem módosít) */
export function permOf(u: { id: number; role: string }, perms: Record<string, TaskPerm>): TaskPerm & { write: boolean } {
  if (u.role === 'admin') return { ...ADMIN_PERM, write: true };
  const p = perms[String(u.id)] || DEFAULT_PERM;
  return { ...p, write: u.role !== 'viewer' };
}

type Who = Pick<Task, 'assignee_id' | 'created_by'>;
export const canSee = (t: Who, u: { id: number }, p: TaskPerm) => p.view === 'all' || t.assignee_id === u.id || t.created_by === u.id;
export const canEditTask = (t: Who, u: { id: number }, p: TaskPerm & { write: boolean }) =>
  p.write && (t.assignee_id === u.id || t.created_by === u.id || (p.editOthers && canSee(t, u, p)));
export const canDeleteTask = (t: Who, u: { id: number }, p: TaskPerm & { write: boolean }) =>
  p.write && (p.del === 'all' ? canSee(t, u, p) : p.del === 'own' ? t.created_by === u.id : false);
