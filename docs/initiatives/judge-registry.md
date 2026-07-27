# Initiative: Judge registry (the verdict-gate family, promoted)

Tracker for **judges** — the fourth step-taxonomy bucket. A judge is a step whose LLM
produces a **structured verdict against a rubric**, which the engine compares to a
**per-task threshold** and then disposes: advance, park for a human, bounce the preceding
step with feedback, or fail the run.

## Goal & rationale

Three engine paths already share exactly that shape:

| path                   | assessment                                 | threshold                      | disposition             |
| ---------------------- | ------------------------------------------ | ------------------------------ | ----------------------- |
| requirements auto-pass | reviewer findings + severities             | `maxRequirementConcernAllowed` | advance / park          |
| `merger`               | `MergeAssessment` (complexity/risk/impact) | the merge preset ceilings      | merge / park for review |
| `on-call`              | `OnCallAssessment` (culprit confidence)    | the gate's own handling        | notify / enrich         |

`CLAUDE.md` names this "a latent 'verdict gate' family, not promoted to an abstraction until
a second externally-authored member needs it". **That member has arrived.** Deployments want
to insert their own rubric-based evaluator over a run's output — scope adherence, house
engineering standards, doc completeness — that can block or bounce the run. Today they can
only approximate it by bending a `StepCompletionResolver` (which returns a `StepResolution`,
so it cannot park or loop the run) or by forking the engine.

End state: **adding a judge is a new registry entry, not a copy of the machinery** — the same
promise `registerGate` makes for polling gates. One generic driver (`evaluateJudge`) owns the
state machine, threshold comparison, park/bounce/fail disposition, persistence and emission;
a registration supplies only its differentiators.

## The target pattern

`GateRegistry` / `registerBuiltinGates` is the model, deliberately and literally:

- an **app-owned** `JudgeRegistry` instance in kernel (`defaultJudgeRegistry()` — empty),
  threaded through `CoreDependencies` beside `gateRegistry` / `stepResolverRegistry`;
- a registration is a **factory** (`JudgeFactory`) the engine invokes once at registry-build
  time with a minimal `JudgeContext`, so its closures reach the engine seams;
- **one** generic driver in the engine (`JudgeStepController.evaluate`), the analogue of
  `evaluateGate`;
- live state on **`step.judge`** (`JudgeStepState`, the `GateStepState` / `forkDecision`
  precedent) — no side table, so runtime symmetry is by construction;
- **pass-through** when the assessor is unwired, so pipelines, conformance and e2e run
  unchanged.

Reference implementation once it lands: the `scope-adherence` judge in
`@cat-factory/example-custom-agent` (registered **by reference** on the injected registry —
no module-global side effect).

## Decisions

### D1 — A new taxonomy bucket, NOT a gate and NOT a resolver

**Decision: judges are a fourth bucket in the step taxonomy (agents / polling gates /
one-shot engine steps / judges).**

- Not a **gate**: a gate's `probe()` is a _programmatic precheck against a provider_ whose
  entire point is to spin nothing up when it passes. A judge's assessment IS an LLM call —
  it always costs a model call, has no "pending" state to poll, and its verdict is a score,
  not a tri-state. Forcing it into `GateProbe` would mean a `probe()` that lies about being
  cheap and a `helperKind` that has nothing to escalate to.
- Not a **step-completion resolver**: a resolver returns `StepResolution` (reshape output /
  own terminal status). It cannot park the run, cannot bounce it, and cannot yield an
  `AdvanceResult`. That is precisely the ceiling deployments hit today.

### D2 — The verdict schema is supplied by the registration, defaulted in contracts

**Decision: `judgeVerdictSchema` (score 0..1 + summary + findings) ships in
`@cat-factory/contracts` as the default; a registration MAY supply its own valibot schema,
which the driver parses against.**

A generic score+findings shape covers the rubric use cases we have, and having a canonical
one means the SPA gets a real result window (`judge`) for free rather than falling back to
`generic-structured`. A registration that needs more supplies its own schema; the driver only
requires that the parsed value expose `score` (the number the threshold compares) —
enforced by typing the registration's schema as producing a `JudgeVerdict`-assignable value.

