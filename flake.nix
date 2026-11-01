{
  description = "proton-drive-mount: serve Proton Drive over local WebDAV through the official Proton Drive SDK";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        proton-drive-mount = pkgs.callPackage ./nix/package.nix {
          # The revision the binary names in --version. `rev` is set for a
          # clean tree, `dirtyRev` for a dirty one.
          revision = self.rev or self.dirtyRev or "unknown";
        };
        default = proton-drive-mount;
      });

      apps = forAllSystems (pkgs: rec {
        proton-drive-mount = {
          type = "app";
          program = "${self.packages.${pkgs.system}.proton-drive-mount}/bin/proton-drive-mount";
        };
        default = proton-drive-mount;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.rclone
          ];
          shellHook = ''
            echo "proton-drive-mount dev shell: bun $(bun --version), $(rclone version | head -n1)"
            echo "Run: bun install && bun test"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
