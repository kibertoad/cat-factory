# Initiative: Bug fishing expedition (multi-angle hunt → triage → spawned fix tasks)

## Goal & rationale

Every defect flow the platform has starts from a REPORT. `bug-investigator` triages one,
`pl_bugfix` fixes one, `bug-hunt` picks one off a tracker board, the `ci` gate reacts to one
that already broke a build. Nothing looks for the defects nobody has hit yet, and those are the
ones that cost the most: they ship, they sit, and they surface as an incident rather than as a
ticket.

A **bug fishing expedition** is the missing shape. It is a read-only, multi-angle hunt through a
service's codebase for genuine logic gaps, real bugs, footguns and unhandled edge cases. It
changes nothing and opens no pull request; its deliverable is the catch, and a human decides
which findings become work. Each finding they MARK spawns its own bug-fix task, on its own
pipeline, linked back to the expedition that found it.

Two design decisions carry the feature, and both are about the same thing: an agent asked to
"find bugs" in a healthy codebase finds something, and the something is a style opinion dressed
as a defect.

- **Angles, not one pass.** The expedition runs the SAME read-only agent once per ANGLE
  (control flow, failure handling, boundaries, concurrency, lifecycle, contracts, footguns,
  requirements conformance). A pass told to find everything returns the shallow half of
  everything; a pass told to think only about concurrency reads the same files with a question
  that makes the race visible. Each angle is its own container dispatch with a fresh context,
  which is also why they are affordable: the reading of one angle never lands on another's
  transcript.
- **A stated finding bar.** The prompt spells out the test a candidate must pass before it is
  reported (point at the code, describe what actually happens, would fixing it change
  behaviour, has something else already handled it) and names the empty answer as a legitimate
  result. `confidence` exists for the same reason: a finding the agent is unsure of is useful
  when it says so and worse than nothing when it does not.

## Target pattern (the reference implementations this copies)

- **The phase LOOP** is the Ralph loop's shape: `RalphController.resolveRalphResult` re-arms one
  step and re-dispatches it rather than finishing, and the dispatch epoch
  (`dispatchEpochFor`) gives each pass a job id of its own. `BugFishingController` is the same
  machine with a phase list instead of an attempt budget.
- **The PARK + human triage** is the PR deep-review's shape: state on the step
  (`step.bugFishing`, the sibling of `step.prReview`), a completion interceptor that
  short-circuits `recordStepResult`, a dedicated result-view window, and a `RunDecisionSurfaces`
  entry per verb.
- **SPAWNING a linked task** is the initiative loop's: `blockRepository.insert` under the
  expedition's own parent frame, then a bound `ExecutionService.start`, with the block rolled
  back if the start fails. `Block.expeditionId` mirrors `Block.initiativeId` exactly, down to
  its index.
- **The per-dispatch BRIEF** is the Challenge Investigator's: folded in as a `priorOutputs`
  entry by the step handler, so the standing role prompt stays overridable by a workspace
  without losing the angle the pass is fishing.

## What shipped

| Layer         | What                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts     | `bugFishing.ts` (the angle catalog, findings, step state, the lenient agent output, the request bodies), `bug-fishing` task type + its two creation fields, `Block.expeditionId`, `bugFishingFixPipelineId`          |
| Kernel        | `pl_bug_fishing` (a single `bug-fisher` step, `research` purpose, no tail), the `bug-fishing → pl_bug_fishing` type default, the input-gate exemption                                                                |
| Agents        | the `bug-fisher` kind (read-only `container-explore`, full base-branch clone) + `renderBugFishingPhaseBrief`                                                                                                         |
| Orchestration | `bugFishing.logic.ts` (the pure reductions), `BugFishingController` (the phase loop, the park, triage, spawning), the step handler + completion interceptor + failed-pass branch                                     |
| Server        | four workspace-scoped routes under `/executions/:executionId/bug-fishing`                                                                                                                                            |
| Runtimes      | `blocks.expedition_id` + `workspace_settings.bug_fishing_fix_pipeline_id`, D1 ⇄ Drizzle                                                                                                                              |
| Frontend      | the expedition window (phase rail, per-finding triage, pipeline override), the create-form angle picker, the board setting, the inbox card, 10 locales                                                               |
| Coverage      | `bugFishing.logic.test.ts` (28 cases, the claim lifecycle included) + a cross-runtime conformance suite (loop → park → spawn → finish; board default + per-batch override + both loud refusals + the released claim) |

