// NAV Online Számla (API v3): bejövő (szállítói) számlák lekérdezése → párosítás a tervvel / banki ténnyel.
// Ha egy számlához nincs terv, „új számla terv nélkül” riasztás lesz, javaslattal (rendszeres vagy előre nem látható).
// Hitelesítés: NAV technikai felhasználó (Cloudflare titkok: NAV_LOGIN, NAV_PASSWORD, NAV_SIGN_KEY, NAV_TAX_NUMBER).
import { sha512 } from '@noble/hashes/sha2';
import { sha3_512 as keccak } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { normalizeText } from '../shared/categories';
import { matchPlan, partnerKey, suggestLeaf } from '../shared/match';
import type { Entry } from '../shared/types';
import { matchingContext } from './bank';
import { taxBase, taxLeafMap } from './partnertax';
import { Env, HttpError, audit, getSetting, now, randomId, setSetting, todayHu } from './util';

const BASE = 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3';
/** a NAV egy lekérdezésben legfeljebb 35 napos kiállítási időszakot enged */
const WINDOW_DAYS = 35;
/** első szinkronnál ennyi nappal korábbtól kérünk */
const FIRST_DAYS = 120;

export const navEnabled = (env: Env) => !!(env.NAV_LOGIN && env.NAV_PASSWORD && env.NAV_SIGN_KEY && env.NAV_TAX_NUMBER);

export interface NavDigest {
  invoiceNumber: string;
  invoiceOperation: string;
  supplierTaxNumber: string;
  supplierName: string;
  invoiceIssueDate: string;
  invoiceDeliveryDate: string;
  paymentDate: string;
  paymentMethod: string;
  currency: string;
  net: number;
  gross: number;
  originalInvoiceNumber: string;
}

const upperHex = (b: Uint8Array) => bytesToHex(b).toUpperCase();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);

/** Kérés aláírás (nem számlabeküldésnél): SHA3-512(requestId + időbélyeg[yyyyMMddHHmmss, UTC] + aláírókulcs), nagybetűs hex. */
export function requestSignature(requestId: string, timestamp: string, signKey: string): string {
  const mask = timestamp.replace(/\.\d+Z$|Z$/, '').replace(/[-T:]/g, '');
  return upperHex(keccak(new TextEncoder().encode(requestId + mask + signKey)));
}

export function passwordHash(password: string): string {
  return upperHex(sha512(new TextEncoder().encode(password)));
}

/** A NAV által elvárt 18 karakteres szoftverazonosító (adószám alapján). */
const softwareId = (tax: string) => `HU${tax.slice(0, 8)}-CASHFL1`.slice(0, 18);

export function digestRequestXml(env: Env, o: { requestId: string; timestamp: string; page: number; from: string; to: string; contact: string }): string {
  const tax = String(env.NAV_TAX_NUMBER).replace(/\D/g, '').slice(0, 8);
  return `<?xml version="1.0" encoding="UTF-8"?>
<QueryInvoiceDigestRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
<common:header><common:requestId>${o.requestId}</common:requestId><common:timestamp>${o.timestamp}</common:timestamp><common:requestVersion>3.0</common:requestVersion><common:headerVersion>1.0</common:headerVersion></common:header>
<common:user><common:login>${esc(String(env.NAV_LOGIN).trim())}</common:login><common:passwordHash cryptoType="SHA-512">${passwordHash(String(env.NAV_PASSWORD).trim())}</common:passwordHash><common:taxNumber>${tax}</common:taxNumber><common:requestSignature cryptoType="SHA3-512">${requestSignature(o.requestId, o.timestamp, String(env.NAV_SIGN_KEY).trim())}</common:requestSignature></common:user>
<software><softwareId>${softwareId(tax)}</softwareId><softwareName>Cashflow tervezo</softwareName><softwareOperation>ONLINE_SERVICE</softwareOperation><softwareMainVersion>1.0</softwareMainVersion><softwareDevName>360 Marketing</softwareDevName><softwareDevContact>${esc(o.contact)}</softwareDevContact><softwareDevCountryCode>HU</softwareDevCountryCode><softwareDevTaxNumber>${tax}</softwareDevTaxNumber></software>
<page>${o.page}</page><invoiceDirection>INBOUND</invoiceDirection>
<invoiceQueryParams><mandatoryQueryParams><invoiceIssueDate><dateFrom>${o.from}</dateFrom><dateTo>${o.to}</dateTo></invoiceIssueDate></mandatoryQueryParams></invoiceQueryParams>
</QueryInvoiceDigestRequest>`;
}

