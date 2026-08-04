# `docs/`

Repo-wide documentation. Backend-specific reference lives next to the backend in
[`backend/docs/`](../backend/docs); the design records it accumulates are in
[`backend/docs/adr/`](../backend/docs/adr).

This directory holds three different kinds of document, and mistaking one for
another is the usual way to be misled:

## Reference

Describes how the platform behaves **today**, and is updated by the change that
would otherwise outdate it.

- [`glossary.md`](./glossary.md): vocabulary and naming map. Block vs task vs
  card, directory ⇄ package names, runner/executor/transport, and where gates,
  agent kinds and migration parity live. Read this first if a term is ambiguous.
- [`environment-variables.md`](./environment-variables.md): every configuration
  variable, and which names are reserved so they can never be resolved into an
  agent process.
- [`execution-state-machine.md`](./execution-state-machine.md): the run
  lifecycle, its states and transitions, and why it is not XState.
- [`releases.md`](./releases.md): changesets, the runner-image rollout recipe,
  and the checklist for a newly published package.
- [`dogfooding.md`](./dogfooding.md): cat-factory developing cat-factory, and
  the per-PR preview stacks under [`deploy/preview`](../deploy/preview).
- [`localization.md`](./localization.md): i18n status and the migration plan.
- [`benchmarks/`](./benchmarks): agent benchmark runs and candidate models.

## In-flight initiatives

Trackers for multi-PR work **in progress**. Each describes a target state that
is only partly built, so none of them describes what ships today. Index, reading
guide and lifecycle: [`initiatives/README.md`](./initiatives/README.md).

## Point-in-time records

Written against the repo as it stood on a date, and deliberately **not**
maintained afterwards. Useful as history and as a list of things somebody once
found; check anything you plan to act on against the current code first.

- [`code-quality-observability-extensibility-review-2026-07.md`](./code-quality-observability-extensibility-review-2026-07.md)
- [`race-condition-audit-2026-07.md`](./race-condition-audit-2026-07.md)
- [`pr-review-run-efficiency-and-parking-fixes-2026-07.md`](./pr-review-run-efficiency-and-parking-fixes-2026-07.md)
- [`refactoring-candidates.md`](./refactoring-candidates.md): a standing backlog
  of structural cleanups, referenced by the file-size ratchet's comments.
- [`modularisation.md`](./modularisation.md): the modularisation tracker.
- [`handover/`](./handover): notes and reference material handed between agent
  sessions on a specific piece of work.
