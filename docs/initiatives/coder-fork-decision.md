# Initiative: Coder implementation-fork decision (design)

> **Status: PR 1 landed (backend + frontend, no chat).** The propose → park → choose → Coder
> loop, the single-path auto-advance, the risk-policy gate + per-task tri-state, and the whole
> UI (window, routing, notification, risk-policy editor, i18n) are implemented and covered by
> the cross-runtime conformance suite (asserted against real Postgres on the Node facade).
> **PR 2 remains: grounded chat** (`pendingForkChat` re-entry + `ForkChatService` + the chat
> endpoint/thread + the `fork-chat` prompt) and the e2e spec. Update the checklist and the
> "Conventions & gotchas" section as each further slice lands.
>
> **Open question 4 resolved (single-repo scope):** PR 1 surfaces forks for the run's primary
> repo only — the `fork-proposer` kind deliberately does NOT set `fanOutMultiRepo`, so the
> window/state model stays a single choice. Per-repo fork sets are a future follow-up.

## Goal & rationale

Today the Coder (agentKind `coder`, the standard `build` phase) commits to the first viable
implementation strategy it finds. For non-trivial tasks there are often **materially
different** ways to do the work — "patch the call site vs refactor the seam", "migrate the
schema vs adapt the mapper", "targeted fix vs behind a flag" — and picking between them is
frequently a product/architecture judgement, not a coding judgement. The existing surfaces
catch this class of decision badly:

- The **follow-up companion** evaluates only after the Coder finished — the branch already
  embodies one fork, so redirecting means throwing work away.
- The **agent-raised `Decision`** (`AgentRunResult.decision`) is unreliable (the Coder decides
  on its own whether to ask), unstructured (bare option strings, no approach/tradeoffs/risk),
  offers no dialogue, and burns a full coding container on the aborted attempt.

This initiative adds an **optional fork-decision phase on the Coder step**: before any code is
written, a dedicated read-only proposer **aggressively surfaces the materially different
implementation forks** for the task and the run **parks** for the human to choose. The human
can pick a proposed fork, **enter their own approach as free text**, or **chat** (grounded
back-and-forth Q&A about the forks) before deciding. The chosen fork is folded into the
Coder's prompt as a binding directive. The phase is **gated on the task Estimator's
complexity/risk/impact estimate** so trivial tasks never pay the extra container run or the
human interrupt.

Design decisions (confirmed with the requester):

1. **Architecture**: the fork phase lives **inside the coder step** (a two-phase coder step),
   not as a separate pipeline step and not prompt-only.
2. **Gating config**: the estimate thresholds live on the **workspace risk policy** preset;
   the per-task control is a **tri-state toggle** (`auto` / `always` / `off`).
3. **Chat**: full multi-turn chat is part of the design (inline LLM in the durable driver, no
   container re-dispatch); the implementation may phase it as PR 2.

## Target pattern — a two-phase Coder step

A container job cannot pause mid-run (the harness runs start→terminal; the only mid-run
channel is the one-way follow-ups JSONL tail), so a human park always sits **between two
container dispatches on the same pipeline step**:

- **Phase A (propose):** when the option is active, the engine dispatches a new registered
  structured explore kind **`fork-proposer`** (`container-explore`, read-only clone of the
  base branch — the `bug-investigator.ts` template) _as a helper off the coder step_, via the
  existing `options.agentKind` override in `AgentContextBuilder.buildContext` (the same
  mechanism gate helpers and the Tester's fixer use). Its structured JSON is recorded into a
  new `step.forkDecision` state; the run parks on the standard durable decision-wait
  (`RunStateMachine.parkStepOnDecision`) and raises a `fork_decision_pending` notification
  (mirroring `raiseFollowUpPending`).
- **Human interaction:** pick / custom / chat via a dedicated result-view window. Chat replies
  are computed by an **inline `ModelProvider` LLM call in the durable driver** using the
  transient-marker async re-entry protocol (a new `step.pendingForkChat`, the exact
  `pendingRecommendation` / `pendingIncorporation` pattern from `ReviewGateController`).
- **Phase B (implement):** on choose, the step is reset for re-run (`resetStepForRerun` +
  `startStep` + `signalDecision` — the `loopCoderForFollowUps` / `applyFollowUpDecision`
  template) and the ordinary Coder dispatch runs on `cat-factory/<blockId>` with the chosen
  fork folded into its prompt.

Key properties, all deliberate:

- **No harness/image change** — the generic `container-explore` dispatch + structured output
  (`resolveStructuredOutput` → `result.custom`) already cover the proposer; no new dispatch
  kind, no image-tag bump.
- **No new table** — all fork state rides the run's `PipelineStep` (the instance's steps
  JSON), so D1 ⇄ Drizzle parity is free, exactly like `followUps` / `testerQuality`.
