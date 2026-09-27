#!/usr/bin/env bash
set -euo pipefail

# 02-clip <cities.json> <data_dir> <index>
# Clips the downloaded region PBF to city[index]'s bounding box and places a
# per-city <slug>.osm.pbf under data/cities/<slug>/.

cities_json="$1"
data_dir="$2"
i="$3"

pbf_url="$(jq -r ".[$i].pbf_url" "$cities_json")"
slug="$(jq -r ".[$i].slug" "$cities_json")"
bbox="$(jq -r ".[$i].bbox | join(\",\")" "$cities_json")"

src_pbf="$data_dir/pbf/$(basename "$pbf_url")"
city_dir="$data_dir/cities/$slug"
out_pbf="$city_dir/$slug.osm.pbf"

mkdir -p "$city_dir"

if [[ -f "$out_pbf" ]]; then
  echo "    clip present: $out_pbf"
  exit 0
fi

echo "    clipping $slug to bbox [$bbox]"
osmium extract -b "$bbox" "$src_pbf" -o "$out_pbf"
echo "    saved $out_pbf"