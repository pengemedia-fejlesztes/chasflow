// Feladatok: a tábla futáskor jön létre (SQLite és MySQL is). Admin minden feladatot lát, a többi felhasználó a neki
// kiosztottakat és az általa létrehozottakat. Minden módosítás a Naplóba kerül.
import { cleanTask, TASK_TYPE_LABEL, type Task, type TaskUser } from '../shared/tasks';
import { requireRole, type User } from './auth';
import { logChange } from './changelog';
import { Env, HttpError, json, now, randomId, readJson } from './util';

const DDL = `CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  type VARCHAR(20) NOT NULL DEFAULT 'egyeb',
  title VARCHAR(300) NOT NULL,
  note TEXT,
  partner_key VARCHAR(120),
  assignee_id INTEGER,
  created_by INTEGER,
  due_date VARCHAR(10) NOT NULL,
  due_time VARCHAR(5),
  end_date VARCHAR(10),
  status VARCHAR(12) NOT NULL DEFAULT 'nyitott',
  done_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`;

let ready: Promise<boolean> | null = null;
export function ensureTasks(env: Env): Promise<boolean> {
  if (!ready)
    ready = env.DB.prepare(DDL)
      .run()
      .then(() => true)
      .catch((e) => {
        ready = null;
        console.error('tasks ddl', e);
        return false;
      });
  return ready;
}

const COLS = 'id, type, title, note, partner_key, assignee_id, created_by, due_date, due_time, end_date, status, done_at, created_at, updated_at';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const row = (r: any): Task => ({
  ...r,
  assignee_id: num(r.assignee_id),
  created_by: num(r.created_by),
  done_at: num(r.done_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at),
});

export async function loadTasks(env: Env, u: User): Promise<{ tasks: Task[]; taskUsers: TaskUser[]; tasksError?: string }> {
  const users = (await env.DB.prepare('SELECT id, name, email FROM users WHERE disabled = 0 OR disabled IS NULL ORDER BY name').all<any>()).results.map(
    (x) => ({
      id: Number(x.id),
      name: String(x.name || x.email || 'Felhasználó'),
    }),
  );
  if (!(await ensureTasks(env))) return { tasks: [], taskUsers: users, tasksError: 'A feladatok táblája nem hozható létre.' };
  // a lezártakból csak az elmúlt fél év
  const base = `SELECT ${COLS} FROM tasks WHERE (status = 'nyitott' OR due_date >= date('now', '-190 days'))`;
  const r =
    u.role === 'admin'
      ? await env.DB.prepare(`${base} ORDER BY due_date, due_time`).all<any>()
      : await env.DB.prepare(`${base} AND (assignee_id = ? OR created_by = ?) ORDER BY due_date, due_time`).bind(u.id, u.id).all<any>();
  return { tasks: r.results.map(row), taskUsers: users };
}

export async function handleTasks(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  const m = path.match(/^\/api\/tasks(?:\/([^/]+))?$/);
  if (!m || req.method === 'GET') return null;
  requireRole(u, 'admin', 'member');
  if (!(await ensureTasks(env))) throw new HttpError(500, 'A feladatok táblája nem hozható létre a szerveren.');
  const id = m[1] ? decodeURIComponent(m[1]).slice(0, 40) : null;
  const cur = id ? await env.DB.prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`).bind(id).first<any>() : null;
  if (id && !cur) throw new HttpError(404, 'Nincs ilyen feladat.');
  // nem admin csak a sajátját (kiosztott vagy általa létrehozott) módosíthatja
  if (cur && u.role !== 'admin' && Number(cur.assignee_id) !== u.id && Number(cur.created_by) !== u.id)
    throw new HttpError(403, 'Ezt a feladatot nem módosíthatod.');
  const t = now();
  if (req.method === 'DELETE' && cur) {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
    await logChange(
      env,
      u.id,
      'task_deleted',
      `Feladat törölve: ${TASK_TYPE_LABEL[cur.type as keyof typeof TASK_TYPE_LABEL] || ''} · ${cur.title} (${cur.due_date})`,
      [],
      null,
    );
    return json({ ok: true });
  }
  if (req.method !== 'PUT' && req.method !== 'POST') return null;
  const b = await readJson(req);
  let v;
  try {
    v = cleanTask(b, cur ? row(cur) : undefined);
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  if (!cur && v.assignee_id === null) v.assignee_id = u.id;
  const doneAt = v.status === 'nyitott' ? null : cur?.status === v.status && cur?.done_at ? Number(cur.done_at) : t;
  const nid = id || randomId('k');
  await env.DB.prepare(
    `INSERT INTO tasks (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, note = excluded.note, partner_key = excluded.partner_key,
       assignee_id = excluded.assignee_id, due_date = excluded.due_date, due_time = excluded.due_time, end_date = excluded.end_date,
       status = excluded.status, done_at = excluded.done_at, updated_at = excluded.updated_at`,
  )
    .bind(
      nid,
      v.type,
      v.title,
      v.note,
      v.partner_key,
      v.assignee_id,
      cur ? num(cur.created_by) : u.id,
      v.due_date,
      v.due_time,
      v.end_date,
      v.status,
      doneAt,
      cur ? Number(cur.created_at) : t,
      t,
    )
    .run();
  const what = `${TASK_TYPE_LABEL[v.type]} · ${v.title}${v.partner_key ? ` · ${v.partner_key}` : ''} · ${v.due_date}${v.due_time ? ' ' + v.due_time : ''}`;
  const action = !cur
    ? 'Új feladat'
    : cur.status !== v.status
      ? `Feladat ${v.status === 'kesz' ? 'kész' : v.status === 'elmaradt' ? 'elmaradt' : 'újranyitva'}`
      : 'Feladat módosítva';
  await logChange(env, u.id, cur ? 'task_updated' : 'task_created', `${action}: ${what}`, [], null);
  return json({ ok: true, id: nid });
}
