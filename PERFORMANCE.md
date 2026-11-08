# Performance changes

Anonymous login now loads the login UI and shared utilities. Desktop/mobile shells and large screens are dynamic imports. After successful authentication the selected shell starts loading alongside `/api/data`. A Suspense fallback covers navigation and partner-card loading. Logout no longer imports the desktop application. Theme tokens were extracted to avoid a UI/date-picker chunk cycle.

`GET /api/data?sections=tasks` (or `stock`, `catalog`, `payroll`, `ledger`, comma-separated) reads only the selected groups of queries. Every response still passes through `visibleBundle`; scope selection never grants access. No selector preserves the original full-bundle contract. `Server-Timing: data;dur=...` measures server loading without exposing payloads.

Successful task and warehouse/stock writes, including undo and partially failed multi-step actions, refresh only their respective sections. Unknown operations, financial imports/sync, and periodic global revision changes retain a full refresh. Deleting financial entries refreshes the ledger/trash. Refresh requests are serialized and combined. A mutation invalidates an older in-flight read; the read retries. A permission change reported by a partial response triggers a complete refresh to clear old modules. Task-only or stock-only refreshes preserve the financial index.

## Validation

- `npm test`, `npm run build`, `npm run build:server`, `npm run audit:security`.
- Real SQLite regression fixture: 10,000 historical financial entries. Full JSON: 3,249,791 bytes. Stock patch: 427 bytes, four prepared reads including permission lookup, no financial history query. This is a synthetic fixture, not production latency.
- Build at original base `9dc2b53`: main JS 858.74 kB, gzip 249.05 kB. After integration of the subsequent account-history feature: main JS about 208.5 kB, gzip 68.9 kB. Deferred chunks remain additional downloads after login/navigation; this is not a 76% reduction in total application code.
- Local production-build browser checks with synthetic API data: anonymous login, desktop income/tasks/stock, mobile overview at 390×844. No production financial data or real credentials were used.
- Regression coverage includes scope validation and visibility, unchanged financial calculations, cached-index reuse, permission revocation, partial failure, overlapping writes, and stale response retries.

## Remaining work

The initial financial bundle and global revision polling still load full financial history. Date-bound financial queries require opening-balance carry amounts, per-category historical first/last dates, future plan horizons, linked transactions and year-expanded filters to remain exact. This package deliberately does not trim historical entries or claim an authenticated production speed-up. Further extraction of shared view hooks can reduce the first authenticated download.
