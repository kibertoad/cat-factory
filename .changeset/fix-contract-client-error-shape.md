---
'@cat-factory/contracts': minor
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Fix the SPA error handling broken by the `@toad-contracts/*` migration.

The contract client (`sendByApiContract`) reports a contract-declared non-2xx as a plain
`{ statusCode, headers, body }` value (not an `Error`), with the `{ error: { code, message,
details } }` envelope under `body`. The old `$fetch` threw an ofetch `FetchError` with the
body under `data` and was always an `Error`. Several handlers still read the old shape, so:

- `parseCredentialError` returned `null` for every 428, so the personal-subscription
  password modal never opened and individual-usage runs (Claude/Codex/GLM) could not be
  started or retried.
- `parseConflict` returned `null` for every 409, so run-control conflict toasts lost their
  tailored guidance (including the `providers_unconfigured` "Configure AI" jump).
- `instanceof Error` message extraction across many catch blocks rendered `"[object Object]"`
  for declared 4xx/5xx, and the login/account/tracker-probe handlers dropped the server's
  message.

`sendContract` now wraps a bare non-2xx into a real `ApiError` (an `Error` carrying
`statusCode`, the parsed `body`, and the server's message), and a shared
`apiErrorEnvelope` / `apiErrorStatus` reads the envelope from either client shape. The
provisioning-logs query now validates through the contract schema so an invalid query
returns the standard `{ code: 'validation' }` 400 like every other route. `@cat-factory/contracts`
gains a `singleStringParam` helper that collapses the one-key path-param schemas the route
files each re-declared (typing preserved).
