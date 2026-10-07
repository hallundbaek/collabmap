{
  description = "Collaborative map for partitioning cities into responsibility areas";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }: let
    systems = [ "x86_64-linux" "aarch64-linux" ];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
      inherit system;
      pkgs = nixpkgs.legacyPackages.${system};
    });

    tools = pkgs: with pkgs; [
      nodejs_22
      pnpm
      osrm-backend
      osmium-tool
      jq
      curl
      bash
      coreutils
      gnused
      gawk
      findutils
    ];
  in {
    packages = forAllSystems ({ pkgs, system }: let
      server = pkgs.callPackage ./nix/server.nix { };
      web = pkgs.callPackage ./nix/web.nix { };
      collabmap = pkgs.runCommand "collabmap-0.1.0" { } ''
        mkdir -p $out/bin $out/share/collabmap
        cp -r ${server}/bin/. $out/bin/
        cp -r ${web} $out/share/collabmap/web
      '';
    in {
      inherit server web collabmap;
      default = collabmap;
    });

    devShells = forAllSystems ({ pkgs, system }: {
      default = pkgs.mkShell {
        packages = tools pkgs;
        shellHook = ''
          export osrm_backend="${pkgs.osrm-backend}"
        '';
      };
    });

    apps = forAllSystems ({ pkgs, system }: let
      flakeDir = ./.;
      devApp = pkgs.writeShellScriptBin "collabmap-dev" ''
        export PATH=${nixpkgs.lib.escapeShellArg (nixpkgs.lib.makeBinPath (tools pkgs))}:$PATH
        export osrm_backend=${pkgs.osrm-backend}
        export WORK_ROOT="$PWD"
        exec bash ${flakeDir}/scripts/dev.sh "$@"
      '';
      provisionApp = pkgs.writeShellScriptBin "collabmap-provision-dev" ''
        export PATH=${nixpkgs.lib.escapeShellArg (nixpkgs.lib.makeBinPath (tools pkgs))}:$PATH
        export osrm_backend=${pkgs.osrm-backend}
        export WORK_ROOT="$PWD"
        exec bash ${flakeDir}/provisioning/build-all.sh "$@"
      '';
    in {
      default = { type = "app"; program = "${devApp}/bin/collabmap-dev"; };
      dev = { type = "app"; program = "${devApp}/bin/collabmap-dev"; };
      provision = { type = "app"; program = "${provisionApp}/bin/collabmap-provision-dev"; };
    });

    nixosModules = {
      collabmap = import ./nix/module.nix { inherit self; };
      default = self.nixosModules.collabmap;
    };
  };
}