- **No new WorkspaceEvent** — the `execution` event carries the whole instance, so the fork
  window stays live the same way the follow-up window does.
- **Durable drivers untouched** — the whole flow rides the existing `awaiting_decision` /
  `WorkRunner.signalDecision` protocol on both Cloudflare Workflows and Node pg-boss.

### Rejected alternatives

- **A separate `fork-proposer` pipeline step before the coder.** Users would have to add it to
  every pipeline; the chosen fork would need cross-step plumbing to reach the coder (in-step,
  `step.forkDecision.chosen` is read directly by the context builder, like `step.rework`); and
  `assertValidGating` (`pipelineShape.ts`) deliberately restricts `stepGating` to companion
  kinds, so a free-standing producer step could not ride the estimate gate without weakening
  that rule. The accepted codebase pattern for a producer-attached feature with its own
  estimate gate is the tester-QC companion — config on the producer step, not a new step —
  and this design mirrors it.
- **Prompt-only (`AgentRunResult.decision`).** Cannot guarantee "aggressively"; options are
  bare strings (no approach/tradeoffs/risk view); no chat; and the decision resolution
  re-runs the coder after a full coding container was already spent on the aborted attempt.
  The existing `Decision` machinery stays untouched.

## Configuration — risk-policy thresholds + per-task tri-state

**Thresholds live on the workspace risk policy** (the per-workspace preset that already
carries the auto-merge ceilings, `ciMaxAttempts`, `maxRequirementIterations`,
`maxTesterQualityIterations`, …), resolved block pin → workspace default → built-in:

- `riskPolicySchema` (`backend/packages/contracts/src/merge.ts`) gains
  `forkDecision: v.optional(v.nullable(stepGatingSchema))` — reusing the existing
  `stepGatingSchema` (`contracts/src/consensus.ts`:
  `{ enabled, minComplexity?, minRisk?, minImpact?, onMissingEstimate: 'run' | 'skip' }`)
  **verbatim**, so the runtime check is the existing
  `shouldRunGatedStep(block.estimate, gating)` (`stepGating.logic.ts`) with zero new gating
  logic. A fork is proposed when ANY supplied axis of the block's estimate meets its
  threshold. `onMissingEstimate: 'run'` means "propose even without an estimate" (fail toward
  asking, consistent with consensus gating's fail-safe) and is the default when a workspace
  enables the group. Absent/disabled on a policy ⇒ fork surfacing is off in `auto` mode.
- Update the create/update preset request contracts, `DEFAULT_RISK_POLICY` +
  `seedRiskPolicies()` (kernel `domain/catalog.ts`) with the group **disabled by default** +
  the built-in preset `version` bump, and the SPA preset editor (`stores/riskPolicies.ts` +
  the preset panel) with the new fields.

**The per-task tri-state rides the existing agent-config contribution seam**
(`contracts/src/agent-config.ts`, `agents/src/agents/kinds/configs.ts`
`BUILTIN_CONFIG_CONTRIBUTIONS`) — a new `coder` entry:

```ts
{
  id: 'coder.forkDecision',
  agentKind: 'coder',
  label: 'Implementation-fork decision',
  description:
    'Surface materially different implementation approaches before the Coder writes code and park for a human choice. `auto` gates on the task risk policy; `always` proposes regardless; `off` never proposes.',
  type: 'select',
  // AgentConfigDescriptor options are `{ value, label }` objects (see the
  // `playwright.e2eTarget` descriptor in `configs.ts`), not bare tokens.
  options: [
    { value: 'auto', label: 'Auto (gate on risk policy)' },
    { value: 'always', label: 'Always propose' },
    { value: 'off', label: 'Off' },
  ],
  default: 'auto',
}
```

This reuses the task-creation + inspector rendering (`TaskAgentConfig.vue`) and the
freeze-once-the-owning-step-starts semantics for free — no new `Block` field. Semantics:

- `off` — never propose.
- `always` — propose regardless of estimate/policy.
- `auto` (default) — resolve the block's risk policy (the same injected `resolveRiskPolicy`
  the merge resolver and requirements gate use) and apply
  `shouldRunGatedStep(block.estimate, policy.forkDecision)`.

