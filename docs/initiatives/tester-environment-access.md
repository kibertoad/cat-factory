# Tester environment access: standardized coordinates + per-service test-credential pools

> **Scope note (extended).** The original initiative (Slices A + B) covered the mechanical
> coordinates and the **non-sensitive** test-credential pools. It has since grown two more
> slices, driven by the need to test third-party integrations: **Slice C — sealed SENSITIVE
> test credentials** (a 3rd-party API token a Tester needs, delivered out of band), and
> **Slice D — the Test Data Seeder agent** (checks/seeds test data before the Tester, with a
> human-intervention park loop). Slice C is the SEALED counterpart of Slice B and shares its
> per-service-frame model; Slice D consumes BOTH cred stores.

## Goal & rationale

A Tester run aborted with _"Ephemeral environment not provided/reachable — searched process
env, session-env, project context … no deployed URL or credentials found."_ The Tester agent
has no reliable way to learn **where** the environment is or **who** it can log in as. Two
distinct root causes, addressed in two independent slices:

1. **The mechanical coordinates were half-delivered and unstandardized.** `environmentSection()`
   (`backend/packages/agents/src/agents/prompts/standard.ts`) rendered the ephemeral env URL +
   status + auth _scheme_ into the tester prompt and told the agent credentials were _"provided
   to the test harness out of band"_ — but **nothing delivered them out of band**. The promise
   was empty, and there was no standard host/port shape.
2. **There was no concept of app-level test users.** A provider like Kubernetes has **zero
   knowledge** of the login accounts on the provisioned infra — those come from data seeds.
   `EnvironmentAccessHandle` describes how to _reach the endpoint_ (ingress bearer/basic), not
   how to _log into the app under test_. So the Tester needs a new, per-service source of test
   login credentials.

**Intended end state:** every provider surfaces standardized coordinates (`url` / `host` /
`port` / `scheme`) that reliably reach the Tester, plus the full endpoint access credentials;
and each service can declare **credential pools** of test users the Tester is told about and can
authenticate as.

**Key constraint (owner decision):** both the endpoint access handle and the credential pools
are **test-environment data, explicitly NOT sensitive.** They are stored, rendered into the
prompt, and shown in telemetry as ordinary non-secret data. The agent cannot authenticate
without them reaching the model regardless of channel, so there is **no out-of-band / redaction
machinery** — they go straight into the prompt. The Part B UI must state this unmistakably so
nobody enters real/production secrets.

## Target pattern (reference implementations)

- **Coordinate derivation** (Slice A): `deriveEnvironmentCoordinates(url)` in
  `backend/packages/agents/src/agents/prompts/standard.ts` — a pure URL→`{host,port,scheme}`
  parser with scheme-default ports. Lives in `agents` (not `kernel`) because `kernel`'s TS lib
  is ES2022-only and has no `URL` global; `agents` carries the DOM lib. Rendered by
  `environmentSection()`, unit-tested in `environment-section.test.ts`.
- **Per-service config** (Slice B): mirror the release-health per-block config —
  `ReleaseHealthService` + `ServiceReleaseHealthConfig.vue` + `stores/releaseHealth.ts`, resolved
  up the frame chain via `AgentContextBuilder.resolveServiceFrame`. **Difference:** the pools are
  a **plain JSON column, NOT sealed** (`observability_connections` uses `SecretCipher`; these do
  not — they are non-sensitive by contract).

## Conventions & gotchas carried between iterations

- The tester prompts (`tester-api` / `tester-ui`) are **not** in `PROMPT_VERSIONS`
  (`agents/kinds/versions.ts`) — they resolve to version 1 as bespoke kinds — so editing their
  text needs **no version bump** (the bump rule applies only to prompts listed there).
- `kernel` is ES2022-only (no DOM/Node lib): `new URL(...)` does not typecheck there. Put
  URL-parsing helpers in a DOM-lib package (`agents`/`server`/`integrations`).
- Slice B must land **both** runtimes (D1 + Drizzle) + a conformance assertion in the same
  change (CLAUDE.md "Keep the runtimes symmetric").
- Pre-existing (unrelated) `@cat-factory/server` **test-file** typecheck errors exist on `main`
  (`WebCryptoSecretCipher.spec.ts`, `ensureWorkBranch.spec.ts`, `web-search-upstreams.spec.ts`) —
  not caused by this work.
