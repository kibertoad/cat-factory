---
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/server': patch
---

Address review findings on the runtime-facades work:

- **Node durable execution: fix pg-boss dedup.** The advance queue is now created with
  the `exclusive` policy. `singletonKey` alone does NOT deduplicate under pg-boss's
  default `standard` policy (the singleton unique indexes are policy-gated, and the
  policy-independent one needs `singletonSeconds`), so duplicate `signalDecision`/sweeper
  sends could double-drive a healthy run. `exclusive` makes at most one advance job per
  run id live at a time, restoring the documented no-op semantics.
- **Node decision timeout.** A run parked on a human decision now arms a delayed
  `execution.decision-timeout` job; `ExecutionService.expireDecision` fails it
  `decision_timeout` only if still parked on that exact decision (idempotent, no driving),
  matching the Cloudflare driver's `waitForEvent` timeout instead of waiting forever.
- **Node Postgres pool** attaches an `'error'` handler so a transient idle-client drop
  (Postgres restart/failover) no longer crashes the process.
- **Provider registration parity.** The Worker now registers `openai`/`anthropic` only
  when their key is set (like the Node facade), so an unconfigured provider throws a clear
  "Unsupported model provider" error instead of failing deep in the vendor SDK.
- **Node config fail-fast**: a too-short `AUTH_SESSION_SECRET` with OAuth configured (and
  no dev-open) now refuses to boot with a clear message rather than silently 503-ing.
- **`BEDROCK_MODELS=""`** (set-but-blank) is treated as "allow all" rather than rejecting
  every model.
- **LLM proxy** trims the bearer token, matching the auth middleware.
- The Node `driveExecution` gate handling drains gate→gate transitions (e.g. a CI step
  dispatching a `ci-fixer`) in-iteration rather than relying on the next advance.
