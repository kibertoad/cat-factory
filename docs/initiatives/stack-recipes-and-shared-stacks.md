# Initiative: Stack recipes & shared stacks — complex-monolith environments (acme-main pilot)

**Status:** in progress (slices 1–3 landed = contracts + detection + recipe execution) · **Owner:** environments · **Started:** 2026-07-05

> Durable source of truth for a multi-PR initiative. Read this first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Today cat-factory can auto-detect and provision **simple** repos as ephemeral environments: a
single compose file (image-pull or, since `compose-build-from-source.md`, build-from-source on
the local facade) or a Kubernetes manifest tree. The motivating pilot for this initiative is the
opposite extreme — a **complex multi-repo system**:

- **acme-main** — a PHP (Symfony) monolith + ~25 compose services (app + 8 daemon
  variants + nginx + ~10 private-ECR microservices + 4 node watch-build containers), whose
  bring-up is **imperative**: env-file materialization → secrets → compose up → `composer
install` → MySQL seed import → Doctrine migrations → ES index build → health-loop gate.
- **acme-shared-services** — a _separate sibling repo_ providing the shared infra stack
  (~17 services: MySQL/Postgres/Valkey/RabbitMQ/Kafka/ES/Mailpit/Envoy/…) that runs **once per
  machine, long-lived**, and that consumer repos attach to over an external Docker network
  (`acme-net`).

Neither fits any primitive cat-factory has. The intended end state:

1. **Auto-detection understands complex repos** — multi-compose layering, external networks
   (→ "this repo depends on a shared stack"), env-file templates, profiles, seed dumps — and an
   optional LLM "environment analyst" drafts the imperative parts (setup steps, health gates)
   as a non-binding recommendation.
2. **The spin-up system can execute them** — a declarative **stack recipe** (ordered setup
   steps, env files, health gate) run by the compose provider, plus a **shared stack**
   primitive (workspace-scoped, long-lived, reused across runs/PRs).
3. **The inherently-manual parts become guided, not silent failures** — a **preflight**
   framework checks machine prerequisites (docker daemon, registry auth, VPN reachability,
   mkcert CA, hosts entries) and shows copy-paste remediation instructions in a **wizard**,
   so the human does each manual step once per machine and everything after is unattended.

Primary execution target: the **local facade** (host Docker daemon). Runner-pool execution is a
stretch slice. Cloudflare Containers can never host this class of system (no host daemon, no
privileged DinD at this scale) — that asymmetry is documented, not fought.

Everything here is **generic**; acme is the pilot consumer that proves the primitives, the
way the .NET+Angular+SQL-Server app piloted build-from-source.

## The pilot system (facts the design must cover)

### acme-main bring-up (from its `bin/dev-console app setup`)

The repo's own CLI (`bin/dev-console`, a generated bashly script; **WSL/mac/linux only**,
refuses Git-Bash/msys) performs, in order:

1. Docker running check; sudo prompt.
2. Resolve/clone the sibling `acme-shared-services` repo (`ACME_SHARED_SERVICES_DIR`
   env → `../acme-shared-services` → persisted path → interactive prompt; **hard-fails on
   non-TTY when unset**).
3. Install OS deps (curl, s3cmd, jq, … + HashiCorp Vault CLI).
4. Delegate `shared-services setup` (see below).
5. `users sync postgres` on the shared stack.
6. Write `services/app/.env.local`, copy `.env.dev.local-dist` → `.env.dev.local`.
7. **Vault OIDC login (Google SSO, browser)** and pull `kv/acme-main/dev/*` secrets into
   `.env.dev.local` + `docker/.env.<service>` files.
8. Hand-copy `services/app/.split.yaml.dist` → `.split.yaml` (documented manual step).
9. `docker compose pull/build/up -d` — `docker/dev.yml` + OS override
   (`dev.wsl.override.yml` / `dev.mac.override.yml`); attaches to external `acme-net`;
   ~10 service images from **private ECR** (`053497547689.dkr.ecr.eu-central-1.amazonaws.com`,
   `ecr.prod.acme.cloud`); no healthchecks in the compose file — ordering is imperative.
10. `composer install` inside the app container.
11. MySQL seed import (`deployment/acme-db-dummy/acme-dummy.sql` + `acme-pre-dummy.sql`).
12. `bin/console cache:warmup` (~4–5 min first run).
13. Doctrine migrations (main + `services_db` on Postgres).
14. Integration tag sync; ES `acme:elastic:create-indexes --delete --all` + full reindex;
    expert-search reindex (each preceded by a wait-for-endpoint loop).
