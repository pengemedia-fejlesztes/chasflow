// Termék- és szolgáltatástörzs, a partnerekhez rendelt (számlázandó) termékek és a partnerek számlázási adatai.
// A táblák futáskor jönnek létre (CREATE TABLE IF NOT EXISTS), így az éles MySQL-en sem kell kézi sémafrissítés;
// a típusok SQLite-on és MySQL-en is érvényesek.
import { BILLING_STEP, VATS, cleanProfile, deriveCatalog, type Billing, type PartnerProduct, type PartnerProfile, type Product } from '../shared/catalog';
import { requireRole, type User } from './auth';
import { logChange } from './changelog';
import { partnerIdOf } from '../shared/partners';
import { Env, HttpError, getSetting, json, now, randomId, readJson, setSetting, todayHu } from './util';

const DDL = [
  `CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(40) NOT NULL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'szolgaltatas',
    unit VARCHAR(20) NOT NULL DEFAULT 'db',
    price DOUBLE NOT NULL DEFAULT 0,
    vat VARCHAR(10) NOT NULL DEFAULT '27',
    currency VARCHAR(3) NOT NULL DEFAULT 'HUF',
    billing VARCHAR(12) NOT NULL DEFAULT 'havi',
    sku VARCHAR(60),
    note TEXT,
    stock DOUBLE,
    grp VARCHAR(80),
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS partner_products (
    id VARCHAR(40) NOT NULL PRIMARY KEY,
    partner_key VARCHAR(120) NOT NULL,
    product_id VARCHAR(40) NOT NULL,
    qty DOUBLE NOT NULL DEFAULT 1,
    price DOUBLE,
    billing VARCHAR(12),
    start_ym VARCHAR(7) NOT NULL,
    end_ym VARCHAR(7),
    note TEXT,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS partner_profiles (
    partner_key VARCHAR(120) NOT NULL PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
];

let ready: Promise<boolean> | null = null;
/** a táblák létrehozása (folyamatonként egyszer); hiba esetén a következő kérés újra próbálja */
export function ensureCatalog(env: Env): Promise<boolean> {
  if (!ready)
    ready = (async () => {
      for (const s of DDL) await env.DB.prepare(s).run();
      // később hozzáadott oszlop: készlet (a már létező táblába)
      const hasStock = await env.DB.prepare('SELECT stock FROM products LIMIT 1')
        .all()
        .then(() => true)
        .catch(() => false);
      if (!hasStock) await env.DB.prepare('ALTER TABLE products ADD COLUMN stock DOUBLE').run();
      // termékcsoport
      const hasGrp = await env.DB.prepare('SELECT grp FROM products LIMIT 1')
        .all()
        .then(() => true)
        .catch(() => false);
      if (!hasGrp) await env.DB.prepare('ALTER TABLE products ADD COLUMN grp VARCHAR(80)').run();
      return true;
    })().catch((e) => {
      ready = null;
      console.error('catalog ddl', e);
      return false;
    });
  return ready;
}

export interface CatalogBundle {
  products: Product[];
  partnerProducts: PartnerProduct[];
  partnerProfiles: Record<string, PartnerProfile>;
  catalogError?: string;
}

export async function loadCatalog(env: Env): Promise<CatalogBundle> {
  if (!(await ensureCatalog(env)))
    return { products: [], partnerProducts: [], partnerProfiles: {}, catalogError: 'A termékadatbázis táblái nem hozhatók létre.' };
  // első betöltéskor a partnereknél már felvitt tételekből feltöltjük a törzset
  if (!(await getSetting(env, 'catalog_seeded'))) {
    await syncCatalog(env).catch((e) => console.error('catalog seed', e));
    await setSetting(env, 'catalog_seeded', String(now()));
  }
  const [p, a, f] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, kind, unit, price, vat, currency, billing, sku, note, grp, archived, updated_at FROM products ORDER BY name'),
    env.DB.prepare('SELECT id, partner_key, product_id, qty, price, billing, start_ym, end_ym, note, updated_at FROM partner_products ORDER BY start_ym'),
    env.DB.prepare('SELECT partner_key, data FROM partner_profiles'),
  ]);
  const profiles: Record<string, PartnerProfile> = {};
  for (const r of f.results as any[]) {
    try {
      profiles[r.partner_key] = cleanProfile(JSON.parse(r.data));
    } catch {
      /* hibás sor: kihagyjuk */
    }
  }
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    products: (p.results as any[]).map((r) => ({ ...r, price: Number(r.price), archived: Number(r.archived) })),
    partnerProducts: (a.results as any[]).map((r) => ({ ...r, qty: Number(r.qty), price: num(r.price) })),
    partnerProfiles: profiles,
  };
}

const IGNORE_KEY = 'catalog_ignore';
const lc = (s: string) =>
  String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
async function ignoreList(env: Env): Promise<Set<string>> {
  try {
    return new Set(JSON.parse((await getSetting(env, IGNORE_KEY)) || '[]'));
  } catch {
    return new Set();
  }
}
/** a kézzel levett / törölt tételt a szinkron nem hozza vissza */
async function addIgnore(env: Env, key: string) {
  const s = await ignoreList(env);
  s.add(key);
  await setSetting(env, IGNORE_KEY, JSON.stringify([...s].slice(-2000)));
}

/**
 * A partnereknél felvitt (bevételi) tervekből a hiányzó termékek és partner-hozzárendelések létrehozása.
 * Csak hozzáad: a meglévőt nem írja felül (azt már szerkeszthették), a kézzel törölteket nem hozza vissza.
 */
export async function syncCatalog(env: Env): Promise<{ products: number; assigns: number }> {
  if (!(await ensureCatalog(env))) return { products: 0, assigns: 0 };
  const cur = todayHu().slice(0, 7);
  const [gR, lR, eR, sR, pR, aR] = await env.DB.batch([
    env.DB.prepare('SELECT id, section, label FROM groups'),
    env.DB.prepare('SELECT id, group_id, label FROM leaves'),
    env.DB.prepare("SELECT leaf_id, name, amount, date, period, series_id, tentative FROM entries WHERE kind = 'plan' AND date >= date('now', '-100 days')"),
    env.DB.prepare('SELECT id, rep FROM series'),
    env.DB.prepare('SELECT id, name, price FROM products'),
    env.DB.prepare('SELECT partner_key, product_id FROM partner_products'),
  ]);
  const groups = new Map((gR.results as any[]).map((g) => [g.id, g]));
  const leaves = (lR.results as any[]).map((l) => {
    const g = groups.get(l.group_id);
    return { id: l.id, label: l.label, section: g?.section === 'out' ? 'out' : 'in', offer: /aj[áa]nlat/i.test(g?.label || '') } as const;
  });
  const rep = Object.fromEntries((sR.results as any[]).map((x) => [x.id, x.rep]));
  const d = deriveCatalog(leaves as any, eR.results as any, rep, cur, partnerIdOf);
  const ignore = await ignoreList(env);
  const byName = new Map((pR.results as any[]).map((p) => [lc(p.name), { id: p.id as string, price: Number(p.price) }]));
  const have = new Set((aR.results as any[]).map((a) => a.partner_key + '|' + a.product_id));
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let np = 0,
    na = 0;
  for (const p of d.products) {
    if (byName.has(lc(p.name)) || ignore.has('*|' + lc(p.name))) continue;
    const id = randomId('p');
    byName.set(lc(p.name), { id, price: p.price });
    stmts.push(
      env.DB.prepare(
        'INSERT INTO products (id, name, kind, unit, price, vat, currency, billing, sku, note, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        id,
        p.name.slice(0, 200),
        'szolgaltatas',
        p.billing === 'havi' ? 'hó' : 'db',
        p.price,
        '27',
        'HUF',
        p.billing,
        null,
        'A partnereknél felvitt tételekből',
        0,
        t,
      ),
    );
    np++;
  }
  for (const a of d.assigns) {
    const p = byName.get(lc(a.name));
    if (!p || a.offer || have.has(a.partner_key + '|' + p.id) || ignore.has(a.partner_key + '|' + lc(a.name))) continue;
    have.add(a.partner_key + '|' + p.id);
    stmts.push(
      env.DB.prepare(
        'INSERT INTO partner_products (id, partner_key, product_id, qty, price, billing, start_ym, end_ym, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(randomId('pp'), a.partner_key, p.id, a.qty, a.price === p.price ? null : a.price, a.billing, a.start_ym, a.end_ym, null, t),
    );
    na++;
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { products: np, assigns: na };
}

const KINDS = new Set(['szolgaltatas', 'termek']);
const VAT_SET = new Set(VATS.map((v) => v[0]));
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const str = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const money = (v: unknown, what: string) => {
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e11) throw new HttpError(400, `Hibás ${what}.`);
  return Math.round(n * 100) / 100;
};
const billingOf = (v: unknown): Billing | null => (typeof v === 'string' && v in BILLING_STEP ? (v as Billing) : null);

export async function handleCatalog(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  const prod = path.match(/^\/api\/products(?:\/([^/]+))?$/);
  const asg = path.match(/^\/api\/partner-products(?:\/([^/]+))?$/);
  const prof = path.match(/^\/api\/partner-profile\/([^/]+)$/);
  if (!prod && !asg && !prof) return null;
  if (req.method === 'GET') return null;
  requireRole(u, 'admin', 'member');
  if (!(await ensureCatalog(env))) throw new HttpError(500, 'A termékadatbázis táblái nem hozhatók létre a szerveren.');
  const t = now();

  if (prod && prod[1] === 'sync' && req.method === 'POST') {
    const r = await syncCatalog(env);
    if (r.products || r.assigns)
      await logChange(env, u.id, 'catalog_sync', `Törzs frissítve a partnerek tételeiből: ${r.products} új termék, ${r.assigns} új hozzárendelés`, [], null);
    return json({ ok: true, ...r });
  }

  if (prod) {
    const id = prod[1] ? decodeURIComponent(prod[1]).slice(0, 40) : null;
    const cur = id ? await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>() : null;
    if (id && !cur) throw new HttpError(404, 'Nincs ilyen termék.');
    if (req.method === 'DELETE' && cur) {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM partner_products WHERE product_id = ?').bind(id).first<{ n: number }>();
      if (Number(used?.n || 0) > 0) {
        await env.DB.prepare('UPDATE products SET archived = 1, updated_at = ? WHERE id = ?').bind(t, id).run();
        await logChange(env, u.id, 'product_archived', `Termék archiválva: ${cur.name} (${used?.n} partnernél használatban)`, [], null);
        return json({ ok: true, archived: true });
      }
      await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
      await addIgnore(env, '*|' + lc(cur.name));
      await logChange(env, u.id, 'product_deleted', `Termék törölve: ${cur.name}`, [], null);
      return json({ ok: true, deleted: true });
    }
    if (req.method !== 'PUT' && req.method !== 'POST') return null;
    const b = await readJson(req);
    const v = {
      name: b.name !== undefined ? str(b.name, 200) : cur?.name || '',
      kind: b.kind !== undefined ? (KINDS.has(b.kind) ? b.kind : 'szolgaltatas') : cur?.kind || 'szolgaltatas',
      unit: b.unit !== undefined ? str(b.unit, 20) || 'db' : cur?.unit || 'db',
      price: b.price !== undefined ? money(b.price, 'egységár') : Number(cur?.price || 0),
      vat: b.vat !== undefined ? (VAT_SET.has(b.vat) ? b.vat : '27') : cur?.vat || '27',
      currency: b.currency !== undefined ? (['HUF', 'EUR', 'USD'].includes(b.currency) ? b.currency : 'HUF') : cur?.currency || 'HUF',
      billing: b.billing !== undefined ? billingOf(b.billing) || 'havi' : cur?.billing || 'havi',
      sku: b.sku !== undefined ? str(b.sku, 60) || null : (cur?.sku ?? null),
      grp: b.grp !== undefined ? str(b.grp, 80) || null : (cur?.grp ?? null),
      note:
        b.note !== undefined
          ? String(b.note ?? '')
              .trim()
              .slice(0, 2000) || null
          : (cur?.note ?? null),
      archived: b.archived !== undefined ? (b.archived ? 1 : 0) : Number(cur?.archived || 0),
    };
    if (!v.name) throw new HttpError(400, 'Adj meg megnevezést.');
    const clash = await env.DB.prepare('SELECT id FROM products WHERE lower(name) = lower(?) AND id <> ?')
      .bind(v.name, id || '')
      .first();
    if (clash) throw new HttpError(409, `Már van „${v.name}” nevű termék vagy szolgáltatás.`);
    const nid = id || randomId('p');
    await env.DB.prepare(
      `INSERT INTO products (id, name, kind, unit, price, vat, currency, billing, sku, note, grp, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, unit = excluded.unit, price = excluded.price, vat = excluded.vat,
         currency = excluded.currency, billing = excluded.billing, sku = excluded.sku, note = excluded.note, grp = excluded.grp, archived = excluded.archived, updated_at = excluded.updated_at`,
    )
      .bind(nid, v.name, v.kind, v.unit, v.price, v.vat, v.currency, v.billing, v.sku, v.note, v.grp, v.archived, t)
      .run();
    await logChange(
      env,
      u.id,
      id ? 'product_updated' : 'product_created',
      `${id ? 'Termék módosítva' : 'Új termék'}: ${v.name} · ${v.price} ${v.currency}/${v.unit}`,
      [],
      null,
    );
    return json({ ok: true, id: nid });
  }

  if (asg) {
    const id = asg[1] ? decodeURIComponent(asg[1]).slice(0, 40) : null;
    const cur = id ? await env.DB.prepare('SELECT * FROM partner_products WHERE id = ?').bind(id).first<any>() : null;
    if (id && !cur) throw new HttpError(404, 'Nincs ilyen hozzárendelés.');
    if (req.method === 'DELETE' && cur) {
      await env.DB.prepare('DELETE FROM partner_products WHERE id = ?').bind(id).run();
      const pn = await env.DB.prepare('SELECT name FROM products WHERE id = ?').bind(cur.product_id).first<{ name: string }>();
      if (pn) await addIgnore(env, cur.partner_key + '|' + lc(pn.name));
      await logChange(env, u.id, 'partner_product_deleted', `Partnertől levéve: ${cur.partner_key} · ${cur.product_id}`, [], null);
      return json({ ok: true });
    }
    if (req.method !== 'PUT' && req.method !== 'POST') return null;
    const b = await readJson(req);
    const partner = b.partner_key !== undefined ? str(b.partner_key, 120) : cur?.partner_key;
    const productId = b.product_id !== undefined ? str(b.product_id, 40) : cur?.product_id;
    const p = productId ? await env.DB.prepare('SELECT id, name FROM products WHERE id = ?').bind(productId).first<any>() : null;
    if (!partner) throw new HttpError(400, 'Hiányzik a partner.');
    if (!p) throw new HttpError(400, 'Válassz terméket vagy szolgáltatást.');
    const qty = b.qty !== undefined ? money(b.qty, 'mennyiség') : Number(cur?.qty ?? 1);
    if (qty <= 0) throw new HttpError(400, 'A mennyiség legyen nagyobb nullánál.');
    const price = b.price !== undefined ? (b.price === null || b.price === '' ? null : money(b.price, 'egységár')) : (cur?.price ?? null);
    const billing = b.billing !== undefined ? billingOf(b.billing) : (cur?.billing ?? null);
    const start = b.start_ym !== undefined ? String(b.start_ym) : cur?.start_ym;
    const end = b.end_ym !== undefined ? (b.end_ym ? String(b.end_ym) : null) : (cur?.end_ym ?? null);
    if (!YM.test(start || '')) throw new HttpError(400, 'Hibás kezdő hónap.');
    if (end && (!YM.test(end) || end < start)) throw new HttpError(400, 'A záró hónap nem lehet a kezdő előtt.');
    const note =
      b.note !== undefined
        ? String(b.note ?? '')
            .trim()
            .slice(0, 1000) || null
        : (cur?.note ?? null);
    const nid = id || randomId('pp');
    await env.DB.prepare(
      `INSERT INTO partner_products (id, partner_key, product_id, qty, price, billing, start_ym, end_ym, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET partner_key = excluded.partner_key, product_id = excluded.product_id, qty = excluded.qty, price = excluded.price,
         billing = excluded.billing, start_ym = excluded.start_ym, end_ym = excluded.end_ym, note = excluded.note, updated_at = excluded.updated_at`,
    )
      .bind(nid, partner, p.id, qty, price, billing, start, end, note, t)
      .run();
    await logChange(
      env,
      u.id,
      id ? 'partner_product_updated' : 'partner_product_created',
      `${id ? 'Partner-szolgáltatás módosítva' : 'Partnerhez rendelve'}: ${partner} · ${p.name}`,
      [],
      null,
    );
    return json({ ok: true, id: nid });
  }

  if (prof && (req.method === 'PUT' || req.method === 'POST')) {
    const key = decodeURIComponent(prof[1]).slice(0, 120);
    const b = await readJson(req);
    const cur = await env.DB.prepare('SELECT data FROM partner_profiles WHERE partner_key = ?').bind(key).first<{ data: string }>();
    let base: Record<string, unknown> = {};
    try {
      base = cur ? JSON.parse(cur.data) : {};
    } catch {
      base = {};
    }
    const v = cleanProfile({ ...base, ...b });
    await env.DB.prepare(
      `INSERT INTO partner_profiles (partner_key, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(partner_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
      .bind(key, JSON.stringify(v), t)
      .run();
    await logChange(env, u.id, 'partner_profile_updated', `Számlázási adatok módosítva: ${key}`, [], null);
    return json({ ok: true });
  }
  return null;
}
