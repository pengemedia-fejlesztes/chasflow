# Cashflow tervező – 360 Marketing

Böngészőben és iPhone-on is használható, több felhasználós cashflow szoftver.

- **Áttekintés:** banki (vagy számított) egyenleg, a hónap várható zárása, havi cashflow, legalacsonyabb egyenleg, és a jövő 12 hónap becslése az elmúlt 12 hónap tényeihez képest.
- **Szűrők:** időszak (következő 8/12 hónap, elmúlt 12 hónap, bármelyik év 2022-től, éves összesítő), tény / terv nézet, bevétel / kiadás, ajánlatok, becslés és keresés. **Csak az aktív szűrőkhöz tartozó, nem üres sorok és kategóriák látszanak.**
- **Korábbi adatok:** a TÉNYEK xls teljes egészében (2022 decemberétől) importálható, bármelyik év és hónap visszanézhető.
- **Becslés:** a tervek után az elmúlt 12 hónap rendszeres tételeinek átlagával számol előre. A becsült értékek dőlt betűvel, „≈” jellel jelennek meg, és ki is kapcsolhatók.
- **Billingo:** a kiállított, még ki nem fizetett számlák automatikusan a *Tervezett bevétel* fülre kerülnek, a fizetési határidőre. Ha a tervben már szerepel ugyanaz a bevétel (pl. havi díj), a számla azt a tervet állítja „kiszámlázottra”, így nincs dupla bevétel.
- **Bank (BiNX, Magnet):** PSD2 kapcsolaton keresztül (Enable Banking) naponta ötször (5, 9, 13, 17, 21 órakor) frissül az egyenleg és a tételek. Ahol ez nem érhető el, a netbankból letöltött CSV vagy Excel kivonat is feltölthető. A beérkezett tételekhez a rendszer kategóriát javasol, és párosítja őket a tervvel vagy a Billingo-számlával. Egy kattintásos jóváhagyás után a terv lezárul, és tényként kerül be.
- **Mobil:** iPhone-on a Safariban *Megosztás → Főképernyőhöz adás*, és utána alkalmazásként fut.

## Biztonság

- **Csak meghívott felhasználók.** Nincs nyilvános regisztráció. Az első admint egy titkos beállító kóddal lehet létrehozni, a többieket az admin hívja meg. Az új felhasználó ideiglenes jelszót kap, amit első belépéskor kötelező lecserélni.
- **Szerepkörök:** adminisztrátor, szerkesztő, csak olvasó.
- **Jelszavak:** PBKDF2-SHA256 hash, 100 000 iterációval. Opcionális (erősen ajánlott) kétlépcsős azonosítás hitelesítő alkalmazással (TOTP).
- **Brute-force védelem:** 5 hibás próbálkozás után 15 percre zárolja a fiókot, és IP-cím szerinti korlátozás is van.
- **Munkamenet:** `HttpOnly`, `Secure`, `SameSite` süti, 7 nap inaktivitás után lejár. „Kilépés minden eszközön” funkció.
- **Böngészővédelem:** CSRF-védelem, szigorú Content-Security-Policy, HSTS, clickjacking-védelem, `noindex`.
- **Titkok:** az API kulcsok (Billingo, Enable Banking, NAV, e-mail) csak a szerver `.env` fájljában vannak (`~/cashflow/.env`, 600-as jog), soha nem kerülnek a repóba.
- **Pénzügyi adatok:** csak a szerver adatbázisában vannak. A repó nem tartalmaz adatot, az xls/csv fájlok és a lokális adatbázis (`.data/`) a `.gitignore`-ban vannak.
- **Napló:** belépések és fontos műveletek naplója.

> ⚠️ **A GitHub repó legyen privát!** GitHub → a repó → *Settings* → *General* → legalul *Danger Zone* → *Change repository visibility* → *Make private*.

## Üzemeltetés (pmdev.hu)

Az app a pmdev cPanel-tárhelyén fut: <https://pmdev.hu/Cashflow/>.