## The rules that bit, and why each is what it is

- **The expedition state must survive `resetStepForRerun`.** The loop re-arms the SAME step for
  each angle, so anything the reset clears is thrown away between passes. `bugFishing` is
  preserved by omission there, exactly like `prReview` / `forkDecision`, and the conformance
  suite asserts the ACCUMULATION (two angles, four findings) rather than only the last pass.
- **Triage does not wait for the hunt.** `address` is accepted while later angles are still
  fishing. That is the whole reason the angles are separate dispatches: a human who reads the
  concurrency pass at minute six should be able to start its fix then, not after the
  requirements pass finishes at minute forty.
- **A failed angle costs only that angle.** The passes share nothing but the checkout, so a
  crashed one is settled as `failed` CARRYING ITS REASON and the expedition moves on. A phase
  that silently reported nothing is indistinguishable from one that honestly found nothing,
  which is the distinction the record has to keep.
- **A spawn that cannot happen fails LOUDLY.** The first cut swallowed a start failure into
  "the finding stays untriaged" and answered 200. That reports the request as done and leaves
  somebody waiting for a task that is never going to appear, so the failure propagates instead;
  findings spawned earlier in the batch are already persisted, and the refused finding's record
  is released as `failed` carrying the cause, so it stays markable. Conformance drives both
  refusals (a pipeline that does not exist, and one that exists but cannot be started on a
  one-off task).
- **The spawn record is a CLAIM, taken before the task exists.** Marking creates a board task and
  starts a run, so it is an external side effect two callers can enter at once: creating first
  and recording after (the first cut) let two markings of one finding each file the same bug and
  start a run for it. The record is now written as `pending` under the run's CAS with the block id
  it is about to create, and settled to `spawned` or `failed` behind the work — the shape
  `InitiativeLoopService.spawnItem` uses, down to recognising its own claim by that id so a
  settle cannot report the loser's outcome against the winner's task. The consequence every
  reader owes: "is this finding being fixed" is its spawn's STATUS, never the record being
  present, which is why `bugFishingSpawnIsClaimable` lives in contracts where the engine and the
  window read the same one.
- **A pass that answers unusably is not a pass that found nothing.** An absent or unparseable
  `result.custom` used to settle the phase as `completed` with an empty summary, which is
  byte-for-byte how an angle that honestly caught nothing is recorded — and "which angles came
  back empty" is the whole product a human reads. It takes the failure path instead, named as its
  own cause so it is distinguishable from a crashed container too.
