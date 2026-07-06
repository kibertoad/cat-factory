---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Missing mandatory env vars / bindings now produce human-readable, actionable startup errors AND a
graceful degraded backend instead of an opaque crash.

- **Shared structured config errors.** A new `ConfigValidationError` (carrying a list of
  `ConfigProblem { key, summary, remedy }`) plus a canonical `ENV_HELP` description table and a
  `requireEnv` helper live in `@cat-factory/server`. Every facade's startup throw for a mandatory
  variable (`DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, a configured auth provider,
  `TELEMETRY_DB`, `AGENT_MODELS`, the container-executor prerequisites) now routes through it, so the
  message reads the same across Node, local, and the Worker and always says what the variable is for
  and how to fill it. A `ConfigProblem` never carries a secret value.

- **Graceful misconfiguration fallback backend.** Instead of exiting (which left the SPA on a generic
  "can't reach the backend" panel with no clue what was wrong), a facade that hits a
  `ConfigValidationError` at boot now serves a minimal fallback app (`createMisconfiguredApp`) on the
  normal port: `GET /auth/config` returns an auth-disabled config carrying the problem list, `/health`
  stays 200 (`status: misconfigured`, so an orchestrator doesn't crash-loop it), and every other route
  503s with the structured problems. Wired symmetrically in all three runtimes — Node/local
  `serveMisconfigured`, the Worker's per-request build (which recovers automatically once bindings are
  fixed).

- **Dedicated frontend error screen.** The SPA's boot handshake now recognises the `misconfigured`
  field and renders `BackendMisconfiguredScreen` — a per-variable list of name + meaning + remedy with
  a reload button — instead of the login/board. Fully translated across all locales.
