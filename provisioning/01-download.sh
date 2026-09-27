#!/usr/bin/env bash
set -euo pipefail

# 01-download <cities.json> <data_dir> <index>
# Downloads the region PBF referenced by city[index].pbf_url into data/pbf/.

cities_json="$1"
data_dir="$2"
i="$3"

pbf_url="$(jq -r ".[$i].pbf_url" "$cities_json")"
slug="$(jq -r ".[$i].slug" "$cities_json")"
pbf_dir="$data_dir/pbf"

mkdir -p "$pbf_dir"

# Derive a local filename from the URL basename (e.g. denmark-latest.osm.pbf)
file_name="$(basename "$pbf_url")"
target="$pbf_dir/$file_name"

if [[ -f "$target" ]]; then
  echo "    pbf present: $target"
  exit 0
fi

echo "    downloading $pbf_url"
curl -L --fail --retry 3 -o "$target.tmp" "$pbf_url"
mv "$target.tmp" "$target"
echo "    saved to $target"