# Environment variables

This is the reference for every environment variable the cat-factory backends read,
grouped by purpose and annotated with the deployment modes each applies to. For the
narrative on how config is loaded per runtime, see the facade sections in
[`CLAUDE.md`](../CLAUDE.md) and the example `.env` files under `deploy/*`.

## Deployment modes

The same `@cat-factory/server` app ships to several targets. "Mode" is which facade
boots plus a few switches:

| Mode       | Facade                                                                                                                       | Meaning                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare | `runtimes/cloudflare` (`@cat-factory/worker`)                                                                                | The Worker: D1 + Durable Objects + Workflows + Containers. Config comes from `wrangler.toml` `[vars]` + secrets + bindings.                                                               |
| Node       | `runtimes/node` (`@cat-factory/node-server`)                                                                                 | The hosted Node service: Postgres (Drizzle) + pg-boss. Config comes from `process.env`. Also called "remote node".                                                                        |
| Local      | `runtimes/local` (`@cat-factory/local-server`)                                                                               | The Node facade a single developer runs on their machine: per-run local containers + a GitHub PAT. Reuses every Node variable plus the `LOCAL_*` extras and some local-friendly defaults. |
| Mothership | a Node/Cloudflare deployment acting as the hosted org backend, plus a local laptop that delegates persistence to it over RPC | The hosted side reads the Node/Cloudflare variables; the laptop reads the Local variables plus `LOCAL_MOTHERSHIP_*`.                                                                      |

In the tables below the Modes column uses: `CF` (Cloudflare), `Node`, `Local`,
`MS` (mothership-specific). A variable marked `Node` is also read by `Local` and by a
mothership-mode laptop, because Local reuses the Node config loader; the tables call out
`Local`/`MS` only when a variable is exclusive to those modes.

## Spend budgets

Budgets are tiered: a per-workspace monthly limit (configured in the UI), a per-account
limit, and a per-user limit. The two variables below are operator hard ceilings on the
account and user tiers. When set, a UI user cannot configure a value above the cap (it is
also enforced server-side), the cap is shown on the budget configuration screen, and it
acts as the effective tier limit when nothing is configured. See
[`docs/initiatives/tiered-budgets.md`](initiatives/tiered-budgets.md). Amounts are in the
base pricing currency (EUR by default).

| Variable                         | Modes        | Default         | Description                                                                |
| -------------------------------- | ------------ | --------------- | -------------------------------------------------------------------------- |
| `BUDGET_MAX_MONTHLY_PER_ACCOUNT` | CF, Node, MS | none (uncapped) | Hard ceiling on the account-tier monthly budget any account may configure. |
| `BUDGET_MAX_MONTHLY_PER_USER`    | CF, Node, MS | none (uncapped) | Hard ceiling on the user-tier monthly budget any user may configure.       |

Notes: these are read by the Node and Cloudflare config loaders, so they apply in the
Node, Cloudflare, and mothership-hosted deployments. A single-user local deployment reads
them too (Local reuses the Node loader) but they are rarely meaningful there. The
per-workspace budget itself is not an env variable: it is configured per workspace in the
UI (Workspace settings -> Budget) and defaults to about 100 EUR/month.

## Core service & networking

| Variable                                            | Modes       | Default         | Description                                                                                                                                                                                            |
| --------------------------------------------------- | ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                      | Node, Local | required (Node) | Postgres connection string. Prefer `127.0.0.1` over `localhost` for a local DB: on Windows + Docker Desktop `localhost` resolves to IPv6 `::1` first and the connection RESETS at boot (`ECONNRESET`). |
| `DB_SCHEMA`                                         | Node        | `public`        | Schema for the app's unqualified tables (relocated via the connection `search_path`); set when sharing a Postgres with other services. Plain lowercase identifier.                                     |
| `DB_MIGRATIONS_SCHEMA`                              | Node        | `drizzle`       | Schema for the Drizzle migration ledger, so it can't collide with another Drizzle service's `drizzle.__drizzle_migrations`. Plain lowercase identifier.                                                |
| `DB_PGBOSS_SCHEMA`                                  | Node        | `pgboss`        | Schema for pg-boss's durable-job queue tables. Plain lowercase identifier.                                                                                                                             |
| `PORT`                                              | Node, Local | `8080`          | HTTP listen port.                                                                                                                                                                                      |
| `HOST`                                              | Node, Local | all interfaces  | Bind address.                                                                                                                                                                                          |
| `PUBLIC_URL` / `WORKER_PUBLIC_URL` / `APP_BASE_URL` | Node / CF   | derived         | Public base URL used to build callback/redirect URLs.                                                                                                                                                  |
| `CORS_ALLOWED_ORIGINS`                              | CF, Node    | none            | Comma-separated allowed CORS origins.                                                                                                                                                                  |
| `ENVIRONMENT`                                       | CF, Node    | `development`   | Deployment environment label (`production`, `local`, ...).                                                                                                                                             |

