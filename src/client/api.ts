// Kis fetch-csomagoló: CSRF fejléc, JSON, egységes hibakezelés.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'cashflow',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* nem JSON */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth')) window.dispatchEvent(new Event('cf-logout'));
    throw new ApiError(res.status, data?.error || `Hiba (${res.status})`);
  }
  return data as T;
}
