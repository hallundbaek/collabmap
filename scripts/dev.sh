#!/usr/bin/env bash
set -euo pipefail

# Entry point for `nix run .#dev`. Starts everything needed for development:
#   - provisions city OSRM datasets (first run only; needs network, can take a while)
#   - starts osrm-routed on :5000
#   - starts the Express backend on :4321 (serves /api and /a public area pages)
#   - starts the Vite dev server on :5173 (proxying /api and /a to the backend)

# code_root: where the immutable flake source copy lives (scripts, cities.json).
code_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# work_root: the writable repo the user invoked nix from (data + node_modules live here).
work_root="${WORK_ROOT:-$PWD}"

data_dir="$work_root/data"
cities_json="$code_root/server/cities.json"

export PORT="${PORT:-4321}"
export OSRM_PORT="${OSRM_PORT:-5000}"
export DATA_DIR="$data_dir"
OSRM_BASE="http://127.0.0.1:$OSRM_PORT"

osrm_backend="${osrm_backend:-}"
if [[ -z "$osrm_backend" ]]; then
  echo "error: osrm_backend not set (run via 'nix run .#dev')" >&2
  exit 1
fi

mkdir -p "$data_dir"

# 1. Install dependencies if missing
if [[ ! -d "$work_root/server/node_modules" ]]; then
  echo "==> installing server deps (npm)"
  (cd "$work_root/server" && npm install)
fi
if [[ ! -d "$work_root/web/node_modules" ]]; then
  echo "==> installing web deps (npm)"
  (cd "$work_root/web" && npm install)
fi

# 2. Provision datasets (idempotent; skipped when already built)
WORK_ROOT="$work_root" "$code_root/provisioning/build-all.sh"

# 3. Identify the OSRM dataset file to serve (single union-region dataset).
osrm_file="$data_dir/osrm/region.osrm"

if [[ ! -f "$osrm_file.hsgr" || ! -f "$osrm_file.datasource_names" ]]; then
  echo "error: OSRM region dataset missing ($osrm_file)." >&2
  echo "Run 'nix run .#provision' (or remove 'data/osrm' and re-run)." >&2
  exit 1
fi

# 4. Probe whether OSRM is already up (and routing) on the target port.
#    /nearest returns code "Ok" as soon as the graph is loaded (route pairs can 400).
PROBE="$OSRM_BASE/nearest/v1/foot/12.571,55.682?number=1"
if curl -s --max-time 1 "$PROBE" 2>/dev/null | grep -q Ok; then
  echo "==> osrm-routed already running on :$OSRM_PORT"
  OSRM_PID=""
else
  echo "==> starting osrm-routed (CH) region on :$OSRM_PORT"
  osrm-routed --algorithm ch --port "$OSRM_PORT" "$osrm_file" &
  OSRM_PID=$!
  # Wait until OSRM has loaded its MLD data before continuing.
  echo -n "==> waiting for OSRM to load"
  for _ in $(seq 1 60); do
    if curl -s --max-time 1 "$PROBE" 2>/dev/null | grep -q Ok; then
      echo "  ...ready"; break
    fi
    echo -n "."
    sleep 1
  done
fi

cleanup() {
  [[ -n "${OSRM_PID:-}" ]] && kill "$OSRM_PID" 2>/dev/null || true
}
trap cleanup EXIT

# 5. Start backend + frontend concurrently.
echo "==> starting backend on :$PORT"
(cd "$work_root/server" && exec node index.js) &
BACKEND_PID=$!

echo "==> starting vite dev server on :5173"
(cd "$work_root/web" && exec pnpm dev) &
VITE_PID=$!

cleanup_all() {
  kill "$BACKEND_PID" "$VITE_PID" ${OSRM_PID:+$OSRM_PID} 2>/dev/null || true
}
trap cleanup_all EXIT INT TERM

echo ""
echo "Collaborative map running:"
echo "  Frontend   http://localhost:5173"
echo "  Backend    http://localhost:${PORT}"
echo "  OSRM       http://localhost:${OSRM_PORT}"

# Print the admin link (token is created by the backend on startup).
for _ in $(seq 1 20); do
  admin_token="$(cd "$work_root/server" && node -e "try{const D=require('better-sqlite3');const db=new D('$data_dir/collabmap.db');console.log((db.prepare(\"SELECT value FROM settings WHERE key='admin_token'\").get()||{}).value||'')}catch(e){}" 2>/dev/null)"
  [[ -n "$admin_token" ]] && break
  sleep 0.3
done
echo "  Admin      http://localhost:5173/admin/${admin_token:-<see backend log>}"
echo "Press Ctrl+C to stop."
wait