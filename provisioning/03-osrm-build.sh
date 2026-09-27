#!/usr/bin/env bash
set -euo pipefail

# 03-osrm-build <data_dir> <slug> <osrm_backend_store_path>
# Builds an OSRM dataset for a clipped city PBF using the bundled foot.lua
# profile. Uses the CH (contraction hierarchy) algorithm, which is robust for
# small city extracts (the MLD algorithm intermittently throws
# vector::_M_range_insert on this OSM data).

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_dir="$1"
slug="$2"
osrm_backend="$3"

city_dir="$data_dir/cities/$slug"
pbf="$city_dir/$slug.osm.pbf"
osrm="$city_dir/$slug.osrm"
profile="$osrm_backend/share/osrm/profiles/foot.lua"

if [[ ! -f "$pbf" ]]; then
  echo "error: missing $pbf (run 02-clip first)" >&2
  exit 1
fi

mkdir -p "$city_dir"

# osrm-extract generates <osrm>.datasource_names and the graph files.
if [[ ! -f "$osrm.datasource_names" ]]; then
  echo "    osrm-extract $slug (foot profile)"
  osrm-extract -p "$profile" "$pbf"
else
  echo "    osrm-extract: already present"
fi

# osrm-contract builds the CH graph (produces <osrm>.hsgr).
if [[ ! -f "$osrm.hsgr" ]]; then
  echo "    osrm-contract $slug (CH)"
  osrm-contract "$osrm"
else
  echo "    osrm-contract: already present"
fi