Because the config lives on the policy + the block (not the pipeline), **no pipeline-builder
changes and no new `pipelineShape` validation are needed**; a pipeline without a
`task-estimator` is handled at runtime by `onMissingEstimate`.

## Data model — new `backend/packages/contracts/src/forkDecision.ts`

Re-exported from the contracts index and from `@cat-factory/kernel` (the `followUp.ts`
pattern):

- `forkOptionSchema` — one materially different approach:
  `{ id, title, summary, approach, tradeoffs[], riskNotes?, recommended? }`. `id` is
  engine-minted (`fork_*`); `approach` is the concrete plan (seams/files/modules +
  sequencing); `tradeoffs` are honest pros AND cons; the proposer marks exactly one
  `recommended`.
- `forkChatMessageSchema` — `{ id, role: 'human' | 'assistant', text (≤4000), createdAt }`.
  Assistant turns are appended by the durable driver.
- `forkDecisionStatusSchema` — the lifecycle:
  - `proposing` — the fork-proposer explore job is in flight (phase A)
  - `awaiting_choice` — parked; the human picks / types custom / chats
  - `answering` — a chat turn is pending (`pendingForkChat` set; driver computing the reply)
  - `chosen` — human decided; the Coder dispatch (phase B) runs next
  - `single_path` — the proposer's escape hatch fired; no park, the Coder runs directly
  - `skipped` — the estimate gate was not met (or tri-state `off`)
- `forkChoiceSchema` — the human's resolution: exactly one of `forkId` / `custom` (xor
  `v.check`), an optional steering `note` on a picked fork, `at`.
- `forkDecisionStepStateSchema` — the live state on the run's coder step:
  `{ status, seamSummary?, forks[], singlePathReason?, chat[], maxChatTurns (default 15),
chosen?, model? }`. `seamSummary` is the proposer's read of where the change lands
  (grounding for the human + the chat); `maxChatTurns` bounds inline LLM spend and step-row
  size; `model` records the proposing model for transparency.
- Request bodies: `forkChatRequestSchema` `{ text (trimmed, 1..4000) }`; `chooseForkSchema`
  (the xor shape above, `custom` ≤8000).

Changes to existing contracts:

- `pipelineStepSchema` (`entities.ts`) gains `forkDecision?` (created lazily by the engine
  when the phase activates — the config itself never lives on the step) and the transient
  re-entry marker `pendingForkChat?: { messageId }` (documented beside
  `pendingIncorporation` / `pendingInterview`).
- `notifications.ts` gains type `'fork_decision_pending'` (+ an optional `forkCount` payload
  field; reuse `pipelineName`).
- `result-views.ts` `RESULT_VIEW_IDS` gains `'fork-decision'`.
- Kernel `AgentRunContext` gains:

```ts
implementationChoice?: {
  source: 'proposed' | 'custom'
  title: string
  approach: string
  note?: string
  /** Titles of the rejected alternatives, so the coder doesn't drift into them. */
  alternativesConsidered: string[]
}
```

## Engine flow (orchestration)

New `backend/packages/orchestration/src/modules/execution/ForkDecisionController.ts` + pure
helpers in `forkDecision.logic.ts` (unit-tested), wired via `RunDispatcherDeps`, shaped like
`ReviewGateController`:

1. **Step handler** — `RunDispatcher.buildStepHandlerRegistry()` gains an entry (order ~170,
   after `inline-companion`, before the fallthrough): `canHandle` = coder step + fork phase
   active (the pure predicate: tri-state resolves to on/auto-pass AND
   `step.forkDecision?.status` is not `chosen` / `single_path` / `skipped`). When the phase is
   resolved the handler returns `null` and the ordinary `handleAgentStep` dispatches the
   Coder.
2. **Fresh entry** (`evaluate`): resolve the tri-state (`resolveAgentConfigValue` over the
   `coder.forkDecision` descriptor + `block.agentConfig`), then for `auto` the risk-policy
   gate (§ Configuration). Not satisfied → `step.forkDecision = { status: 'skipped' }`, fall
   through (Coder runs). Satisfied → `status: 'proposing'`, dispatch the `fork-proposer`
   explore job **on this step** (`contextBuilder.buildContext(…, { agentKind:
FORK_PROPOSER_KIND })` + the async-dispatch tail of `handleAgentStep`, factored into a
   shared private dispatch helper rather than duplicated), return `awaiting_job`.
