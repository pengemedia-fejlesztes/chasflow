import { describe, expect, it } from 'vitest';
import { httpsConfig } from '../../src/server/runtime/enforce-https.mjs';

describe('Passenger HTTPS config', () => {
  it('megőrzi a Passenger-konfigurációt és ismételt telepítéskor nem duplikál', () => {
    const original = 'PassengerAppRoot /home/example/cashflow\nPassengerBaseURI /Cashflow\n';
    const config = httpsConfig(original);
    expect(config).toContain(original);
    expect(config).toContain('RewriteCond %{HTTPS} !=on');
    expect(config).toContain('RewriteCond %{REQUEST_URI} ^/Cashflow(?:/|$)');
    expect(config).toContain('https://pmdev.hu%{REQUEST_URI}');
    expect(httpsConfig(config)).toBe(config);
  });
});
