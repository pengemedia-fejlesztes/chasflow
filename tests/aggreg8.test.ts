import { describe, expect, it } from 'vitest';
import { bankOfAccount, parseAggreg8 } from '../shared/aggreg8';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<BankTransactionExport version="1.0"><Transactions count="3">
<Transaction localId="a"><BookingDate>2026-10-10</BookingDate><Direction>expense</Direction><TransactionName>Kártya</TransactionName>
<Amount currency="HUF">-12990</Amount><Counterparty><Name>TESZT &amp; BOLT KFT</Name><AccountNumber status="not_available"/></Counterparty>
<OwnAccount><OwnerName>Teszt</OwnerName><AccountNumber>HU12 1620 0000</AccountNumber><CardNumber status="x"/></OwnAccount><SourceDetailText>Kártya
TESZT BOLT</SourceDetailText></Transaction>
<Transaction localId="b"><BookingDate>2026-10-10</BookingDate><Direction>income</Direction><TransactionName>Számla 99</TransactionName>
<Amount currency="HUF">150000</Amount><Counterparty><Name>Ügyfél Zrt</Name></Counterparty><OwnAccount><AccountNumber>HU12 1620 0000</AccountNumber></OwnAccount></Transaction>
<Transaction localId="c"><ValueDate>2026-10-09</ValueDate><Direction>expense</Direction><Amount>4990</Amount>
<Counterparty><Name>Rackforest</Name></Counterparty><OwnAccount><AccountNumber>HU55126000</AccountNumber></OwnAccount></Transaction>
</Transactions></BankTransactionExport>`;

describe('aggreg8 XML', () => {
  it('számlánként, előjelesen, partnerrel és közleménnyel', () => {
    const r = parseAggreg8(xml);
    expect(r.map((a) => [a.account, a.rows.length])).toEqual([
      ['HU1216200000', 2],
      ['HU55126000', 1],
    ]);
    expect(r[0].rows[0]).toMatchObject({ date: '2026-10-10', amount: -12990, partner: 'TESZT & BOLT KFT', memo: 'Kártya · Kártya TESZT BOLT' });
    expect(r[1].rows[0]).toMatchObject({ date: '2026-10-09', amount: -4990, partner: 'Rackforest' });
    expect(bankOfAccount('HU1216200000')).toBe('MagNet');
    expect(() => parseAggreg8('<x/>')).toThrow(/aggreg8/);
  });
});
