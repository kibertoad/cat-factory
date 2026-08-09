# Initiative: error-message coverage (elaborate failures with fix instructions + doc URLs)

**Status:** doc-URL convention established (A1) · boot-config validation (A2/A4/A6) · boot-time
warnings for missing/rejected config (A5/A9/A10) · model-provisioning remedies (B1–B4) ·
GitHub/GitLab API-error classification (C1/C4/C5/C6) · crypto/credential decryption remedies
(E1/E2) · GitHub App auth failures (A3 App-key boot validation / C3 installation-token mint) ·
structured container/runner dispatch failures (D1 stale-image 404 / I2 `DispatchError`) ·
UI-first runner-backend / runner-pool / Datadog remedies (D2/D3/D4) · boot-time connection &
credential probes (A11 Postgres loopback reachability / A12 local-mode PAT validity) ·
structured container-eviction signal (I1 `RunnerJobView.evicted`) · Redis-bus failure modes
(A7 missing-`ioredis` configProblem + unreachable-bus boot probe) · env-config-repair
structured-cause classification (I3) · typed harness cause union + one shared kernel mapper
(I4 `HarnessFailureCause` / `failureKindFromHarnessCause`) · webhook signature-rejection operator
logging (C2, GitHub HMAC + GitLab token) · numeric-env-knob rejection warnings (A8, shared
`parseNumericEnv`) · harness clone/push + PR/MR-open + LLM-proxy failure classification (F1/F2/F3,
one `llm-upstream` cause, image-bumped) · exhaustive execution failure-kind hints
(G3, `preflight` was hint-less) · structured installation-token-gone code + first-wrap-point rule
codified + string-fallback classifiers deleted (I7/I6/I5) · per-reason conflict-toast descriptions

- jump actions across all locales (G1) · status-class-keyed generic failure copy + raw-detail
  disclosure (G2) · connection-probe cause chains + per-cause remedies and ServiceAccount-token
  paste validation (D5/D6; **sections A–G are complete apart from G4; only the H feature axis
  remains**) · **Owner:** core · **Started:** 2026-07-11

> This is the durable source of truth for a multi-PR initiative. Read it before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

Many failures a self-hosting operator or end user can plausibly hit today surface as a
terse, opaque, or entirely silent condition: a raw `GitHub GET <url> → 401`, a bare
`Unsupported model provider: litellm`, an `atob` `InvalidCharacterError` from a malformed
`ENCRYPTION_KEY`, a typo'd `LOCAL_CONTAINER_RUNTIME` silently running docker, a Datadog
`HTTP 403` with no mention of the keys panel. Each such message costs the person who hits
it a debugging session that a good message would have collapsed into a 30-second fix.

The intended end state: **every failure or missing configuration a user can plausibly hit
names the condition, its likely cause, the exact fix (the UI location first for
UI-configurable settings, a command or env var for operator-only settings), and links the
relevant documentation.** The repo already has six strong reusable shapes for this (see
the target patterns below); the work is extending their coverage, not inventing new
machinery. A second axis of the initiative (section H) closes the biggest _remedy gap_
itself: several providers cannot currently be configured through the UI at all, so their
best possible error message today is "ask your deployment operator"; making them
UI-configurable upgrades the whole remedy story.

Today **no error message anywhere in the repo embeds a documentation URL**, a universal
gap this initiative closes alongside the per-message work.

## Target pattern (the reference shapes to copy)

There is no single pilot PR; instead there are six existing good-citizen shapes. Pick by
failure class; do NOT invent a seventh:

1. **`ConfigProblem` + `ENV_HELP` registry**: `backend/packages/server/src/config/problems.ts`.
   For boot-time / configuration failures. `{ key, summary, remedy }` written ONCE in the
   `ENV_HELP` table, thrown via `configProblem(...)` / `requireEnv(...)`, rendered by
   `formatConfigProblems`, and served to the SPA by the misconfigured fallback backend
   (`config/misconfiguredApp.ts`) so the UI can explain what to fix. Only a
   `ConfigValidationError` reaches that screen; wrapping a boot error in it is often part
   of the fix.
2. **Named error class + hint constant + code→cause map**: `backend/runtimes/node/src/db/migrate.ts`
   (`DbSchemaInconsistentError`, `MigrationFailedError`, `RESET_HINT`,
   `explainMigrationFailure`). For wrapping opaque driver/SDK errors: map machine codes to
   a human cause + recovery command, keep the map exported for unit tests.
3. **Keyed `FAILURE_HINTS` maps**: `BootstrapService.ts` / `RunStateMachine.ts` /
   `EnvConfigRepairService.ts`. For agent-run failures: a `Partial<Record<FailureKind, string>>`
   of recovery paragraphs, surfaced as `AgentFailure.hint` and rendered by
   `AgentFailureCard.vue`.
4. **`DomainError.details.reason` + `CONFLICT_REASONS`**: kernel `domain/errors.ts` +
   contracts `errors.ts`, mapped by the SPA's `usePipelineErrorToast.ts`. For any condition
   the frontend should present with translated copy and/or a jump-to-the-right-panel
   action: add a machine reason code, never rely on prose matching.
5. **`PreflightResult.remediation`**: contracts `preflights.ts` +
   `integrations/modules/preflight/PreflightService.ts`. For probe-style prerequisite
   checks: the non-pass verdict carries copy-paste fix instructions.
6. **Structured cause code + extractor + fallback**: the shape for ERROR IDENTITY
   (complementing pattern 4, which covers the HTTP/frontend boundary): a named error
   subclass carrying a machine field consumed via `instanceof` (`GitHubApiError.status`,
   `DomainError.code`, `HarnessFailure.failureCause`), a small extractor helper that
   encapsulates the check (`failureCauseOf` in `executor-harness/src/failure.ts:53`,
   `getErrorReason` in kernel `domain/errors.ts:131`, the duck-typed cross-boundary
   `httpStatusOf` in `integrations/modules/tasks/tasks.logic.ts:56`). When a structured
   producer is guaranteed (a current image / an in-process throw), read the field alone
   (`failureKindFromHarnessCause(cause) ?? 'agent'`, `installationTokenMintStatusOf`) with NO
   message fallback (I5/I7 deleted the `classify*(message)` pairs). Classify errors by these
   fields and typeguards, NEVER by regex/`includes` on the message; see section I for the
   sites still string-matched.

### Doc-URL convention (new; establish in the first slice)

- **In-repo docs** are linked as stable GitHub blob URLs on `main`:
  `https://github.com/kibertoad/cat-factory/blob/main/docs/environment-variables.md` (the
  canonical target for every env-var remedy), `…/blob/main/backend/docs/<topic>.md` for
  topic docs (e.g. `github-operations.md`, `model-support.md`, `auth.md`).
- **Vendor URLs** where the fix lives off-platform: the GitHub App settings/installation
  pages, Datadog API-key pages, Cloudflare dashboard/wrangler docs, AWS Bedrock docs.
- The remedy text must remain self-sufficient without the link: the URL deepens, it never
  replaces, the instruction.
- Centralize repo-doc URL construction in one small helper/constant module (per package
  that needs it) rather than scattering string literals, so a docs move is one edit.
  **Established (A1):** `@cat-factory/server`'s `config/docs.ts` exports `repoDocUrl(path,
anchor?)`, the named `DOCS` helpers (`envVars`, `modelSupport`, `githubIntegration`,
  `githubOperations`, `vcsProviders`, `concurrencyAndRedis`), and the `ENV_VARS_ANCHORS`
  section-slug constants. Extend `DOCS` with a new entry rather than writing a bare
  `https://github.com/.../blob/main/...` literal at a throw site; a package outside the
  server layer adds its own equivalent module. The `ConfigProblem` wire type carries an
  optional `docsUrl` so the misconfigured screen renders it as a link.

### UI-first remedy rule

Many settings are UI-configurable and mostly used that way: provider API keys (the key
pool), personal subscriptions, local model runners, the observability/Datadog connection,
self-hosted runner pools, GitHub connect / repo linking, merge presets, release-health
configs. For those, the error's PRIMARY fix instruction names the UI location (a click
path, and where possible a `details.reason` code the SPA turns into a jump action, the
`usePipelineErrorToast` pattern) and mentions the env var only as the deployment-level
ALTERNATIVE. Env-var-first wording is reserved for genuinely operator/env-only settings
(`DATABASE_URL`, `ENCRYPTION_KEY`, wrangler bindings, and, until H1 lands,
`LITELLM_BASE_URL`).

## Per-item checklist

Severity legend: **P1** = users/operators hit it routinely and the current message is
opaque; **P2** = plausible and confusing; **P3** = nice-to-have polish. Config surface:
**UI** = UI-first remedy applies, **env** = operator/env-only, **n/a** = not a config
issue.

### A. Boot / configuration

