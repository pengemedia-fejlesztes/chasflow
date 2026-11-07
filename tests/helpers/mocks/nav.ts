// NAV Online Számla v3 mock (bejövő / szállítói számlák) – memóriabeli állapottal, a valódi XML-formátumban, ahogy a
// src/server/app/nav.ts olvassa. Csak az app által hívott műveletek:
//   POST {base}/queryInvoiceDigest  – számla-kivonatok kiállítási időszakra, lapozva (INBOUND)
//   POST {base}/queryInvoiceData    – egy számla teljes tartalma (base64, opcionálisan gzip)
// Ellenőrzi a technikai felhasználót (login, jelszó-hash, kérés-aláírás) – hibás adatnál a NAV hibaválaszát adja.
// Hibaszimuláció: `fail(500 | 502 | 'timeout' | 'network' | 'bad-json')`, `failNav('INVALID_SECURITY_USER')`.
// Csak kitalált adat! Ez a fájl Node-ból közvetlenül is betöltődik (scripts/dev/mock-external.mjs): csak törölhető TS-szintaxis.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export type NavMockFailure = 500 | 502 | 503 | 'timeout' | 'network' | 'bad-json';
export interface NavLine {
  description: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  net: number;
  /** ÁFA-kulcs (0.27); egyszerűsített számlánál nincs */
  vatRate?: number;
}
export interface NavInvoiceInput {
  number: string;
  supplierName: string;
  /** 12345678-2-41 alakú adószám */
  supplierTax: string;
  issueDate: string;
  deliveryDate?: string;
  /** fizetési határidő */
  paymentDate?: string;
  paymentMethod?: 'TRANSFER' | 'CARD' | 'CASH' | 'OTHER';
  currency?: string;
  exchangeRate?: number;
  /** nettó és ÁFA (Ft); ha csak `gross` van, 27% ÁFÁ-val bontja */
  net?: number;
  vat?: number;
  gross?: number;
  operation?: 'CREATE' | 'MODIFY' | 'STORNO';
  originalInvoiceNumber?: string;
  lines?: NavLine[];
  /** egyszerűsített számla (pl. üzemanyag): a kivonatban nincs nettó / ÁFA */
  simplified?: boolean;
  /** tömörítve (gzip) adja vissza a számlaadatot */
  compressed?: boolean;
}
export interface NavInvoice extends Required<Omit<NavInvoiceInput, 'lines' | 'originalInvoiceNumber' | 'gross'>> {
  lines: NavLine[];
  originalInvoiceNumber: string;
  insDate: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const val = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1].trim() ?? '';
const upperHex = (algo: string, s: string) => createHash(algo).update(s, 'utf8').digest('hex').toUpperCase();
const xmlResponse = (xml: string, status = 200) => new Response(xml, { status, headers: { 'Content-Type': 'application/xml;charset=UTF-8' } });

const NS =
  'xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base" xmlns:data="http://schemas.nav.gov.hu/OSA/3.0/data"';
const head = (requestId: string) =>
  `<common:header><common:requestId>${esc(requestId)}</common:requestId><common:timestamp>${new Date().toISOString()}</common:timestamp><common:requestVersion>3.0</common:requestVersion><common:headerVersion>1.0</common:headerVersion></common:header>`;
const software = `<software><softwareId>HU00000000-MOCK001</softwareId><softwareName>NAV mock</softwareName><softwareOperation>ONLINE_SERVICE</softwareOperation><softwareMainVersion>1.0</softwareMainVersion><softwareDevName>mock</softwareDevName><softwareDevContact>mock@example.hu</softwareDevContact></software>`;

