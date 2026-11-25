{
  description = "protium-drive: an unofficial third-party client, not supported by Proton, that serves Proton Drive over local WebDAV through the Proton Drive SDK";

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
        protium-drive = pkgs.callPackage ./nix/package.nix {
          # The revision the binary names in --version. `rev` is set for a
          # clean tree, `dirtyRev` for a dirty one.
          revision = self.rev or self.dirtyRev or "unknown";
        };
        default = protium-drive;
        # The name before the rename to protium-drive (#143), kept so that
        # consumers that pin this output still build. Prefer `protium-drive`.
        proton-drive-mount = protium-drive;
      });

      apps = forAllSystems (pkgs: rec {
        protium-drive = {
          type = "app";
          program = "${self.packages.${pkgs.system}.protium-drive}/bin/protium-drive";
        };
        default = protium-drive;
        # The name before the rename to protium-drive (#143).
        proton-drive-mount = protium-drive;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.rclone
          ];
          shellHook = ''
            echo "protium-drive dev shell: bun $(bun --version), $(rclone version | head -n1)"
            echo "Run: bun install && bun test"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
