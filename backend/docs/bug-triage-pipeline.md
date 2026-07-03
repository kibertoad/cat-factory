# Bug-triage pipeline (recurring)

A **recurring-only** pipeline that works a team's bug backlog autonomously: each scheduled
fire pulls ONE matching issue from the workspace's configured issue tracker, marks it
in-progress with a "taken by cat-factory" comment, investigates the codebase across every
involved service's repo, asks a human for clarification when the report is unclear, writes
a failing reproduction test (and is allowed to concede), fixes the bug, and drives the fix
through the standard review / ephemeral-env test / conflicts / CI / merge tail. On merge,
the existing tracker writeback closes the issue — the loop is closed end to end.

This document is the full design. Implementation is tracked in
[`docs/initiatives/bug-triage-pipeline.md`](../../docs/initiatives/bug-triage-pipeline.md).

Multi-repo investigation and fixing rides on the **service-connections** design — this
initiative *executes* [`service-connections.md`](./service-connections.md) Phases 3–4
(multi-repo coding, multi-PR gates + merge-all) rather than re-designing them. Do not
re-derive that work here; the service-connections doc is the source of truth for it.

## 1. Pipeline shape

A new built-in seed pipeline in `seedPipelines()` (`@cat-factory/kernel`
`src/domain/seed.ts`), exported as `BUG_TRIAGE_PIPELINE_ID = 'pl_bug_triage'`:

```ts
{
  id: 'pl_bug_triage',
  name: 'Bug triage (recurring)',
  availability: 'recurring',                       // NEW field, see §2
  agentKinds: [
    'bug-intake',        // pull one matching issue, mark in-progress, comment  (§3)
    'bug-investigator',  // structured multi-repo investigation                 (§4)
    'clarity-review',    // clarification gate — auto-pass when clear           (§5)
    'task-estimator',    // early estimate, factors in investigation output     (§6)
    'repro-test',        // failing reproduction test(s), may concede           (§7)
    'coder',             // the fix                                             (§8)
    'reviewer',          // container-explore companion on the coder            (§9)
    'tester-api',        // ephemeral-env verification + fixer loop             (§9)
    'conflicts', 'ci', 'merger',                    // standard tail            (§10)
  ],
}
```

- The `reviewer` companion sits adjacent to `coder` per `assertValidCompanionPlacement`.
- The gates tail is hand-authored like every other seed preset (there is no runtime
  insertion of `conflicts`/`ci`/`merger`).
- `ScheduleTemplate` (contracts `src/recurring.ts`) gains a `'bug-triage'` value so the
  recurring modal seeds a sensible block description, mirroring `'tech-debt'`.
- The closest existing presets — and the reference implementations to copy from — are
  `pl_bugfix` (bug-investigator → clarity-review head) and `pl_tech_debt` (the recurring
  analysis → tracker → act shape).

### Run lifecycle on a schedule

The pipeline is attached to a service frame via a normal `PipelineSchedule`
(`RecurringPipelineService`), which owns one reused `taskType: 'recurring'` block. Every
fire re-runs that block; `bug-intake` rewrites the block's title/description from the
issue it picks, so each fire works a different bug through the same block. The existing
recurring safeguards apply unchanged: no individual-usage models (system-initiated start),
and **no overlap** — a run parked on clarification (§5) or on a companion budget gate
blocks the block, so subsequent fires skip until a human settles it. That is intentional:
one bug in flight per schedule.

## 2. Pipeline `availability` (recurring / one-off / both)

Today any library pipeline can be launched both ways; recurring-vs-one-off is purely a
property of how it's started. `pl_bug_triage` must not be startable as a one-off task (a
manual run has no schedule, hence no intake config), so the definition gains the launch
constraint:

- **Contract**: `pipelineSchema` (`@cat-factory/contracts` `src/entities.ts`) gains
  `availability?: 'one-off' | 'recurring' | 'both'`. Absent means `'both'` — pre-1.0, no
  migration/back-fill; existing rows simply read as unrestricted.
- **SPA pickers**: `AddTaskModal.vue` (one-off) filters out `availability === 'recurring'`;
  `RecurringPipelineModal.vue` filters out `'one-off'`. Both filters compose with the
  existing `pipelineAllowedForFrame` predicate (`frontend/app/app/utils/pipeline.ts`).
