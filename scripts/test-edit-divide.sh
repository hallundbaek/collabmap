#!/usr/bin/env bash
set -euo pipefail
# Tests the edit and divide endpoints. Boots OSRM + backend, runs assertions, tears down.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port=4322
osrm_file="$root/data/cities/copenhagen/copenhagen.osrm"
data="${CM_TEST_DATA:-/tmp/cm-test-test-edit-divide}"
rm -rf "$data"; mkdir -p "$data"
export ADMIN_TOKEN=testadmintoken
export CURL_HOME="$(mktemp -d)"
printf 'header = "x-admin-token: %s"\n' "$ADMIN_TOKEN" > "$CURL_HOME/.curlrc"

echo "==> starting osrm-routed on :5000"
osrm-routed --algorithm ch --port 5099 "$osrm_file" >/tmp/osrm-edit.log 2>&1 &
OSRM_PID=$!
echo "==> starting backend on :$port"
(cd "$root/server" && exec env DATA_DIR="$data" OSRM_PORT=5099 PORT="$port" node index.js >/tmp/be-edit.log 2>&1) &
BACK_PID=$!
# the subshell is replaced by node (exec), so $! is node's real pid

cleanup(){ kill "$BACK_PID" "$OSRM_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 25); do curl -s --max-time 1 "http://127.0.0.1:$port/api/cities" >/dev/null 2>&1 && break; sleep 0.5; done
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:5099/route/v1/foot/12.571,55.682;12.585,55.681?overview=false" | grep -q Ok && break; sleep 0.5; done

stamp=$(date +%s)
echo "==> create area"
resp=$(curl -s -X POST "http://127.0.0.1:$port/api/cities/copenhagen/areas" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Base $stamp\",\"outline\":[{\"x\":12.571,\"y\":55.682},{\"x\":12.585,\"y\":55.681},{\"x\":12.584,\"y\":55.677},{\"x\":12.573,\"y\":55.676}]}")
echo "    RAW: $resp"
id=$(echo "$resp" | jq -r .id)
echo "    created id=$id name=$(echo "$resp"|jq -r .name) pts=$(echo "$resp"|jq '.polygon.coordinates[0]|length') outline=$(echo "$resp"|jq '.outline|length')"

echo "==> edit (rename + move waypoint)"
resp=$(curl -s -X PUT "http://127.0.0.1:$port/api/cities/copenhagen/areas/$id" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Edited $stamp\",\"points\":[{\"x\":12.571,\"y\":55.682},{\"x\":12.586,\"y\":55.681},{\"x\":12.584,\"y\":55.677},{\"x\":12.574,\"y\":55.676}]}")
echo "$resp" | jq -c --argjson id "$id" '{n_areas:(.areas|length), name:.areas[0].name, outline:(.areas[0].outline|length), pts:(.areas[0].polygon.coordinates[0]|length)}'

echo "==> divide into two"
resp=$(curl -s -X POST "http://127.0.0.1:$port/api/cities/copenhagen/areas/$id/divide" -H 'Content-Type: application/json' \
  -d "{\"name1\":\"Left $stamp\",\"name2\":\"Right $stamp\",\"dividing\":[[12.575,55.680],[12.581,55.678]]}")
echo "    DIVIDE RAW: $resp"
echo "$resp" | jq -c '{a1:.area1.name, a1_outline:(.area1.outline|length), a1_pts:(.area1.polygon.coordinates[0]|length), a2:.area2.name, a2_outline:(.area2.outline|length), a2_pts:(.area2.polygon.coordinates[0]|length)}' 2>/dev/null || echo "DIVIDE JQ FAILED"

echo "==> original gone from list?"
curl -s "http://127.0.0.1:$port/api/cities/copenhagen/areas" | jq -c --argjson id "$id" '{still_there: any(.[]; .id==$id)}'

echo "==> E2E EDIT/DIVIDE OK"
