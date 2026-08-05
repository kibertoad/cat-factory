# Initiative: PR verification report

**Status:** phases 1 + 2 landed; slices 11 + 12 open · **Owner:** core · **Started:** 2026-07-26

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the
> next slice; update the checklist at the end of each PR.

The report itself ships: every slice that produces it has landed. What keeps this tracker alive
rather than converted to an ADR is slice 11 (peer-PR reports) and slice 12, which cannot start
until global-search slice 4 lands elsewhere. Convert once both close.

## Goal & rationale

The PR an agent run opens carries whatever body the coder agent happened to write. The
platform already **produces** strong verification signals, but none of them land on the PR,
which is exactly where human reviewers and downstream tooling look:

- the `ci` gate aggregates real check runs (`CiStatusProvider`) and tracks `ci-fixer` attempts
  on `step.gate`;
- the tester gate (`tester-api` / `tester-ui`) produces a structured `TestReport`;
- the `deployer` step owns the ephemeral-environment lifecycle (per-frame spin-up outcomes on
  `step.deployEnvs`, the live projection on `step.environment`);
- the `merger` returns its complexity/risk/impact assessment, and the engine's `MergeResolver`
  turns it into a `MergeDecision`;
- telemetry (`llm_call_metrics`, `agent_context_snapshots`) records what every step did,
  surfaced in the observability panel;
- run metadata (linked tracker issue refs, repo, pipeline, per-step agent kinds and models)
  lives on the `ExecutionInstance` + the task projection.

A reviewer sees none of it and has to take the agent's own prose ("tests pass") on faith.

**End state:** the ENGINE, not the agent, maintains a verification report on the run's PR:
captured facts, not assertions. Human-readable markdown PLUS a fenced machine-readable JSON
block validated by a contracts schema, updated **idempotently in place** on every re-run and
retry.

## Decisions (the two the task asked to weigh, with rationale)

### D1: Form: a managed section of the **PR body**, not a maintained comment

Chosen: the PR/MR **description**, delimited by HTML-comment markers
(`<!-- cat-factory:verification-report:start -->` … `:end`), spliced in place.

|                  | PR body (chosen)                                                                                                                                                                   | Maintained comment                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotency      | **Structural**: the markers ARE the identity. No persisted state, so a lost/replaced run row, a retry, or a second deployment writing the same PR still updates in place.          | Needs the comment id persisted on the run (or a list-and-match scan), and a lost id silently duplicates: exactly the failure mode the acceptance criteria forbid. |
| Port surface     | One new READ (`getPullRequestBody`); the WRITE (`updatePullRequest`) already exists on the kernel `GitHubClient` / `VcsClient` ports and is implemented for GitHub **and** GitLab. | Needs a NEW `updateComment` write (absent from both ports) plus author identity to find "our" comment, which differs per provider.                                |
| Reviewer surface | First thing shown, above the diff; GitLab MR descriptions behave identically.                                                                                                      | Buried in a conversation that grows with every fixer round.                                                                                                       |
| Failure mode     | A provider that can't read the body ⇒ no report (loud pass-through), never a corrupted body: the splice is a pure function over the read body.                                     | Duplicate reports on every retry.                                                                                                                                 |

The splice is a pure function (`spliceManagedSection`) in kernel: absent markers ⇒ append the
section after the existing prose; present ⇒ replace exactly the marked region. The agent's own
body above the markers is never touched.

### D2: Shape: an **engine hook** on step settlement, not a one-shot pipeline step

Chosen: the report is (re)composed and published whenever a step SETTLES, funnelled through
one call in `RunDispatcher.recordStepResult`.

Why not a one-shot `pr-report` step (the `tracker`/`deployer` archetype):

- It would have to be **inserted into all 15 built-in pipelines**, and would silently not
  exist for any deployment-authored pipeline, so most runs would carry no report.
- Its position is unsatisfiable: placed **before** the `merger` it misses the merge
  assessment; placed **after** it, the merge has already happened, and the `merge_review`
  notification a human acts on was raised against a PR with no report.
- A run that **fails or parks part-way** (the runs most worth inspecting) would never reach
  it, so the PR would carry nothing.

The hook has none of those problems and is pipeline-shape agnostic. Its position inside
`recordStepResult` is load-bearing and documented at the call site:

