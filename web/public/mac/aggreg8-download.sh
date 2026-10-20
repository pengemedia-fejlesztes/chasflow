#!/bin/bash
URL="https://cashflow-tervezo.pengemedia.workers.dev"
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
LOG="$STATE/download.log"
note() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
TOKEN=$(security find-generic-password -s cashflow-import -w 2>/dev/null)
# jelentés a cashflow tervezőnek (siker vagy hiba) – az appban és a diagnosztikában látszik
report() { curl -s -m 20 -X POST "$URL/api/ingest/report?ok=$1" -H "Authorization: Bearer $TOKEN" -H "X-Requested-With: cashflow" -H "Content-Type: text/plain; charset=utf-8" --data-binary "$2" >/dev/null 2>&1; }
LOG0=$(wc -l < "$LOG" 2>/dev/null || echo 0)
# a hibajelentésbe az aktuális futás belépési/szinkron lépései is bekerülnek (diagnosztikához)
fail() { log "HIBA: $1"; note "Cashflow – bankszinkron hiba" "$1"; report 0 "$1 | $(tail -n +$((LOG0+1)) "$LOG" | grep -v 'HIBA:' | cut -c12- | tr '\n' ' ' | tail -c 400)"; exit 1; }
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
# JavaScript a Google bejelentkező lapon (lehet felugró ablak is)
gjs() {
  osascript -e 'on run argv' -e 'tell application "Google Chrome"' -e 'repeat with w in windows' -e 'repeat with t in tabs of w' \
    -e 'if URL of t contains "accounts.google.com" then return (execute t javascript (item 1 of argv))' \
    -e 'end repeat' -e 'end repeat' -e 'end tell' -e 'return "NOGOOGLE"' -e 'end run' "$1" 2>&1
}
# automatikus belépés: a „Bejelentkezés mint …” Google-gomb egy beágyazott Google-elem (iframe), ezért valódi
# egérkattintással nyomjuk meg (a „Cashflow Kattintó” segédprogrammal, a felhasználó jóváhagyásával); jelszót nem ad meg
APP="$HOME/Applications/Cashflow Kattintó.app"
front_tab() {
  osascript -e 'on run argv' -e 'tell application "Google Chrome"' -e 'activate' -e 'repeat with w in windows' -e 'set i to 0' -e 'repeat with t in tabs of w' -e 'set i to i + 1' \
    -e 'if (id of t as text) is (item 1 of argv) then' -e 'set active tab index of w to i' -e 'set index of w to 1' -e 'return "OK"' -e 'end if' \
    -e 'end repeat' -e 'end repeat' -e 'end tell' -e 'return "NOTAB"' -e 'end run' "$TAB" >/dev/null 2>&1
}
autologin() {
  WANT=$(tr -d ' \n' < "$STATE/google_account" 2>/dev/null | tr 'A-Z' 'a-z')
  for attempt in 1 2 3; do
    front_tab; sleep 2
    P=$(js '(function(){var f=[].slice.call(document.querySelectorAll("iframe")).filter(function(e){return /accounts\.google\.com\/gsi/.test(e.src)&&e.offsetParent!==null})[0];if(!f)return "NINCS";f.scrollIntoView({block:"center"});var r=f.getBoundingClientRect();return Math.round(window.screenX+r.left+Math.min(r.width/2,120))+","+Math.round(window.screenY+(window.outerHeight-window.innerHeight)+r.top+r.height/2)})()')
    log "belépés: Google gomb helye: $P"
    case "$P" in [0-9]*,[0-9]*) ;; *) return 1 ;; esac
    [ -d "$APP" ] || { log "belépés: nincs telepítve a Cashflow Kattintó"; return 1; }
    rm -f "$STATE/click.result"
    echo "$P" > "$STATE/click.txt"
    open -W "$APP"
    log "belépés: kattintás: $(cat "$STATE/click.result" 2>/dev/null)"
    for i in $(seq 1 10); do
      sleep 3
      case "$(js 'location.href')" in *standalone.aggreg8.hu*login*) ;; *standalone.aggreg8.hu*) log "belépés: sikeres"; return 0 ;; esac
      # felugró Google-ablak: fiókválasztás / Folytatás
      G=$(gjs "(function(){var want='$WANT';var pw=document.querySelector('input[type=password]');if(pw&&pw.offsetParent)return 'JELSZO';var a=[].slice.call(document.querySelectorAll('[data-identifier],[data-email]'));var id=function(e){return (e.getAttribute('data-identifier')||e.getAttribute('data-email')||'').toLowerCase()};var x=a.filter(function(e){return want&&id(e)===want})[0]||(a.length===1?a[0]:null);if(x){x.click();return 'FIOK '+id(x)}var c=[].slice.call(document.querySelectorAll('button,[role=button]')).filter(function(e){return /^(folytatás|tovább|continue|allow|engedélyezés|confirm|megerősítés)$/i.test((e.innerText||'').trim())})[0];if(c){c.click();return 'TOVABB'}return ''})()")
      case "$G" in
        JELSZO) log "belépés: a Google jelszót/kódot kér"; return 1 ;;
        NOGOOGLE|'') ;;
        *) log "belépés: $G" ;;
      esac
    done
  done
  return 1
}
# megvárja, amíg az oldal betölt (legfeljebb 20 mp)
for i in $(seq 1 20); do sleep 1; case "$(js 'document.readyState')" in complete) break ;; esac; done
sleep 1
R=$(js 'location.href')
log "lap: $R"
case "$R" in
  *standalone.aggreg8.hu*login*)
    if autologin; then
      goto "https://standalone.aggreg8.hu/synchronizations"; sleep 2
      for i in $(seq 1 20); do sleep 1; case "$(js 'document.readyState')" in complete) break ;; esac; done
      R=$(js 'location.href'); log "lap: $R"
    else
      fail "Az aggreg8-ból kiléptetett, és nem tudtam automatikusan visszalépni – részletek a Mac naplójában (belépés: …). Ha a képernyő zárolva volt, a következő futás újrapróbálja."
    fi ;;