### D3 — Threshold: a knob on the merge preset, the `maxRequirementConcernAllowed` shape

**Decision: two new merge-preset knobs — `judgeMinScore` (default 0.7) and `judgeMaxBounces`
(default 1) — with `JudgeDefinition.threshold(preset)` / `attemptBudget(preset)` free to
read whichever knob they want.**

Same reasoning as `maxRequirementConcernAllowed` and `ciMaxAttempts`: the tolerance for a
verdict is a **per-task risk decision**, and the merge preset is already the per-task risk
policy a workspace authors and a task selects. Putting it on the registration instead would
make it a deployment-global constant that no task could relax.

### D4 — Rubric source: the registration default, overridden through the FRAGMENT library

**Decision: a registration carries a default `rubric` body plus an optional
`rubricFragmentId`. When a fragment with that id resolves for the workspace (through the
existing `fragmentResolver` — the merged tenant catalog of managed + document-backed
fragments), its body IS the rubric; otherwise the registration's default is used.**

This is the "resolved like prompt fragments" requirement taken literally, and it is the
reason no new table exists in this initiative. A workspace overrides a rubric by authoring a
fragment — the surface it already uses to author prompt standards — so the override inherits
that library's CRUD, versioning, tenancy and runtime symmetry for free. A dedicated
`judge_rubrics` table was rejected: it would duplicate the fragment library's entire
lifecycle (D1 ⇄ Drizzle, repo, service, controller, panel, i18n) to store the same thing.

### D5 — `onFail` dispositions: `park` | `bounce` | `fail`

**Decision: three, and only three.**

- `park` — `parkStepOnDecision` + a `judge_review` notification. Answerable from the SPA's
  judge window AND from the public API's decisions surface (see D6).
- `bounce` — `stepGraph.rerunProducerThrough(...)`: re-arm the nearest preceding producing
  step with the verdict's findings as `rework` feedback and re-run through the judge, under
  `judgeMaxBounces`. This is the `ci` gate's "return to `checking`" shape, expressed through
  the machinery the companion loop already uses. Budget spent ⇒ fall through to `park`
  (never a silent advance — a judge that gave up must say so to a human).
- `fail` — fail the run with the verdict summary.

A `bounce` needs a producing step to bounce TO. A registration names the producer kinds it
grades (`bounceTargets`); when none precedes the judge, the disposition degrades to `park`
and the state records why. Silently advancing would be the one outcome a rubric gate must
never produce.

### D6 — Park answers on BOTH surfaces, through one service method

**Decision: `ExecutionService.resolveJudgeDecision(workspaceId, blockId, choice, feedback)`
is the single entry point; the SPA controller and the public `/api/v1/runs/:runId/decisions`
route both call it.**

The headless-clarification-loop rule: a park that only the SPA can answer is a park a
headless caller waits on forever. Choices are `proceed` (advance despite the verdict),
`bounce` (spend a round even if the budget said stop) and `stop` (fail the run).

### D7 — Scope discipline: the merger is NOT rewritten onto this

**Decision: `merger` stays the privileged built-in.** It owns terminal block status and
executes a real, policy-gated merge with backend credentials — it is the dual of a gate, not
an instance of a judge. Rewriting it would hand the public seam `ownsTerminalStatus` and the
real merge, which `CLAUDE.md` explicitly reserves.

**Requirements auto-pass MAY be re-expressed on this machine later** (its
`disposeReview` → threshold → park/advance is a genuine judge). That is deliberate strangler
work for a follow-up slice, tracked below as `todo` and explicitly NOT done here — the
requirements loop also owns an incorporation cycle and an iteration cap that the judge
machine has no concept of yet.

### D8 — The verdict is a first-class PR-verification-report section

**Decision: a `judges` array section on the report** (rubric name, score, threshold,
disposition, model, findings), rendered through the `hostMarkdown` `cell`/`inline`/`prose`
helpers.

Non-negotiable: the rubric body and every finding are **model-authored text on a
host-parsed, often public surface**. Every hole goes through `hostMarkdown` + `redactSecrets`
exactly like the rest of the report. A judge step that did not run records
`status: 'absent'` with a note — a silently missing section reads like a clean one.

