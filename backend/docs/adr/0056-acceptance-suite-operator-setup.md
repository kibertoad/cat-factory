# ADR 0056: Operator-runnable acceptance setup

- **Status:** Accepted (implemented)
- **Date:** 2026-08-12
- **Context layer:** `@cat-factory/kernel` (model catalog + preset seeds), `@cat-factory/server`
  (`/api/v1` presets, repo adoption), `@cat-factory/orchestration` (`BoardService` pin validation),
  the four `sdk/` clients, and `@cat-factory/acceptance`

Supersedes the `acceptance-suite-operator-setup` initiative tracker, whose committed scope is now
complete. The live acceptance suite it unblocked is documented in
[`backend/internal/acceptance/README.md`](../../internal/acceptance/README.md); the public-API
surface it extended is [ADR 0030](./0030-public-api-surface.md) and
[`backend/docs/public-api.md`](../public-api.md).

## Context

A first live setup attempt of `@cat-factory/acceptance` cleared eight of ten prerequisites and
stopped on two, one of which no configuration could fix.

**`vcs-connection`.** `VcsPatConnectionService` hard-coded `canCreateRepos: false` for every PAT
connection, and the only creation path minted a GitHub App installation token against
`/orgs/{org}/repos`. So spec 01, which bootstrapped two repositories from empty, could not run on a
local-mode PAT deployment: the exact shape the suite's own README offers first. It could not target
a personal account even with an App installed, because repo creation is org-scoped on that path too.

**`agent-model`.** All 21 catalog entries reported unavailable, because the models that deployment
actually ran on were per-user (a locally-run endpoint or a personal subscription), and an API key can
see neither. There was also no way to say which model a pass should run on: presets were invisible on
`/api/v1`, so a pass adopted whatever the board's default happened to be and reported a result nobody
could reproduce.

Neither was a bug in the gate. Both were real, and the gate naming them before anything was created
is the suite working as designed.

## Decision

**Repositories are created by the OPERATOR, and the suite adopts them.** `POST /api/v1/services`
already backed a service with an existing repo by `repoId`, so the narrative needed no new creation
path. The bootstrap agent stopped being spec 01's subject and the scaffolding moved to `pl_build`
from the same briefs, which also made an interrupted scaffold resume exactly as an interrupted
feature run does.

**A pass PINS a model preset** rather than adopting the workspace default, so a result is
reproducible. That needed a public surface: `GET /api/v1/model-presets` plus optional
`modelPresetId` and `riskPolicyId` on public task create and PATCH, read back on the task
projection.

**Adoption itself became public**, because creating a repository and LINKING it are two acts and
only the first is a person's: `GET /api/v1/repos/available` lists what the connection can reach and
`POST /api/v1/repos/link` adopts one by `owner`/`name`, idempotent.

**A `configure` command assembles the `.env`**, resolving everything the deployment, kubeconfig and
preset library can answer and asking only for the API token and the two repository names.

**The GPT built-in preset is `mdp_chatgpt`, pinning `gpt-5.6-sol`, with no new catalog route.** The
tracker's last open slice asked for an OpenAI catalog entry carrying a `direct` route
(`provider: 'openai'`, `keyEnv: 'OPENAI_API_KEY'`) alongside `openrouter` and Codex `subscription`
routes, plus the preset. The catalog entries arrived meanwhile through unrelated work
(`gpt-5.6-sol` / `-terra` / `-luna`, and `gpt-5.5`), so only the preset was outstanding, and the
`direct` route is deliberately NOT added: see the rationale below.

### Rejected

- **Relaxing the `vcs-connection` prerequisite to a warning.** It trades a refusal that costs a
  minute for a bootstrap failure that costs an afternoon, which is the one thing the gate exists to
  prevent.
- **Teaching the suite to create repositories itself** with the deployment's PAT, out of band. The
  suite drives the public API through the published SDK on purpose, so that a surface change breaks
  it at compile time; a side channel around that gives up the property.
- **A preset param that only documents what the workspace default is.** A param that cannot change
  what runs is a lie in a config file.
