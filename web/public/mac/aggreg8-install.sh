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
  rm -f "$PLIST" "$SCRIPT" "$DPLIST" "$DSCRIPT"
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
for F in "\$HOME"/Downloads/aggreg8-bank-tranzakciok-*.xml "\$HOME"/Downloads/aggreg8-tranzakciok-*.json; do
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
# saját lap a Chrome-ban (azonosító alapján vezéreljük, nem URL alapján)
TAB=$(osascript -e 'tell application "Google Chrome"' -e 'activate' -e 'if (count of windows) = 0 then make new window' \
  -e 'set t to make new tab at end of tabs of window 1 with properties {URL:"https://standalone.aggreg8.hu/synchronizations"}' \
  -e 'return id of t' -e 'end tell' 2>&1)
log "lap azonosító: $TAB"
case "$TAB" in ''|*[!0-9]*) note "Cashflow – engedély kell" "A Terminál nem vezérelheti a Chrome-ot: Rendszerbeállítások → Adatvédelem → Automatizálás"; exit 1 ;; esac
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
  *-1743*|*"Apple Events"*|*JavaScript*|*execution\ error*) log "nincs engedély: $R"; note "Cashflow – engedély kell" "Chrome: Nézet → Fejlesztő → JavaScript engedélyezése az Apple Events eseményekből; Rendszerbeállítások → Adatvédelem → Automatizálás → Terminál → Google Chrome"; exit 1 ;;
  NOTAB) log "nincs aggreg8 lap"; note "Cashflow – aggreg8" "Nem nyílt meg az aggreg8 a Chrome-ban."; exit 1 ;;
  *login*) log "nincs bejelentkezve"; note "Cashflow – aggreg8" "Jelentkezz be az aggreg8-ba a Chrome-ban (Google), utána magától megy."; exit 1 ;;
esac
# frissítés: a bankkapcsolatok szinkron gombjai (megvárja, amíg megjelennek)
S=""
for i in $(seq 1 10); do
  S=$(js '(function(){var b=[].slice.call(document.querySelectorAll("button.btn-sync, button[class*=sync]")).filter(function(x){return !x.disabled&&x.offsetParent!==null});if(!b.length)return "NINCS";b.forEach(function(x){x.click()});return "SYNC "+b.length})()')
  [ "$S" != "NINCS" ] && break
  sleep 3
done
log "szinkron: $S"
[ "$S" != "NINCS" ] && sleep 60
goto "https://standalone.aggreg8.hu/transactions"
sleep 12
log "lap: $(js 'location.href')"
EXP=$(curl -fsS -m 30 "$URL/mac/aggreg8-export.js") || { log "export-szkript nem tölthető le"; note "Cashflow – aggreg8" "Nem érem el a cashflow tervezőt."; exit 1; }
EXP="${EXP%;}"
js "window.__cf_r='fut';($EXP).then(function(r){window.__cf_r=r},function(e){window.__cf_r='HIBA '+e.message});'START'" >/dev/null
for i in $(seq 1 60); do
  sleep 3
  R=$(js 'String(window.__cf_r)')
  case "$R" in fut) ;; *) break ;; esac
done
log "letöltés: $R"
# a saját lapot bezárja (a többi lapodhoz nem nyúl)
case "$R" in OK*) sleep 5; tabdo "" 'close t' >/dev/null ;; esac
case "$R" in
  OK*) note "Cashflow – aggreg8" "Letöltve a Letöltésekbe: ${R#OK }" ;;
  *LOGIN*) note "Cashflow – aggreg8" "Jelentkezz be az aggreg8-ba a Chrome-ban (Google)." ;;
  *) note "Cashflow – aggreg8 hiba" "$(echo "$R" | head -c 120)" ;;
esac
SH
chmod 700 "$DSCRIPT"
cat > "$DPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DLABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DSCRIPT</string></array>
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

echo ""
echo "Kész. 5, 9, 13, 17 és 21 órakor a Chrome megnyitja az aggreg8-at, frissít, és a Letöltésekbe menti a tranzakciókat (aggreg8-tranzakciok-….json);"
echo "a fájlt a Mac feltölti a cashflow tervezőbe. Napló: ~/Library/Application Support/cashflow-aggreg8/"
echo ""
echo "EGYSZER a Chrome-ban: Nézet → Fejlesztő → „JavaScript engedélyezése az Apple Events eseményekből” legyen bepipálva."
echo "Ha a Mac rákérdez, hogy a Terminál/bash vezérelheti-e a Chrome-ot: Engedélyezés."
printf "Ha be vagy jelentkezve az aggreg8-ba a Chrome-ban, nyomj Entert az azonnali próbához (Ctrl+C: kihagyás)… "
read -r _
/bin/bash "$DSCRIPT"; echo "Eredmény: $(tail -1 "$HOME/Library/Application Support/cashflow-aggreg8/download.log")"
