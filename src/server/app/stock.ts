// Raktárkészlet: raktárak és készletmozgások (futáskor létrejövő táblák, SQLite és MySQL is).
// A készlet a mozgások összege raktáranként; a korábbi „készlet” mező értéke nyitókészletként kerül át a központi raktárba.
import { MOVE_LABEL, type MoveKind, type StockLevel, type StockMove, type Warehouse } from '../../shared/stock';
import { requireRole, type User } from './auth';
import { ensureCatalog } from './catalog';
import { logChange } from './changelog';
import { Env, HttpError, ensureOnce, json, now, randomId, readJson } from './util';

const DDL = [
  `CREATE TABLE IF NOT EXISTS warehouses (
    id VARCHAR(40) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    note TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stock_moves (
    id VARCHAR(40) NOT NULL PRIMARY KEY,
    product_id VARCHAR(40) NOT NULL,
    warehouse_id VARCHAR(40) NOT NULL,
    qty DOUBLE NOT NULL,
    kind VARCHAR(12) NOT NULL,
    ref VARCHAR(40),
    partner_key VARCHAR(120),
    note TEXT,
    created_by INTEGER,
    created_at BIGINT NOT NULL
  )`,
];
export const MAIN_WH = 'wh-main';

export const ensureStock = ensureOnce('stock ddl', async (env) => {
  if (!(await ensureCatalog(env))) throw new Error('catalog');
  for (const s of DDL) await env.DB.prepare(s).run();
  const t = now();
  const wh = await env.DB.prepare('SELECT id FROM warehouses LIMIT 1').first();
  if (!wh)
    await env.DB.prepare('INSERT INTO warehouses (id, name, note, archived, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(MAIN_WH, 'Központi raktár', null, 0, t)
      .run();
  // a régi termék-szintű készlet → nyitókészlet a központi raktárba (egyszer)
  const legacy = (await env.DB.prepare('SELECT id, stock FROM products WHERE stock IS NOT NULL').all<{ id: string; stock: number }>()).results;
  for (const p of legacy) {
    if (Number(p.stock))
      await env.DB.prepare(
        'INSERT INTO stock_moves (id, product_id, warehouse_id, qty, kind, ref, partner_key, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(randomId('m'), p.id, MAIN_WH, Number(p.stock), 'korrekcio', null, null, 'Nyitókészlet', null, t)
        .run();
    await env.DB.prepare('UPDATE products SET stock = NULL WHERE id = ?').bind(p.id).run();
  }
});

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadStock(env: Env): Promise<{ warehouses: Warehouse[]; stockLevels: StockLevel[]; stockMoves: StockMove[]; stockError?: string }> {
  if (!(await ensureStock(env))) return { warehouses: [], stockLevels: [], stockMoves: [], stockError: 'A raktárkészlet táblái nem hozhatók létre.' };
  const [w, l, m] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, note, archived FROM warehouses ORDER BY name'),
    env.DB.prepare('SELECT product_id, warehouse_id, SUM(qty) AS qty FROM stock_moves GROUP BY product_id, warehouse_id'),
    env.DB.prepare(
      'SELECT id, product_id, warehouse_id, qty, kind, ref, partner_key, note, created_by, created_at FROM stock_moves ORDER BY created_at DESC LIMIT 1500',
    ),
  ]);
  return {
    warehouses: (w.results as any[]).map((x) => ({ ...x, archived: Number(x.archived) })),
    stockLevels: (l.results as any[]).map((x) => ({ product_id: x.product_id, warehouse_id: x.warehouse_id, qty: Number(x.qty) })),
    stockMoves: (m.results as any[]).map((x) => ({ ...x, qty: Number(x.qty), created_by: num(x.created_by), created_at: Number(x.created_at) })),
  };
}