/** a NAV hibaválasza (GeneralErrorResponse) */
export const navError = (code: string, message: string, requestId = 'RID') =>
  xmlResponse(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><GeneralErrorResponse ${NS}>${head(requestId)}<common:result><common:funcCode>ERROR</common:funcCode><common:errorCode>${code}</common:errorCode><common:message>${esc(message)}</common:message></common:result>${software}</GeneralErrorResponse>`,
    code === 'INVALID_SECURITY_USER' || code === 'INVALID_REQUEST_SIGNATURE' ? 401 : 400,
  );

export function mockNav(opts: { base?: string; pageSize?: number; login?: string; password?: string; signKey?: string; taxNumber?: string; customerName?: string } = {}) {
  const base = (opts.base || 'https://nav.mock/invoiceService/v3').replace(/\/+$/, '');
  const login = opts.login || 'mocktechuser';
  const password = opts.password || 'Mock-jelszo-1';
  const signKey = opts.signKey || 'mock-alairo-kulcs-0123456789abcdef';
  const taxNumber = opts.taxNumber || '99999999';
  const customerName = opts.customerName || 'Teszt Ügyfél Kft.';
  const invoices: NavInvoice[] = [];
  const requests: { op: string; requestId: string; from?: string; to?: string; page?: number; number?: string; supplierTax?: string }[] = [];
  const failures: { failure: NavMockFailure | { code: string; message: string }; times: number; op?: string }[] = [];
  let pageSize = opts.pageSize || 100;

  const takeFailure = (op: string) => {
    const i = failures.findIndex((f) => !f.op || f.op === op);
    if (i < 0) return null;
    const f = failures[i];
    if (--f.times <= 0) failures.splice(i, 1);
    return f.failure;
  };
  const amounts = (inv: NavInvoice) => ({ net: inv.net, vat: inv.vat, gross: inv.net + inv.vat });

  function digestXml(inv: NavInvoice, index: number) {
    const a = amounts(inv);
    const rate = inv.exchangeRate || 1;
    const money = inv.simplified
      ? ''
      : `<invoiceNetAmount>${(a.net / rate).toFixed(2)}</invoiceNetAmount><invoiceNetAmountHUF>${a.net.toFixed(2)}</invoiceNetAmountHUF><invoiceVatAmount>${(a.vat / rate).toFixed(2)}</invoiceVatAmount><invoiceVatAmountHUF>${a.vat.toFixed(2)}</invoiceVatAmountHUF>`;
    return (
      `<invoiceDigest><invoiceNumber>${esc(inv.number)}</invoiceNumber><invoiceOperation>${inv.operation}</invoiceOperation><invoiceCategory>${inv.simplified ? 'SIMPLIFIED' : 'NORMAL'}</invoiceCategory>` +
      `<invoiceIssueDate>${inv.issueDate}</invoiceIssueDate><supplierTaxNumber>${inv.supplierTax.replace(/\D/g, '').slice(0, 8)}</supplierTaxNumber><supplierName>${esc(inv.supplierName)}</supplierName>` +
      `<customerTaxNumber>${taxNumber}</customerTaxNumber><customerName>${esc(customerName)}</customerName>` +
      (inv.paymentMethod ? `<paymentMethod>${inv.paymentMethod}</paymentMethod>` : '') +
      (inv.paymentDate ? `<paymentDate>${inv.paymentDate}</paymentDate>` : '') +
      `<invoiceAppearance>ELECTRONIC</invoiceAppearance><source>OSZ</source><invoiceDeliveryDate>${inv.deliveryDate}</invoiceDeliveryDate><currency>${inv.currency}</currency>` +
      money +
      (inv.originalInvoiceNumber ? `<originalInvoiceNumber>${esc(inv.originalInvoiceNumber)}</originalInvoiceNumber><modificationIndex>1</modificationIndex>` : '') +
      `<transactionId>MOCKTX${String(index).padStart(10, '0')}</transactionId><index>1</index><insDate>${inv.insDate}</insDate><completenessIndicator>false</completenessIndicator></invoiceDigest>`
    );
  }

  function invoiceDataXml(inv: NavInvoice) {
    const tax = inv.supplierTax.replace(/\D/g, '');
    const lines = inv.lines
      .map((l, i) => {
        const vat = Math.round(l.net * (l.vatRate ?? 0));
        const gross = l.net + vat;
        const amounts = inv.simplified
          ? `<lineAmountsSimplified><lineVatRate><vatContent>${(0.27 / 1.27).toFixed(4)}</vatContent></lineVatRate><lineGrossAmountSimplified>${gross}</lineGrossAmountSimplified><lineGrossAmountSimplifiedHUF>${gross}</lineGrossAmountSimplifiedHUF></lineAmountsSimplified>`
          : `<lineAmountsNormal><lineNetAmountData><lineNetAmount>${l.net}</lineNetAmount><lineNetAmountHUF>${l.net}</lineNetAmountHUF></lineNetAmountData><lineVatRate><vatPercentage>${l.vatRate ?? 0}</vatPercentage></lineVatRate><lineVatData><lineVatAmount>${vat}</lineVatAmount><lineVatAmountHUF>${vat}</lineVatAmountHUF></lineVatData><lineGrossAmountData><lineGrossAmountNormal>${gross}</lineGrossAmountNormal><lineGrossAmountNormalHUF>${gross}</lineGrossAmountNormalHUF></lineGrossAmountData></lineAmountsNormal>`;
        return `<line><lineNumber>${i + 1}</lineNumber><lineExpressionIndicator>true</lineExpressionIndicator><lineDescription>${esc(l.description)}</lineDescription><quantity>${l.quantity ?? 1}</quantity><unitOfMeasure>OWN</unitOfMeasure><unitOfMeasureOwn>${esc(l.unit || 'db')}</unitOfMeasureOwn><unitPrice>${l.unitPrice ?? l.net}</unitPrice>${amounts}</line>`;
      })
      .join('');
    const a = amounts(inv);
    const summary = inv.simplified
      ? `<summarySimplified><vatRate><vatContent>${(0.27 / 1.27).toFixed(4)}</vatContent></vatRate><vatContentGrossAmount>${a.gross}</vatContentGrossAmount><vatContentGrossAmountHUF>${a.gross}</vatContentGrossAmountHUF></summarySimplified>`
      : `<summaryNormal><summaryByVatRate><vatRate><vatPercentage>0.27</vatPercentage></vatRate><vatRateNetData><vatRateNetAmount>${a.net}</vatRateNetAmount><vatRateNetAmountHUF>${a.net}</vatRateNetAmountHUF></vatRateNetData><vatRateVatData><vatRateVatAmount>${a.vat}</vatRateVatAmount><vatRateVatAmountHUF>${a.vat}</vatRateVatAmountHUF></vatRateVatData></summaryByVatRate><invoiceNetAmount>${a.net}</invoiceNetAmount><invoiceNetAmountHUF>${a.net}</invoiceNetAmountHUF><invoiceVatAmount>${a.vat}</invoiceVatAmount><invoiceVatAmountHUF>${a.vat}</invoiceVatAmountHUF></summaryNormal>`;
    return (
      `<?xml version="1.0" encoding="UTF-8"?><InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">` +
      `<invoiceNumber>${esc(inv.number)}</invoiceNumber><invoiceIssueDate>${inv.issueDate}</invoiceIssueDate><completenessIndicator>false</completenessIndicator><invoiceMain><invoice><invoiceHead>` +
      `<supplierInfo><supplierTaxNumber><base:taxpayerId>${tax.slice(0, 8)}</base:taxpayerId><base:vatCode>${tax.slice(8, 9) || '2'}</base:vatCode><base:countyCode>${tax.slice(9, 11) || '41'}</base:countyCode></supplierTaxNumber>` +
      `<supplierName>${esc(inv.supplierName)}</supplierName><supplierAddress><base:detailedAddress><base:countryCode>HU</base:countryCode><base:postalCode>1111</base:postalCode><base:city>Budapest</base:city><base:streetName>Minta</base:streetName><base:publicPlaceCategory>utca</base:publicPlaceCategory><base:number>1.</base:number></base:detailedAddress></supplierAddress></supplierInfo>` +
      `<customerInfo><customerVatStatus>DOMESTIC</customerVatStatus><customerName>${esc(customerName)}</customerName></customerInfo>` +
      `<invoiceDetail><invoiceCategory>${inv.simplified ? 'SIMPLIFIED' : 'NORMAL'}</invoiceCategory><invoiceDeliveryDate>${inv.deliveryDate}</invoiceDeliveryDate><currencyCode>${inv.currency}</currencyCode><exchangeRate>${inv.exchangeRate || 1}</exchangeRate>` +
      (inv.paymentMethod ? `<paymentMethod>${inv.paymentMethod}</paymentMethod>` : '') +
      (inv.paymentDate ? `<paymentDate>${inv.paymentDate}</paymentDate>` : '') +
      `<invoiceAppearance>ELECTRONIC</invoiceAppearance></invoiceDetail></invoiceHead>` +
      `<invoiceLines><mergedItemIndicator>false</mergedItemIndicator>${lines}</invoiceLines>` +
      `<invoiceSummary>${summary}<summaryGrossData><invoiceGrossAmount>${a.gross}</invoiceGrossAmount><invoiceGrossAmountHUF>${a.gross}</invoiceGrossAmountHUF></summaryGrossData></invoiceSummary>` +
      `</invoice></invoiceMain></InvoiceData>`
    );
  }

  const api = {
    name: 'nav' as const,
    base,
    env: { NAV_LOGIN: login, NAV_PASSWORD: password, NAV_SIGN_KEY: signKey, NAV_TAX_NUMBER: taxNumber, NAV_API_URL: base } as Record<string, string>,
    invoices,
    requests,
    setPageSize: (n: number) => void (pageSize = n),

    /** bejövő (szállítói) számla; bruttó összegből 27% ÁFÁ-val bont, tételsor nélkül egy sort képez */
    addInvoice(input: NavInvoiceInput): NavInvoice {
      const net = input.net ?? Math.round((input.gross ?? 0) / 1.27);
      const vat = input.vat ?? (input.gross != null ? input.gross - net : Math.round(net * 0.27));
      const inv: NavInvoice = {
        number: input.number,
        supplierName: input.supplierName,
        supplierTax: input.supplierTax,
        issueDate: input.issueDate,
        deliveryDate: input.deliveryDate || input.issueDate,
        paymentDate: input.paymentDate || '',
        paymentMethod: input.paymentMethod || 'TRANSFER',
        currency: input.currency || 'HUF',
        exchangeRate: input.exchangeRate || 1,
        net,
        vat,
        operation: input.operation || 'CREATE',
        originalInvoiceNumber: input.originalInvoiceNumber || '',
        simplified: !!input.simplified,
        compressed: !!input.compressed,
        lines: input.lines || [{ description: 'Szolgáltatás', net, vatRate: net ? Math.round((vat / net) * 100) / 100 : 0 }],
        insDate: new Date().toISOString(),
      };
      invoices.push(inv);
      return inv;
    },

    /** hálózati / HTTP hiba a következő `times` kérésre (op: queryInvoiceDigest / queryInvoiceData) */
    fail(failure: NavMockFailure, o: { times?: number; op?: string } = {}) {
      failures.push({ failure, times: o.times ?? 1, op: o.op });
    },
    /** NAV hibakód (funcCode=ERROR) a következő kérésre, pl. INVALID_SECURITY_USER, OPERATION_FAILED */
    failNav(code: string, message = 'Mock NAV hiba', o: { times?: number; op?: string } = {}) {
      failures.push({ failure: { code, message }, times: o.times ?? 1, op: o.op });
    },

    async handle(req: Request): Promise<Response | null> {
      if (!req.url.startsWith(base + '/')) return null;
      const op = new URL(req.url).pathname.split('/').pop() || '';
      const body = await req.text();
      const requestId = val(body, 'requestId');
      const f = takeFailure(op);
      if (f) {
        if (typeof f === 'object') return navError(f.code, f.message, requestId);
        if (f === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        if (f === 'network') throw new TypeError('fetch failed');
        if (f === 'bad-json') return new Response('<html><body>Bad gateway</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        return new Response(`<html><body><h1>${f} Service Unavailable</h1></body></html>`, { status: f, headers: { 'Content-Type': 'text/html' } });
      }
      if (req.method !== 'POST' || (op !== 'queryInvoiceDigest' && op !== 'queryInvoiceData'))
        throw new Error(`NAV mock: nem támogatott kérés: ${req.method} ${op}`);
      // hitelesítés: login, SHA-512 jelszó-hash, SHA3-512 kérés-aláírás (requestId + yyyyMMddHHmmss + aláírókulcs)
      const ts = val(body, 'timestamp');
      const mask = ts.replace(/\.\d+Z$|Z$/, '').replace(/[-T:]/g, '');
      if (val(body, 'login') !== login || val(body, 'passwordHash') !== upperHex('sha512', password))
        return navError('INVALID_SECURITY_USER', 'Helytelen authentikációs adatok!', requestId);
      if (val(body, 'requestSignature') !== upperHex('sha3-512', requestId + mask + signKey))
        return navError('INVALID_REQUEST_SIGNATURE', 'Helytelen kérés aláírás!', requestId);

      if (op === 'queryInvoiceDigest') {
        const from = val(body, 'dateFrom'),
          to = val(body, 'dateTo'),
          page = Number(val(body, 'page')) || 1;
        requests.push({ op, requestId, from, to, page });
        if (val(body, 'invoiceDirection') !== 'INBOUND') throw new Error('NAV mock: csak INBOUND irány támogatott');
        // a NAV legfeljebb 35 napos időszakot enged
        if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 35) return navError('INVALID_REQUEST', 'A dátumtartomány túl hosszú (max. 35 nap).', requestId);
        const list = invoices.filter((i) => i.issueDate >= from && i.issueDate <= to);
        const pages = Math.max(1, Math.ceil(list.length / pageSize));
        const items = list
          .slice((page - 1) * pageSize, page * pageSize)
          .map((inv, i) => digestXml(inv, (page - 1) * pageSize + i + 1))
          .join('');
        return xmlResponse(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><QueryInvoiceDigestResponse ${NS}>${head(requestId)}<common:result><common:funcCode>OK</common:funcCode></common:result>${software}<invoiceDigestResult><currentPage>${page}</currentPage><availablePage>${pages}</availablePage>${items}</invoiceDigestResult></QueryInvoiceDigestResponse>`,
        );
      }
      const number = val(body, 'invoiceNumber');
      const supplierTax = val(body, 'supplierTaxNumber');
      requests.push({ op, requestId, number, supplierTax });
      const inv = invoices.find((i) => i.number === number && (!supplierTax || i.supplierTax.replace(/\D/g, '').startsWith(supplierTax)));
      const raw = inv ? Buffer.from(inv.compressed ? gzipSync(invoiceDataXml(inv)) : invoiceDataXml(inv)) : null;
      return xmlResponse(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><QueryInvoiceDataResponse ${NS}>${head(requestId)}<common:result><common:funcCode>OK</common:funcCode></common:result>${software}` +
          (raw
            ? `<invoiceDataResult><invoiceData>${raw.toString('base64')}</invoiceData><auditData><insdate>${inv!.insDate}</insdate><insCusUser>mock</insCusUser><source>OSZ</source><transactionId>MOCKTX</transactionId><index>1</index><originalRequestVersion>3.0</originalRequestVersion></auditData><compressedContentIndicator>${inv!.compressed}</compressedContentIndicator></invoiceDataResult>`
            : '') +
          `</QueryInvoiceDataResponse>`,
      );
    },
  };
  return api;
}
export type NavMock = ReturnType<typeof mockNav>;
