{
  lib,
  stdenv,
  fetchurl,
  osrm-backend,
  osmium-tool,
  # Region PBF (pinned) and the union bbox [minLon minLat maxLon maxLat].
  pbfUrl,
  pbfHash,
  bbox,
  name ? "region",
  # Distance-weight foot profile (shortest network path).
  profile ? ./osrm/foot.lua,
}:

let
  bboxStr = lib.concatStringsSep "," (map (x: toString x) bbox);
in
stdenv.mkDerivation {
  pname = "collabmap-osrm-${name}";
  version = "1";

  src = fetchurl {
    url = pbfUrl;
    hash = pbfHash;
  };

  nativeBuildInputs = [ osrm-backend osmium-tool ];

  dontUnpack = true;

  buildCommand = ''
    mkdir -p $out profiles
    cp -r ${osrm-backend}/share/osrm/profiles/lib profiles/lib
    cp ${profile} profiles/foot.lua
    chmod -R u+w profiles

    echo "clipping ${name} to [${bboxStr}]"
    osmium extract -b ${bboxStr} $src -o $out/${name}.osm.pbf

    echo "osrm-extract ${name}"
    osrm-extract -p "$PWD/profiles/foot.lua" -d osmosis --threads ''${NIX_BUILD_CORES:-1} $out/${name}.osm.pbf

    echo "osrm-contract ${name}"
    osrm-contract --threads ''${NIX_BUILD_CORES:-1} $out/${name}.osm

    rm -f $out/${name}.osm.pbf
  '';

  meta = with lib; {
    description = "OSRM foot (CH) routing dataset for ${name}";
    license = licenses.bsd2;
    platforms = platforms.linux;
  };
}
