#!/usr/bin/env bash
set -euo pipefail

# Builds ONE OSRM dataset covering the union bounding box of every city in
# server/cities.json, at data/osrm/region.osrm. A city is only a logical
# grouping; routing coverage is the union of all cities' bboxes.

code_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_root="${WORK_ROOT:-$PWD}"
cities_json="$code_root/server/cities.json"
data_dir="$work_root/data"

osrm_backend="${osrm_backend:-}"
if [[ -z "$osrm_backend" ]]; then
  echo "error: osrm_backend not set (run via 'nix run .#provision')" >&2
  exit 1
fi
if [[ ! -f "$cities_json" ]]; then
  echo "error: missing $cities_json" >&2
  exit 1
fi

mkdir -p "$data_dir/osrm"

bash "$code_root/provisioning/01-download.sh" "$cities_json" "$data_dir"
bash "$code_root/provisioning/02-clip.sh" "$cities_json" "$data_dir"
bash "$code_root/provisioning/03-osrm-build.sh" "$data_dir" "$osrm_backend"

echo "Region dataset ready: $data_dir/osrm/region.osrm"