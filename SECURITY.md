# Security and deployment

Security fixes require `npm run typecheck`, `npm test`, `npm run audit:security`,
`npm run build`, and `npm run build:server`. CI blocks deployment on audit findings
of moderate severity or higher. Use a review branch; the production branch deploys automatically.

## Access and sessions

Non-admin users with no valid, explicit access configuration have no access.
Administrators must enroll in TOTP before accessing application data. Existing
sessions also expire after 12 hours total or 30 minutes without activity.

The shared ledger, deleted entries, history, and totals combine bank, payroll and
invoice information. Until rows have reliable data classification, these views
and their mutations require all three data scopes. Restricted users can still
use explicitly authorized tasks, catalog and stock functions. The API removes
unavailable financial menus from the returned access list. An administrator
must review each non-admin user's explicit grants after deployment.

Only documented display settings are serialized. Credentials, token hashes,
internal permission maps and unknown future settings must not be added to that allowlist.

## Transport and static files

The Worker redirects non-local HTTP reads and rejects HTTP writes. Passenger's
internal connection can hide the original scheme, so production deployment also
identifies the public configuration by its exact PassengerAppRoot in the domain webroots and installs a managed HTTPS block for `/Cashflow` only, preserving
the existing Passenger configuration and backing it up under `.backup/<release>/public-htaccess`.
If the public webroot cannot be identified uniquely, deployment stops before swapping the application; never
disable the HTTP smoke check. Roll back that block using the release backup.

## Private worktime sheets

Do not make worktime or payroll sheets publicly accessible. Local XLS upload
remains supported. Server export requires `GOOGLE_DRIVE_ACCESS_TOKEN` with
read-only access to the intended private files. The application does not provision
or refresh this OAuth token; use a managed credential provider or upload XLS files.
No token belongs in this repository, a PR, or an application response.

## Mac bank helper

The `mac-agent` Vite plugin (`vite.config.ts`) embeds the three executable helpers in the built installer.
Installed helpers execute local files only; updating requires the user to rerun
the installer from a reviewed release. Existing installations must be reinstalled
to replace the old launcher that downloads code automatically. Do not run the
source template directly. Banking session authentication and bank consent remain user actions.

## Repository and historical data

Repository visibility and Drive permissions are owner-managed. This patch does
not change them. Historical, customer-specific data-repair migrations remain in
Git history; code changes cannot retract previously public copies. The owner must
restrict repository access, assess public Actions logs and copies, and decide on
coordinated history cleanup. Do not delete or rename applied migrations as a
substitute for that process. Future migrations and fixtures must use synthetic
data and exclude customer names, invoice numbers and financial amounts.
