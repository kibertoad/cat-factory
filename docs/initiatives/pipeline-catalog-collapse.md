# Pipeline catalog collapse

**Goal.** Cut the built-in pipeline catalog down by replacing the seven near-identical build presets
with a deliberate **three-rung ladder** varying the one axis anyone actually chose on (how much
design a task gets), making the axes they were really toggling (reviewer, human PR review,
architect) into **estimate-gated steps**, and scoping every picker to the task type's real
use-case. 27 presets → 21 live, 6 tombstoned, with the build family down from 13 to 5.

**Why now.** Two independent problems compound:

1. **Seven build presets are the same spine with at most two toggles.** `coder → [reviewer] →
[blueprints] → [mocker] → deployer → tester-* → conflicts → ci → [human gate] → merger`
   describes `pl_quick`, `pl_simple`, `pl_dep_update`, `pl_pr_review`, `pl_human_review`,
   `pl_frontend` and `pl_visual`. `pl_quick` and `pl_simple` differ by **reviewer-vs-blueprints**:
   nobody picks a pipeline on that axis. `pl_fullstack` is the same spine with every optional step
   on, which is a saved preset, not a built-in.
2. **The estimate-gating machinery was built and never used.** `StepGating`,
   `shouldRunGatedStep`, the runtime skip seam (`ExecutionService` → `RunDispatcher.skipGatedStep`),
   the builder UI and the admission validation all exist. `grep gating seed.ts` returns only prose.
   It could not be used for this, because `assertValidGating` restricted gating to **companion
   kinds**.

Result: a `feature` task's picker offers ~24 presets, three of which (`pl_initiative*`)
`assertInitiativeShapeAllowed` then **refuses at start**; offered-then-rejected.

## Target pattern

### The build ladder

Three rungs, varying how much design a task gets, plus one adaptive preset that makes that choice per
task instead of per service. **Order in `buildDeliveryPipelines` is load-bearing**: `seedPipelines()[0]`
is the positional default every `Start` button resolves (`TaskCard.vue` → `pipelines.pipelines[0]`), so
the default rung must stay first.

| rung        | id          | shape                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------ |
| **default** | `pl_build`  | design → challenge design → implement → review → verify → guards → merge |
| trivial     | `pl_simple` | implement → review → verify → guards → merge                             |
| adaptive    | `pl_full`   | sizes the task up, then switches its own optional steps on               |

`pl_build` and `pl_simple` are **entirely unconditional**, no estimator, no gating, no human pause,
so a run's shape is known before it starts. That predictability is the point: an adaptive pipeline
cannot make that promise, which is why the fixed rungs survive rather than collapsing into `pl_full`.

`pl_full` is the adaptive rung:

```
task-estimator                                  always   (inline, one cheap call)
architect             gatable  ≥ complexity .4
  ↳ architect-companion        cascades          (skipped because its producer was)
coder                                            always
  ↳ reviewer                                     always
deployer                                         always   (no-op unless the service declares infra)
tester-api            gatable  ≥ complexity .3 | risk .3
conflicts                                        always
ci                                               always
human-review          gatable  ≥ risk .8         (replaces pl_pr_review)
merger                                           always   (auto or manual per merge preset)
```

`architect-companion` deliberately carries **no gate of its own**: it cascades off the architect, so a
threshold there would be a second copy to keep in sync, and the two could only ever disagree by
leaving a design unreviewed. That makes the cascade load-bearing in shipped config rather than
belt-and-braces.

`human-review` is the one gate whose `onMissingEstimate` is **`skip`** rather than the
thoroughness-first `run`: an unestimated task must not silently wait for a human forever.

`requirements-review`, `spec-writer`, `researcher`, `blueprints`, `mocker`, `code-commenter`,
`documenter`, `playwright` and `business-documenter` remain available in the builder as opt-in steps.
They are deliberately in **no** rung: omitted rather than shipped disabled, so each preset's step list
reads as exactly what it does.

### `gatable`, declared per kind

`assertValidGating`'s companion-only restriction rested on "skipping a producer would starve its
downstream steps". That is **too strong, and provably so**: `pl_simple` had no architect and no
spec-writer, `pl_quick` had no reviewer. Those presets worked, because a producer's output reaches
later steps as _prompt context_, not as a precondition.

The genuine hard dependencies are four, and each already has its own guard:

