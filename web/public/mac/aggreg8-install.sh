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
  rm -rf "$HOME/Applications/Cashflow Kattintó.app"
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
# Mindig a legfrissebb letöltő fut (a javításokhoz nem kell újratelepíteni); ha a szerver nem érhető el, a legutóbbi helyi példány.
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
F="$STATE/aggreg8-download.sh"
if curl -fsS -m 30 "https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-download.sh" -o "$F.new" && bash -n "$F.new"; then mv "$F.new" "$F"; else rm -f "$F.new"; fi
exec /bin/bash "$F" "$@"
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

# a korábbi „Cashflow Kattintó” már nem kell (a Chrome vezérlése a hivatalos CDP-felületen megy)
rm -rf "$HOME/Applications/Cashflow Kattintó.app"

# --- figyelő: 30 másodpercenként megnézi, kért-e valaki szinkront (app gomb, robot, Claude), vagy pótolni kell egy kimaradt futást ---
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
  <key>StartInterval</key><integer>30</integer>
</dict></plist>
PL
launchctl unload "$PPLIST" 2>/dev/null || true
launchctl load "$PPLIST"

echo ""
echo "Kész. 5, 9, 13, 17 és 21 órakor a Chrome megnyitja az aggreg8-at, frissít, és a Letöltésekbe menti a tranzakciókat (aggreg8-tranzakciok-….json);"
echo "a fájlt a Mac feltölti a cashflow tervezőbe. Napló: ~/Library/Application Support/cashflow-aggreg8/"
echo ""
echo "Próbafutás indul (a belépést is a rendszer intézi)…"
# ugyanúgy indítjuk, ahogy ütemezve fut (launchd) – így az engedélykérések most jönnek fel, nem hajnalban
L="$HOME/Library/Application Support/cashflow-aggreg8/download.log"; touch "$L"; N0=$(wc -l < "$L")
launchctl kickstart -k "gui/$(id -u)/$DLABEL"
echo "Fut…"
for i in $(seq 1 120); do sleep 5; tail -n +$((N0+1)) "$L" | tail -1 | grep -q "eredmény:\|HIBA:\|már fut\|kihagyva" && break; done
tail -n +$((N0+1)) "$L"
