#!/bin/bash
URL="https://cashflow-tervezo.pengemedia.workers.dev"
STATE="$HOME/Library/Application Support/cashflow-aggreg8"; mkdir -p "$STATE"
LOG="$STATE/download.log"
note() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
LF=$(cat "$STATE/login_failed" 2>/dev/null || echo 0)
if [ "$1" != "kérésre" ] && [ $(( $(date +%s) - LF )) -lt 10800 ]; then log "kihagyva: a legutóbbi automatikus belépés nem sikerült (kézi indítás: Bankszinkron most)"; exit 0; fi
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
# a céges Chrome-profilban nyitja meg (nem a robotok/AI profiljában): a 360-marketing.eu fiókos profil,
# vagy a „céges/360/penge” nevű; felülírható: $STATE/chrome_profile (pl. „Profile 1”)
PROFILE=$(tr -d '\n' < "$STATE/chrome_profile" 2>/dev/null)
if [ -z "$PROFILE" ]; then
  PROFILE=$(osascript -l JavaScript -e 'ObjC.import("Foundation");var p=$("~/Library/Application Support/Google/Chrome/Local State").stringByExpandingTildeInPath.js;var s=$.NSString.stringWithContentsOfFileEncodingError(p,$.NSUTF8StringEncoding,null);var c=s?JSON.parse(s.js).profile.info_cache:{};var k=Object.keys(c);var f=function(re){return k.filter(function(d){var i=c[d];return re.test([i.user_name,i.gaia_name,i.name].join(" "))})[0]};f(/360-marketing\.eu/i)||f(/c[ée]ges|360|penge/i)||""' 2>/dev/null)
fi
log "Chrome-profil: ${PROFILE:-alapértelmezett}"
# a saját Chrome-od (a robotok külön adatkönyvtáras / távvezérelt Chrome-ja nem): a fő folyamat azonosítója
chrome_pid() { ps -axo pid=,args= | awk '/\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)/ && !/--type=/ && !/--user-data-dir/ && !/--remote-debugging/ && !/--no-startup-window/ {print $1; exit}'; }
CPID=$(chrome_pid)
if [ -z "$CPID" ]; then open -a "Google Chrome"; for i in $(seq 1 20); do sleep 1; CPID=$(chrome_pid); [ -n "$CPID" ] && break; done; sleep 3; fi
CJS="$STATE/aggreg8-chrome.js"
curl -fsS -m 30 "$URL/mac/aggreg8-chrome.js" -o "$CJS.new" && mv "$CJS.new" "$CJS"
cr() { osascript -l JavaScript "$CJS" "$CPID" "$@" 2>&1; }
log "Chrome folyamat: ${CPID:-nincs}"
[ -n "$CPID" ] || fail "Nem indul a Google Chrome."
BEFORE=",$(cr ids),"
# új ablak a céges profilban (a futó Chrome-nak adja át, nem indít új példányt)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ${PROFILE:+--profile-directory="$PROFILE"} --new-window "https://standalone.aggreg8.hu/synchronizations" >/dev/null 2>&1
# a saját (új) lapunk azonosítója – ezt az egy ablakot vezéreljük, a végén ezt zárjuk be
TAB=""
for i in $(seq 1 30); do
  sleep 1
  TAB=$(cr findnew "$BEFORE")
  case "$TAB" in [0-9]*) break ;; *) TAB="" ;; esac
done
# a végén a teljes ablakot bezárja (sikernél és hibánál is)
trap '[ -n "$TAB" ] && cr closewin "$TAB" >/dev/null; rm -rf "$LOCK"' EXIT
log "lap azonosító: $TAB"
if [ -z "$TAB" ]; then
  log "chrome folyamatok: $(ps -axo args | grep -E '/Google Chrome[^/]*\.app/Contents/MacOS/' | grep -v Helper | sed -E 's#.*/([^/]+\.app)/Contents/MacOS/[^ ]+#\1#; s#--user-data-dir=([^ ]+)#udd=\1#' | cut -c1-120 | sort | uniq -c | tr '\n' ';')"
  log "vezérelt lapok: $(cr urls | cut -c1-200)"
