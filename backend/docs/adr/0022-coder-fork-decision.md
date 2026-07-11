# ADR 0022: Implementation-fork decision (two-phase Coder step)

- **Status:** Accepted (implemented)
- **Date:** 2026-07-11
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades) + frontend (`@cat-factory/app`)

## Context

The Coder (agentKind `coder`, the standard `build` phase) commits to the first viable
implementation strategy it finds. For non-trivial tasks there are often **materially
different** ways to do the work — "patch the call site vs refactor the seam", "migrate the
schema vs adapt the mapper", "targeted fix vs behind a flag" — and picking between them is
frequently a product/architecture judgement, not a coding judgement. The existing surfaces
caught this badly: the follow-up companion evaluates only AFTER the Coder finished (the branch
already embodies one fork), and the agent-raised `Decision` is unreliable (the Coder decides on
its own whether to ask), unstructured (bare option strings), offers no dialogue, and burns a
full coding container on the aborted attempt.

## Decision

An **optional fork-decision phase on the Coder step**: before any code is written, a dedicated
read-only proposer aggressively surfaces the materially different implementation forks and the
run **parks** for the human to pick a proposed fork, enter a free-text approach, or **chat**
(grounded Q&A) before deciding. The chosen fork is folded into the Coder's prompt as a binding
directive. It is **gated on the task Estimator's estimate** so trivial tasks never pay the extra
container run or the human interrupt.

A container job cannot pause mid-run, so the human park always sits **between two container
dispatches on the same coder step**:

- **Phase A (propose):** the engine dispatches the registered structured explore kind
  **`fork-proposer`** (`container-explore`, read-only clone of the base branch) as a HELPER off
  the coder step. Its structured JSON is recorded into `step.forkDecision`; `singlePath` or <2
  usable forks auto-advances (no park), else the run parks on the standard durable decision-wait
  (`parkStepOnDecision`) and raises a `fork_decision_pending` notification.
- **Human interaction:** pick / custom / chat via a dedicated `fork-decision` result-view window.
  Chat replies are computed by an **inline `ModelProvider` LLM call in the durable driver**
  (`ForkChatService`) using the transient-marker async re-entry protocol (`step.pendingForkChat`
  - the `reentrantForkDecision` guard in `stepInstance`), exactly the `pendingIncorporation`
    pattern. Each chat turn re-parks with a fresh approval id; `maxChatTurns` (default 15) is a hard
    budget.
- **Phase B (implement):** on choose, the step is reset for re-run and the ordinary Coder dispatch
  runs with the chosen fork folded into `AgentRunContext.implementationChoice` (the chosen
  approach + the rejected alternatives), rendered by `implementationChoiceSection` into the
  `build` prompt.

**Configuration** lives in two places: the estimate thresholds on the workspace **risk policy**
(`riskPolicySchema.forkDecision`, reusing `stepGatingSchema` verbatim so the runtime check is the
existing `shouldRunGatedStep`), disabled by default; and a per-task **tri-state**
(`coder.forkDecision` ∈ `auto`/`always`/`off`) riding the existing agent-config contribution seam
(`BUILTIN_CONFIG_CONTRIBUTIONS`) — so no pipeline-builder change and no new `Block` field.

## Rationale

- **In the coder step, not a separate pipeline step.** A free-standing producer step would have
  to be added to every pipeline, would need cross-step plumbing to reach the coder, and could not
  ride the estimate gate (`assertValidGating` restricts `stepGating` to companion kinds). The
  accepted pattern for a producer-attached feature with its own estimate gate is the tester-QC
  companion — config on the producer step — and this mirrors it.
- **All state rides the run's `PipelineStep`** (`step.forkDecision` + the transient
  `pendingForkChat`), so D1 ⇄ Drizzle parity is free (no side table), exactly like `followUps` /
  `testerQuality`. No new `WorkspaceEvent` (the `execution` event carries the whole instance) and
  the durable drivers are untouched (the whole flow rides the existing `awaiting_decision` /
  `signalDecision` protocol).
- **No harness/image change.** The generic `container-explore` dispatch + structured output
  already cover the proposer; no new dispatch kind, no image-tag bump. The chat is a pure inline
  LLM call in the driver.
- **Prompt-only was rejected** (`AgentRunResult.decision`): it cannot guarantee "aggressively",
  offers bare-string options with no approach/tradeoffs/risk view, has no chat, and re-runs the
  coder after a full coding container was already spent.
- **Pass-through everywhere it can't run** (tri-state `off`, gate not met, proposer/chat model
  unwired) so existing pipelines and engine tests behave exactly as before. A no-model chat
  degrades to a canned "chat unavailable" turn rather than wedging the parked run — pick / custom
  still work.

## Consequences

- The cross-runtime conformance suite asserts the whole loop (gate-skip / propose→park→choose→coder
  / single-path auto-advance / chat-endpoint no-model degradation) against both facades, and a
  Playwright e2e drives the live park→chat→choose→resume round-trip. The prompts are version-gated
  (`build` v4, `fork-proposer` v1, `fork-chat` v1) so Kaizen re-grades on a bump.
- **Scoped to the run's primary repo** (single-repo tasks): `fork-proposer` deliberately does NOT
  set `fanOutMultiRepo`, so the window/state model stays a single choice. Per-repo fork sets are a
  deliberate follow-up.
- Deferred by design: injecting the choice into reviewer/tester context (the PR embodies it),
  Kaizen grading of fork-proposal quality, surfacing the chosen fork in the PR description, and a
  cheaper default model for the proposer.
