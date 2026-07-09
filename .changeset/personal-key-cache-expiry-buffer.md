---
'@cat-factory/app': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
---

Validate the personal-subscription password cache against an 8h expiry buffer on every
gated action (start / confirm / retry), so the user is prompted to re-enter early — while
they are present at the action — instead of the key lapsing mid-pipeline and surfacing as a
broken run that asks for a retry.

- Frontend (`@cat-factory/app`): a cached key with under 8h of runway left is withheld on
  the first attempt of a gated action, so the server's existing `428 credential_required`
  gate re-challenges and the modal refreshes the full window. The mid-run confirm actions
  (resolve decision / approve step / request changes / resolve-exceeded) now flow through
  the same `withCredential` prompt path as start/retry.
- Backend (`@cat-factory/server`): **behavior change** — the run-interaction endpoints
  (resolve decision / approve / request changes / resolve-exceeded) now hard-gate for
  individual-usage runs (mint a fresh activation via `personalGateForRun`, 428 when the
  password is needed but absent/withheld) instead of a silent best-effort re-mint, so an
  early re-entry can be surfaced mid-run. The `remintActivations` helper is removed.
- `@cat-factory/integrations`: removed the now-unused `PersonalSubscriptionService.refreshActivations`.
