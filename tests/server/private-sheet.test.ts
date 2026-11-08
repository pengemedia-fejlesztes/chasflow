import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleData } from '../../src/server/app/data';

afterEach(() => vi.unstubAllGlobals());
describe('privát elszámoló táblák', () => {
  const env = () =>
    ({
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          first: async () => ({ name: 'Test', sheet_url: 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuv' }),
        }),
      },
    }) as any;
  const req = () => new Request('https://test.invalid/api/worktime/fetch', { method: 'POST', body: JSON.stringify({ employee: 'test' }) });
  it('névtelen letöltés helyett beállítási hibát ad, nem javasol nyilvános megosztást', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(handleData(env(), req(), '/api/worktime/fetch', { id: 1, role: 'admin' } as any)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('csak a Google Drive API felé küldi a szerveroldali hozzáférést', async () => {
    const fetch = vi.fn(
      async () => new Response('synthetic-xlsx', { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const e = env();
    e.GOOGLE_DRIVE_ACCESS_TOKEN = 'SYNTHETIC_TOKEN';
    const res = await handleData(e, req(), '/api/worktime/fetch', { id: 1, role: 'admin' } as any);
    expect(res?.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/www.googleapis.com\/drive\/v3\/files\//),
      expect.objectContaining({ headers: { Authorization: 'Bearer SYNTHETIC_TOKEN' }, redirect: 'error' }),
    );
    expect(await res!.text()).not.toContain('SYNTHETIC_TOKEN');
  });
});
