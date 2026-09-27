{ self }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types optional optionalString;
  cfg = config.services.collabmap;
  s = cfg.settings;

  # The app/provisioning read the snake_case cities.json format; map the
  # camelCase Nix options onto it here so users only set `settings.cities`.
  citiesJson = pkgs.writeText "collabmap-cities.json" (builtins.toJSON (map (c: {
    slug = c.slug;
    name = c.name;
    pbf_url = c.pbfUrl;
    bbox = c.bbox;
    initial_center = c.initialCenter;
    initial_zoom = c.initialZoom;
  }) s.cities));
  firstSlug = if s.cities == [ ] then "" else (builtins.head s.cities).slug;
  osrmFile = "${s.dataDir}/cities/${firstSlug}/${firstSlug}.osrm";
in
{
  options.services.collabmap = {
    enable = mkEnableOption "CollabMap collaborative city-partition map";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.system}.collabmap;
      defaultText = lib.literalExpression "collabmap flake package";
      description = "The CollabMap package (server + web + provisioning).";
    };

    settings = mkOption {
      default = { };
      description = "CollabMap application settings.";
      type = types.submodule {
        options = {
          port = mkOption { type = types.port; default = 4321; description = "HTTP port for the web app."; };
          osrmPort = mkOption { type = types.port; default = 5000; description = "Port for the local OSRM server."; };
          adminToken = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Fixed admin token. If null, one is generated and stored in the data dir.";
          };
          dataDir = mkOption {
            type = types.str;
            default = "/var/lib/collabmap";
            description = "Directory for the SQLite DB and OSRM datasets.";
          };
          autoProvision = mkOption {
            type = types.bool;
            default = true;
            description = "Download OSM extracts and build the OSRM datasets on start.";
          };
          cities = mkOption {
            default = [
              {
                slug = "copenhagen";
                name = "Copenhagen";
                pbfUrl = "https://download.geofabrik.de/europe/denmark-latest.osm.pbf";
                bbox = [ 12.40 55.60 12.75 55.77 ];
                initialCenter = [ 12.568 55.676 ];
                initialZoom = 12;
              }
            ];
            description = "Cities to serve (each is provisioned and selectable in the admin).";
            type = types.listOf (types.submodule {
              options = {
                slug = mkOption { type = types.str; };
                name = mkOption { type = types.str; };
                pbfUrl = mkOption { type = types.str; };
                bbox = mkOption { type = types.listOf types.number; };
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

    systemd.services.collabmap-provision = mkIf s.autoProvision {
      description = "CollabMap OSRM dataset provisioning";
      wantedBy = [ "multi-user.target" ];
      before = [ "collabmap-osrm.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "collabmap";
        Group = "collabmap";
        StateDirectory = "collabmap";
        Environment = [
          "DATA_DIR=${s.dataDir}"
          "CITIES_FILE=${citiesJson}"
        ];
        ExecStart = "${cfg.package}/bin/collabmap-provision";
      };
    };

    systemd.services.collabmap-osrm = {
      description = "CollabMap OSRM (foot) routing server";
      after = [ "network.target" ] ++ optional s.autoProvision "collabmap-provision.service";
      requires = optional s.autoProvision "collabmap-provision.service";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = "collabmap";
        Group = "collabmap";
        ExecStart = "${pkgs.osrm-backend}/bin/osrm-routed --algorithm ch --port ${toString s.osrmPort} ${osrmFile}";
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
