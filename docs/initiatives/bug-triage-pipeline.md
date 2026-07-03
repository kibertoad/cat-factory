# Initiative: bug-triage pipeline (recurring)

## Goal & rationale

Teams accumulate bug backlogs faster than they burn them down. This initiative adds a
**recurring-only pipeline** (`pl_bug_triage`) that works the backlog autonomously: each
scheduled fire pulls ONE issue matching configured predicates (title fragment / label /
issue type, default `bug`) from the workspace's issue tracker board, marks it in-progress
with a "taken by cat-factory" comment, investigates across every involved service's repo,
asks a human for clarification when the report is unclear (parking the run, echoing the
questions onto the tracker issue), writes a failing reproduction test (allowed to concede
without failing the run), fixes the bug, and drives the fix through the standard
review → ephemeral-env test → conflicts → CI → merge tail. On merge the existing tracker
writeback closes the issue.

Full design (the source of truth — do not re-derive):
[`backend/docs/bug-triage-pipeline.md`](../../backend/docs/bug-triage-pipeline.md).

Multi-repo investigation/fixing is **not designed here**: this initiative _executes_
Phases 3–4 of [`backend/docs/service-connections.md`](../../backend/docs/service-connections.md)
(tracked in [`service-connections.md`](./service-connections.md) — keep BOTH trackers'
rows in sync when those phases land).