- **Server enforcement** (the pickers are convenience, not the gate):
  - `ExecutionService.start` gains an `origin: 'manual' | 'recurring'` option (default
    `'manual'`); `assertRunnable` rejects a `'manual'` start of a `recurring`-only
    pipeline (and vice versa). `RecurringPipelineService.fire` passes `'recurring'`.
  - `RecurringPipelineService.create`/`update` reject attaching a `'one-off'`-only
    pipeline to a schedule.
  - `validatePipelineShape` (`orchestration` `pipelineShape.ts`) validates the field and
    rejects a `bug-intake` step in a non-`recurring` pipeline (the step is meaningless
    without a schedule).

## 3. `bug-intake` — pull one issue, mark it, own the no-op

A one-shot **non-LLM engine step** (the inbound dual of the existing `tracker` filing
step), dispatched through `step-handler-registry.ts`. No container, no model call.

### Configuration — on the schedule, not the pipeline

The pipeline stays generic; *which tracker board and which predicates* are per-schedule.
`PipelineSchedule` (contracts `src/recurring.ts` + the `pipeline_schedules` persistence,
D1 ⇄ Drizzle with a fresh migration each) gains:

```ts
issueIntake?: {
  source: TaskSourceKind                    // 'jira' | 'github' | 'linear'
  board: {                                  // the vendor's "board"/project scope
    jiraProjectKey?: string
    linearTeamId?: string
    githubRepo?: string                     // owner/name
  }
  predicates: {
    titleFragment?: string                  // substring match in the title
    labels?: string[]                       // label(s) that must be present
    issueType?: string                      // default 'bug'
  }
  inProgressLabel?: string                  // GitHub only, default 'in-progress' (§ pickup)
}
```

`RecurringPipelineService.create/update` require `issueIntake` when the chosen pipeline
contains a `bug-intake` step, and validate the source is a connected task source
(`TaskConnectionService.isEnabled`). Credentials are the existing `task_connections`
rows (Jira/Linear) or the GitHub App — **no new credential storage**. The SPA's
`RecurringPipelineModal.vue` gains an intake section (source picker from connected
sources, board field per vendor, the three predicate inputs), i18n'd.

### Predicate search — a port extension, three vendor impls

`TaskSourceProvider` (`kernel/src/ports/task-source.ts`) gains:

```ts
searchIssues?(credentials: unknown, query: IssueIntakeQuery): Promise<TaskSearchResult[]>

interface IssueIntakeQuery {
  board: { jiraProjectKey?; linearTeamId?; githubRepo? }
  titleFragment?: string
  labels?: string[]
  issueType?: string
  excludeExternalIds?: string[]
  limit: number                              // small; ordering oldest-first
}
```

Only **open** issues, oldest-first (deterministic pickup order). Vendor mapping, pushed
into the vendor query wherever expressible (never fetch-all-then-filter):

- **Jira** (`jira.logic.ts`): JQL — `project = <key> AND statusCategory != Done AND
  issuetype = "<type>" AND labels = "<label>" AND summary ~ "<fragment>" ORDER BY created ASC`.
- **GitHub Issues** (`github-issues.logic.ts`): search qualifiers —
  `repo:<owner/name> is:issue is:open label:"<label>" in:title <fragment>
  sort:created-asc`; `issueType` maps to the org issue-type filter where available, else
  to a `type:<x>`/label convention (documented in the provider).
- **Linear** (`linear.logic.ts`): GraphQL `issues(filter: { team, state.type != completed/
  canceled, labels, title contains })`, oldest-first.

### Selection — exactly one, deduped

1. `searchIssues` with the schedule's predicates, `excludeExternalIds` seeded from the
   local `tasks` projection: any issue already imported AND linked to a block is off
   limits (it is or was being worked). This is **one batched projection read**, never a
   per-candidate point lookup (the no-N+1 rule).
2. Pick the oldest remaining match. None ⇒ the no-op path below.

### Actions on pickup

1. `TaskImportService.import(workspaceId, source, externalId)` — the standard projection
   upsert (full description, comments, labels, priority).
2. **Replace-link** to the schedule's block: a new `TaskLinkService.replaceForBlock`
   (unlink whatever the previous fire linked, then `linkToBlock`) so linked context never
   accumulates across fires.
3. Rewrite the block's title/description from the issue (the same block-seeding move
   `createTaskFromIssue` does, applied to the existing recurring block).
4. **Mark in-progress + comment** — a new writeback entry point (below).
5. Step output: a short human-readable summary (issue key/url, title, matched predicates)
   — this is what `priorOutputs` threads to every later step.

### In-progress transition + pickup comment

`IssueWritebackProvider` (`kernel/src/ports/issue-writeback.ts`) gains:

```ts
onIssuePickedUp(workspaceId: string, blockId: string, info: { runUrl?: string }): Promise<void>
```