15. Block until the frontend watch-builds emit `public/js/compiled/ui/manifest.json`.
16. Loop `bin/console monitor:health` until green. Healthy = that command +
    `https://acme.local` + Mailpit UI.

### acme-shared-services (its `bin/shared-services setup`)

sysctl tweaks → mkcert CA + wildcard certs (`*.acme.local`, `*.acme.internal`) →
`/etc/hosts` managed block (sudo) → `docker network create acme-net` → `.env.shared` →
(interactive prompts, safe defaults on non-TTY) → **AWS SSO + ECR login** → compose pull →
`up -d` → wait-healthy → `users sync` (mysql + proxysql mirror + postgres + cockroach via CLI)
→ Debezium connector registration.

Consumer opt-in conventions (all file-drop + idempotent re-apply): `users.d/<engine>/<consumer>.sql`
(two-user owner/app convention), `config/envoy/sites.d/<consumer>/*.yaml` L7 vhosts,
`config/debezium-connect/connectors/<consumer>/*.json`. Only Envoy binds host ports (`+40000`
scheme; 80/443 standard). **4 of ~17 images are private ECR** — cockroach, languagetool, okapi
(all `peer`-profile) and **fauxqs, which is a core `backends`-profile service**; the other ~11
backends + envoy + proxysql are public images, so a **public-only subset can run fully
unattended** (profiles/edits required — see validation plan).

## Gap analysis (cat-factory today → what's missing)

What exists (see `compose-build-from-source.md`, `tester-environment-access.md`,
`service-connections.md`): the `EnvironmentProvider` port (`kernel/src/ports/environment-provider.ts`),
`EnvironmentProvisioningService` + backends registry
(`backend/packages/integrations/src/modules/environments/environment-backends.ts`; `compose`
registered local-facade-only via `runtimes/local/src/compose.ts`), the k8s `deploy-harness`,
the `deployer` step, `ProvisioningLogService`, descriptor-driven config UI
(`InfrastructureWindow.vue` / `InfraHandlersConfigurator.vue`), deterministic checkout-free
detection (`provision-detect.logic.ts`), per-frame `ServiceProvisioning`
(`contracts/src/environments.ts`) resolved up the frame chain (`AgentContextBuilder`).

| #   | Gap                                                                                                                                                                     | Covered by slice |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| G1  | No shared/long-lived stack primitive — compose projects are strictly per-PR and torn down with the run; no compose analogue of the k8s helm `scope:'shared'` singleton  | 4, 5             |
| G2  | Compose provider takes a single `-f` file — no override layering (`dev.yml` + `dev.wsl.override.yml`), no `COMPOSE_PROFILES`, no external networks                      | 3, 5             |
| G3  | No model of imperative setup steps (seed import, migrations, index builds, `composer install`) or health gates — provisioning is `up --wait` and done                   | 1, 3             |
| G4  | No env-file materialization (`.env.dev.local-dist` → `.env.dev.local`, `.split.yaml.dist` → `.split.yaml`)                                                              | 1, 3             |
| G5  | No prerequisite/preflight concept — VPN, registry auth, mkcert CA, hosts entries, RAM/disk fail deep inside provisioning instead of up-front with instructions          | 6                |
| G6  | Detection is compose/k8s-layout only — no multi-compose/override detection, no `external: true` network → shared-stack inference, no env-template/seed-dump detection   | 2                |
| G7  | No LLM-assisted detection for the imperative parts a deterministic scan can't see (README/Makefile/CLI-encoded setup order)                                             | 8                |
| G8  | No guided "detect → review → preflight → trial → save" wizard; no surface for built-in manual-step instructions                                                         | 7                |
| G9  | Registry auth unmodeled (already called out as out-of-scope in `compose-build-from-source.md`) — a preflight can _check_ login state even if we never store credentials | 6                |
| G10 | Heavy stacks don't fit Cloudflare containers; runner pools exist but recipes don't run there                                                                            | stretch          |

## Target architecture

Each primitive names its seam. **Persistence-touching slices land D1 ⇄ Drizzle + a conformance
assertion in the same PR** (CLAUDE.md "Keep the runtimes symmetric"); runtime-_bound_ execution
(host daemon) registers only on the local facade — the documented compose exception.

### 1. `StackRecipe` (contracts extension of `ServiceProvisioning`)

Extend `ServiceProvisioning` (`backend/packages/contracts/src/environments.ts`) with a
declarative recipe (all optional — existing configs parse unchanged):

