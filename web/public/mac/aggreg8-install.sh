#!/bin/bash
# Cashflow tervező – aggreg8 napi export: ütemezett letöltés a saját böngészőben + automatikus feltöltés a Letöltések mappából (macOS).
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

if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl unload "$DPLIST" 2>/dev/null || true
  rm -f "$PLIST" "$SCRIPT" "$DPLIST" "$DSCRIPT"
  security delete-generic-password -s cashflow-import >/dev/null 2>&1 || true
  echo "Eltávolítva."
  exit 0
fi

printf "Feltöltési kulcs (az appból: Beállítások → Bekötések → Automatikus feltöltés): "
read -rs TOKEN; echo
case "$TOKEN" in cfi_*) ;; *) echo "Ez nem feltöltési kulcs (cfi_ kezdetű)."; exit 1 ;; esac
# a kulcs a Kulcskarikába kerül, nem fájlba
security add-generic-password -U -a cashflow -s cashflow-import -w "$TOKEN"

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
  SUM=\$(shasum "\$F" | cut -d" " -f1)
  grep -q "\$SUM" "\$STATE/done" && continue
  R=\$(curl -s -m 90 -X POST "$URL/api/ingest/aggreg8" -H "Authorization: Bearer \$TOKEN" -H "X-Requested-With: cashflow" -H "Content-Type: application/xml" --data-binary @"\$F")
  if echo "\$R" | grep -q '"ok":true'; then
    echo "\$SUM" >> "\$STATE/done"
    N=\$(echo "\$R" | grep -o '"inbox":[0-9-]*' | cut -d: -f2 | awk '{s+=\$1} END {print s+0}')
    D=\$(echo "\$R" | grep -o '"duplicates":[0-9-]*' | cut -d: -f2 | awk '{s+=\$1} END {print s+0}')
    note "Cashflow – banki tételek feltöltve" "\$N új tétel jóváhagyásra, \$D már megvolt"
  else
    note "Cashflow – feltöltési hiba" "\$(echo "\$R" | head -c 150)"
  fi
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

# --- automatikus letöltés a saját, bejelentkezett böngésződben (a felhasználó jóváhagyásával) ---
if [ -d "/Applications/Google Chrome.app" ]; then BROWSER="Google Chrome"; else BROWSER="Safari"; fi
cat > "$DSCRIPT" <<'SH'
#!/bin/bash
# Az aggreg8 „Tranzakciók” oldal megnyitása a böngészőben és az XML export letöltése
# (a feltöltést a Letöltések-figyelő végzi). Eltávolítás: a telepítő --uninstall kapcsolójával.
BROWSER="__BROWSER__"
PAGE="https://standalone.aggreg8.hu/transactions"
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
note() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
JS='(function(){var t=function(e){return (e.innerText||e.textContent||"").replace(/\s+/g," ").trim()};if(document.querySelector("input[type=password]"))return "LOGIN";var els=[].slice.call(document.querySelectorAll("button,a,[role=button],[role=menuitem],mat-option"));var vis=function(e){return e.offsetParent!==null};var x=els.filter(function(e){return /xml/i.test(t(e))&&vis(e)})[0]||els.filter(function(e){return /let(ö|o)lt|export|download/i.test(t(e))&&vis(e)})[0];if(!x)return "NOBUTTON:"+els.map(t).filter(Boolean).slice(0,40).join(" | ");x.click();return "CLICKED:"+t(x)})()'
run_js() {
  local app="$BROWSER" cmd
  if [ "$app" = "Google Chrome" ]; then cmd='execute t javascript (item 1 of argv)'; else cmd='do JavaScript (item 1 of argv) in t'; fi
  osascript -e 'on run argv' -e "tell application \"$app\"" -e 'repeat with w in windows' -e 'repeat with t in tabs of w' \
    -e "if URL of t contains \"standalone.aggreg8.hu\" then return ($cmd)" -e 'end repeat' -e 'end repeat' -e 'end tell' -e 'return "NOTAB"' -e 'end run' "$JS" 2>&1
}
open -g -a "$BROWSER" "$PAGE"
R=""
for i in 1 2 3 4 5 6 7 8; do
  sleep 5
  R=$(run_js)
  case "$R" in
    CLICKED:*[xX][mM][lL]*) break ;;
    CLICKED:*) sleep 3; R2=$(run_js); case "$R2" in CLICKED:*) R="$R2" ;; esac; break ;;
    LOGIN) break ;;
  esac
done
echo "$(date '+%F %T') $R" >> "$STATE/download.log"
case "$R" in
  CLICKED:*) note "Cashflow – aggreg8" "Letöltés elindítva, a feltöltés automatikus." ;;
  LOGIN) note "Cashflow – aggreg8" "Jelentkezz be az aggreg8-ba a böngészőben ($BROWSER), utána magától megy." ;;
  *-1743*|*JavaScript*|*"Apple Events"*) note "Cashflow – engedély kell" "$BROWSER: engedélyezd a JavaScriptet az Apple Events számára." ;;
  *) note "Cashflow – aggreg8" "Nem találtam a letöltés gombot – részletek: download.log" ;;
esac
SH
sed -i '' "s/__BROWSER__/$BROWSER/" "$DSCRIPT" 2>/dev/null || sed -i "s/__BROWSER__/$BROWSER/" "$DSCRIPT"
chmod 700 "$DSCRIPT"
cat > "$DPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DLABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DSCRIPT</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>30</integer></dict>
  </array>
</dict></plist>
PL
launchctl unload "$DPLIST" 2>/dev/null || true
launchctl load "$DPLIST"

echo ""
echo "Kész. Naponta 7:30-kor és 16:30-kor a(z) $BROWSER megnyitja az aggreg8 letöltési oldalát és letölti az XML-t;"
echo "a Letöltésekbe kerülő aggreg8-bank-tranzakciok-*.xml automatikusan feltöltődik, értesítéssel."
echo ""
if [ "$BROWSER" = "Google Chrome" ]; then
  echo "EGYSZERI BEÁLLÍTÁS a Chrome-ban: Nézet → Fejlesztő → „JavaScript engedélyezése az Apple Events eseményekből” legyen bepipálva."
else
  echo "EGYSZERI BEÁLLÍTÁS a Safariban: Beállítások → Speciális → „Fejlesztői funkciók megjelenítése”, majd Fejlesztés menü → „JavaScript engedélyezése az Apple Events eseményekből”."
fi
echo "Ha a Mac rákérdez, hogy a Terminál vezérelheti-e a böngészőt: Engedélyezés."
echo ""
printf "Ha megvan a beállítás és be vagy jelentkezve az aggreg8-ba, nyomj Entert a próbához (vagy Ctrl+C a kihagyáshoz)… "
read -r _
/bin/bash "$DSCRIPT"; echo "Eredmény: $(tail -1 "$HOME/Library/Application Support/cashflow-aggreg8/download.log")"
sleep 15
/bin/bash "$SCRIPT" && echo "(ha letöltődött új fájl, a feltöltésről értesítés jött)"
