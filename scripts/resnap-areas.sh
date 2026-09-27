#!/usr/bin/env bash
set -euo pipefail
# Re-snap all saved areas' boundaries from their waypoints, using the running
# OSRM dataset. This rewrites the real developer database (data/). Use it to
# clean up routed nooks/crannies on areas created before simplification existed.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="$root/data"
osrm_file="$data/cities/copenhagen/copenhagen.osrm"
port="${PORT:-4334}"

if [[ ! -f "$osrm_file.hsgr" ]]; then
  echo "error: OSRM dataset missing; run 'nix run .#provision' first" >&2
  exit 1
fi

osrm-routed --algorithm ch --port 5000 "$osrm_file" >/tmp/osrm-resnap.log 2>&1 &
OSRM_PID=$!
(cd "$root/server" && exec env DATA_DIR="$data" OSRM_PORT=5000 PORT="$port" node index.js >/tmp/be-resnap.log 2>&1) &
BACK_PID=$!
cleanup(){ kill "$BACK_PID" "$OSRM_PID" 2>/dev/null || true; pkill -f osrm-routed 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 25); do curl -s --max-time 1 "http://127.0.0.1:$port/api/cities" >/dev/null 2>&1 && break; sleep 0.5; done
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:5000/nearest/v1/foot/12.571,55.682?number=1" | grep -q Ok && break; sleep 0.5; done

slug="$(curl -s "http://127.0.0.1:$port/api/cities" | jq -r '.[0].slug')"
echo "==> re-snapping areas for city: $slug"
resp=$(curl -s -X POST "http://127.0.0.1:$port/api/cities/$slug/resnap")
echo "$resp" | jq -r '.areas[] | "  \(.name): \(.polygon.coordinates[0] | length) points"' 2>/dev/null || echo "$resp"
echo "==> done"