# Initiative: from-scratch k3d create coverage for the guided k3s CLI

**Status:** proposed (decision pending) · **Owner:** cli / infra-testing · **Started:** 2026-07-01

> Follow-up to PR #603 (the `cat-factory k3s` k3d integration suite). That PR deliberately
> left a from-scratch `k3d cluster create` uncovered by the real-cluster suite. This tracker
> is the durable analysis of **how** we'd cover it and **whether it's worth it**, so a later
> iteration doesn't re-derive the trade-off from scratch. Read this before adding create-path
> integration coverage; update the checklist at the end if the decision changes.

## Goal & rationale

The k3d integration suite added in #603 (`backend/packages/cli/src/k3s.it.spec.ts`) drives the
CLI's real probe + provisioning logic against a real cluster, but reuses the existing `test-k8s`
cluster (`cf-it`). Because that cluster already holds the default apiserver port **6443**, the
suite exercises `provisionCluster`'s **reuse** branch (`create-k3d` against an already-running
named cluster) but **not** a genuinely-new `k3d cluster create`. The question this tracker
answers: is a real from-scratch create worth building, and if so, how?

**End state (if we proceed):** one integration test that runs `provisionCluster('create-k3d', …)`
against a cluster name that does **not** yet exist, so the real `k3d cluster create` subprocess
runs, the fresh `k3d-<name>` kubeconfig context is created, and the subsequent apply/token-read/
apiserver-URL read all succeed against a just-born cluster — then the cluster is torn down.

## Current coverage baseline (what is already validated)

Be precise about the gap before spending CI time on it. As of #603:

- **Unit (mocked `HostShell`)** — `k3s-provision.test.ts` already covers: the exact
  `k3dCreateCommand` / `kindCreateCommand` shape + the generous create timeout; the create
  branch dispatching `k3d cluster create` and then targeting `--context k3d-<name>`; the
  **port-collision hint** on a create failure; the reuse branch skipping create; declined-confirm
  aborting before any create; the non-local `--yes` refusal.
- **Integration (real cluster, #603)** — probe → `use-existing` recommendation; idempotent
  re-provision (byte-identical long-lived token, no duplicate SA, `kubectl apply` reconcile);
  the `create-k3d` **reuse** branch provisioning via a real `--context k3d-<name>`; the built
  handler + deep-link validated against the real contract schema from a real token/URL.
- **CI environment** — the `test-k8s` job itself runs `k3d cluster create cf-it --api-port
  127.0.0.1:6443` (with a 3× retry), so "`k3d cluster create` works in this runner" is already
  proven — just not *through* `provisionCluster`.

### The residual gap (what ONLY a real from-scratch create adds)

Everything below is the *entire* incremental coverage — it is small:

1. `provisionCluster`'s create branch actually spawning `k3d cluster create` (vs. the mocked
   spawn in the unit test) and getting a 0 exit under the real create timeout.
2. The freshly-created `k3d-<name>` context being **immediately usable** by the very next
   `kubectl --context …` apply/read (no race between create returning and the context landing
   in the kubeconfig).
3. `normalizeApiServerUrl` handling what k3d writes for a **fresh** cluster's server field
   (the `0.0.0.0` → `127.0.0.1` rewrite) on a real kubeconfig rather than a fixture string.

## Options (how we'd cover it)

### Option A — add a `--api-port` CLI option, create on a non-default port in the same job

Thread an `--api-port` through `CliOptions` → `k3dCreateCommand(name, port)` (today the port is
hardcoded to `DEFAULT_API_PORT` and never plumbed from options). The IT then creates a throwaway
`cat-factory-cli-it` cluster on e.g. `6444`, so it coexists with `cf-it`'s `6443` in the same
`test-k8s` job.

