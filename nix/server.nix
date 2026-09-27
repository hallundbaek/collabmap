{
  lib,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
}:

buildNpmPackage rec {
  pname = "collabmap-server";
  version = "0.1.0";

  src = lib.cleanSource ../server;

  nodejs = nodejs_22;
  npmDepsHash = "sha256-n26/AfmjVYe1cgRswNadFFxGEAJW3C8CsuiyRhfVUmk=";
  dontNpmBuild = true;

  nativeBuildInputs = [ python3 makeWrapper ];

  # better-sqlite3 is a native module; build it from source (no network prebuilds).
  env = {
    npm_config_build_from_source = "true";
  };

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/collabmap $out/bin
    cp -r . $out/lib/collabmap
    makeWrapper ${nodejs_22}/bin/node $out/bin/collabmap-server \
      --add-flags "$out/lib/collabmap/index.js"
    runHook postInstall
  '';

  meta = with lib; {
    description = "CollabMap backend (Express + SQLite)";
    license = licenses.mit;
    mainProgram = "collabmap-server";
  };
}
