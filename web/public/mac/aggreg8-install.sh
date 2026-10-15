#!/bin/bash
# Cashflow tervező – aggreg8 banki tételek automatikus feltöltése a Letöltések mappából (macOS).
# 5, 9, 13, 17, 21 órakor a saját Chrome-ban megnyitja az aggreg8-at, frissít, és a Letöltésekbe menti a tranzakciókat (aggreg8-tranzakciok-*.json).
# Telepítés:  bash <(curl -fsSL https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-install.sh)
# Eltávolítás: bash <(curl -fsSL https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-install.sh) --uninstall
set -e
URL="https://cashflow-tervezo.pengemedia.workers.dev"
LABEL="hu.pengemedia.cashflow-aggreg8"
SCRIPT="$HOME/Library/Scripts/cashflow-aggreg8.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DLABEL="hu.pengemedia.cashflow-aggreg8-download"
DSCRIPT="$HOME/Library/Scripts/cashflow-aggreg8-download.sh"
DPLIST="$HOME/Library/LaunchAgents/$DLABEL.plist"
launchctl unload "$DPLIST" 2>/dev/null || true

if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl unload "$HOME/Library/LaunchAgents/hu.pengemedia.cashflow-aggreg8-poll.plist" 2>/dev/null || true
  rm -f "$PLIST" "$SCRIPT" "$DPLIST" "$DSCRIPT" "$HOME/Library/LaunchAgents/hu.pengemedia.cashflow-aggreg8-poll.plist" "$HOME/Library/Scripts/cashflow-aggreg8-poll.sh"
  security delete-generic-password -s cashflow-import >/dev/null 2>&1 || true
  echo "Eltávolítva."
  exit 0
fi

if security find-generic-password -s cashflow-import -w >/dev/null 2>&1 && [ "$1" != "--new-key" ]; then
  echo "A feltöltési kulcs már a Kulcskarikában van (új kulcshoz: a parancs végére --new-key)."
else
  printf "Feltöltési kulcs (az appból: Beállítások → Automatikus bankfeltöltés): "
  read -rs TOKEN; echo
  case "$TOKEN" in cfi_*) ;; *) echo "Ez nem feltöltési kulcs (cfi_ kezdetű)."; exit 1 ;; esac
  # a kulcs a Kulcskarikába kerül, nem fájlba
  security add-generic-password -U -a cashflow -s cashflow-import -w "$TOKEN"
fi

mkdir -p "$HOME/Library/Scripts" "$HOME/Library/LaunchAgents"
cat > "$SCRIPT" <<SH
#!/bin/bash
# Új aggreg8 export a Letöltésekben → feltöltés a Cashflow tervezőbe (egy fájlt egyszer).
STATE="\$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "\$STATE"; touch "\$STATE/done"
note() { osascript -e "display notification \"\$2\" with title \"\$1\"" >/dev/null 2>&1; }
if ! ls "\$HOME/Downloads" >/dev/null 2>&1; then
  note "Cashflow – nincs hozzáférés" "Engedélyezd: Rendszerbeállítások → Adatvédelem → Teljes lemezhozzáférés → bash"
  exit 0
fi
TOKEN=\$(security find-generic-password -s cashflow-import -w 2>/dev/null) || exit 0
for F in "\$HOME"/Downloads/aggreg8-bank-tranzakciok-*.xml; do
  [ -f "\$F" ] || continue
  case "\$F" in *.json) CT=application/json ;; *) CT=application/xml ;; esac
  # a böngésző még írja a fájlt
  S1=\$(stat -f %z "\$F"); sleep 2; [ "\$S1" = "\$(stat -f %z "\$F")" ] || continue
  SUM=\$(shasum "\$F" | cut -d" " -f1)
  grep -q "\$SUM" "\$STATE/done" && continue
  R=\$(curl -s -m 120 -X POST "$URL/api/ingest/aggreg8" -H "Authorization: Bearer \$TOKEN" -H "X-Requested-With: cashflow" -H "Content-Type: \$CT" --data-binary @"\$F")
  if echo "\$R" | grep -q '"ok":true'; then
    echo "\$SUM" >> "\$STATE/done"
    N=\$(echo "\$R" | grep -o '"inbox":[0-9-]*' | cut -d: -f2 | awk '{s+=\$1} END {print s+0}')
    D=\$(echo "\$R" | grep -o '"duplicates":[0-9-]*' | cut -d: -f2 | awk '{s+=\$1} END {print s+0}')
    note "Cashflow – banki tételek feltöltve" "\$N új tétel jóváhagyásra, \$D már megvolt"
  else
    note "Cashflow – feltöltési hiba" "\$(echo "\$R" | head -c 150)"
  fi
  echo "\$(date '+%F %T') \$(basename "\$F") \$(echo "\$R" | head -c 300)" >> "\$STATE/upload.log"
