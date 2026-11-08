// Billingo v3 API mock – memóriabeli állapottal, a valódi válaszformátummal. Csak azokat a végpontokat ismeri, amelyeket
// az app hív (src/server/app/billingo.ts):
//   GET  /documents?page=&per_page=&start_date=   – bizonylatok listája (lapozva)
//   GET  /documents/{id}                          – egy bizonylat (az automatikus „fizetve” előtti friss állapot)
//   GET  /documents/{id}/public-url               – nyilvános számlakép link
//   GET  /documents/{id}/payments                 – a számla fizetései (részfizetésnél a befolyt összeg)
//   PUT  /documents/{id}/payments                 – fizetés(ek) rögzítése (az app „fizetve”-jelölése) → `payments` naplóba
// Minden más kérés a mock alatt hangos hibát dob. Hibaszimuláció: `fail(429 | 500 | 401 | 'timeout' | 'network' | 'bad-json')`.
// Csak kitalált adat! Önállóan is fut (Node típuseltávolítással): scripts/dev/mock-external.mjs.
// FONTOS: ez a fájl Node-ból közvetlenül is betöltődik, ezért csak „törölhető” TS-szintaxis lehet benne (nincs enum, import csak `import type`).

export type BillingoStatus = 'outstanding' | 'expired' | 'paid' | 'partially_paid' | 'none';
export type BillingoDocType = 'invoice' | 'advance' | 'proforma' | 'cancellation' | 'modification' | 'draft';
export type MockFailure = 429 | 500 | 502 | 401 | 'timeout' | 'network' | 'bad-json';

export interface BillingoPartner {
  id: number;
  name: string;
  taxcode: string;
  emails: string[];
}
export interface BillingoPayment {
  date: string;
  price: number;
  payment_method: string;
  voucher_number?: string;
}
export interface BillingoDocument {
  id: number;
  invoice_number: string;
  type: BillingoDocType;
  cancelled: boolean;
  /** a megadott (nem számított) fizetési állapot; a lejártat a mock a határidőből számolja */
  payment_status: BillingoStatus;
  payment_method: string;
  gross_total: number;
  net_total: number;
  currency: string;
  conversion_rate: number;
  invoice_date: string;
  fulfillment_date: string;
  due_date: string;
  paid_date: string | null;
  partner: BillingoPartner;
  /** a helyesbítő / sztornó számla eredetije */
  original_document_id?: number;
  payments: BillingoPayment[];
}
export interface BillingoDocInput {
  id?: number;
  number?: string;
  /** partner neve vagy egy addPartner()-rel felvett partner */
  partner: string | BillingoPartner;
  taxcode?: string;
  gross: number;
  /** nettó (alapértelmezés: bruttó / 1,27) */
  net?: number;
  currency?: string;
  rate?: number;
  invoiceDate?: string;
  fulfillmentDate?: string;
  dueDate: string;
  status?: BillingoStatus;
  paidDate?: string;
  type?: BillingoDocType;
  cancelled?: boolean;
  paymentMethod?: string;
}
export interface MockRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Hibaszimuláció közös része (a NAV mock is ezt használja). */
export function failureQueue() {
  const queue: { failure: MockFailure; times: number; match?: RegExp }[] = [];
  return {
    /** a következő `times` (alapból 1) illeszkedő kérés hibával tér vissza */
    fail(failure: MockFailure, opts: { times?: number; match?: RegExp } = {}) {
      queue.push({ failure, times: opts.times ?? 1, match: opts.match });
    },
    clear: () => void queue.splice(0),
    /** a soron következő hiba erre a kérésre (és fogyasztja) – vagy null */
    take(path: string): MockFailure | null {
      const i = queue.findIndex((q) => !q.match || q.match.test(path));
      if (i < 0) return null;
      const q = queue[i];
      if (--q.times <= 0) queue.splice(i, 1);
      return q.failure;
    },
  };
}

