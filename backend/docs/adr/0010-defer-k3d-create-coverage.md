# ADR 0010: Defer from-scratch k3d cluster-create integration coverage for the guided k3s CLI

- **Status:** Accepted
- **Date:** 2026-07-01
- **Context layer:** backend (`@cat-factory/cli`)

## Context

PR #603 added a k3d integration suite (`backend/packages/cli/src/k3s.it.spec.ts`) that drives
the CLI's real probe + provisioning logic against a real cluster. Because that suite reuses
the CI job's existing `test-k8s` cluster (`cf-it`, which already occupies the default apiserver
port 6443), it exercises `provisionCluster`'s **reuse** branch (`create-k3d` against an
already-running named cluster) but not a genuinely-new `k3d cluster create` — the port is
hardcoded and not plumbed from CLI options, so a same-job second cluster can't be created
without a product change.

Existing coverage is already substantial: unit tests (mocked `HostShell`) cover the exact
create-command shape, the create timeout, the port-collision hint, and the reuse/decline/
non-local-refusal branches; the #603 integration suite covers probe recommendation, idempotent
re-provisioning, and the reuse branch against a real apiserver; and the CI `test-k8s` job's own
setup step already proves `k3d cluster create` works in the runner — just not through
`provisionCluster`. The residual, unexercised gap is exactly three thin behaviours: the create
branch actually spawning `k3d cluster create` end-to-end, the freshly-created context being
immediately usable by the next `kubectl` call, and `normalizeApiServerUrl` handling a genuinely
fresh cluster's kubeconfig server field.

## Decision

Do not build dedicated from-scratch create-path integration coverage now. Accept the residual
gap. Revisit only if/when an `--api-port` CLI option is added for independent product reasons
(a user whose default 6443 is occupied currently has no way to move it) — at that point, add a
from-scratch create test cheaply as a byproduct of that feature, creating a throwaway cluster on
a non-default port in the same `test-k8s` job.

## Rationale

- **Benefit is low.** The residual gap is three thin behaviours over well-trodden k3d/kubectl
  mechanics; the highest-risk question — does `k3d cluster create` work in this CI runner at
  all — is already proven by the job's own setup step.
- **Cost is medium and asymmetric to the benefit.** A from-scratch create needs either a second
  real cluster lifecycle in the same job (peak resource use, a second flake/retry surface,
  guaranteed teardown) or a dedicated CI job/step (slower, already rejected on cost when #603
  was scoped), and the cheap path requires a real change to the **published** CLI
  (`--api-port`, with arg parsing, validation, help text, and a changeset) rather than a
  test-only patch.
- **Piggybacking on a real feature is the only version worth building.** If `--api-port` ships
  for its own product reason, the create test becomes nearly free and validates the new flag at
  the same time — so the trigger for this work should be product-driven, not testing-driven.

## Alternatives considered

- **Option A — add `--api-port`, create a second cluster on a non-default port in the same
  job.** Exercises the real create branch and is independently useful product-wise, but is a
  real change to the published CLI, not a test-only follow-up, and raises peak resource use /
  flake surface in the job.
- **Option B — a dedicated cluster in its own gated CI step/job.** No CLI code change, fully
  isolated, but this is the "dedicated cluster" approach already declined on cost when #603 was
  scoped, and it is the slowest option for three residual assertions.

## Consequences

- The three residual behaviours (real create-branch execution, immediate context usability,
  fresh-cluster URL normalization) remain unexercised end-to-end; assessed as low risk since
  they are thin glue over already-proven k3d/kubectl behaviour.
- If `--api-port` is later added for product reasons, a from-scratch create IT should be added
  alongside it, reusing #603's guaranteed-teardown (`afterAll` + workflow `if: always()`),
  retry budget (matching the job's existing 3× create retry), and local-only skip guard
  (`looksLocalCluster`).
- If `--api-port` never ships, the coverage gap is accepted indefinitely.
