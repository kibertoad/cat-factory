---
'@cat-factory/local-server': minor
'@cat-factory/server': patch
---

Make `HARNESS_SHARED_SECRET` a mandatory, stable local-mode secret and a required runner-transport parameter.

Local mode previously let the runner transports mint a RANDOM `HARNESS_SHARED_SECRET` per process when the env var was unset. That value is the inbound-auth secret between the orchestrator and its agent containers, so after a restart, polls against a container still running from before the restart failed auth (not mapped to eviction) and the run flapped instead of re-attaching.

Now:

- `applyLocalDefaults` REQUIRES `HARNESS_SHARED_SECRET` (min 16 chars) and fails loudly at boot with a clear, actionable error when it is missing/blank/too-short, exactly like `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`.
- `sharedSecret` is now a REQUIRED constructor argument on `LocalContainerRunnerTransport`, `LocalProcessRunnerTransport`, and `LocalPreviewTransport` — the random per-process fallback is gone. The `*FromEnv` factories read it via the new `requireHarnessSharedSecret(env)`.
- `pnpm secrets` (deploy/local) now emits `HARNESS_SHARED_SECRET` alongside the other two, and `deploy/local/.env.example` documents it.

BREAKING (local mode): a local deployment with no `HARNESS_SHARED_SECRET` set now fails at boot instead of running with an unstable per-process secret. Set a stable value (via `pnpm secrets`) before upgrading.
