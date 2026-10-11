#!/bin/bash
# Cashflow tervező – aggreg8 napi export automatikus feltöltése a Letöltések mappából (macOS).
# Telepítés:  bash <(curl -fsSL https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-install.sh)
# Eltávolítás: bash <(curl -fsSL https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-install.sh) --uninstall
set -e
URL="https://cashflow-tervezo.pengemedia.workers.dev"
LABEL="hu.pengemedia.cashflow-aggreg8"
SCRIPT="$HOME/Library/Scripts/cashflow-aggreg8.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$SCRIPT"
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
echo "Kész. Ha a Letöltésekbe új aggreg8-bank-tranzakciok-*.xml kerül, automatikusan feltöltöm és értesítést küldök."
echo "Most lefuttatom egyszer kézzel is:"
/bin/bash "$SCRIPT" && echo "(ha volt új fájl, az értesítés megjelent)"