`IssueWritebackService` implements it per vendor, best-effort like the existing hooks
(a tracker hiccup never fails the run):

- **Comment** (all vendors): "Taken by cat-factory" + the run/board link — the existing
  comment plumbing (`commentOnGitHubIssue` seam, Jira comment POST, Linear comment
  mutation).
- **Transition**: Jira generalizes `pickDoneTransition` into
  `pickTransitionByCategory('indeterminate' | 'done')` (`jira.writeback.logic.ts`) and
  transitions to the first in-progress-category state; Linear mirrors
  `pickCompletedStateId` with a `started`-type `pickStartedStateId`; GitHub has no native
  status, so it applies the schedule's `inProgressLabel` (default `in-progress`) —
  creating the label if absent — and leaves the issue open.

On merge, **nothing new is needed**: the existing `onPullRequestMerged` writeback finds
the linked issue via `taskRepository.listByBlock` and comments + resolves it (the "done"
transition), provided the workspace/block writeback toggles are on.

### No matching issue — silent no-op success

The intake handler writes a "no matching issues" step output, marks every remaining step
`skipped` (the existing `step.skipped` mechanics used by estimate-gating), and completes
the run **successfully**. No notification — the outcome is visible in the schedule's run
history and the block's last run. This is a small engine capability scoped to the intake
handler (an early-complete that reuses the skip machinery), not a new gate archetype.

## 4. Investigation — structured, multi-repo `bug-investigator`

`bug-investigator` today is a thin read-only prose role (`agents/src/agents/prompts/
roles.ts`). It is upgraded to a **structured `container-explore` kind** through the
registered-kind track (`registerAgentKind` — the `security-auditor` worked example is the
shape to copy), keeping the same kind id so `pl_bugfix` inherits the upgrade:

- `agent: { surface: 'container-explore', clone: { branch: 'base' } }` — read-only
  checkout of the primary repo **plus every involved service's repo as sibling checkouts**
  via the service-connections Phase 3 `peerRepos` job body. Which peers: the schedule
  block's `involvedServiceIds` (Phase 1, already implemented) resolved through
  `resolveRepoTargets` (plural, Phase 3). This is how "one or more repos, taking linked
  services/frontends into consideration" is real, not prompt-only.
- `structuredOutput` (valibot, lenient with `v.fallback`/`v.optional` like
  `securityAssessment`):

```ts
{
  clarity: 'clear' | 'needs_clarification',
  summary: string,                       // what the bug is, in the agent's own words
  rootCauseHypotheses: string[],         // ranked
  affectedRepos: Array<{ repo: string; frameId?: string; paths: string[]; rationale: string }>,
  suggestedReproductions: string[],      // concrete repro/test ideas for §7
  questions: string[],                   // non-empty iff needs_clarification
}
```

- A post-completion resolver (`registerStepResolver`) renders a prose digest into
  `step.output` (so `priorOutputs` threads it to the estimator, repro-test and coder) and
  leaves the structured result on `step.custom`, rendered by the stock
  `generic-structured` result view — no bespoke UI.

## 5. Clarification gate — reuse `clarity-review`, plus a tracker comment

Requirement: "if extra inputs needed, raise an ask for a human". The purpose-built seam is
the existing **`clarity-review`** re-entrant park loop (`IterativeReviewService` subclass
driven by `ReviewGateController`), already the bug-report triage step in `pl_bugfix`. Two
extensions:

- **Seeding + auto-pass**: when the preceding step is a structured `bug-investigator`
  output, the gate seeds its review items from `questions` instead of running its own
  first LLM pass, and **auto-passes** (no park, no notification, no LLM) when
  `clarity === 'clear'` — the requirements-review auto-pass pattern.
- **Tracker echo**: on parking, best-effort post the open questions as a comment on the
  linked tracker issue via a new `IssueWritebackProvider.postQuestions(workspaceId,
  blockId, questions)` — so the reporter sees the ask where they filed the bug. Answers
  still arrive **in-app** (the existing clarity window; the incorporated brief substitutes
  the block description downstream). Tracker-side reply polling is explicitly out of
  scope.

The park is a normal `awaiting_decision` + the existing `clarity_review` notification.
Because the schedule skips fires while the block has a live run, a parked clarification
holds the schedule — by design (see §1).

## 6. Task estimator — early, investigation-aware

The stock inline `task-estimator` is placed immediately after `clarity-review`: it runs
once the problem is understood (investigation output + clarified brief are both in its
context via `priorOutputs` / the description substitution) and **before** any
implementation spend. Its `{complexity, risk, impact}` estimate persists to
`block.estimate` (existing resolver) and is available for per-step gating and consensus
gating on the expensive downstream steps — no new code, only placement.

