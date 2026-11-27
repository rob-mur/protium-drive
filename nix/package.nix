{
  lib,
  stdenvNoCC,
  bun,
  makeWrapper,
  glib,
  libsecret,
  rclone,
  # The git revision this build was made from; --version names it.
  revision ? "unknown",
}:

let
  packageJson = lib.importJSON ../package.json;
  version = packageJson.version;

  # A continuous-delivery release archive (`source.tar.gz` on each release)
  # holds `.cd-release.json`: {"version", "commit", "committed_at"}. A build
  # from the archive gives that version, commit and date to --version. A build
  # from a git checkout has no stamp and gives `revision` alone.
  stampFile = ../.cd-release.json;
  stamp = if builtins.pathExists stampFile then lib.importJSON stampFile else null;
  stampWrapperFlags = lib.optionalString (stamp != null) (
    lib.escapeShellArgs [
      "--set"
      "PDM_BUILD_VERSION"
      stamp.version
      "--set"
      "PDM_BUILD_DATE"
      (builtins.substring 0 10 stamp.committed_at)
    ]
  );
  buildRevision = if stamp != null then stamp.commit else revision;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../tsconfig.json
      ../patches
      ../src
      # `--fake-drive` runs the Receive arm from the product, so the package
      # ships it beside src/ (src/proton/connect.ts imports it).
      ../fake-drive
      ../vendor
    ];
  };

  # Production dependencies from bun.lock, with the patches in patches/ applied.
  # Fixed-output: update `outputHash` when bun.lock or patches/ change (build once with
  # lib.fakeHash and copy the hash from the error).
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "protium-drive-node-modules";
    inherit version src;
    nativeBuildInputs = [ bun ];
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --production --ignore-scripts --no-progress
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/
      runHook postInstall
    '';
    dontFixup = true;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-1y8aIO6T97mIgKJlUyUjS2/NB+/XT0cjmCTMjOgFz+s=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "protium-drive";
  inherit version src;
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    app=$out/lib/protium-drive
    mkdir -p $app $out/bin
    cp -R package.json tsconfig.json src fake-drive vendor $app/
    ln -s ${nodeModules}/node_modules $app/node_modules
    makeWrapper ${lib.getExe bun} $out/bin/protium-drive \
      --set PDM_RCLONE ${lib.getExe rclone} \
      --set PDM_BUILD_REVISION ${lib.escapeShellArg buildRevision} ${stampWrapperFlags} \
      --prefix LD_LIBRARY_PATH : ${
        lib.makeLibraryPath [
          libsecret
          glib
        ]
      } \
      --add-flags "$app/src/main.ts"
    # The binary name before the rename to protium-drive (#143), kept so that
    # a consumer that runs bin/proton-drive-mount still works.
    ln -s protium-drive $out/bin/proton-drive-mount
    runHook postInstall
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "Unofficial third-party client, not supported by Proton, that serves Proton Drive over local WebDAV";
    license = lib.licenses.agpl3Only;
    mainProgram = "protium-drive";
    platforms = bun.meta.platforms;
  };
}
