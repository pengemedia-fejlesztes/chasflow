import { describe, expect, it } from 'vitest';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { digestRequestXml, parseDigestResponse, passwordHash, requestSignature } from '../worker/nav';

describe('NAV Online Számla', () => {
  it('kérés aláírás: requestId + yyyyMMddHHmmss (UTC) + aláírókulcs, SHA3-512 nagybetűs hex', () => {
    // a NAV dokumentáció példája szerinti összefűzés
    const want = bytesToHex(sha3_512(new TextEncoder().encode('TSTKFT122256420171230182545ce-8f5e-215119fa7dd621DLMRHRLH2S'))).toUpperCase();
    expect(requestSignature('TSTKFT1222564', '2017-12-30T18:25:45.000Z', 'ce-8f5e-215119fa7dd621DLMRHRLH2S')).toBe(want);
    expect(passwordHash('abc')).toMatch(/^DDAF35A193617ABA/);
  });

  it('lekérdezés XML: adószám 8 jegy, bejövő irány, időszak', () => {
    const env: any = { NAV_LOGIN: 'tech<1>', NAV_PASSWORD: 'p', NAV_SIGN_KEY: 'k', NAV_TAX_NUMBER: '12345678-2-42' };
    const x = digestRequestXml(env, {
      requestId: 'RID1',
      timestamp: '2026-10-10T10:00:00.000Z',
      page: 2,
      from: '2026-09-01',
      to: '2026-10-05',
      contact: 'a@b.hu',
    });
    expect(x).toContain('<common:taxNumber>12345678</common:taxNumber>');
    expect(x).toContain('<common:login>tech&lt;1&gt;</common:login>');
    expect(x).toContain('<invoiceDirection>INBOUND</invoiceDirection>');
    expect(x).toContain('<dateFrom>2026-09-01</dateFrom><dateTo>2026-10-05</dateTo>');
    expect(x).toContain('<softwareId>HU12345678-CASHFL1</softwareId>');
    expect(x).toContain('<page>2</page>');
  });

  it('válasz feldolgozás (névtér-előtagokkal), Ft összegek, hiba', () => {
    const xml = `<?xml version="1.0"?><ns2:QueryInvoiceDigestResponse xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common">
      <result><funcCode>OK</funcCode></result>
      <ns2:invoiceDigestResult><ns2:currentPage>1</ns2:currentPage><ns2:availablePage>3</ns2:availablePage>
      <ns2:invoiceDigest><ns2:invoiceNumber>A-2026/12</ns2:invoiceNumber><ns2:invoiceOperation>CREATE</ns2:invoiceOperation>
        <ns2:supplierTaxNumber>87654321</ns2:supplierTaxNumber><ns2:supplierName>Tárhely &amp; Co Kft.</ns2:supplierName>
        <ns2:invoiceIssueDate>2026-10-01</ns2:invoiceIssueDate><ns2:paymentDate>2026-10-09</ns2:paymentDate><ns2:currency>EUR</ns2:currency>
        <ns2:invoiceNetAmount>100</ns2:invoiceNetAmount><ns2:invoiceNetAmountHUF>39000.4</ns2:invoiceNetAmountHUF>
        <ns2:invoiceVatAmount>27</ns2:invoiceVatAmount><ns2:invoiceVatAmountHUF>10530</ns2:invoiceVatAmountHUF></ns2:invoiceDigest>
      </ns2:invoiceDigestResult></ns2:QueryInvoiceDigestResponse>`;
    const r = parseDigestResponse(xml);
    expect(r.pages).toBe(3);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ invoiceNumber: 'A-2026/12', supplierName: 'Tárhely & Co Kft.', paymentDate: '2026-10-09', net: 39000, gross: 49530 });
    expect(() =>
      parseDigestResponse(
        '<GeneralErrorResponse><result><funcCode>ERROR</funcCode><errorCode>INVALID_SECURITY_USER</errorCode><message>Hibás</message></result></GeneralErrorResponse>',
      ),
    ).toThrow(/INVALID_SECURITY_USER/);
  });
});

import { unplannedHint } from '../shared/unplanned';

describe('terv nélküli tétel javaslat', () => {
  const a = (id: string, date: string, name: string, amount: number, leaf = 'L1'): any => ({ id, kind: 'actual', date, name, amount, leaf_id: leaf });
  const hist = [
    a('1', '2026-05-03', 'RACKFOREST ZRT', -12000),
    a('2', '2026-06-03', 'Rackforest Zrt.', -12000),
    a('3', '2026-07-03', 'Rackforest', -13000),
    a('4', '2026-08-03', 'Rackforest', -12000),
  ];
  it('legalább 3 hónapban volt → rendszeres, a megszokott kategóriával', () => {
    const h = unplannedHint(hist, { name: 'Rackforest Zrt.', amount: -12500, date: '2026-10-05', leaf_id: 'UF' }, 'UF');
    expect(h).toMatchObject({ kind: 'recurring', months: 4, leaf_id: 'L1', avg: -12250 });
  });
  it('új partner → előre nem látható', () => {
    const h = unplannedHint(hist, { name: 'Autószerviz Kft.', amount: -85000, date: '2026-10-05', leaf_id: 'UF' }, 'UF');
    expect(h).toMatchObject({ kind: 'oneoff', months: 0, leaf_id: null });
  });
});
