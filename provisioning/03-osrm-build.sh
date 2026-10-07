#!/usr/bin/env bash
set -euo pipefail

# 03-osrm-build <data_dir> <osrm_backend_store_path>
# Builds the OSRM foot (CH) dataset for the clipped union region.

data_dir="$1"
osrm_backend="$2"

code_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
region_dir="$data_dir/osrm"
pbf="$region_dir/region.osm.pbf"
osrm="$region_dir/region.osrm"

# Assemble a profile dir: our distance-weight foot.lua next to OSRM's bundled lib.
# Recreate it every time: the copied lib comes from the read-only Nix store, so a
# stale copy would make `cp -r` fail (and nest into lib/lib).
profdir="$region_dir/profile"
if [[ -e "$profdir" ]]; then
  chmod -R u+w "$profdir" 2>/dev/null || true
  rm -rf "$profdir"
fi
mkdir -p "$profdir"
cp -r "$osrm_backend/share/osrm/profiles/lib" "$profdir/lib"
cp "$code_root/nix/osrm/foot.lua" "$profdir/foot.lua"
profile="$profdir/foot.lua"

if [[ ! -f "$pbf" ]]; then
  echo "error: missing $pbf (run 02-clip first)" >&2
  exit 1
fi

if [[ ! -f "$osrm.datasource_names" ]]; then
  echo "    osrm-extract region (foot, distance weight)"
  osrm-extract -p "$profile" -d osmosis "$pbf"
else
  echo "    osrm-extract: already present"
fi

if [[ ! -f "$osrm.hsgr" ]]; then
  echo "    osrm-contract region (CH)"
  osrm-contract "$osrm"
else
  echo "    osrm-contract: already present"
fi