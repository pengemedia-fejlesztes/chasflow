import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('telepített Mac-bot csak helyi kódot futtat', () => {
  it('a launcher és a letöltő nem frissít futtatható fájlt a hálózatról', () => {
    const installer = readFileSync('mac-agent/aggreg8-install.sh', 'utf8');
    const downloader = readFileSync('mac-agent/aggreg8-download.sh', 'utf8');
    const cdp = readFileSync('mac-agent/aggreg8-cdp.mjs', 'utf8');
    expect(installer).not.toContain('curl -fsS -m 30');
    expect(downloader).not.toContain('curl -fsS -m 30');
    expect(cdp).not.toContain('fetch(`${CF_URL}/mac/');
    expect(cdp).toContain('readFileSync(env.EXPORT_JS_FILE');
    expect(downloader).toContain('EXPORT_JS_FILE="$STATE/aggreg8-export.js"');
    for (const marker of ['DOWNLOAD', 'CDP', 'EXPORT']) expect(installer).toContain(`__CF_MAC_${marker}_B64__`);
  });
});
