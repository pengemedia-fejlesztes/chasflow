#!/usr/bin/env node
// Billingo- és NAV-mock önálló HTTP-szerverként – a lokális app kézi kipróbálásához (ugyanaz a mock, mint a tesztekben:
// tests/helpers/mocks/billingo.ts, nav.ts). Kitalált bemutató adatokkal indul. NINCS bekötve a docker-compose-ba.
//
// Indítás (a repó gyökeréből, Node 22.18+ típuseltávolítással; a hoston nincs Node, ezért Dockerben):
//   docker run --rm -it -p 8790:8790 -v "$PWD:$PWD" -w "$PWD" node:22-bookworm-slim node scripts/dev/mock-external.mjs
// A kiírt env sorokat (BILLINGO_API_KEY/URL, NAV_*) tedd a lokális app .env-jébe; a konténerből a host:
//   BILLINGO_API_URL=http://host.docker.internal:8790/billingo/v3  NAV_API_URL=http://host.docker.internal:8790/nav/invoiceService/v3
//
// Kezelő végpontok (JSON):
//   GET  /_mock/state                     – a mock teljes állapota (bizonylatok, rögzített fizetések, NAV-számlák, kérések)
//   POST /_mock/billingo/documents        – új kimenő számla  { partner, gross, dueDate, number?, status?, ... }
//   POST /_mock/billingo/pay              – fizetés a Billingóban { id, amount?, date? }
//   POST /_mock/billingo/cancel           – sztornó { id }
//   POST /_mock/nav/invoices              – új bejövő számla { number, supplierName, supplierTax, issueDate, gross, ... }
//   POST /_mock/fail                      – hibaszimuláció { target: 'billingo' | 'nav', failure: 429 | 500 | 'bad-json' | ..., times? }
import { createServer } from 'node:http';
import { mockBillingo } from '../../tests/helpers/mocks/billingo.ts';
import { mockNav } from '../../tests/helpers/mocks/nav.ts';

const PORT = Number(process.env.MOCK_PORT || 8790);
const PUBLIC = process.env.MOCK_PUBLIC_URL || `http://host.docker.internal:${PORT}`;
const INTERNAL = 'http://mock.local';
const billingo = mockBillingo({ base: `${INTERNAL}/billingo/v3` });
const nav = mockNav({ base: `${INTERNAL}/nav/invoiceService/v3` });

// bemutató adatok (kitalált)
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
billingo.addDocument({ partner: 'Minta Kft.', taxcode: '11111111-2-41', gross: 254_000, invoiceDate: day(-3), dueDate: day(5) });
billingo.addDocument({ partner: 'Példa Bt.', taxcode: '22222222-1-13', gross: 63_500, invoiceDate: day(-20), dueDate: day(-12) });
billingo.addDocument({ partner: 'Teszt Zrt.', taxcode: '33333333-2-42', gross: 1_270_000, invoiceDate: day(-15), dueDate: day(-7), status: 'paid', paidDate: day(-6) });
nav.addInvoice({ number: 'TSZ-2026/0815', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '44444444-2-41', issueDate: day(-4), paymentDate: day(4), gross: 12_700 });
nav.addInvoice({ number: 'KI-2026-516', supplierName: 'Könyvelő Iroda Kft.', supplierTax: '55555555-2-13', issueDate: day(-2), paymentDate: day(6), gross: 36_830 });

const readBody = (req) =>
  new Promise((ok) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
  });
const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 1));
};

createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, INTERNAL);
  try {
    if (url.pathname.startsWith('/_mock/')) {
      const b = body.length ? JSON.parse(body.toString()) : {};
      const p = url.pathname;
      if (req.method === 'GET' && p === '/_mock/state')
        return send(res, 200, { billingo: { documents: billingo.documents, payments: billingo.payments, requests: billingo.requests.slice(-50) }, nav: { invoices: nav.invoices, requests: nav.requests.slice(-50) } });
      if (req.method === 'POST' && p === '/_mock/billingo/documents') return send(res, 201, billingo.addDocument(b));
      if (req.method === 'POST' && p === '/_mock/billingo/pay') return send(res, 200, billingo.pay(Number(b.id), b));
      if (req.method === 'POST' && p === '/_mock/billingo/cancel') return send(res, 200, billingo.cancel(Number(b.id)));
      if (req.method === 'POST' && p === '/_mock/nav/invoices') return send(res, 201, nav.addInvoice(b));
      if (req.method === 'POST' && p === '/_mock/fail') {
        (b.target === 'nav' ? nav : billingo).fail(b.failure, { times: b.times });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'ismeretlen kezelő végpont' });
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(INTERNAL + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const r = (await billingo.handle(request)) || (await nav.handle(request));
    if (!r) return send(res, 404, { error: `nincs mock ehhez: ${req.method} ${req.url}` });
    let text = await r.text();
    text = text.split(INTERNAL).join(PUBLIC);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(text);
    console.log(`${req.method} ${req.url} → ${r.status}`);
  } catch (e) {
    // időtúllépés-szimuláció: a kapcsolat válasz nélkül megszakad; minden más hiba hangosan
    if (e?.name === 'TimeoutError' || e?.message === 'fetch failed') {
      console.error(`${req.method} ${req.url} → szimulált ${e.name}`);
      return req.socket.destroy();
    }
    console.error(`HIBA ${req.method} ${req.url}: ${e?.message || e}`);
    send(res, 501, { error: String(e?.message || e) });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Billingo/NAV mock: http://0.0.0.0:${PORT}  (kezelés: /_mock/state)`);
  console.log('Az app .env-jébe:');
  for (const [k, v] of Object.entries({ ...billingo.env, ...nav.env })) console.log(`  ${k}=${String(v).split(INTERNAL).join(PUBLIC)}`);
});
