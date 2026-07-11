---
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Elaborate GitHub App authentication failures (error-message coverage initiative, items A3/C3). A
malformed `GITHUB_APP_PRIVATE_KEY` and a failed installation-token mint used to surface opaquely —
long after boot, deep in a pipeline — instead of naming the cause and the fix.

- **A3** — new shared validator `requireGitHubAppPrivateKey` (`@cat-factory/server`
  `config/problems.ts`) checks the App private key's SHAPE at config load whenever the App is
  configured: present, a PKCS#8 PEM (not the PKCS#1 key GitHub hands out), with a base64-decodable
  body. A malformed key now fails on the misconfigured screen with the exact `openssl pkcs8 -topk8`
  conversion remedy and a docs link, rather than as an opaque `crypto.subtle.importKey` rejection or
  an `atob` `InvalidCharacterError` at the first token mint. Wired into BOTH facade config loaders
  (Node `loadNodeConfig`, Worker `loadGitHubConfig`) for the default and privileged App keys, with a
  new `GITHUB_APP_PRIVATE_KEY` `ENV_HELP` entry so the message reads identically across facades.
  `GitHubAppAuth.importKey` additionally wraps the residual "valid base64 but not a real key" case
  (which slips past the shape check) with the same actionable message.
- **C3** — `GitHubAppAuth.mintInstallationToken` now throws an elaborated message via the exported
  `explainInstallationTokenMintFailure`: 401 → wrong/rotated App private key; 404/410 → the App was
  uninstalled or the workspace points at a stale installation (reconnect GitHub); 403 → rejected /
  rate-limited (check App id + key + clock). The load-bearing first line
  (`Failed to mint installation token for <id> (HTTP <status>)`) is preserved verbatim so the
  stale-installation reconcile regexes still classify correctly — the cause + remedy is only
  appended. Unit-tested for both the elaboration and the regex compatibility.

No behaviour changes beyond error message text and boot-time validation of an already-required key.
