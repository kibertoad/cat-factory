# Handover — Kubernetes ephemeral environment provider

Branch: `feat/kubernetes-ephemeral-environments` (NOT committed yet — work is in the working tree).
Plan: `C:\Users\kiber\.claude\plans\implement-kubernetes-based-ephemeral-env-iridescent-blum.md`

## Goal

Add a Kubernetes-based ephemeral-environment provider that deploys operator-authored
k3s/Kubernetes manifests into a per-PR namespace, reusing the Kubernetes runner backend's
apiserver client, and selected per-workspace through a backend registry that mirrors the
runner-pool backends.

## Key design decisions (confirmed with the user)

- Selection = registry + `kind` discriminator (mirror `runner-backends.ts`); `manifest` and
  `kubernetes` coexist, chosen per workspace at connect time.
- Provisioning = apply an operator manifest set into a per-PR namespace (server-side apply);
  teardown deletes the namespace. Manifests read checkout-free from the PR repo (co-located)
  OR a separate repo.
- URL = operator chooses: `ingressTemplate` (host template) or read back Service/Ingress
  status (k3s Traefik / ServiceLB).
- Local mode can point at an existing local k3s (widened env URL policy). Managed local-k3s
  lifecycle is documented as a future follow-up only (no code).
- DEVIATION from the plan, flagged + accepted: the `EnvironmentProvider` PORT was kept
  intact (NOT refactored to drop `manifest`). The stored connection still persists an
  `EnvironmentManifest`; the K8s config rides its `providerConfig` (the sanctioned
  native-adapter storage path). This kept the blast radius tractable.
- The old public injection seam (`buildNodeContainer/startLocal({ environmentProvider })`)
  was REMOVED (user-approved); native adapters now register via `registerEnvironmentBackend`.
  An INTERNAL `CoreDependencies.environmentProvider` override remains, used ONLY by the
  conformance suite (fake validate-repo / repair providers) — not a public seam.

## What is DONE (backend complete + green)

All backend source builds (22/22) and the changed backend packages typecheck clean
(integrations, kernel, contracts, server, worker, node-server, local-server, conformance).

- Contracts (`backend/packages/contracts/src/environments.ts`): `kubernetesEnvironmentConfigSchema`
  (apiServerUrl, caCertPem?, insecureSkipTlsVerify?, namespaceTemplate?, manifestSource
  variant colocated|separate, url variant ingressTemplate|ingressStatus|serviceStatus,
  imageTemplate?, defaultTtlMs?, labels?, annotations?), discriminated
  `environmentBackendConfigSchema` (manifest|kubernetes), `KUBERNETES_ENV_TOKEN_SECRET_KEY`.
  `registerEnvironmentProviderSchema` + `testEnvironmentConnectionSchema` now take `{config}`;
  `environmentConnectionSchema` gains `kind` + `config?`. Kernel re-exports the new types.
- Reuse: extracted `KubernetesApiClient` (`backend/packages/integrations/src/modules/kubernetes/
  KubernetesApiClient.ts`) — bearer token + undici TLS dispatcher + safeText — and refactored
  `KubernetesRunnerTransport` to delegate to it (behaviour-identical). Generalized
  `kubernetes.logic.ts`: `k8sName(value,prefix,...)` (podName now uses it), exported
  `labelValue`, added `classifyDeploymentReadiness`, widened `apiBase` param.
- New provider: `KubernetesEnvironmentProvider.ts` + pure `kubernetes-environment.logic.ts`
  (namespace render, kind→resource-path allow-list, multi-doc YAML parse + templating, SSA
  apply, URL derivation). Added `yaml` dep to integrations.
- Registry: `environment-backends.ts` (`registerEnvironmentBackend` / `environmentBackend` /
  `registeredEnvironmentBackendKinds` / `findRepairCapableProvider`) with built-in
  `manifest` + `kubernetes` backends. Exported from the integrations index.
- Services: `EnvironmentConnectionService` rewritten to resolve the backend by `kind` (register
  validates via the backend, stores the manifest + kind, describeProvider/testConnection/
  validateRepo/bootstrap go through it, honors the internal override). `EnvironmentProvisioning
  Service` + `EnvironmentTeardownService` resolve the provider via `connectionService.resolve
  Provider` and pass `runRepo` / `resolveRepoFiles`. `referencedSecretKeys` +
  `assertManifestUrlsSafe` moved to `environments.logic.ts` (broke an import cycle).
- Composition: orchestration `container.ts` drops the singleton provider deps, gates the env
  module on repos+cipher, passes `environmentCustomTlsSupported` + `resolveRepoFilesForCoords`.