3. **Proposal completion** — `buildStepCompletionInterceptors()` gains a `fork-proposal`
   interceptor (`canIntercept` on `status === 'proposing'`; runs after spend metering, before
   output/PR/follow-up/approval handling — none of which apply to the proposer). Parse
   `result.custom` via the registry's structured-output parser (lenient `v.fallback`s):
   - `singlePath === true` or <2 usable forks → `status: 'single_path'` (+ reason),
     `resetStepForRerun` + `startStep`, persist + emit, return `{ kind: 'continue' }` — the
     driver immediately re-enters and dispatches the Coder. No park.
   - Otherwise → mint fork ids, record `forks` / `seamSummary` / `model`,
     `status: 'awaiting_choice'`, raise `fork_decision_pending`, return
     `parkStepOnDecision(...)`.
4. **Re-entry guard** — add `reentrantForkDecision` (`step.pendingForkChat` set) to the
   `waiting_decision` fall-through disjunction in `ExecutionService.stepInstance`, beside
   `reentrantHumanTest`, so a parked step with a pending chat turn re-enters the controller
   instead of immediately re-parking.
5. **Chat** (`ForkDecisionController.chat`) — the `ReviewGateController.incorporate` template:
   - CAS `mutateInstance`: find the coder step with `state === 'waiting_decision'` &&
     `approval?.status === 'pending'` && `forkDecision?.status === 'awaiting_choice'` (else
     `ConflictError`); enforce `maxChatTurns`; append the human message; set
     `status: 'answering'` + `pendingForkChat = { messageId }`; flip `blocked → running`;
     capture the approval id.
   - After the CAS: `emitInstance` + `workRunner.signalDecision(…, approvalId, 'fork-chat')`.
     Return the updated state immediately (the reply arrives via the `execution` event).
   - Driver re-enters → clear the marker, run the inline chat LLM (a small `ForkChatService`
     copying `DocInterviewService`'s scoped model resolution — block pin → workspace per-kind
     default → routing default — and its usage metering), append the assistant reply,
     `status: 'awaiting_choice'`, re-park (fresh approval id). **No model wired → append a
     canned "chat unavailable" assistant message and re-park** (graceful degradation; pick or
     custom still work).
6. **Choose** (`ForkDecisionController.choose`) — the `applyFollowUpDecision` 'loop' template:
   - CAS: validate the fork id / custom text against the fresh snapshot; set
     `forkDecision.chosen` + `status: 'chosen'`; `resetStepForRerun` + `startStep`;
     `blocked → running`; capture the approval id.
   - After the CAS: `clearWaitingNotification`, `updateBlockProgress(…, 'in_progress')`,
     `signalDecision(…, approvalId, 'approved')`, `emitInstance`. The driver re-enters; the
     fork handler's `canHandle` is now false; `handleAgentStep` dispatches the Coder normally.
     Follow-ups / approval gate / PR handling at Coder completion are unchanged (they evaluate
     at completion, after phase B).
7. **Context fold** — `AgentContextBuilder.buildContext` sets `context.implementationChoice`
   from `step.forkDecision.chosen` (resolving the chosen `forkOption`, or the custom text as
   `source: 'custom'`) when dispatching the step's **own** coder kind. Also fix the adjacent
   latent issue while there: gate the `followUpCompanion: true` flag on
   `agentKind === step.agentKind`, so a helper dispatch off the coder step (the fork-proposer)
   never inherits the Coder's follow-up streaming guidance.
8. **Job identity** — extend `dispatchEpochFor` (`dispatchEpoch.logic.ts`): +1 when the fork
   phase is resolved (`chosen` / `single_path`), so the phase-B Coder dispatch gets a distinct
   harness job id on container-reusing transports (the same guarantee fixer/helper rounds
   get).

Companion rework loops and follow-up loop-backs re-enter the step with `status === 'chosen'`,
so the proposal never re-runs within one run; a full pipeline re-run starts a fresh instance
and a fresh proposal.

## HTTP API

Execution-scoped, mirroring the follow-up routes (`contracts/src/routes/followUp.ts`), all
under `/workspaces/:workspaceId`; new `server/src/modules/forkDecision/ForkDecisionController.ts`
delegating through `ExecutionService` pass-throughs (the follow-up delegation pattern):