- **A `direct` OpenAI route on the GPT-5.6 tiers.** Two independent reasons, either sufficient. The
  catalog already states in `models.ts` that these ids ARE the Codex `--model` slugs and that the
  5.6 tiers are "Codex/OpenRouter only", so a `direct` route would contradict a documented fact in
  the file that declares it. And the id OpenAI's own REST API serves is not knowable from this
  repository: the tracker flagged exactly that ("pinning one that does not exist fails at the first
  dispatch rather than at review"), and writing one from memory is how a built-in preset becomes
  selectable, seedable and broken only for whoever picks it. It was also not load-bearing for the
  goal, which the next section explains.

## Rationale

**Why the preset needed no route work.** `mdp_claude` already pins `claude-opus`, whose only routes
are `openrouter` and an individual-only `subscription`: no Cloudflare floor and no `direct` key. So a
built-in preset over a subscription-or-gateway model is the shipped norm rather than a new shape, and
`gpt-5.6-sol` has the same pair. `effectiveVariant` walks the preference and lands on whichever the
workspace holds, which means an OpenRouter key alone makes the preset dispatchable to a SYSTEM API
key (the acceptance suite's case, since a Codex subscription is per-seat and an individual-only
credential a system token may not spend), and a connected subscription wins where there is one. The
initiative's goal was that `claude | chatgpt | kimi` be expressible and pinnable; that is now true,
and adding an unverifiable model id would not have made it truer.

**Why the seed ids name a vendor, not a generation.** `mdp_chatgpt` rather than `mdp_gpt56sol`, so a
built-in rolls its `baseModelId` forward as the vendor's flagship moves and a workspace's pin
survives the move. That is what the `version: 2` bump on `mdp_claude` records (Opus 4.8 → Opus 5);
pinning the generation in the id would have made every roll-forward a new preset nobody had selected.

**Why the new test joins the seeds to the catalog rather than listing them.** A preset's
`baseModelId` is a plain string matched at DISPATCH, so a built-in naming a renamed or dropped model
typechecks, seeds, lists and is selectable, then fails on the first agent step of whichever run picked
it. `catalog.test.ts` derives the expectation from `MODEL_CATALOG` itself and covers every preset's
base and overrides, so a catalog rename breaks a test instead of a live run and adding a built-in
needs no edit there. Deliberately not a count: the population grows.

**Where the dangling-id check lives.** On `BoardService`, not on the public route: `addTask` and
`updateBlock` are reached by the SPA, the internal API, tracker intake, an initiative spawn and
blueprint reconciliation, and a check at one door leaves every other one falling back silently.

**Both pinning knobs, not just the model one.** The first reading was that a risk policy should stay
read-only, because pinning one selects how much oversight landing takes. That reading was wrong about
the baseline: a caller could always move the WORKSPACE default instead, which is the same power aimed
at every other task too, so withholding the field made the blunt instrument the only one. The control
actually missing is an admission rule over which policies a caller may pin, which became its own
feature ([`role-scoped-risk-policy-admission.md`](../../../docs/initiatives/role-scoped-risk-policy-admission.md)).

**One deliberate public break rode along.** `GET /api/v1/merge-presets` shipped in 1.41.0 under the
name the product had renamed to "risk policy" a month earlier, and the id it serves is what a task
pins as `riskPolicyId`, so the surface would have carried two names for one concept forever. Renamed
in place rather than dual-served, because 1.41.0 had no adopters; argued in
[`public-api-versions.md`](../public-api-versions.md).

**Adoption takes a NAME rather than a `repoId`**, unlike every other repository operation: a caller
setting a workspace up from configuration knows the name and cannot know a provider's numeric id for
a repository no public read lists. `GitHubSyncService` resolves it through `listAvailableRepos` (the
exact-slug point-read plus the search) rather than a bare `getRepo`, so everything the app's own
picker can reach is adoptable, and the OWNER is part of the match: a slug search can surface a
look-alike, and linking that one would file work in someone else's account while answering 200.

## Consequences

**Three things the platform cannot answer, so the suite states them instead of grading them.**
Repository EMPTINESS is published by no `/api/v1` read (the bootstrapper answered it inside its
container pre-flight, and putting it on the repository LIST would cost a provider round-trip per row
on an endpoint the SPA also uses), so `target-repos` reports what it read and says outright that
emptiness is not part of the verdict. `defaultBranch` is no substitute: GitHub reports `main` for a
repository with no commits. A repository that does not exist and one the credential is not granted
are the same answer from a provider, so `404 repo_not_reachable` names both causes and the remedy
names creation AND access.

**The repositories now need a README.** A `pl_build` scaffold opens a pull request, so the default
branch has to exist; "empty" means "holds a README and nothing else". The bootstrap path accepted a
commitless repository because it wrote the first commit itself.

**"Already backs a service" is not one question.** `GET /api/v1/repos` reports the service a
repository backs ON THIS BOARD, so `serviceId: null` does not mean the repository is free: a
whole-repo service homed on another board of the same account has no id a workspace-scoped surface
can hand back. The contract answers null WITH `linkedElsewhere: true`, `POST /api/v1/services`
refuses with `reason: repo_service_homed_elsewhere`, and `target-repos` plus `adopt.ts` share one
blocker verdict so the gate cannot green-light a pass whose first adopt would 409. The pass-identity
half is separate and needs the LEDGER's service ids: the first shape took
`hasAdoptedServices: Boolean(backend ?? frontend)`, which answers true for BOTH repositories once
either service is adopted.

**An OpenAI API key does not run the GPT built-in, and the refusal has to say so.** `openai` is a
first-class poolable provider with its own onboarding copy ("create a new secret key"), and
`OPENAI_API_KEY` is a reserved platform variable, so the obvious reading of the old
`providers_unconfigured` remedy ("add an API key for the provider") is a `platform.openai.com`
secret. For `gpt-5.6-sol` that buys nothing: its routes are OpenRouter and a Codex subscription,
which is the whole point of the rejected `direct` route above. Left generic, the refusal sent an
operator to buy a key and returned them to the same 409, so `declaredModelRouteLabels` now derives
each unusable model's DECLARED routes from the catalog and the message names them (`gpt-5.6-sol
(needs OpenRouter or ChatGPT (Codex))`). That fixes the misattribution for every
subscription-or-gateway-only model rather than for this preset alone; `details.models` still carries
the bare ids the SPA and the four SDK clients read.

**A model being in the catalog is not a model being available**, and per-user model wiring is
invisible to an API key. A deployment whose humans all run on personal subscriptions or local
endpoints looks, to the public API, like a deployment with no models at all. That is why
`model-preset` is checked separately from `agent-model`, and why it keeps three outcomes apart: no
such preset, a preset naming a dropped model, and a preset whose model has no provider wired.

**Export a normalisation WITH the read it belongs to, or the omission is the easy path.** k3d writes
the wildcard bind address `https://0.0.0.0:6443` into the kubeconfig and `cat-factory k3s` has always
rewritten it, so `normalizeApiServerUrl` is exported beside `readApiServerCommand` /
`readTokenCommand`; a consumer given the read without the rewrite writes an undialable URL and fails
`cluster-connection` against an address nothing listens on.

**When a gate's remedy ends in "go and do it in the app", the question is whether the API is missing
an operation, not whether the message needs rewording.** That is what turned linking into two public
operations, and it generalises past this suite. Its corollary: what is left for a person is EXISTENCE
and ACCESS, and a step naming a screen the platform can now drive itself is worse than no step,
because it reads as required. The one branch still outside this rule at the time of writing is
deleting a leftover service frame, which [#1971](https://github.com/kibertoad/cat-factory/pull/1971)
adds.

**A loop that re-reads on a human's behalf reports every attempt.** "What did you just see" is owed on
each pass, not only the pass that finds what it was waiting for: a silent negative is
indistinguishable from a no-op, and the operator concludes the tool is stuck.
