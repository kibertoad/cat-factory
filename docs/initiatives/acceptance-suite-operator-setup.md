# Acceptance suite: operator-runnable setup

**Goal.** Let an operator run `@cat-factory/acceptance` against their own local deployment without
the two things that block it today: a VCS connection that cannot create repositories, and no way to
say which model the pass should run on. Plus a setup command, so the eight variables and two
repositories are assembled by asking rather than by reading a README twice.

## Why now

A first live setup attempt cleared eight of the ten prerequisites and stopped on two, one of which
no configuration can fix:

- **`vcs-connection`.** `VcsPatConnectionService` hard-codes `canCreateRepos: false` for every PAT
  connection ("provisioning is a later slice"), and the only creation path mints a GitHub **App
  installation** token against **`/orgs/{org}/repos`**. So spec 01, which bootstraps two
  repositories from empty, cannot run on a local-mode PAT deployment: the exact shape the suite's
  own README offers first. It also cannot target a personal account even with an App installed.
- **`agent-model`.** All 21 catalog entries reported unavailable, because the models that
  deployment actually runs on are per-user (a locally-run endpoint or a personal subscription) and
  an API key can see neither.

Neither is a bug in the gate. Both are real, and the gate naming them before anything was created
is the suite working as designed.

## Decisions

- **Repositories are created by the OPERATOR**, and the suite adopts them. `POST /api/v1/services`
  already backs a service with an existing repo by `repoId`, so this needs no platform change. The
  bootstrap agent stops being spec 01's subject; the scaffolding happens through `pl_build` from
  the same briefs.
- **The pass names a MODEL PRESET**, resolved against the deployment and pinned on every task it
  files, so a pass is reproducible regardless of what the workspace default happens to be. That
  needs a public surface: presets are invisible on `/api/v1` today.
- **ChatGPT becomes a real option.** There is no OpenAI entry in the model catalog at all, so
  `claude | chatgpt | kimi` is not expressible today. The resolver seam already exists
  (`openAiResolver`, wired through `baseProviderRegistry`, with `OPENAI_API_KEY` already a reserved
  key), so what is missing is a catalog entry and a built-in preset rather than a provider.

### Rejected

- **Relaxing the `vcs-connection` prerequisite to a warning.** It would trade a refusal that costs
  a minute for a bootstrap failure that costs an afternoon, which is the one thing the gate exists
  to prevent.
- **Teaching the suite to create repositories itself** with the deployment's PAT, out of band. The
  suite drives the public API through the published SDK on purpose, so that a surface change breaks
  it at compile time. A side channel around that is the property being given up.
- **A preset param that only documents what the workspace default is.** A param that cannot change
  what runs is a lie in a config file.

## Slices

Ordered by what unblocks a live pass soonest. A is independent and can land at any point.

| #   | Slice                                                                        | PR                                                          |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| B   | Public model-preset surface: list, plus `modelPresetId` on task create       | [#1940](https://github.com/kibertoad/cat-factory/pull/1940) |
| C   | Suite adopts operator-created repos, and pins the configured preset          |                                                             |
| D   | `configure` command: defaults, the token, the repo names, the creation pages |                                                             |
| A   | OpenAI catalog entry and a `chatgpt` built-in preset                         |                                                             |

### B. Public preset surface

Mostly additive, the normal mode for `/api/v1`: `GET /api/v1/model-presets` listing the workspace's
presets and which is the default (the risk-policy endpoint is the shape it copies, since that one
already reports a default), plus optional `modelPresetId` AND `riskPolicyId` on public task create
and PATCH, both read back on the task projection. Carries the full public-API cost: an entry in
`scripts/sdk/surface.mjs`, `pnpm gen:sdk` across four clients, the OpenAPI `info.version` minor, and
conformance assertions.

