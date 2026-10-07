#!/usr/bin/env bash
set -euo pipefail
# Smoke test: boots OSRM + backend, exercises the API, then tears both down.

PORT="${PORT:-4399}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node="$(command -v node)"
osrm_file="$root/data/osrm/region.osrm"
data="${CM_TEST_DATA:-/tmp/cm-test-test-api}"
rm -rf "$data"; mkdir -p "$data"
export ADMIN_TOKEN=testadmintoken
export CURL_HOME="$(mktemp -d)"
printf 'header = "x-admin-token: %s"\n' "$ADMIN_TOKEN" > "$CURL_HOME/.curlrc"

echo "==> starting osrm-routed (CH) on :5000"
osrm-routed --algorithm ch --port 5099 "$osrm_file" >/tmp/osrm-api.log 2>&1 &
OSRM_PID=$!

echo "==> booting backend on :$PORT"
cd "$root/server"
DATA_DIR="$data" OSRM_PORT="${OSRM_PORT:-5099}" PORT="$PORT" "$node" index.js &
BACK_PID=$!

cleanup(){ kill "$BACK_PID" "$OSRM_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 20); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/api/cities" >/dev/null 2>&1 && break
  sleep 0.5
done
for i in $(seq 1 20); do
  curl -s --max-time 1 "http://127.0.0.1:5099/nearest/v1/foot/12.571,55.682?number=1" | grep -q Ok && break
  sleep 0.5
done

echo "[1] cities:"; curl -s "http://127.0.0.1:$PORT/api/cities" | jq -c 'map({slug,name})'

echo "[2] create area (polygon vertices snapped to streets):"
area_name="Demo $(date +%s)"
resp=$(curl -s -X POST "http://127.0.0.1:$PORT/api/cities/copenhagen/areas" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$area_name\",\"outline\":[{\"x\":12.571,\"y\":55.682},{\"x\":12.585,\"y\":55.681},{\"x\":12.584,\"y\":55.677},{\"x\":12.573,\"y\":55.676}]}")
echo "$resp" | jq -c '{id,name,share_token,n_pts:(.polygon.coordinates[0]|length)}'
area_id="$(echo "$resp" | jq -r .id)"
token="$(echo "$resp" | jq -r .share_token)"

echo "[2b] start campaign:"
camp=$(curl -s -X POST "http://127.0.0.1:$PORT/api/cities/copenhagen/campaigns" \
  -H 'Content-Type: application/json' -d "{\"name\":\"Campaign $(date +%s)\"}")
echo "$camp" | jq -c '{id,name,token}'
campaign_id="$(echo "$camp" | jq -r .id)"
campaign_token="$(echo "$camp" | jq -r .token)"

echo "[3] add route via click waypoints:"
raw=$(curl -s -X POST "http://127.0.0.1:$PORT/api/areas/$area_id/routes" \
  -H 'Content-Type: application/json' \
  -d "{\"campaign_id\":$campaign_id,\"waypoints\":[[12.573,55.679],[12.580,55.679]]}")
echo "    raw: $raw"
echo "$raw" | jq -c '{id,distance_m,path: (.path.coordinates|length)}' 2>/dev/null || echo "$raw"

echo "[4] add route via freehand draw:"
raw=$(curl -s -X POST "http://127.0.0.1:$PORT/api/areas/$area_id/routes" \
  -H 'Content-Type: application/json' \
  -d "{\"campaign_id\":$campaign_id,\"drawn\":[[12.573,55.679],[12.575,55.680],[12.578,55.679],[12.580,55.678]]}")
echo "    raw: $raw"
echo "$raw" | jq -c '{id,distance_m,path: (.path.coordinates|length)}' 2>/dev/null || echo "$raw"

echo "[5] campaign routes:"; curl -s "http://127.0.0.1:$PORT/api/cities/copenhagen/routes?campaign_id=$campaign_id" | jq -c 'length'

echo "[6] public area page /a/$token/$campaign_token:"
curl -s "http://127.0.0.1:$PORT/a/$token/$campaign_token" | jq -c '{area:.area.name,campaign:.campaign.name,city:.city.name,route_count:(.routes|length)}'

echo "==> OK"