| Contract                  | Method/path                                          | Body                    | 200                                       |
| ------------------------- | ---------------------------------------------------- | ----------------------- | ----------------------------------------- |
| `getForkDecisionContract` | `GET /executions/:executionId/fork-decision`         | —                       | `v.nullable(forkDecisionStepStateSchema)` |
| `forkChatContract`        | `POST /executions/:executionId/fork-decision/chat`   | `forkChatRequestSchema` | `forkDecisionStepStateSchema`             |
| `chooseForkContract`      | `POST /executions/:executionId/fork-decision/choose` | `chooseForkSchema`      | `forkDecisionStepStateSchema`             |

- The GET resolves the "active" fork step with an `activeForkDecisionStep` helper mirroring
  `activeFollowUpStep` (pipelines with multiple coder steps).
- `ConflictError` (409) when not awaiting a choice / chat budget spent; `NotFoundError` when
  no fork-bearing step exists.
- The notification `act` route gains a `fork_decision_pending` handler (mark read +
  deep-link; the choice itself happens in the window).

## Frontend

- **Window**: `components/forkDecision/ForkDecisionWindow.vue`, result-view id
  `'fork-decision'`, registered in `StepResultViewHost.vue`, built on
  `useResultView('fork-decision', …)`. Layout: seam summary → fork cards (title / summary /
  approach / tradeoffs / risk notes, "recommended" badge, select) → custom-approach textarea →
  chat thread (interaction model: `DocInterviewWindow.vue`; card model: `FollowUpWindow.vue`)
  → Choose. Status-driven rendering: `proposing` (spinner), `answering` ("thinking…" bubble),
  `chosen` / `single_path` (read-only record of what was decided and why — the step's
  permanent result view).
- **Store**: `stores/forkDecision.ts` — keyed by executionId; `load` (GET), `chat`, `choose`;
  live state read off the coder step's `forkDecision` from the `execution` events already
  dispatched in `useWorkspaceStream.ts` (the followUps-store pattern; **no new event type**).
- **Routing**: `ui.dispatchStepView` routes a coder step with fork state to the window (taking
  precedence over the prose panel while `awaiting_choice`); `TaskExecution.vue` renders a
  "Choose approach" button on the parked step beside the existing decision/approval buttons;
  `NotificationsInbox.vue` META/ACTION_KEYS + `reveal` get the new type;
  `PipelineProgress.vue` shows phase chips ("Proposing approaches" / "Choose an approach").
- **Settings surfaces**: the risk-policy editor gains the fork gating group (enabled +
  min-complexity/risk/impact + on-missing-estimate); the tri-state select renders through the
  existing agent-config UI (`TaskAgentConfig.vue`) — no bespoke `TaskRunSettings` control
  needed.
- **i18n**: all copy in `en.json` + real translations in all other locales, same PR (keys
  under `forkDecision.*`, `notifications.fork_decision_pending*`, the risk-policy editor
  additions).
- **data-testids**: `fork-decision-window`, `fork-option-card`, `fork-option-choose`,
  `fork-custom-input`, `fork-chat-input`, `fork-chat-send`.

## Prompts

### `fork-proposer` (new registered kind)

`agents/src/agents/kinds/fork-proposer.ts`, registered in `defaultAgentKindRegistry`:
`agent: { surface: 'container-explore', clone: { branch: 'base' } }`, `fanOutMultiRepo` (a
cross-service task's forks may differ per repo — but see open question 4: the choose/park/window
flow is single-choice, so the per-repo fan-out UX must be resolved before PR 1), a lenient
`defineStructuredOutput` (the
`bugInvestigation` shape) over
`{ seamSummary, forks: [{ title, summary, approach, tradeoffs, riskNotes, recommended }],
singlePath, singlePathReason }`. **No `presentation`** — it is never a palette step; its
output renders through the coder step's fork window, not `generic-structured`. Read-only +
final-answer directives are auto-appended for explore kinds.

The system prompt is the operational definition of **"aggressive"**:

- You are a senior engineer deciding **how** to implement a task, before anyone writes code.
  Read the relevant code first; state the seam in `seamSummary`.
- Enumerate every **materially different** approach: different seam (call site vs
  abstraction), different data shape (migrate vs adapt), different blast radius (targeted
  patch vs refactor), different delivery strategy (behind a flag vs direct). Target 2–4
  forks. Two forks are materially different only if they lead to different code being
  reviewed, different risk, or different future maintenance — naming/style variants of one
  approach are ONE fork.