done
SH
chmod 700 "$SCRIPT"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>WatchPaths</key><array><string>$HOME/Downloads</string></array>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# --- letöltés: a saját, bejelentkezett Chrome-ban megnyitja az aggreg8-at, frissít, és a Letöltésekbe menti a tranzakciókat ---
cat > "$DSCRIPT" <<'SH'
#!/bin/bash
URL="https://cashflow-tervezo.pengemedia.workers.dev"
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
LOG="$STATE/download.log"
note() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
TOKEN=$(security find-generic-password -s cashflow-import -w 2>/dev/null)
# jelentés a cashflow tervezőnek (siker vagy hiba) – az appban és a diagnosztikában látszik
report() { curl -s -m 20 -X POST "$URL/api/ingest/report?ok=$1" -H "Authorization: Bearer $TOKEN" -H "X-Requested-With: cashflow" -H "Content-Type: text/plain; charset=utf-8" --data-binary "$2" >/dev/null 2>&1; }
fail() { log "HIBA: $1"; note "Cashflow – bankszinkron hiba" "$1"; report 0 "$1"; exit 1; }
# egyszerre csak egy futás (a beragadt zárat 20 perc után elengedi)
LOCK="$STATE/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else log "már fut egy szinkron"; exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT
date +%s > "$STATE/last_try"
log "indul ($1)"
# saját lap a Chrome-ban (azonosító alapján vezéreljük, nem URL alapján)
TAB=$(osascript -e 'tell application "Google Chrome"' -e 'activate' -e 'if (count of windows) = 0 then make new window' \
  -e 'set t to make new tab at end of tabs of window 1 with properties {URL:"https://standalone.aggreg8.hu/synchronizations"}' \
  -e 'return id of t' -e 'end tell' 2>&1)
log "lap azonosító: $TAB"
case "$TAB" in ''|*[!0-9]*) fail "A Mac nem vezérelheti a Chrome-ot (Rendszerbeállítások → Adatvédelem → Automatizálás): $TAB" ;; esac
tabdo() {
  osascript -e 'on run argv' -e 'tell application "Google Chrome"' -e 'repeat with w in windows' -e 'repeat with t in tabs of w' \
    -e 'if (id of t as text) is (item 1 of argv) then' -e "$2" -e 'end if' \
    -e 'end repeat' -e 'end repeat' -e 'end tell' -e 'return "NOTAB"' -e 'end run' "$TAB" "$1" 2>&1
}
js() { tabdo "$1" 'return (execute t javascript (item 2 of argv))'; }
goto() { tabdo "$1" 'set URL of t to (item 2 of argv)' >/dev/null; }
sleep 10
R=$(js 'location.href')
log "lap: $R"
case "$R" in
  *-1743*|*"Apple Events"*|*JavaScript*|*execution\ error*) fail "Nincs engedély a Chrome vezérlésére (Chrome: Nézet → Fejlesztő → JavaScript engedélyezése az Apple Events eseményekből): $R" ;;
  NOTAB) fail "Nem nyílt meg az aggreg8 a Chrome-ban." ;;
  *login*) fail "Az aggreg8-ból kiléptetett – jelentkezz be a Chrome-ban (Google), utána magától megy." ;;