## Realtime (Node horizontal scaling)

| Variable                 | Modes | Default            | Description                                                                                     |
| ------------------------ | ----- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `REDIS_URL`              | Node  | none (single node) | Enables the Redis pub/sub cross-node WebSocket propagator. `ioredis` is imported only when set. |
| `REDIS_REALTIME_CHANNEL` | Node  | default channel    | Redis channel for realtime fan-out.                                                             |
| `REALTIME_NODE_ID`       | Node  | generated          | Stable id for this replica in the propagator.                                                   |

## Authentication

| Variable                                                                              | Modes       | Default                | Description                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SESSION_SECRET`                                                                 | CF, Node    | required (Node/Local)  | HMAC secret for session tokens (>= 32 chars).                                                                                                                                      |
| `HARNESS_SHARED_SECRET`                                                               | CF, Node    | required (executor)    | Shared secret the orchestrator sends on every agent-container harness call (`x-harness-secret`) so a job container only trusts this service (>= 16 chars, stable across restarts). |
| `AUTH_SESSION_TTL_HOURS`                                                              | Node        | default TTL            | Session lifetime.                                                                                                                                                                  |
| `AUTH_DEV_OPEN`                                                                       | Node, Local | `false` (Local `true`) | Dev-open auth (no sign-in).                                                                                                                                                        |
| `AUTH_PASSWORD_ENABLED`                                                               | Node, Local | `false` (Local `true`) | Enable password auth.                                                                                                                                                              |
| `AUTH_OPEN_SIGNUP`                                                                    | Local       | `true` (Local)         | Allow open sign-up.                                                                                                                                                                |
| `AUTH_ALLOWED_LOGINS` / `AUTH_ALLOWED_ORGS` / `AUTH_ALLOWED_EMAIL_DOMAINS`            | CF, Node    | none                   | Allow-lists gating who may sign in.                                                                                                                                                |
| `AUTH_ALLOWED_REDIRECT_ORIGINS` / `AUTH_SUCCESS_REDIRECT_URL` / `AUTH_CALLBACK_URL`   | CF, Node    | none                   | OAuth redirect configuration.                                                                                                                                                      |
| `AUTH_MACHINE_TOKEN_TTL_MS`                                                           | CF, Node    | 30 days                | Lifetime of a machine token minted for a mothership-mode node.                                                                                                                     |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`                               | CF, Node    | none                   | "Login with GitHub" OAuth app.                                                                                                                                                     |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URL` | Node        | none                   | "Login with Google" OAuth app.                                                                                                                                                     |

## VCS integration (GitHub / GitLab)

| Variable                                                            | Modes     | Default  | Description                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`                          | CF, Node  | none     | The GitHub App (installation-based repo access + CI/merge gates).                                                                                                                                                                                       |
| `GITHUB_APP_SLUG` / `GITHUB_API_BASE` / `GITHUB_SETUP_REDIRECT_URL` | CF, Node  | defaults | GitHub App metadata + API base (GitHub Enterprise).                                                                                                                                                                                                     |
| `GITHUB_PAT`                                                        | Local, MS | none     | Personal access token local mode uses instead of a GitHub App (push token + CI/merge client). OPTIONAL in mothership mode: without it, GitHub runs on installation tokens the mothership's GitHub App mints over the machine API. A set PAT still wins. |
| `GITLAB_PAT` / `GITLAB_API_BASE`                                    | Local     | none     | GitLab personal access token + API base for a GitLab local deployment.                                                                                                                                                                                  |

## Model providers

