---
'@cat-factory/integrations': patch
'@cat-factory/app': patch
---

feat(infra): view, retest and safely edit a stored Kubernetes test-environment connection

The Test-environments Kubernetes handler previously only offered a delete: opening the edit form
cleared the write-only ServiceAccount token, so "Test connection" on a saved connection always
failed auth (no token) and re-saving a non-secret tweak silently wiped the stored token.

- Backend (`EnvironmentConnectionService` + `EnvironmentUserHandlerService`, runtime-neutral):
  `testHandler` now falls back to the SAVED handler's stored secret, so an established connection
  can be tested (or a non-secret field edited and tested) without re-entering the token; a
  freshly-typed value still overrides it. Saving a handler now PRESERVES stored secrets the
  operator left blank (a blank/omitted secret means "keep it") and replaces them only when a new
  value is supplied. Shared `overlaySecrets` helper; no schema change.
- Frontend: the Kubernetes engine form shows when a token is already saved, makes the token
  optional on edit ("leave blank to keep"), and enables Test against the stored token. The
  handler list now frames each entry as an established connection with a prominent connected
  checkbox and an inline Test-connection button.
