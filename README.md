# proton-drive-mount

Serve Proton Drive over local WebDAV, so stock `rclone mount` can mount it.

> This is a third-party application not officially supported by Proton.
> It is not made, endorsed or reviewed by Proton AG, and it uses no Proton
> logos or design elements. **Proton may still limit or block an unknown
> client** at any time, even one that follows every rule below.

```
rclone mount ──WebDAV──▶ proton-drive-mount ──Proton Drive SDK──▶ Proton
 (VFS cache)            127.0.0.1:7395      (official, MIT)
```

`proton-drive-mount` is a small TypeScript service on Bun. All traffic to
Proton goes through the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
(`@protontech/drive-sdk`), with the same login and crypto stack as Proton's own
CLI. rclone talks plain WebDAV to it (`vendor = other`) and keeps its VFS cache,
so anything that runs on an rclone mount today (for example an Immich library)
can keep running on it.

It replaces rclone's own `protondrive` backend, which talks to Proton's API
without the SDK. Proton blocked that backend by app version on 2026-10-23, and
Proton's coming crypto change will break it for good.

Status: **prototype, 0.1.0-alpha**. Tested only against a fake SDK; see
[Manual live test](#manual-live-test).

## Quick start

```sh
nix develop                 # bun + rclone; or install both yourself
bun install
bun test                    # no test reaches Proton

bun src/main.ts auth login  # once; approve in a browser
bun src/main.ts serve       # http://127.0.0.1:7395/
```

With Nix, `nix run . -- serve` or `nix build` (the binary is
`result/bin/proton-drive-mount`) work too.

## Sign in (`auth`)

```sh
proton-drive-mount auth login  [--state-dir DIR]
proton-drive-mount auth status [--state-dir DIR]
proton-drive-mount auth logout [--state-dir DIR]
```

`auth login` uses the session-fork flow of Proton's CLI. It never asks for your
password:

1. The command prints a URL on `account.proton.me`.
2. Open it in a browser on any device, sign in there (2FA included), and
   approve the sign-in.
3. The command waits up to 10 minutes, then prints `Signed in.`

The session (refresh token and key password, which together give full access
to the account) goes to `session.json` with mode 0600 in a 0700 directory:
`$XDG_STATE_HOME/proton-drive-mount/` (usually `~/.local/state/proton-drive-mount/`),
or the `--state-dir` you give. Treat the file like a password.

When `serve` starts again, it loads that file and refreshes the access token
with the refresh token. It does not sign in again. Proton rotates the refresh
token on each refresh, so only one process may use a state directory at a
time; a `lock.pid` file enforces that.

`auth status` reads only the local file and makes no Proton call, so it is safe
to run while `serve` runs. If Proton refused the refresh token, the file stays
(with a `refreshRejectedAt` mark) and `auth status` tells you to sign in again.

`auth logout` deletes the local file. Proton keeps the session until it
expires. To end it at once, revoke it in Proton's web settings
(Security > Session management).

## Serve (`serve`)

```sh
proton-drive-mount serve [--host 127.0.0.1] [--port 7395] [--root PATH] [--state-dir DIR]
```

- `--root PATH` serves one folder of "My files" as `/`, for example
  `--root Photos/immich`. The folder must exist.
- `--host` defaults to `127.0.0.1`. The server has **no authentication of its
  own**: anyone who can reach the port can read and change the whole Drive (or
  the `--root` folder). Keep it on loopback.
- `PDM_LOG_LEVEL=debug|info|warn|error` sets the log level (default `info`).
  Logs go to stderr, one line per request.

WebDAV support:

| Method | Behaviour |
|---|---|
| `PROPFIND` | `Depth: 0` and `1`. `infinity` is refused (403), so no client can walk the whole Drive. |
| `GET`, `HEAD` | `Range` supported (one range; 206). Streams; nothing is buffered whole. `HEAD` needs no download. |
| `PUT` | A new name creates a file (201). An existing name uploads a **new revision** (204), so Drive keeps the old version. The body streams into the SDK. |
| `DELETE` | Moves the file or folder to Drive's **trash**. Nothing is deleted for good. |
| `MKCOL` | Creates a folder. |
| `MOVE` | Rename and/or move; `Overwrite: T` trashes an existing target first. |
| `COPY` | Not supported (501). |
| `LOCK`, `PROPPATCH` | Not supported. |

Error mapping: a missing or refused session gives `401` before any Proton call;
Proton rate limits give `503` with `Retry-After`; a name clash gives `409`/`412`;
a Proton server error or a failed integrity check gives `502`.

## rclone

`~/.config/rclone/rclone.conf` (or any file you pass with `--config`):

```ini
[pdm]
type = webdav
url = http://127.0.0.1:7395/
vendor = other
```

Check it:

```sh
rclone lsf pdm:
```

Mount it:

```sh
rclone mount pdm: /mnt/proton \
  --vfs-cache-mode full \
  --vfs-cache-max-size 6G \
  --vfs-write-back 5s \
  --dir-cache-time 1000h \
  --attr-timeout 1000h \
  --no-modtime \
  --no-checksum \
  --timeout 1h \
  --transfers 2
```

Notes:

- `--timeout 1h` (or `0`): the server forwards an upload to Proton while the
  client sends it, and a large file can stay quiet longer than rclone's default
  5-minute idle timeout.
- `--no-modtime`: WebDAV with `vendor = other` cannot set modification times,
  so Drive records the upload time.
- WebDAV has no change notification. With a long `--dir-cache-time`, the mount
  does not see changes made elsewhere (web app, phone) until the cache expires
  or you run `rclone rc vfs/refresh`. The server itself sees them through Drive
  events within about 30 seconds.
- When an overwrite fails, rclone deletes the target. For an existing file
  that would trash good content, so the server refuses (423) a `DELETE` of that
  path for 60 seconds after a failed overwrite.

## Proton's third-party rules, and how this project follows them

From the [SDK README](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects):

| Rule | Here |
|---|---|
| Use the SDK | All Drive calls go through `@protontech/drive-sdk` 0.23.0. Login, token refresh and keys use Proton's account module, vendored unchanged (`vendor/`). |
| Use official endpoints | The API host is fixed to `drive-api.proton.me`. There is no option to change it. |
| Identify your application honestly | Every request sends `x-pm-appversion: external-drive-protondrivemount@0.1.0-alpha` (the README's `external-drive-{name}@{semver}-{channel}` shape) and `x-pm-drive-sdk-version: js@0.23.0`. It never uses a Proton or rclone client name. The login uses the `external-drive` client ID that Proton gives third-party clients. |
| Event-based sync, no recursive polling | Folder listings load only when a client asks, and stay cached. Drive events (the SDK's scheduler, about every 30 s) drop only the listings that changed. `PROPFIND Depth: infinity` is refused. |
| Back off on 429 | The SDK retries each 429 with `Retry-After`. After it gives up (`RateLimitedError`), the server stops all Proton calls for 30 s, doubling up to 15 min, and answers `503` with `Retry-After`. Event polls skip the cool-down too. HTTP-level retries outside the SDK are off. |
| No Proton branding | No logos or design elements. The name only says which service it connects to. |
| Credential disclosure | `auth login` and `--help` print "This is a third-party application not officially supported by Proton." |

Proton's server can also tell the SDK that a newer SDK version is required
(`x-pm-drive-requirements`). The server logs that as a warning; update the
`@protontech/drive-sdk` dependency when you see it.

## Limitations

- Prototype. The SDK itself is not yet officially released for third-party use.
- Serves "My files" only: not "Shared with me", not Photos albums.
- Nodes whose name cannot be decrypted, and files with no clear-text size, are
  hidden (with a warning in the log).
- The SDK caches (`MemoryCache`) are in memory, so each restart starts cold.
  The SDK calls `MemoryCache` "not recommended in production"; a persistent,
  encrypted cache like the official CLI's is future work.
- Bun sends `GET` bodies chunked and drops `Content-Length`. Clients take the
  size from `PROPFIND`. A file that fails its integrity check after streaming
  starts arrives truncated; before streaming starts, it gives a `502`.
- A `PUT` without `Content-Length` uploads without the SDK's exact size check
  (rclone always sends it).
- No `COPY`, `LOCK` or `PROPPATCH`; no server-side checksums.
- The Nix package pins the `node_modules` hash; it is tested on `x86_64-linux`.

## Development

```sh
nix develop
bun install
bun test                         # unit, integration, and the stock-rclone test
bun run check-types              # tsc --noEmit
bun tests/support/serveFake.ts   # WebDAV over an in-memory fake Drive, for trying rclone
```

Layout:

| Path | What |
|---|---|
| `src/main.ts` | CLI: `auth login/status/logout`, `serve`. |
| `src/proton/connect.ts` | Wires the account module, the HTTP client and the SDK, as the official CLI does. |
| `src/session/` | Session file (0600), the account module's credentials interface, the state lock. |
| `src/drive/` | Path tree and listing cache over the SDK, downloads (full and ranged), events, back-off. |
| `src/webdav/` | WebDAV handler, XML, the Bun server. |
| `tests/support/fakeSdk.ts` | In-memory fake of the SDK surface the server uses. |
| `vendor/` | Unchanged MIT code from the SDK repository; see `vendor/README.md`. |
| `patches/` | `bun patch` files: `@protontech/crypto` loads the full OpenPGP build; `@protontech/drive-sdk` frees a download slot when revision keys fail to load. |

Tests never reach Proton: the WebDAV and rclone tests run against
`FakeDriveSdk`, and the login and token-refresh tests run against a local mock
HTTP server.

## Manual live test

The first run against a real account is by hand: login needs a browser, and
the account has a login rate limit. Use a scratch state directory and a scratch
folder.

1. In the Proton Drive web app, create the folder `pdm-test` in My files.
2. `nix develop`, then `bun install && bun test`. Expect all tests to pass.
3. Sign in:
   `bun src/main.ts auth login --state-dir ~/.local/state/pdm-test`.
   Open the URL, approve, and expect `Signed in.`. Check
   `ls -l ~/.local/state/pdm-test/session.json` shows `-rw-------`.
4. `bun src/main.ts auth status --state-dir ~/.local/state/pdm-test` shows
   "signed in".
5. Serve the scratch folder:
   `PDM_LOG_LEVEL=debug bun src/main.ts serve --state-dir ~/.local/state/pdm-test --root pdm-test`.
   Expect no app-version errors and no "requires SDK" warnings in the log. A
   block by app version shows up here first.
6. In a second shell, with the `[pdm]` remote above:
   - `rclone lsf pdm:` lists the (empty) folder.
   - `rclone copyto ./some-photo.jpg pdm:a.jpg`, then `rclone lsl pdm:`.
   - Overwrite with a different file: `rclone copyto ./other.jpg pdm:a.jpg`.
     In the web app, `a.jpg` now has 2 versions.
   - `rclone cat pdm:a.jpg | cmp - ./other.jpg` prints nothing.
   - `rclone cat --offset 1000 --count 100 pdm:a.jpg | wc -c` prints `100`.
   - `rclone moveto pdm:a.jpg pdm:b.jpg`, then `rclone deletefile pdm:b.jpg`.
     `b.jpg` is now in the web app's Trash.
7. Upload a file in the web app into `pdm-test`. Within about 30 seconds,
   `rclone lsf pdm:` shows it (the server read a Drive event).
8. Stop `serve` (Ctrl-C) and start it again. It must not ask for a login, and
   `rclone lsf pdm:` still works.
9. Mount: `rclone mount pdm: /tmp/pdm-mnt --vfs-cache-mode full --timeout 1h`.
   Copy a large video (over 128 MiB) in, then play it from the mount and seek.
10. Clean up: `bun src/main.ts auth logout --state-dir ~/.local/state/pdm-test`,
    revoke the session in Proton's web settings, and delete `pdm-test`.

If Proton answers with an error about the app version or client, stop:
Proton blocks this client. Do not change `x-pm-appversion` to get around it.

## License

MIT; see `LICENSE`. `vendor/` holds MIT code © Proton AG, with its license
files.