| Variable                                                                                                                    | Modes    | Default            | Description                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | ------------------------------------------------------------- |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `QWEN_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY`                           | CF, Node | none               | Direct vendor API keys.                                       |
| `OPENROUTER_BASE_URL`                                                                                                       | CF, Node | public gateway     | OpenRouter gateway base URL.                                  |
| `LITELLM_BASE_URL`                                                                                                          | CF, Node | required to enable | Operator-hosted LiteLLM gateway (no public default).          |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_AI_GATEWAY`                                                  | CF, Node | none               | Cloudflare Workers AI over REST (Node) + AI Gateway.          |
| `BEDROCK_REGION` / `AWS_*` / `BEDROCK_MODELS`                                                                               | Node     | none               | Opt-in AWS Bedrock resolver + its supported-model allow-list. |
| `AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL` / `AGENT_DEFAULT_TEMPERATURE` / `AGENT_MAX_OUTPUT_TOKENS` / `AGENT_MODELS` | CF, Node | built-in routing   | Default agent routing + per-kind model overrides.             |

## Web search

| Variable                                                                               | Modes           | Default | Description                                      |
| -------------------------------------------------------------------------------------- | --------------- | ------- | ------------------------------------------------ |
| `WEB_SEARCH_SEARXNG_URL` / `WEB_SEARCH_SEARXNG_API_KEY`                                | CF, Node, Local | none    | SearXNG upstream.                                |
| `WEB_SEARCH_BRAVE_API_KEY`                                                             | CF, Node        | none    | Brave search upstream (wins when set).           |
| `INLINE_WEB_SEARCH_ENABLED` / `INLINE_WEB_SEARCH_KINDS` / `INLINE_WEB_SEARCH_MAX_USES` | Node            | off     | Inline web-search tool for non-container agents. |
| `LOCAL_WEB_SEARCH`                                                                     | Local           | on      | Set `off` to disable the local SearXNG default.  |

## Execution tuning

| Variable                                                                                                                 | Modes    | Default  | Description                                     |
| ------------------------------------------------------------------------------------------------------------------------ | -------- | -------- | ----------------------------------------------- |
| `DECISION_TIMEOUT`                                                                                                       | CF, Node | default  | Human-decision wait timeout.                    |
| `JOB_POLL_INTERVAL` / `JOB_MAX_POLLS` / `JOB_POLL_FAILURE_TOLERANCE`                                                     | Node     | defaults | Container job polling cadence + limits.         |
| `CI_POLL_INTERVAL` / `CI_MAX_POLLS`                                                                                      | Node     | defaults | CI gate polling cadence + limits.               |
| `CONTAINER_MAX_AGE_MINUTES`                                                                                              | Node     | `90`     | Max age of a per-run container before eviction. |
| `EXECUTION_CONCURRENCY` / `EXECUTION_HEARTBEAT_SECONDS` / `EXECUTION_MAX_DRIVE_STEPS` / `EXECUTION_DRIVE_EXPIRE_MINUTES` | Node     | defaults | pg-boss execution worker tuning.                |
| `STALE_RUN_SWEEP_MINUTES` / `STALE_RUN_LEASE_MINUTES`                                                                    | Node     | defaults | Stale-run sweeper cadence + lease.              |

## Storage & retention

| Variable                           | Modes           | Default                    | Description                                                                                   |
| ---------------------------------- | --------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                   | CF, Node, Local | required for sealed stores | Base64 system key (>= 32 bytes) for sealed credentials.                                       |
| `TOKEN_USAGE_RETENTION_DAYS`       | CF, Node        | `395`                      | Retention for the `token_usage` ledger.                                                       |
| `LLM_CALL_METRICS_RETENTION_DAYS`  | CF, Node        | `3`                        | Retention for the LLM-call telemetry store.                                                   |
| `GITHUB_RATE_LIMIT_RETENTION_DAYS` | CF, Node        | `7`                        | Retention for GitHub rate-limit rows.                                                         |
| `GITHUB_COMMIT_RETENTION_DAYS`     | CF, Node        | `90`                       | Retention for commit-projection rows.                                                         |
| `LLM_RECORD_PROMPTS`               | CF, Node        | `false`                    | Deployment switch that (with the per-workspace toggle) enables storing prompts/agent context. |

## Integrations & observability

| Variable                                                               | Modes       | Default  | Description                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_ENABLED`                                                        | CF, Node    | `false`  | Enable the Slack notification channel.                                                                                                                                                                    |
| `OBSERVABILITY_ENABLED`                                                | CF, Node    | `false`  | Enable the post-release-health observability providers.                                                                                                                                                   |
| `CONSENSUS_ENABLED`                                                    | Node        | `false`  | Enable the consensus-orchestration mechanism.                                                                                                                                                             |
| `ENVIRONMENTS_ALLOW_HTTP_URLS` / `ENVIRONMENTS_ALLOW_URL_HOSTS`        | Node, Local | off      | Relax environment URL restrictions (local defaults on).                                                                                                                                                   |
| `RUNNERS_ENABLED`                                                      | CF, Node    | `false`  | Enable self-hosted runner pools.                                                                                                                                                                          |
| `LANGFUSE_*`                                                           | CF, Node    | none     | Langfuse trace sink credentials.                                                                                                                                                                          |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_*` / `OTEL_SERVICE_NAME`          | CF, Node    | `false`  | OpenTelemetry OTLP trace + metrics exporter.                                                                                                                                                              |
| `OTEL_PLATFORM_METRICS` (+ `_WINDOW`, `_INTERVAL_MS`)                  | CF, Node    | `false`  | Push per-account platform-health aggregates as OTLP gauge metrics (opt-in on top of `OTEL_ENABLED`).                                                                                                      |
| `PLATFORM_ALERTS`                                                      | CF, Node    | `false`  | Enable platform-health threshold alerting: a periodic sweep raises a `platform_health` notification (in-app + Slack) when the deployment's own run health crosses a threshold, auto-clearing on recovery. |
| `PLATFORM_ALERTS_WINDOW`                                               | CF, Node    | `1h`     | Window each evaluation aggregates over (`1h`/`24h`/`7d`).                                                                                                                                                 |
| `PLATFORM_ALERTS_INTERVAL_MS`                                          | Node        | `300000` | Node sweep interval (the Worker is cron-driven).                                                                                                                                                          |
| `PLATFORM_ALERTS_MIN_RUNS`                                             | CF, Node    | `5`      | Minimum terminal runs in the window before the failure-rate alert can fire.                                                                                                                               |
| `PLATFORM_ALERTS_MAX_FAILURE_RATE`                                     | CF, Node    | `0.5`    | Failure rate (0..1) at or above which the failure-rate alert fires.                                                                                                                                       |
| `PLATFORM_ALERTS_MAX_P99_MINUTES`                                      | CF, Node    | `60`     | p99 run duration (minutes) at or above which the slow-run alert fires.                                                                                                                                    |
| `PLATFORM_ALERTS_MAX_BACKLOG`                                          | CF, Node    | `50`     | Live running/blocked/paused/pending depth at or above which the backlog alert fires.                                                                                                                      |
| `EMAIL_SYSTEM_PROVIDER` / `EMAIL_SYSTEM_FROM` / `EMAIL_SYSTEM_API_KEY` | Node        | none     | System email sender.                                                                                                                                                                                      |

## Local mode

| Variable                                                                                                                                            | Modes | Default         | Description                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LOCAL_HARNESS_IMAGE`                                                                                                                               | Local | recommended pin | The executor-harness image local mode pulls + runs.                                                                                              |
| `LOCAL_HARNESS_IMAGE_REFRESH`                                                                                                                       | Local | off             | Re-pull the harness image at boot.                                                                                                               |
| `LOCAL_CONTAINER_RUNTIME`                                                                                                                           | Local | `docker`        | Container runtime adapter (`docker`/`podman`/`orbstack`/`colima`/`apple`).                                                                       |
| `LOCAL_DOCKER_BINARY` / `LOCAL_DOCKER_NETWORK` / `LOCAL_HARNESS_HOST_ALIAS` / `LOCAL_DOCKER_ADD_HOST_GATEWAY` / `LOCAL_DOCKER_PRIVILEGED_TEST_JOBS` | Local | defaults        | Docker-CLI adapter tuning.                                                                                                                       |
| `LOCAL_NATIVE_AGENTS` / `LOCAL_HARNESS_ENTRY`                                                                                                       | Local | off             | Run CONTAINER agents natively (no container) on the developer's `claude`/`codex` CLI.                                                            |
| `LOCAL_NATIVE_INLINE`                                                                                                                               | Local | on (both)       | Which subscription harnesses (`claude-code`/`codex`) may serve INLINE steps (reviewer/brainstorm/estimator) via the local CLI; `off` to disable. |

## Mothership mode

| Variable                                                                                    | Modes | Default          | Description                                                                           |
| ------------------------------------------------------------------------------------------- | ----- | ---------------- | ------------------------------------------------------------------------------------- |
| `LOCAL_MOTHERSHIP_URL`                                                                      | MS    | none (off)       | Enables mothership mode: the local node delegates persistence to this hosted backend. |
| `LOCAL_MOTHERSHIP_TOKEN`                                                                    | MS    | minted via login | Headless/CI machine-token override.                                                   |
| `LOCAL_MOTHERSHIP_TOKEN_DB` / `LOCAL_MOTHERSHIP_CREDENTIAL_DB` / `LOCAL_MOTHERSHIP_WORK_DB` | MS    | default paths    | Override paths for the laptop's local `node:sqlite` stores.                           |
