import { api, ApiError } from './api';

/** Kijelentkezés: csak akkor sikeres, ha a szerver törölte a munkamenetet (401 = már nincs érvényes munkamenet). */
export async function logout(): Promise<void> {
  try {
    await api('/api/auth/logout', { body: {} });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    throw e;
  }
}
