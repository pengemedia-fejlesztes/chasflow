// Billingo v3 szinkron: kiállított számlák → tervezett bevétel.
import { partnerKey, suggestLeaf } from '../shared/match';
import type { Leaf } from '../shared/types';
import { CategoryCache } from './data';
import { Env, HttpError, getSetting, now, setSetting, todayHu } from './util';

const BASE = 'https://api.billingo.hu/v3';

interface BillingoDocument {
  id: number;
  invoice_number?: string;
  type?: string;
  cancelled?: boolean;
  payment_status?: string;
  gross_total?: number;
  currency?: string;
  conversion_rate?: number;
  invoice_date?: string;
  due_date?: string;
  paid_date?: string;
  partner?: { name?: string };
}

const INCOME_TYPES = new Set(['invoice', 'advance']);
// csak a ténylegesen kifizetésre váró számlákból lesz új terv ('none' = sztornózott / fizetési státusz nélküli)
const OPEN_STATUSES = new Set(['outstanding', 'expired', 'partially_paid']);

async function fetchDocs(base: string, key: string, startDate: string): Promise<BillingoDocument[]> {
  const out: BillingoDocument[] = [];
  for (let page = 1; page <= 50; page++) {
    const url = `${base}/documents?page=${page}&per_page=100&start_date=${startDate}`;
    const res = await fetch(url, { headers: { 'X-API-KEY': key, Accept: 'application/json' } });
    if (res.status === 429) throw new Error('Billingo: túl sok kérés (rate limit), később újrapróbálja.');
    if (!res.ok) throw new Error(`Billingo hiba: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: BillingoDocument[]; last_page?: number; current_page?: number };
    out.push(...(body.data || []));
    if (!body.last_page || page >= body.last_page) break;
  }
  return out;
}

/** Partner név → bevételi kategória (meglévő szabály / név egyezés / új "Projektek" alkategória). */
async function leafForPartner(
  env: Env,
  partner: string,
  leaves: Leaf[],
  sectionOf: (id: string) => 'in' | 'out',
  rules: Record<string, string>,
  cache: CategoryCache,
  stmts: D1PreparedStatement[],
) {
  const s = suggestLeaf({ date: '', amount: 1, partner, memo: '' }, rules, leaves, sectionOf);
  if (s) return s;
  const def = await getSetting(env, 'billingo_leaf_default');
  if (def && leaves.some((l) => l.id === def)) return def;
  const label =
    partner
      .replace(/\b(kft|zrt|nyrt|bt|kkt|e\.?v\.?)\b\.?/gi, '')
      .replace(/[\s,.]+$/, '')
      .trim()
      .slice(0, 60) || 'Billingo';
  const r = cache.stmtsFor('in', 'Projektek', label);
  stmts.push(...r.stmts);
  leaves.push({ id: r.lid, group_id: r.gid, label, sort: 0, archived: 0 });
  return r.lid;
}

export async function syncBillingo(env: Env): Promise<{ docs: number; plans: number }> {
  if (!env.BILLINGO_API_KEY) throw new Error('Nincs beállítva BILLINGO_API_KEY.');
  const start = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
  const docs = await fetchDocs(env.BILLINGO_API_URL || BASE, env.BILLINGO_API_KEY, start);

  const cache = await new CategoryCache(env).load();
  const [leavesR, groupsR, rulesR, existingR, docsR, openR] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM leaves'),
    env.DB.prepare('SELECT id, section FROM groups'),
    env.DB.prepare('SELECT pattern, leaf_id FROM partner_rules'),
    env.DB.prepare("SELECT id, ext_ref, done, leaf_id, date FROM entries WHERE ext_ref LIKE 'billingo:%'"),
    env.DB.prepare('SELECT id, due_date FROM billingo_docs'),
    env.DB.prepare(
      "SELECT id, leaf_id, date, amount, tentative FROM entries WHERE kind = 'plan' AND done = 0 AND (ext_ref IS NULL OR ext_ref LIKE 'imp:%') AND amount > 0 AND date >= date('now', '-120 days')",
    ),
  ]);
  const leaves = leavesR.results as unknown as Leaf[];
  const secOfGroup: Record<string, 'in' | 'out'> = {};
  (groupsR.results as any[]).forEach((g) => (secOfGroup[g.id] = g.section));
  const leafGroup: Record<string, string> = {};
  leaves.forEach((l) => (leafGroup[l.id] = l.group_id));
  const sectionOf = (id: string) => secOfGroup[leafGroup[id]] || 'out';
  const rules: Record<string, string> = {};
  (rulesR.results as any[]).forEach((r) => (rules[r.pattern] = r.leaf_id));
  const existing = new Map<string, { id: string; done: number; leaf_id: string; date: string }>();
  (existingR.results as any[]).forEach((e) => existing.set(e.ext_ref, e));
  const prevDue = new Map<number, string>();
  (docsR.results as any[]).forEach((d) => prevDue.set(d.id, d.due_date));

  // nyitott (kézi / importált) tervek, amelyekhez a számla hozzárendelhető – így nincs dupla bevétel
  const openPlans = openR.results as unknown as { id: string; leaf_id: string; date: string; amount: number; tentative: number }[];
  const used = new Set<string>();
  /**
   * A partner (kategória) nyitott terve(i), amelyekhez a számla tartozik – a számla a tervhez kötődik, az összegtől függetlenül
   * (az eltérést a riasztás jelzi). Sorrend: egy terv ±3%-kal; több tétel együtt (pl. SEO + PPC); különben a legközelebbi terv.
   */
  const findPlan = (leaf: string, gross: number, due: string): { id: string; covered: string[] } | null => {
    const near = openPlans
      .filter((p) => !used.has(p.id) && p.leaf_id === leaf)
      .map((p) => ({ ...p, dd: Math.abs(Date.parse(p.date) - Date.parse(due)) / 86400_000 }))
      .filter((p) => p.dd <= 25)
      .sort((a, b) => a.tentative - b.tentative || a.dd - b.dd);
    const close = (v: number) => Math.abs(v - gross) / Math.max(gross, 1) <= 0.03;
    const take = (ps: typeof near) => {
      ps.forEach((p) => used.add(p.id));
      return { id: ps[0].id, covered: ps.slice(1).map((p) => p.id) };
    };
    const single = near.find((p) => close(p.amount));
    if (single) return take([single]);
    // ugyanabban a hónapban több tétel (2–3) együtt
    const sameMonth = near.filter((p) => p.date.slice(0, 7) === near[0]?.date.slice(0, 7)).slice(0, 6);
    for (let i = 0; i < sameMonth.length; i++)
      for (let j = i + 1; j < sameMonth.length; j++) {
        if (close(sameMonth[i].amount + sameMonth[j].amount)) return take([sameMonth[i], sameMonth[j]]);
        for (let k = j + 1; k < sameMonth.length; k++)
          if (close(sameMonth[i].amount + sameMonth[j].amount + sameMonth[k].amount)) return take([sameMonth[i], sameMonth[j], sameMonth[k]]);
      }
    // a legközelebbi biztos terv (az összeg eltérése riasztás lesz, ha kevesebb)
    const nearest = near.find((p) => !p.tentative && p.dd <= 20);
    return nearest ? take([nearest]) : null;
  };

  // partner álnevek (pl. „MAGYAR OKLEVELES ADÓSZAKÉRTŐK EGYESÜLETE” → „MOKLASZ”): a terv neve ezzel jelenik meg
  let alias: Record<string, string> = {};
  try {
    alias = JSON.parse((await getSetting(env, 'partner_alias')) || '{}');
  } catch {}
  const t = now();
  const today = todayHu();
  // a már meglévő bevételi tények (pl. xls import, banki tétel) – a Billingo „fizetve” ne duplázza meg őket
  const actualsR = await env.DB.prepare(
    "SELECT id, leaf_id, date, amount FROM entries WHERE kind = 'actual' AND amount > 0 AND date >= date('now', '-200 days')",
  ).all<{ id: string; leaf_id: string; date: string; amount: number }>();
  const linkedR = await env.DB.prepare("SELECT link_id FROM entries WHERE kind = 'plan' AND link_id IS NOT NULL").all<{ link_id: string }>();
  const linked = new Set(linkedR.results.map((r) => r.link_id));
  /** Billingo szerint kifizetett számla → tény (vagy a meglévő, azonos tényhez kötés) + a terv lezárása. */
  const paidStmts = (planId: string, leaf: string, d: BillingoDocument, gross: number, partner: string): D1PreparedStatement[] => {
    const paidOn = d.paid_date && d.paid_date <= today ? d.paid_date : today;
    const same = actualsR.results.find(
      (a) =>
        !linked.has(a.id) &&
        a.leaf_id === leaf &&
        Math.abs(a.amount - gross) <= Math.max(500, gross * 0.01) &&
        Math.abs(Date.parse(a.date) - Date.parse(paidOn)) <= 12 * 86400_000,
    );
    const aid = same?.id || 'bp' + d.id;
    linked.add(aid);
    const out: D1PreparedStatement[] = [];
    if (!same)
      out.push(
        env.DB.prepare(
          `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, ext_ref, note, updated_at)
           VALUES (?, 'actual', ?, ?, ?, ?, 0, 0, 'billingo', ?, 'Billingo: fizetve', ?) ON CONFLICT DO NOTHING`,
        ).bind(aid, paidOn, leaf, `${partner} · ${d.invoice_number || ''}`.trim(), gross, 'bpaid:' + d.id, t),
      );
    out.push(env.DB.prepare('UPDATE entries SET done = 1, link_id = ?, updated_at = ? WHERE id = ? AND done = 0').bind(aid, t, planId));
    return out;
  };
  const stmts: D1PreparedStatement[] = [];
  let plans = 0;
  for (const d of docs) {
    if (!d.id || !INCOME_TYPES.has(String(d.type))) continue;
    const rate = d.currency && d.currency !== 'HUF' ? Number(d.conversion_rate) || 1 : 1;
    const gross = Math.round((Number(d.gross_total) || 0) * rate);
    const partnerRaw = d.partner?.name || 'Ismeretlen partner';
    const partner = alias[partnerKey(partnerRaw)] || partnerRaw;
    const ext = `billingo:${d.id}`;
    const ex = existing.get(ext);
    const cancelled = !!d.cancelled || d.payment_status === 'cancelled';
    const due = d.due_date || d.invoice_date || new Date().toISOString().slice(0, 10);
    let planId = ex?.id ?? null;

    if (cancelled) {
      if (ex && !ex.done) stmts.push(env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(ex.id));
      planId = null;
    } else if (ex) {
      // meglévő terv: összeg és név frissítése; a felhasználó által áthelyezett dátumot csak akkor írjuk felül, ha a határidő változott.
      // Ha a Billingo szerint fizetve: a terv lezárul, tény lesz belőle (a fizetés napjára) – a későbbi banki tétel ehhez kapcsolódik.
      const dueChanged = prevDue.has(d.id) && prevDue.get(d.id) !== due;
      stmts.push(
        // a számlából létrejött terv neve a számla; a tervhez kötött számla a terv saját nevét (pl. „Havi díj”) tartja meg
        env.DB.prepare(
          'UPDATE entries SET amount = ?, name = CASE WHEN ? THEN ? ELSE name END, date = CASE WHEN ? THEN ? ELSE date END, updated_at = ? WHERE id = ? AND done = 0',
        ).bind(gross, ex.id === 'b' + d.id ? 1 : 0, `${partner} · ${d.invoice_number || ''}`.trim(), dueChanged ? 1 : 0, due, t, ex.id),
      );
      plans++;
      if (!ex.done && d.payment_status === 'paid') stmts.push(...paidStmts(ex.id, ex.leaf_id, d, gross, partner));
    } else if (gross > 0) {
      const lid = await leafForPartner(env, partner, leaves, sectionOf, rules, cache, stmts);
      const matched = findPlan(lid, gross, due);
      if (matched) {
        // a meglévő tervből „kiszámlázott” tétel lesz
        planId = matched.id;
        // a többi lefedett tétel összege az első tervbe kerül (eredeti tervösszegként), majd törlődik
        const coveredSum = matched.covered.reduce((a, c) => a + (openPlans.find((p) => p.id === c)?.amount || 0), 0);
        for (const c of matched.covered) stmts.push(env.DB.prepare('DELETE FROM entries WHERE id = ? AND done = 0').bind(c));
        stmts.push(
          env.DB.prepare(
            "UPDATE entries SET ext_ref = ?, source = 'billingo', plan_amount = COALESCE(plan_amount, amount + ?), amount = ?, date = ?, tentative = 0, updated_at = ? WHERE id = ?",
          ).bind(ext, coveredSum, gross, due, t, matched.id),
        );
        if (d.payment_status === 'paid') stmts.push(...paidStmts(matched.id, lid, d, gross, partner));
        plans++;
      } else if (OPEN_STATUSES.has(String(d.payment_status))) {
        planId = 'b' + d.id;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, ext_ref, updated_at)
           VALUES (?, 'plan', ?, ?, ?, ?, 0, 0, 'billingo', ?, ?) ON CONFLICT DO NOTHING`,
          ).bind(planId, due, lid, `${partner} · ${d.invoice_number || ''}`.trim(), gross, ext, t),
        );
        plans++;
      }
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO billingo_docs (id, number, partner, gross, currency, invoice_date, due_date, payment_status, paid_date, cancelled, plan_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET number = excluded.number, partner = excluded.partner, gross = excluded.gross, currency = excluded.currency,
           invoice_date = excluded.invoice_date, due_date = excluded.due_date, payment_status = excluded.payment_status,
           paid_date = excluded.paid_date, cancelled = excluded.cancelled, plan_id = COALESCE(excluded.plan_id, billingo_docs.plan_id), synced_at = excluded.synced_at`,
      ).bind(
        d.id,
        d.invoice_number || null,
        partnerRaw, // a számlázási (cég)név változatlanul; az álnév csak a terv nevében
        gross,
        d.currency || 'HUF',
        d.invoice_date || null,
        due,
        d.payment_status || null,
        d.paid_date || null,
        cancelled ? 1 : 0,
        planId,
        t,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await setSetting(env, 'billingo_last_sync', String(t));
  return { docs: docs.length, plans };
}

/** Számlaszám-hivatkozások a banki közlemény párosításához: plan_id → számlaszám */
export async function invoiceRefs(env: Env): Promise<Record<string, string>> {
  const r = await env.DB.prepare('SELECT plan_id, number FROM billingo_docs WHERE plan_id IS NOT NULL AND number IS NOT NULL').all<{
    plan_id: string;
    number: string;
  }>();
  const out: Record<string, string> = {};
  r.results.forEach((x) => (out[x.plan_id] = x.number));
  return out;
}

/** A számla nyilvános (Billingo által kiszolgált) megtekintő linkje. */
export async function billingoPublicUrl(env: Env, id: number): Promise<string> {
  if (!env.BILLINGO_API_KEY) throw new HttpError(400, 'Nincs beállítva Billingo kapcsolat.');
  const doc = await env.DB.prepare('SELECT id FROM billingo_docs WHERE id = ?').bind(id).first();
  if (!doc) throw new HttpError(404, 'Ismeretlen Billingo bizonylat.');
  const res = await fetch(`${env.BILLINGO_API_URL || BASE}/documents/${id}/public-url`, {
    headers: { 'X-API-KEY': env.BILLINGO_API_KEY, Accept: 'application/json' },
  });
  const j = (await res.json().catch(() => null)) as { public_url?: string } | null;
  if (!res.ok || !j?.public_url) throw new HttpError(502, `A Billingo nem adta ki a számlát (${res.status}).`);
  return j.public_url;
}