esac
# frissítés: a bankkapcsolatok (BinX, MagNet) szinkron gombjai egymás után, mindegyiknél megvárja az eredményt
# a gombokat a bank neve szerint keressük (a lista szinkron után újrarajzolódik, a sorrend/index nem megbízható)
BTN='var q=function(){var b=[].slice.call(document.querySelectorAll("app-bac-list button.btn-sync"));if(!b.length)b=[].slice.call(document.querySelectorAll("button.btn-sync"));return b};var lbl=function(b){for(var e=b;e&&e!==document.body;e=e.parentElement){var t=(e.innerText||"").toLowerCase(),x=/binx/.test(t),m=/magnet/.test(t);if(x!==m)return x?"BinX":"MagNet";if(x&&m)break}return ""};var byName=function(n){return q().filter(function(b){return lbl(b)===n})[0]};'
BANKS=""
SYNCRES=""
for i in $(seq 1 10); do
  BANKS=$(js "(function(){${BTN}return q().map(lbl).filter(Boolean).join(' ')})()")
  case "$BANKS" in *BinX*|*MagNet*) break ;; esac
  sleep 3
done
log "szinkron bankok: $BANKS"
for BANK in BinX MagNet; do
  case " $BANKS " in *" $BANK "*) ;; *) log "szinkron $BANK: nincs gomb"; continue ;; esac
  C=""
  for w in $(seq 1 20); do
    C=$(js "(function(){${BTN}var b=byName('$BANK');if(!b||b.disabled)return 'NINCS';window.__cf_t0=document.body.innerText.split('Sikeres szinkroniz').length;b.scrollIntoView();b.click();return 'KATT'})()")
    [ "$C" = "KATT" ] && break
    sleep 3
  done
  RES="$C"
  if [ "$C" = "KATT" ]; then
    RES="időtúllépés"
    for j in $(seq 1 40); do
      sleep 3
      T=$(js '(function(){var t=document.body.innerText;if(t.split("Sikeres szinkroniz").length>window.__cf_t0)return "OK";if(/sikertelen|hiba történt/i.test(t))return "HIBA";return ""})()')
      case "$T" in OK|HIBA) RES="$T"; break ;; esac
    done
  fi
  log "szinkron $BANK: $RES"
  SYNCRES="$SYNCRES $BANK: $RES;"
  sleep 8
done
goto "https://standalone.aggreg8.hu/transactions"
sleep 3
case "$(js 'location.pathname')" in */transactions*) ;; *) js 'location.href="https://standalone.aggreg8.hu/transactions";"OK"' >/dev/null ;; esac
sleep 12
log "lap: $(js 'location.href')"
EXP=$(curl -fsS -m 30 "$URL/mac/aggreg8-export.js") || fail "Nem érem el a cashflow tervezőt (nincs internet?)."
EXP="${EXP%;}"
# csak az új tételek: a cashflow tervező megmondja, mikori az utolsó banki tétele (−7 nap átfedéssel);
# hétfő hajnalban teljes lista ellenőrzésképpen
SINCE=""
if [ "$(date +%u)" != "1" ] || [ "$(date +%H)" -ge 7 ]; then
  SINCE=$(curl -s -m 30 "$URL/api/ingest/status" -H "Authorization: Bearer $TOKEN" | grep -o '"since":"[0-9-]*"' | cut -d'"' -f4)
fi
log "kezdő dátum: ${SINCE:-teljes lista}"
js "window.__cf_since='$SINCE';'x'" >/dev/null
js "window.__cf_r='fut';($EXP).then(function(r){window.__cf_r=r},function(e){window.__cf_r='HIBA '+e.message});'START'" >/dev/null
for i in $(seq 1 60); do
  sleep 3
  R=$(js 'String(window.__cf_r)')
  case "$R" in fut) ;; *) break ;; esac
done
log "letöltés: $R"
case "$R" in
  OK*)
    # feltöltés közvetlenül a böngészőből átvett adattal (nem kell hozzá a Letöltések mappa elérése)
    F="$STATE/last.json"
    js 'window.__cf_data||""' > "$F"
    js 'delete window.__cf_data;"x"' >/dev/null
    U=$(curl -s -m 120 -X POST "$URL/api/ingest/aggreg8" -H "Authorization: Bearer $TOKEN" -H "X-Requested-With: cashflow" -H "Content-Type: application/json" --data-binary @"$F")
    rm -f "$F"
    log "feltöltés: $(echo "$U" | head -c 400)"
    sleep 3; tabdo "" 'close t' >/dev/null
    if echo "$U" | grep -q '"ok":true'; then
      N=$(echo "$U" | grep -o '"inbox":[0-9-]*' | cut -d: -f2 | awk '{s+=$1} END {print s+0}')
      note "Cashflow – bank frissítve" "Letöltve és feltöltve, $N új tétel jóváhagyásra."
      report 1 "Szinkron:${SYNCRES:- nem futott} Letöltés: ${R#OK } Új tétel: $N."
    else
      fail "Feltöltési hiba: $(echo "$U" | head -c 200)"
    fi ;;
  *LOGIN*) fail "Az aggreg8-ból kiléptetett – jelentkezz be a Chrome-ban (Google)." ;;
  *) fail "Letöltési hiba: $(echo "$R" | head -c 200) (szinkron:$SYNCRES)" ;;