| dependency                         | guard                                                       | consequence for gating    |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------- |
| companion → its immediate producer | `assertValidCompanionPlacement`                             | must **cascade-skip**     |
| `deployer` → env consumer          | `assertDeployerBeforeConsumer`                              | not independently gatable |
| `merger`                           | `runOpensPr` reads `instance.steps`, not the un-skipped set | **never** gatable         |
| `bug-intake` → schedule            | `assertPipelineLaunchable`                                  | never gatable             |

So gatability is a **per-kind capability**, not a category test. Built-in kinds are not
`AgentKindDefinition` entries (CLAUDE.md: "the built-in agents aren't migrated to this model"), so it
follows the established per-concern idiom; a `BUILTIN_*` table beside a registry accessor, exactly
like `read-only.ts` and `tuning.ts`. The one departure from that idiom is WHERE the table lives: in
`@cat-factory/contracts`, because the SPA needs the same answer and cannot see `@cat-factory/agents`
(see the advisory gotcha below).

```ts
// contracts/agent-gating.ts - shared, so the engine and the SPA cannot disagree
export const BUILTIN_GATABLE_KINDS: ReadonlySet<string> = new Set<string>([...])
export function isBuiltinGatableKind(kind: AgentKind | string): boolean { ... }

// agents/kinds/gatable.ts - the registry-aware form, backend only
export function isGatableKind(kind: AgentKind, registry?: AgentKindRegistry): boolean {
  return registry?.gatable(kind) ?? BUILTIN_GATABLE_KINDS.has(kind)
}
```

`registry.get(kind)?.gatable` alone would return `undefined` for every built-in: the trap to avoid
when extending this.

### The cascade is a LOCAL rule, not lookahead

When a gated producer is skipped, its companion must be skipped too, or the companion grades whatever
happens to precede it. Implemented as a rule evaluated at the **companion's own turn**: if the
immediately preceding step has `skipped === true`, skip this one. No lookahead, no multi-step advance,
and replay-safe because it reads persisted step state (`step.skipped`) rather than in-memory
intent, which matters, since the durable drivers replay.

### A human gate is never estimate-conditional

The estimate may **add** a human checkpoint, never remove one. Enforced structurally: a step may not
carry both `gates[i] === true` and `gating.enabled === true`.

This is not the same as forbidding conditional human involvement. `human-review` / `human-test` /
`visual-confirmation` are gate **kinds** whose whole purpose is the human: gating their _presence_
on risk is escalation, and none of them uses the `gates[i]` approval flag. What the rule forbids is
letting a model's own estimate cancel an approval pause a pipeline author explicitly asked for.

`requirements-review` is the one gatable kind the structural rule cannot police, and it is listed
alongside those three rather than with the design producers for that reason: its park is **intrinsic**
to the kind (the iterative answer/dismiss/re-review conversation) rather than expressed as `gates[i]`,
so `assertValidGating` cannot see it. The escalation argument has to stand on its own there: it does,
because gating the step is the author choosing to have the conversation conditionally, and an author
who wants it unconditionally simply leaves it ungated. Worth knowing that the guard is not what makes
that case safe, since a future kind with an intrinsic pause would need the same judgement applied by
hand.

Per-change-class floors ride the merge preset's existing `classRules`, keyed on the **computed**
change class (`change-class.ts`, derived from the diff) rather than the model's opinion, so "a
schema-class change always gets a human review" is policy the estimate cannot override. (WS4.)

### Pickers scope to the use-case

`pipelineAllowedForTaskType` only narrowed `document` and `review`; every other type fell through to
unrestricted. It now also narrows `feature`/`bug`, and a new **block-level** predicate
(`pipelineAllowedForBlockLevel`) mirrors `assertInitiativeShapeAllowed` so planning pipelines stop
being offered on task blocks.

The two narrowings run in **opposite directions**, which was a correction made during review rather
than the first cut. `document` / `review` demand the EXPLICIT classifier, because a build pipeline on
a document task is actively wrong. `feature`/`bug` only EXCLUDE `document` / `review` / `planning`,
because a pipeline could reach the picker unclassified: the builder's dropdown started unset
(`draftPurpose = null`), the create request omitted it, and a `PipelineRegistry` entry need not
declare one. Requiring the classifier there would have hidden every workspace's own hand-built
pipelines from the picker they were built for, silently, with nothing on screen to explain it. The
kernel guard that every BUILT-IN declares a purpose is what the document/review half leaned on; it
never covered the pipelines actually at risk.

