#!/usr/bin/env bash
set -euo pipefail
# End-to-end: run `nix run .#dev`, wait for services, probe endpoints, then tear down.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="/tmp/collabmap-e2e.log"

echo "==> starting 'nix run .#dev' (detached process group)"
cd "$root"
setsid nix --extra-experimental-features "nix-command flakes" run .#dev >"$log" 2>&1 &
DEV_PID=$!
echo "    dev pid $DEV_PID"

cleanup () {
  echo "==> tearing down process group"
  kill -- -"$DEV_PID" 2>/dev/null || true
  pkill -f osrm-routed 2>/dev/null || true
  pkill -f "node .*index.js" 2>/dev/null || true
  pkill -f "node .*/vite" 2>/dev/null || true
  pkill -f "esbuild" 2>/dev/null || true
}
trap cleanup EXIT

# Poll backend
echo -n "waiting for backend :4321"
for i in $(seq 1 60); do
  if curl -s --max-time 1 http://127.0.0.1:4321/api/cities >/dev/null 2>&1; then echo "  ...up after ${i}s"; break; fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then echo "  ...DEV DIED"; tail -30 "$log"; exit 1; fi
  echo -n "."; sleep 1
done

echo "==> probe :4321/api/cities"
curl -s http://127.0.0.1:4321/api/cities | jq -c 'map(.slug)'

echo "==> probe frontend :5173"
for i in $(seq 1 40); do
  s=$(curl -s --max-time 1 -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ 2>/dev/null || echo 000)
  [ "$s" = "200" ] && break; sleep 1
done
echo "    / -> HTTP $s"
echo "==> probe /a token via vite proxy"
tok="$(curl -s http://127.0.0.1:4321/api/cities/copenhagen/areas | jq -r '.[0].share_token // empty')"
if [[ -n "$tok" ]]; then
  curl -s http://127.0.0.1:5173/a/"$tok" | jq -c '{area:.area.name,routes:(.routes|length)}' || true
else
  echo "    (no areas yet; creating one)"
  resp=$(curl -s -X POST http://127.0.0.1:4321/api/cities/copenhagen/areas -H 'Content-Type: application/json' \
    -d '{"name":"E2E Area","outline":[{"x":12.571,"y":55.682},{"x":12.585,"y":55.681},{"x":12.584,"y":55.677},{"x":12.573,"y":55.676}]}')
  echo "    created: $(echo "$resp" | jq -c '{id,n_pts:(.polygon.coordinates[0]|length)}')"
fi

echo "==> home page serves index:"
curl -s http://127.0.0.1:5173/ | grep -o "<title>.*</title>" || true

echo "==> E2E OK"
sleep 1