- `composeFiles: string[]` — ordered `-f` layering (base + overrides). Supersedes the single
  `composePath` for multi-file repos; single-file stays the simple case.
- `composeProfiles: string[]` — `COMPOSE_PROFILES` for the project.
- `envFiles: { template: string; target: string }[]` — materialize committed templates
  (`.env.dev.local-dist`, `.split.yaml.dist`) into their gitignored targets inside the
  checkout before `up`. Both paths must pass the existing `escapesCheckout` guard.
- `externalNetworks: string[]` — networks the project expects to exist (created/owned by a
  shared stack or by the engine).
- `sharedStackRefs: string[]` — ids of `SharedStack` entities that must be up first.
- `setupSteps: RecipeStep[]` — ordered post-`up` steps. Step kinds:
  - `compose-exec` — `docker compose exec <service> <cmd>` (composer install, migrations,
    cache warmup, index builds, seed import via a client container).
  - `copy-file` — in-checkout template copy (subset of `envFiles`, for one-offs).
  - `wait-http` — poll a URL until 2xx/expected body (ES up, expert-search `/health`).
  - `wait-file` — poll for a file inside the checkout/container (the `manifest.json` gate).
  - `host-command` — arbitrary command on the orchestrator host. **Trusted local facade
    only**, behind an explicit opt-in flag (same pattern as the `build` flag), refused by
    every other backend. Escape hatch for genuinely host-side steps.
- `healthGate` — terminal readiness check: `{ kind: 'http', url }` |
  `{ kind: 'compose-exec', service, command }` (e.g. `bin/console monitor:health`) |
  `{ kind: 'compose-healthy' }` (default, today's behaviour).
- `teardownSteps: RecipeStep[]` — optional, before `down -v`.

Persisted on the service frame like today; resolved up the frame chain
(`AgentContextBuilder.resolveServiceFrame`). Valibot schemas beside the existing provisioning
contracts. Autodetection and the analyst only _recommend_ these fields; the provider keys purely
on persisted config (the build-flag rule).

> **Landed (slice 1)** in `backend/packages/contracts/src/stack-recipes.ts` (wired onto
> `serviceProvisioning.recipe` in `environments.ts`): `stackRecipeSchema`
> (`StackRecipe`), composed of `recipeStepSchema` (`RecipeStep`,
> kinds `compose-exec` / `copy-file` / `wait-http` / `wait-file` / `host-command`, each with a
> per-step `timeoutMs`; `compose-exec` seed import pipes a dump via `stdinFile`),
> `recipeHealthGateSchema` (`RecipeHealthGate` — `compose-healthy` default / `http` /
> `compose-exec`), and `recipeEnvFileSchema` (`RecipeEnvFile`). All fields are optional (a plain
> `composePath` config parses unchanged); `recipe.composeFiles` supersedes `composePath` when
> present. The recommendation gained `composeFileCandidates` (OS overrides annotated via `os`),
> `profileCandidates` (default-off), `seedDumpCandidates`, and the report-only `repoCliHint` —
> detected recipe fields (external networks, env-file pairs, base compose files) go straight into
> `recommendation.provisioning.recipe`. Persistence rides the existing `optJsonField('provisioning')`
> blob, so **no migration** — the D1 ⇄ Drizzle parity work begins at the SharedStack table (slice 4).

### 2. `SharedStack` (new entity + lifecycle service)

A **workspace-scoped, long-lived stack**: `{ id, workspaceId, name, repo (cloneUrl/ref/path),
composeFiles, composeProfiles, envFiles, managedNetworks, setupSteps, healthGate, status,
lastError, updatedAt }`. New table mirrored D1 ⇄ Drizzle + conformance round-trip; a
`SharedStackService` (integrations) owns lifecycle:

- `ensureUp(stackId)` — idempotent: clone/refresh the stack repo into a per-stack working dir
  (reuse the `ComposeRuntime.checkout` seam from build mode), create managed networks
  (`docker network create acme-net` if absent), `compose up -d` with profiles, wait
  healthy, run setup steps (users sync, Debezium registration). Re-entrant: already-healthy →
  no-op. Concurrent provisions coalesce on one `ensureUp`.
- `status(stackId)` / `refresh(stackId)` / explicit `teardown(stackId)`. **Never** swept with
  a run and never TTL-reaped — teardown is a deliberate user action.
- The compose environment provider gains `sharedStackRefs` handling in
  `buildProvisionRequest`/`provision`: ensure stacks first (provider-before-consumer, reusing
  the `orderProvisionTargets` idea from service-connections), then attach the per-PR project to
  their `managedNetworks` as `external: true` networks in the rewritten compose file.
- Controller: `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks` (+ `POST …/:id/ensure-up`,
  `…/teardown`); SPA store + a panel in the Infrastructure window.

This is the compose analogue of the k8s helm `scope: 'shared'` singleton, and it directly
models acme-shared-services (one stack per machine/workspace, consumers attach over
`acme-net`).

### 3. Preflights (machine-prerequisite checks + guided remediation)

A kernel port `PreflightCheck` / `PreflightRunner`: each check =
`{ id, title, probe(): pass|fail|warn + detail, remediation: markdown }`. **Checks are
automated; remediation is human instructions** — this is exactly where VPN / SSO / Vault /
mkcert live, as guided one-time machine setup rather than pretend-automation. Built-in checks
(local facade impl):

- docker daemon reachable; free disk / RAM vs a recipe-declared minimum (acme wants ≥16 GB).
- registry reachability + `docker login` state per registry named in the recipe's images
  (detects "ECR token expired" _before_ a 40-image pull fails; we check, never store, creds —
  G9 stays out of scope).
- TCP/HTTP reachability probes for recipe-declared endpoints (a VPN-only Vault/ECR host
  unreachable → "connect Tailscale" remediation).
- mkcert CA present in the trust store; expected `/etc/hosts` entries present.
- env-file secrets markers present (e.g. acme's `# BOF SECRETS #` block in
  `.env.dev.local`) — detects "Vault step not done yet" without knowing anything about Vault.

Recipes declare which checks apply (`prerequisites: PreflightRef[]`, with per-check params +
custom remediation text). Surfaced in the wizard (live re-check button) and re-run at
provision start — a failed _required_ preflight fails fast with the remediation text in the
provisioning log instead of a mid-provision mystery.

### 4. Recipe execution engine (compose provider path)

Extend `ComposeEnvironmentProvider` + the `ComposeRuntime` seam (`runtimes/local/src/compose.ts`):
multi-`-f` invocation, `COMPOSE_PROFILES`, env-file materialization, then the ordered
`setupSteps` with **per-step entries in `ProvisioningLogService`** (step name, duration,
truncated output, verdict), per-step timeouts (separate budgets — the build-mode
`BUILD_TIMEOUT_MS` precedent; a 5-minute cache-warmup must not eat the `up --wait` budget), and
the `healthGate` as the terminal gate. Failure surfacing: the failed step's log tail lands on
the environment record's `lastError` and the provisioning log, so the SPA (and the env-repair
agent) can show exactly which step died. All build-mode safety lines stay (host-escape
uniformity on every path-bearing reference; `include:`/cross-file `extends` refused —
multi-`-f` layering is the sanctioned alternative; `privileged` refused).