- Persistence (parity): `kind` column on `environment_connections` — D1 migration
  `0021_environment_backend_kind.sql`, Drizzle schema + generated migration
  `drizzle/20260629110303_real_bullseye`, both repos + `EnvironmentConnectionRecord`.
  `pnpm --filter @cat-factory/node-server db:check` → "Everything's fine".
- Runtime wiring: Cloudflare (`customTlsSupported:false`) + Node + local facades updated to the
  registry; env-config-repairer resolves via the registry/override. Local mode widens the env
  URL policy (`ENVIRONMENTS_ALLOW_HTTP_URLS` + loopback/LAN `ENVIRONMENTS_ALLOW_URL_HOSTS`).
- Controller: `EnvironmentController` register handler uses `{config}`.
- Tests: new `kubernetes-environment.logic.test.ts`, `KubernetesEnvironmentProvider.test.ts`,
  `environment-backends.test.ts` (30 new tests, all pass). Existing env + kubernetes runner
  tests updated and passing (71 total). Cloudflare env integration specs + the 3 runtime
  conformance harnesses updated to the new wire shape / internal override.
- Conformance: new assertion — a `kubernetes` connection round-trips kind + discriminated
  config on both stores (`backend/internal/conformance/src/suite.ts`). The validate-repo +
  env-config-repair conformance tests still pass via the internal override.
- Docs: `backend/docs/local-k3s-environments.md` (incl. the managed-lifecycle future section);
  `native-environment-adapter.md` updated to point at `registerEnvironmentBackend`.
- Changeset: `.changeset/kubernetes-environment-backend.md`.
- Frontend (partial): `composables/api/providerConnections.ts` now wraps the environment
  register/test into the discriminated `{config}` shape (the existing manifest env connect
  form works again). Frontend typechecks clean.

## What is LEFT

1. Frontend Kubernetes env connect FORM (task 9, partial). `ProviderConnectionTab.vue` shows
   the backend-type selector + K8s form only for `runner-pool` (`showBackendSelector =
   props.kind === 'runner-pool'`); environment is manifest-only in the UI. To finish: enable
   the selector for `environment`, add a K8s env form section (apiServerUrl, token,
   manifestSource colocated|separate, url ingressTemplate|status), and i18n keys in
   `i18n/locales/en.json`. The backend fully supports it today; operators can register a
   kubernetes env via the API in the meantime. NOTE: the env K8s config shape differs from the
   runner K8s config (manifestSource/url variants vs image/namespace), so the runner K8s form
   can't be reused verbatim.
2. Full verification not yet run end-to-end:
   - `pnpm test:run` from the repo root (full suite; Node conformance needs Postgres, worker
     conformance needs Linux/macOS). I ran the integrations env+kubernetes tests (71 pass) and
     the 30 new tests; I did NOT run the worker/node/local conformance suites (Windows can't run
     workerd; Node needs a Postgres service).
   - `pnpm lint:fix` (oxlint --fix && oxfmt .) over the whole tree — NOT run yet.
   - `pnpm typecheck` whole repo — backend packages pass; see the pre-existing note below.
3. Commit + push the branch + open a PR — NOT done (you asked me to stop).

## Known issues / notes

- PRE-EXISTING, unrelated: `@cat-factory/orchestration` typecheck fails on several TEST files
  (`stepGating.logic.test.ts`, `pipelineShape.test.ts`, `ai-agent-web-search.test.ts`,
  `HumanTestController.test.ts`, `InstrumentedModelProvider.test.ts`, `extension-registries.test.ts`,
  `PipelineService.test.ts`) — `onMissingEstimate` missing in fixtures, `LanguageModelV3` mock
  signatures, `AgentExecutor` mock casts, `"task"` block category, `"no-such-view"`. I only
  modified `orchestration/src/container.ts` (which builds clean); these test-file errors are
  not caused by this work. Verify against `main` and fix separately if needed.
- PRE-EXISTING, unrelated: `@cat-factory/integrations` `test:run` has 16 failing Slack/Jira
  tests (`invalid_auth` / `fetch failed`) — network-dependent, not touched by this work.
- Per CLAUDE.md, before committing run `pnpm lint:fix` over the WHOLE tree and let git's
  line-ending normalization absorb the CRLF churn (Windows).

## Suggested next steps (in order)

1. Build the K8s env connect form (item 1) + i18n keys.
2. `pnpm lint:fix` whole tree.
3. Run the Node + worker conformance suites on Linux/CI (the new kind round-trip assertion).
4. Commit to `feat/kubernetes-ephemeral-environments`, push, open a PR with the changeset.