**Update (2026-07-03):** service-connections Phase 3 (= Phase B below) has landed in
[PR #752](https://github.com/kibertoad/cat-factory/pull/752) — `resolveRepoTargets`,
`peerRepos` sibling checkouts, per-repo PR fan-out, `peerPullRequests`, the multi-repo
prompt section, and both-runtime conformance are all implemented there. The PR is **open
and unmerged** (`mergeable_state: dirty` — conflicts with `main`), so Phase B stays
`in-progress` below until it merges; Phases E–H (which build on `peerRepos`/multi-repo
checkouts, notably Phase F's investigator) are blocked on that merge, not just on the
code existing. See the Phase B row notes for details.

## Target pattern

Reference implementations to copy, per piece:

- **Recurring pipeline + non-LLM step**: `pl_tech_debt` (`kernel/src/domain/seed.ts`) and
  the `tracker` filing step (`RunDispatcher.runTracker`, `step-handler-registry.ts`) —
  `bug-intake` is its inbound dual.
- **Registered structured container kinds**: the `security-auditor` worked example
  (`backend/internal/example-custom-agent/src/index.ts`) — `container-explore` +
  `structuredOutput` + post-completion resolver + `generic-structured` result view.
- **Clarification park loop**: `clarity-review` (`IterativeReviewService`,
  `ReviewGateController.ts`) with the requirements-review auto-pass pattern.
- **Vendor tracker plumbing**: the `tasks` module providers
  (`integrations/src/modules/tasks/{JiraProvider,GitHubIssuesProvider,LinearTaskProvider}.ts`)
  for search/import, and `IssueWritebackService` for comment/transition.

## Phase checklist

Each phase ≈ one PR. Update the status column (+ PR link) at the end of every PR.

### Phase 0 — design doc + tracker

| Item                                                | Status |
| --------------------------------------------------- | ------ |
| `backend/docs/bug-triage-pipeline.md` (full design) | done   |
| This tracker                                        | done   |

### Phase A — pipeline `availability` attribute (design §2)

| Item                                                                                        | Status |
| ------------------------------------------------------------------------------------------- | ------ |
| Contracts: `availability?: 'one-off'\|'recurring'\|'both'` on `pipelineSchema`              | todo   |
| `ExecutionService.start` `origin` option + `assertRunnable` enforcement                     | todo   |
| `RecurringPipelineService.create/update` reject `'one-off'`-only pipelines                  | todo   |
| `validatePipelineShape`: field validation + `bug-intake` requires `recurring`               | todo   |
| SPA pickers: `AddTaskModal.vue` / `RecurringPipelineModal.vue` filters + i18n (all locales) | todo   |

### Phase B — multi-repo coding (= service-connections Phase 3; update that tracker too)

| Item                                                                                                     | Status                |
| -------------------------------------------------------------------------------------------------------- | --------------------- |
| `resolveRepoTargets` (plural) beside the singular resolver; dedupe by repo; monorepo `serviceDirectory`s | in-progress (PR #752) |
| `AgentJob.peerRepos` + sibling-checkout workspace layout in the harness (image bump)                     | in-progress (PR #752) |
| Push/PR fan-out: same `cat-factory/<blockId>` branch per repo, PR only for dirty repos                   | in-progress (PR #752) |
| `AgentRunResult.peerPullRequests` + `block.peerPullRequests` + `allPullRequests(block)` helper           | in-progress (PR #752) |
| Multi-repo prompt section (peer roles from connection descriptions) + `AGENTS.md` note                   | in-progress (PR #752) |
| Conformance: two-repo coding run records both PRs on both runtimes                                       | in-progress (PR #752) |

All six items are implemented in [PR #752](https://github.com/kibertoad/cat-factory/pull/752)
(`resolveRepoTargets` in `backend/packages/server/src/agents/resolveRepoTarget.ts`,
`renderMultiRepoWorkspaceSection` in `jobBody.ts` for the prompt section,
`MULTI_REPO_GUIDANCE` in the harness `pi.ts` for the "AGENTS.md note", `peerPullRequests`
mirrored D1 ⇄ Drizzle via `0037_peer_pull_requests.sql`). Flip these to `done` once the PR
merges — don't mark done off code sitting on an open branch. Two things to recheck at
merge time: the harness image was actually bumped to **`1.34.5`**, not the `1.34.4` the PR
description states — verify the real pin in `deploy/backend/package.json` /
`wrangler.toml` / `runtimes/local/src/harnessImage.ts` rather than trusting the
description text; and the PR's own conformance case only asserts the _recording_ path
(`peerPullRequests` round-trips through the fake executor), not a real harness dispatch
through `runMultiRepoCoding` — that path is covered only by
`executor-harness/test/agent.test.ts` + `resolveRepoTarget.spec.ts`, not conformance.

### Phase C — multi-PR gates + merger (= service-connections Phase 4; update that tracker too)

| Item                                                                                                   | Status |
| ------------------------------------------------------------------------------------------------------ | ------ |
| CI gate aggregates across PRs (`step.gate.headShas` map); fixer runs in the sibling-checkout container | todo   |
| Conflicts gate per PR; single-repo conflict-resolver dispatched at the first conflicted repo           | todo   |
| Merger: combined-diff assessment + all-green-then-merge-all in provider-first order                    | todo   |
| Mid-sequence merge failure → block `blocked` + notification enumerating merged vs unmerged             | todo   |
| Conformance: multi-PR gate + merge-all behaviour on both runtimes                                      | todo   |

### Phase D — issue-intake foundations (design §3, ports + persistence)

| Item                                                                                                        | Status |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| `TaskSourceProvider.searchIssues` + `IssueIntakeQuery`; Jira JQL / GitHub qualifiers / Linear filter impls  | todo   |
| `PipelineSchedule.issueIntake` config: contracts + `pipeline_schedules` column, D1 ⇄ Drizzle migrations     | todo   |
| `IssueWritebackProvider.onIssuePickedUp` (comment + in-progress transition, 3 vendors, best-effort)         | todo   |
| Jira `pickTransitionByCategory` / Linear `pickStartedStateId` / GitHub `inProgressLabel` logic + unit tests | todo   |
| `TaskLinkService.replaceForBlock` (unlink previous fire's issue, link the new one)                          | todo   |

### Phase E — `bug-intake` step (design §3, engine + SPA)

| Item                                                                                          | Status |
| --------------------------------------------------------------------------------------------- | ------ |
| Step handler: predicate search + batched projection dedupe + oldest-first pick                | todo   |
| Pickup: import → replace-link → rewrite block title/description → `onIssuePickedUp`           | todo   |
| No-match: skip all remaining steps, run completes successfully, no notification               | todo   |
| Schedule validation: `issueIntake` required + source connected when pipeline has `bug-intake` | todo   |
| SPA: intake config section in `RecurringPipelineModal.vue` + i18n (all locales)               | todo   |
| Conformance: intake pickup + no-match no-op on both runtimes (fake task source)               | todo   |

### Phase F — investigation + clarification (design §4–5)

**Blocked on Phase B merging** (needs `peerRepos`/`resolveRepoTargets`), and note
PR #752's fan-out is currently gated to `IMPLEMENTER_AGENT_KIND` (`'coder'`) only
(`ContainerAgentExecutor`) — this phase must extend that gate to include
`bug-investigator`, not assume `peerRepos` is already wired for every container kind.

| Item                                                                                                     | Status |
| -------------------------------------------------------------------------------------------------------- | ------ |
| `bug-investigator` → structured `container-explore` kind (same id) + valibot schema + peerRepos checkout | todo   |
| Post-completion resolver: prose digest → `step.output`, structured → `step.custom`                       | todo   |
| `clarity-review` seeding from investigator `questions` + auto-pass on `clarity === 'clear'`              | todo   |
| `IssueWritebackProvider.postQuestions` tracker comment on park (best-effort)                             | todo   |
| Conformance: clear → no park; needs_clarification → park + resume on answer                              | todo   |

### Phase G — `repro-test` agent (design §7–8)

Same caveat as Phase F: `repro-test` is a `container-coding` kind that will want the
same sibling-checkout treatment as `coder` when a bug spans multiple services, so it
also needs adding to the (currently `coder`-only) multi-repo fan-out gate from Phase B.

| Item                                                                                       | Status |
| ------------------------------------------------------------------------------------------ | ------ |
| `repro-test` registered kind (`container-coding`, work branch) + structured outcome schema | todo   |
| Concede resolver: `not_reproducible` recorded, run advances (never fails)                  | todo   |
| `BUG_FIX_GUIDANCE` coder prompt fragment (applied when a prior `repro-test` output exists) | todo   |
| Conformance: reproduced and conceded paths both reach the coder on both runtimes           | todo   |

### Phase H — the pipeline itself + end-to-end (design §1, §6, §9–10)

| Item                                                                                                    | Status |
| ------------------------------------------------------------------------------------------------------- | ------ |
| `pl_bug_triage` seed (`availability: 'recurring'`) + `BUG_TRIAGE_PIPELINE_ID` + `'bug-triage'` template | todo   |
| `task-estimator` placement + gating validation over the new shape (`pipelineShape.ts`)                  | todo   |
| End-to-end conformance: schedule fire → intake → investigate → clarity → repro → fix → merge (fakes)    | todo   |
| e2e spec (live pushed UI updates for the recurring run; `data-testid`s as needed)                       | todo   |
| Docs: glossary entries (`bug-intake`, `repro-test`), CLAUDE.md flow note if warranted                   | todo   |

## Conventions & gotchas carried between iterations

- **Decisions already made — do not re-litigate**: `availability` is a tri-state enum on
  the pipeline definition (not a label convention); intake config is **schedule-scoped**
  (not per-frame, not per-pipeline); clarification reuses `clarity-review` (no new gate
  archetype); a `repro-test` concession NEVER fails the run; no-match is a silent no-op
  success; clarification answers are in-app only (the tracker comment is an echo);
  full multi-repo (service-connections Phases 3–4) is in scope, per-user decision.
- **Runtime symmetry is per-PR**: every new column/behaviour lands D1 ⇄ Drizzle with a
  conformance assertion in the SAME PR. `pipeline_schedules` changes need a fresh D1
  migration and a `pnpm db:generate` Drizzle migration.
- **No N+1**: the intake dedupe against the `tasks` projection is one batched read;
  predicates are pushed into the vendor query (JQL / search qualifiers / GraphQL filter),
  never fetch-all-then-filter.
- **Harness changes live in Phase B only** (sibling checkouts): bump
  `@cat-factory/executor-harness` + the three pinned image tags per the CLAUDE.md rules.
  Every other phase is backend TypeScript + registered kinds — zero harness edits.
- **A parked clarification intentionally blocks subsequent fires** (the recurring
  no-overlap rule): one bug in flight per schedule. Don't "fix" this.
- **Writeback is best-effort everywhere** — a tracker outage must never fail a run.
- **Recurring runs are system-initiated**: no individual-usage (personal-subscription)
  models — already enforced by `RecurringPipelineService.fire`; don't duplicate the check.
- Changeset per PR (empty for docs-only); SPA strings through i18n with all locales in
  the same PR (the locale-parity CI gate).
- Two branches adding Drizzle migrations merge into "Non-commutative migrations": re-root
  with `node scripts/rebase-migration-snapshot.mjs <later-folder>` (see CLAUDE.md).
- **Phase B's multi-repo fan-out (PR #752) is gated to the `coder` kind only** — dropping
  `serviceDirectory` scoping and building `peerRepos`/the multi-repo prompt section fires
  only for `IMPLEMENTER_AGENT_KIND`. Phases F and G (`bug-investigator`,
  `repro-test`) are container kinds that also want sibling checkouts for a
  multi-service bug, so each must widen that gate rather than assume `peerRepos` is
  already wired for every kind — check `ContainerAgentExecutor` when Phase F/G start.
- **The harness's multi-repo path (`runMultiRepoCoding`) is deliberately simpler than the
  single-repo `runCodingAgent`** (per PR #752 / service-connections.md's carried-forward
  notes): no mid-run checkpoints, no warm pool, no follow-up streaming. `bug-investigator`
  and `repro-test` will run through this same simpler path once multi-repo, not the
  richer single-repo one — don't design Phase F/G around checkpoint/streaming behaviour
  that only exists on the single-repo side.
- Phase 4 of service-connections (= Phase C here) must also extend the gate-helper agents
  (`ci-fixer`, `conflict-resolver`) to emit `peerRepos` — PR #752 only wired the `coder`
  path; the `ci`/`conflicts` gates' helper dispatch (`onPr`) doesn't yet know about peers.