/** Egyszerű XML olvasás (a Workerben nincs DOMParser): névtér-előtagok nélkül. */
const stripNs = (xml: string) => xml.replace(/<(\/?)[A-Za-z0-9_]+:/g, '<$1').replace(/\sxmlns(:\w+)?="[^"]*"/g, '');
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m
    ? m[1]
        .trim()
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
    : '';
};

export function parseDigestResponse(raw: string): { page: number; pages: number; items: NavDigest[] } {
  const xml = stripNs(raw);
  const func = tag(xml, 'funcCode');
  if (func && func !== 'OK') throw new Error(`NAV hiba: ${tag(xml, 'errorCode') || func} – ${tag(xml, 'message') || 'ismeretlen'}`);
  const items: NavDigest[] = [];
  for (const m of xml.matchAll(/<invoiceDigest>([\s\S]*?)<\/invoiceDigest>/g)) {
    const d = m[1];
    const huf = (n: string) => Math.round(parseFloat(tag(d, n + 'HUF') || tag(d, n) || '0'));
    const net = huf('invoiceNetAmount');
    items.push({
      invoiceNumber: tag(d, 'invoiceNumber'),
      invoiceOperation: tag(d, 'invoiceOperation'),
      supplierTaxNumber: tag(d, 'supplierTaxNumber'),
      supplierName: tag(d, 'supplierName'),
      invoiceIssueDate: tag(d, 'invoiceIssueDate'),
      invoiceDeliveryDate: tag(d, 'invoiceDeliveryDate'),
      paymentDate: tag(d, 'paymentDate'),
      paymentMethod: tag(d, 'paymentMethod'),
      currency: tag(d, 'currency') || 'HUF',
      net,
      gross: net + huf('invoiceVatAmount'),
      originalInvoiceNumber: tag(d, 'originalInvoiceNumber'),
    });
  }
  return { page: Number(tag(xml, 'currentPage') || 1), pages: Number(tag(xml, 'availablePage') || 1), items };
}

async function contactEmail(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").first<{ email: string }>();
  return r?.email || 'info@example.hu';
}

/** POST a NAV-nak; átmeneti hálózati hibánál egyszer újrapróbálja, és érthető hibaüzenetet ad. */
async function navPost(env: Env, body: string, op = 'queryInvoiceDigest'): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch((env.NAV_API_URL || BASE) + '/' + op, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml', Accept: 'application/xml', 'User-Agent': 'CashflowTervezo/1.0 (+360 Marketing)' },
        body,
      });
    } catch (e: any) {
      last = `NAV hiba: nem sikerült kapcsolódni (${e?.message || 'hálózati hiba'})`;
      continue;
    }
    const text = await res.text();
    if (res.ok || text.includes('funcCode')) return text;
    const snippet = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    last =
      res.status >= 520 && res.status <= 530
        ? `NAV hiba: HTTP ${res.status} – a Cloudflare nem tudott kapcsolódni a NAV szerveréhez${snippet ? ` (${snippet})` : ''}`
        : `NAV hiba: HTTP ${res.status}${snippet ? ` – ${snippet}` : ''}`;
    if (res.status < 500) break;
  }
  throw new Error(last);
}