- **A spawned fix is created the way the CREATE FORM would create it.** The task is hand-built
  rather than routed through `BoardService.addTask` (the initiative loop's precedent), so
  everything that door applies has to be applied deliberately: the service's standing standards
  through the same `fragmentIdsFor` seam (a task-level run folds only its own `fragmentIds` and
  never re-unions the service's), and `createdBy` from whoever marked the finding, without which
  the "notify the task creator" audience of every notification the fix run raises is empty.
- **The input gate had to learn about it.** A bug-fishing task legitimately has no description:
  its input is the codebase. `description_missing` is BLOCKING, so every expedition would have
  parked at step 0 before ever dispatching. The exemption is its own set
  (`CODEBASE_INPUT_TASK_TYPES`) rather than a second member of the platform-authored one,
  because the two answer different questions: that one is about who wrote the description, this
  one about where the input lives.
- **A retired angle is NAMED.** Phase ids are a persisted closed vocabulary, so a run keeps
  coming back out of the store naming an angle a later build may not ship. Each recorded phase
  carries the title and goal it ran under, `describeBugFishingPhase` answers "retired", and
  `describeRecordedPhase` prefers the run's own record over the placeholder — the expedition
  genuinely fished that angle and is the better witness.

## Large codebases: territories, a scout, a pass budget, and rotation

Design for the large-codebase slices. **Slices 1, 2 and 4 have shipped** (territories, the handed-over
brief, the coverage record, the pass budget); the checklist at the end is the record, and the
"what shipped" notes under it are what the implementation settled that the design left open.

### The problem, stated against what ships

Every pass today is told "decide where in this codebase that angle could actually bite, then read
narrowly". On a service of a few thousand lines that heuristic is the whole coverage story and it
works. On a large codebase (a monorepo package of a few hundred thousand lines, a service with
dozens of modules) it fails in three ways at once, and each gets worse with size:

- **Coverage is unknown and unrepeatable.** The pass reads whatever its first `grep` pointed it
  at. Two expeditions over the same tree read different files, the phase summary is the only
  record of what was looked at, and a module nobody read reports exactly like a module that was
  read and found clean. That is the "absent and zero render the same" trap at the scale of a
  whole subsystem.
- **Orientation is paid once per angle.** Each angle is a fresh context, by design, so each one
  re-discovers the directory layout, the entry points and the package boundaries before it reads a
  body. The PR-review measurement ([`pr-review-turn-reduction.md`](./pr-review-turn-reduction.md))
  showed those discovery turns dominate an agentic run's cost, because every later turn re-sends
  them. An expedition has no diff to bound it, so its orientation is larger than a review's, and
  it is repeated eight times.
- **Nothing bounds what one pass reads except the clock.** The bug-fisher runs with
  `expectsEdits: false`, which disables the harness's no-edit progress guard, so a pass is bounded
  by `JOB_MAX_DURATION_MS` (an hour) and by nothing finer. On a large tree that hour is spent
  sampling, and the finding bar's fourth test ("has something else already handled it?") is
  unanswerable when the pass has one file from each of forty modules in view rather than one
  module whole. The per-phase cap then fills with low-confidence candidates from everywhere.

So yes: a large codebase has to be split into logical groups and fished group by group. Whether
that is a token saving or a token multiplier turns on WHAT the groups are, WHO computes them,
whether every angle runs over every group, and whether the split lives in one run or many. The
answers below follow the rule that runs through every other flow here: the platform COMPUTES, the
model JUDGES.

### Decision 1: the unit is a TERRITORY, computed by the platform from the tree

A **territory** is a cohesive slice of the codebase sized so one pass can read a meaningful share
of it with ranged reads: a target of roughly 150k source tokens (bytes ÷ 4 on the tree's blob
sizes), never more than twice that. Territories are derived deterministically on the backend,
before the first dispatch, from the repository TREE, not by asking a model to invent a module map:

1. **A blueprint wins when one exists.** `blueprints/blueprint.json` already records the
   platform's own decomposition of the service into modules, and each `BlueprintModule` carries
   `references`, the repo-relative files and directories it owns. Those become the territories: a
   module whose references exceed the budget is split along its own sub-directories, small
   siblings are packed together, and a module with no usable references falls through to rule 2
   for its part of the tree. Nothing on the backend reads the blueprint today (only the
   Blueprinter's own prompt does, inside the container); this adds the one `RepoFiles.getFile`
   read plus a `blueprintServiceSchema` parse, and treats a stale or absent blueprint as "no
   blueprint" rather than trusting a path the tree no longer has.
2. **Otherwise, package and directory boundaries.** A workspace-package marker (`package.json`,
   `pyproject.toml`, `go.mod`, `Cargo.toml`, a `src/<module>` directory) is a boundary; the tree is
   walked top-down and bin-packed into territories of the target size, keeping a directory whole
   whenever it fits. Generated, vendored, fixture, snapshot and lockfile paths are excluded by the
   same ignore vocabulary the file-size ratchet uses, and test files stay WITH the code they test
   (a pass answering "does a test pin this invariant?" needs both).
3. **The service's monorepo `directory` is the root, and the FRAME.** `resolveRepoTarget` already
   narrows a service to its directory; the survey walks from there, never from the repository root,
   so a sibling service's code is out of scope exactly as it is for every other run. Every path the
   survey then emits (a territory's roots, its manifest) is relative to that root, because the
   harness checks the agent out at `<clone>/<serviceDirectory>` and that is the frame the pass reads
   files in, reports its `filesRead` in, and anchors its findings in. A repo-relative manifest handed
   to a service agent lists paths it cannot open, and every finding it sends back lands outside every
   root and is dropped as somebody else's ground.

The tree comes from ONE call. `GitHubClient.listTree` and `VcsClient.listTree` already read the
whole tree through the recursive git-trees endpoint, every entry carrying its blob or subtree SHA
and (for files) its byte size; today their only consumer is the doc-context file picker's search
box. The gap is on the facade the engine holds: `RepoFiles` gains `listTree?(gitRef)` (optional,
like `listChangedFiles?`), delegating to the client. Walking `listDirectory` level by level is an
N+1 over HTTP and is banned for the same reason it is banned over a database. The provider
TRUNCATES a very large tree, and a truncated tree is not a manifest: the read surfaces truncation,
and a truncated survey plans against the blueprint or the top-level directories it did get,
recording on the plan that the tree was partial. The result is cached through `AppCaches` keyed by
`(repoId, commitSha)`, because two things read it: the survey that plans the expedition and the
step handler that briefs every pass.

What a territory records on the step is SMALL: an id, a label, its root paths, a file count, an
approximate token count and its subtree SHAs. The file list is never persisted (a thousand paths
on a blob re-serialised on every progress write); the per-pass manifest is re-rendered from the
cached tree at each dispatch.

**Pass-through:** a codebase that fits in one territory plans one, with no territory id on its
phases, and the expedition is byte-for-byte today's: eight angles over the whole tree, no scout,
no manifest beyond the one the pass would have built itself. Large-codebase mode is a size
threshold crossed, never a mode a task opts into.

### Decision 2: one run, a flat phase list of (territory × angle) passes, territory-major

The passes stay what they are: one read-only container dispatch per pass, fresh context, on the
SAME step, driven by the existing `BugFishingController` loop with its one-dimensional
`currentPhaseIndex`. The loop does not change; the PLAN gets longer. Today a phase IS an angle. It
becomes an angle fished over a territory: `phase.id` stays the angle id (the persisted closed
vocabulary, `describeBugFishingPhase` and its retired handling untouched) and gains a nullable
`territoryId` (null means the whole codebase, which is how every stored run parses unchanged). A
finding carries the same pair. `dispatchEpochFor` counts per kind across the run, so every one of
the T × A dispatches gets its own job id with no new counter.

The alternatives, and why they lose:

- **One expedition per territory, as separate runs or tasks.** The obvious reading of "process
  groups separately in different runs", and it splits the one thing an expedition exists to
  produce. Triage scatters over N windows and N inbox cards; the seams BETWEEN territories (the
  `contracts` and `boundaries` angles are about little else) belong to no run; a recurring
  schedule needs N reused blocks that drift; and marking a finding in territory 3 while territory
  5 is still fishing, which the phase loop gives for free, would need cross-run coordination to
  reinvent. A large codebase gets ONE catch, in one window, grouped by territory.
- **One dispatch per territory with a subagent per angle inside it.** The PR reviewer's shape,
  cheaper on clones and wall-clock. Rejected here: subagent fan-out is a Claude Code CLI
  capability (Pi and codex do not fan out, and the harness reads only the parent stream), a
  wedged parent loses every angle's findings for that territory, and the human loses per-angle
  landing, which is what lets them start a fix at minute six. Fresh context per angle is what the
  feature IS; the design keeps it and saves elsewhere.
- **A sparse checkout per territory.** `AgentCloneSpec.sparsePaths` exists, dormant and static per
  kind, and making it per-dispatch is tempting for clone cost. Wrong for the finding bar: "has
  something else already handled it?" is answered by the neighbouring module, the shared type,
  the caller one layer up. The clone stays full; the READING is what the territory scopes, and
  `serviceDirectory` today is only a working directory plus prompt guidance, so a territory is
  the same kind of thing: a scope the platform states and then ENFORCES at coercion (Decision 5),
  not a wall.
- **A bigger context window or a stronger model per pass.** Cost scales with the codebase either
  way; only the partition makes it scale linearly, and only the partition gives a coverage record.

Ordering is **territory-major**: every planned angle over territory 1, then territory 2. The human
gets a complete answer for one module early and can start its fixes while the rest is fished, and
the prior-findings list each pass is briefed with (Decision 5) stays the territory's own.
Angle-major (every territory under `control-flow` first) would front-load the highest-yield angle,
but the territories themselves are priority-ordered (Decision 4), so the early passes are already
the ones most worth having if the expedition is stopped.

### Decision 3: a SCOUT prunes the matrix; the platform plans from its verdict

Territories × angles is the multiplier that turns a partition into a token sink: six territories
and eight angles is forty-eight dispatches, and many cells are empty. A pure-functional module has
no concurrency to fish, a territory of DTOs has no failure handling, `requirements` applies only
where a specification points. The engine cannot know which cells are empty from a tree, and
guessing from file names would be the platform judging.

So a large-codebase expedition opens with a **scout**: ONE bounded inline tool loop over
`RepoFiles`, the shape `MonorepoAdoptionAdvisorService` already runs for the bootstrap adoption
survey (a call ceiling plus a character ceiling, temperature 0, tools withdrawn on the final step
so it must answer, every failure TOLD to the model rather than thrown, the transcript filed through
the inline recorder with the run in scope). It is handed the territory DESCRIPTORS and each
territory's top-level listing up front, never the full file list (thirty territories of several
hundred files each is a prompt the size of the problem it is meant to shrink), so its reads are
the entry points and a few hotspots rather than a walk, and its cost does not scale with the size
of the repo it lands in. It returns, per territory: the hotspots (paths and one line of why,
capped per territory), a relevance rating per angle with a one-line reason, and the **seams**: the
files where territories meet (shared types, cross-module calls, persisted shapes read by more than
one), capped as a whole. The caps are stated in the prompt and enforced at coercion, the way the
finding cap is: a scout that exceeds one has its overflow dropped and the plan says so, because on
a big service the scout's own answer is otherwise the first thing to explode. It reports no
findings; it draws a map. The existing explorer port is monorepo-and-template specific (`side`,
prefixed keys); the scout generalises its shape into a `RepoExplorer` over one `RepoFiles`, and
the adoption survey becomes its first caller when convenient, not in this slice.

A container scout (a sibling `container-explore` kind dispatched on the bug-fisher step, the way
the fork proposer is dispatched on a `coder` step) was considered and set aside: it costs a full
clone and an orientation of its own, which is the cost this whole design is spending to remove. It
stays the escalation if the inline scout proves too shallow to rate angles honestly.

The ENGINE then plans the pass list deterministically from the map plus the budget: for each
territory, the angles rated at least `medium`, always including the two the catalog ranks highest
(the scout can be wrong, and the top angles earn their pass everywhere); plus a synthetic `seams`
territory fished under `contracts` and `boundaries`, whose manifest is the scout's edge list
validated against the tree (a path the tree does not have is dropped and named as dropped, and a
seams territory with nothing left is not planned, and says so). The plan is written onto the step
BEFORE any pass runs and the window shows it: which cells run, which were pruned and why, in the
scout's words. A scout that fails or answers unusably does not fail the expedition: the plan falls
back to the full matrix within budget, and the plan record says so, because an unplanned matrix
and a planned one read differently to the person deciding how far to trust the coverage.

### Decision 4: the pass budget is stated up front, and every cut is recorded

An expedition carries a **pass budget**: the most dispatches it may make, defaulting to a shipped
number (twenty-four, three times today's expedition), settable per task (`fishingMaxPasses`, a
sibling of `fishingPhaseIds`) and per workspace beside `bugFishingFixPipelineId`. This is a COUNT,
not a spend gate: `runStepPreamble` already runs `spend.isOverBudget` before every dispatch, so an
over-budget workspace pauses between passes today, and the count is what bounds a run that is
within budget but unreasonably long. When the planned matrix exceeds it, the engine trims from
the bottom of a priority order, never from the middle:

1. territories the creator's `fishingFocus` names (a path prefix or a word matching a territory
   label) come first, because the focus is the deliberate act;
2. then territories by the scout's hotspot density;
3. then by size.

Within a territory the lowest-rated angles go first. Whatever is cut is written into the plan as
UNFISHED, by territory and angle, and rendered in the window's plan section and the parked
summary ("fished 24 of 31 planned passes; not fished this run: `billing` under footguns, ...").
A cap silent about its tail teaches the reader that the tail was clean.

The per-phase finding cap (still 40, still reported when hit) and the harness's duration limit
stay as they are. The territory target size is what makes both bite less often: a pass that can
read most of its scope stops sampling.

What the design does NOT yet have is a hard ceiling on one pass's own transcript. The context
discipline in the prompt (ranged reads, no re-reads) is advisory, and a read-only pass runs with
`expectsEdits: false`, which disables the harness's no-edit progress guard, so the clock is the
only bound today. The territory and the manifest make an explosion unlikely; they do not make it
impossible. The honest bound is a per-dispatch READ BUDGET in the harness's `guardLimits` (a total
tool-call ceiling for an explore job, sized by the engine from the territory's token count), which
stops the pass and makes it answer with what it has, recorded on the phase as budget-stopped
rather than as completed. That is a harness change and an image bump, so it is its own slice.

### Decision 5: the brief hands over orientation, so a pass spends its turns reading code

This is where the token saving actually comes from, and it is independent of how many passes run.
Each pass is briefed with `.cat-context/` files set on `injectedContextFiles` by the step
handler's context mutator, the same mutator that folds today's phase brief into `priorOutputs`,
rendered from the cached tree (the seam `prReviewerDiffPreOp` uses to hand the reviewer its
diff):

- **`territory.md`**: the territory's shape, the scout's hotspots for this angle, the entry
  points, and which neighbouring territories it touches. A pass starts from a map instead of
  `find`, `ls` and three greps, and its first body read is its first turn. The manifest is itself
  context, so it is SIZED: directories with file counts and token totals always, individual files
  only where the territory is small enough for the list to stay a few thousand tokens, and above
  that the file list stays in the tree the pass can `ls` on demand. A map that costs a tenth of
  the budget it is meant to save is not a map.
- **The standards as files, not folded prose.** `bug-fisher` is `code-aware`, so today every
  selected best-practice fragment is folded into every pass's system prompt and re-sent on every
  turn of every pass. It switches to `standardsDelivery: 'context-files'`, the PR reviewer's
  precedent, so a standard is read once, when the angle needs it.
- **Prior findings scoped to the territory.** Today's brief lists every earlier finding's title,
  which across thirty passes is hundreds of lines nobody in territory 5 needs. It lists the
  territory's own findings plus the seams', and nothing else; D2 stays prompt-only, at a scope
  where prompt-only is enough.

The brief also tells the pass what it is NOT responsible for, and the platform holds it to that:
a finding whose path lies outside the territory manifest is dropped at coercion and counted in
the phase summary as out-of-scope, so a pass that wanders is corrected by the platform rather
than by exhortation, and the human sees how often it happened.

### Decision 6: coverage is a RECORD, computed from what was read

Each pass reports the paths it read (`coverage.filesRead`) beside its findings. The engine
intersects that with the territory manifest and writes onto the phase what share of the territory
it covered and which files no pass under any angle read. The number is honest about its source:
it is SELF-REPORTED by the model, and the record says so (the tool-call trajectory sink could
verify it later, and the record would then name which of the two produced it). The window renders
it per territory as a coverage rail beside the phase rail, so a territory with a low share is what
tells the human that "found nothing" here means "did not look", the distinction this whole section
exists to preserve.

### Decision 7: recurring expeditions ROTATE, and re-fish what changed

For a large codebase on a schedule the biggest saving is not per run but across runs: a nightly
expedition should not re-read a module nobody has touched since it was last fished clean. That
needs the one thing this flow has so far refused, state that outlives the run (D3), and a large
codebase is the case that earns it: a **territory ledger** keyed by `(workspaceId, serviceId,
territoryId)` recording when the territory was last fished, under which angles, the subtree SHAs it
had, and its catch density. Keyed by SERVICE rather than by the schedule's reused block, so an
ad-hoc expedition and the scheduled one share a memory. It is org state, so it rides the `remote`
bucket of the mothership rule with its allow-list and round-trip tests, mirrored D1 ⇄ Drizzle.

With the ledger, planning gains a priority signal ahead of size: a territory whose subtree SHA
changed since it was last fished outranks one that did not, and one never fished outranks both.
The subtree SHA comes free with the tree read, so "changed since" is a string compare, never a
diff. The rotation rule is then simple: a scheduled expedition spends its pass budget on the
highest-priority cells, records what it fished, and the next run starts from what it left. Full
coverage of a large codebase becomes a property of the cadence rather than of one run's budget,
and the ledger is what makes the UNFISHED list actionable instead of a confession.

The ledger also answers the D3 link the earlier slice deferred: a spawned fix task's merge lands
a new subtree SHA, which is what re-arms its territory.

### What this does NOT change

- The angle catalog, the finding bar, the read-only surface, the full base clone, the triage
  verbs, the spawn claim and the fix-pipeline resolution are untouched.
- A small codebase runs exactly as before (Decision 1's pass-through), and every stored expedition
  parses unchanged (`territoryId` is optional, and null means the whole codebase).
- The harness image does not change: the manifest and the standards arrive as `.cat-context/`
  files through a seam the harness already materialises, and the scout runs inline on the backend.

### What bounds what

Three things can explode on a big service, and each has its own bound; the table is the one place
they are stated together, so a change to one can check it did not silently lean on another.

| What grows                        | Bounded by                                                                                                                                     | Soft until                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| One pass's transcript             | the territory's size; orientation handed over; standards as files; territory-scoped prior findings; the sized manifest; fresh context per pass | Slice 6 lands the per-dispatch read budget |
| The plan (dispatches per run)     | the scout's relevance floor; the pass budget with every cut recorded; rotation across scheduled runs                                           | hard from Slice 4                          |
| The scout's own prompt and answer | descriptors plus top-level listings in, capped hotspots and seams out, the call and character ceilings of the inline loop                      | hard from Slice 3                          |
| The run blob                      | phases bounded by the pass budget; descriptors persisted, never file lists; the per-phase finding cap                                          | hard; the side-table escape hatch is named |

### Slices

- [x] **Slice 1: territories + the brief.** `RepoFiles.listTree?` (delegating to the client's
      existing tree read, truncation surfaced, conformance pinned), the blueprint read,
      `partitionCodebase` as a pure reduction beside `planBugFishingPhases` (blueprint-first,
      then package/directory bin-packing, the ignore vocabulary shared with the file-size
      ratchet), `territories` + `phase.territoryId` on the step state, the tree cache entry, the
      `territory.md` context file, `standardsDelivery: 'context-files'`, territory-scoped prior
      findings, out-of-scope paths dropped and counted at coercion. Full matrix within the
      shipped pass budget; no scout yet. Window: phases grouped by territory. Pass-through
      asserted: a one-territory plan is today's plan, field for field.
- [x] **Slice 2: coverage.** `coverage.filesRead` on the agent output, the per-phase and
      per-territory coverage record, the coverage rail, the unread-files list in the parked
      summary.
- [ ] **Slice 3: the scout.** The `RepoExplorer` generalisation of the adoption explorer, the
      scout's inline tool loop and output schema, the deterministic planner over its verdict
      (relevance floor, the always-run top two, the `seams` territory), the plan section in the
      window with what was pruned and why, the fallback to the full matrix when the scout fails.
- [x] **Slice 4: budgets.** `fishingMaxPasses` plus the workspace default, the trim order, the
      UNFISHED record on the plan and in the summary.
- [ ] **Slice 5: rotation.** The territory ledger (remote bucket, D1 ⇄ Drizzle), the
      changed-since-fished priority signal, the recurring-run planner reading it, the fix-merge
      re-arm.
- [ ] **Slice 6: the per-pass read budget.** A total tool-call ceiling for explore jobs on
      `guardLimits`, sized per dispatch from the territory's token count, the budget-stopped
      phase status and its rendering, the image bump. The pass-through rule holds: a
      single-territory expedition gets no ceiling it does not have today.
- [ ] **Slice 7: measure.** One expedition over a representative large repo before and after
      (turns, fresh vs cached tokens, coverage share, findings a human marked), folded back here
      the way the PR-review tracker did.

### What slices 1, 2 and 4 settled

The design left four things to the implementation, and each was decided against the rule it came
closest to breaking.

- **A tree with no blob sizes is sized by assumption, not by zero.** GitHub's tree read carries a
  byte size per file; GitLab's does not. Sizing a size-less entry as weightless would pack a whole
  GitLab monorepo into one territory and silently undo the partition, so an unsized file counts as
  a middling source file (4 KB) and the constant is stated in one place. The failure mode is now
  "territories are sized coarsely on GitLab", not "sizing stopped applying on one provider".
- **`standardsDelivery: 'context-files'` is HALF a decision.** It only stops the engine folding the
  standards into the system prompt; the op that WRITES them is separate. A `code-aware` kind that
  declares the first without the second does not deliver its standards more cheaply, it stops
  delivering them, and nothing fails. The PR reviewer's op was already kind-neutral, so it was
  renamed (`standardsAsContextFilesPreOp`) rather than copied, and both kinds register it.
- **Without the scout, the trim order is focus then SIZE.** The design's second key is the scout's
  hotspot density, which does not exist until Slice 3. Size is the honest stand-in: it is a fact the
  platform computes rather than a judgement it would be inventing, and the biggest territory is the
  one most likely to hide something. The creator's `fishingFocus` still outranks it, because naming
  a subsystem is the deliberate act.
- **"Could not survey" is its own status, not a one-territory plan.** An unreadable tree, an unwired
  repo and a genuinely small codebase all yield ONE territory, which is the same value and opposite
  facts. `plan.surveyUnavailableReason` is what separates them, and the window renders it. The
  survey answers with that one territory rather than with none: an empty list is what the step would
  persist as `territories: []`, which claims the codebase WAS surveyed and found to contain nothing,
  and it also leaves the planner with no cell to name when the budget cuts an angle.
- **The files loose at a root own themselves, not the root.** A territory's roots are prefixes, and
  the files sitting directly in a root cannot be described by one: the root is a prefix over every
  sibling directory too. At the survey root it is worse, because the empty prefix matches nothing at
  all. So they form their own named territory whose roots ARE those file paths, which `isInTerritory`
  already matches exactly.
- **A derived id needs a de-duplication rule.** Territory ids come from the tree, so two blueprint
  modules sharing a name (or a first reference) derive one id, and `filesByTerritory` is keyed by it.
  Ids are stamped unique within a survey; nothing looks a territory up across surveys, which is what
  makes a local suffix enough.
- **The findings cap is per-expedition as well as per-phase.** The per-phase cap bounded the run blob
  only while a phase list was the angle catalog. Territories x angles multiplies it, so a second
  ceiling bounds the whole record, and the phase that hits it says so.

The pass-through is asserted rather than assumed, on both sides: a one-territory plan is
field-for-field the plan that shipped before territories (no `territoryId` on any phase, no
manifest, no scope), and conformance drives it on every facade.

### Gotchas already visible

- **The step blob is the budget everything else shares.** Thirty phases and their findings ride
  the run's `detail`, re-serialised on every progress write. Territories persist descriptors, not
  file lists; the brief re-renders from the cache; the finding cap stays per phase. If the record
  outgrows the blob, the answer is a side table for findings, never a smaller cap that drops what
  was caught.
- **A territory id is a persisted vocabulary too**, but an OPEN one: it is derived from the tree,
  and the tree moves. A phase whose territory no longer exists in a later survey is rendered from
  the phase's own recorded label, exactly as a retired angle is; nothing looks a territory up by id
  at render time.
- **The scout's edge list is model text that becomes a manifest.** Every path in it is validated
  against the tree before it briefs a pass; `normalizeSurveyPath` from the adoption survey is the
  hardening to reuse, because a scout path is interpolated into a contents-API URL.
- **The blueprint is a decomposition first and a file map second.** Its `references` are paths,
  but they were written by a model against an older tree; a reference the tree no longer has is
  dropped and the module falls through to the directory rule, never guessed onto a new home.
- **Rotation must not starve a territory.** A territory that never changes is still re-fished once
  its last-fished age crosses a ceiling; otherwise the ledger silently exempts the oldest code from
  every expedition, which is where the latent defects are.

## Open decisions

- **D1: how many angles by default.** Today: all eight, which is eight container dispatches. The
  create form narrows it and a recurring schedule can pin a subset (by editing the reused block's
  `fishingPhaseIds`; `createSchedule` carries no task fields). If the cost proves wrong in
  practice the honest fix is a shipped SUBSET as the default (with the rest opt-in), not a
  cheaper prompt: the angle separation is what the feature is. On a large codebase the question
  becomes which CELLS of territory × angle run, and the scout plus the pass budget above answer
  it (Decisions 3 and 4).
- **D2: cross-angle deduplication is prompt-only.** Each pass is briefed with the titles earlier
  passes reported and told not to repeat them. The platform does not merge duplicates, because
  it cannot tell a repeat from a second instance of the same class in different code without
  reading both. Territories keep the list short enough for prompt-only to hold (Decision 5); if
  duplicates still prove common, the place to fix it is a final aggregation pass, not a
  similarity heuristic over titles.
- **D3: no automatic re-fishing after a fix lands.** A recurring schedule re-fishes on its
  cadence and re-reports what is still there; nothing links a merged fix back to the finding
  that caused it. That link needs the expedition to outlive its run, which is a table: the
  territory ledger of Decision 7 is that table, and the subtree SHA a merged fix moves is what
  re-arms its territory. Until Slice 5 lands, this stands as written.

## Follow-ups (not in this slice)

- An e2e spec (create an expedition, watch a phase land live, mark a finding, see the spawned
  card appear) — the live push is exactly what only the assembled product shows.
- A board affordance on the spawned task's card naming the expedition it came from. The link is
  stored (`Block.expeditionId`) and the window walks it the other way; the card does not yet.
- A `pl_bug_fishing_deep` variant pinning a stronger model per angle, once there is evidence
  about which angles are worth the spend.
