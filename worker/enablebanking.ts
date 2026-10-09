// Enable Banking (PSD2 számlainformációs szolgáltató) – minimális kliens.
// Dokumentáció: https://enablebanking.com/docs/api/reference/
import { Env, b64decode, b64url } from './util';

const API = 'https://api.enablebanking.com';

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function importKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error('Az EB_PRIVATE_KEY PKCS#1 formátumú. Alakítsd PKCS#8-ra: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key8.pem');
  }
  const body = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', b64decode(body), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  cachedKey = { pem, key };
  return key;
}

export async function jwt(env: Env): Promise<string> {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) throw new Error('Az Enable Banking nincs beállítva (EB_APP_ID, EB_PRIVATE_KEY).');
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const iat = Math.floor(Date.now() / 1000);
  const head = enc({ typ: 'JWT', alg: 'RS256', kid: env.EB_APP_ID });
  const body = enc({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(env.EB_PRIVATE_KEY), new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + b64url(sig);
}

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await jwt(env)), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.message || j.detail || j.error || msg;
    } catch {}
    throw new Error(`Enable Banking hiba (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return JSON.parse(text) as T;
}

export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
}

export const listAspsps = (env: Env) => call<{ aspsps: Aspsp[] }>(env, 'GET', '/aspsps?country=HU&service=AIS').then((r) => r.aspsps);

export function startAuth(env: Env, bankName: string, state: string, redirectUrl: string, validDays: number, psuType: 'business' | 'personal') {
  const validUntil = new Date(Date.now() + validDays * 86400_000).toISOString();
  return call<{ url: string; authorization_id: string }>(env, 'POST', '/auth', {
    access: { valid_until: validUntil },
    aspsp: { name: bankName, country: 'HU' },
    state,
    redirect_url: redirectUrl,
    psu_type: psuType,
    language: 'hu',
  });
}

export interface EbAccount {
  uid: string;
  account_id?: { iban?: string; other?: { identification?: string } };
  name?: string;
  currency?: string;
  product?: string;
}

export const createSession = (env: Env, code: string) =>
  call<{ session_id: string; accounts: EbAccount[]; aspsp: { name: string }; access: { valid_until: string } }>(env, 'POST', '/sessions', { code });

export interface EbBalance {
  balance_amount: { amount: string; currency: string };
  balance_type: string;
}
export const getBalances = (env: Env, uid: string) => call<{ balances: EbBalance[] }>(env, 'GET', `/accounts/${uid}/balances`).then((r) => r.balances || []);

export interface EbTx {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: 'CRDT' | 'DBIT';
  status?: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  creditor?: { name?: string };
  debtor?: { name?: string };
  remittance_information?: string[];
  note?: string;
}

export async function getTransactions(env: Env, uid: string, dateFrom: string): Promise<EbTx[]> {
  const out: EbTx[] = [];
  let ck: string | undefined;
  for (let i = 0; i < 30; i++) {
    const q = new URLSearchParams({ date_from: dateFrom });
    if (ck) q.set('continuation_key', ck);
    const r = await call<{ transactions: EbTx[]; continuation_key?: string }>(env, 'GET', `/accounts/${uid}/transactions?${q}`);
    out.push(...(r.transactions || []));
    if (!r.continuation_key) break;
    ck = r.continuation_key;
  }
  return out;
}
