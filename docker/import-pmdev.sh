#!/bin/bash
# Az eles (pmdev) MySQL-adat behozasa a lokalis SQLite-ba. A HOSTON futtatando (nem a kontenerben):
#
#   bash docker/import-pmdev.sh                 # friss dump a pmdev-rol (ssh pmdev), majd import
#   bash docker/import-pmdev.sh <dump.sql.gz>   # egy korabbi dump ujraimportalasa
#
# Lepesek:
#   1. mysqldump a pmdev-en, CSAK OLVASVA (--single-transaction), SSH-n at egyenesen ide: .data/import/
#      (a szerveren semmi nem irodik, a titkok nem kerulnek ki a szerverrol)
#   2. ideiglenes MySQL 5.7 kontener (mint a pmdev-en), a dump betoltese
#   3. tools/mysql2sqlite.mjs: uj SQLite-fajl a migrations/ semajaval + az adatok, darabszam-ellenorzessel
#      (a munkamenetek, belepesi kiserletek, jelszo-visszaallitasok es OAuth-allapotok kimaradnak)
#   4. a futo app leallitasa, a regi lokalis adatbazis mentese (.data/backup/<ido>/), csere, ujrainditas
#   5. lokalis admin: LOCAL_ADMIN_EMAIL / LOCAL_ADMIN_PASSWORD (alapbol teszt@pelda.hu / Helyi-teszt-jelszo-123)
#
# FIGYELEM: ez valodi penzugyi adat. A .data/ mappa gitignore-ban van – ne masold mashova.
set -euo pipefail
cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
NET=cf-import-$TS
MY=cf-import-mysql-$TS
NODE_IMG=node:22-bookworm-slim
MYSQL_IMG=mysql:5.7.44
ADMIN_EMAIL=${LOCAL_ADMIN_EMAIL:-teszt@pelda.hu}
ADMIN_PW=${LOCAL_ADMIN_PASSWORD:-Helyi-teszt-jelszo-123}
SKIP=sessions,login_attempts,password_resets,reset_requests,oauth_states

mkdir -p .data/import .data/backup

cleanup() {
  docker rm -f "$MY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. dump
if [ $# -ge 1 ]; then
  DUMP=$1
  echo ">> Meglevo dump: $DUMP"
else
  DUMP=.data/import/pmdev-$TS.sql.gz
  echo ">> mysqldump a pmdev-rol (csak olvasas) -> $DUMP"
  ssh pmdev 'cd ~/cashflow && set -a && . ./.env && set +a &&
    MYSQL_PWD="$DB_PASSWORD" mysqldump -h "$DB_HOST" -u "$DB_USER" \
      --single-transaction --skip-lock-tables --no-tablespaces --default-character-set=utf8mb4 \
      "$DB_NAME"' | gzip >"$DUMP"
  # a mysqldump hiba eseten is irhat reszleges kimenetet: a befejezo sornak meg kell lennie
  gunzip -c "$DUMP" | tail -n 1 | grep -q 'Dump completed' || { echo "HIBA: hianyos dump: $DUMP"; exit 1; }
fi
echo "   meret: $(du -h "$DUMP" | cut -f1)"

# 2. ideiglenes MySQL
echo ">> Ideiglenes MySQL ($MYSQL_IMG)"
docker network create "$NET" >/dev/null
docker run -d --name "$MY" --network "$NET" -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=cashflow \
  "$MYSQL_IMG" --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
# az entrypoint inicializalas utan ujraindul: ket egymast koveto sikeres kapcsolodasig varunk
ok=0
for _ in $(seq 1 90); do
  if docker exec "$MY" mysql -uroot -e 'SELECT 1' cashflow >/dev/null 2>&1; then ok=$((ok + 1)); else ok=0; fi
  [ $ok -ge 2 ] && break
  sleep 2
done
[ $ok -ge 2 ] || { echo "HIBA: a MySQL nem indult el"; docker logs "$MY" | tail -20; exit 1; }
gunzip -c "$DUMP" | docker exec -i "$MY" mysql -uroot cashflow
echo "   betoltve"

# 3. atalakitas
echo ">> MySQL -> SQLite"
NEW=.data/cashflow.import-$TS.sqlite
docker run --rm --network "$NET" -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app \
  -e MYSQL_HOST="$MY" -e MYSQL_DATABASE=cashflow \
  "$NODE_IMG" node --no-warnings tools/mysql2sqlite.mjs "$NEW" --skip="$SKIP"

# 4. csere
echo ">> A lokalis app leallitasa es az adatbazis csereje"
docker compose stop app >/dev/null 2>&1 || true
if [ -f .data/cashflow.sqlite ]; then
  mkdir -p ".data/backup/$TS"
  mv .data/cashflow.sqlite* ".data/backup/$TS/"
  echo "   a korabbi lokalis adatbazis: .data/backup/$TS/"
fi
mv "$NEW" .data/cashflow.sqlite
rm -f "$NEW-wal" "$NEW-shm"

# 5. lokalis admin
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app "$NODE_IMG" \
  node --no-warnings tools/local-admin.mjs .data/cashflow.sqlite "$ADMIN_EMAIL" "$ADMIN_PW" "Lokalis admin"

docker compose up -d app >/dev/null
echo ">> Kesz. Felulet: http://localhost:5173  (belepes: $ADMIN_EMAIL)"
