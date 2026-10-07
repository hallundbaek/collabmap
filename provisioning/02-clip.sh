#!/usr/bin/env bash
set -euo pipefail

# 02-clip <cities.json> <data_dir>
# Clips the region PBF to the UNION of all cities' bboxes -> data/osrm/region.osm.pbf.

cities_json="$1"
data_dir="$2"

pbf_url="$(jq -r '.[0].pbf_url' "$cities_json")"
src_pbf="$data_dir/pbf/$(basename "$pbf_url")"
out_dir="$data_dir/osrm"
out_pbf="$out_dir/region.osm.pbf"

bbox="$(jq -r 'map(.bbox) | [ (map(.[0])|min), (map(.[1])|min), (map(.[2])|max), (map(.[3])|max) ] | join(",")' "$cities_json")"

mkdir -p "$out_dir"

if [[ -f "$out_pbf" ]]; then
  echo "    clip present: $out_pbf"
  exit 0
fi

echo "    clipping region to union bbox [$bbox]"
osmium extract -b "$bbox" "$src_pbf" -o "$out_pbf"
echo "    saved $out_pbf"