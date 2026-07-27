---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
can now include the requirements-review loop instead of being refused at admission: a new
`/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
with stable item ids, iteration/cap, the incorporated document; the proposed implementation
forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
identically whichever surface answers first.

**Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
(`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
should now answer decisions must be re-minted as `decide`.

Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
a `decision` frame on both public SSE streams, which now stay open across a park; a new
per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
alongside in-app and Slack, so a headless caller learns of a park by push rather than
polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
push clarification questions to a tracker issue for headless-origin runs only. A UI-started
task's behaviour is unchanged throughout.

The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
(a public endpoint cannot 302 the signed body at an internal target). Two new optional env
vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
it for a receiver on an internal host or a developer's `localhost`; they are scoped to
webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
bounded by a total wall-clock budget rather than an attempt count, because the notification
fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
notification channel, so under mothership mode the mothership — which holds the key its
signing secret is sealed with — is the side that delivers it.

Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
environment, runner-pool and notification-webhook integrations (previously an
environment-labelled private function), so an SSRF bypass is fixed in one place for all of
them.

See `docs/initiatives/headless-clarification-loop.md`.