**One deliberate break rode along.** `GET /api/v1/merge-presets` shipped in 1.41.0 under the name
the product renamed to "risk policy" a month earlier, and the id it serves is what a task pins as
`riskPolicyId`, so the surface would have carried two names for one concept forever. Renamed in
place rather than dual-served, because 1.41.0 has no adopters; the exception is argued in
`backend/docs/public-api-versions.md`.

**Where the dangling-id check lives.** On `BoardService`, not on the public route: `addTask` and
`updateBlock` are reached by the SPA, the internal API, tracker intake, an initiative spawn and
blueprint reconciliation, and a check at one door leaves every other one falling back silently.

**Both knobs, not just the model one.** The first reading here was that a merge preset should stay
read-only, because pinning one selects how much oversight landing takes and a caller choosing its
own oversight is an escalation. That reading was wrong about the baseline: a caller could always
move the WORKSPACE default instead, which is the same power aimed at every other task too, so
withholding the field made the blunt instrument the only one rather than removing the power. The
control that was actually missing is an admission rule over which presets a caller may pin, and it
is a feature in its own right: [`role-scoped-risk-policy-admission.md`](./role-scoped-risk-policy-admission.md).

The task-create schema's "deliberately MINIMAL" comment is updated in the same change rather than
left contradicting the fields beneath it.

### C. Suite adopts operator-created repos

Spec 01 stops bootstrapping and starts adopting: read `GET /api/v1/repos`, back a service with each
`repoId`, then scaffold through `pl_build` from the briefs in `src/instructions.ts`. The
`vcs-connection` prerequisite stops asking for `canCreateRepos` and starts asking the questions that
now matter: do both named repositories exist, are they empty, and can the workspace push to them.
New config: the two repository names (the operator chose them, so they are no longer derived from
`ACCEPTANCE_NAME_PREFIX`) and `ACCEPTANCE_MODEL_PRESET`, defaulting to `claude`.

A new prerequisite covers the preset: it exists on this deployment, and its base model is one the
workspace can actually dispatch to. That is the check that would have caught the empty-catalog
finding above as a preset problem rather than as a mystery at the first dispatch.

### D. `configure` command

`pnpm --filter @cat-factory/acceptance run configure`, a sibling of the existing `status` command
(`src/statusCli.ts`), writing the `.env` the suite now reads.

- Defaults everything it can, and resolves rather than asks where the deployment can answer: the
  workspace id comes from `GET /api/v1/me`, the repo owner from `GET /api/v1/vcs/connection`, the
  cluster values from the current kubeconfig.
- **The API token is the one thing it must ask for**, since nothing can mint one for it.
- Asks for the two repository names, then opens a prefilled creation page per repository
  (`https://github.com/new?name=…`) so the operator's next click is the thing the suite needs.
- Never overwrites an existing value without saying so, and never prints the token back.

### A. OpenAI catalog entry and `chatgpt` preset

A catalog entry with a `direct` route (`provider: 'openai'`, `keyEnv: 'OPENAI_API_KEY'`), an
`openrouter` route, and a `subscription` route on the Codex harness, which the harness layer already
supports. Then `MODEL_PRESET_SEED_IDS.chatgpt` and its `DEFAULT_MODEL_PRESETS` entry.

**Open question: which model id to pin.** The catalog names concrete versions, and pinning one that
does not exist fails at the first dispatch rather than at review, so this needs checking against
OpenAI's current model list rather than being written from memory.

## Gotchas found so far

- **A model being in the catalog is not a model being available.** The catalog is static; each
  entry's `available` flag comes from whether its route's credential is wired. Adding an entry
  changes what an operator CAN select, never what they can run.
- **Per-user model wiring is invisible to an API key.** A deployment whose humans are all running on
  personal subscriptions or local endpoints looks, to the public API, like a deployment with no
  models at all. The suite needs a provider key or a subscription of its own.
- **Repo creation is org-scoped even on the App path** (`/orgs/{org}/repos`), so a personal account
  was never a supported bootstrap target. Operator-created repositories sidestep this entirely,
  which is a second reason to prefer them over widening the creation path.
