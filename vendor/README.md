# Vendored code

Files in this directory are copied without change from
https://github.com/ProtonDriveApps/sdk at commit
`b68d64bd9f9c1f24be521c8b423c26f5dca1c681` (2026-10-23). They are MIT
licensed; each directory keeps the upstream `LICENSE.md`
(Copyright (c) 2025-2026 Proton AG).

| Directory | Upstream path | Why |
|---|---|---|
| `proton-drive-sdk-account/` | `incubating/account/js/src/` (tests left out) | Browser session-fork login, token refresh, addresses and keys. The SDK has no login code, and Proton does not publish this module to npm. |
| `proton-drive-cli/` | `cli/src/api/apiRequirements.ts`, `messageEmitter.ts`, `serverTimeHook.ts` | Same response hooks as the official CLI: server time for crypto, and the `x-pm-drive-requirements` "update required" warnings. |

To update: copy the same paths from a newer SDK commit, record the commit
here, and run `bun test`.
