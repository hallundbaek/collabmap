#!/usr/bin/env bash
set -euo pipefail

# 01-download <cities.json> <data_dir>
# Downloads the shared region PBF (from the first city's pbf_url).

cities_json="$1"
data_dir="$2"

pbf_url="$(jq -r '.[0].pbf_url' "$cities_json")"
pbf_dir="$data_dir/pbf"
target="$pbf_dir/$(basename "$pbf_url")"

mkdir -p "$pbf_dir"

if [[ -f "$target" ]]; then
  echo "    pbf present: $target"
  exit 0
fi

echo "    downloading $pbf_url"
curl -L --fail --retry 3 -o "$target.tmp" "$pbf_url"
mv "$target.tmp" "$target"
echo "    saved to $target"