- Per fork: a concrete `approach` (the modules/files touched and the order of work), honest
  `tradeoffs` in both directions, `riskNotes` for anything irreversible (schema, wire
  contracts, data).
- Mark exactly one fork `recommended` and justify it inside its tradeoffs.
- **Escape hatch**: set `singlePath: true` ONLY when any competent senior engineer would
  implement it the same way (a trivial/obvious fix, or the codebase already prescribes the
  pattern) — then fill `singlePathReason` and return that one fork. Fabricating cosmetic
  forks for trivial work is a failure; missing a genuine patch-vs-refactor or
  migrate-vs-adapt split is a worse one.
- Return ONLY the JSON object (shape spelled out in the prompt, as in `bug-investigator.ts`).

### Chat responder (inline)

`agents/src/agents/prompts/fork-decision.ts`: "You are the engineer who proposed these
implementation approaches." Grounding assembled by `ForkChatService`: the effective task
description (the reworked-requirements resolution the context builder already computes),
`seamSummary`, the forks as JSON, and the chat so far. Rules: answer concretely and
comparatively, referencing forks by title; if the human floats a new direction, evaluate it
honestly (they can submit it as a custom choice); recommend only when asked; never claim to
have chosen; a few sentences per answer.

### Coder prompt changes

- A new `implementationChoiceSection(context)` appended in `renderStandardUserPrompt` for
  `phase === 'build'` (beside `technicalContextSection`): the chosen approach title + full
  `approach` text, the human's `note`, and "Alternatives considered and rejected: …" (titles
  only) with an explicit "do not drift into a rejected alternative; surface a follow-up if
  the chosen approach proves unworkable".
- One line in `SYSTEM_PROMPTS.build`'s Approach list: "If the task context pins a CHOSEN
  IMPLEMENTATION APPROACH, implement that approach faithfully — do not silently switch to an
  alternative."
- **Version bumps** (`agents/src/agents/kinds/versions.ts`): `build` v3 → v4; new
  `fork-proposer` v1 and `fork-chat` v1 entries in `PROMPT_VERSIONS`.

## Conventions & gotchas (carry between iterations)

- **Runtime symmetry is free but must stay free**: all fork state rides the step JSON — do
  NOT introduce a side table for chat or proposals; if one ever becomes necessary it must be
  mirrored D1 ⇄ Drizzle with a conformance assertion in the same change.
- **Valibot declaration order**: `stepGatingSchema` lives in `consensus.ts` and is imported by
  `merge.ts` for the risk-policy field — check the contracts import graph stays acyclic
  (`forkDecision.ts` should import from `consensus.ts`, not the reverse).
- **The park is always `parkStepOnDecision` (an approval id)** — never a hand-rolled
  `awaiting_x`; every re-park after a chat turn mints a fresh approval id (the review-gate
  convention), and every human action is CAS-guarded `mutateInstance` with the settle
  (signal/emit/notify) AFTER the CAS wins.
- **Pass-through everywhere it can't run**: tri-state `off`, policy group absent/disabled,
  estimate gated out, proposer executor unwired (tests/conformance), or chat model unwired ⇒
  the Coder behaves exactly as before / the window degrades. Existing engine tests without
  fork config must pass unchanged.
- **The proposer is a helper dispatch on the coder step** — mind context-flag leakage: any
  step-scoped flag keyed off the step's kind (e.g. `followUpCompanion`) must check the
  _effective_ dispatched kind, or the proposer inherits Coder-only guidance.
- **`maxChatTurns` is a hard budget** (409 past it) — the chat is grounded on a fixed
  proposal, not a container; unbounded turns only add spend and step-row bloat.
- **Prompt edits bump versions** — the `build` prompt change is a version bump; Kaizen keys
  on the `(prompt, agent, model)` combo.

## Per-item status

