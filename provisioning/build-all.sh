#!/usr/bin/env bash
set -euo pipefail

# Orchestrates the full data pipeline for every city declared in server/cities.json.
# Outputs live under data/cities/<slug>/ and a city is considered provisioned when
# data/cities/<slug>/<slug>.osrm.datasource_names exists.

# code_root: immutable flake source copy (holds server/cities.json + sibling scripts)
code_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# work_root: writable repo the user invoked nix from (data lives here)
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

count="$(jq 'length' "$cities_json")"
for ((i=0; i<count; i++)); do
  slug="$(jq -r ".[$i].slug" "$cities_json")"
  echo "==> provisioning city: $slug"
  bash "$code_root/provisioning/01-download.sh" "$cities_json" "$data_dir" "$i"
  bash "$code_root/provisioning/02-clip.sh" "$cities_json" "$data_dir" "$i"
  bash "$code_root/provisioning/03-osrm-build.sh" "$data_dir" "$slug" "$osrm_backend"
  echo "==> done: $slug"
done
echo "All cities provisioned."