- **Futtatás:** Node.js 22 (CloudLinux Passenger), az app könyvtára `~/cashflow`. A Passenger beállítása a `~/public_html/pmdev.hu/Cashflow/.htaccess`-ben van (`PassengerStartupFile deploy/passenger/entry.cjs`).
- **Ütemezett szinkron:** cPanel-cron (`node src/server/runtime/cron.mjs` az app könyvtárában), munkanapokon.
- **Telepítés:** a GitHub Actions (`.github/workflows/deploy.yml`) a `main` és a fejlesztési ágra pusholt commitot ellenőrzi, buildeli, és SSH-n felmásolja. Szükséges GitHub Secret: `PMDEV_SSH_KEY`.
- **Titkok:** a `~/cashflow/.env` fájlban (minta: `.env.example`). Módosítás után az app újraindítása: `touch ~/cashflow/tmp/restart.txt`.
- **Első belépés:** a `SETUP_TOKEN`-nel hozható létre az első admin. Utána:
  - *Beállítások → Adatok:* töltsd fel a TÉNYEK és a TERVEK xls fájlt.
  - Ha még nincs bankkapcsolat, add meg a mai egyenleget.
  - *Beállítások → Fiókom:* kapcsold be a 2FA-t.
  - *Beállítások → Felhasználók:* hívd meg a kollégákat.

## Elfelejtett jelszó – e-mail küldés

A belépő oldalon az „Elfelejtett jelszó?” egy 30 percig érvényes, egyszer használható linket küld e-mailben. Magát a jelszót nem lehet elküldeni, mert a rendszer csak a hash-ét tárolja. Ha a felhasználónak be van kapcsolva a 2FA, a visszaállításhoz a kód is kell. Sikeres csere után minden eszközről kilépteti, és értesítő levelet küld.

Beállítás a **Brevo**-val (ingyenes, napi 300 levél):

1. Regisztrálj: <https://www.brevo.com>.
2. *Senders, Domains & Dedicated IPs → Senders → Add a sender*: add meg a feladó címet (pl. `laszlo.nagy@360-marketing.eu`), és igazold a kapott levéllel. A jobb kézbesítéshez ajánlott a domain hitelesítése is (DKIM/DMARC DNS rekordok).
3. *SMTP & API → API keys → Generate a new API key*.
4. Állítsd be a titkokat a `.env`-ben:
   ```bash
   BREVO_API_KEY=…
   MAIL_FROM="Cashflow <laszlo.nagy@360-marketing.eu>"
   ```

A Brevo helyett **Resend** is használható: `RESEND_API_KEY`, ehhez a domaint DNS-ben igazolni kell.

E-mail küldés beállítása nélkül az admin a *Beállítások → Felhasználók → Jelszó reset* gombbal adhat ideiglenes jelszót.

## Bankkapcsolat (BiNX, Magnet) – Enable Banking

A bankok PSD2-n keresztül csak engedélyezett számlainformációs szolgáltatónak adnak hozzáférést. Erre az Enable Banking szolgál, amely saját számlák összekapcsolására ingyenesen használható.

1. Regisztrálj: <https://enablebanking.com/cp> → *Applications → Add application*. Környezet: **Production**. Redirect URL: `https://<az-app-címe>/api/bank/callback`.
2. A létrehozáskor letöltött privát kulcs (`.pem`) tartalma lesz az `EB_PRIVATE_KEY`, az alkalmazás azonosítója az `EB_APP_ID`. Ha a kulcs `BEGIN RSA PRIVATE KEY`-jel kezdődik, alakítsd át:
   `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key8.pem`
3. Az appban: *Beállítások → Bekötések → Elérhető bankok betöltése*. Válaszd ki a bankot, majd *Összekapcsolás*. A banki belépés a bank saját oldalán történik.
4. A hozzájárulás legfeljebb 180 napig érvényes, utána ugyanígy újra kell kapcsolni. Az app jelzi, ha lejárt.

Ha valamelyik bank (pl. BiNX) nem szerepel az Enable Banking listájában, használd a **kivonat importot**: *Beállítások → Bekötések → Banki kivonat import*. Ide tölthető fel a netbankból letöltött CSV vagy XLSX. Az ismételten feltöltött tételek nem duplikálódnak.

## Frissítés, fejlesztés GitHubon keresztül

- Minden módosítás, ami a `main` (vagy a fejlesztési) ágra kerül, automatikusan élesedik: tesztek, build és telepítés egy lépésben.
- Más ágon a GitHub Actions csak ellenőriz (típusellenőrzés, tesztek, build).
- Új adatbázis-mező esetén új fájl kell a `migrations/` mappába (pl. `0002_….sql`). Az éles MySQL-t ez még nem frissíti: a deploy ilyenkor megáll, a sémát kézzel kell frissíteni.

### Helyi futtatás (Docker, Node + SQLite)

