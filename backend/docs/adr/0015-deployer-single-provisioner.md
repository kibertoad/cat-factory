# ADR 0015: Deployer as the sole environment provisioner

- **Status:** Accepted (implemented)
- **Date:** 2026-07-08
- **Context layer:** backend (`@cat-factory/orchestration`, `@cat-factory/kernel`, `@cat-factory/integrations`)

## Context

A local-mode run on a `kubernetes` service dead-ended at the `tester-api` step with "Ephemeral
run mode selected but no environment coordinates/credentials were provided and no instance of
the service is reachable." Root cause: the tester's run mode is chosen from
`provisioning.type` (`kubernetes`/`custom` ⇒ ephemeral), but its coordinates are rendered only
when a provisioned environment record already exists — and the pipeline in question
(`pl_quick`) had no `deployer` step, so nothing ever provisioned one. Any `kubernetes`/`custom`
service run through a deployer-less pipeline was a guaranteed dead-end at the tester.

More broadly, provisioning logic was scattered: both a `deployer` step and the `human-test` gate
could stand up an environment, which risked duplicate provisioning, drift between what AI and
human testing exercised, and orphaned environments on redeploy.

## Decision

The Deployer is the **only** place environments are provisioned. No other agent or gate
self-provisions — in particular, the `human-test` gate stops standing up its own environment and
instead consumes the one the Deployer provisioned. An environment is provisioned **once per
run**, shared by both AI and human usage.

- **Type-aware injection**: a `deployer` step is injected before the first environment consumer
  in every built-in tester/human-test pipeline. It provisions only when the service's
  provisioning type is `kubernetes`/`custom`, or `docker-compose` with a resolvable compose
  handler; it is a fast skip for `infraless`/undeclared/frontend frames, so uniform injection is
  safe everywhere.
- **Fail fast, not silently dead-end**: a `kubernetes`/`custom`/handler-backed `docker-compose`
  service whose enabled chain reaches a tester/human-test step with no enabled deployer earlier
  is refused at run start with an actionable error, rather than dead-ending at the tester.
- **Redeploy loops back to the Deployer**: when a human-test fixer pushes new commits, or the
  human requests a recreate / pulls in `main`, the gate re-runs the upstream Deployer step to
  rebuild the environment (tearing down the current one first) rather than provisioning itself.
- **Identity-aware teardown**: environment records are cleaned up on supersede by comparing
  `(provisionType, engine[, externalId])`, and torn down through the provider resolved from the
  record itself (not the workspace's primary provider).

## Rationale

- **A single provisioning point removes the class of bug.** Scattering provisioning across the
  deployer and the human-test gate is what produced the silent tester dead-end and risked
  divergent AI/human environments; centralizing it in the Deployer makes "no deployer ran" a
  detectable, refusable precondition instead of a runtime surprise.
- **Loop-back reuses existing step-graph mechanics** (`rerunRange`, the companion-controller
  re-run pattern) rather than inventing a second re-provisioning path for redeploys.
- **Identity-aware teardown degrades safely**: when the new environment's identity isn't yet
  known (an async provisioning placeholder), the system conservatively does not tear down the
  prior one, leaning on the TTL reaper as a backstop rather than risking a live env going down
  under a still-in-flight replacement.

## Consequences

- Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test step
  with no configured compose handler is now refused at run start rather than falling back to an
  in-container (DinD) bring-up; that DinD fallback path is now unreachable.
- A failed teardown must leave the environment record live so the TTL reaper can retry it;
  teardown must run before any soft-delete tombstone, since a deleted row becomes invisible to
  the expiry sweep.
- Deliberately deferred to separate future work: an operational Disposer step, TTL-hardening
  (sweep verification, default 240-minute TTL), and async/container-backed teardown. An
  "extensible custom-gate config" follow-up was also spun out separately.