> **Landed (slice 3)** — the recipe now reaches the provider: `resolveProviderForType`
> (`EnvironmentConnectionService`) + `handlerConfigToBackendConfig`'s `local-docker` branch fold
> the SERVICE's `recipe` into the compose handler's `providerConfig.recipe` (the compose analogue
> of merging a kube `manifestSource`; `ServiceKubeInputs` → `ServiceProvisioningInputs`), so the
> provider keys purely on the persisted, merged config. `ComposeEnvironmentProvider.provisionRecipe`
> drives the bring-up: it always materializes a checkout (its steps + env files operate on the
> working tree), reads + `{{var}}`-renders each `composeFiles` layer, rewrites them isolation-safe
> per layer (`prepareRecipeComposeFiles` — host-escape-checked with the build-mode guard + host
> ports neutralized + the probed service's publish guaranteed on whichever layer defines it), writes
> them beside their originals + passes ordered `-f`s, materializes `envFiles`, `up -d` under
> `COMPOSE_PROFILES` (**no `--wait`** — these stacks rarely declare healthchecks, so readiness is
> the recipe's own gate), runs `setupSteps` (`compose-exec` [seed import pipes a `.sql` via the new
>
> > `compose` stdin seam], `copy-file`, `wait-http`, `wait-file` [container `test -f` or checkout],
> > `host-command` [opt-in via the handler's `allowHostCommands` + the runtime's `hostCommand` seam]),
> > then polls the `healthGate` (`compose-healthy`/`http`/`compose-exec`). Per-step verdicts stream
> > through the new kernel `ProvisionEnvironmentRequest.recordStep` seam (bound in
> > `EnvironmentProvisioningService.buildProvisionRequest` to a `subsystem:'environment'` provisioning
> > log entry) — env file, `up`, each step, health gate — so the "View logs" drawer shows which step
> > ran/died; a failing step tears the half-up stack down and surfaces its own error as `lastError`.
> > New pure helpers + the `ComposeRuntime` recipe seams (`compose` stdin, `copyCheckoutFile`,
> > `checkoutFileExists`, `hostCommand`) live in `compose-environment.logic.ts` / `runtimes/local`.
> > **Gotchas for later slices:** recipe execution is local-facade-bound (no D1⇄Drizzle work — the
> > recipe rides the existing `provisioning` blob, so persistence parity is inherent), so its
> > validation is unit tests with a fake `ComposeRuntime`, not conformance. `teardownSteps` execution
> > is deferred (`down -v` is the teardown for now). `externalNetworks`/`sharedStackRefs` are parsed
> > but NOT yet attached — that is slice 5.