**`Pipeline.purpose` is mandatory as of the library-narrowing change**, so that write-boundary hole
is closed at each of the three producers rather than absorbed by the readers: the entity and the
create request require it, `definePipeline` and therefore every `PipelineRegistry` entry require it
at compile time, and the shared `rowToPipeline` resolves a pre-mandatory NULL column to `build` (the
classifier such a row already behaved as). The asymmetry above SURVIVES, drawn now on the one thing
still open: a stored classifier this build cannot NAME, which the persisted closed vocabulary makes
reachable in both directions. `document` / `review` hide it; `feature`/`bug` keep it, for exactly
the reason they kept an unclassified pipeline.

Both predicates are composed at every manual-start picker: the add-task modal, the focus view's Run
menu, the inspector's Run menu and the task's default-pipeline setting. All four, not the two the
first cut touched: the inspector menu is reachable for frames and modules as well as tasks, and a
planning preset settable as a task's DEFAULT pipeline is a 409 on every later Start.

The block-level gate also applies to the RECURRING-schedule picker, keyed to `'task'` because a
schedule seeds a `level: 'task'` block on every fire. The planning presets declare no `availability`,
so the one-off filter never excluded them there, and a schedule the engine refuses is worse than a
manual start it refuses, since it fires unattended: nobody sees the error and the work simply never
happens, which is the same reasoning behind refusing to delete a pipeline a schedule points at.

The block-level predicate is keyed on `purpose: 'planning'` rather than the initiative AGENT KINDS the
engine tests, because the SPA depends on `@cat-factory/contracts` only and cannot see the kernel's kind
vocabulary. Two classifiers deciding one question drift, so a kernel drift guard pins that they keep
coinciding across the built-in catalog, and it earned its keep immediately, catching that
`pl_initiative_breakdown` is `purpose: 'planning'` while carrying **no** initiative kinds (it is the
inline, headless, public-API preset, so it binds to no block level at all). That one is exempted
explicitly rather than papered over.

## Slices

- [x] **WS1: the `gatable` capability.** `agents/kinds/gatable.ts` + `AgentKindDefinition.gatable` +
      `AgentKindRegistry.gatable()`; `assertValidGating` swaps `isCompanionKind` for `isGatableKind`
      and gains the human-gate exclusivity rule; `producerWasSkipped` cascade in the runtime skip
      path. Unit tests + three conformance assertions (producer skip + cascade, a refused
      non-gatable kind, a refused human-gated + estimate-gated step).
- [x] **WS2: the build ladder; retire the duplicates.** `pl_build` (new, default), `pl_simple`
      (redefined, `mocker` dropped), `pl_full` (adaptive, version 6). Tombstoned `pl_quick`,
      `pl_dep_update`, `pl_pr_review`, `pl_human_review`, `pl_fullstack`, `pl_integrate`. Repointed
      ~30 fixture references, the two initiative presets, and the planner prompt's pipeline menu.
- [x] **WS3a: picker scoping.** `pipelineAllowedForTaskType` narrows feature/bug to build +
      research; `pipelineAllowedForBlockLevel` added and wired into both manual-start call sites.
- [ ] **WS3b: `availability: 'system'`.** A third availability member for the presets only the
      platform invokes (`pl_blueprint` after a bootstrap, `pl_environment_analysis` from the setup
      wizard, `pl_initiative_breakdown` from the public API), so they leave every picker. Needs the
      schema member, the `assertPipelineLaunchable` arm, and care that the programmatic start paths
      pass no user `origin`. Until it lands, those three are still offered on a task (and
      `pl_initiative_breakdown` on an initiative block, where the engine would refuse it).
- [x] **WS3c: make the omitted steps actually addable.** The `remain available in the builder`
      promise above was never true for `spec-writer`, `blueprints` or `deployer`: the first two are
      registered kinds that declared no `presentation`, and the SPA's `SYSTEM_AGENT_META` shadowed
      all three out of the palette. Both halves fixed, plus the admission message that told a user
      to reseed because adding a Deployer was impossible.
- [ ] **WS4: the merge-preset human-gate floor.** Per-change-class required-human-review rules on
      the merge preset, so the estimate can escalate but never fall below policy.
- [ ] **WS5: second retirement wave.** `pl_visual` + `pl_frontend` (both `experimental`, both
      blocked on unwired `ui`-image routing), `pl_spike_direct`, `pl_initiative_docs`; reclassify
      `pl_spec` / `pl_code_comments` / `pl_business_docs` off the `build` purpose.