/** A szimulált hiba válasza: HTTP-hibakód, hibás törzs, vagy elutasított fetch (időtúllépés / hálózat). */
export function failureResponse(f: MockFailure, body: (status: number) => Response): Response {
  if (f === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  if (f === 'network') throw new TypeError('fetch failed');
  if (f === 'bad-json') return new Response('<html><body>502 Bad Gateway – upstream</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  return body(f);
}

export function mockBillingo(opts: { base?: string; apiKey?: string; perPage?: number } = {}) {
  const base = (opts.base || 'https://billingo.mock/v3').replace(/\/+$/, '');
  const apiKey = opts.apiKey || 'teszt-billingo-kulcs';
  const docs: BillingoDocument[] = [];
  const partners: BillingoPartner[] = [];
  const payments: { documentId: number; payments: BillingoPayment[]; at: number }[] = [];
  const requests: MockRequestLog[] = [];
  const failures = failureQueue();
  let nextDoc = 140_000_001;
  let nextPartner = 2_000_001;
  let nextNumber = 1;

  const find = (id: number) => {
    const d = docs.find((x) => x.id === id);
    if (!d) throw new Error(`Billingo mock: nincs ${id} azonosítójú bizonylat`);
    return d;
  };
  /** a Billingo a lejárt, kifizetetlen számlát „expired”-nek mutatja */
  const view = (d: BillingoDocument) => {
    const { payments: _p, original_document_id, ...rest } = d;
    const status = d.payment_status === 'outstanding' && d.due_date < todayIso() ? 'expired' : d.payment_status;
    return { ...rest, payment_status: status, ...(original_document_id ? { original_document_id } : {}) };
  };

  const api = {
    name: 'billingo' as const,
    base,
    /** a createTestApp-nek / a lokális appnak átadható env */
    env: { BILLINGO_API_KEY: apiKey, BILLINGO_API_URL: base } as Record<string, string>,
    documents: docs,
    partners,
    /** az app által rögzített fizetések (PUT /documents/{id}/payments), időrendben */
    payments,
    /** minden beérkezett kérés */
    requests,
    fail: failures.fail,
    clearFailures: failures.clear,

    addPartner(name: string, taxcode = ''): BillingoPartner {
      const p = { id: nextPartner++, name, taxcode, emails: [] };
      partners.push(p);
      return p;
    },

    /** kimenő számla (alapból: „invoice”, kifizetetlen, HUF) */
    addDocument(input: BillingoDocInput): BillingoDocument {
      const partner =
        typeof input.partner === 'string'
          ? partners.find((p) => p.name === input.partner) || api.addPartner(input.partner, input.taxcode)
          : input.partner;
      const invoiceDate = input.invoiceDate || todayIso();
      const d: BillingoDocument = {
        id: input.id ?? nextDoc++,
        invoice_number: input.number || `MOCK-${invoiceDate.slice(0, 4)}-${String(nextNumber++).padStart(6, '0')}`,
        type: input.type || 'invoice',
        cancelled: !!input.cancelled,
        payment_status: input.status || 'outstanding',
        payment_method: input.paymentMethod || 'wire_transfer',
        gross_total: input.gross,
        net_total: input.net ?? Math.round((input.gross / 1.27) * 100) / 100,
        currency: input.currency || 'HUF',
        conversion_rate: input.rate ?? 1,
        invoice_date: invoiceDate,
        fulfillment_date: input.fulfillmentDate || invoiceDate,
        due_date: input.dueDate,
        paid_date: input.paidDate ?? null,
        partner,
        payments: input.status === 'paid' ? [{ date: input.paidDate || invoiceDate, price: input.gross, payment_method: 'wire_transfer' }] : [],
      };
      docs.push(d);
      return d;
    },

    /** fizetés a Billingóban (pl. a könyvelő rögzíti): részösszegnél „partially_paid” */
    pay(id: number, opts: { date?: string; amount?: number } = {}) {
      const d = find(id);
      d.payments.push({ date: opts.date || todayIso(), price: opts.amount ?? d.gross_total, payment_method: 'wire_transfer' });
      settle(d);
      return d;
    },

    /** sztornó: az eredeti „cancelled”, és létrejön a sztornó bizonylat (negatív összeggel) */
    cancel(id: number, opts: { date?: string } = {}) {
      const d = find(id);
      d.cancelled = true;
      return api.addDocument({
        partner: d.partner,
        gross: -d.gross_total,
        net: -d.net_total,
        dueDate: opts.date || todayIso(),
        invoiceDate: opts.date || todayIso(),
        type: 'cancellation',
        status: 'none',
        number: `${d.invoice_number}-S`,
      });
    },

    /** helyesbítő (módosító) számla az eredetihez – a különbözet összegével */
    modify(id: number, diffGross: number, opts: { date?: string; dueDate?: string } = {}) {
      const d = find(id);
      const m = api.addDocument({
        partner: d.partner,
        gross: diffGross,
        dueDate: opts.dueDate || d.due_date,
        invoiceDate: opts.date || todayIso(),
        type: 'modification',
        number: `${d.invoice_number}-M1`,
      });
      m.original_document_id = d.id;
      return m;
    },

    async handle(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      if (!req.url.startsWith(base + '/')) return null;
      const path = url.pathname.slice(new URL(base).pathname.replace(/\/+$/, '').length);
      const query = Object.fromEntries(url.searchParams);
      const body = req.method === 'PUT' || req.method === 'POST' ? await req.json().catch(() => undefined) : undefined;
      requests.push({ method: req.method, path, query, body });
      const f = failures.take(path);
      if (f !== null)
        return failureResponse(f, (status) =>
          json({ error: { message: status === 429 ? 'Too Many Attempts.' : status === 401 ? 'Unauthenticated.' : 'Server Error' } }, status, status === 429 ? { 'Retry-After': '60' } : {}),
        );
      if (req.headers.get('X-API-KEY') !== apiKey) return json({ error: { message: 'Unauthenticated.' } }, 401);

      if (req.method === 'GET' && path === '/documents') {
        const per = Math.min(100, Number(query.per_page) || opts.perPage || 25);
        const page = Math.max(1, Number(query.page) || 1);
        const list = docs.filter((d) => !query.start_date || d.invoice_date >= query.start_date).sort((a, b) => b.id - a.id);
        const last = Math.max(1, Math.ceil(list.length / per));
        return json({
          data: list.slice((page - 1) * per, page * per).map(view),
          total: list.length,
          per_page: per,
          current_page: page,
          last_page: last,
          prev_page_url: page > 1 ? `${base}/documents?page=${page - 1}` : null,
          next_page_url: page < last ? `${base}/documents?page=${page + 1}` : null,
        });
      }
      const m = path.match(/^\/documents\/(\d+)(\/public-url|\/payments)?$/);
      if (m) {
        const d = docs.find((x) => x.id === Number(m[1]));
        if (!d) return json({ error: { message: 'Document not found.' } }, 404);
        if (req.method === 'GET' && !m[2]) return json(view(d));
        if (req.method === 'GET' && m[2] === '/payments')
          return json(d.payments.map((p, i) => ({ id: i + 1, ...p, conversion_rate: d.conversion_rate, is_conciliated: false })));
        if (req.method === 'GET' && m[2] === '/public-url') return json({ public_url: `${base.replace(/\/v3$/, '')}/public/${d.id}.pdf` });
        if (req.method === 'PUT' && m[2] === '/payments') {
          if (!Array.isArray(body)) return json({ error: { message: 'The given data was invalid.' } }, 422);
          // a Billingo a teljes fizetési listát cseréli le
          d.payments = (body as BillingoPayment[]).map((p) => ({ ...p }));
          payments.push({ documentId: d.id, payments: d.payments.map((p) => ({ ...p })), at: Date.now() });
          settle(d);
          return json(d.payments.map((p, i) => ({ id: i + 1, ...p, conversion_rate: 1, is_conciliated: false })));
        }
      }
      throw new Error(`Billingo mock: nem támogatott kérés: ${req.method} ${path}`);
    },
  };

  function settle(d: BillingoDocument) {
    const paid = d.payments.reduce((a, p) => a + Number(p.price), 0);
    d.payment_status = paid <= 0 ? 'outstanding' : paid + 0.5 >= d.gross_total ? 'paid' : 'partially_paid';
    d.paid_date = d.payment_status === 'paid' ? d.payments.map((p) => p.date).sort().at(-1)! : null;
  }

  return api;
}
export type BillingoMock = ReturnType<typeof mockBillingo>;