- **after** `applyTerminalStepResolver`, so the `merger` step's publish already carries the
  `MergeDecision` the resolver just recorded (scores + auto-merge/awaiting-review outcome);
- **before** `finalizeBlock`, so the `pipeline_complete` notification raised for a
  merger-less pipeline is raised against a PR that already carries the finished report.

A **passing gate finishes through `recordStepResult`** too (`evaluateGate`'s `pass` branch
calls it with the gate's `passOutput`), so the CI gate's verdict lands with no extra hook.

Cost control: `PrVerificationReportController` hashes the rendered section and skips the
remote write when nothing changed, so a 12-step run does not make 12 PR edits.

## Target pattern

The reference implementation is the merge/mergeability provider shape: a kernel port, a
`@cat-factory/server` GitHub-client-backed impl, wired per facade off `engineVcsClient`:

1. **Contracts**: `@cat-factory/contracts` `src/pr-report.ts`: `prVerificationReportSchema`
   (+ `parsePrVerificationReport`). Every section carries an explicit
   `status: 'reported' | 'absent'` with a `note`, so _"no tester step in this pipeline"_ is
   stated rather than silently missing.
2. **Kernel**: `domain/pr-report.ts` (the markers + the pure `spliceManagedSection`) and
   `ports/pr-report.ts` (`PrVerificationReportPublisher`). Provider-neutral: the port takes
   `(workspaceId, blockId, section)` exactly like `PullRequestMerger` / `CiStatusProvider`,
   so the impl owns the repo/PR resolution.
3. **Orchestration**: `prReport.logic.ts` (PURE: compose from the already-loaded
   `ExecutionInstance` + `Block` + linked issues; render markdown + the JSON fence) and
   `PrVerificationReportController.ts` (the engine collaborator: load, compose, render, hash,
   publish). Reads: one `blockRepository.get` and one `taskRepository.listByBlock`, no N+1
   (everything else is already in memory on the instance).
4. **Server**: `github/GitHubPrReportPublisher.ts`: `getPullRequestBody` → splice →
   `updatePullRequest`, through the injected `GitHubClient` (i.e. `engineVcsClient`, so GitLab
   deployments publish too).
5. **Facades**: wired in the Worker's `selectGitHubDeps` and Node's
   `container-github-deps.ts`, beside `pullRequestMerger` / `branchUpdater`. Absent ⇒
   `CoreDependencies.prVerificationReportPublisher` is undefined and the controller is a
   no-op, so existing engine tests and no-GitHub deployments are untouched.
6. **Conformance**: `suites/execution-pr-report.ts` drives a real run on BOTH facades
   through a fake publisher and asserts the composed report (sections present, absent sections
   named, JSON parses against the schema, a retry updates in place).

## Conventions & gotchas carried between iterations

- **The publisher never throws into the run.** A PR-report write is bookkeeping; a provider
  outage must not fail a run that otherwise succeeded. The controller swallows and logs.
- **Never `updatePullRequest` with a body you did not just read.** The splice must be computed
  from the CURRENT remote body or a concurrent human edit is clobbered.
- **`getPullRequestBody` is a REQUIRED port method, not optional.** Both `FetchGitHubClient`
  and `FetchGitLabClient` implement it, `vcsBackedGitHubClient` bridges it, and
  `ProviderRoutingGitHubClient` routes it: otherwise a GitLab deployment silently loses the
  feature (the "provider-neutral" rule in CLAUDE.md).
- **File-size ratchets are split triggers.** `ExecutionService.ts` had 3 lines of headroom
  under its 2650 allowance, so this PR split the ~360-line `ExecutionServiceDependencies`
  declaration block into its own module (re-exported, so no call site changed) and ratcheted
  the allowance DOWN. Do NOT raise a budget to fit the next slice.
- **The observability deep link needs a consumer.** The link the report emits
  (`?ws=…&block=…&run=…&view=observability`) is only real because this PR also landed the
  minimal boot-time replay in the SPA. That is a down-payment on slice 4 of
  [`global-search-and-deep-links.md`](./global-search-and-deep-links.md), when that
  initiative lands the general parser, DELETE the narrow one rather than keeping both.
- **A PR body is a PARSED, PUBLIC surface, never interpolate untrusted text bare.** Everything
  the report shows is agent- or human-authored, and the host acts on what it finds: `#123` /
  `@name` / `!123` auto-link (a mention notifies a real person), a **closing keyword in front of
  an issue reference closes that issue when the PR merges**, a raw newline ends a table row, and
  an unbalanced code fence swallows the JSON block that is the machine-readable contract. Every
  interpolation therefore goes through kernel's `hostMarkdown` boundary (`cell` / `inline` /
  `prose`), shared with the tracker-issue writebacks.
  Two traps found the hard way: the escapes must run in ONE regex pass (each emits a `#`, so a
  chained `.replace()` re-escapes the previous one's output; `@` → `&#64;` → `&&#35;64;`), and
  they must skip inline code spans (the host does not auto-link there, so escaping only shows the
  reader a literal `&#35;`).
- **Free text is scrubbed with `redactSecrets` at COMPOSE time.** Same helper the telemetry store
  uses; a PR body is the MORE exposed surface of the two. Compose-time (not over the rendered
  markdown) so the prose and the JSON block can never disagree about what was redacted.
- **Bound every list, and SAY what was dropped.** Per-list caps feed the report's `truncations`
  log rather than silently shortening: a capped list that doesn't admit it is the same false
  reassurance as a silently missing section. The rendered section also has a hard character
  budget: over it, the JSON block goes (with a note), because a body the host rejects means NO
  report at all, silently and forever.
- **State the repo/provider the PUBLISHER resolved, not `diagnostics.lastDispatch`.** Diagnostics
  record the most recent dispatch: on a multi-repo task that is a PEER repo, not the repo whose
  PR is being written to. `resolveTarget` on the port answers the same question the write uses.
- **Wire the logger.** This is the one engine path designed to swallow its failures, so an
  unwired logger means a revoked token or a rejected body leaves no trace anywhere and the report
  just stops appearing.
- **The environment lifecycle's LAST leg happens after the run does.** An environment is reclaimed
  by the TTL sweep (or by a human on the human-test gate), routinely long after the final step
  settled, so the settlement hook structurally cannot observe it: before slice 13 the report said
  "still live" forever about environments the platform had destroyed on schedule. The teardown
  service therefore carries a best-effort hook fired from the ONE place that records a teardown
  attempt, late-bound in the composition root to `ExecutionService.refreshVerificationReport`. It
  fires on a FAILED attempt as much as a successful one: with no settlement left, an environment
  the provider refuses to reclaim would otherwise sit on the PR as one nobody has got to yet
  rather than as the thing an operator has to go and do. Any future leg that completes outside a
  run needs the same treatment; a memo on the compose path would defeat it.
- **The step's environment PROJECTION is not a teardown signal.** It is written by the run's own
  polls and never refreshed once the run settles, so it keeps a stale `ready` forever. The
  provisioning event log is what dates the lifecycle, and `confirmed` requires POSITIVE evidence
  from the log or from projections that all show gone: "nothing looks live" is also true of a run
  that projected nothing at all.
- **The teardown verdict is decided by environment IDENTITY, never by a tally.** Comparing a count
  of teardown rows against a count of ready frames reads as correct until a run REPLACES an
  environment mid-flight (the provisioning service supersedes a frame's prior environment under
  the same run), at which point the superseded one's teardown balances the books while its
  replacement is still standing. So the log's `targetId`s are followed individually, `confirmed`
  means every id the run stood up was reclaimed, and the verdict is latest-attempt-wins per id so
  a retried sweep neither reports one wedged environment as many nor a recovered one as stuck.
  Rows carrying no `targetId` (a provision that failed before a record existed, a stack recipe's
  per-STEP rows) inform the failure count and never the identity sets.
- **An empty timeline has four causes and they are not interchangeable** (`PrReportTimelineGap`):
  no log wired, a read that FAILED, a read too large to be complete, and a run that stood nothing
  up. Only the first is a statement about how the deployment is configured, so reporting a timed-out
  query as "this deployment retains no provisioning event log" is a fabricated fact about somebody's
  setup. The truncation member exists because the identity accounting above needs a WHOLE history:
  rows arrive newest first, so an environment whose bring-up fell off the end reads as one that
  never existed and therefore never needed reclaiming, which is a confident wrong answer where
  "too long to date" is an honest one.
- **Attribution is a separate axis from capture.** A tester's screenshots are reported whatever it
  ran against, because they exist and a reviewer should reach them; whether they are EVIDENCE about
  the ephemeral environment rides the section's status, which keeps `local` (it ran somewhere else)
  apart from `undeclared` (it did not say). Guessing either way turns an unknown into a claim in
  the one section whose whole job is provenance.

- **`ci` verdict detail is on the gate step, not the provider.** Read `step.gate.lastVerdict` /
  `failingChecks` / `attempts` / `attemptLog`; do NOT re-probe the `CiStatusProvider` when
  composing (a re-probe costs a round trip and can disagree with what the gate acted on).

## Prioritized checklist

| #   | Slice                                                                                                                                                                                                    | Status  | PR   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---- |
| 1   | Contracts schema (`pr-report.ts`) + `parsePrVerificationReport`                                                                                                                                          | 🟩 done | this |
| 2   | Kernel: markers + pure `spliceManagedSection`, `PrVerificationReportPublisher` port                                                                                                                      | 🟩 done | this |
| 3   | `getPullRequestBody` on the `GitHubClient` + `VcsClient` ports, all 5 implementors                                                                                                                       | 🟩 done | this |
| 4   | Orchestration: pure compose/render logic + `PrVerificationReportController` + the `recordStepResult` hook                                                                                                | 🟩 done | this |
| 5   | `GitHubPrReportPublisher` + both-facade wiring (Worker ⇄ Node/local)                                                                                                                                     | 🟩 done | this |
| 6   | Conformance suite `execution-pr-report.ts` (both runtimes, fake publisher)                                                                                                                               | 🟩 done | this |
| 7   | SPA: minimal `?run=…&view=observability` deep-link replay so the emitted link resolves                                                                                                                   | 🟩 done | this |
| 8   | Docs sweep: root README capability row, package READMEs/AGENTS.md, CLAUDE.md flow note                                                                                                                   | 🟩 done | this |
| 8a  | Review hardening: text boundary (auto-link/table/fence), `redactSecrets` scrub, list caps + `truncations`                                                                                                | 🟩 done | this |
| 8b  | Per-workspace `publishPrVerificationReport` opt-out (contracts + D1 ⇄ Drizzle + SPA + 10 locales + conformance)                                                                                          | 🟩 done | this |
| 9   | **Phase 2**; harness-captured raw command output (test/build/lint logs captured by the executor-harness rather than summarized by the agent)                                                             | 🟩 done | this |
| 10  | **Phase 2**; bugfix reproduction proof: the failing-then-passing test demonstrated across the fix; tracked in [`bugfix-reproduction-proof.md`](../../backend/docs/adr/0033-bugfix-reproduction-proof.md) | 🟩 done | this |
| 11  | **Phase 2 follow-up**; per-repo report on a multi-repo task's PEER PRs (phase 1 reports on the own-service PR only)                                                                                      | ⬜ todo |      |
| 12  | **Phase 2 follow-up**; retire the narrow deep-link replay once global-search slice 4 lands                                                                                                               | ⬜ todo |      |
| 13  | **Phase 2**; test environment lifecycle PROOF: dated up/down timeline from the provisioning log, tester-evidence attribution + links, computed verdict, teardown republish                               | 🟩 done | this |
| 14  | **Phase 2**; machine reachability: the report names the run's auditable TRAJECTORY and serves itself live over `/api/v1`                                                                                 | 🟩 done | this |

### Phase-2 notes (slices 9 + 10, as landed)

- **Slice 9 needed NO harness change and no image bump**, contrary to what this note said while
  it was a plan. The harness has captured each check's exit code and a scrubbed output tail on
  `step.validation` since pre-PR validation shipped; what was missing was purely the RENDERING.
  The remaining harness ritual (bump the version + the three pinned tags, or
  `pnpm sync:image-tags`) applies the next time the image's `src/**` actually changes.
- **The output budget is the report's, not the producer's.** The harness already trims each tail
  to what a REPAIR PROMPT needs, and a pull-request body is a far tighter budget than a model's
  context window, so the report re-bounds every log to `PR_REPORT_MAX_OUTPUT_CHARS` (2k) at
  compose time, from the END (a failure is reported at the tail; a prefix cut discards exactly the
  half a reviewer opened the report for) and records the cut in `truncations`.
- **A PASSING validation command's log is deliberately dropped, and the section says so.** Ten
  green logs would cost the budget that makes the failing one readable, and an unexplained `null`
  tail would read as "the command printed nothing". The rendered section states the rule in as
  many words: that is the difference between a stated policy and a silent omission.
- **Captured output needs a SIZED fence, not a ``` fence.** Test runners and linters legitimately
  print backticks, and a fixed three-tick fence closes on the first such run and spills the rest of
  the log — plus every section below it, including the machine-readable JSON block — into the body
  as prose. Kernel gained `hostMarkdown.outputBlock` (fence one tick longer than the longest run in
  the body) and `hostMarkdown.boundOutput`; the harness's own `fencedOutput` is the same rule at
  its own boundary, and the two are deliberately independent copies because the image can depend on
  no workspace package.
- Slice 10 landed through its own initiative,
  [`bugfix-reproduction-proof.md`](../../backend/docs/adr/0033-bugfix-reproduction-proof.md) (the proof is a harness phase,
  not a step; symmetric worktrees defend against a false "reproduced"; the declaration seam stays
  `repro-test` rather than making the coder structured). Read that tracker before touching the
  reproduction section: its Phase-B notes hold the renderer's non-obvious obligations, above all
  that an ABSENT `final` run is normal for an inconclusive verdict and that the producer's own
  `note` is rendered VERBATIM rather than re-derived from `base.passed`.

### Machine reachability (slice 14)

The report told a reader what happened and, for a person, where to browse it (`runUrl`, the app's
observability panel). It named nothing a MACHINE could follow, so a consumer holding the report had
to already know the debug API exists (and how to address a run on it) to reach the record behind
any claim in it. `observability` now carries two more links, both built from `apiBaseUrl` (the
BACKEND url, like the artifact byte links, never the SPA one beside it):

- **`trajectoryUrl`** → `/api/v1/debug/runs/:runId/tool-calls?order=trajectory`: what the run's
  agents actually did, in the order they did it. This is the link that makes the report auditable
  rather than merely informative: every other section is a verdict somebody produced, and this is
  the record those verdicts are about.
- **`reportUrl`** → `/api/v1/runs/:runId/report`: this same report, served live. The fenced block in
  the PR body is a snapshot from the last publish; a consumer that wants the current one (or that is
  looking at a run whose PR body it does not have) fetches it.

Three things about it are deliberate:

- **Both are rendered in the PROSE as well as carried in the JSON.** A trajectory nobody can find is
  not an audit trail, and the reader who wants to check a claim is often a person.
- **Both endpoints stay key-authenticated**, so a report on a public repository names them without
  making anything public; a reader without a credential gets a 401, the same honest outcome the app
  deep link already produces.
- **The read endpoint behind `reportUrl` composes from the same code**
  (`PrVerificationReportController.composeForRun`), so the live JSON and the PR body cannot state
  different facts about one run. It is also why the report shape is now part of the STABLE public
  surface: see [`public-api-additions.md`](./public-api-additions.md) (E1).

### Evidence reachability (landed with slices 9 + 10)

The environment-evidence rows used to carry an opaque artifact id and nothing else, so reaching a
captured screenshot meant knowing the app well enough to find the run. Each row now carries a
DIRECT link to the artifact's bytes on the deployment's own authenticated blob endpoint
(`GET /workspaces/:ws/artifacts/:id/blob`), built from a new `apiBaseUrl` core dependency
(`PUBLIC_URL` on Node/local, `WORKER_PUBLIC_URL` on the Worker).

Three things about it are deliberate:

- **It is a separate config from `appBaseUrl`.** The two coincide on a same-origin deployment and
  diverge the moment the SPA is served from its own host, and a link built from the wrong one is
  worse than no link. They also answer different questions: the app deep link beside it opens a
  panel a human BROWSES, this one returns bytes to anything holding a credential.
- **The id stays beside the link**, and an unconfigured `apiBaseUrl` yields the id with no link
  rather than a link to nowhere. The id is what an operator greps the store for.
- **The endpoint stays authenticated.** The report may land on a public repository, so the bytes
  are not made reachable by an unguessable URL: a reader without workspace access gets a 401, which
  is the honest outcome and the same one the app deep link already produces.