- **Pros:** exercises the real create in the *existing* job (no second CI job); `--api-port` is
  **independently useful product-wise** — a user whose 6443 is taken currently has no flag to
  move it (the port-collision hint just says "free it"). This is the option that turns the test
  from "extra cost" into "a test that rides along a feature we'd want anyway".
- **Cons:** it's a real change to the **published** CLI (needs a proper changeset + `bin.ts`
  wiring + arg parsing/validation + help text), so it's no longer a test-only follow-up. Two
  clusters in one job raises peak resource use and a second `k3d cluster create` flake surface.

### Option B — dedicated cluster in its own gated CI step/job

Give the CLI IT its own cluster (own `k3d cluster create` on 6443 after `cf-it` is torn down, or
a separate job). No code change to the CLI.

- **Pros:** no product change; fully isolates the create test.
- **Cons:** this is the "dedicated cluster" path already **declined** on cost when scoping #603;
  adds a second cluster lifecycle (create + retry + guaranteed teardown) purely for test #2's
  three residual assertions; slowest option.

### Option C — do nothing (keep #603's boundary)

Accept that the create *command* is unit-tested, the reuse branch is integration-tested against a
real apiserver, and the runner itself proves `k3d cluster create` works.

- **Pros:** zero added CI time/flake; matches the coverage-vs-cost call already made in #603.
- **Cons:** the three residual behaviours above stay un-exercised end-to-end (low risk — they are
  thin glue over well-trodden k3d/kubectl behaviour).

## Cost / benefit

- **Benefit:** LOW as pure test coverage — the residual gap is 3 thin behaviours, and the highest-
  risk piece (does `k3d cluster create` work in CI) is already proven by the job's own setup.
- **Cost:** MEDIUM — a second real cluster create (~20–40s with images cached, plus its own flake/
  retry surface and guaranteed teardown), and for the *good* variant (Option A) a published-CLI
  change with a changeset, not a test-only patch.

## Recommendation

**Do not build a from-scratch create IT for its own sake (Option C stands).** The incremental
real-cluster coverage does not justify a second cluster lifecycle in CI.

**Revisit via Option A only if/when we add `--api-port` for product reasons** (a user with 6443
occupied is a plausible real request). At that point a from-scratch create test on a non-default
port is nearly free to add and validates the new flag at the same time — so the trigger for this
work is a *product* need for `--api-port`, not a testing need. If that never arrives, the gap is
acceptable indefinitely.

## Gotchas carried forward (for whoever picks this up)

- **Port 6443 is taken by `cf-it` in `test-k8s`.** Any same-job create MUST use a different
  `--api-port`, which today is impossible through `provisionCluster` (port is hardcoded) — hence
  Option A's code change is a prerequisite for the cheap path.
- **Guaranteed teardown.** A create IT must delete its cluster in `afterAll` **and** the workflow
  must `k3d cluster delete` on `always()` (a mid-test crash otherwise leaks a cluster into the
  runner). Mirror #603's `afterAll` cleanup + the job's existing `if: always()` teardown step.
- **Flake budget.** `k3d cluster create` pulls `k3d-proxy`/`k3d-tools` from ghcr.io; the existing
  job retries 3×. A second create needs the same retry treatment or it will occasionally red an
  otherwise-green PR.
- **Keep the self-skip local-only guard.** A from-scratch create must still refuse to run against
  a non-local / remote current context (reuse #603's `looksLocalCluster` skip gate).

## Status checklist

| Item | Status | Notes / PR |
| --- | --- | --- |
| Decide whether to build from-scratch create coverage | **done — deferred (Option C)** | This doc; revisit only via Option A |
| Add `--api-port` CLI option (+ arg parse/validate/help + changeset) | todo (only if product-driven) | Prerequisite for cheap Option A create IT |
| From-scratch `create-k3d` integration test on a non-default port | todo (gated on the option above) | Piggyback on `--api-port`; guaranteed teardown + retry |
| Reassess if `--api-port` lands for other reasons | todo | Trigger to pick this back up |