### D9 — A judge is a first-class registration for BOOT VALIDATION, not just at run time

**Decision: `validateRegistrations` takes the `judgeRegistry` and checks it like the gates.**
Three checks, each closing a way a judge could be silently wrong:

- **A judge kind counts as a legal pipeline step.** Without it `checkPipelineKinds` reports a
  pipeline placing a registered judge as `pipeline_unknown_kind` — the worked example's own
  `pl_org_scope` would fail its own boot gate the moment a facade supplies `knownAgentKinds`.
- **A judge's `presentation.resultView` gets the SAME check an agent kind's does.** A typo
  otherwise degrades the window to the generic prose panel with no signal at all.
- **A judge kind that collides with a gate kind is an ERROR.** The two registries are meant to
  be disjoint, but the dispatcher's polling-gate handler has the lower `order`, so a collision
  makes the judge silently dead code. "Disjoint by construction" is only true once something
  checks it.

A throwing factory is reported here too, rather than surfacing on the first run that happens to
reach a judge step (the engine builds the same map lazily).

### D10 — The park's card is CLEARED by the engine, on every resolution path

**Decision: `judge_review` is in the shared `GATE_CLEARED_NOTIFICATION_TYPES` contract**, which
`NotificationService.clearWaitingDecision` iterates.

This shipped broken in the first cut and is worth recording as the shape of the trap: the type
was added to the notification union AND to `REVIEW_WAIT_NOTIFICATION_TYPES` (the review-debt
metric), but the DISMISSAL list was a third, hard-coded literal inside the service. The card was
therefore never auto-cleared on any path — and an open parking card is exactly what the
escalation sweep later flips red as "Overdue" for a decision a human already made. The list is
now a named contract beside its sibling so a new parking surface is added in one place. Note
`proceed` also needs an explicit `clearWaitingNotification`: it settles through the shared
`settleAdvancedGate`, which deliberately does not clear (it is the generic gate-advance settle).

### D11 — The assessment prompt is budgeted in TOTAL, and says what it dropped

**Decision: a 24k-char total cap across prior outputs on top of the 6k per-entry cap**, spent
newest-first, with an explicit "N earlier step output(s) omitted" line in the prompt.

The per-entry cap is not a bound: a fifteen-step pipeline multiplies it into ~90 KB of prompt on
every judge round, and a bounce pays it again. Newest-first because the work under review is
what the last steps produced. The omission is STATED rather than silent for the same reason the
report logs its truncations — a judge that scored a subset while its summary reads as if it saw
everything produces a verdict a human cannot calibrate.

### D12 — A judge's model is its own dependency, defaulted to the reviewers'

**Decision: `judgeModel` / `judgeResolveModel` on `CoreDependencies`, falling back to
`requirementReviewModel ?? documentPlannerModel`.** The fallback is what makes "no facade wiring"
true; the named deps are so that "what model does a judge use?" is answerable from the dependency
contract rather than from a silent reuse buried in `createCore`.

## Conventions & gotchas carried between iterations

- **The assessment rides an injectable `JudgeAssessor` seam, not a direct `generateText`.**
  `JudgeService` (orchestration) is the inline-LLM implementation, built in `createCore` from
  the model-provider deps the facades already wire — so **no facade needs new wiring** and the
  runtimes cannot drift. Conformance injects a deterministic fake through the same seam (the
  `testerQualityReviewer` precedent), which is what makes evaluate/park/bounce assertable on
  both runtimes with no model.
- **Unwired ⇒ byte-for-byte the old behaviour.** No assessor ⇒ `status: 'skipped'`, the step
  records a pass-through output and advances. Assert this explicitly in conformance; it is
  what keeps every existing pipeline and the e2e suite green.
- **`step.judge` must survive `resetStepForRerun`** (like `forkDecision` / `followUps`), or a
  bounce would erase the very verdict it is looping on.
- **A bounce re-runs the producer AND the judge.** Use `rerunProducerThrough`, never a
  hand-rolled cursor rewind — it is what clears stale container `jobId`s on the intermediate
  steps.