async function fetchDigests(env: Env, from: string, to: string): Promise<NavDigest[]> {
  const contact = await contactEmail(env);
  const out: NavDigest[] = [];
  for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
    const end = addDays(start, WINDOW_DAYS - 1) < to ? addDays(start, WINDOW_DAYS - 1) : to;
    for (let page = 1; page <= 50; page++) {
      const requestId = ('RID' + randomId().replace(/[^A-Za-z0-9]/g, '')).slice(0, 30);
      const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '.000Z');
      const body = digestRequestXml(env, { requestId, timestamp, page, from: start, to: end, contact });
      const text = await navPost(env, body);
      const r = parseDigestResponse(text);
      out.push(...r.items);
      if (page >= r.pages) break;
    }
  }
  return out;
}

export async function syncNav(env: Env, opts: { from?: string } = {}): Promise<{ invoices: number; unplanned: number }> {
  if (!navEnabled(env)) throw new Error('Nincs beállítva NAV kapcsolat.');
  try {
    const r = await syncNavInner(env, opts);
    await setSetting(env, 'nav_last_error', '');
    await setSetting(env, 'nav_last_result', JSON.stringify(r));
    return r;
  } catch (e: any) {
    // a hiba megmarad (Beállítások + diagnosztika), hogy utólag is látszódjon
    await setSetting(env, 'nav_last_error', `${new Date().toISOString()} ${String(e?.message || e)}`.slice(0, 500));
    throw e;
  }
}

async function syncNavInner(env: Env, opts: { from?: string }): Promise<{ invoices: number; unplanned: number }> {
  const today = todayHu();
  const last = await getSetting(env, 'nav_last_date');
  const from = opts.from || (last ? addDays(last, -10) : addDays(today, -FIRST_DAYS));
  const digests = await fetchDigests(env, from, today);
  await storeDigests(env, digests);
  await fillZeroGross(env).catch((e) => console.error('nav zero gross', e));
  const res = await rematchNav(env);
  await setSetting(env, 'nav_last_date', today);
  await setSetting(env, 'nav_last_sync', String(now()));
  return { invoices: digests.length, unplanned: res.unplanned };
}