- **Slice C frontend (`fe`): the panel is a FULL-SET-REPLACE editor, by construction.** The
  backend `set` replaces the whole sealed blob and values are write-only (`GET` returns only
  key + description refs, never a value), so `ServiceTestSecrets.vue` can't do per-entry edits:
  it prefills the row list from the configured refs (values blank) and PUTs the entire set on
  save. Save is disabled until EVERY row has a value, so an existing secret can never be blanked
  by accident — but adding one secret means re-entering the others' values. This is faithful to
  the shipped contract, not a bug. If that re-entry cost bites, the clean fix is a BACKEND slice:
  make `value` optional-on-update and merge-by-key server-side (omitted value ⇒ keep the sealed
  one), mirrored on both runtimes + a conformance assertion — not a frontend workaround.

## Status checklist

### Slice A — Standardized coordinates + full endpoint access in the tester prompt (prompt-only)

| Unit                                                                                    | Status | PR   |
| --------------------------------------------------------------------------------------- | ------ | ---- |
| Tracker document                                                                        | done   | PR 1 |
| `deriveEnvironmentCoordinates` helper (agents)                                          | done   | PR 1 |
| `environmentSection()` renders url/host/port/scheme + full access (bearer/basic/header) | done   | PR 1 |
| Rewrite misleading "must not be sent to the LLM" comment                                | done   | PR 1 |
| Tighten tester system-prompt + `testerEnvironmentSection` wording                       | done   | PR 1 |
| Unit test `environment-section.test.ts`                                                 | done   | PR 1 |
| Changeset (`@cat-factory/agents`)                                                       | done   | PR 1 |

### Slice B — Per-service test-credential pools

| Unit                                                                                                                                                       | Status | PR  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| Contracts: `TestCredentialPool` / `TestCredentialEntry` / `ServiceTestCredentials` (incl. `authMode: 'none' \| 'pools'`) + Valibot + upsert input          | todo   | —   |
| Kernel port `TestCredentialsRepository` (`getByBlock`/`upsert`/`deleteByBlock`)                                                                            | todo   | —   |
| D1 migration + `D1TestCredentialsRepository` (cloudflare)                                                                                                  | todo   | —   |
| Drizzle schema + migration + `DrizzleTestCredentialsRepository` (node)                                                                                     | todo   | —   |
| `TestCredentialsService` (orchestration) + controller (server) `GET\|PUT\|DELETE /workspaces/:ws/services/:blockId/test-credentials`                       | todo   | —   |
| Wire repo in all facades (Worker/Node/local)                                                                                                               | todo   | —   |
| `AgentContextBuilder.resolveTestCredentials` (walk to service frame) + `AgentRunContext.testCredentials`                                                   | todo   | —   |
| `testCredentialsSection()` prompt (tester kinds) — `authMode:'none'` → "no login required"; `'pools'` → full pools — wired into `renderStandardUserPrompt` | todo   | —   |
| Cross-runtime conformance assertion (agent-context renders pools on both stores)                                                                           | todo   | —   |
| Frontend: `stores/testCredentials.ts` + `ServiceTestCredentials.vue` inspector panel (incl. "service needs no auth" toggle)                                | todo   | —   |
| **Explicit non-sensitive warning banner** (its own i18n key) + i18n keys in all locales                                                                    | todo   | —   |
| Changesets (per touched published package)                                                                                                                 | todo   | —   |

### Slice C — SENSITIVE test credentials (sealed; delivered out of band)

The SEALED sibling of Slice B, for a genuinely secret testing credential (e.g. a third-party
API token a Tester needs to exercise an integration). Unlike the Slice B pools, these are
**sealed at rest** by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
`observability_connections`) and delivered to the Tester container **out of band** — the value
is decrypted at dispatch and injected as a container **environment variable** the agent's shell
reads (`$KEY`); it is **never** rendered into the prompt text or the redacted telemetry snapshot
(it rides a dedicated top-level job-body field, which the snapshot allow-list omits — the same
mechanism as `packageRegistries`). The tester prompt advertises only each secret's **key +
description** (the non-secret `TestSecretRef`), so the agent knows which env vars exist and what
each is for. Per-service-frame + frame-chain resolution, exactly like Slice B / release-health.

