#!/bin/bash
# Lokalis fejlesztoi inditas a konteneren belul (docker compose up).
#   - npm ci, ha a package-lock.json valtozott
#   - a backend (src/server/app/ + src/shared/) buildje figyelo modban -> dist/server/worker.mjs
#   - a Node szerver (src/server/runtime/entry.mjs) a 8787-es porton, valtozaskor ujraindul
#   - a Vite dev szerver az 5173-as porton (a /api kereseket a 8787-re tovabbitja)
set -eu
cd /app

if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.lock-snapshot; then
  echo ">> npm ci (a package-lock.json valtozott vagy meg nincs telepitve)"
  npm ci
  cp package-lock.json node_modules/.lock-snapshot
fi

echo ">> Backend build"
npm run --silent build:server

pids=""
cleanup() { [ -n "$pids" ] && kill $pids 2>/dev/null || true; }
trap cleanup EXIT INT TERM

npx esbuild src/server/app/index.ts --bundle --format=esm --platform=node --target=node22 \
  --outfile=dist/server/worker.mjs --watch=forever --log-level=warning &
pids="$pids $!"

node --watch-path=dist/server --watch-path=src/server/runtime src/server/runtime/entry.mjs &
pids="$pids $!"

npx vite --host 0.0.0.0 --port 5173 --strictPort &
pids="$pids $!"

# ha barmelyik folyamat leall, az egesz kontener leall (a compose ujrainditja / jelzi)
wait -n
