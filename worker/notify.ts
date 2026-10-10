// Automatikus értesítés szinkron után: új, terv nélküli tételek (NAV-számla, banki tétel) e-mailben az adminoknak.
// (A felületen a riasztás-sáv mindig jelzi; az e-mail csak akkor megy, ha be van állítva levélküldő szolgáltató.)
import { fmt } from '../shared/model';
import { mailEnabled, sendMail } from './mail';
import { Env, getSetting, now, setSetting } from './util';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function notifyUnplanned(env: Env, origin = 'https://cashflow-tervezo.pengemedia.workers.dev'): Promise<{ sent: number; items: number }> {
  const since = Number((await getSetting(env, 'notify_unplanned_at')) || 0);
  const t = now();
  const [inv, tx] = await env.DB.batch([
    env.DB.prepare(
      "SELECT partner_name AS name, invoice_number AS ref, payment_date AS date, gross AS amount FROM nav_invoices WHERE status = 'new' AND created_at > ?",
    ).bind(since),
    env.DB.prepare(
      "SELECT partner AS name, memo AS ref, date, amount FROM bank_tx WHERE status = 'new' AND plan_id IS NULL AND created_at > ? AND date >= date('now', '-30 days')",
    ).bind(since),
  ]);
  const rows = [...(inv.results as any[]).map((r) => ({ ...r, src: 'NAV-számla' })), ...(tx.results as any[]).map((r) => ({ ...r, src: 'Bank' }))];
  await setSetting(env, 'notify_unplanned_at', String(t));
  // első futáskor csak megjegyzi az időpontot (nem küldi el a teljes előzményt)
  if (!since || !rows.length || !mailEnabled(env)) return { sent: 0, items: rows.length };
  const admins = (await env.DB.prepare("SELECT email FROM users WHERE role = 'admin' AND disabled = 0").all<{ email: string }>()).results;
  const list = rows.map((r) => `${r.src}: ${r.name || r.ref} · ${fmt(r.amount)} Ft${r.date ? ' · ' + r.date : ''}`);
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1F2933"><h2 style="color:#002040">${rows.length} új tétel terv nélkül</h2>
<p>Ezekhez nem tartozott terv. Döntsd el tételenként: <b>rendszeres</b> (havonta tervbe egy kategóriába) vagy <b>előre nem látható költség</b>.</p>
<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p style="margin:24px 0"><a href="${origin}/?tab=alerts" style="background:#287FAA;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Megnézem a riasztásokat</a></p></div>`;
  let sent = 0;
  for (const a of admins) {
    await sendMail(env, { to: a.email, subject: `Cashflow – ${rows.length} új tétel terv nélkül`, html, text: list.join('\n') + `\n\n${origin}` });
    sent++;
  }
  return { sent, items: rows.length };
}
