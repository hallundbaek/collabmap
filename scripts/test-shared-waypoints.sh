#!/usr/bin/env bash
set -euo pipefail
# Tests shared waypoints: create-sharing, moving a shared waypoint affecting
# multiple areas, and divide producing waypoints shared by both new areas.
# Boots OSRM + backend, runs assertions, tears down.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port=4331
osrm_file="$root/data/cities/copenhagen/copenhagen.osrm"
data="${CM_TEST_DATA:-/tmp/cm-test-test-shared-waypoints}"
rm -rf "$data"; mkdir -p "$data"
export ADMIN_TOKEN=testadmintoken
export CURL_HOME="$(mktemp -d)"
printf 'header = "x-admin-token: %s"\n' "$ADMIN_TOKEN" > "$CURL_HOME/.curlrc"

osrm-routed --algorithm ch --port 5099 "$osrm_file" >/tmp/osrm-shared.log 2>&1 &
OSRM_PID=$!
(cd "$root/server" && exec env DATA_DIR="$data" OSRM_PORT=5099 PORT="$port" node index.js >/tmp/be-shared.log 2>&1) &
BACK_PID=$!
cleanup(){ kill "$BACK_PID" "$OSRM_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 25); do curl -s --max-time 1 "http://127.0.0.1:$port/api/cities" >/dev/null 2>&1 && break; sleep 0.5; done
for i in $(seq 1 20); do curl -s --max-time 1 "http://127.0.0.1:5099/nearest/v1/foot/12.571,55.682?number=1" | grep -q Ok && break; sleep 0.5; done

base="http://127.0.0.1:$port/api/cities/copenhagen"
stamp=$(date +%s)
fail=0

# shared corner: P1 and P2 appear in both areas
P1="12.571,55.682"; P2="12.585,55.681"; P4="12.573,55.676"

echo "==> create A1"
a1=$(curl -s -X POST "$base/areas" -H 'Content-Type: application/json' \
  -d "{\"name\":\"A1 $stamp\",\"outline\":[{\"x\":12.571,\"y\":55.682},{\"x\":12.585,\"y\":55.681},{\"x\":12.584,\"y\":55.677},{\"x\":12.573,\"y\":55.676}]}")
a1_id=$(echo "$a1" | jq -r .id)
echo "    a1_id=$a1_id outline=$(echo "$a1"|jq '.outline|length')"

echo "==> create A2 sharing P1,P2,P4 coords"
a2=$(curl -s -X POST "$base/areas" -H 'Content-Type: application/json' \
  -d "{\"name\":\"A2 $stamp\",\"outline\":[{\"x\":12.571,\"y\":55.682},{\"x\":12.585,\"y\":55.681},{\"x\":12.587,\"y\":55.680},{\"x\":12.579,\"y\":55.677},{\"x\":12.573,\"y\":55.676}]}")
a2_id=$(echo "$a2" | jq -r .id)
echo "    a2_id=$a2_id"

# find waypoint id at P1 in each area
wid_a1=$(echo "$a1" | jq -r --arg x "${P1%,*}" --arg y "${P1#*,}" '.outline as $o | ($o|map(select((((.x - ($x|tonumber))|fabs) < 0.0002) and (((.y - ($y|tonumber))|fabs) < 0.0002)))[0].id)')
wid_a2=$(echo "$a2" | jq -r --arg x "${P1%,*}" --arg y "${P1#*,}" '.outline as $o | ($o|map(select((((.x - ($x|tonumber))|fabs) < 0.0002) and (((.y - ($y|tonumber))|fabs) < 0.0002)))[0].id)')
echo "    P1 id in A1=$wid_a1  in A2=$wid_a2"
if [ "$wid_a1" = "$wid_a2" ] && [ "$wid_a1" != "null" ]; then
  echo "    PASS: waypoint shared across areas"
else
  echo "    FAIL: waypoint not shared"; fail=1
fi
shared_wp="$wid_a1"

echo "==> edit A1: move shared waypoint $shared_wp"
points=$(echo "$a1" | jq -c ".outline | map(if .id == $shared_wp then .x=(.x+0.0005) else . end)")
put=$(curl -s -X PUT "$base/areas/$a1_id" -H 'Content-Type: application/json' -d "{\"points\":$points}")
n_affected=$(echo "$put" | jq '.areas|length')
echo "    affected areas returned: $n_affected (expect >=2)"
ids=$(echo "$put" | jq -c '[.areas[].id]')
echo "    ids: $ids"
if echo "$ids" | grep -q "$a2_id"; then echo "    PASS: moving shared waypoint also updated A2"; else echo "    FAIL: A2 not updated when shared waypoint moved"; fail=1; fi

echo "==> verify shared waypoint moved in A2 too"
newx=$(echo "$put" | jq -r --argjson w "$shared_wp" '.areas[] | select(.id=='"$a2_id"') | .outline[] | select(.id==$w) | .x')
echo "    new x of shared wp in A2 = $newx (was ${P1%,*})"
[ -n "$newx" ] && [ "$newx" != "${P1%,*}" ] && echo "    PASS: A2 reflects moved shared waypoint" || { echo "    FAIL: A2 waypoint not moved"; fail=1; }

echo "==> divide A2 with an interior point (should be shared waypoint in both)"
dv=$(curl -s -X POST "$base/areas/$a2_id/divide" -H 'Content-Type: application/json' \
  -d "{\"name1\":\"L $stamp\",\"name2\":\"R $stamp\",\"dividing\":[[12.585,55.680],[12.582,55.679],[12.579,55.677]]}")
d1=$(echo "$dv" | jq -r .area1.id); d2=$(echo "$dv" | jq -r .area2.id)
echo "    area1=$d1 area2=$d2"
# interior divide point 12.582,55.679 present in both
ia=$(echo "$dv" | jq -r --arg x 12.582 --arg y 55.679 '.area1.outline[] | select((((.x-($x|tonumber))|fabs) < 0.0002) and (((.y-($y|tonumber))|fabs) < 0.0002)) | .id')
ib=$(echo "$dv" | jq -r --arg x 12.582 --arg y 55.679 '.area2.outline[] | select((((.x-($x|tonumber))|fabs) < 0.0002) and (((.y-($y|tonumber))|fabs) < 0.0002)) | .id')
echo "    interior divide pt id in area1=$ia  in area2=$ib"
if [ -n "$ia" ] && [ "$ia" = "$ib" ] && [ "$ia" != "null" ]; then
  echo "    PASS: divide point is a shared waypoint in both areas"
else
  echo "    FAIL: divide point not shared"; fail=1
fi

echo "==> original A2 gone?"
left=$(curl -s "$base/areas" | jq --argjson id "$a2_id" 'any(.[]; .id==$id)')
echo "    still present? $left (expect false)"
[ "$left" = "false" ] && echo "    PASS" || { echo "    FAIL"; fail=1; }

[ "$fail" = 0 ] && echo "==> ALL SHARED-WAYPOINT TESTS PASSED" || { echo "==> SOME TESTS FAILED"; exit 1; }
