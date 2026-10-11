#!/bin/bash
# Cashflow tervező – aggreg8 banki tételek automatikus feltöltése a Letöltések mappából (macOS).
# A letöltést a Claude ügynök végzi a böngészőben (aggreg8-tranzakciok-*.json), vagy kézzel letöltött XML (aggreg8-bank-tranzakciok-*.xml).
# Telepítés:  bash <(curl -fsSL https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-install.sh)
# Eltávolítás: bash <(curl -fsSL https://cashflow-tervezo.pengemedia.workers.dev/mac/aggreg8-install.sh) --uninstall
set -e
URL="https://cashflow-tervezo.pengemedia.workers.dev"
LABEL="hu.pengemedia.cashflow-aggreg8"
SCRIPT="$HOME/Library/Scripts/cashflow-aggreg8.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# a korábbi (gombra kattintó) letöltő – már nem kell
DPLIST="$HOME/Library/LaunchAgents/hu.pengemedia.cashflow-aggreg8-download.plist"
DSCRIPT="$HOME/Library/Scripts/cashflow-aggreg8-download.sh"
launchctl unload "$DPLIST" 2>/dev/null || true
rm -f "$DPLIST" "$DSCRIPT"

if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$SCRIPT"
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
# Új aggreg8 export a Letöltésekben → feltöltés a Cashflow tervezőbe (egy fájlt egyszer; a Claude ügynök JSON-ját utána törli).
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
    case "\$F" in *.json) rm -f "\$F" ;; esac
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

echo ""
echo "Kész. A Letöltésekbe kerülő aggreg8 fájlokat (a Claude ügynök JSON-ja és a kézi XML) a Mac magától feltölti, értesítéssel."
echo "Napló: ~/Library/Application Support/cashflow-aggreg8/upload.log"