export async function storeDigests(env: Env, digests: NavDigest[]) {
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const d of digests) {
    if (!d.invoiceNumber) continue;
    const id = `nav:${d.supplierTaxNumber || 'x'}:${d.invoiceNumber}`.slice(0, 80);
    // sztornó / módosító számla: külön sor, nem kell rá terv; a sztornózott eredeti kikerül
    const side = d.invoiceOperation === 'STORNO' || d.invoiceOperation === 'MODIFY';
    stmts.push(
      env.DB.prepare(
        `INSERT INTO nav_invoices (id, direction, invoice_number, operation, partner_tax, partner_name, issue_date, delivery_date, payment_date, payment_method, currency, gross, net, status, created_at, updated_at)
         VALUES (?, 'INBOUND', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payment_date = excluded.payment_date,
           gross = CASE WHEN excluded.gross = 0 THEN nav_invoices.gross ELSE excluded.gross END,
           net = CASE WHEN excluded.gross = 0 THEN nav_invoices.net ELSE excluded.net END,
           partner_name = excluded.partner_name, updated_at = excluded.updated_at`,
      ).bind(
        id,
        d.invoiceNumber,
        d.invoiceOperation || 'CREATE',
        d.supplierTaxNumber || null,
        (d.supplierName || '').slice(0, 200),
        d.invoiceIssueDate || null,
        d.invoiceDeliveryDate || null,
        d.paymentDate || null,
        d.paymentMethod || null,
        d.currency,
        -Math.abs(d.gross),
        -Math.abs(d.net),
        side ? 'ignored' : 'new',
        t,
        t,
      ),
    );
    if (d.invoiceOperation === 'STORNO' && d.originalInvoiceNumber)
      stmts.push(
        env.DB.prepare("UPDATE nav_invoices SET status = 'ignored', updated_at = ? WHERE invoice_number = ? AND partner_tax IS ? AND status = 'new'").bind(
          t,
          d.originalInvoiceNumber,
          d.supplierTaxNumber || null,
        ),
      );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

interface NavRow {
  id: string;
  invoice_number: string;
  partner_name: string;
  partner_tax?: string | null;
  issue_date: string | null;
  payment_date: string | null;
  gross: number;
  leaf_id: string | null;
  status: string;
}

/** A terv nélküli számlák újrapárosítása: van-e már hozzá terv (nyitott) vagy banki tény (kifizetve). */
export async function rematchNav(env: Env): Promise<{ unplanned: number }> {
  const rows = (await env.DB.prepare("SELECT * FROM nav_invoices WHERE status = 'new'").all<NavRow>()).results;
  if (!rows.length) return { unplanned: 0 };
  const ctx = await matchingContext(env);
  const byTax = await taxLeafMap(env).catch(() => new Map<string, { in?: string; out?: string }>());
  const actuals = (
    await env.DB.prepare(
      "SELECT id, date, amount, leaf_id, name, link_id FROM entries WHERE kind = 'actual' AND amount < 0 AND date >= date('now', '-200 days')",
    ).all<Entry>()
  ).results;
  const used = new Set(
    (await env.DB.prepare('SELECT plan_id, actual_id FROM nav_invoices WHERE plan_id IS NOT NULL OR actual_id IS NOT NULL').all<any>()).results.flatMap((r) =>
      [r.plan_id, r.actual_id].filter(Boolean),
    ),
  );
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let unplanned = 0;
  for (const r of rows) {
    const date = r.payment_date || r.issue_date || todayHu();
    const tx = { date, amount: r.gross, partner: r.partner_name || '', memo: r.invoice_number };
    // az adószám (partnertörzs) megelőzi a név- és kategóriaszabályokat
    const leaf = byTax.get(taxBase(r.partner_tax))?.out || suggestLeaf(tx, ctx.rules, ctx.leaves, ctx.sectionOf, ctx.contains);
    // 1) már kifizetve (banki tény ugyanazzal az összeggel, a kiállítás után)
    const key = partnerKey(r.partner_name || '');
    const paid = actuals.find(
      (a) =>
        !used.has(a.id) &&
        Math.abs(a.amount - r.gross) <= Math.max(500, Math.abs(r.gross) * 0.01) &&
        a.date >= addDays(r.issue_date || date, -5) &&
        a.date <= addDays(date, 45) &&
        ((leaf && a.leaf_id === leaf) || (key.length >= 3 && partnerKey(a.name).includes(key.split(' ')[0]))),
    );
    if (paid) {
      used.add(paid.id);
      stmts.push(
        env.DB.prepare("UPDATE nav_invoices SET status = 'paid', actual_id = ?, leaf_id = ?, updated_at = ? WHERE id = ?").bind(paid.id, paid.leaf_id, t, r.id),
      );
      continue;
    }
    // 2) van rá nyitott terv
    const plan = matchPlan(
      { ...tx, leaf_id: leaf },
      ctx.plans.filter((p) => !used.has(p.id)),
      ctx.refs,
    );
    if (plan && (plan.leaf_id === leaf || Math.abs(plan.amount - r.gross) <= Math.max(1000, Math.abs(r.gross) * 0.05))) {
      used.add(plan.id);
      stmts.push(
        env.DB.prepare("UPDATE nav_invoices SET status = 'planned', plan_id = ?, leaf_id = ?, updated_at = ? WHERE id = ?").bind(
          plan.id,
          plan.leaf_id,
          t,
          r.id,
        ),
      );
      continue;
    }
    unplanned++;
    if (leaf !== r.leaf_id) stmts.push(env.DB.prepare('UPDATE nav_invoices SET leaf_id = ?, updated_at = ? WHERE id = ?').bind(leaf, t, r.id));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { unplanned };
}

const addMonthsDate = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  const tt = y * 12 + (m - 1) + n;
  const ny = Math.floor(tt / 12),
    nm = (tt % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
};

export interface NavResolve {
  id: string;
  /**
   * recurring = havonta tervbe; unforeseen = egyszeri, előre nem látható költség; assign = egyszeri, a választott kategóriába
   * (a számla hónapjára, partnerrel, összeggel); move = a már besorolt számla kategóriájának módosítása; ignore = nem kell terv
   */
  action: 'recurring' | 'unforeseen' | 'assign' | 'move' | 'ignore' | 'reopen';
  leaf_id?: string;
  months?: number;
  name?: string;
}

const learnPartner = (env: Env, partner: string | null, leaf: string, t: number) => {
  const key = partnerKey(partner || '');
  return key
    ? env.DB.prepare(
        'INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(pattern) DO UPDATE SET leaf_id = excluded.leaf_id, hits = partner_rules.hits + 1, updated_at = excluded.updated_at',
      ).bind(key, leaf, t)
    : null;
};

export async function resolveNav(env: Env, userId: number, it: NavResolve) {
  const r = await env.DB.prepare('SELECT * FROM nav_invoices WHERE id = ?').bind(String(it.id)).first<NavRow & { plan_id: string | null }>();
  if (!r) throw new HttpError(404, 'Nincs ilyen számla.');
  const t = now();
  const base = 'n' + r.id.replace(/[^\w]/g, '').slice(-40);
  // a számlából létrehozott terv(ek): base_0, base_1, … (a sorozat tagjai)
  const own = `substr(id, 1, ${base.length + 1}) = ?`;
  if (it.action === 'ignore' || it.action === 'reopen') {
    const stmts: D1PreparedStatement[] = [];
    if (it.action === 'reopen' && r.status === 'planned') {
      // a még nyitott, ebből a számlából készült tervek a kukába (visszaállíthatók); a már teljesült (bankkal párosított) marad
      stmts.push(
        env.DB.prepare(
          `INSERT INTO deleted_entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by, deleted_at, deleted_by)
           SELECT id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by, ?, ?
           FROM entries WHERE kind = 'plan' AND done = 0 AND ${own}`,
        ).bind(t, userId, base + '_'),
        env.DB.prepare(`DELETE FROM entries WHERE kind = 'plan' AND done = 0 AND ${own}`).bind(base + '_'),
      );
    }
    stmts.push(
      env.DB.prepare('UPDATE nav_invoices SET status = ?, plan_id = CASE WHEN ? THEN NULL ELSE plan_id END, updated_at = ? WHERE id = ?').bind(
        it.action === 'ignore' ? 'ignored' : 'new',
        it.action === 'reopen' && r.status === 'planned' ? 1 : 0,
        t,
        r.id,
      ),
    );
    await env.DB.batch(stmts);
    return;
  }
  if (it.action === 'move') {
    if (r.status !== 'planned' && r.status !== 'paid') throw new HttpError(400, 'A számla még nincs besorolva.');
    const leaf = String(it.leaf_id || '');
    if (!leaf || !(await env.DB.prepare('SELECT id FROM leaves WHERE id = ?').bind(leaf).first())) throw new HttpError(400, 'Válassz kategóriát.');
    const stmts: D1PreparedStatement[] = [
      // a számla tervei (a teljesült is), a hozzájuk párosított banki tény és a sorozat is az új kategóriába kerül
      env.DB.prepare(
        `UPDATE entries SET leaf_id = ?, updated_at = ?, updated_by = ?
         WHERE ${own} OR id IN (SELECT link_id FROM entries WHERE kind = 'plan' AND link_id IS NOT NULL AND ${own})`,
      ).bind(leaf, t, userId, base + '_', base + '_'),
      env.DB.prepare('UPDATE series SET leaf_id = ? WHERE id = ?').bind(leaf, 's' + base),
      env.DB.prepare('UPDATE nav_invoices SET leaf_id = ?, updated_at = ? WHERE id = ?').bind(leaf, t, r.id),
    ];
    const rule = learnPartner(env, r.partner_name, leaf, t);
    if (rule) stmts.push(rule);
    await env.DB.batch(stmts);
    await audit(env, userId, 'nav_resolve', { id: r.id, action: it.action, leaf });
    return;
  }
  const date = r.payment_date || r.issue_date || todayHu();
  const name = (String(it.name || '').trim() || r.partner_name || r.invoice_number).slice(0, 200);
  let leaf = it.leaf_id || r.leaf_id;
  if (it.action === 'assign' && !it.leaf_id) throw new HttpError(400, 'Válassz kategóriát.');
  if (it.action === 'unforeseen' || !leaf) {
    const u = await env.DB.prepare("SELECT l.id, l.label FROM leaves l JOIN groups g ON g.id = l.group_id WHERE g.section = 'out' AND l.archived = 0").all<{
      id: string;
      label: string;
    }>();
    const uf = u.results.find((l) => normalizeText(l.label).startsWith('elore nem lathato'))?.id;
    leaf = it.action === 'unforeseen' ? it.leaf_id || uf || leaf : uf || null;
  }
  if (!leaf) throw new HttpError(400, 'Válassz kategóriát.');
  const ok = await env.DB.prepare('SELECT id FROM leaves WHERE id = ?').bind(leaf).first();
  if (!ok) throw new HttpError(400, 'Ismeretlen kategória.');
  const stmts: D1PreparedStatement[] = [];
  const planId = base + '_0';
  if (it.action === 'recurring') {
    const months = Math.min(36, Math.max(1, Number(it.months) || 12));
    const sid = 's' + base;
    stmts.push(
      env.DB.prepare('INSERT OR REPLACE INTO series (id, leaf_id, name, rep, day) VALUES (?, ?, ?, ?, ?)').bind(
        sid,
        leaf,
        name,
        'monthly',
        Number(date.slice(8)),
      ),
    );
    for (let i = 0; i < months; i++)
      stmts.push(
        env.DB.prepare(
          `INSERT INTO entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, updated_at, updated_by)
           VALUES (?, 'plan', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(`${base}_${i}`, addMonthsDate(date, i), leaf, name, r.gross, sid, i ? 'manual' : 'nav', i ? null : r.id, t, userId),
      );
    const rule = learnPartner(env, r.partner_name, leaf, t);
    if (rule) stmts.push(rule);
  } else {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, ext_ref, note, updated_at, updated_by)
         VALUES (?, 'plan', ?, ?, ?, ?, 0, 0, 'nav', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(planId, date, leaf, name, r.gross, r.id, `NAV számla: ${r.invoice_number}`, t, userId),
    );
    // kézzel választott kategória: a partner következő számlája is ide kerüljön
    const rule = it.action === 'assign' ? learnPartner(env, r.partner_name, leaf, t) : null;
    if (rule) stmts.push(rule);
  }
  stmts.push(env.DB.prepare("UPDATE nav_invoices SET status = 'planned', plan_id = ?, leaf_id = ?, updated_at = ? WHERE id = ?").bind(planId, leaf, t, r.id));
  await env.DB.batch(stmts);
  await audit(env, userId, 'nav_resolve', { id: r.id, action: it.action });
}

/** A tervhez kötött NAV-számlák számlaszáma (a banki közlemény párosításához). */
export async function navInvoiceRefs(env: Env): Promise<Record<string, string>> {
  const r = await env.DB.prepare('SELECT plan_id, invoice_number FROM nav_invoices WHERE plan_id IS NOT NULL').all<{
    plan_id: string;
    invoice_number: string;
  }>();
  const out: Record<string, string> = {};
  r.results.forEach((x) => (out[x.plan_id] = x.invoice_number));
  return out;
}

// ── Egy számla teljes tartalma (tételsorokkal) – a riasztásoknál a számla sorszámára kattintva ──
export interface NavInvoiceData {
  number: string;
  supplier: string;
  supplierTax: string;
  supplierAddress: string;
  customer: string;
  issueDate: string;
  deliveryDate: string;
  paymentDate: string;
  paymentMethod: string;
  currency: string;
  lines: { desc: string; qty: number | null; unit: string; unitPrice: number | null; net: number; vat: string; gross: number }[];
  net: number;
  vat: number;
  gross: number;
}

export function dataRequestXml(env: Env, o: { requestId: string; timestamp: string; contact: string; number: string; supplierTax: string }): string {
  // a lekérdezés fejléce ugyanaz, mint a digestnél – csak a törzs más
  const head = digestRequestXml(env, { ...o, page: 1, from: '2000-01-01', to: '2000-01-01' })
    .replace('QueryInvoiceDigestRequest', 'QueryInvoiceDataRequest')
    .replace(/<page>[\s\S]*<\/QueryInvoiceDigestRequest>/, '');
  return (
    head +
    `<invoiceNumberQuery><invoiceNumber>${esc(o.number)}</invoiceNumber><invoiceDirection>INBOUND</invoiceDirection>` +
    (o.supplierTax ? `<supplierTaxNumber>${esc(o.supplierTax.replace(/\D/g, '').slice(0, 8))}</supplierTaxNumber>` : '') +
    `</invoiceNumberQuery>\n</QueryInvoiceDataRequest>`
  );
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

export function parseInvoiceXml(raw: string, number: string): NavInvoiceData {
  const x = stripNs(raw);
  const num = (v: string) => (v === '' ? null : Math.round(parseFloat(v) * 100) / 100);
  const sup = tag(x, 'supplierInfo');
  const cus = tag(x, 'customerInfo');
  const det = tag(x, 'invoiceDetail');
  const addr = tag(sup, 'supplierAddress');
  const lines: NavInvoiceData['lines'] = [];
  for (const m of x.matchAll(/<line>([\s\S]*?)<\/line>/g)) {
    const l = m[1];
    const net = Math.round(parseFloat(tag(l, 'lineNetAmountHUF') || tag(l, 'lineNetAmount') || '0'));
    const vatAmt = Math.round(parseFloat(tag(l, 'lineVatAmountHUF') || tag(l, 'lineVatAmount') || '0'));
    // egyszerűsített számla (pl. üzemanyag-blokk): csak bruttó összeg és ÁFA-tartalom van
    const simpl = Math.round(parseFloat(tag(l, 'lineGrossAmountSimplifiedHUF') || tag(l, 'lineGrossAmountSimplified') || '0'));
    const vatContent = parseFloat(tag(l, 'vatContent') || '0');
    const gross = Math.round(parseFloat(tag(l, 'lineGrossAmountNormalHUF') || tag(l, 'lineGrossAmountNormal') || '')) || simpl || net + vatAmt;
    const pct = tag(l, 'vatPercentage');
    lines.push({
      desc: tag(l, 'lineDescription') || '—',
      qty: num(tag(l, 'quantity')),
      unit: tag(l, 'unitOfMeasureOwn') || tag(l, 'unitOfMeasure'),
      unitPrice: num(tag(l, 'unitPrice')),
      net: net || (simpl ? Math.round(simpl * (1 - vatContent)) : 0),
      vat: pct
        ? `${Math.round(parseFloat(pct) * 100)}%`
        : vatContent
          ? `${Math.round(vatContent * 10000) / 100}% tart.`
          : tag(l, 'vatExemption')
            ? 'mentes'
            : '',
      gross,
    });
  }
  const sum = tag(x, 'invoiceSummary');
  const lineGross = lines.reduce((a, l) => a + l.gross, 0);
  const lineNet = lines.reduce((a, l) => a + l.net, 0);
  let net = Math.round(parseFloat(tag(sum, 'invoiceNetAmountHUF') || tag(sum, 'invoiceNetAmount') || '0'));
  let vat = Math.round(parseFloat(tag(sum, 'invoiceVatAmountHUF') || tag(sum, 'invoiceVatAmount') || '0'));
  const gross = Math.round(parseFloat(tag(sum, 'invoiceGrossAmountHUF') || tag(sum, 'invoiceGrossAmount') || '')) || net + vat || lineGross;
  // egyszerűsített számlánál a nettó / ÁFA a tételsorok ÁFA-tartalmából
  if (!net && !vat && gross) {
    net = lineNet;
    vat = gross - lineNet;
  }
  return {
    number: tag(x, 'invoiceNumber') || number,
    supplier: tag(sup, 'supplierName'),
    supplierTax: [tag(sup, 'taxpayerId'), tag(sup, 'vatCode'), tag(sup, 'countyCode')].filter(Boolean).join('-'),
    supplierAddress: [
      tag(addr, 'postalCode'),
      tag(addr, 'city'),
      tag(addr, 'streetName'),
      tag(addr, 'publicPlaceCategory'),
      tag(addr, 'number'),
      tag(addr, 'additionalAddressDetail'),
    ]
      .filter(Boolean)
      .join(' '),
    customer: tag(cus, 'customerName'),
    issueDate: tag(x, 'invoiceIssueDate'),
    deliveryDate: tag(det, 'invoiceDeliveryDate'),
    paymentDate: tag(det, 'paymentDate'),
    paymentMethod: tag(det, 'paymentMethod'),
    currency: tag(det, 'currencyCode') || 'HUF',
    lines,
    net,
    vat,
    gross,
  };
}

/**
 * A 0 Ft-os számlák (egyszerűsített számla, pl. üzemanyag-blokk: a listában nincs nettó/ÁFA) bruttó összege a számla
 * teljes adatából – egy szinkronban legfeljebb 25.
 */
export async function fillZeroGross(env: Env): Promise<number> {
  const rows = (
    await env.DB.prepare(
      "SELECT id, invoice_number, partner_tax FROM nav_invoices WHERE gross = 0 AND COALESCE(operation, 'CREATE') = 'CREATE' ORDER BY issue_date DESC LIMIT 25",
    ).all<{ id: string; invoice_number: string; partner_tax: string | null }>()
  ).results;
  let n = 0;
  for (const r of rows) {
    try {
      const d = await fetchInvoiceData(env, r.invoice_number, r.partner_tax || '');
      if (!d.gross) continue;
      await env.DB.prepare('UPDATE nav_invoices SET gross = ?, net = ?, updated_at = ? WHERE id = ?')
        .bind(-Math.abs(d.gross), -Math.abs(d.net), now(), r.id)
        .run();
      n++;
    } catch (e) {
      console.error('nav invoice data', r.invoice_number, e);
    }
  }
  return n;
}

/** NAV queryInvoiceData: a bejövő számla teljes tartalma (base64, esetleg gzip-pel tömörítve). */
export async function fetchInvoiceData(env: Env, number: string, supplierTax: string): Promise<NavInvoiceData> {
  if (!navEnabled(env)) throw new HttpError(400, 'Nincs beállítva NAV kapcsolat.');
  const requestId = ('RID' + randomId().replace(/[^A-Za-z0-9]/g, '')).slice(0, 30);
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '.000Z');
  const body = dataRequestXml(env, { requestId, timestamp, contact: await contactEmail(env), number, supplierTax });
  const text = stripNs(await navPost(env, body, 'queryInvoiceData'));
  const func = tag(text, 'funcCode');
  if (func && func !== 'OK') throw new HttpError(502, `NAV hiba: ${tag(text, 'errorCode') || func} – ${tag(text, 'message') || 'ismeretlen'}`);
  const b64 = tag(text, 'invoiceData');
  if (!b64) throw new HttpError(404, 'A NAV nem adott vissza számlaadatot ehhez a sorszámhoz.');
  const bin = Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const xml = tag(text, 'compressedContentIndicator') === 'true' ? await gunzip(bin) : new TextDecoder().decode(bin);
  return parseInvoiceXml(xml, number);
}
