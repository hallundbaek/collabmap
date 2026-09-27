{
  lib,
  buildNpmPackage,
  nodejs_22,
}:

buildNpmPackage rec {
  pname = "collabmap-web";
  version = "0.1.0";

  src = lib.cleanSource ../web;

  nodejs = nodejs_22;
  npmDepsHash = "sha256-050QSIPu/XVNHnhaqZOet/RYsruXKP/Som4Vei2Nlwo=";

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/. $out/
    runHook postInstall
  '';

  meta = with lib; {
    description = "CollabMap web frontend (React + MapLibre)";
    license = licenses.mit;
  };
}
