// A futtatókörnyezet és az alkalmazás közötti szerződés: amit a backend a platformtól vár.
// A Node-os futtató (src/server/runtime/) valósítja meg: adatbázis (SQLite / MySQL), statikus fájlok, ütemezett futás.
// A forma a Cloudflare Workers / D1 API-t követi, mert a kód onnan jött – de nincs hozzá Cloudflare-függőség.

/** Egy SQL-utasítás eredménye. */
export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta: { changes: number; last_row_id: number; [key: string]: unknown };
}

/** Előkészített SQL-utasítás (`?` paraméterekkel). */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

/** Az adatbázis. A `batch` egyetlen tranzakcióban futtatja az utasításokat. */
export interface Db {
  prepare(query: string): DbStatement;
  batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]>;
  exec(query: string): Promise<unknown>;
}

/** A statikus fájlok (a buildelt felület) kiszolgálója. */
export interface AssetFetcher {
  fetch(req: Request): Promise<Response>;
}

/** Ütemezett futás (cron) adatai. */
export interface ScheduledEvent {
  scheduledTime: number;
  cron?: string;
}

/** A kérésen túl futó munkák regisztrálása. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Az alkalmazás belépési pontja: HTTP-kérések és ütemezett futás. */
export interface AppHandler<E> {
  fetch(req: Request, env: E, ctx?: ExecutionContext): Promise<Response>;
  scheduled(ev: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>;
}