esac
SH
chmod 700 "$DSCRIPT"
cat > "$DPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DLABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DSCRIPT</string><string>ütemezett</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
  </array>
</dict></plist>
PL
launchctl load "$DPLIST"

# --- figyelő: 5 percenként megnézi, kért-e valaki szinkront (app gomb, robot, Claude), vagy pótolni kell egy kimaradt futást ---
PLABEL="hu.pengemedia.cashflow-aggreg8-poll"
PSCRIPT="$HOME/Library/Scripts/cashflow-aggreg8-poll.sh"
PPLIST="$HOME/Library/LaunchAgents/$PLABEL.plist"
cat > "$PSCRIPT" <<'SH'
#!/bin/bash
URL="https://cashflow-tervezo.pengemedia.workers.dev"
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
TOKEN=$(security find-generic-password -s cashflow-import -w 2>/dev/null) || exit 0
S=$(curl -s -m 20 "$URL/api/ingest/status" -H "Authorization: Bearer $TOKEN") || exit 0
REQ=$(echo "$S" | grep -o '"requested_at":[0-9]*' | cut -d: -f2)
DONE=$(cat "$STATE/request_done" 2>/dev/null || echo 0)
GO=""
if [ -n "$REQ" ] && [ "$REQ" -gt "$DONE" ]; then echo "$REQ" > "$STATE/request_done"; GO="kérésre"; fi
# pótlás (pl. a Mac aludt az ütemezett időpontban): legfeljebb óránként egy próbálkozás
if [ -z "$GO" ] && echo "$S" | grep -q '"due":true'; then
  LT=$(cat "$STATE/last_try" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - LT )) -gt 3600 ] && GO="pótlás"
fi
[ -n "$GO" ] && /bin/bash "$HOME/Library/Scripts/cashflow-aggreg8-download.sh" "$GO"
exit 0
SH
chmod 700 "$PSCRIPT"
cat > "$PPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PLABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$PSCRIPT</string></array>
  <key>StartInterval</key><integer>300</integer>
</dict></plist>
PL
launchctl unload "$PPLIST" 2>/dev/null || true
launchctl load "$PPLIST"

echo ""
echo "Kész. 5, 9, 13, 17 és 21 órakor a Chrome megnyitja az aggreg8-at, frissít, és a Letöltésekbe menti a tranzakciókat (aggreg8-tranzakciok-….json);"
echo "a fájlt a Mac feltölti a cashflow tervezőbe. Napló: ~/Library/Application Support/cashflow-aggreg8/"
echo ""
echo "EGYSZER a Chrome-ban: Nézet → Fejlesztő → „JavaScript engedélyezése az Apple Events eseményekből” legyen bepipálva."
echo "Ha a Mac rákérdez, hogy a Terminál/bash vezérelheti-e a Chrome-ot: Engedélyezés."
printf "Ha be vagy jelentkezve az aggreg8-ba a Chrome-ban, nyomj Entert az azonnali próbához (Ctrl+C: kihagyás)… "
read -r _
# ugyanúgy indítjuk, ahogy ütemezve fut (launchd) – így az engedélykérések most jönnek fel, nem hajnalban
L="$HOME/Library/Application Support/cashflow-aggreg8/download.log"; touch "$L"; N0=$(wc -l < "$L")
launchctl kickstart -k "gui/$(id -u)/$DLABEL"
echo "Fut… (ha a Mac engedélyt kér a Chrome vezérléséhez: OK)"
for i in $(seq 1 120); do sleep 5; tail -n +$((N0+1)) "$L" | tail -1 | grep -q "feltöltés:\|letöltés: [^O]\|nincs bejelentkezve\|nincs aggreg8\|nincs engedély" && break; done
tail -n +$((N0+1)) "$L"
