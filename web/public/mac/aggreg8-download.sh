#!/bin/bash
# Cashflow – aggreg8 bankszinkron (a Mac ütemezője és a „Bankszinkron most” kérés indítja; minden futás előtt frissül).
# A munkát az aggreg8-cdp.mjs végzi a Chrome hivatalos vezérlőfelületén (CDP): láthatatlan háttérlap, automatikus
# belépés, szinkron, letöltés, feltöltés. Nem kell hozzá Kisegítő engedély, AppleScript vagy egérkattintás.
URL="${CF_TEST_URL:-https://cashflow-tervezo.pengemedia.workers.dev}"
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
LOG="$STATE/download.log"
note() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
# sikertelen belépés után az automatikus futások 3 óráig pihennek (kézi kérés mindig fut)
LF=$(cat "$STATE/login_failed" 2>/dev/null || echo 0)
if [ "$1" != "kérésre" ] && [ $(( $(date +%s) - LF )) -lt 10800 ]; then log "kihagyva: a legutóbbi belépés nem sikerült (kézi indítás: Bankszinkron most)"; exit 0; fi
TOKEN=$(security find-generic-password -s cashflow-import -w 2>/dev/null)
report() { curl -s -m 20 -X POST "$URL/api/ingest/report?ok=$1" -H "Authorization: Bearer $TOKEN" -H "X-Requested-With: cashflow" -H "Content-Type: text/plain; charset=utf-8" --data-binary "$2" >/dev/null 2>&1; }
fail() { log "HIBA: $1"; note "Cashflow – bankszinkron hiba" "$(echo "$1" | cut -c1-120)"; report 0 "$1"; exit 1; }
[ -n "$TOKEN" ] || { log "nincs feltöltési kulcs a Kulcskarikában"; exit 1; }
# egyszerre csak egy futás (a beragadt zárat 20 perc után elengedi)
LOCK="$STATE/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else log "már fut egy szinkron"; exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT
date +%s > "$STATE/last_try"
log "indul ($1)"

# Node.js (legalább 22-es: beépített WebSocket) – a launchd szűk PATH-ja miatt a szokásos helyeken is keresi
NODE=""
for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/bin/node; do
  [ -x "$n" ] || continue
  "$n" -e 'process.exit(typeof WebSocket==="function"?0:1)' 2>/dev/null && { NODE="$n"; break; }
done
[ -n "$NODE" ] || fail "Nincs megfelelő Node.js a Macen (22-es vagy újabb kell)."

# a script letöltése (ha a szerver nem érhető el, a legutóbbi helyi példány)
CDPJS="$STATE/aggreg8-cdp.mjs"
curl -fsS -m 30 "$URL/mac/aggreg8-cdp.mjs" -o "$CDPJS.new" && mv "$CDPJS.new" "$CDPJS" || rm -f "$CDPJS.new"
[ -f "$CDPJS" ] || fail "Nem érem el a cashflow tervezőt (nincs internet?)."

# a használt Google-fiók (a céges): felülírható a $STATE/google_account fájlban
ACC=$(cat "$STATE/google_account" 2>/dev/null | tr -d " \n")
OUT=$(CF_TOKEN="$TOKEN" CF_URL="$URL" CF_STATE="$STATE" CF_GOOGLE_ACCOUNT="${ACC:-laszlo.nagy@360-marketing.eu}" "$NODE" "$CDPJS" 2>>"$LOG")
RES=$(echo "$OUT" | tail -1)
log "eredmény: $(echo "$RES" | cut -c1-600)"
# az eredmény (JSON) elemzése a Node-dal
OK=$(echo "$RES" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.ok?"1":"0")}catch{console.log("0")}})')
MSG=$(echo "$RES" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.ok?j.msg:(j.msg+" | "+(j.steps||[]).join(" · ")))}catch{console.log("Váratlan hiba: "+s.slice(0,300))}})')
if [ "$OK" = "1" ]; then
  rm -f "$STATE/login_failed"
  report 1 "$MSG"
  note "Cashflow – bank frissítve" "$(echo "$MSG" | grep -o 'Új tétel: [0-9]*' )"
else
  case "$MSG" in *belépni*|*Egyszeri*) date +%s > "$STATE/login_failed" ;; esac
  fail "$MSG"
fi
