import { describe, expect, it } from 'vitest';
import { dataRequestXml, parseInvoiceXml } from '../worker/nav';

describe('NAV számla-adat', () => {
  it('lekérdezés XML: QueryInvoiceDataRequest, számlaszám, bejövő irány, szállító adószáma', () => {
    const env: any = { NAV_LOGIN: 'u', NAV_PASSWORD: 'p', NAV_SIGN_KEY: 'k', NAV_TAX_NUMBER: '12345678-2-42' };
    const x = dataRequestXml(env, {
      requestId: 'RID1',
      timestamp: '2026-10-10T10:00:00.000Z',
      contact: 'a@b.hu',
      number: 'A/1&2',
      supplierTax: '87654321-2-13',
    });
    expect(x).toContain('<QueryInvoiceDataRequest');
    expect(x).toContain('</QueryInvoiceDataRequest>');
    expect(x).not.toContain('QueryInvoiceDigestRequest');
    expect(x).not.toContain('<page>');
    expect(x).toContain('<invoiceNumber>A/1&amp;2</invoiceNumber><invoiceDirection>INBOUND</invoiceDirection><supplierTaxNumber>87654321</supplierTaxNumber>');
    expect(x).toContain('<common:taxNumber>12345678</common:taxNumber>');
  });

  it('számla XML feldolgozás: szállító, tételsorok, összegek', () => {
    const xml = `<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
      <invoiceNumber>FUGEA0908648</invoiceNumber><invoiceIssueDate>2026-09-10</invoiceIssueDate>
      <invoiceMain><invoice><invoiceHead>
        <supplierInfo><supplierTaxNumber><base:taxpayerId>11112222</base:taxpayerId><base:vatCode>2</base:vatCode><base:countyCode>41</base:countyCode></supplierTaxNumber>
          <supplierName>Optivi Kft.</supplierName><supplierAddress><base:simpleAddress><base:countryCode>HU</base:countryCode><base:postalCode>1111</base:postalCode><base:city>Budapest</base:city><base:additionalAddressDetail>Fő utca 1.</base:additionalAddressDetail></base:simpleAddress></supplierAddress></supplierInfo>
        <customerInfo><customerName>Penge Média Kft.</customerName></customerInfo>
        <invoiceDetail><invoiceDeliveryDate>2026-09-10</invoiceDeliveryDate><currencyCode>HUF</currencyCode><paymentMethod>TRANSFER</paymentMethod><paymentDate>2026-09-18</paymentDate></invoiceDetail>
      </invoiceHead>
      <invoiceLines><line><lineNumber>1</lineNumber><lineDescription>Tárhely szolgáltatás</lineDescription><quantity>2</quantity><unitOfMeasure>PIECE</unitOfMeasure><unitPrice>5000</unitPrice>
        <lineAmountsNormal><lineNetAmountData><lineNetAmount>10000</lineNetAmount><lineNetAmountHUF>10000</lineNetAmountHUF></lineNetAmountData>
        <lineVatRate><vatPercentage>0.27</vatPercentage></lineVatRate><lineVatData><lineVatAmount>2700</lineVatAmount></lineVatData>
        <lineGrossAmountData><lineGrossAmountNormal>12700</lineGrossAmountNormal></lineGrossAmountData></lineAmountsNormal></line></invoiceLines>
      <invoiceSummary><summaryNormal><invoiceNetAmount>10000</invoiceNetAmount><invoiceNetAmountHUF>10000</invoiceNetAmountHUF><invoiceVatAmount>2700</invoiceVatAmount><invoiceVatAmountHUF>2700</invoiceVatAmountHUF></summaryNormal>
        <summaryGrossData><invoiceGrossAmount>12700</invoiceGrossAmount><invoiceGrossAmountHUF>12700</invoiceGrossAmountHUF></summaryGrossData></invoiceSummary>
      </invoice></invoiceMain></InvoiceData>`;
    const r = parseInvoiceXml(xml, 'X');
    expect(r.number).toBe('FUGEA0908648');
    expect(r.supplier).toBe('Optivi Kft.');
    expect(r.supplierTax).toBe('11112222-2-41');
    expect(r.supplierAddress).toContain('1111 Budapest');
    expect(r.paymentDate).toBe('2026-09-18');
    expect(r.lines).toEqual([{ desc: 'Tárhely szolgáltatás', qty: 2, unit: 'PIECE', unitPrice: 5000, net: 10000, vat: '27%', gross: 12700 }]);
    expect([r.net, r.vat, r.gross]).toEqual([10000, 2700, 12700]);
  });
});