- **Keep the runtimes symmetric.** Everything here is either kernel/contracts (shared) or
  step state (shared row), so the only per-facade surface is the registry injection point.
  Add both facades' wiring in the same commit as the registry.
- **Palette + result view.** A judge kind reaches the SPA through the snapshot's
  `customAgentKinds` projection (extended to read the judge registry) and the new built-in
  `judge` result view. A registration with no `presentation` is simply not a palette block.
- **A facade that threads a `judgeRegistry` must also pass it to `validateRegistrations`** (D9),
  or its judges are unvalidated and its judge-placing pipelines false-positive.
- **"Which step is the active judge?" has ONE definition** — `activeJudgeStepIndex` in contracts.
  The engine, the public-API projection, the inbox reveal and the SPA's optimistic echo each
  grew their own scan with a different precedence, which in a multi-judge pipeline let the API
  answer about one rubric while the SPA echoed the result onto another. Add a caller to the
  shared helper; do not re-derive it.
- **An out-of-range score is explained, not rescued.** The 0..1 clamp turns a `85` reply into
  `0.00` beside a sensible summary. Keep the cautious zero (a judge blocks work, so "I could not
  tell" belongs on the cautious side) but attach `annotateOutOfRangeScore`'s finding, or a
  reviewer reads the model's scale error as a damning verdict.
- **Persist BEFORE the assessment, not just emit.** The durable driver replays steps; without a
  committed `evaluating` marker a replay re-runs the model call and can broadcast a second,
  different verdict. Same rule the gate machine follows before dispatching a helper.

## Per-item status

| #   | Slice                                                                                                                                                  | Status | PR      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------- |
| 1   | Tracker (this document)                                                                                                                                | done   | this PR |
| 2   | Contracts: `judge.ts` (verdict / step state / resolve request), `step.judge`, preset knobs, `judge` result-view id, `judge_review` notification        | done   | this PR |
| 3   | Kernel: `JudgeRegistry` / `JudgeDefinition` / `JudgeContext` / `defaultJudgeRegistry` / `stubJudgeContext` + the pure `judge-logic.ts` disposition     | done   | this PR |
| 4   | Engine: `JudgeService` (inline assessor) + `JudgeStepController` (`evaluate` / `resolveDecision`) + step-handler registration + `resolveJudgeDecision` | done   | this PR |
| 5   | DI: `judgeRegistry` + `judgeAssessor` through `CoreDependencies`, both facades, `Core` spine re-export                                                 | done   | this PR |
| 6   | PR verification report: the `judges` section (compose + render + JSON)                                                                                 | done   | this PR |
| 7   | Public API: judges on `/api/v1/runs/:runId/decisions` (+ the resolve route)                                                                            | done   | this PR |
| 8   | Frontend: `JudgeResultView.vue` in the `resultViews` slot + i18n (all locales)                                                                         | done   | this PR |
| 9   | Conformance: evaluate / park / bounce / fail / human proceed-bounce-stop / unwired pass-through on both runtimes                                       | done   | this PR |
| 10  | Worked example: `scope-adherence` judge in `@cat-factory/example-custom-agent`                                                                         | done   | this PR |
| 11  | Docs sweep: `CLAUDE.md` taxonomy (fourth bucket), `backend/docs/custom-agents.md`, package READMEs/AGENTS.md, root README                              | done   | this PR |
| 11b | Boot validation (D9), card clearing (D10), prompt budget (D11), judge model deps (D12), one `activeJudgeStepIndex`                                     | done   | this PR |
| 12  | Strangler: re-express requirements auto-pass on the judge machine                                                                                      | todo   | —       |
| 13  | Convert this tracker to an ADR once slice 12 lands (or is formally dropped)                                                                            | todo   | —       |

## Deliberately NOT pursued

- **Rewriting `merger` or `on-call`** onto the judge machine (D7).
- **A multi-judge panel / consensus over several rubrics** — `@cat-factory/consensus` already
  owns fan-out-and-reconcile; a judge is one assessment.
- **A dedicated rubric table + editor UI** (D4) — the fragment library is the authoring
  surface.
- **A hard timeout on a parked judge.** A parked run waits for a human indefinitely by design
  (`CLAUDE.md`); the backstops are the workspace in-flight cap and job cancellation.