### 5. Detection extensions (`provision-detect.logic.ts` — deterministic, checkout-free)

Keep the non-binding `ProvisioningRecommendation` + per-field confidence shape. Add:

- **Override layering**: when `findCompose` hits `dev.yml`/`compose.yaml`, also collect
  sibling `*.override.yml` / `dev.<os>.override.yml` / `docker-compose.override.yml` →
  recommend `composeFiles` ordering (OS-specific overrides annotated as candidates, not
  auto-selected).
- **External networks**: `networks: { x: { external: true } }` → recommend a
  `sharedStackRefs` placeholder + surface "this repo expects network `x` to pre-exist" (the
  wizard binds it to a concrete SharedStack).
- **Profiles**: collect `profiles:` labels → recommend default-off optional groups.
- **Env templates**: `*.dist` / `*.example` / `*.local-dist` siblings of env-looking files →
  recommend `envFiles` pairs.
- **Seed dumps**: `*.sql` under seed-ish dirs (`deployment/`, `seed/`, `db/`,
  `docker-entrypoint-initdb.d/`) → recommend a seed `compose-exec` step candidate (low
  confidence, wizard-confirmed).
- **Repo-CLI presence** (report-only hint): a `Makefile` / `bin/*console*` / `justfile` with
  setup-looking targets → set a "this repo has its own imperative bring-up; consider the
  analyst draft" flag on the recommendation. Detection never parses shell.

All within the existing `READ_BUDGET` discipline; predicates exported once and shared with
provisioning (the compose-build rule: never re-implement a predicate).

> **Landed (slice 2)** in `backend/packages/integrations/src/modules/environments/provision-detect.logic.ts`
> (`buildComposeRecommendation`, formerly the sync `composeRecommendation`), plus the compose-doc
> predicates `extractExternalNetworks` / `extractComposeProfiles` in
> `compose-environment.logic.ts` (so the slice-5 provider reuses them, not the detector). `findCompose`
> now recognizes a bare `dev.yml` base (lowest priority — canonical names still win) and returns the
> containing dir's listing + the parsed external networks / profiles. A recipe is populated ONLY when
> the repo is actually recipe-shaped, so a plain single-file compose recommendation is byte-for-byte
> unchanged (the exact-`toEqual` regression test still passes). Mapping: base + `<stem>.override.ya?ml`
> → `recipe.composeFiles` (OS overrides → `composeFileCandidates` with `os`, opt-in); `external: true`
> networks → `recipe.externalNetworks` (+ a `sharedStackRefs` nudge note, no ref fabricated);
> `*-dist`/`*.example`/`*.dist` config templates → `recipe.envFiles`; `profiles:` → default-off
> `profileCandidates` (never `recipe.composeProfiles`); seed-ish `*.sql` (one level deep) →
> `seedDumpCandidates` (fullest pre-selected); `bin/*console*`/Makefile/justfile/Taskfile → the
> report-only `repoCliHint`. Fixture-driven unit tests (incl. a combined acme-main-shaped repo)
> cover every extension. Gotcha for later slices: several existing detector tests assert the WHOLE
> recommendation with `toEqual`, so any new always-on field breaks them — gate additions behind an
> "actually detected" check, as done here.

### 6. Environment analyst (LLM draft — opt-in, never silently applied)

