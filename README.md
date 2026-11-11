# proton-drive-mount

Serve Proton Drive over local WebDAV through the official Proton Drive SDK, so stock
`rclone mount` can mount it.

> This is a third-party application not officially supported by Proton.
> It is not made, endorsed or reviewed by Proton AG, and it uses no Proton
> logos or design elements. **Proton may still limit or block an unknown
> client** at any time, even one that follows every rule below.

## Status

`main` holds a **skeleton**: the build plumbing and an entry point that starts, serves nothing
and exits. The product comes back one ticket at a time, each one scenario first, through
[cd-pipeline](https://forgejo.clarob.uk/rob/continuous-delivery).

The working prototype lives on the branch `prototype/webdav-mount` (`7bff71f`). It is the
behaviour reference for the tickets: its README describes `auth`, `serve`, the WebDAV methods,
the rclone settings and the manual live test. It never merges to `main`.

## Exit status

| Status | Meaning |
|--------|---------|
| 0 | Success. |
| 1 | An error. For example, another proton-drive-mount process holds the state directory: `auth login` and `auth logout` refuse while a `serve` or `mount` runs, and name its process id. |
| 2 | Usage error. |
| 3 | Needs login. `serve` or `mount` found no session, or Proton refused the stored session at the start or while it ran. Run `proton-drive-mount auth login`, then start it again. |
| 130 | Interrupted. |

A user service should not restart on 3: with systemd, set `RestartPreventExitStatus=3`.

## Rules every change keeps

From the [SDK README](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects):

- All Drive calls go through `@protontech/drive-sdk`; login and keys use Proton's account module,
  vendored unchanged in `vendor/`.
- The API host is Proton's official one, and nothing can change it.
- Every request identifies this client honestly:
  `x-pm-appversion: external-drive-protondrivemount@<version>-<channel>`. Never send a Proton or
  rclone client name, and never change the value to get around a block.
- Event-based sync, no recursive polling; back off on 429.
- `--help` and `auth login` print the third-party notice above.

No automated test reaches Proton. The suite runs against a fake Drive; a live test against a real
account is run by hand.

## Development

```sh
devenv shell                # bun, rclone, actionlint, and cd-pipeline's cd-run and built-ins
cd-run ci:commit            # what a merge request's ci:commit runs
```

| Path | Lane | What |
|---|---|---|
| `src/` | implementation | The product. Unit tests sit beside the code as `*.test.ts`. |
| `flake.nix`, `nix/`, `package.json`, `bun.lock`, `patches/`, `vendor/` | implementation | The build: what a consumer gets at a rev. |
| `spec/` | frozen | The acceptance suite: cucumber-js 13 under Bun. Features in `spec/features/`, the DSL layer (the `DriveWorld`) in `spec/steps/`, the Send arm in `spec/support/send/`. |
| `spec/frozen.lock.json` | frozen | Each scenario's expected status. |
| `fake-drive/` | frozen | The test-only Receive arm. |
| `cd-pipeline/`, `.forgejo/`, `tasks/`, `devenv.*` | pipeline | The pipeline: freeze manifest, release toolchain, workflows, verb tasks. |

`cd-pipeline/freeze-manifest.json` decides each path's lane, and the freeze gate refuses a
commit that touches two of frozen, implementation and pipeline.

Run one scenario against a built package:

```sh
nix build .#default
(cd spec && bun install)
PDM_BINARY=$PWD/result/bin/proton-drive-mount PDM_REVISION=$(git rev-parse HEAD) \
  bun spec/node_modules/.bin/cucumber-js --config spec/cucumber.mjs --tags '@id:binary-reports-its-revision'
```

## License

MIT; see `LICENSE`. `vendor/` holds MIT code © Proton AG, with its license files.