| #   | Failure / misconfiguration                                                 | Current behaviour                                                                                                                                                                                                       | Surface | Sev | Proposed fix                                                                                                                                                                                                                                                                                                                                                                                         | Doc URL to embed                                    | Status  | PR       |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------- | -------- |
| A1  | Every `ENV_HELP` remedy lacks a doc URL                                    | Good remedies exist for the 8 keys (`backend/packages/server/src/config/problems.ts:58-107`) but none link docs                                                                                                         | env     | P1  | Add a `docsUrl` (or append the link to `remedy`) to each `ENV_HELP` entry; render it in `formatConfigProblems` + the misconfigured screen                                                                                                                                                                                                                                                            | `docs/environment-variables.md` (per-key anchors)   | ✅ done | #1017    |
| A2  | `ENCRYPTION_KEY` malformed / too short not validated at Node & Worker boot | Fails lazily: bare `encryption key must decode to at least 32 bytes` (`WebCryptoSecretCipher.ts:42`) or an opaque `atob` `InvalidCharacterError`; local mode already validates (`runtimes/local/src/config.ts:103-122`) | env     | P1  | Validate format + decoded length at config load on Node & Worker (mirror local), throw `configProblem` with the existing `ENV_HELP.ENCRYPTION_KEY` remedy                                                                                                                                                                                                                                            | `docs/environment-variables.md`                     | ✅ done | phase 2  |
| A3  | `GITHUB_APP_PRIVATE_KEY` malformed PEM (non-PKCS#1 case)                   | Opaque `crypto.subtle.importKey` failure at first token mint (`GitHubAppAuth.ts:148`); only the PKCS#1 case has a good message (`encoding.ts:35`)                                                                       | env     | P2  | Validate PEM shape at config load; wrap import failures naming the var + the `openssl pkcs8 -topk8` conversion                                                                                                                                                                                                                                                                                       | `backend/docs/github-operations.md`                 | ✅ done | phase 7  |
| A4  | Cloudflare primary `env.DB` binding unbound/misnamed                       | Bare `const db = env.DB` (`runtimes/cloudflare/src/infrastructure/container.ts:2026`) → NPE deep in the first repository call; contrast `requireTelemetryDb` (`env.ts:526`)                                             | env     | P1  | Add a `requireDb`-style guard throwing `configProblem({ key: 'DB', … })` with wrangler `[[d1_databases]]` remedy, mirroring TELEMETRY_DB                                                                                                                                                                                                                                                             | `docs/environment-variables.md`                     | ✅ done | phase 2  |
| A5  | Node facade: container executor prerequisites missing → no boot signal     | `buildContainerExecutor` returns `null` (`runtimes/node/src/container.ts:909,916`); boots "healthy", fails only at dispatch. Worker throws a configProblem (`cloudflare container.ts:424`)                              | env     | P1  | At minimum a boot-time structured warning listing exactly which of `PUBLIC_URL`/`AUTH_SESSION_SECRET`/App creds/transport is missing; consider an opt-in strict mode that fails fast                                                                                                                                                                                                                 | `docs/environment-variables.md`                     | ✅ done | phase 3  |
| A6  | Invalid `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA`                               | Good message but a plain `Error` (`runtimes/node/src/db/client.ts:23-36`) → hard crash, never reaches the misconfigured fallback screen                                                                                 | env     | P2  | Rethrow as `ConfigValidationError` (configProblem) so the fallback screen serves it                                                                                                                                                                                                                                                                                                                  | `docs/environment-variables.md`                     | ✅ done | phase 2  |
| A7  | `REDIS_URL` failure modes                                                  | Missing `ioredis` → good text but a plain Error thrown late in boot (`redisPropagator.ts:37-44`); unreachable host → silent infinite retry, cross-node realtime silently dead (`:55`)                                   | env     | P2  | Wrap the ioredis-missing case as a configProblem; add a connect-timeout probe that logs an elaborate warning (host, likely causes, how to verify) instead of retrying silently                                                                                                                                                                                                                       | `backend/docs/concurrency-and-redis.md`             | ✅ done | phase 12 |
| A8  | Numeric env knobs silently coerce garbage to defaults                      | `num()` in Node config returns `undefined` on garbage → default, no signal (e.g. `JOB_MAX_POLLS=abc`)                                                                                                                   | env     | P3  | Log a structured warning naming the var, the rejected value, and the default used. **Deferred from phase 3:** both facades share the same footgun (Node `config.ts` `num()` + Worker `config/utils.ts` `num()`), so per "keep the runtimes symmetric" this is a two-facade `num(name, value)` plumbing change across ~30 call sites; its own slice, not folded into the localized A5/A9/A10 warnings | `docs/environment-variables.md`                     | ✅ done | phase 15 |
| A9  | `LOCAL_CONTAINER_RUNTIME` unrecognized value silently falls back to docker | `resolveRuntimeId` returns `'docker'` for any unknown value (`runtimes/local/src/containerRuntime.ts:260-264`); preflight logs only the resolved runtime                                                                | env     | P2  | Warn at boot: name the rejected value, the accepted set (docker/podman/orbstack/colima/apple), and the fallback taken                                                                                                                                                                                                                                                                                | `docs/environment-variables.md`                     | ✅ done | phase 3  |
| A10 | Half-set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair             | Silently disables the Cloudflare provider (`runtimes/node/src/config.ts:160`)                                                                                                                                           | env     | P2  | Boot warning naming the one that is set and the one that is missing                                                                                                                                                                                                                                                                                                                                  | `docs/environment-variables.md`                     | ✅ done | phase 3  |
| A11 | localhost→IPv6 `::1` Postgres `ECONNRESET` at boot                         | Raw driver error, process dies; the footgun is documented only in `deploy/local/.env.example:7-10`                                                                                                                      | env     | P2  | Detect `ECONNRESET`/`ECONNREFUSED` on a `localhost` `DATABASE_URL` during `migrate()`/connect and explain the IPv6 resolution issue + the `127.0.0.1` fix                                                                                                                                                                                                                                            | `docs/environment-variables.md`                     | ✅ done | phase 10 |
| A12 | Local mode: invalid (vs missing) `GITHUB_PAT`                              | Missing PAT gets a good boot warning with a pre-scoped token URL (`runtimes/local/src/server.ts:144-150`); an invalid one fails at runtime with raw `GitHub /user/repos failed (HTTP 401)` (`github.ts:167`)            | env     | P2  | Optional boot-time probe (one `GET /user`) that reports invalid/expired/under-scoped with the same pre-scoped creation URL                                                                                                                                                                                                                                                                           | GitHub PAT settings URL (already generated in code) | ✅ done | phase 10 |

### B. Model provisioning

| #   | Failure / misconfiguration                                  | Current behaviour                                                                                                       | Surface | Sev | Proposed fix                                                                                                                                                                                           | Doc URL to embed                | Status  | PR      |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------- | ------- |
| B1  | `Unsupported model provider: X`                             | Terse throw (`backend/packages/agents/src/providers/registry.ts:54`); reaches users raw via the frontend fallback toast | UI      | P1  | UI-first remedy: point at the provider key pool ("Configure AI" / workspace provider keys) as the primary fix, env var(s) as the deployment alternative; consider a `ConflictReason` for a jump action | `backend/docs/model-support.md` | ✅ done | phase 4 |
| B2  | `Unsupported Bedrock model: X`                              | Terse throw (`backend/packages/provider-bedrock/src/index.ts:38-40`); doesn't name the allow-list                       | env     | P2  | Name `BEDROCK_MODELS`, list the allowed models, link docs                                                                                                                                              | `backend/docs/model-support.md` | ✅ done | phase 4 |
| B3  | LiteLLM selected but `LITELLM_BASE_URL` unset               | Falls through to generic B1 (`endpoints.ts:38-43` returns `undefined`, provider never registers)                        | env→UI  | P1  | Dedicated message naming `LITELLM_BASE_URL` (operator-hosted, no public default); flips to a UI-first remedy once H1 lands                                                                             | `docs/environment-variables.md` | ✅ done | phase 4 |
| B4  | `No base URL configured for OpenAI-compatible provider 'X'` | Partial message, no remedy (`backend/packages/server/src/agents/modelProviderResolver.ts:149`)                          | UI/env  | P2  | Name the `${PROVIDER}_BASE_URL` var and (where the key is UI-pooled) the key-pool panel                                                                                                                | `backend/docs/model-support.md` | ✅ done | phase 4 |

### C. GitHub / VCS runtime

| #   | Failure / misconfiguration                               | Current behaviour                                                                                                                                                                                  | Surface | Sev | Proposed fix                                                                                                                                                                                                                                                                                                                                                          | Doc URL to embed                      | Status  | PR       |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------- | -------- |
| C1  | `FetchGitHubClient` raw status dumps                     | `` `GitHub ${method} ${url} → ${status}: ${text}` `` for every non-2xx (`FetchGitHubClient.ts:1258`, PAT path `:354`, GraphQL `:1182`); no 401-revoked vs 403-rate-limit vs 403-scopes distinction | n/a     | P1  | Classify in one place (shared kernel `describeVcsApiError`, `domain/vcs-errors.ts`): 401 → token revoked/expired remedy; 403 + rate-limit headers → wait/App-vs-PAT note; 403 scopes → which scope + where to grant. REST `request()` + PAT `requestWithToken()` routed through it; the synthetic-200 GraphQL path is left as-is (not a raw HTTP-status auth failure) | GitHub token/App settings vendor URLs | ✅ done | phase 5  |
| C2  | Webhook `Invalid signature` 401                          | One-liner (`GitHubWebhookController.ts:26`, `VcsWebhookController.ts:56`); a mismatched webhook secret is a classic self-host setup error                                                          | env     | P2  | Response stays 401-terse (external caller), but LOG an elaborate operator message: configured-secret mismatch, where to compare (GitHub App webhook settings ⇄ deployment secret)                                                                                                                                                                                     | `backend/docs/github-integration.md`  | ✅ done | phase 14 |
| C3  | Installation-token mint failures                         | Terse `Failed to mint installation token for <id> (HTTP <status>)` shape (`GitHubAppAuth`)                                                                                                         | env     | P2  | Map 401 → wrong/rotated App private key; 404 → App uninstalled from the org/repo, with reinstall click path                                                                                                                                                                                                                                                           | GitHub App installation settings URL  | ✅ done | phase 7  |
| C4  | `No connected GitHub repository found for workspace 'X'` | Partial (`ContainerAgentExecutor.ts:1063`)                                                                                                                                                         | UI      | P1  | UI-first: point at the workspace GitHub connect flow / repo linking; App-installation detail second; consider a `ConflictReason` (`github_not_connected` already exists; reuse it here)                                                                                                                                                                               | `backend/docs/github-integration.md`  | ✅ done | phase 5  |
| C5  | `Installation X not found on any configured App`         | Partial (`FetchGitHubClient.ts:199`)                                                                                                                                                               | env     | P3  | Add "the App was likely uninstalled or the workspace points at a stale installation; reconnect GitHub" remedy                                                                                                                                                                                                                                                         | `backend/docs/github-integration.md`  | ✅ done | phase 5  |
| C6  | `FetchGitLabClient` parity                               | Same raw-status pattern as C1                                                                                                                                                                      | n/a     | P2  | Mirror whatever classification C1 lands (401 PAT, 403, project not found), GitLab-flavoured                                                                                                                                                                                                                                                                           | `backend/docs/vcs-providers.md`       | ✅ done | phase 5  |

### D. Container / runner dispatch & observability

| #   | Failure / misconfiguration                                                  | Current behaviour                                                                                                                                                                                                                                                                                                                                       | Surface | Sev | Proposed fix                                                                                                                                                                                                                                                         | Doc URL to embed                     | Status  | PR       |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------- | -------- |
| D1  | `Container dispatch failed (HTTP 404)`                                      | Raw status (`CloudflareContainerTransport.ts:105`, `KubernetesRunnerTransport.ts:93`); the known cause is a stale harness image whose tag wasn't bumped                                                                                                                                                                                                 | env     | P1  | On 404 specifically, append the stale-image explanation: the deployed container image predates this route, so republish with a fresh tag + `pnpm deploy` (per the release rules); land together with I2's `DispatchError` so the status is a field, not parsed prose | `CONTRIBUTING.md` / releases section | ✅ done | phase 8  |
| D2  | Runner-pool HTTP / OAuth / manifest-secret errors                           | Raw `` `Runner pool ${method} → ${status}` ``, `Missing secret 'X'`, `OAuth token request → <status>` (`HttpRunnerPoolProvider.ts:208,248,312,326`)                                                                                                                                                                                                     | UI      | P2  | UI-first: point at Settings → Self-hosted runner pool (re-test connection there); manifest/secret naming as detail                                                                                                                                                   | `backend/docs/` runner-pool doc      | ✅ done | phase 9  |
| D3  | `No runner backend available for workspace 'X'`                             | Plain Error, terse-ish (`cloudflare container.ts:556`)                                                                                                                                                                                                                                                                                                  | UI      | P2  | UI-first: register a pool in Settings → Self-hosted runner pool, or enable Cloudflare Containers (deployment config); make it a `ConflictReason` (reuse `agent_backend_unconfigured`)                                                                                | `backend/docs/` runner-pool doc      | ✅ done | phase 9  |
| D4  | Datadog auth failure                                                        | Raw `HTTP 403` (`DatadogClient.ts:193`); keys are UI-configured                                                                                                                                                                                                                                                                                         | UI      | P2  | On 401/403: "your Datadog API/Application keys were rejected; re-enter them in Integrations → Observability connection"; env vars not mentioned (they don't exist for this)                                                                                          | Datadog API-keys vendor URL          | ✅ done | phase 9  |
| D5  | Every "Test connection" button reports `fetch failed` when nothing answered | Each provider's `testConnection` catch rendered `err.message`, which on Node/undici is the wrapper `TypeError: fetch failed`; the real cause (`connect ECONNREFUSED`, `self-signed certificate`, `getaddrinfo ENOTFOUND`) hangs off `.cause` / an `AggregateError`, and a stopped cluster, an untrusted cert and a firewalled host all read identically | UI      | P1  | One shared kernel helper flattening the cause chain into the exact failure plus a per-cause remedy; wired into every probe (k8s env + runner, the shared HTTP `probeConnection` behind the manifest env/pool providers, Cloudflare, Compose)                         | (none)                               | ✅ done | phase 20 |
| D6  | A pasted ServiceAccount token with a hidden line break                      | undici refuses the header with `TypeError: Invalid header value` at request time; the connect form said nothing and the operator had no way to tell it from a wrong token or a stopped cluster                                                                                                                                                          | UI      | P2  | Classify the paste in contracts, flag it ON THE FIELD before Test is clicked, and refuse the impossible case at the apiserver client (the one boundary every k8s call passes through)                                                                                | (none)                               | ✅ done | phase 20 |

### E. Crypto / credentials

| #   | Failure / misconfiguration                                 | Current behaviour                                                                                                                                   | Surface | Sev | Proposed fix                                                                                                                                                                                                      | Doc URL to embed | Status  | PR      |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------- | ------- |
| E1  | Personal-subscription wrong password on decrypt            | Raw AES-GCM `DOMException` (`WebCryptoPersonalSecretCipher.ts:49`); contrast the exemplary system-cipher wrapper (`WebCryptoSecretCipher.ts:78-83`) | UI      | P1  | Wrap like the system cipher: "the password does not match the one this subscription was sealed under; re-enter it, or delete and re-add the subscription"; keep the 428 `password_required` flow as the UI driver | (none)           | ✅ done | phase 6 |
| E2  | `Invalid secret envelope` (malformed/truncated ciphertext) | Terse (`WebCryptoSecretCipher.ts:62`)                                                                                                               | n/a     | P3  | Name the likely causes (truncated column, mixed encryption keys across environments) + the re-enter-credential remedy                                                                                             | (none)           | ✅ done | phase 6 |

### F. Executor harness: ⚠ every slice here bumps the image tag + the three pins; batch these rows into ONE slice

Any new failure classification added here (F1–F3) extends the harness `FailureCause`
union (a structured code per target pattern 6, never a new string-matched phrase), and
that union change is itself image-affecting, so it batches into the same slice.

| #   | Failure / misconfiguration         | Current behaviour                                                                                                            | Surface | Sev | Proposed fix                                                                                                                                       | Doc URL to embed | Status  | PR       |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------- | -------- |
| F1  | Clone/push auth failures           | Raw git stderr passed through (`git.ts:139-144`): `Authentication failed`, `repository not found`                            | n/a     | P2  | Classify the common stderr shapes → token-expired / App-lacks-access / repo-deleted causes with remedies, keeping the raw stderr as detail         | (none)           | ✅ done | phase 16 |
| F2  | PR/MR open failures                | Raw `Failed to open PR (HTTP <status>)` + `GitHub did not return a PR url` (`git.ts:1020,1026,1078,1084`)                    | n/a     | P3  | Map the common statuses (403 scopes, 404 repo, 422 validation) to causes                                                                           | (none)           | ✅ done | phase 16 |
| F3  | LLM-proxy 401/402/429 during a run | Unwrapped; surfaces only via `agentOutputTail` stderr slice; the good `NEVER_ACTED_CAUSE` covers only the total-failure case | n/a     | P2  | Classify proxy auth/quota/rate-limit into the harness failure vocabulary so the run failure names the cause (key exhausted / quota / rate-limited) | (none)           | ✅ done | phase 16 |

### G. Frontend surfacing

| #   | Failure / misconfiguration                                       | Current behaviour                                                                                                                                                                                       | Surface | Sev | Proposed fix                                                                                                                                                                                                                                                                                                                                     | Doc URL to embed | Status  | PR       |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------- | -------- |
| G1  | 14 title-only `ConflictReason`s show raw backend prose           | `CONFLICT_TITLE_KEYS` maps only titles; description = untranslated backend `message` (`usePipelineErrorToast.ts:43-58`)                                                                                 | n/a     | P2  | Add translated description/remedy keys per reason (+ jump actions where a panel exists); locale parity in ALL catalogs in the same PR                                                                                                                                                                                                            | (none)           | ✅ done | phase 18 |
| G2  | Generic fallback toast surfaces raw backend strings              | Non-conflict errors fall to `error.message` verbatim (`usePipelineErrorToast.ts:248-253`), the funnel for every raw string above                                                                        | n/a     | P2  | Keep raw detail behind a "show detail" disclosure; show a generic translated title; shrink this funnel by moving conditions onto reason codes (the real fix)                                                                                                                                                                                     | (none)           | ✅ done | phase 19 |
| G4  | ~78 inline `error.message` render sites outside the toast funnel | Panels/modals/stores assign the raw prose to a local `error` ref rendered inline (`ApiKeysSection.vue`, `GitHubPanel.vue`, `stores/board/*`, …), the same untranslated-English gap G2 closed for toasts | n/a     | P3  | Adopt G2's `describeGenericFailure` split per site (translated status-class line + the raw detail behind a disclosure). Deliberately NOT batched into phase 19: it is ~78 mechanical component edits with no shared render seam, so it wants its own slice (or a small shared `<ApiFailure>` component first) rather than burying the funnel fix | (none)           | ⬜ todo |          |
| G3  | `AgentFailureCard.failure.hint` rarely populated                 | The card renders `hint` when present, but the backend `FAILURE_HINTS` maps cover few kinds                                                                                                              | n/a     | P2  | Extend the three `FAILURE_HINTS` maps to every `FailureKind`; audit which kinds reach the card hint-less                                                                                                                                                                                                                                         | (none)           | ✅ done | phase 17 |

### H. Provider UI configurability (feature work the UI-first remedies depend on)

Verified 2026-07-11: **none of this exists yet.** The UI key pool (`apiKeyProviderSchema`,
`backend/packages/contracts/src/api-keys.ts:20-32`; `ApiKeysSection.vue`) covers API keys
for openai/anthropic/qwen/deepseek/moonshot/openrouter/litellm, but **no base URL or
credential endpoint is UI-configurable anywhere**. `LITELLM_BASE_URL` is env-only (the
i18n copy even tells the user "set by your deployment operator (LITELLM_BASE_URL), not
here", `en.json` `providers.apiKeys.providers.litellm.step2`; the capability gate
`providerCapabilities.ts:61-79` keeps a UI-connected LiteLLM key unselectable until the
env var is set). Cloudflare Workers AI (`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`/
`CLOUDFLARE_AI_GATEWAY`) and Bedrock (`BEDROCK_REGION` + AWS creds + `BEDROCK_MODELS`,
Node-only) have zero UI surface (Bedrock appears only as a residency-policy checkbox).

**Template & shape:** the per-user "My local runners" panel is the existing UX to copy
(`LocalModelEndpointsPanel.vue` + `stores/localModels.ts` + `LocalModelEndpointService`:
base URL + optional key + test-connection + model discovery). The architectural change is
adding an endpoint/config dimension to the pooled provider-credential model (today the
`ApiKeyService` pool is secret-only): sealed like keys, consulted by
`resolveOpenAiCompatibleBaseUrl` / `baseUrlFor` and the capability gate, with the env var
demoted to deployment-level fallback. Runtimes symmetric (D1 ⇄ Drizzle) + a conformance
assertion, per the standing rules.

| #   | Work item                                                                                                         | Sev | Status  | PR  |
| --- | ----------------------------------------------------------------------------------------------------------------- | --- | ------- | --- |
| H1  | LiteLLM base URL configurable in the UI (alongside its pooled key); `LITELLM_BASE_URL` becomes the fallback       | P1  | ⬜ todo |     |
| H2  | Cloudflare Workers AI credentials (account id + API token + optional AI-gateway) configurable in the UI           | P2  | ⬜ todo |     |
| H3  | Bedrock configurable in the UI (region, credentials, model allow-list); Node-only runtime support                 | P2  | ⬜ todo |     |
| H4  | Optional base-URL override in the UI for the remaining direct/proxy providers (`${PROVIDER}_BASE_URL` → fallback) | P3  | ⬜ todo |     |
| H5  | Revisit B1–B4 / A10 remedies once H1–H4 land so the primary instruction is always the UI path                     | P3  | ⬜ todo |     |

### I. Structured error codes & typeguards instead of string/regex matching

Verified 2026-07-11. Error identity is determined two ways today, and the goal is to make
the structured way the only load-bearing one:

- **Structured (preferred, already end-to-end for harness-owned faults):** the harness
  `FailureCause` union + `HarnessFailure.failureCause`
  (`executor-harness/src/failure.ts:28-55`) rides the wire: harness
  `JobView.failureCause` → kernel `RunnerJobView.failureCause` →
  `AgentExecutorPollUpdate.failureCause` → `AgentFailure.reason`. Consumers prefer it and
  fall back to text only for older images/pools:
  `agentFailureKindFromCause(update.failureCause) ?? classifyAgentFailure(update.error)`
  (`RunDispatcher.ts:965`; same shape in `ContainerRepoBootstrapper.ts:303`).
- **String/regex (to eliminate as the primary channel):**
  - Container **eviction**: ✅ **structured as of I1 (phase 11).** The verdict now rides the typed
    `RunnerJobView.evicted` field (`'crash' | 'transient'`, kernel `ContainerEvictionKind`), minted
    by every transport and read via the `evictionKindOf` extractor (`job.logic.ts`); the consumers
    (`RunDispatcher.recoverContainerEviction`, `ContainerRepoBootstrapper.pollBootstrap`,
    `ContainerEnvConfigRepairer.pollRepair`) prefer the field. The sentinel
    `'Job not found (container evicted or crashed)'` (+ `TRANSIENT_EVICTION_MARKER`) and the
    `isContainerEvictionError` / `isTransientEviction` regexes are PRESERVED as the older-producer
    fallback; deleting them is the image-floor-gated I5. Still-string-only: the K8s
    `waitForPodReady` and inline-job DISPATCH-time eviction THROW an `Error` (no view exists yet),
    so they ride `classifyDispatchFailure`'s string check; a typed dispatch-eviction error is a
    follow-up, not part of I1's `RunnerJobView` scope.
  - **Dispatch failure** is a bare `Error('… dispatch failed (HTTP n): …')` matched by
    `/dispatch failed/i` (`BootstrapService.ts:313,425`, `EnvConfigRepairService.ts:170`).
  - The **watchdog abort phrases** (`failure.ts:63-73`) are regex-matched
    (`/inactivity|no agent activity|max duration/i`) only as the old-image fallback; the
    structured `inactivity-timeout`/`max-duration` causes already cover current images.
  - **Installation-token-gone**: RESOLVED (I7). The shared `reconcileStaleRepos`
    (`isInstallationGoneError` / `isInstallationTokenGoneError`) classifies off the structured
    `InstallationTokenMintError.status` / `GitHubApiError.status` fields, no message parsing. The
    mint wording is free to change.

Compatibility rule for this section: the regex fallbacks guard against OLDER harness
images / runner pools (see the `failureCausePath` older-pool test in
`runner-pool-transport.test.ts:229-235`), so a conversion adds the structured field and
demotes the regex to fallback; deleting the fallback is a separate, image-floor-gated
step (I5). Eviction and dispatch signals are minted by in-repo transports/facades, so those
conversions need NO executor-harness image bump. Extending the harness `FailureCause`
union itself DOES bump the image (batch with the F-slice).

| #   | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Sev | Status                            | PR       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------- | -------- |
| I1  | Structured eviction signal: add a field (e.g. `evicted?: 'crash' \| 'transient'`) to kernel `RunnerJobView` (`ports/runner-transport.ts`), emit it from all four transports (Cloudflare, local `harnessHttp`, `LocalContainerRunnerTransport`, k8s), read via an extractor; regexes become fallback-only. No image bump                                                                                                                                                                | P1  | ✅ done                           | phase 11 |
| I2  | `DispatchError` class (HTTP `status` field) thrown by every transport `dispatch()`; `BootstrapService` / `EnvConfigRepairService` classify via `instanceof` / `isDispatchFailure` instead of `/dispatch failed/i`. Pairs with D1's stale-image elaboration. No image bump                                                                                                                                                                                                              | P1  | ✅ done                           | phase 8  |
| I3  | Quick win: `ContainerEnvConfigRepairer.ts:175` ignores the already-plumbed `view.failureCause`: add `repairFailureKindFromCause(cause) ?? classifyRepairFailure(error)`, matching the bootstrap/execution paths                                                                                                                                                                                                                                                                        | P2  | ✅ done                           | phase 13 |
| I4  | Type the wire: narrow kernel `failureCause?: string` (`runner-transport.ts:226`, `agent-executor.ts:671`, `preview-transport.ts:52`) to a shared cause union so the `*FromCause` mappers are exhaustively checked (`Record`-style drift guard, like the SPA's `CONFLICT_TITLE_KEYS`)                                                                                                                                                                                                   | P2  | ✅ done                           | phase 13 |
| I5  | Once a harness-image floor is acceptable, delete the abort-phrase + eviction-phrase regex fallbacks and drop the "wording MUST stay stable" constraint documented in `failure.ts:5-13`                                                                                                                                                                                                                                                                                                 | P3  | ✅ done (consumer-side; see note) | phase 18 |
| I6  | Codify the first-wrap-point rule for unavoidable third-party text (git stderr → `HarnessFailure('git')` in `gitFailure`, pg driver errors → `pg.code` switch in `explainMigrationFailure` (the reference), kubectl/k3s stderr in `cli/src/k3s-provision.ts:291`): the code is attached exactly ONCE where the text enters our system; nothing downstream re-parses                                                                                                                     | P3  | ✅ done                           | phase 18 |
| I7  | Installation-token-gone classification: attach a structured code where the mint failure enters the system (the App-registry mint path; dovetails with C3's message elaboration), consume via `instanceof`/extractor (`GitHubApiError.status`-style), no message-regex fallback (in-process throw, current installs only). No image bump. Sequence AFTER the reconcile-loop hoist tracked in `system-audit-improvements.md` item 4, which deduplicates the classifier to one site first | P2  | ✅ done                           | phase 18 |

## Conventions & gotchas carried between iterations

- **UI-first remedies** (see the rule above): name the UI location first for anything
  UI-configurable; env vars are the deployment-level alternative only.
- **Keep the runtimes symmetric**: any validation added to one facade (Node ⇄ Worker ⇄
  local) lands in the others in the same change, with a conformance assertion where the
  behaviour is shared.
- **Regex-load-bearing strings must NOT change (interim rule; section I is the real
  fix)**: the eviction sentinels (`CloudflareContainerTransport.ts:20-21`), the abort
  messages (`executor-harness/src/failure.ts:63,71`), and the `classifyBootstrapFailure`
  patterns are matched downstream. Until the corresponding I-item lands and its fallback
  is retired (I5), elaborate AROUND them (structured cause fields, `hint`, appended
  detail); never rewrite the matched phrase. And never ADD a new string-matched
  sentinel: a new failure condition gets a code field + extractor (target pattern 6)
  from day one.
- **The backend never localizes prose.** A new user-facing condition gets a machine
  `details.reason` code in `@cat-factory/contracts`; the SPA maps it to translated copy.
  Adding a `ConflictReason` forces the exhaustive frontend `Record` + every locale catalog
  to update in the same PR (locale-parity CI gate); that is the drift guard working, not
  friction to route around.
- **Extend the existing shapes** (`ENV_HELP`, `FAILURE_HINTS`, `ConfigProblem`,
  `ConflictReason`, `PreflightResult.remediation`); do not invent one-off error string
  formats or a parallel hint mechanism.
- **Facade-symmetric boot validation goes in ONE shared helper** (phase 2 reference:
  `requireEncryptionKey` in `@cat-factory/server` `config/problems.ts`, wired into the Node
  - Worker config loaders and reused by local mode's `requireStableSecret`). When a value
    must be validated identically across facades, add the validator to the server config
    module and call it from each loader rather than re-implementing per facade; that is how
    the message stays identical across Node/Worker/local.
- **Only `ConfigValidationError` reaches the misconfigured fallback screen.** For boot
  errors that today crash with a plain `Error` (A6, A7), wrapping them is itself part of
  the fix.
- **VCS API-error remedies live in ONE shared kernel helper** (phase 5 reference:
  `describeVcsApiError` in `@cat-factory/kernel` `domain/vcs-errors.ts`, called by both
  `FetchGitHubClient` (`@cat-factory/server`) and `FetchGitLabClient` /
  `provisioning.ts` (`@cat-factory/gitlab`)). The two clients live in different packages
  that share only kernel, so the mapping is kept there to stop the providers drifting and
  to unit-test it in one place (`vcs-errors.test.ts`). It PRESERVES the raw
  `<Provider> <method> <url> → <status>: <body>` first line (detectors like
  `RepoReadError`/`readFault` surface it and it stays greppable) and only APPENDS a cause +
  remedy line. Error IDENTITY still rides `GitHubApiError.status` / `GitLabApiError.status`,
  so elaborating the message never changes classification. Kernel sits below the server
  layer so it can't use `config/docs.ts`; per the doc-URL convention it keeps its own
  equivalent (`VCS_DOC_URLS`), so extend that rather than writing a bare blob literal.
- **A domain-error remedy only reaches the SPA if the failure surface propagates its
  `reason`.** C4's `github_not_connected` `ConflictError` is a 409 on the synchronous
  controller start paths, but on the async pipeline it is thrown from `startJob` and caught
  by `RunDispatcher`, which used to reframe EVERY dispatch throw as a container
  `dispatch` failure ("container failed to start"), dropping the reason. `classifyDispatchFailure`
  (`job.logic.ts`) now maps a pre-dispatch `DomainError` to a `preflight` failure that keeps its
  message + `reason`, and `AgentFailureCard` reuses the existing `errors.conflict.title.*`
  key for the title (no new locale keys). Pattern for future UI-surfaced runtime errors: a
  `ConflictError`/reason alone is not enough; check the failure funnel actually carries the
  reason through to `AgentFailure.reason`.
- **Credential-decrypt remedies wrap at the CIPHER (phase 6 reference: E1/E2).** The
  actionable message is attached where the opaque Web Crypto failure enters the system (the
  `open`/`decrypt` catch in `WebCryptoPersonalSecretCipher` / `WebCryptoSecretCipher`
  (`@cat-factory/server`), mirroring the system cipher's existing rotated-key wrapper), NOT
  re-derived at the service call site. Distinguish the two failure modes: a malformed envelope
  (format/corruption) vs an AES-GCM auth failure (wrong password / rotated key). The consuming
  service keeps its machine `reason` code (`wrong_password`) as the UI driver and a clean,
  self-sufficient message rather than nesting the raw cipher text. (Aside surfaced here: the
  `@cat-factory/server` vitest `include` omitted the co-located `src/**/*.test.ts` unit tests,
  so the cipher suites silently never ran; the glob now covers both layouts.)
- **GitHub App auth failures (phase 7 reference: A3/C3).** The App private key's SHAPE is validated
  at config load by the shared `requireGitHubAppPrivateKey` (`@cat-factory/server` `config/problems.ts`),
  called from BOTH facade loaders (Node `loadNodeConfig`, Worker `loadGitHubConfig`) for the default
  AND privileged keys, mirroring `requireEncryptionKey`, so a malformed PKCS#1 / non-base64 / boundary-
  less key reads identically everywhere and lands on the misconfigured screen. Local mode uses a PAT (no
  App), so it is exempt. The installation-token mint remedy is attached at the mint site
  (`explainInstallationTokenMintFailure`, exported for unit test); the wording is now purely for
  humans, because the stale-installation reconcile classifies off the structured
  `InstallationTokenMintError.status` field (I7), not the message, so the cause/remedy prose is free
  to change without affecting the tombstone decision.
- **Container/runner dispatch failures ride a structured `DispatchError` (phase 8 reference:
  D1/I2).** The identity of a `dispatch()` rejection lives in kernel `domain/dispatch-errors.ts`:
  `DispatchError` carries the HTTP `status` as a FIELD, thrown by every transport `dispatch()`
  (`CloudflareContainerTransport`, `KubernetesRunnerTransport`, the local `postHarnessJob` shared by
  both local transports, and `RunnerPoolTransport`, which re-wraps the pool provider's
  `RunnerPoolApiError`, whose `Runner pool … → <status>` wording matched no dispatch check and so was
  mislabelled `preflight`). Consumers classify via `isDispatchFailure(error)` (or `instanceof
DispatchError`, reading `.status`), NOT the `/dispatch failed/i` regex, which is demoted to a
  fallback for any producer still throwing a plain `Error` (no image floor to gate on: the signal
  is minted by in-repo transports, so no
  executor-harness bump). Per the doc-URL convention, kernel keeps its own `DISPATCH_DOC_URLS`
  (sibling of `VCS_DOC_URLS`); extend it rather than writing a bare blob literal. The raw
  `<label> dispatch failed (HTTP n): <body>` first line is PRESERVED verbatim by
  `harnessDispatchFailureMessage` (greppable + regex-fallback-matchable); the D1 404 stale-image
  cause + republish remedy is only APPENDED, and only for a 404 on the harness `/jobs` route (where a
  404 unambiguously means the image predates the route). Pool 404s are NOT given that harness-
  specific remedy (a pool 404 can be a wrong control-plane route), only the structured status.
- **Boot-time connection/credential probes (phase 10 reference: A11/A12).** A boot connectivity
  failure is reframed AT the first-connection point, not re-derived downstream. **A11:** `migrate()`
  (`runtimes/node/src/db/migrate.ts`) is the pool's first connection, so `explainDbConnectionFailure`
  (exported, unit-tested) turns a connection-refused/reset error into the shared
  `ConfigValidationError`, but ONLY for a LOOPBACK host, so a transient REMOTE-database outage still
  crash-and-retries instead of freezing behind the misconfigured screen; the `localhost` name (vs an
  explicit `127.0.0.1`/`::1`) is what triggers the IPv6-`::1` footgun remedy. It unwraps the
  `AggregateError`/`.cause` shapes node-postgres nests the code in. **A12:** local mode's
  `probeGitHubPat` (`runtimes/local/src/github.ts`) does one best-effort `GET /user` at boot (behind
  an `AbortController` timeout, `undefined` on any network error so it NEVER blocks/crashes boot);
  the pure `classifyPatProbe` maps 401→invalid / 403→forbidden / 2xx+`x-oauth-scopes`→under-scoped
  (a fine-grained token reports no scopes, so it is NOT false-warned), and `describePatProbeVerdict`
  reuses the existing `githubPatCreationUrl()` pre-scoped link: the same one-click fix as the
  already-present MISSING-PAT warning. GitLab's equivalent PAT probe (a `GITLAB_PAT`-only local
  deployment) is a deliberate follow-up, not done here: A12 names GitHub only.
- **Structured container-eviction signal (phase 11 reference: I1).** The eviction verdict is a
  typed `RunnerJobView.evicted` field (`ContainerEvictionKind` = `'crash' | 'transient'`, kernel
  `ports/runner-transport.ts`), NOT a string any consumer parses. Every transport that mints an
  eviction VIEW sets it beside the preserved sentinel: the Cloudflare 404/rollout poll, the shared
  local `harnessHttp.pollHarnessJob`, the local container/pool/process/native-routing `!resolved` /
  `!member` / no-leg fallbacks, and the K8s poll 404 (EKS inherits it). It flows through
  `AgentJobUpdate.evicted` (kernel `agent-executor.ts`, forwarded in `ContainerAgentExecutor.pollJob`)
  to the three consumers, which read the single `evictionKindOf(evicted, error)` extractor
  (`job.logic.ts`): field first, the `isContainerEvictionError` / `isTransientEviction` regexes as
  the older-producer fallback. TWO channels stay string-only ON PURPOSE and are NOT in I1's scope: a
  DISPATCH-time eviction is a thrown `Error` (K8s `waitForPodReady`, the inline-job path) with no view
  to carry a field, classified by `classifyDispatchFailure`; and the `PreviewView` / `InlineJobView`
  ports are separate types, left on the sentinel. Because the string is preserved, no facade needs a
  version floor: this bumps no executor-harness image (the signal is minted by in-repo transports).
  Deleting the regex fallback + the "deliberately avoids the phrase" negative-coupling comments is the
  still-open, image-floor-gated I5.
- **Redis-bus failure modes (phase 12 reference: A7).** `REDIS_URL` has two failure shapes and each
  gets the shape that fits. The FATAL one (set but the optional `ioredis` dep absent) is wrapped at
  BOTH Node consumers (`redisPropagator.ts` + `cacheNotifications.ts`) as the shared
  `missingIoredisProblem` (a `ConfigValidationError` naming `REDIS_URL`), so it lands on the
  misconfigured screen identically whichever loads ioredis first; the helper + the `ENV_HELP.REDIS_URL`
  entry live in `@cat-factory/server` only to reuse the shared configProblem shape (Redis is a Node-only
  concern (the Worker coordinates through Durable Objects) so there is NO facade-symmetry obligation
  here). The NON-fatal one (set but the bus unreachable) is a best-effort, timeout-bounded BOOT PROBE
  (`redisProbe.ts` `warnIfRedisUnreachable`, mirroring local mode's A12 `probeGitHubPat`): it logs ONE
  elaborate, CREDENTIAL-FREE warning (the host via `redisTargetLabel`, which strips the URL userinfo, the
  silent degradation, `redis-cli … ping`, the docs) and NEVER blocks/crashes boot; the ioredis
  background retry is the real recovery path, the probe only makes the degradation visible. The probe
  distinguishes `false` (unreachable → warn) from `undefined` (ioredis absent → stay silent, the fatal
  configProblem already covers it). No executor-harness image bump (no harness change). **Gotcha:
  wrap the layered-loader import too, not just the ioredis one.** In `cacheNotifications.ts` the
  ioredis-absent failure actually surfaces FIRST at `loadNotificationFactory`'s root `import('layered-loader')`
  (its root index eagerly requires ioredis, per `appCaches.ts`), which runs before `loadRedis`; and
  `buildCacheNotifications` itself runs before `redisPropagator.start()` at boot. So the raw
  `import('layered-loader')` must ALSO be caught and rethrown as `missingIoredisProblem`: otherwise the
  bare `Cannot find module 'ioredis'` escapes as a non-`ConfigValidationError` and boot crashes opaquely
  before `loadRedis`'s nice error is ever reached.
- **Structured-cause classification is ONE shared kernel mapper (phase 13 reference: I3 + I4).**
  Every job-failure classifier (execution `RunDispatcher`, bootstrap `ContainerRepoBootstrapper`,
  env-config repair `ContainerEnvConfigRepairer`) prefers the harness's structured
  `RunnerJobView.failureCause` via the kernel's `failureKindFromHarnessCause`
  (`kernel/src/domain/harness-failure.ts`), with its per-flow error-string regex demoted to the
  older-producer fallback. The historical per-flow local `*FromCause` copies are GONE: they were
  three identical switches (the once-claimed "target enums differ" rationale only ever held for
  bootstrap; repair and execution always shared `AgentFailureKind`, and the real blocker was just
  that the execution mapper wasn't a public export), and the kernel mapper's coarse
  `'timeout' | 'agent'` result is assignable to BOTH `AgentFailureKind` and
  `BootstrapFailureKind`, so one function serves every flow. The `HarnessFailureCause` union is
  kept in step BY HAND with the two dependency-free container payloads (executor-harness
  `FailureCause`, deploy-harness `DeployFailureCause`, hence the `deploy` member); the
  `Record<HarnessFailureCause, …>` inside the mapper is the drift guard (a new union member with
  no mapping fails typecheck). Untyped producers (the pool's dot-path extraction in
  `HttpRunnerPoolProvider`) narrow through `isHarnessFailureCause`, dropping free-form values to
  the regex fallback. Container eviction stays OUTSIDE the union on purpose (transport-minted,
  `RunnerJobView.evicted`). No image bump: the harness types are untouched; only backend
  consumers changed.
- **Webhook signature-rejection logging keeps the response terse (phase 14 reference: C2).** A
  webhook receiver's caller is the EXTERNAL provider (GitHub/GitLab), not the operator, so the
  `401 Invalid signature` response MUST stay terse; it must not leak why verification failed. The
  elaboration is a side-channel `logger.warn` for the operator watching the logs, NOT a richer
  response body. The message is tailored to the sub-case the controller can distinguish from the
  config + inbound header WITHOUT touching secret bytes, no deployment secret configured
  (`*_WEBHOOK_SECRET` unset → fail-closed), no signature/token header present (the provider-side
  secret isn't set / the caller isn't the provider), or a mismatched signature (the two secrets
  differ). Both receivers share ONE helper (`describeWebhookSignatureRejection` /
  `logWebhookSignatureRejection`, `@cat-factory/server` `src/webhooks/signatureLog.ts`), keyed by a
  `'github' | 'gitlab'` provider so GitHub's HMAC `X-Hub-Signature-256` / "Webhook secret" and
  GitLab's `X-Gitlab-Token` / "Secret token" wording (+ the `github-integration.md` vs
  `vcs-providers.md` doc link) don't drift. Shared server-layer change: both facades pick it up
  with no per-runtime work.
- **Numeric-env-knob rejection warnings live in ONE shared parser (phase 15 reference: A8).**
  The garbage-coercion footgun (`num(env.X) ?? default` silently swallowing `JOB_MAX_POLLS=abc`)
  is closed by the shared `parseNumericEnv(name, value)` (`@cat-factory/server` `config/numeric.ts`):
  a PRESENT-but-un-parseable value emits ONE structured `logger.warn` (var name, rejected value,
  docs link) before returning `undefined`, so the caller's `?? default` still applies but the
  operator now SEES the rejection. Unset/blank stays silent (the default is intended there) and a
  valid value is unchanged, so the resolved config never moves: only the visibility does. Every
  facade's local `num()` delegates to it (Node `config.ts` + `execution/config.ts`, Worker
  `infrastructure/config/utils.ts`, and the Worker's `retentionMs` which threads the var name
  through), so the message reads identically across runtimes. The pure `describeRejectedNumericEnv`
  is split out for unit testing (mirroring `describeWebhookSignatureRejection`). Scope is the
  non-finite case the `num()` helpers own; the sibling `Number(env.X) || default` sites
  (`STALE_RUN_*`, `EXECUTION_DRIVE_EXPIRE_MINUTES`) are a different pattern left as-is. No image
  bump (config-layer only). Two follow-through details, since `parseNumericEnv` warns per call:
  the knobs read at every model-config site (`AGENT_DEFAULT_TEMPERATURE`,
  `AGENT_MAX_OUTPUT_TOKENS`) are parsed ONCE per facade and reused so a garbage value warns once,
  not N times; and Node's retention days now go through a local `retentionMs` helper mirroring the
  Worker's (incl. the `days >= 0` clamp), so a negative override falls back to the default on both
  facades rather than a negative window on Node only.
- **Harness git / PR-open / LLM-proxy failure remedies wrap at the FIRST point the third-party
  text enters the harness (phase 16 reference: F1/F2/F3).** All three are executor-harness faults
  whose only signal is opaque third-party text (git stderr, a REST status body, Pi's `finalError`),
  so each is classified ONCE where it enters (per I6) and the remedy is APPENDED; the raw line is
  preserved as detail, never rewritten. **F1:** `describeGitFailure(stderr)` (`git.ts`) matches the
  auth / repository-not-found / write-permission shapes (404-not-found checked BEFORE the generic
  auth shape, since a private-repo 404 is GitHub's stand-in for "your token can't see it") and keeps
  the `git` cause. **F2:** `describePrOpenFailure(status, provider)` maps 401/403/404/422(GitHub)/
  400(GitLab) to a provider-tailored remedy (GitHub App "Pull requests: write" vs GitLab `api`
  scope; PR vs merge-request noun), keeps the `api` cause and the load-bearing `Failed to open …
(HTTP n)` first line. **F3:** the ONE new structured cause this slice adds: `llm-upstream` (in
  BOTH the harness `FailureCause` and the kernel `HARNESS_FAILURE_CAUSES` union, kept in step by
  hand, mapped to the coarse `agent` kind by the `FAILURE_KIND_BY_CAUSE` drift-guard Record). All
  model traffic rides the proxy, so a terminal `terminalRunError` that `classifyLlmUpstreamError`
  recognises as a proxy 401/403 (auth) / 402 (quota) / 429 (rate-limit) rejects a
  `HarnessFailure('llm-upstream', remedy)` instead of a bare `Error`: the cause flows via
  `RunnerJobView.failureCause` → `AgentFailure.reason`. The three remedies are UI-first (re-enter
  the provider key in the AI key pool / reconnect the GitHub App). All three are executor-harness
  `src/**` changes, so this BUMPS the image tag (`1.43.3`) + the three pins (synced via
  `pnpm sync:image-tags`): the reason F1/F2/F3 were batched into one slice. Deferred (bare `Error`
  → `agent`) for any shape the classifiers don't recognise, so nothing regresses.
- **Board failure hints are exhaustive per PRODUCING union, not per map (phase 17 reference: G3).**
  The audit of the three `FAILURE_HINTS` maps found only ONE genuinely hint-less path: the execution
  engine's `EXECUTION_FAILURE_HINTS` (`RunStateMachine.ts`) omitted `preflight`, which the engine
  DOES produce (a pre-dispatch `DomainError` such as `github_not_connected` → `classifyDispatchFailure`
  → `preflight`), so those failures reached `AgentFailureCard` with `hint: null`. The fix adds the
  `preflight` hint AND retypes the map from `Partial<Record<AgentFailureKind, string>>` to an
  EXHAUSTIVE `Record<AgentFailureKind, string>` (dropping the `?? null` at the render site): the
  engine is the primary producer of the full `AgentFailureKind` union, so a total map is correct and
  the type is now the drift guard (a new kind fails typecheck here), mirroring bootstrap's
  `Record<BootstrapFailureKind, string>`. The OTHER two maps were already safe and are left as-is:
  bootstrap is exhaustive over its narrow `BootstrapFailureKind` alias, and env-config-repair keeps
  `Partial<…> & { unknown }` with a `?? unknown` fallback because it only produces a SUBSET of the
  union (dispatch/preflight/evicted/timeout/agent/cancelled); forcing hints for kinds it never emits
  (environment/job_failed/rejected/…) would add dead, misleading entries. So "extend to every
  FailureKind" means exhaustive over what each flow can PRODUCE, not the full union everywhere. The
  hint is backend prose rendered verbatim by the card (NOT i18n), so no locale-parity work; no image
  bump (orchestration-only). G2 (fallback-toast disclosure) remains open.
- **The FIRST-WRAP-POINT rule: attach the structured code exactly once, at the boundary (phase 18
  reference: I6).** Unavoidable third-party TEXT (git stderr, a pg driver error, kubectl/k3s stderr,
  a REST status body) is classified ONCE, where it first enters our system, into a named error
  carrying a machine field; nothing downstream re-parses that text. The three reference wrap points:
  git stderr → `HarnessFailure('git')` in `gitFailure` (executor-harness `git.ts`), pg errors →
  the `pg.code` switch in `explainMigrationFailure` (`runtimes/node/src/db/migrate.ts`; the
  canonical reference), kubectl/k3s stderr → `ProvisionError` in `runOrThrow`
  (`cli/src/k3s-provision.ts`). All three already conformed, so I6 was a codification, not a fix.
  The rule generalizes the per-class notes already in this section (E1/E2 "wrap at the cipher",
  C3 "attach at the mint site", F1/F2/F3 "wrap at the FIRST point the text enters"): downstream
  consumers classify by the field/typeguard (`failureCause`, `.status`, `pg.code`), NEVER by
  re-`includes`/regex on the message; a message is for humans, a field is for code. A new
  boundary that ingests third-party text adds its OWN single wrap point rather than teaching a
  distant consumer to parse the prose.
- **Structured installation-token-gone code (phase 18 reference: I7).** The token-mint failure now
  throws a named `InstallationTokenMintError` (carrying the HTTP `status` as a field), wrapped
  ONCE at the mint site in `GitHubAppAuth.mintInstallationToken`; the first-wrap-point rule
  applied (the App JWT → `/access_tokens` call is not a `VcsClient` request, so it never routes
  through `describeVcsApiError`; this is its dedicated boundary). The reconcile pass
  (`reconcileStaleRepos.ts`) classifies via `installationTokenMintStatusOf(error)`: an `instanceof`
  extractor DELIBERATELY specific to the mint error, so a repo-level 404 `GitHubApiError` (also
  `status`-bearing) can never be mistaken for a gone installation. The log-level classifier
  (`isInstallationGoneError`) additionally reads the repo-level `GitHubApiError.status` structurally,
  so a deleted repo (404) still logs at warn without any message parsing. Both errors throw
  in-process to the reconcile catch, so `instanceof` is authoritative: there are NO message-regex
  fallbacks (the old-producer / boundary-crossed-as-plain-text path was dropped: we target current
  installations only). The elaborated remedy text (C3) is free to change without breaking
  classification. No image bump (no harness change).
- **String-fallback classifiers deleted (phase 18 reference: I5).** With the structured
  `RunnerJobView.evicted` field (I1) and the harness `failureCause` (I3/I4/F3) now minted by every
  in-repo transport / current image, the error-string fallbacks they superseded are removed:
  `classifyAgentFailure` / `classifyBootstrapFailure` / `classifyRepairFailure` are gone (the three
  `failureKindFromHarnessCause(cause) ?? classify*(error)` sites default to the coarse `'agent'`),
  and `evictionKindOf`'s string fallback (plus `isTransientEviction` + `TRANSIENT_EVICTION_MARKER`)
  is dropped; the poll-time eviction verdict reads the `evicted` field directly. Both are
  backend/runtime-only (no image bump); a self-hosted pool / old image that reports neither field
  now coarsens a watchdog timeout to `agent` rather than mislabelling it: the accepted cost of the
  image floor. **KEPT on purpose:** `isContainerEvictionError`, because a DISPATCH-time eviction
  (K8s `waitForPodReady`, the inline-job path) throws an `Error` with no job view to carry the
  field: it is the sole remaining eviction string test and is NOT a fallback. **Deferred:** the
  matching comment cleanup in executor-harness `src/failure.ts:5-13` (the now-stale "wording MUST
  stay stable / regex-matched by `classifyBootstrapFailure`" note): editing harness `src/**` trips
  the path-based image-tag guard, forcing a byte-identical image republish + 3-pin bump for a
  comment-only change, so it is left to ride the next real harness image bump. The abort-message
  wording is nonetheless now free to change: no backend classifier reads it.
- **The generic funnel describes from the STATUS CLASS; raw prose is DETAIL (phase 19 reference:
  G2).** `usePipelineErrorToast` is where every non-409 failure lands, and it used to put the
  backend's `message` straight into the toast description, so a non-English user read English, an
  internal 500 was reported as the fixed `Internal server error`, and a request-validation 400 said
  `Request failed validation` while its `issues` (the only informative part) were dropped. The split
  now is: the DESCRIPTION is translated copy keyed off `error.code` through
  `GENERIC_DESCRIPTION_KEYS`, and the untranslated DETAIL (the prose, the `issues`, and the
  envelope's `requestId`) is revealed in place by a "Show details" action. Four things about it
  matter for anything new:
  - **The status class is now a CONTRACTS vocabulary, not a kernel one.** `DOMAIN_ERROR_CODES` /
    `API_ERROR_CODES` live in `@cat-factory/contracts` and kernel's `DomainErrorCode` is derived
    from the first (mirroring how `ConflictReason` already worked), so the exhaustive
    `Record<Exclude<ApiErrorCode, 'conflict'>, string>` in the SPA is a real drift guard: adding a
    status class without frontend wording fails the typecheck. `API_ERROR_CODES` adds `internal`,
    which is NOT a `DomainError` (`handleError` mints it for an unexpected fault) so a client
    mapping only the domain codes silently misses every 500. `conflict` is excluded because
    `parseConflict` intercepts it upstream; wording it would be dead copy in ten locales.
  - **The prose is kept, not dropped.** Eighteen phases of this initiative went into making those
    backend messages good (a `configProblem` remedy, `describeVcsApiError`'s appended cause, a
    harness `HarnessFailure` remedy). Hiding them behind a disclosure is the point: a raw string
    must not be the FIRST thing a user reads, and it must still be one click away.
  - **`requestId` finally has a UI.** `handleError` has stamped every envelope with the correlation
    id since request logging landed, precisely so "a user can quote the id off a failed request",
    and the SPA had never rendered it anywhere. The detail disclosure is where it belongs.
  - **"Nothing answered" and "something answered unrecognisably" are separate verdicts**
    (`network` vs `unexpected`), decided by whether an HTTP status exists at all: the remedies are
    opposites (check your connection vs the server is broken), so folding them would be exactly the
    degrade-loudly failure this repo bans elsewhere. The reveal is a `toast.update` of the SAME
    toast (never a second one, which would leave two readings on screen disagreeing) and must pass
    `actions: []` explicitly, because `update` MERGES over the existing toast and would otherwise
    leave a now-dead button. No image bump, no backend behaviour change (types + SPA only).
- **A probe that never got an ANSWER is described from the CAUSE CHAIN, not from `err.message`
  (phase 20 reference: D5).** Every "Test connection" button ends in a `fetch` that either answered
  (an HTTP status each provider already maps) or threw, and the threw half is now kernel's
  `describeConnectionFailure` / `connectionFailureResult`
  (`kernel/src/shared/connection-failure.logic.ts`), the sibling of `describeVcsApiError` and kept
  in kernel for the same reason: the probes live in packages that share only kernel. Four things
  about it bind anything new:
  - **`error.message` is the WRONG field on Node.** undici wraps every transport failure in a
    generic `TypeError: fetch failed` and puts the real failure on `.cause`, or on an
    `AggregateError`'s `.errors` when the host resolves to several addresses (`localhost` giving
    both `::1` and `127.0.0.1` is the local-k3s norm, and "refused on one, never attempted on the
    other" is a different diagnosis from "refused on both"). Both are walked; the `fetch failed`
    wrapper is dropped whenever something more specific exists.
  - **The DETAIL and the HINT are separate, and only the detail is unconditional.** The cause is a
    closed union (`refused` / `dns` / `timeout` / `aborted` / `unreachable` / `reset` / the four TLS
    splits / `invalid-header` / `unknown`) matched on the transport `code`, and `unknown` is a real
    member: an unmatched chain is reported verbatim with NO hint, because a guessed remedy for an
    unrecognised failure sends the operator somewhere wrong. Callers pass a `subject` noun so the
    hint names what was probed rather than "the server". A cause pair whose remedies DIVERGE is two
    members, never one: an `AbortError` is a cancelled request, and reporting it as a `timeout` sent
    the operator to inspect firewalls over a request that was never allowed to finish.
  - **The CAUSE is what a localized surface renders; the prose is the detail beside it.** The union
    lives in **contracts** (`connectionFailureCauseSchema`) and rides the wire on
    `ConnectionTestResult.failureCause`, so the SPA states the failure class in the operator's own
    language (`CONNECTION_FAILURE_CAUSE_KEYS` → `settings.providerConnection.test.causes.*`) and
    keeps the English account underneath, which is where the concrete host and remedy live. Every
    probe answers through `connectionFailureResult`, not a hand-built `{ ok: false, message }`,
    because a literal structurally cannot carry the machine-readable half: the same argument as
    `handleError` owning the HTTP error envelope. Absent and `unknown` are different facts (no
    transport cause at all, i.e. the probe got an ANSWER, vs. a chain that matched nothing).
  - **Specificity runs INNERMOST-first, and a message match never outranks a code.** undici wraps a
    mid-handshake `DEPTH_ZERO_SELF_SIGNED_CERT` in a `SocketError` whose own `UND_ERR_SOCKET` is
    itself a recognised cause, so taking the first match in walk order answered with the wrapper and
    told the operator to hunt for a proxy instead of pasting a CA bundle. The one code-less cause
    (`invalid-header`) is matched on the runtime's whole wording and only after every link failed to
    yield a code: a bare `invalid character` also matches Go's JSON decode error, which is what a
    kube-apiserver or an intercepting proxy answers with when something returns HTML.
  - **Scrub before capping, and say what the cap dropped.** `redactSecrets` runs on the whole
    rendered chain and only then is it capped, because a secret sliced in half matches none of the
    shape rules (a JWT cut after its second segment, a `bearer` token cut under the rule's minimum
    run). The cap appends the dropped character count, since a silent slice reads exactly like a
    complete chain. The probed `target` needs its own scrub: it comes from the caller's config
    rather than from the error, and a base URL may legitimately carry `user:secret@` userinfo.
  - **The hints are written for the connect FORM.** They end in "then test again", so a caller with
    no Test button (the teardown-verification `reason`) takes `describeConnectionFailure(...).detail`
    and leaves the remedy behind.
  - **Only a SCREAMING_SNAKE `code` is appended to the detail.** Our own `DomainError`s reach these
    same catch blocks and carry a lowercase status class (`validation`), which identifies nothing
    about a connection and rendered as a baffling `(validation)` glued onto a finished sentence.
  - **`redactSecrets` will mangle a message ABOUT a token.** The scrub drops the run of characters
    after a bare `token`/`bearer`, so a refusal whose own prose says "token contains …" comes out
    with a `[REDACTED]` hole in the advice. Word around it (`token ('apiToken') contains …`) and
    assert the real wording survives the scrub, as `connection-failure.logic.test.ts` does.
- **A credential that cannot become a header is refused at the header boundary, and flagged on the
  field first (phase 20 reference: D6).** The shape rule for a pasted k8s ServiceAccount token is
  `classifyServiceAccountToken` in **contracts**, not kernel, because BOTH sides must agree about
  the answer and the SPA cannot see kernel; the SPA owns the prose (three locale keys under
  `settings.providerConnection.serviceAccountToken`), per the standing "backend never localizes"
  rule. Two things generalize:
  - **Severity is part of the verdict.** Whitespace INSIDE the token is impossible (no bearer token
    has it, no HTTP header can carry it) so it blocks Test/Save and is refused server-side; a
    still-base64 `.data.token` value and a non-JWT shape are only SUSPICIOUS (a `--token-auth-file`
    apiserver accepts arbitrary static tokens) so they render as an overrulable amber hint. A check
    that cannot be sure must never be the thing that blocks a legitimate cluster.
  - **The enforcement point is `KubernetesApiClient.fetch`**, the single place the token becomes an
    `authorization` header, so env + runner and probe + provision are all covered by one guard with
    no new registry seam. It throws a `ValidationError` with a `service_account_token_whitespace`
    reason rather than letting undici answer with an opaque `Invalid header value`.
  - **A guard that judges a NORMALISED value must be where the normalising happens.** The classifier
    judges the TRIMMED token, on the stated premise that surrounding padding is stripped before use,
    so the client trims at the same line it builds the header from: reading the guard's verdict while
    sending the raw value let a token with a trailing newline pass as fine and then die in undici
    with the very error the guard replaces.
- **Executor-harness changes bump the image tag** + the three hand-maintained pins
  (`deploy/backend/package.json`, `deploy/backend/wrangler.toml`,
  `RECOMMENDED_HARNESS_IMAGE`): batch all F-rows into one slice to pay that cost once.
- **Changesets**: one per touched versioned package; empty changeset for docs-only slices.
- Boot warnings for non-fatal conditions (A5, A8–A10) should be single structured log
  lines with the var name, the rejected/missing value, and the consequence: greppable,
  not multi-line prose.
- **Provisioning docs helper (B-slice):** `@cat-factory/agents` sits BELOW the server layer,
  so it cannot use `@cat-factory/server`'s `config/docs.ts`. Per the doc-URL convention it has
  its own `providers/docs.ts` (`MODEL_SUPPORT_DOCS`), which `@cat-factory/provider-bedrock`
  imports for B2. The server-layer B3/B4 wording lives in one shared helper
  (`server/src/agents/providerErrors.ts` `openAiCompatibleBaseUrlError`) so the INLINE resolver
  (`modelProviderResolver.ts`) and the container LLM proxy (`LlmProxyController.ts`) explain a
  missing base URL identically. B3 (litellm) is handled at that base-URL site when a litellm key
  IS pooled but `LITELLM_BASE_URL` is unset; a litellm ref with NO pooled key still lands on B1's
  (now elaborated) message, which lists litellm among the UI-configurable providers. The B1 remedy
  derives that provider list from `UI_CONFIGURABLE_DIRECT_PROVIDERS` (`agents/providers/endpoints.ts`,
  = the built-in OpenAI-compatible endpoints + `anthropic` + `litellm`) rather than re-listing the
  vendors inline, so adding a vendor to `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` keeps the error text in
  step automatically: do NOT re-hardcode the vendor names at the throw site.

## Out of scope

- The deliberate 404→`null`/`[]` swallows in `FetchGitHubClient` (`getRepoById`,
  `branchHeadSha`, `getFileContent`, …): by-design absence handling, not errors.
- Internal invariant errors users cannot trigger (e.g. `ContainerAgentExecutor` missing
  workspaceId/executionId).
- `RunContendedError`: an internal control-flow signal, deliberately not a `DomainError`.
- Backwards compatibility of error message text: pre-1.0, messages may change freely
  except the regex-load-bearing strings named above.