A new agent kind registered through the public seams (`registerAgentKind`,
`container-explore` structured — the `example-custom-agent` shape): given a checkout, read
README / Makefile / compose files / setup scripts and return a **structured draft
`StackRecipe`** (setup steps with rationale + source citations, prerequisites, health gate) on
`result.custom`. The wizard merges it as a _draft_ layer: deterministic detector facts always
win on fields both produce; analyst-only fields arrive editable + flagged with provenance
("suggested by analysis of `bin/src/lib/setup.sh:112`"). The deterministic detector remains the
only thing that runs without opt-in. This is how `bin/dev-console app setup`'s ordering
(composer → seed → migrate → index → health) becomes a recipe without cat-factory hardcoding
acme knowledge.

### 7. Wizard UX (detect → review → preflight → trial → save)

A guided flow in the SPA — new `EnvironmentSetupWizard.vue` family reusing the
descriptor-driven form machinery + the `BootstrapModal` async pattern + `stores/infraConfig.ts`:

1. **Pick service** (frame) → run detection; offer "run deep analysis" (analyst agent, async
   with progress).
2. **Review recipe** — per-field confidence + provenance chips; candidate pickers (compose
   file sets, profiles, shared-stack binding); inline editing.
3. **Preflight checklist** — live checks with pass/fail/warn, copy-paste remediation
   instructions per failure (the "built-in instructions" surface), re-check button.
4. **Trial provision** — kick a real provision against a chosen ref with live step logs
   (`ProvisioningLogsDrawer`); on failure, jump to the failed step + its remediation if a
   preflight maps to it.
5. **Save** to the frame's `ServiceProvisioning` (+ create/bind SharedStacks).

Plus an `InfraSetupBanner`-style nudge on service frames where detection finds a recipe-shaped
repo but nothing is configured. All copy through i18n with locale parity from day one;
`data-testid` on every affordance (e2e rule).

### 8. Tester integration

Recipe-provisioned environments surface through the existing `environment: 'ephemeral'` + URL
path (`testerInfraSpec` in `backend/packages/server/src/agents/prompts.ts`) — no tester-side
changes needed beyond what `tester-environment-access.md` already tracks. Acme's seeded
login users belong in that initiative's **Slice B credential pools** (explicitly non-secret
test data); this tracker takes a dependency on it rather than duplicating it.

## The acme mapping table (pilot acceptance)

Classification: **A** = fully automatable (unattended once configured) · **C** = automatable
with credentials/one-time login provided · **M** = inherently manual, guided by a preflight
with remediation instructions.

