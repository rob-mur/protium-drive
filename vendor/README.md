# Vendored code

Files in this directory are copied without change from
https://github.com/ProtonDriveApps/sdk at the tag on the line below. They are MIT
licensed; each directory keeps the upstream `LICENSE.md`
(Copyright (c) 2025-2026 Proton AG).

<!-- renovate: tag -->
Upstream tag: `js/v0.24.0`

| Directory | Upstream path | Why |
|---|---|---|
| `proton-drive-sdk-account/` | `incubating/account/js/src/` (tests left out) | Browser session-fork login, token refresh, addresses and keys. The SDK has no login code, and Proton does not publish this module to npm. |
| `proton-drive-cli/` | `cli/src/api/apiRequirements.ts`, `messageEmitter.ts`, `serverTimeHook.ts` | Same response hooks as the official CLI: server time for crypto, and the `x-pm-drive-requirements` "update required" warnings. |

The record is a tag, not a commit, because the upstream repository is a mirror
whose history Proton rewrites. The SDK, the account module and the CLI are
released together under one `js/v<version>` tag.

To update: change the tag above, run `tasks/vendor-sync.sh`, and run `bun test`.
Renovate does this in the same pull request as the `@protontech/drive-sdk` and
`@protontech/crypto` bump (`renovate.json`). `ci:commit:vendor-drift` runs
`tasks/vendor-sync.sh --check`, and fails when `vendor/` differs from upstream at
the tag.