Csak Docker kell (Node sem kell a gépre):

```bash
docker compose up                  # felület: http://localhost:5173  (API: http://localhost:8787)
docker compose run --rm app npm test
docker compose run --rm app npm run typecheck
docker compose run --rm app node src/server/runtime/cron.mjs   # egy szinkron-futás kézzel (titkok kellenek hozzá)
bash scripts/dev/import-pmdev.sh   # az éles adatok behozása a lokális SQLite-ba (a hoston fut, ssh pmdev kell)
```

- Az adatbázis SQLite: `./.data/cashflow.sqlite`. Induláskor a `migrations/` összes még nem futtatott fájlja lefut
  (nyilvántartás: `d1_migrations` tábla). A fájl törlésével üres adatbázissal indul újra.
- Első indításkor az első admin a `SETUP_TOKEN`-nel hozható létre (alapból `helyi-teszt`).
- Titkok (Billingo, NAV, Enable Banking, e-mail): `.env` (minta: `.env.example`). Nélkülük az app fut, csak a külső szinkron nem.
- A felület (Vite) azonnal frissül, a szerver (`src/server/`, `src/shared/`) változáskor újraépül és újraindul.
- Az adatbázis-meghajtót a `SQLITE_PATH` választja ki (`src/server/runtime/db.mjs`): ha meg van adva, SQLite
  (`d1-sqlite.mjs`), ha nincs, a MySQL (`d1-mysql.mjs`) – az éles pmdev egyelőre MySQL-lel fut.

A módosításütközések elleni védelemhez a `0025_mutation_guard.sql` migráció szükséges. A felület és a backend együtt frissítendő; régi böngészőfül esetén töltsd újra az oldalt. A kliens a tétel korábbi verzióját küldi, a szerver pedig egyetlen tranzakcióban ellenőrzi és menti a teljes módosítást. Ütközéskor 409-es választ ad, és megőrzi a másik felhasználó változtatását. A visszavonásra is ugyanez a védelem érvényes.

Az összegmezők egész forintot fogadnak el, szóközös ezres tagolással is. A tizedesjel és az előjel elutasításra kerül; a bevétel/kiadás választás határozza meg az előjelet.

A regressziótesztek Node.js 22.13 vagy újabb verziót igényelnek (beépített SQLite). A felületi tesztek jsdomot használnak; a natív dialógus böngészős fókuszkezelését ezek nem helyettesítik.

## Felépítés

| Mappa | Tartalom |
|---|---|
| `src/client/` | React felület (Vite), asztali és mobil nézet |
| `src/server/app/` | Az API: hitelesítés, adatok, Billingo, bank, NAV, napi szinkron. Platformfüggetlen, `{ fetch, scheduled }` formájú; a platformtól várt felület: `platform.ts` |
| `src/server/runtime/` | Node-os futtatás: HTTP-szerver (`entry.mjs`), ütemezett futás (`cron.mjs`), adatbázis-réteg (SQLite / MySQL) |
| `src/shared/` | Közös logika (felület + szerver): kategóriák, xls-értelmezés, cashflow-számítás, banki párosítás |
| `public/` | Statikus fájlok (ikonok, manifest, service worker) |
| `mac-agent/` | A Macen futó bankletöltő (aggreg8); a build a `/mac/` útvonalra másolja |
| `migrations/` | Adatbázis-séma (SQLite) |
| `tests/` | Tesztek (`vitest`), a forrás szerint: `client/`, `server/`, `shared/` |
| `scripts/dev/` | Lokális fejlesztés: Docker-indítás, éles adat importja, lokális admin |
| `scripts/ops/` | Üzemeltetés: MySQL → SQLite átvitel, füstteszt |
| `scripts/data-fixes/` | Egyszeri adatjavító szkriptek |
| `deploy/` | Élesítéshez: a Passenger belépési pontja |
| `dist/` | Build-kimenet (nincs a gitben): `client/` a felület, `server/` a backend |

**Egyenleg-logika:** a mai egyenleg bankkapcsolatnál a banki egyenlegek összege, egyébként a nyitó egyenleg és az összes tény összege. A múltbeli hónapok záró egyenlege a mai egyenleg mínusz az azóta történt tények. Az előrejelzés a mai egyenleg plusz a nyitott tervek (ebben a hónapban a lejárt, még nyitottakkal együtt), plusz opcionálisan az ajánlatok és a becslés.