## 7. `repro-test` — Reproduction Test Automation (may concede)

A new registered kind, `agent: { surface: 'container-coding', clone: { branch: 'work' } }`
— it creates (or reuses) the run branch `cat-factory/<blockId>` and is the first
committing step of the run. Multi-repo capable: the tests land in whichever involved repo
owns the behaviour (the sibling-checkout layout from Phase 3).

- **Mission**: write one or more tests that fail *for the reported reason* — run them and
  capture the failure output as proof, then commit + push. Tests are committed active
  (not skipped): the intent is that CI is red until the coder's fix turns them green, and
  the tail CI gate is the enforcement.
- **Structured outcome** (`structuredOutput`):

```ts
{
  outcome: 'reproduced' | 'partial' | 'not_reproducible',
  testPaths: string[],
  notes: string,        // for not_reproducible: WHY (e.g. needs prod data, timing-dependent)
}
```

- **Conceding never fails the pipeline**: a post-completion resolver records a
  `not_reproducible` outcome into `step.output` (so the coder knows there is no failing
  test and why) and the run simply advances. Only an infrastructure/eviction failure
  fails the step, same as any container kind.

## 8. Coder — original context + investigation + repro, fix-the-issue emphasis

The stock built-in `coder` (build phase), no new kind. Its context is already complete by
construction: block description = the picked issue (or the clarified brief), and
`priorOutputs` carries the intake summary, investigation digest, estimator summary, and
the repro outcome. One addition:

- **`BUG_FIX_GUIDANCE` prompt fragment** (`@cat-factory/agents`, applied when a prior
  `repro-test` step output exists in the run): the coder MAY amend or extend the
  reproduction test if new information surfaces while fixing, but the objective is
  **fixing the reported issue** — a change that merely makes the test pass without
  addressing the report is a failure. Keep the reproduction test meaningful.

Multi-repo: the coder runs with the same `peerRepos` sibling-checkout layout; push/PR
fan-out opens **one PR per dirty repo** (Phase 3), tracked as `block.pullRequest`
(primary) + `block.peerPullRequests`.

## 9. Review and ephemeral-env test — stock loops

Zero new machinery:

- **`reviewer`** — the existing container-explore companion targeting `coder`
  (`companions.ts` + `CompanionController`): clones the PR branch, reads the real diff,
  and a failing verdict automatically loops the coder back with the feedback, up to the
  attempt budget, then parks for a human (one-more-round / proceed / stop).
- **`tester-api`** — the existing tester gate with ephemeral-env infra
  (`decideTesterInfra`): a service with `kubernetes`/`custom` provisioning gets a real
  provisioned environment (deploy-harness), docker-compose services run in-container, and
  a failing report dispatches the **`fixer`** companion (pushes to the same PR branch)
  then re-tests — the standard Tester→Fixer loop. Multi-env provisioning for the involved
  peer services is service-connections Phase 2 — a compatible follow-up, not required for
  v1 (the tester still exercises the primary service's env).

## 10. Gates + merger tail

Hand-authored `conflicts → ci → merger`, the standard tail. With multi-repo fixes in play
these must be the **Phase 4** generalizations (executed under this initiative):

- `ci` aggregates check runs across the primary + peer PRs; the `ci-fixer` helper runs in
  the same sibling-checkout container (a cross-repo contract break is exactly what a
  single-repo fixer cannot fix).
- `conflicts` probes mergeability per PR; the `conflict-resolver` stays single-repo.
- `merger` assesses the **combined diff** once, then all-green-then-merge-all in
  provider-before-consumer order; the task is `done` only when ALL PRs merged; a
  mid-sequence failure leaves the block `blocked` with a notification (accepted
  non-atomicity — see the service-connections doc, do not re-litigate).

After the merge, the existing writeback closes the tracker issue (§3), and the next
scheduled fire picks the next matching bug.

## 11. Out of scope / non-goals

- **Tracker-side reply polling** for clarification answers — answers come in-app; the
  tracker comment is an echo, not a channel.
- **Per-frame tracker overrides** — the workspace-level `task_connections` + the
  per-schedule `issueIntake.board` cover the "specified tracker, specified board"
  requirement without a frame-chain config table.
- **New notification types** — the flow reuses `clarity_review`, `test_failed`,
  `ci_failed`, `merge_review` and the standard decision parks.
- **Backwards compatibility** — pre-1.0 rules apply: `availability` and `issueIntake` are
  additive optional fields; no shims, no dual-reads.