| Area                                                                                                                                                                                                                                                  | Status | PR   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| Contracts: `forkDecision.ts` (option/chat/status/choice/state + request bodies), `pipelineStepSchema.forkDecision` + `pendingForkChat`, notification type, result-view id                                                                             | done   | PR 1 |
| Contracts + kernel: `riskPolicySchema.forkDecision` (reusing `stepGatingSchema`) + preset request contracts + `DEFAULT_RISK_POLICY`/seeds + version bump                                                                                              | done   | PR 1 |
| Kernel: `AgentRunContext.implementationChoice`                                                                                                                                                                                                        | done   | PR 1 |
| Agents: `fork-proposer` kind (structured explore, `bug-investigator` template) + registry entry + prompt versions (`build` v4, `fork-proposer` v1)                                                                                                    | done   | PR 1 |
| Agents: `coder.forkDecision` tri-state in `BUILTIN_CONFIG_CONTRIBUTIONS`                                                                                                                                                                              | done   | PR 1 |
| Agents: `implementationChoiceSection` + `SYSTEM_PROMPTS.build` line                                                                                                                                                                                   | done   | PR 1 |
| Orchestration: `ForkDecisionController` + `forkDecision.logic` (gate resolve, propose dispatch, completion interceptor, choose) + `RunDispatcher` wiring + `dispatchEpochFor` + `AgentContextBuilder` fold (+ `followUpCompanion` effective-kind fix) | done   | PR 1 |
| Orchestration: `fork_decision_pending` notification raise + act handler                                                                                                                                                                               | done   | PR 1 |
| Server: routes/contracts (`GET`/`choose`) + `ForkDecisionController` (HTTP) + `ExecutionService` pass-throughs                                                                                                                                        | done   | PR 1 |
| Frontend: `ForkDecisionWindow` (no chat) + store + result-view registration + routing/buttons/chips + risk-policy editor fields + i18n (all locales) + data-testids                                                                                   | done   | PR 1 |
| Conformance: gate-skip / propose→park→choose→coder / single-path auto-advance / unwired pass-through, on all facades                                                                                                                                  | done   | PR 1 |
| Unit tests: `forkDecision.logic`, controller (via conformance against real Postgres), store/window                                                                                                                                                    | done   | PR 1 |
| Persistence: `merge_threshold_presets.fork_decision` column (D1 migration `0049` ⇄ Drizzle) + repo mappers, both facades                                                                                                                              | done   | PR 1 |
| Chat: `pendingForkChat` marker + `stepInstance` re-entry guard + `ForkChatService` (DocInterview model resolution + metering) + chat endpoint + window thread + budget + prompt (`fork-chat` v1)                                                      | todo   | PR 2 |
| Conformance: chat re-entry (fake model) + graceful no-model degradation                                                                                                                                                                               | todo   | PR 2 |
| e2e: park → choose → resume happy path against the fake executor (+ testids)                                                                                                                                                                          | todo   | PR 2 |
| CLAUDE.md flow-notes paragraph (fork-decision park in the run lifecycle)                                                                                                                                                                              | todo   | PR 2 |

## Follow-ups (out of scope)

- Feed the chosen fork to later steps (reviewer/tester) as a synthetic prior-output entry —
  default no; the PR embodies it.
- Kaizen grading of fork-proposal quality (did the human pick the recommended fork? did a
  custom choice reveal a missed fork?).
- Surface the chosen fork + rejected alternatives in the PR description.
- A cheaper default model for the proposer (a workspace model-default entry, not a design
  change).

## Open questions (defaults chosen)

1. **Downstream visibility** — inject the choice into reviewer/tester context? Default: no
   (one-line change if wanted).
2. **Chat usage metering** — mirror whatever spend path `DocInterviewService` /
   `IterativeReviewService` use; confirm at implementation that the scoped-provider
   observability wrapper covers it.
3. **Multiple coder steps in one pipeline** — the active-step resolution mirrors
   `activeFollowUpStep`; each coder step with the option active gets its own phase. Confirm
   during implementation that this matches expectations for the rare multi-coder pipelines.
4. **Multi-repo fan-out UX** — `fork-proposer` carries `fanOutMultiRepo`, so a cross-service
   task can yield a _different_ fork set per repo, but the proposed choose/park/window flow
   presents ONE fork list and records ONE `forkDecision.chosen` on the step. This must be
   resolved before PR 1 rather than deferred. Default (recommended): scope PR 1 to
   **single-repo tasks** — drop `fanOutMultiRepo` from the proposer (surface forks for the
   run's primary repo only, like the single `implementationChoice` the coder context folds
   in) and add per-repo forks as an explicit follow-up, so the MVP's window/state model stays
   a single choice. Alternatively, model `forkDecision` as a per-repo map (forks + chosen keyed
   by `repoId`) with a per-repo section in the window — a larger PR-1 surface.
