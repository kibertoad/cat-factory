# Initiative: pre-dispatch input gate

**Status:** in progress (V1 landed) · **Owner:** core · **Started:** 2026-08-04

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The platform's CHEAPEST refusal used to cost a model call. A task with an empty description
started a run, dispatched the `requirements-review` step, and spent an inline LLM call to be
told that the description is empty. A `bug` task with no reproduction context went further: the
reviewer would ask about it, the run parked, and the human answered questions a form field on
the task already has a slot for.

Two things are wrong with paying for that verdict. It is money spent to learn something a string
comparison knows, and it is a slower answer: the reviewer's questions arrive after a model call
rather than at once. Neither matters much per run, and both matter at the volume a board
generates when a schedule or an initiative is spawning tasks.

End state: a deterministic structural check of a task's OWN authored fields, run before a run's
first agent step is dispatched. Nothing an agent could work with ⇒ the run parks having spent
nothing, and says exactly which fields are missing.

**The gate is not a cheap reviewer.** It never judges quality, scores prose or infers intent:
that judgement is what the reviewer is for, and a cheap imitation of it would park real work. It
answers one question, is there anything here at all, and every blocking finding names an input
a model could not have acted on either.

## Target pattern

1. **The check is PURE and lives in kernel** (`domain/input-gate.ts`): fields in, findings out.
   No I/O, no model, no repository. Its vocabulary (`InputGateIssueCode`, severity, mode,
   status) is in contracts, because the SPA renders each finding and must key its translated
   copy off the same closed set the engine writes.
2. **Each finding carries an INTRINSIC severity** (`INPUT_GATE_SEVERITY`, an exhaustive
   `Record`). `blocking` means the run has nothing to act on; `advisory` means the input is
   weak, which is a reviewer's business.
3. **The workspace mode only ever SOFTENS.** `standard` (default) parks on a blocking finding,
   `advisory` downgrades everything so nothing parks, `off` skips the check. There is
   deliberately no mode that PROMOTES an advisory finding, because the advisory set is advisory
   on the merits rather than by configuration.
4. **The verdict rides the run** (`ExecutionInstance.inputGate`, in the `detail` JSON, so it is
   runtime-symmetric by construction), and is recorded in EVERY disposition including the ones
   where the gate did nothing.
5. **It parks; it never fails.** The remedy is a thing a human can go and fix, so the run waits
   for `recheck` (re-evaluate the task as it now stands) or `proceed` (waive the findings).

## Prioritized checklist

| #   | Slice                                                                                             | Status  | PR  |
| --- | ------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | Kernel check + contracts vocabulary + the six V1 findings                                         | ✅ done |     |
| 2   | `InputGateController`: evaluate at step 0, park, `recheck`/`proceed` resolve, HTTP route          | ✅ done |     |
| 3   | Workspace `inputGateMode` (D1 ⇄ Drizzle column) + settings panel                                  | ✅ done |     |
| 4   | SPA notice (inspector + step detail), park routing, i18n across all locales                       | ✅ done |     |
| 5   | Cross-runtime conformance: park → recheck → release, `off`/`advisory`, the 409                    | ✅ done |     |
| 6   | Public API: the verdict as a parked decision + a `decide`-scope resolve, and admission for it     | ✅ done |     |
| 7   | Tell the AGENTS what was waived (`AgentRunContext`), so an overridden run's prompt states the gap | ⬜ todo |     |
| 8   | Per-task-type findings for deployment-registered types (a `TaskTypeRegistry` hook)                | ✅ done |     |
| 9   | Count the parks (`OperationalMetrics`), so "is this catching more than it was" is answerable      | ⬜ todo |     |
| 10  | E2E: the park, the named finding, and BOTH exits through the real notice (`input-gate.spec.ts`)   | ✅ done |     |

## Conventions & gotchas