**Target pattern:** `observability_connections` for the sealed-blob + non-secret-summary shape;
`release_health_configs` for the per-service-frame keying; `packageRegistries` on the
`ContainerAgentExecutor` job body for the out-of-band, snapshot-omitted delivery channel.

| Unit                                                                                                                                                     | Status | PR   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| Contracts: `TestSecretEntry`/`TestSecretRef`/`ServiceTestSecretsView` + upsert input + `test-secrets` route contracts                                    | done   | this |
| Kernel port `TestSecretsRepository` (`getByBlock`/`listByWorkspace`/`upsert`/`deleteByBlock`) + `AgentRunContext.testSecrets` (refs only)                | done   | this |
| `TestSecretsService` (integrations, `cat-factory:test-secrets`) + `TestSecretsController` (server) `GET\|PUT\|DELETE .../services/:blockId/test-secrets` | done   | this |
| D1 migration `0044_test_secrets` + `D1TestSecretsRepository`                                                                                             | done   | this |
| Drizzle `testSecrets` table + migration + `DrizzleTestSecretsRepository`                                                                                 | done   | this |
| Wire repo + cipher + service in Worker + Node (local inherits) + attach `ServerContainer.testSecrets`                                                    | done   | this |
| `AgentContextBuilder.resolveTestSecretRefs` (frame walk, refs) → `context.testSecrets`; `testSecretsSection()` prompt (tester kinds)                     | done   | this |
| Executor `resolveTestSecrets` (values) → tester job body `testSecrets`; harness injects as env vars (reserved-name guard + redaction) + image bump       | done   | this |
| Cross-runtime conformance assertion (seal via API, read-back refs, no values leak) on both stores                                                        | done   | this |
| Frontend: `stores/testSecrets.ts` + `ServiceTestSecrets.vue` inspector panel (SENSITIVE warning banner) + i18n in all locales                            | done   | fe   |
| Changesets (per touched published package)                                                                                                               | done   | this |

### Slice D — Test Data Seeder agent (follow-up; NOT in this PR)

A new agent kind (`test-data-seeder`) placed IMMEDIATELY before the Tester in every build
pipeline. It uses BOTH the non-sensitive pools (Slice B) and the sealed secrets (Slice C) to
check whether the system under test holds enough test data and whether the available UI/API
lets it seed more. If it can seed, it does and records what exists; if it CANNOT, it requires
**human intervention** — it explains what data it needs, raises a notification, and PARKS until
a human confirms the data was seeded manually, then resolves and advances to the Tester. Its
result (a summary of available test data) is threaded to the Tester as a prior-output context.

- **Reference pattern for the human-park loop:** `HumanTestController`
  (`orchestration/.../execution/HumanTestController.ts`) — a non-LLM engine step where a human
  is the verdict: fresh entry parks (`parkStepOnDecision`) + raises a notification; a REST action
  re-arms the run (`instance.status='running'`) and `workRunner.signalDecision(...)`; the durable
  driver re-enters and consumes the pending action. Also see the gate machinery
  (`RunDispatcher.evaluateGate`/`pollGate`, `awaiting_gate`).
- **Container agent kind:** a `container-*` kind registered via `registerAgentKind`
  (`AgentKindRegistry`), with a harness handler that runs the seeding against the provisioned env
  using the injected creds — OR a hybrid (deterministic pre/post-ops over `RepoFiles` + an LLM
  step). Placed after `deployer`, before `tester-api`/`tester-ui`, in each `seedPipelines()`
  built-in (bump each pipeline `version`); it must precede every env-consumer.
- **Seeding intel (owner decision, this PR):** the "what test data would be useful for THIS task"
  guidance comes from **extending the Researcher** — add a "test data needs" section to its
  output; the Seeder reads it from `priorOutputs`. (Chosen over a dedicated analyst step to reuse
  an existing pipeline stage.)
- **Output → Tester context:** on resolve, set `step.output` to a description of the available
  test data (`recordStepResult`); the engine folds every prior step's `output` into
  `context.priorOutputs`, so the Tester receives it automatically.
- Both cred stores (B + C) are resolved into the seeder dispatch the same way the Tester now
  resolves Slice C (out-of-band values for the sealed set; in-prompt pools for Slice B).