esac
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
for i in $(seq 1 20); do
  BANKS=$(js "(function(){${BTN}return q().map(lbl).filter(Boolean).join(' ')})()")
  case "$BANKS" in *BinX*MagNet*|*MagNet*BinX*) break ;; esac
  sleep 1
done
log "szinkron bankok: $BANKS"
for BANK in BinX MagNet; do
  case " $BANKS " in *" $BANK "*) ;; *) log "szinkron $BANK: nincs gomb"; continue ;; esac
  C=""
  for w in $(seq 1 30); do
    C=$(js "(function(){${BTN}var b=byName('$BANK');if(!b||b.disabled)return 'NINCS';var n=function(){return document.body.innerText.split('Sikeres szinkroniz').length};var t0=n();window.__cf_ok='';if(window.__cf_mo)window.__cf_mo.disconnect();window.__cf_mo=new MutationObserver(function(){if(window.__cf_ok)return;var t=document.body.innerText;if(n()>t0)window.__cf_ok='OK';else if(/sikertelen|hiba történt/i.test(t))window.__cf_ok='HIBA'});window.__cf_mo.observe(document.body,{childList:true,subtree:true,characterData:true});b.scrollIntoView();b.click();return 'KATT'})()")
    [ "$C" = "KATT" ] && break
    sleep 2
  done
  RES="$C"
  if [ "$C" = "KATT" ]; then
    RES="időtúllépés"
    # az üzenetet az oldalba tett figyelő azonnal elkapja (a felugró üzenet gyorsan eltűnik) – másodpercenként nézzük
    for j in $(seq 1 90); do
      sleep 1
      T=$(js 'String(window.__cf_ok||"")')
      case "$T" in OK|HIBA) RES="$T"; break ;; esac
    done
  fi
  log "szinkron $BANK: $RES"
  SYNCRES="$SYNCRES $BANK: $RES;"
  sleep 1
done
goto "https://standalone.aggreg8.hu/transactions"
sleep 2
case "$(js 'location.pathname')" in */transactions*) ;; *) js 'location.href="https://standalone.aggreg8.hu/transactions";"OK"' >/dev/null ;; esac
for i in $(seq 1 20); do sleep 1; case "$(js 'document.readyState')" in complete) break ;; esac; done
sleep 1
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
for i in $(seq 1 180); do
  sleep 1
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