| Bring-up element                                                    | Covered by                                                        | Class |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- | ----- |
| Tailscale VPN enrollment/connection                                 | Preflight: reachability probe of VPN-only hosts + instructions    | M     |
| AWS SSO + ECR login (both registries)                               | Preflight: registry auth state + login instructions               | M     |
| Vault OIDC (Google SSO) secrets → `.env.dev.local`, `docker/.env.*` | Preflight: secrets-marker check + instructions (run repo's step)  | M     |
| mkcert install + CA trust                                           | Preflight: CA-in-truststore check + instructions                  | M     |
| `/etc/hosts` entries, sysctl tweaks (sudo)                          | Preflight: hosts-entries check + instructions                     | M     |
| Private clone of both repos                                         | Existing PAT-backed clone seam (`resolveDeployCloneTarget`)       | C     |
| ECR image pulls (after login)                                       | Compose pull inside provision                                     | C     |
| `docker network create acme-net`                                    | SharedStack `managedNetworks`                                     | A     |
| shared-services compose up + wait-healthy (public + ECR images)     | SharedStack `ensureUp` + healthGate                               | A/C   |
| shared-services `users sync` (mysql/proxysql/postgres/cockroach)    | SharedStack `setupSteps` (`compose-exec`)                         | A     |
| Debezium connector registration                                     | SharedStack `setupSteps` (`wait-http` + `compose-exec`/HTTP step) | A     |
| `.split.yaml.dist` → `.split.yaml`, `.env.dev.local-dist` → target  | Recipe `envFiles` materialization                                 | A     |
| `docker/dev.yml` + OS override layering, external `acme-net` attach | Recipe `composeFiles` + `externalNetworks` + `sharedStackRefs`    | A     |
| `composer install`, cache warmup                                    | Recipe `setupSteps` (`compose-exec`, own timeout)                 | A     |
| MySQL seed import (`deployment/acme-db-dummy/*.sql`)                | Recipe `setupSteps` (seed via `compose-exec` mysql client)        | A     |
| Doctrine migrations (main + services_db)                            | Recipe `setupSteps` (`compose-exec`)                              | A     |
| ES index create + reindex, expert-search reindex                    | Recipe `setupSteps` (`wait-http` + `compose-exec`)                | A     |
| Frontend build gate (`public/js/compiled/ui/manifest.json`)         | Recipe `setupSteps` (`wait-file`)                                 | A     |
| `bin/console monitor:health` readiness loop                         | Recipe `healthGate` (`compose-exec`)                              | A     |
| Test login users (register + Mailpit confirm)                       | `tester-environment-access.md` Slice B credential pools (seeded)  | A     |

**Honesty note:** a full acme-main environment requires the five **M** rows done once per
machine (and the ECR login refreshed ~8-hourly — the preflight makes the stale-token case a
clear actionable failure). After that, re-provisions are unattended. The **public-image subset**
of shared-services + a synthetic consumer runs with zero M/C rows — that is the CI-validated
configuration (see validation plan).

## Per-slice checklist

Each slice = one PR; persistence slices land both runtimes + conformance in the same PR;
changesets per touched package; contracts changes flagged as breaking-is-fine (pre-1.0).

| #   | Slice                                                                                                                                                     | Status | PR     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| 0   | Tracker doc                                                                                                                                               | done   | (this) |
| 1   | **Contracts**: `StackRecipe` fields on `ServiceProvisioning` + Valibot + recommendation shape extensions                                                  | done   | (this) |
| 2   | **Detection extensions**: override layering, external networks, profiles, env templates, seed dumps, repo-CLI hint — + fixture-driven unit tests          | done   | (this) |
| 3   | **Recipe execution engine**: multi-`-f`/profiles/envFiles + `setupSteps` runner + `healthGate` + per-step provisioning logs/timeouts (local facade pilot) | done   | (this) |
| 4   | **SharedStack**: entity + table (D1 ⇄ Drizzle + conformance) + `SharedStackService` lifecycle + controller + SPA store/panel                              | todo   |        |
| 5   | **Provider integration**: `sharedStackRefs` ensure-first ordering + external-network attach in the compose provider                                       | todo   |        |
| 6   | **Preflights**: kernel port + local-facade built-in checks + recipe `prerequisites` + API + provisioning-start enforcement                                | todo   |        |
| 7   | **Wizard**: detect → review → preflight → trial → save flow + `InfraSetupBanner` nudge + i18n (all locales) + `data-testid`s                              | todo   |        |
| 8   | **Environment analyst**: agent kind (structured draft recipe) + wizard draft-merge with provenance                                                        | todo   |        |
| 9   | **Acme pilot**: recipe + shared-stack reference configs as fixtures, golden detection tests against the real repos, pilot docs                            | todo   |        |
| 10  | **Validation harness**: golden-run script + shared-services public-subset smoke (compose up + consumer attach + health + teardown-keeps-stack)            | todo   |        |
| S1  | _Stretch_: recipe execution on self-hosted runner pools (heavy stacks for hosted deployments)                                                             | todo   |        |
| S2  | _Stretch_: registry-auth modeling beyond check-only preflights                                                                                            | todo   |        |
| S3  | _Stretch_: Windows-host bridge for `host-command` steps (WSL invocation shim)                                                                             | todo   |        |

## Validation plan (no human testing)

Both acme repos are accessible programmatically (local clones at `C:\sources\acme-main`
and `C:\sources\acme-shared-services`; git-cloneable in CI-adjacent environments with a
deploy key). The layers, cheapest first:

1. **Fixture-driven detection unit tests** (slice 2, runs everywhere incl. Windows via
   `pnpm test:run` in `backend/packages/integrations`): copy sanitized real files —
   `docker/dev.yml`, `dev.wsl.override.yml`/`dev.mac.override.yml`, shared-services
   `docker-compose.yml`, `.env.dev.local-dist`, `.split.yaml.dist` — into test fixtures; assert
   the exact recommended `composeFiles` ordering, `externalNetworks: ['acme-net']`,
   profiles, envFiles pairs, seed-dump candidates, and the repo-CLI hint.
2. **Recipe-engine unit tests** (slice 3): fake `ComposeRuntime`/command runner; assert step
   ordering, per-step log capture + timeout enforcement, failure surfacing onto
   `lastError`/provisioning log, env-file materialization + escape-guard refusals, idempotent
   re-provision.
3. **SharedStack unit + conformance tests** (slices 4–5): lifecycle state machine with a fake
   runtime (ensureUp idempotence, concurrent-coalesce, teardown-is-explicit); config
   round-trips on both facades in `@cat-factory/conformance`.
4. **Preflight simulation tests** (slice 6): fake probe states drive every verdict +
   remediation rendering — including the "ECR token expired", "VPN down", "secrets block
   missing" paths — so the manual-gate UX is fully tested without any real VPN/SSO.
5. **Golden detection run against the live clones** (slices 9–10): a checked-in script points
   the detector's `ProvisioningRepoReader` at real checkouts (paths via env vars) and diffs the
   full recommendation against committed goldens. Doubles as an upstream-drift alarm (e.g.
   shared-services' README already drifted from its compose file — goldens track the compose
   truth).
6. **Automated end-to-end smoke** (slice 10, Linux/WSL host with Docker): bring up the
   shared-services **public-image subset** (mysql, postgres, valkey, rabbitmq, mailpit, kafka,
   ES + envoy/proxysql; ECR-hosted cockroach/fauxqs/languagetool/okapi excluded via
   profiles/overrides) as a SharedStack; provision a minimal synthetic consumer repo (small
   compose file attaching to `acme-net`, one seed step, one `wait-http` health gate);
   assert health-gate pass, then environment teardown **leaves the shared stack running**;
   finally explicit stack teardown. Runs as a scriptable harness (local `pnpm` script first;
   CI job once stable — same trust-earning path as the e2e suite).
7. **Wizard e2e spec** (slice 7, Playwright suite conventions — `data-testid` only, seeded
   workspace, live-push assertions): detect → review → save against a fixture repo with the
   fake executor; analyst path mocked at the backend boundary.
8. **Full acme-main bring-up is explicitly NOT CI-validated** — it requires VPN + Vault +
   ECR. It is validated _indirectly_: every A-row of the mapping table has a unit/smoke test
   equivalent, every M-row has a preflight simulation test, and the golden detection run pins
   the real repo's shape. A human running the pilot once per machine is a product milestone,
   not a test dependency.

## Conventions & gotchas (carry between iterations)

- **All compose safety lines from `compose-build-from-source.md` still apply**: host-escape
  checks on every path-bearing reference (now including `envFiles` targets and recipe file
  args), `include:`/cross-file `extends` refused (multi-`-f` layering is the sanctioned
  alternative — acme needs no `include:`), `privileged` refused, private base-image auth
  stays check-only.
- **`host-command` is the only trust boundary widening** — it must stay behind its own opt-in
  flag, local-facade-only, and be visibly labeled in the wizard. Everything else runs inside
  the compose project's containers.
- **Recipes must not assume the repo's own CLI is runnable on the orchestrator host** —
  acme's `bin/dev-console` and `bin/shared-services` both refuse Git-Bash/msys and expect
  Linux/WSL. The engine executes compose/steps itself; the analyst _translates_ a repo CLI into
  recipe steps rather than shelling out to it (that's what `host-command` + S3 are for if ever
  truly needed).
- **Trust compose files, not READMEs** — shared-services' README service table is already
  stale vs its compose file (postgres version, fauxqs tag, missing ProxySQL). Detection and
  goldens key on compose content; the analyst must cite file paths, not prose claims.
- **Long-lived ≠ leak-proof**: SharedStacks are deliberately excluded from the run-scoped
  teardown/TTL sweeps — make that exclusion explicit in the sweeper code + tests, or a future
  "cleanup" change will helpfully reap them.
- **Non-TTY defaults matter** — every step the engine runs must behave with no TTY (acme's
  own scripts hard-fail or default in places); never depend on interactive prompts.
- **Local-facade-only runtime binding is the documented exception** to runtime symmetry
  (compose already is); the _persistence + contracts_ for recipes/stacks/preflights are still
  fully symmetric and conformance-asserted.
- **Timeouts are per-step budgets**, never one shared pool — a 5-minute cache warmup or a
  40-image ECR pull must not starve `up --wait` (the `BUILD_TIMEOUT_MS` precedent).

## Out of scope

- Automating VPN enrollment, Google-SSO Vault login, or AWS SSO — permanently manual, guided
  by preflights. Storing registry/Vault credentials in cat-factory (S2 revisits modeling, not
  storage).
- Running this class of stack on the Cloudflare Worker or plain-Node facades (no host daemon).
- Replacing acme's `dev-console` for its human developers — cat-factory consumes the same
  repos but drives its own engine.
- Kargo preenv integration (shared-services' `deployment/docker-compose.kargo.yml` is a useful
  reference shape only).
- Envoy vhost / `users.d` / Debezium _authoring_ for new consumers — the pilot uses the
  conventions acme repos already contain; generating those files is a possible future
  analyst skill, not this initiative.
