{ self }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types optional;
  cfg = config.services.collabmap;
  s = cfg.settings;

  # The region dataset is built at Nix build time and shipped to the host, so
  # the host never runs osmium/osrm-extract/osrm-contract.
  dataset = pkgs.callPackage ./dataset.nix {
    pbfUrl = s.region.pbfUrl;
    pbfHash = s.region.pbfHash;
    bbox = s.region.bbox;
  };
  osrmFile = "${dataset}/region.osrm";

  # The generated cities file is only used to seed the DB (groupings + map view).
  citiesJson = pkgs.writeText "collabmap-cities.json" (builtins.toJSON (map (c: {
    slug = c.slug;
    name = c.name;
    bbox = s.region.bbox;
    initial_center = c.initialCenter;
    initial_zoom = c.initialZoom;
  }) s.cities));
in
{
  options.services.collabmap = {
    enable = mkEnableOption "CollabMap collaborative city-partition map";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.system}.collabmap;
      defaultText = lib.literalExpression "collabmap flake package";
      description = "The CollabMap package (server + web).";
    };

    settings = mkOption {
      default = { };
      description = "CollabMap application settings.";
      type = types.submodule {
        options = {
          port = mkOption { type = types.port; default = 4321; description = "HTTP port for the web app."; };
          osrmPort = mkOption { type = types.port; default = 5000; description = "Port for the local OSRM server."; };
          osrmThreads = mkOption {
            type = types.nullOr types.int;
            default = null;
            description = "Cap osrm-routed worker threads (bounds RAM on constrained hosts).";
          };
          adminToken = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Fixed admin token. If null, one is generated and stored in the data dir.";
          };
          dataDir = mkOption {
            type = types.str;
            default = "/var/lib/collabmap";
            description = "Directory for the SQLite DB (the routing dataset lives in the Nix store).";
          };

          region = mkOption {
            description = "Routing coverage (union bbox) and the OSM extract it is built from.";
            default = { };
            type = types.submodule {
              options = {
                pbfUrl = mkOption {
                  type = types.str;
                  default = "https://download.geofabrik.de/europe/denmark-latest.osm.pbf";
                  description = "URL of the region OSM extract (pin a dated snapshot for stability).";
                };
                pbfHash = mkOption {
                  type = types.str;
                  default = "sha256-hOF0XUGC4TjZtCpMXKFKQboKKJJMqJms3teG/IusrRA=";
                  description = "SRI hash of the PBF. NOTE: Geofabrik '-latest' rolls daily — pin a dated snapshot (and its hash) for stability.";
                };
                bbox = mkOption {
                  type = types.listOf types.number;
                  default = [ 12.03 55.60 12.75 55.77 ];
                  description = "Union routing bbox [minLon minLat maxLon maxLat].";
                };
              };
            };
          };

          cities = mkOption {
            default = [
              { slug = "copenhagen"; name = "Copenhagen"; initialCenter = [ 12.568 55.676 ]; initialZoom = 12; }
            ];
            description = "Logical city groupings (areas can be drawn anywhere in the region).";
            type = types.listOf (types.submodule {
              options = {
                slug = mkOption { type = types.str; };
                name = mkOption { type = types.str; };
                initialCenter = mkOption { type = types.listOf types.number; };
                initialZoom = mkOption { type = types.number; default = 12; };
              };
            });
          };
        };
      };
    };
  };

  config = mkIf cfg.enable {
    users.groups.collabmap = { };
    users.users.collabmap = {
      isSystemUser = true;
      group = "collabmap";
      home = s.dataDir;
      description = "CollabMap service user";
    };

    systemd.tmpfiles.rules = [ "d ${s.dataDir} 0750 collabmap collabmap -" ];

    systemd.services.collabmap-osrm = {
      description = "CollabMap OSRM (foot) routing server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = "collabmap";
        Group = "collabmap";
        ExecStart = "${pkgs.osrm-backend}/bin/osrm-routed --algorithm ch "
          + lib.optionalString (s.osrmThreads != null) "--threads ${toString s.osrmThreads} "
          + "${osrmFile}";
        Restart = "on-failure";
        RestartSec = 2;
      };
    };

    systemd.services.collabmap = {
      description = "CollabMap web application";
      after = [ "collabmap-osrm.service" ];
      requires = [ "collabmap-osrm.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = "collabmap";
        Group = "collabmap";
        Environment = [
          "PORT=${toString s.port}"
          "OSRM_PORT=${toString s.osrmPort}"
          "DATA_DIR=${s.dataDir}"
          "CITIES_FILE=${citiesJson}"
          "WEB_DIST=${cfg.package}/share/collabmap/web"
        ] ++ optional (s.adminToken != null) "ADMIN_TOKEN=${s.adminToken}";
        ExecStart = "${cfg.package}/bin/collabmap-server";
        Restart = "on-failure";
        RestartSec = 2;
      };
    };
  };
}
