# Tester environment access: standardized coordinates + per-service test-credential pools

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