const str = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export async function handleStock(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  const wm = path.match(/^\/api\/warehouses(?:\/([^/]+))?$/);
  const mm = path.match(/^\/api\/stock-moves(?:\/([^/]+))?$/);
  if ((!wm && !mm) || req.method === 'GET') return null;
  requireRole(u, 'admin', 'member');
  if (!(await ensureStock(env))) throw new HttpError(500, 'A raktárkészlet táblái nem hozhatók létre a szerveren.');
  const t = now();

  if (wm) {
    const id = wm[1] ? decodeURIComponent(wm[1]).slice(0, 40) : null;
    const cur = id ? await env.DB.prepare('SELECT * FROM warehouses WHERE id = ?').bind(id).first<any>() : null;
    if (id && !cur) throw new HttpError(404, 'Nincs ilyen raktár.');
    if (req.method === 'DELETE' && cur) {
      const has = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_moves WHERE warehouse_id = ?').bind(id).first<{ n: number }>();
      if (Number(has?.n || 0)) await env.DB.prepare('UPDATE warehouses SET archived = 1, updated_at = ? WHERE id = ?').bind(t, id).run();
      else await env.DB.prepare('DELETE FROM warehouses WHERE id = ?').bind(id).run();
      await logChange(env, u.id, 'warehouse_deleted', `Raktár ${Number(has?.n || 0) ? 'archiválva' : 'törölve'}: ${cur.name}`, [], null);
      return json({ ok: true });
    }
    const b = await readJson(req);
    const name = b.name !== undefined ? str(b.name, 120) : cur?.name;
    if (!name) throw new HttpError(400, 'Adj nevet a raktárnak.');
    const note = b.note !== undefined ? str(b.note, 1000) || null : (cur?.note ?? null);
    const archived = b.archived !== undefined ? (b.archived ? 1 : 0) : Number(cur?.archived || 0);
    const nid = id || randomId('wh');
    await env.DB.prepare(
      `INSERT INTO warehouses (id, name, note, archived, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, note = excluded.note, archived = excluded.archived, updated_at = excluded.updated_at`,
    )
      .bind(nid, name, note, archived, t)
      .run();
    await logChange(env, u.id, id ? 'warehouse_updated' : 'warehouse_created', `${id ? 'Raktár módosítva' : 'Új raktár'}: ${name}`, [], null);
    return json({ ok: true, id: nid });
  }

  // készletmozgás: törlés (visszavonás) vagy új mozgás
  const id = mm![1] ? decodeURIComponent(mm![1]).slice(0, 40) : null;
  if (req.method === 'DELETE' && id) {
    const cur = await env.DB.prepare('SELECT m.*, p.name AS pname FROM stock_moves m LEFT JOIN products p ON p.id = m.product_id WHERE m.id = ?')
      .bind(id)
      .first<any>();
    if (!cur) throw new HttpError(404, 'Nincs ilyen mozgás.');
    // átvezetésnél a pár is törlődik
    if (cur.ref) await env.DB.prepare('DELETE FROM stock_moves WHERE ref = ?').bind(cur.ref).run();
    else await env.DB.prepare('DELETE FROM stock_moves WHERE id = ?').bind(id).run();
    await logChange(
      env,
      u.id,
      'stock_move_deleted',
      `Készletmozgás törölve: ${cur.pname || cur.product_id} · ${MOVE_LABEL[cur.kind as MoveKind] || cur.kind} ${cur.qty}`,
      [],
      null,
    );
    return json({ ok: true });
  }
  if (req.method !== 'POST') return null;
  const b = await readJson(req);
  const kind = String(b.kind) as MoveKind;
  if (!(kind in MOVE_LABEL)) throw new HttpError(400, 'Hibás mozgástípus.');
  const p = await env.DB.prepare('SELECT id, name, unit FROM products WHERE id = ?').bind(str(b.product_id, 40)).first<any>();
  if (!p) throw new HttpError(400, 'Válassz terméket.');
  const whOk = async (w: string) => !!(await env.DB.prepare('SELECT id FROM warehouses WHERE id = ? AND archived = 0').bind(w).first());
  const wh = str(b.warehouse_id, 40);
  if (!(await whOk(wh))) throw new HttpError(400, 'Válassz raktárt.');
  const q = Number(String(b.qty ?? '').replace(',', '.'));
  if (!Number.isFinite(q) || Math.abs(q) > 1e9) throw new HttpError(400, 'Hibás mennyiség.');
  const note = str(b.note, 1000) || null;
  const partner = str(b.partner_key, 120) || null;
  const ins = (wid: string, qty: number, ref: string | null) =>
    env.DB.prepare(
      'INSERT INTO stock_moves (id, product_id, warehouse_id, qty, kind, ref, partner_key, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(randomId('m'), p.id, wid, qty, kind, ref, partner, note, u.id, t);
  const level = async (wid: string) =>
    Number(
      (
        await env.DB.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE product_id = ? AND warehouse_id = ?')
          .bind(p.id, wid)
          .first<{ q: number }>()
      )?.q || 0,
    );
  let summary = '';
  if (kind === 'korrekcio') {
    // leltár: a megadott mennyiség lesz a raktári készlet (a különbözet kerül rögzítésre)
    if (q < 0) throw new HttpError(400, 'A leltár szerinti mennyiség nem lehet negatív.');
    const diff = Math.round((q - (await level(wh))) * 1000) / 1000;
    if (!diff) return json({ ok: true, unchanged: true });
    await ins(wh, diff, null).run();
    summary = `${p.name}: leltár ${q} ${p.unit} (${diff > 0 ? '+' : ''}${diff})`;
  } else {
    if (q <= 0) throw new HttpError(400, 'A mennyiség legyen nagyobb nullánál.');
    if (kind === 'bevet') {
      await ins(wh, q, null).run();
      summary = `${p.name}: bevételezés +${q} ${p.unit}`;
    } else if (kind === 'kiadas') {
      await ins(wh, -q, null).run();
      summary = `${p.name}: kiadás −${q} ${p.unit}${partner ? ` · ${partner}` : ''}`;
    } else {
      const to = str(b.to_warehouse_id, 40);
      if (!(await whOk(to)) || to === wh) throw new HttpError(400, 'Válassz másik célraktárt.');
      const ref = randomId('r');
      await env.DB.batch([ins(wh, -q, ref), ins(to, q, ref)]);
      summary = `${p.name}: átvezetés ${q} ${p.unit}`;
    }
  }
  await logChange(env, u.id, 'stock_move', `Raktár · ${summary}`, [], null);
  return json({ ok: true });
}
