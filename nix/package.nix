{
  lib,
  stdenvNoCC,
  bun,
  makeWrapper,
}:

let
  packageJson = lib.importJSON ../package.json;
  version = packageJson.version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../tsconfig.json
      ../patches
      ../src
      ../vendor
    ];
  };

  # Production dependencies from bun.lock, with the patches in patches/ applied.
  # Fixed-output: update `outputHash` when bun.lock changes (build once with
  # lib.fakeHash and copy the hash from the error).
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "proton-drive-mount-node-modules";
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
    outputHash = "sha256-IzXKromFcBmAyLIedCnu9nBYBOTKcNEBxKdlhSlqV08=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "proton-drive-mount";
  inherit version src;
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    app=$out/lib/proton-drive-mount
    mkdir -p $app $out/bin
    cp -R package.json tsconfig.json src vendor $app/
    ln -s ${nodeModules}/node_modules $app/node_modules
    makeWrapper ${lib.getExe bun} $out/bin/proton-drive-mount --add-flags "$app/src/main.ts"
    runHook postInstall
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "Serve Proton Drive over local WebDAV through the official Proton Drive SDK";
    license = lib.licenses.mit;
    mainProgram = "proton-drive-mount";
    platforms = bun.meta.platforms;
  };
}
