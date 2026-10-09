# Cashflow tervező – 360 Marketing

Böngészőben és iPhone-on is használható, több felhasználós cashflow szoftver.

- **Áttekintés:** banki (vagy számított) egyenleg, a hónap várható zárása, havi cashflow, legalacsonyabb egyenleg, és a jövő 12 hónap becslése az elmúlt 12 hónap tényeihez képest.
- **Szűrők:** időszak (következő 8/12 hónap, elmúlt 12 hónap, bármelyik év 2022-től, éves összesítő), tény / terv nézet, bevétel / kiadás, ajánlatok, becslés és keresés. **Csak az aktív szűrőkhöz tartozó, nem üres sorok és kategóriák látszanak.**
- **Korábbi adatok:** a TÉNYEK xls teljes egészében (2022 decemberétől) importálható, bármelyik év és hónap visszanézhető.
- **Becslés:** a tervek után az elmúlt 12 hónap rendszeres tételeinek átlagával számol előre. A becsült értékek dőlt betűvel, „≈” jellel jelennek meg, és ki is kapcsolhatók.
- **Billingo:** a kiállított, még ki nem fizetett számlák automatikusan a *Tervezett bevétel* fülre kerülnek, a fizetési határidőre. Ha a tervben már szerepel ugyanaz a bevétel (pl. havi díj), a számla azt a tervet állítja „kiszámlázottra”, így nincs dupla bevétel.
- **Bank (BiNX, Magnet):** PSD2 kapcsolaton keresztül (Enable Banking) óránként frissül az egyenleg és a tételek. Ahol ez nem érhető el, a netbankból letöltött CSV vagy Excel kivonat is feltölthető. A beérkezett tételekhez a rendszer kategóriát javasol, és párosítja őket a tervvel vagy a Billingo-számlával. Egy kattintásos jóváhagyás után a terv lezárul, és tényként kerül be.
- **Mobil:** iPhone-on a Safariban *Megosztás → Főképernyőhöz adás*, és utána alkalmazásként fut.

## Biztonság

- **Csak meghívott felhasználók.** Nincs nyilvános regisztráció. Az első admint egy titkos beállító kóddal lehet létrehozni, a többieket az admin hívja meg. Az új felhasználó ideiglenes jelszót kap, amit első belépéskor kötelező lecserélni.
- **Szerepkörök:** adminisztrátor, szerkesztő, csak olvasó.
- **Jelszavak:** PBKDF2-SHA256 hash, 100 000 iterációval. Opcionális (erősen ajánlott) kétlépcsős azonosítás hitelesítő alkalmazással (TOTP).
- **Brute-force védelem:** 5 hibás próbálkozás után 15 percre zárolja a fiókot, és IP-cím szerinti korlátozás is van.
- **Munkamenet:** `HttpOnly`, `Secure`, `SameSite` süti, 7 nap inaktivitás után lejár. „Kilépés minden eszközön” funkció.
- **Böngészővédelem:** CSRF-védelem, szigorú Content-Security-Policy, HSTS, clickjacking-védelem, `noindex`.
- **Titkok:** az API kulcsok (Billingo, Enable Banking) **csak Cloudflare titokként** léteznek, soha nem kerülnek a repóba.
- **Pénzügyi adatok:** csak a Cloudflare D1 adatbázisban vannak. A repó nem tartalmaz adatot, az xls/csv fájlok a `.gitignore`-ban vannak.
- **Napló:** belépések és fontos műveletek naplója.

> ⚠️ **A GitHub repó legyen privát!** GitHub → a repó → *Settings* → *General* → legalul *Danger Zone* → *Change repository visibility* → *Make private*.

Extra védelemként ajánlott a **Cloudflare Access** (Zero Trust, 50 felhasználóig ingyenes). Ezzel az oldal be sem töltődik, csak a megadott e-mail címekre küldött egyszer használatos kóddal:
*Cloudflare dashboard → Zero Trust → Access → Applications → Add → Self-hosted* → a Worker domainje → *Policy: Allow, Emails: …*

## Telepítés (egyszer kell)

