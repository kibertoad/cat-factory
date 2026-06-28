# @cat-factory/gates

## 0.2.16

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5

## 0.2.15

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4

## 0.2.14

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.2.13

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2

## 0.2.12

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.2.11

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0

## 0.2.10

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0

## 0.2.9

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.2.8

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/kernel@0.42.2

## 0.2.7

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1

## 0.2.6

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0

## 0.2.5

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0

## 0.2.4

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0

## 0.2.3

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0

## 0.2.2

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/kernel@0.38.1

## 0.2.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0

## 0.2.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0

## 0.1.13

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0

## 0.1.12

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0

## 0.1.11

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0

## 0.1.10

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0

## 0.1.9

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0

## 0.1.8

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0

## 0.1.7

### Patch Changes

- 52d886a: Improve the ergonomics of authoring custom agent kinds and gates:

  - **Typed provider registry** (`defineProviderToken`/`wireProvider`/`requireProvider`, kernel),
    surfaced through `GateContext.getProvider`/`requireProvider`. A custom gate reaches its data
    source through the context instead of a hand-authored module global + unsafe `!`. The built-in
    `@cat-factory/gates` suite dogfoods it (public `wireX` signatures unchanged).
    **Breaking:** `GateContext` gains required `getProvider`/`requireProvider` (use `stubGateContext`).
  - **Schema-driven structured output** (`defineStructuredOutput`, agents): one valibot schema
    derives both the `agent.output` spec and a typed `parse`/`safeParse`, replacing the hand-written
    `shapeHint` string + lenient coercer. `registerAgentKind` auto-fills `agent.output` from a
    `structuredOutput` schema.
  - **Boot-time registration validation** (`validateRegistrations`/`validateRegistrationsOnce`,
    orchestration): a facade validates registered gates/kinds/pipelines at startup (gate `helperKind`
    resolves, `resultView` is known) and fails loudly instead of mid-run. Wired into both runtimes.
  - **Prompt + resultView wiring** (agents/contracts): `FINAL_ANSWER_IN_REPLY` + the read-only
    guardrail are applied to registered kinds from their `agent.surface` (fixing a registered
    `container-explore` kind missing the guardrail); `resultView` is now a typed picklist of
    `RESULT_VIEW_IDS` (unknown ids fail validation instead of silently falling back to prose).

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0

## 0.1.6

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0

## 0.1.5

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/kernel@0.28.1

## 0.1.4

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0

## 0.1.3

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0

## 0.1.2

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.1.1

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.1.0

### Minor Changes

- f4f954b: Dogfood the extensible-gates seam: the built-in polling-gate suite (`ci`, `conflicts`,
  `post-release-health` + the `on-call` escalation) is no longer hard-coded in the engine —
  it ships as a new **`@cat-factory/gates`** package authored ENTIRELY through the public
  `registerGate` seam, depending only on kernel + contracts. If the platform's own gates can
  be expressed as an external package, so can any deployment's.

  **Breaking (pre-1.0, no migration):** the `ci` / `conflicts` / `post-release-health`
  providers leave the engine. `ciStatusProvider`, `mergeabilityProvider`,
  `releaseHealthProvider` and `incidentEnrichment` are removed from
  `ExecutionServiceDependencies` / `CoreDependencies`; a deployment now wires them into the
  gate suite via the exported `wireCiStatusProvider` / `wireMergeabilityProvider` /
  `wireReleaseHealthProvider` / `wireIncidentEnrichment` handles after
  `import '@cat-factory/gates'`. The merge collaborators (`pullRequestMerger`,
  `branchUpdater`) stay on the engine.

  - **gates (new)**: the three gate factories + the four provider wire-handles +
    `registerBuiltinGates()`, registered as an import side effect. Each gate is a
    pass-through until its provider is wired, so a bare import is always safe. Also exports
    `applyGateProviders(overrides)` + the `GateProviderOverrides` bag: a facade build resets
    the deployment-global providers up-front then re-wires from config, and this is the seam
    that re-applies explicit/faked providers AFTER that wiring (so they survive the Worker's
    per-request rebuild and override a config-wired provider) — used by the cross-runtime
    conformance suite to drive the externalized `ci` gate over a controlled verdict.
  - **kernel**: the pure gate logic (`aggregateCi`/`classifyReleaseHealth`/… +
    `renderReleaseEvidence`) and the gate/helper agent-kind constants move into
    `domain/gate-logic.ts` so a gate package can author a gate without depending on the
    engine. New `GateDefinition.resolveHelperCompletion` hook (+ `GateHelperJobResult` /
    `GateHelperCompletionArgs`): the seam an INVESTIGATE-don't-fix helper (`on-call`) needs
    to settle a gate without re-probing — the real gap the dogfood surfaced.
  - **orchestration**: the three inline gates + the bespoke `resolveOnCallStep` /
    `raiseReleaseRegression` / `enrichIncident` / `raiseCiFailed` branches are deleted; the
    engine builds its gate registry purely from what's registered, and drives an on-call-style
    helper completion through the generic `resolveHelperCompletion` hook. The **`merger`**
    step resolver stays a privileged built-in (reclassified): it owns terminal block status
    and executes a policy-gated real merge — a different archetype from the light, externally
    authorable resolvers, so it keeps its engine-internal access rather than the public seam.
  - **worker / node-server**: each facade `import`s `@cat-factory/gates` and wires its
    existing provider impls (`GitHubCiStatusProvider`, `RegistryReleaseHealthProvider`, …)
    via the `wireX` handles instead of threading them through the engine. `local-server`
    inherits this through `buildNodeContainer`.
  - **conformance**: a new cross-runtime assertion drives the externalized built-in `ci`
    gate (green pass-through, red → ci-fixer → re-probe) over a faked provider on both
    runtimes; the registered-gate test now restores the built-ins after clearing the shared
    registry.

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