- **`not_applicable` is decided by whether the block describes AUTHORED TASK input**, which is
  two separate mechanisms rather than one list of task types (`describesAuthoredTaskInput`).
  A run can be started against a frame, a module, an epic or an INITIATIVE ANCHOR, and such a
  block stands for an entity whose real input lives elsewhere: an initiative's planning pipeline
  runs against its anchor, whose description is a caption while the goal and the committed plan
  are what the run actually reads. Judging the caption parked every initiative run, on a field
  the flow never fills in and no task card exists to fix. The second mechanism is the
  platform-authored TASK TYPE (`recurring`, the schedule's reused block).
  What is deliberately NOT exempt: a task the platform CREATED whose description is still a real
  brief (an initiative-spawned item, a task imported from a tracker ticket). Those are ordinary
  board tasks a human can edit, so they are judged like any other; what they need is an answer
  path without a browser, which is the public decision surface below.
- **The gate is the one park that turns on the shape of the TASK rather than the PIPELINE**, and
  that is why the public API needed more than a resolve route. `parkSurfacesOf` reads the step
  chain, so it cannot see this one: a run whose pipeline parks nowhere at all still stops here.
  A `write`-scope key could therefore start a title-only task and get a run that was parked with
  nothing able to answer it and `stop`/`cancel` as its only exit, which is the exact failure
  `publicApiAdmission` exists to prevent. Both halves landed together and both are required:
  `publicRunParkSurfaces` composes the gate into what admission gates on (its `inputGateBlocks`
  argument is REQUIRED, so a new start surface must answer the question), and
  `POST /api/v1/runs/:runId/decisions/input-gate/resolve` is what makes the surface answerable,
  so the refusal steers at the decision surface instead of describing the park as cancel-only.
  `InputGateController.wouldBlock` is a second evaluation site, which is safe only because the
  check is pure and deterministic: it and the engine's own call agree unless the task changed in
  between, and then the later one should win.
- **A verdict that is recorded is not automatically a verdict worth SHOWING.** `off`,
  `not_applicable` and a clean `passed` are three different facts that all mean "nothing to tell
  a human", while a `passed` verdict carrying advisories has something to say and is not a park.
  `inputGateNoticeFor` is the one rule; keying the SPA off `status` alone left every advisory
  finding recorded, reported over the API and invisible in the product, which is `advisory` MODE
  with nothing to watch.

- **The gate evaluates at `currentStep === 0` ONLY, and at most once per run.** Both halves are
  load-bearing. The settled verdict is what makes it idempotent under a durable replay: a
  re-driven run reads its own record rather than re-judging a block a human has since edited,
  which would park the run they just released. And confining it to the first step keeps its
  promise honest, because past the first dispatch the tokens are already spent, so parking there
  would cost a human interruption and save nothing.
- **`off` and `passed` are different facts and must never render the same.** `off` records NO
  findings, because the check did not run; an empty finding list under `passed` would claim it
  did. The same rule is why an ABSENT `inputGate` means only "not evaluated yet", and why an
  unwired settings seam (or a settings read that THROWS) records `off` rather than defaulting to
  the standard mode, an unreadable policy is not a mandate to park somebody's run.
- **The park rides `step.approval`, so every surface offering a generic approval must exclude
  it.** Approving it generically would mark the run's first working step DONE and advance past
  the work the run exists to do, the fork-decision trap, one step earlier. It is refused
  server-side in `assertNotIterativeGate` (checked off the INSTANCE, since the gate parks
  whatever step 0 happens to be and leaves nothing kind-specific on the step), and the SPA routes
  it through `dedicatedParkView`, which REQUIRES the run (optional was how two call sites
  silently stopped passing it, and a missing run reads as "the generic rail applies").
  The refusal is its own conflict reason, `input_gate_parked`, and NOT the `input_gate_not_parked`
  the resolve route raises: those are opposite facts, and copy that fits "already answered" tells
  somebody looking at a live park that there is nothing to answer.
- **`recheck` RE-EVALUATES rather than trusting the caller.** A still-blocked recheck is an
  ordinary 200 with refreshed findings, not an error: nothing went wrong, the task is just not
  fixed yet. The decision id is deliberately UNCHANGED across a failed recheck, because the
  durable driver is still parked on it and a fresh id would strand it.
- **`proceed` records `overridden`, never `passed`, and KEEPS the findings.** What was waived is
  part of the run's record; collapsing it into `passed` would erase the one fact a later reader
  needs to explain the output.
- **Adding a finding is three edits and the typecheck names two of them**: the code in
  contracts' `INPUT_GATE_ISSUE_CODES`, its severity in kernel's `INPUT_GATE_SEVERITY` (an
  exhaustive `Record`, so the build fails until it is classified), and its copy in the SPA's
  `ISSUE_KEYS` (also exhaustive) plus every locale. RETIRING one is the case to be careful with:
  the codes are PERSISTED on run rows, so a withdrawn code must stay renderable, that is what
  the `inputGate.issue.unknown` fallback is for, and why the SPA looks its copy up through `te`
  rather than assuming the key exists.
- **Blocking findings are held to a high bar on purpose.** `description_thin` and
  `success_criteria_missing` are advisory precisely because a one-line task can be a real task
  and a spike can be exploratory. When in doubt, advisory: a false advisory costs a line of text,
  a false park costs somebody's afternoon.
- **A CUSTOM task type's findings come from the declaration it ALREADY made**, not a second one.
  A registered type's create-form field descriptors carry `required`; the gate reads those,
  through the same `unfilledRequiredDescriptorFields` rule the create form's own validator uses,
  so a deployment cannot have a field enforced at one door and ignored at the other. Three things
  follow and all three are load-bearing. The gate takes the SAME two stand-downs the create door
  takes (a type this process does not register declares nothing; a type with a `formPanel` has a
  bespoke section owning the whole bag, so its descriptors are not what was collected), because
  the doors agreeing is the entire argument for reusing the declaration. `showWhen` is honoured,
  so a field the form would have hidden is never required: parking on an input with nowhere to
  go and fill it in is the exact false park this gate must not produce. And the findings are ONE
  PER FIELD, unlike the description checks which collapse to a single reading: three unanswered
  fields are three things to go and do, and a human told "a required field is missing" would fix
  one and be parked again.
- **What the gate adds over the create door is WHEN it asks.** The create check fires once,
  against the declaration as it stood that day, on the paths that reach `addTask`. The gate fires
  at every run, against the declaration as it stands now, so a requirement a deployment adds in
  a later release reaches the tasks that predate it, and a task created on a node that did not
  register the type is still judged where it runs (normal in a two-process deployment). That is
  the case the conformance assertion drives, because it is the one no create-time check can cover.
- **A deployment gets ONE code, not one per type.** `required_field_missing` covers every
  registered type's every field; WHICH field rides on the finding's `field` (`key` for a machine,
  deployment-supplied `label` for a human). The codes are a closed, PERSISTED vocabulary, so an
  org registering twenty operations must add nothing to it, and the SPA's exhaustive `ISSUE_KEYS`
  Record stays a fixed size. Severity is `blocking` because the deployment said the field was
  required, which is the only authority available: this file classifies the built-ins by its own
  judgement about what a model can work around, and a custom type's pipeline is one it has never
  seen. A deployment wanting the softer reading marks the field optional and lets its reviewer ask.
- **A BLOCKING finding owes an answer path, not just an override.** `required_field_missing` was
  the first finding naming an input that could not be supplied after creation: `taskTypeFields` was
  write-once, so `recheck` re-read the same unanswered bag forever and waiving the gate was the
  only exit, while every surface told the reader to go and fill the field in. The fix is the
  `customTaskTypeFields` patch field on `updateBlockSchema`, validated through the create door's own
  `validatedFields`, plus the `task-type-fields` inspector panel rendering the same
  `DescriptorFields` against the same declaration. Two rules fall out of it. The patch is
  deliberately narrower than the whole `taskTypeFields`, because the BUILT-IN per-type fields are
  resolved at creation with side effects the patch path does not repeat (a `review` task's PR
  reference is verified against the provider and folded into the description); the custom bag has no
  such resolution, which is what makes it the half that can be patched. And the panel is
  basic-tier, ungated: unparking a run is the everyday delivery loop, and hiding the control behind
  advanced mode would rebuild the dead end it exists to remove. The conformance suite drives both
  exits, `proceed` and the answer-then-`recheck` release, because a gate whose only exit is "ignore
  me" is a gate that cannot be satisfied.
  `review_target_missing` still has the original gap (a `review` task's PR reference is not
  patchable), which is now the only blocking finding whose remedy the product does not offer.
- **The reproduction-cue scan is deliberately GENEROUS** (a `stepsToReproduce` field, any of a
  list of cue words, or a list of two or more items). Missing a cue parks a task whose author did
  the work, which is worse than letting a thin bug report reach a reviewer that can ask about it
  properly.
