# proton-drive-mount

Serve Proton Drive over local WebDAV through the official Proton Drive SDK, so stock
`rclone mount` can mount it.

> This is a third-party application not officially supported by Proton.
> It is not made, endorsed or reviewed by Proton AG, and it uses no Proton
> logos or design elements. **Proton may still limit or block an unknown
> client** at any time, even one that follows every rule below.

`proton-drive-mount --help` is the full reference for every command and flag. This README
shows how to use them together.

## Install

The flake builds a package that pins its own Bun and rclone. You need Nix with flakes, and
FUSE 3 on the computer: rclone mounts with `fusermount3`, which must be on `PATH` (on NixOS,
`/run/wrappers/bin/fusermount3`).

Install the `stable` tag. It names the release that was last promoted. Main's tip has not
been released yet. Nix reads a bare `ref=stable` as the branch `refs/heads/stable`, which
does not exist, so write the tag in full.

The repository is private, so Nix fetches it over ssh. The URL works only when the forge
accepts an ssh key of yours: add your public key to your account on forgejo.clarob.uk first.

Into your Nix profile:

```sh
nix profile add "git+ssh://forgejo@forgejo.clarob.uk/rob/proton-drive-mount?ref=refs/tags/stable"
proton-drive-mount --version
```

A Nix older than the rename of `install` to `add` spells it `nix profile install`.

Or as an input of your own flake, for NixOS or home-manager:

```nix
inputs.proton-drive-mount.url = "git+ssh://forgejo@forgejo.clarob.uk/rob/proton-drive-mount?ref=refs/tags/stable";

# then, in your configuration:
home.packages = [ inputs.proton-drive-mount.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

## Sign in, once on each computer

```sh
proton-drive-mount auth login
```

Run it and follow what it prints. Keep the command running until it exits; it then has saved
the session.

Each computer needs its own `auth login`. The session is saved on that computer only, in
`~/.local/state/proton-drive-mount/session.json` (`$XDG_STATE_HOME/proton-drive-mount`, or the
folder you give with `--state-dir`). Do not copy the session file to another computer; sign in
there instead.

To check the saved session:

```sh
proton-drive-mount auth status
```

## Mount

```sh
proton-drive-mount mount ~/ProtonDrive
```

`mount` starts the WebDAV serve and `rclone mount` with the tested settings, and mounts all of
"My files" at `~/ProtonDrive`. It creates the folder if it does not exist. It refuses (exit 2)
a folder that is not empty. Give `--root PATH` to mount only one folder inside "My files".

Ctrl-C or SIGTERM stops the mount, and rclone unmounts the folder. A stop by SIGTERM, as
`systemctl stop` sends, exits 0.

A write waits in the cache folder until it reaches the Drive, and a stop does not wait for
it. The mount logs each file not yet on the Drive when it stops. The next mount with the same
cache folder, `--state-dir` and `--root` uploads it, also after a crash.

## Cache settings

| Flag | Default | What it does |
|---|---|---|
| `--dir-cache-time DURATION` | `30s` | How long the mount trusts a folder listing before it asks again, so how soon a change from another device shows. Give a long time, such as `1000h`, for a mount that only this computer changes. |
| `--vfs-cache-max-size SIZE` | `6G` | The most file content the mount keeps on disk, such as `512M` or `6G`, or `off` for no limit. rclone drops a cached file it has not used for 1h. |
| `--cache-dir DIR` | rclone's own: `$RCLONE_CACHE_DIR`, else `$XDG_CACHE_HOME/rclone` (`~/.cache/rclone`) | Where the mount keeps its cache, including writes not yet on the Drive. |

For example:

```sh
proton-drive-mount mount ~/ProtonDrive --dir-cache-time 5m --vfs-cache-max-size 20G \
  --cache-dir ~/.cache/proton-drive-mount
