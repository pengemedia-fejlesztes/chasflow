// Külső szolgáltatások mockjai a tesztekhez. Használat:
//
//   const billingo = mockBillingo();
//   billingo.addDocument({ partner: 'Minta Kft.', gross: 254_000, dueDate: '2026-11-15' });
//   const nav = mockNav();
//   nav.addInvoice({ number: 'TSZ-2026/0815', supplierName: 'Tárhely Kft.', supplierTax: '12345678-2-41', issueDate: '2026-11-02', gross: 12_700 });
//   const ext = installMocks(billingo, nav);              // fetch kiváltva; ismeretlen külső hívás → hiba
//   const t = await createTestApp({ env: ext.env });     // BILLINGO_API_KEY/URL, NAV_* beállítva
//   ...
//   billingo.payments  // az app által rögzített fizetések;  billingo.fail(429) / nav.fail('timeout') – hibaszimuláció
//
// Az afterEach-ben `vi.unstubAllGlobals()` (vagy az installMocks által visszaadott `restore()`).
import { vi } from 'vitest';
import type { BillingoMock } from './billingo';
import type { NavMock } from './nav';

export { mockBillingo, type BillingoMock } from './billingo';
export { mockNav, type NavMock } from './nav';

export interface ExternalMock {
  name: string;
  env: Record<string, string>;
  handle(req: Request): Promise<Response | null>;
}

/** A globális fetch kiváltása a megadott mockokkal. Amit egyik mock sem ismer, hangos hibát dob. */
export function installMocks(...mocks: (ExternalMock | BillingoMock | NavMock)[]) {
  const calls: { method: string; url: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ method: req.method, url: req.url });
    for (const m of mocks) {
      const r = await m.handle(req);
      if (r) return r;
    }
    throw new Error(`Váratlan külső hívás (nincs hozzá mock): ${req.method} ${req.url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    env: Object.assign({}, ...mocks.map((m) => m.env)) as Record<string, string>,
    calls,
    fetch: fetchMock,
    restore: () => vi.unstubAllGlobals(),
  };
}