## Gotchas the first slice surfaced

- **"Remains available in the builder" is a claim about TWO catalogs, and neither was checked.** A
  step is offered only when the kind declares `presentation` (which is what carries a registered
  kind into `customAgentKinds`) AND the SPA does not list it in `SYSTEM_AGENT_META`, whose entries
  DROP the registry's copy. Dropping a step from a preset on the strength of that promise therefore
  removed the capability outright for `spec-writer` and `blueprints`, and took `spec-companion` with
  the spec-writer, since a companion is rendered as a toggle on a producer that must be placeable.
  `deployer` was the sharpest case: `assertDeployerBeforeConsumer` REFUSES a run whose chain reaches
  a tester with no Deployer, on a pipeline the builder could not add one to. **A future preset that
  sheds a step owes a check that the step is placeable**, not just that the kind still exists.
- **`merger` must never be gatable.** `runOpensPr` (`RunRepoOpsController.ts:44`) tests
  `instance.steps.some(s => s.agentKind === 'merger')`: the authored steps, not the un-skipped
  ones. A skipped merger would leave delivering kinds (`spike`, `spec-writer`) opening a PR that
  nothing merges. Same reasoning applies to any future step whose presence is read off
  `instance.steps` rather than its outcome.
- **The SPA re-derives the shape rules, and a stale copy is a BROKEN BOARD, not a stale warning.**
  `usePipelineHealth.ts` mirrors `validatePipelineShape` client-side to tell a workspace which stored
  pipelines would fail, and `pages/index.vue` AUTO-OPENS that advisory as a modal over the board.
  Generalising gating past companions while leaving the SPA's own companion-only check in place made
  the advisory declare `pl_simple` (a pipeline the product itself ships) invalid in every seeded
  workspace, and the modal then swallowed every click on the canvas. Nothing in the backend suites
  can catch this (they were all green); it surfaced as the whole Playwright suite timing out, because
  attribute-only assertions still passed while every click-driven one hung. Hence
  `BUILTIN_GATABLE_KINDS` living in `contracts` and read by both sides. **A future shape rule owes
  the same treatment**: add it to `assertValidGating` AND `shapeProblem`, keyed off shared vocabulary.
  Note the two are not perfectly symmetric and cannot be: the SPA has no `AgentKindRegistry`, so a
  deployment-registered gatable kind is flagged by the advisory and accepted by the engine. That
  direction is the safe one (a dismissible advisory, never a refused save).
- **`pl_integrate` and `pl_spec` have no merge tail at all**, so `runOpensPr` is false and their
  committing agents write **straight to the base branch with no conflicts check and no CI**. For a
  spec increment that is arguably intended; for `pl_integrate`, whose `integrator` is a
  coder-class agent, it is not, which is why it is retired rather than gated.
- **`pl_quick` was the repo's default short-pipeline test fixture** (~30 files). Retiring it was
  mechanical but wide; the repoint target is `pl_simple`. One exception mattered:
  `blueprint.spec.ts` depended on `pl_quick` actually containing a `blueprints` step, so it now
  names the blueprints-only `pl_blueprint`; the focused fixture it always wanted.
- **Estimate gating costs one always-on inline call.** `task-estimator` has to run for any gate to
  have an estimate to read (`assertValidGating` rule 4), which is precisely why the two fixed rungs
  carry no estimator: a pipeline that cannot escalate has nothing to consult an estimate for, so
  paying for one would be pure overhead. `onMissingEstimate` defaults to `run`, failing safe toward
  thoroughness: except on `human-review`, where `skip` is the safe direction.
- **The `dep-update` schedule template lost its inference.** It was derived from
  `pipelineId === 'pl_dep_update'`; that preset was the ordinary build tail under a recurring name, so
  a dependency-update schedule now runs `pl_simple`, which is also the generic choice, so inferring
  from it would mislabel every plain schedule. The template value survives in
  `scheduleTemplateSchema` for an explicit API caller. Giving the recurring modal a real template
  picker is the honest fix and is not in this initiative.
- **Rung order in `buildDeliveryPipelines` is the default.** Nothing resolves the default by id, so a
  reorder silently changes what every `Start` button runs. Pinned by a test asserting
  `seedPipelines()[0].id === 'pl_build'`, and `BUILD_PIPELINE_ID` exists so a programmatic caller
  names it instead of re-deriving it from catalog order.