```

A `--dir-cache-time` that is not a duration stops `mount` with exit 2 before it serves
anything. To change a setting of the user service, edit its `ExecStart=` line, then run
`systemctl --user daemon-reload` and `systemctl --user restart proton-drive-mount`.

## Run it as a user service

proton-drive-mount ships no unit file. This is an example systemd user unit; copy it to
`~/.config/systemd/user/proton-drive-mount.service`, or write the same in your home-manager
config (`systemd.user.services.proton-drive-mount`).

```ini
[Unit]
Description=Proton Drive at ~/ProtonDrive

[Service]
Type=exec
# With `nix profile add`. From a flake input, use the package's bin/proton-drive-mount.
ExecStart=%h/.nix-profile/bin/proton-drive-mount mount %h/ProtonDrive --cache-dir %h/.cache/proton-drive-mount
# Optional: only for units that must start after the folder is mounted (After=proton-drive-mount.service).
#ExecStartPost=/bin/sh -c 'until mountpoint -q %h/ProtonDrive; do sleep 1; done'
Restart=on-failure
RestartSec=10s
# Exit 3 means the session needs a new login. A restart cannot fix that.
RestartPreventExitStatus=3
# SIGTERM goes to mount only. mount stops rclone itself, so the folder unmounts.
KillMode=mixed
# Give mount time to unmount before systemd kills everything.
TimeoutStopSec=45s

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now proton-drive-mount
journalctl --user -u proton-drive-mount -f
```

The unit has no `ExecStop=`. `systemctl --user stop proton-drive-mount` sends SIGTERM, which
unmounts the folder, and `mount` exits 0.

The unit must be able to find `fusermount3` on its `PATH`. On NixOS, the user manager's `PATH`
has `/run/wrappers/bin`. If it does not on your system, add an `Environment=PATH=...` line.

## Sign in again

When Proton refuses the saved session, at the start or while it runs, `mount` and `serve` exit
3. The service then stays stopped, and `journalctl --user -u proton-drive-mount` tells you to
run `auth login`.

```sh
systemctl --user stop proton-drive-mount
proton-drive-mount auth logout        # optional: auth login replaces the session anyway
proton-drive-mount auth login
systemctl --user restart proton-drive-mount
```

## Security model

- The serve listens on `127.0.0.1` only, unless you give `--host`. It answers only requests
  that name `localhost`, `127.0.0.1`, `::1` or the listen address, so a web page cannot reach it
  by a DNS name.
- `mount` makes a new credential each run and gives it to rclone in rclone's environment, never
  on a command line. The port refuses every request without it, so another program or user on
  the computer cannot use the mount's port.
- A standalone `serve` has no password; only the address checks protect it. Keep it on loopback,
  and prefer `mount` on a computer that other users share.
- The session file `session.json` has mode 0600, in a state folder with mode 0700. Only you can
  read it. It holds the refresh token and the key password, so anyone who can read it has full
  access to your Proton account.
- `auth logout` deletes the session file. It does not call Proton, so Proton keeps the session
  until it expires. Revoke it in your Proton account settings to end it sooner.

## Uninstall

```sh
systemctl --user disable --now proton-drive-mount   # unmounts ~/ProtonDrive
journalctl --user -u proton-drive-mount -n 50       # check that no file is "not yet on the Drive"
proton-drive-mount auth logout
rm ~/.config/systemd/user/proton-drive-mount.service
systemctl --user daemon-reload
rm -r ~/.local/state/proton-drive-mount             # the state folder
rm -r ~/.cache/proton-drive-mount                   # the cache folder you gave with --cache-dir
nix profile remove proton-drive-mount                # the name "nix profile list" shows
```

Do not remove a shared `~/.cache/rclone`: other rclone remotes can use it. Give `--cache-dir`,
as the example unit does, so that you can remove the cache folder whole.

A file still in the cache folder is lost when you remove the folder. Start the mount again and
let it upload first.

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

The product grows one ticket at a time, each one scenario first, through
[cd-pipeline](https://forgejo.clarob.uk/rob/continuous-delivery).

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
