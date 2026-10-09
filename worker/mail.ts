// E-mail küldés külső szolgáltatón keresztül (Brevo vagy Resend). A kulcs Cloudflare titokként van beállítva.
import type { Env } from './util';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export const mailEnabled = (env: Env) => !!((env.BREVO_API_KEY || env.RESEND_API_KEY) && env.MAIL_FROM);

/** "Cashflow <noreply@pelda.hu>" → { name, email } */
function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || 'Cashflow', email: m[2] } : { name: 'Cashflow', email: from.trim() };
}

export async function sendMail(env: Env, m: Mail): Promise<void> {
  if (!env.MAIL_FROM) throw new Error('Nincs beállítva MAIL_FROM.');
  const from = parseFrom(env.MAIL_FROM);
  let res: Response;
  if (env.BREVO_API_KEY) {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text }),
    });
  } else if (env.RESEND_API_KEY) {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
    });
  } else throw new Error('Nincs beállítva e-mail szolgáltató (BREVO_API_KEY vagy RESEND_API_KEY).');
  if (!res.ok) throw new Error(`E-mail küldési hiba (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function resetMail(name: string, link: string): Omit<Mail, 'to'> {
  return {
    subject: 'Cashflow tervező – jelszó visszaállítása',
    text: `Szia ${name}!\n\nJelszó-visszaállítást kértek a Cashflow tervező fiókodhoz. Új jelszót az alábbi linken állíthatsz be (30 percig érvényes, egyszer használható):\n\n${link}\n\nHa nem te kérted, hagyd figyelmen kívül ezt a levelet – a jelszavad nem változik.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#1F2933">
<h2 style="color:#002040">Jelszó visszaállítása</h2>
<p>Szia ${esc(name)}!</p>
<p>Jelszó-visszaállítást kértek a <b>Cashflow tervező</b> fiókodhoz. Az alábbi gombbal új jelszót állíthatsz be. A link <b>30 percig</b> érvényes és egyszer használható.</p>
<p style="margin:28px 0"><a href="${esc(link)}" style="background:#287FAA;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Új jelszó beállítása</a></p>
<p style="font-size:13px;color:#5B6770">Ha nem te kérted, hagyd figyelmen kívül ezt a levelet – a jelszavad nem változik.</p>
</div>`,
  };
}

export function changedMail(name: string): Omit<Mail, 'to'> {
  return {
    subject: 'Cashflow tervező – a jelszavad megváltozott',
    text: `Szia ${name}!\n\nA Cashflow tervező fiókod jelszavát most megváltoztatták, és minden eszközön kiléptettünk. Ha nem te voltál, azonnal szólj az adminisztrátornak.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#1F2933"><h2 style="color:#002040">A jelszavad megváltozott</h2><p>Szia ${esc(name)}!</p><p>A Cashflow tervező fiókod jelszavát most megváltoztatták, és minden eszközön kiléptettünk.</p><p><b>Ha nem te voltál, azonnal szólj az adminisztrátornak.</b></p></div>`,
  };
}
