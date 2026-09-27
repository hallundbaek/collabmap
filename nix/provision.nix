{
  writeShellApplication,
  osrm-backend,
  osmium-tool,
  curl,
  jq,
  coreutils,
}:

# Provisions OSRM (foot) datasets for every city in $CITIES_FILE into $DATA_DIR.
writeShellApplication {
  name = "collabmap-provision";
  runtimeInputs = [ osrm-backend osmium-tool curl jq coreutils ];
  text = ''
    set -euo pipefail
    : "''${DATA_DIR:?DATA_DIR is required}"
    : "''${CITIES_FILE:?CITIES_FILE is required}"

    profile="${osrm-backend}/share/osrm/profiles/foot.lua"
    mkdir -p "$DATA_DIR/pbf"

    count="$(jq 'length' "$CITIES_FILE")"
    i=0
    while [ "$i" -lt "$count" ]; do
      slug="$(jq -r ".[$i].slug" "$CITIES_FILE")"
      url="$(jq -r ".[$i].pbf_url" "$CITIES_FILE")"
      bbox="$(jq -r ".[$i].bbox | join(\",\")" "$CITIES_FILE")"
      city_dir="$DATA_DIR/cities/$slug"
      osrm="$city_dir/$slug.osrm"
      mkdir -p "$city_dir"

      if [ -f "$osrm.hsgr" ]; then
        echo "collabmap: $slug already provisioned"
        i=$((i + 1)); continue
      fi

      pbf="$DATA_DIR/pbf/$(basename "$url")"
      if [ ! -f "$pbf" ]; then
        echo "collabmap: downloading $url"
        curl -L --fail --retry 3 -o "$pbf.tmp" "$url"
        mv "$pbf.tmp" "$pbf"
      fi

      clipped="$city_dir/$slug.osm.pbf"
      if [ ! -f "$clipped" ]; then
        echo "collabmap: clipping $slug to [$bbox]"
        osmium extract -b "$bbox" "$pbf" -o "$clipped"
      fi

      if [ ! -f "$osrm.datasource_names" ]; then
        echo "collabmap: osrm-extract $slug"
        osrm-extract -p "$profile" "$clipped"
      fi
      if [ ! -f "$osrm.hsgr" ]; then
        echo "collabmap: osrm-contract $slug"
        osrm-contract "$osrm"
      fi

      i=$((i + 1))
    done
    echo "collabmap: provisioning complete"
  '';
}
