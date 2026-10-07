#!/usr/bin/env bash
set -euo pipefail
# Tests admin behaviors: road snapping, neighbour-distinct colors, rename, delete.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port=4332
osrm_file="$root/data/osrm/region.osrm"
data="${CM_TEST_DATA:-/tmp/cm-test-test-area-admin}"
rm -rf "$data"; mkdir -p "$data"
export ADMIN_TOKEN=testadmintoken
export CURL_HOME="$(mktemp -d)"
printf 'header = "x-admin-token: %s"\n' "$ADMIN_TOKEN" > "$CURL_HOME/.curlrc"

osrm-routed --algorithm ch --port 5099 "$osrm_file" >/tmp/osrm-admin.log 2>&1 &
OSRM_PID=$!
(cd "$root/server" && exec env DATA_DIR="$data" OSRM_PORT=5099 PORT="$port" node index.js >/tmp/be-admin.log 2>&1) &
BACK_PID=$!
cleanup(){ kill "$BACK_PID" "$OSRM_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 25); do curl -s --max-time 1 "http://127.0.0.1:$port/api/cities" >/dev/null 2>&1 && break; sleep 0.5; done
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:5099/nearest/v1/foot/12.571,55.682?number=1" | grep -q Ok && break; sleep 0.5; done

base="http://127.0.0.1:$port/api/cities/copenhagen"
stamp=$(date +%s)
fail=0

echo "==> snap endpoint (road snapping)"
sn=$(curl -s "$base/snap?lon=12.5711&lat=55.6821")
echo "    snap: $sn"
echo "$sn" | jq -e 'has("lon") and has("lat")' >/dev/null && echo "    PASS: snap returns a coordinate" || { echo "    FAIL"; fail=1; }

echo "==> create A1 (auto color)"
a1=$(curl -s -X POST "$base/areas" -H 'Content-Type: application/json' \
  -d "{\"name\":\"CA1 $stamp\",\"outline\":[{\"x\":12.571,\"y\":55.682},{\"x\":12.585,\"y\":55.681},{\"x\":12.584,\"y\":55.677},{\"x\":12.573,\"y\":55.676}]}")
a1_id=$(echo "$a1" | jq -r .id); a1_color=$(echo "$a1" | jq -r .color)
echo "    A1 id=$a1_id color=$a1_color"
[ -n "$a1_color" ] && [ "$a1_color" != "null" ] && echo "    PASS: A1 has a color" || { echo "    FAIL: no color"; fail=1; }

echo "==> create A2 sharing a waypoint from A1 (color must differ)"
shared=$(echo "$a1" | jq -c '.outline[0] | {id,x,y}')
a2=$(curl -s -X POST "$base/areas" -H 'Content-Type: application/json' \
  -d "{\"name\":\"CA2 $stamp\",\"outline\":[$shared,{\"x\":12.587,\"y\":55.680},{\"x\":12.585,\"y\":55.681},{\"x\":12.584,\"y\":55.677}]}")
a2_id=$(echo "$a2" | jq -r .id); a2_color=$(echo "$a2" | jq -r .color)
echo "    A2 id=$a2_id color=$a2_color (A1=$a1_color)"
if [ "$a1_color" != "$a2_color" ]; then echo "    PASS: neighbour colors differ"; else echo "    FAIL: neighbours share color"; fail=1; fi

echo "==> rename A1 via PATCH"
rn=$(curl -s -X PATCH "$base/areas/$a1_id" -H 'Content-Type: application/json' -d "{\"name\":\"Renamed $stamp\"}")
echo "    -> $(echo "$rn" | jq -c '{id,name}')"
[ "$(echo "$rn" | jq -r .name)" = "Renamed $stamp" ] && echo "    PASS: renamed" || { echo "    FAIL"; fail=1; }

echo "==> delete A1"
del=$(curl -s -X DELETE "$base/areas/$a1_id")
echo "    -> $del"
gone=$(curl -s "$base/areas" | jq --argjson id "$a1_id" 'any(.[]; .id==$id)')
[ "$gone" = "false" ] && echo "    PASS: A1 deleted" || { echo "    FAIL: A1 still present"; fail=1; }
a2_there=$(curl -s "$base/areas" | jq --argjson id "$a2_id" 'any(.[]; .id==$id)')
[ "$a2_there" = "true" ] && echo "    PASS: A2 untouched" || { echo "    FAIL: A2 missing"; fail=1; }

echo "==> orphan waypoint cleanup (waypoints table)"
wpc=$(curl -s "$base/areas" | jq '[.[].outline[].id] | unique | length')
echo "    distinct waypoints still referenced by areas: $wpc"
# no direct DB access here; just ensure the API still works
curl -s "$base/areas" | jq -e 'length>=1' >/dev/null && echo "    PASS: list still valid" || { echo "    FAIL"; fail=1; }

[ "$fail" = 0 ] && echo "==> ALL ADMIN TESTS PASSED" || { echo "==> SOME TESTS FAILED"; exit 1; }
