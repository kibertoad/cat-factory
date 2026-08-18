# `docs/`

Repo-wide documentation. Backend-specific reference lives next to the backend in
[`backend/docs/`](../backend/docs); the design records it accumulates are in
[`backend/docs/adr/`](../backend/docs/adr).

## Where does a new doc go?

**Ownership follows the READER, not the topic.** Before adding a page here, decide which of two
surfaces it belongs to:

- **[catfactory.ai](https://www.catfactory.ai/)** (repo:
  [kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website)) is for anyone
  who acts WITHOUT cloning this repo: deployers, operators, workspace users, and integrators
  building on the public API, the SDKs, MCP or manifests. The test: can the reader act on the page
  with no checkout?
- **This repository** is for anyone changing the code: flow docs, ADRs, initiative trackers,
  `AGENTS.md` maps, package `README`s, and this repository's own process. The test: is the doc
  updated in the same PR as the code it describes?

Where a topic serves both, split it by DEPTH and never by copy: the website page owns the
user-facing account, and the doc here keeps the internal design plus a link. Two parallel full
accounts is the failure mode this rule exists to end, so a doc here that needs user-level context
links the website section rather than restating it.

Four kinds of doc stay in this repo whatever their audience: a package `README` that ships in a
published tarball (it has to be self-contained), generated reference such as
[`openapi.json`](./openapi.json), GitHub-native files like `CONTRIBUTING.md`, and **a doc a CI guard
reads** ([`environment-variables.md`](./environment-variables.md) is the worked case: the guard's
value is that it fires in the PR that adds the variable, so the doc has to live in that PR's repo).

The full model, its named exceptions and the findings behind them:
[ADR 0051](../backend/docs/adr/0051-documentation-repo-website-split.md).

## The split inside this directory

The split that matters first is by AUDIENCE: everything under
[`internal/`](./internal) is about developing THIS repository (its release
process, its CI tooling, its own cleanup backlog) and describes nothing a
deployment or an integration can use. Everything else describes the platform.

Past that, this directory holds three different kinds of document, and mistaking
one for another is the usual way to be misled:

## Reference

Describes how the platform behaves **today**, and is updated by the change that
would otherwise outdate it.

- [`glossary.md`](./glossary.md): the code-level naming map. Block vs task vs
  card, directory ⇄ package names, runner/executor/transport, and where gates,
  agent kinds and migration parity live. Read this first if a term is ambiguous;
  the PRODUCT vocabulary is the website's
  [Glossary](https://www.catfactory.ai/reference/glossary.html).
- [`environment-variables.md`](./environment-variables.md): every configuration
  variable, and which names are reserved so they can never be resolved into an
  agent process. The canonical list, read by `scripts/check-reserved-env-keys.mjs`
  and rendered onto the website by its `scripts/sync-env-vars.mjs`.
- [`execution-state-machine.md`](./execution-state-machine.md): the run
  lifecycle, its states and transitions, and why it is not XState.
- [`benchmarks/`](./benchmarks): agent benchmark runs and candidate models.

## In-flight initiatives

Trackers for multi-PR work **in progress**. Each describes a target state that
is only partly built, so none of them describes what ships today. Index, reading
guide and lifecycle: [`initiatives/README.md`](./initiatives/README.md).

(These are contributor material too, but they stay here rather than under
`internal/`: essentially every flow doc and CLAUDE.md entry links them, and
moving the tree would rewrite those references, generated CHANGELOGs included,
for no reader's benefit.)

## Contributor-only: [`internal/`](./internal)

How this repository is developed, released and kept honest. Nothing here is part
of the product.

- [`internal/running-tests.md`](./internal/running-tests.md): getting a green
  suite off a CI runner. The Postgres the two facade suites need, and the two
  traps that make a working tree look broken when only a database is missing.
- [`internal/releases.md`](./internal/releases.md): changesets, the runner-image
  rollout recipe, and the checklist for a newly published package.
- [`internal/mutation-testing.md`](./internal/mutation-testing.md): the nightly
  Stryker flow, which packages it mutates, and how to read a score.
- [`internal/dogfooding.md`](./internal/dogfooding.md): cat-factory developing
  cat-factory, and the per-PR preview stacks under
  [`deploy/preview`](../deploy/preview).
- [`internal/localization.md`](./internal/localization.md): i18n status and the
  migration plan.
- [`internal/external-api-sweep.md`](./internal/external-api-sweep.md): every
  hand-written third-party API call checked against the vendor's live docs, with a
  verdict each. **Regenerated wholesale** by the `external-api-sweep` skill, so it
  is always the latest sweep rather than a point-in-time record; its header carries
  the commit swept, because "still correct" is a claim about a tree.

### Point-in-time records

Written against the repo as it stood on a date, and deliberately **not**
maintained afterwards. Useful as history and as a list of things somebody once
found; check anything you plan to act on against the current code first.

- [`internal/code-quality-observability-extensibility-review-2026-07.md`](./internal/code-quality-observability-extensibility-review-2026-07.md)
- [`internal/race-condition-audit-2026-07.md`](./internal/race-condition-audit-2026-07.md)
- [`internal/pr-review-run-efficiency-and-parking-fixes-2026-07.md`](./internal/pr-review-run-efficiency-and-parking-fixes-2026-07.md)
- [`internal/refactoring-candidates.md`](./internal/refactoring-candidates.md): a
  standing backlog of structural cleanups, referenced by the file-size ratchet's
  comments.
- [`internal/modularisation.md`](./internal/modularisation.md): the
  modularisation tracker.
- [`internal/layered-loader-upstream-gaps.md`](./internal/layered-loader-upstream-gaps.md):
  what the Worker pull-coherency slice had to hand-roll around layered-loader
  16.1, as candidates for a first-class home upstream.
- [`internal/handover/`](./internal/handover): notes and reference material
  handed between agent sessions on a specific piece of work.
