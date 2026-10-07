#!/usr/bin/env bash
set -euo pipefail
# Seed a performance dataset (Voronoi areas + campaign + routes) into the real
# data/ dir, then leave it there. Uses its own OSRM/backend on dedicated ports.
# Run with: nix develop -c bash scripts/seed-perf.sh
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="$root/data"
osrm_file="$data/osrm/region.osrm"
api_port="${API_PORT:-4345}"
osrm_port="${OSRM_PORT:-5101}"
n="${N_AREAS:-10}"

if [[ ! -f "$osrm_file.hsgr" ]]; then
  echo "error: OSRM dataset missing; run 'nix run .#provision' first" >&2
  exit 1
fi

echo "==> clearing existing data (sqlite)"
rm -f "$data/collabmap.db" "$data/collabmap.db-wal" "$data/collabmap.db-shm"

echo "==> starting OSRM on :$osrm_port"
osrm-routed --algorithm ch --port "$osrm_port" "$osrm_file" >/tmp/osrm-perf.log 2>&1 &
OP=$!
echo "==> starting backend on :$api_port"
(cd "$root/server" && exec env DATA_DIR="$data" OSRM_PORT="$osrm_port" PORT="$api_port" node index.js >/tmp/be-perf.log 2>&1) &
BP=$!
cleanup(){ kill "$BP" "$OP" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 30); do curl -s --max-time 1 "http://127.0.0.1:$api_port/api/cities" >/dev/null 2>&1 && break; sleep 0.3; done
for i in $(seq 1 40); do curl -s --max-time 1 "http://127.0.0.1:$osrm_port/nearest/v1/foot/12.571,55.682?number=1" | grep -q Ok && break; sleep 0.5; done

echo "==> seeding"
BASE="http://127.0.0.1:$api_port" CITY=copenhagen N_AREAS="$n" node "$root/scripts/seed-perf.mjs"

echo "==> done (data left in $data/collabmap.db)"