fi
case "$TAB" in ''|*[!0-9]*) fail "Nem találom a megnyitott aggreg8 ablakot a Chrome-ban." ;; esac
js() { cr js "$TAB" "$1"; }
goto() { cr seturl "$TAB" "$1" >/dev/null; }
# JavaScript a Google bejelentkező lapon (lehet felugró ablak is)
gjs() { cr gjs "" "$1"; }
# automatikus belépés: a „Bejelentkezés mint …” Google-gomb egy beágyazott Google-elem (iframe), ezért valódi
# egérkattintással nyomjuk meg (a „Cashflow Kattintó” segédprogrammal, a felhasználó jóváhagyásával); jelszót nem ad meg
APP="$HOME/Applications/Cashflow Kattintó.app"
front_tab() { cr front "$TAB" >/dev/null; }
# kattintás valódi egérrel a Kattintóval (a megadott lapot előre hozva)
realclick() { # $1 = lap azonosító, $2 = "x,y"
  rm -f "$STATE/click.result"; echo "$2" > "$STATE/click.txt"
  cr front "$1" >/dev/null; sleep 0.5
  open -g -W "$APP"
  log "belépés: kattintás: $(cat "$STATE/click.result" 2>/dev/null)"
}
# a Chrome saját „Folytatás … néven” ablakának gombja (a Kattintó a Kisegítő felületen nyomja meg)
axpress() {
  rm -f "$STATE/click.result"; echo "press $CPID folytatás|continue as|continue" > "$STATE/click.txt"
  cr front "$TAB" >/dev/null; sleep 0.5
  open -g -W "$APP"
  log "belépés: Chrome-ablak gomb: $(cat "$STATE/click.result" 2>/dev/null | cut -c1-300)"
}
# a Google felugró ablakában a teendő elem képernyő-koordinátája: a fiókod, vagy a Folytatás/Tovább gomb
GPICK='(function(){var want=WANT;var vis=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0};var pw=document.querySelector("input[type=password]");if(pw&&vis(pw))return "JELSZO";var pt=function(e,lab){e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return "PT "+Math.round(window.screenX+r.left+r.width/2)+","+Math.round(window.screenY+(window.outerHeight-window.innerHeight)+r.top+r.height/2)+" "+lab};var all=[].slice.call(document.querySelectorAll("[data-identifier],[data-email]")).filter(vis);var id=function(e){return (e.getAttribute("data-identifier")||e.getAttribute("data-email")||"").toLowerCase()};var x=all.filter(function(e){return want&&id(e)===want})[0]||(all.length===1?all[0]:null);if(x)return pt(x,"fiók "+id(x));var bs=[].slice.call(document.querySelectorAll("button,[role=button],a")).filter(vis);var c=bs.filter(function(e){return /^(folytatás|tovább|continue|bejelentkezés|sign in|confirm|megerősítés|engedélyezés|allow)/i.test((e.innerText||"").trim())})[0];if(c)return pt(c,"gomb "+(c.innerText||"").trim().slice(0,30));if(want){var el=[].slice.call(document.querySelectorAll("div,li,span")).filter(function(e){return vis(e)&&(e.innerText||"").trim().toLowerCase()===want})[0];if(el)return pt(el,"fiók szöveg")}return "SEMMI: "+(document.body.innerText||"").replace(/\s+/g," ").slice(0,160)})()'
autologin() {
  WANT=$(tr -d ' \n' < "$STATE/google_account" 2>/dev/null | tr 'A-Z' 'a-z')
  [ -z "$WANT" ] && WANT=$(osascript -l JavaScript -e 'ObjC.import("Foundation");var p=$("~/Library/Application Support/Google/Chrome/Local State").stringByExpandingTildeInPath.js;var s=$.NSString.stringWithContentsOfFileEncodingError(p,$.NSUTF8StringEncoding,null);var c=s?JSON.parse(s.js).profile.info_cache:{};var i=c["'"${PROFILE:-Default}"'"]||{};(i.user_name||"").toLowerCase()' 2>/dev/null)
  log "belépés: fiók: ${WANT:-?}"
  GBEFORE=",$(cr ids),"
  for attempt in 1; do
    case "$(js 'location.href')" in *standalone.aggreg8.hu*login*) ;; *standalone.aggreg8.hu*) log "belépés: sikeres"; return 0 ;; esac
    front_tab; sleep 1
    P=$(js '(function(){var f=[].slice.call(document.querySelectorAll("iframe")).filter(function(e){return /accounts\.google\.com\/gsi/.test(e.src)&&e.offsetParent!==null})[0];if(!f)return "NINCS";f.scrollIntoView({block:"center"});var r=f.getBoundingClientRect();return Math.round(window.screenX+r.left+Math.min(r.width/2,120))+","+Math.round(window.screenY+(window.outerHeight-window.innerHeight)+r.top+r.height/2)})()')
    log "belépés: Google gomb helye: $P"
    [ -d "$APP" ] || { log "belépés: nincs telepítve a Cashflow Kattintó"; return 1; }
    case "$P" in [0-9]*,[0-9]*) realclick "$TAB" "$P" ;; esac
    for i in $(seq 1 12); do
      sleep 2
      case "$(js 'location.href')" in *standalone.aggreg8.hu*login*) ;; *standalone.aggreg8.hu*) log "belépés: sikeres"; return 0 ;; esac
      # a Chrome beépített Google-belépő ablaka: „Folytatás … néven”
      if [ "$i" = 1 ] || [ "$i" = 4 ]; then axpress; continue; fi
      GT=$(cr findgoogle "$GBEFORE")
      [ -n "$GT" ] || continue
      G=$(cr js "$GT" "${GPICK/WANT/\"$WANT\"}")
      log "belépés: Google ablak: $(echo "$G" | cut -c1-200)"
      case "$G" in
        JELSZO) log "belépés: a Google jelszót/kódot kér"; return 1 ;;
        "PT "*) XY=$(echo "$G" | cut -d' ' -f2); realclick "$GT" "$XY"; sleep 2 ;;
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
  "missing value"|"") fail "A Chrome nem engedi a vezérlést: a céges profilban kapcsold be: Nézet → Fejlesztő → A JavaScript engedélyezése Apple-eseményekből." ;;
  *standalone.aggreg8.hu*login*)
    if autologin; then
      rm -f "$STATE/login_failed"
      goto "https://standalone.aggreg8.hu/synchronizations"; sleep 2
      for i in $(seq 1 20); do sleep 1; case "$(js 'document.readyState')" in complete) break ;; esac; done
      R=$(js 'location.href'); log "lap: $R"
    else
      date +%s > "$STATE/login_failed"
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