Szükséges: egy ingyenes [Cloudflare](https://dash.cloudflare.com) fiók és Node.js 22 (vagy csak a GitHub Actions).

1. **Cloudflare API token:** *My Profile → API Tokens → Create Token → „Edit Cloudflare Workers”* sablon, plusz *Account → D1 → Edit* jogosultság. Az **Account ID** a Workers oldal jobb oldalán látszik.
2. **Adatbázis létrehozása** (a saját gépeden):
   ```bash
   npm ci
   npx wrangler login
   npx wrangler d1 create cashflow      # kiírja a database_id-t
   ```
3. **GitHub Secrets** (*repó → Settings → Secrets and variables → Actions → New repository secret*):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `D1_DATABASE_ID` (a 2. lépés kimenetéből)
4. **Első deploy:** push vagy merge a `main` ágra. A GitHub Actions lefuttatja a teszteket, a migrációt és a deployt. Az app címe: `https://cashflow-tervezo.<fiókod>.workers.dev` (saját domain is beállítható).
5. **Titkok beállítása** (a saját gépeden, egyszer):
   ```bash
   npx wrangler secret put SETUP_TOKEN        # tetszőleges hosszú, véletlen szöveg az első adminhoz
   npx wrangler secret put BILLINGO_API_KEY   # Billingo → Beállítások → API
   # bankkapcsolathoz (lásd lent):
   npx wrangler secret put EB_APP_ID
   npx wrangler secret put EB_PRIVATE_KEY     # a .pem fájl teljes tartalma
   ```
6. **Első belépés:** nyisd meg az appot, add meg a `SETUP_TOKEN`-t, és hozd létre az admin fiókot. Utána:
   - *Beállítások → Adatok:* töltsd fel a TÉNYEK és a TERVEK xls fájlt.
   - Ha még nincs bankkapcsolat, add meg a mai egyenleget.
   - *Beállítások → Fiókom:* kapcsold be a 2FA-t.
   - *Beállítások → Felhasználók:* hívd meg a kollégákat.

## Bankkapcsolat (BiNX, Magnet) – Enable Banking

A bankok PSD2-n keresztül csak engedélyezett számlainformációs szolgáltatónak adnak hozzáférést. Erre az Enable Banking szolgál, amely saját számlák összekapcsolására ingyenesen használható.

1. Regisztrálj: <https://enablebanking.com/cp> → *Applications → Add application*. Környezet: **Production**. Redirect URL: `https://<az-app-címe>/api/bank/callback`.
2. A létrehozáskor letöltött privát kulcs (`.pem`) tartalma lesz az `EB_PRIVATE_KEY`, az alkalmazás azonosítója az `EB_APP_ID`. Ha a kulcs `BEGIN RSA PRIVATE KEY`-jel kezdődik, alakítsd át:
   `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key8.pem`
3. Az appban: *Beállítások → Bekötések → Elérhető bankok betöltése*. Válaszd ki a bankot, majd *Összekapcsolás*. A banki belépés a bank saját oldalán történik.
4. A hozzájárulás legfeljebb 180 napig érvényes, utána ugyanígy újra kell kapcsolni. Az app jelzi, ha lejárt.

Ha valamelyik bank (pl. BiNX) nem szerepel az Enable Banking listájában, használd a **kivonat importot**: *Beállítások → Bekötések → Banki kivonat import*. Ide tölthető fel a netbankból letöltött CSV vagy XLSX. Az ismételten feltöltött tételek nem duplikálódnak.

## Frissítés, fejlesztés GitHubon keresztül

- Minden módosítás, ami a `main` ágra kerül, automatikusan élesedik: tesztek, adatbázis-migráció és deploy egy lépésben.
- Más ágon a GitHub Actions csak ellenőriz (típusellenőrzés, tesztek, build).
- Új adatbázis-mező esetén új fájl kell a `migrations/` mappába (pl. `0002_….sql`). Ezt a deploy automatikusan lefuttatja.

### Helyi futtatás

```bash
npm ci
echo "SETUP_TOKEN=helyi-teszt" > .dev.vars     # + BILLINGO_API_KEY=… ha kell
npm run db:migrate:local
npx vite build && npx wrangler dev             # http://localhost:8787
npm test                                       # unit tesztek
```

## Felépítés

| Mappa | Tartalom |
|---|---|
| `web/` | React felület (Vite), asztali és mobil nézet a feltöltött design alapján |
| `worker/` | Cloudflare Worker API: hitelesítés, adatok, Billingo, bank, óránkénti szinkron |
| `shared/` | Közös logika: kategóriák, xls-értelmezés, cashflow-számítás, banki párosítás |
| `migrations/` | D1 (SQLite) adatbázis séma |
| `tests/` | Unit tesztek (`vitest`) |

**Egyenleg-logika:** a mai egyenleg bankkapcsolatnál a banki egyenlegek összege, egyébként a nyitó egyenleg és az összes tény összege. A múltbeli hónapok záró egyenlege a mai egyenleg mínusz az azóta történt tények. Az előrejelzés a mai egyenleg plusz a nyitott tervek (ebben a hónapban a lejárt, még nyitottakkal együtt), plusz opcionálisan az ajánlatok és a becslés.
