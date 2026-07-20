# PR-review run: token-usage investigation and two parking-flow fixes (2026-07)

This document collects three related findings from investigating one local PR-review run,
plus a fix plan for the two defects it surfaced.

> **Status:** the concrete fixes below have since landed — the parked PR-review approve routing
> (§2), the container `spend.record` model threading + fresh-vs-cached token surfacing (§1's two
> data-quality gaps), and 3-day session-transcript retention (§3). The turn-count reduction floated
> in §1 ("hand the pr-reviewer the diff up front") is now implemented as Slice 1 of
> [`docs/initiatives/pr-review-turn-reduction.md`](./initiatives/pr-review-turn-reduction.md): a
> `pr-reviewer` preOp injects the PR diff as `.cat-context/pr-diff.md` so the agent skips the
> reconstruct-the-diff turns. The honest fresh-vs-cache token accounting it also motivated is
> tracked in [`docs/initiatives/token-telemetry-per-class-and-cost.md`](./initiatives/token-telemetry-per-class-and-cost.md).

The run under investigation:

- Execution `exec_e854665005384748b7dbb297`, pipeline `pl_review` ("Review a pull request"),
  a single `pr-reviewer` step.
- Task `task_5e6a56b72072471dac61e5d5` = "Review checkboxsurvey/Checkbox-Application#4558".
- Ran locally in a per-run container (`executionBackend: local-container`), model
  `anthropic:claude-opus-4-8`, on a Claude subscription credential.
- It produced a summary, 6 review slices over 28 files, and 18 findings (10 low, 8 medium;
  12 correctness, 2 security, 2 maintainability, 2 performance), then parked
  `waiting_decision` / `prReview.status = awaiting_selection`.

## 1. The "31 million tokens" is real usage but almost entirely cache reads

### What the telemetry actually says

Two different token numbers come from this one run, and they measure different things:

| Source                                  | Number                            | What it is                                                         |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `public.token_usage` (1 row)            | 557,325 (541,879 in + 15,446 out) | The single terminal `result.usage` the CLI emits at end of session |
| `telemetry.llm_call_metrics` (350 rows) | 31,100,498 `prompt_tokens`        | The sum of per-call input across every agentic turn                |

The 31M figure the run surfaced is `sum(prompt_tokens)` over 350 model calls. The breakdown:

- 350 calls = the main explore agent's 164 tool-call turns plus 5 sub-agents it spawned.
- `cached_prompt_tokens` summed to 31,099,813, so **99.998% of those 31M tokens were cache
  reads**. Fresh (uncached) input across all 350 calls was about 685 tokens. Zero calls errored.
- Per-call prompt size ramps from ~18K to ~210K tokens (avg ~88.9K, max 219,232) as the single
  agentic conversation grows and is re-sent each turn.

So the 31M is the classic long-agentic-loop shape: one Claude Code session re-sends its whole
growing transcript on every tool call, and the metric sums that per-turn input. The observability
code already documents this exact effect (`observability.logic.ts:56-70`: "a container agent
re-sends its WHOLE growing conversation on every model call").

The harness log confirms the shape: `mode: explore`, `toolCalls: 164`, 5 sub-agent transcripts,
agent phase 885s (clone 22.8s). The agent cloned the full base branch and reconstructed the PR
diff by hand (multiple `git diff` runs saved to scratch files, plus grep passes) rather than
being handed the diff.

### Are cached calls billed? Yes, and this changes the cost picture

Cache reads are not free. Anthropic prompt-cache pricing:

| Token class              | Multiplier vs base input | Opus 4.8 rate (base input $5/MTok) |
| ------------------------ | ------------------------ | ---------------------------------- |
| Fresh input              | 1x                       | $5.00 / MTok                       |
| Cache write (5-min TTL)  | 1.25x                    | $6.25 / MTok                       |
| Cache write (1-hour TTL) | 2x                       | $10.00 / MTok                      |
| Cache read               | ~0.1x                    | $0.50 / MTok                       |
| Output                   | n/a                      | $25.00 / MTok                      |

On the metered API, 31.1M cache-read tokens would cost roughly 31.1M x $0.50/MTok = about $15.50.
That is cheap per token (10% of input price) but not nothing.

This run used a Claude subscription credential (`billing = 'subscription'`, OAuth token, talks
direct to the vendor), so it was not billed per token in dollars. It consumed the plan's
rate-limit quota instead. That is why the row is tagged `subscription`, is excluded from the
metered spend rollups (`totalsSince*` filter `billing = 'metered'`), and carries a nominal
$0.084 estimate computed off the 557K figure rather than the 31M.

### Verdict on efficiency

Caching worked near-perfectly, so the run did not re-bill fresh tokens. The real cost lever is
**turn count**: 350 model calls / 164 tool calls / 5 sub-agents to review 28 files is a lot, and
each turn re-reads ~88K of cached context at 10% price plus drives the ~15 minutes of wall clock.

Where the turns went, and what would cut them:

- The `pr-reviewer` surface is `container-explore` with a full clone of the base branch
  (`backend/packages/agents/src/agents/kinds/pr-reviewer.ts`). The prompt tells the model to list
  files, group them into slices, and read each slice, but the model still rebuilds the diff itself
  from a bare checkout. Handing the agent the PR diff and changed-file list up front (the backend
  already has them via the GitHub integration) would remove a chunk of early exploration turns.
- Sub-agent fan-out (5 here) multiplies the re-sent-context effect. Worth checking whether the
  reviewer prompt encourages sub-agents where a direct read would do.
- `cacheHitRate` (`observability.logic.ts:46-54`) was effectively 100% here, so there is nothing to
  gain on caching itself.

### Two real data-quality gaps (not the headline, but worth fixing)

1. **`provider = "unknown"`, `model = ""` on the `token_usage` row.** The durable container-poll
   path drops the model: `toRunResult` documents "No model here"
   (`backend/packages/server/src/agents/containerAgentResult.ts:30-35`), the subscription-usage
   tagging in `ContainerAgentExecutor.pollJob` sets usage/billing/vendor but not model
   (`ContainerAgentExecutor.ts:962-967`), and `RunDispatcher` falls back to `'unknown'`
   (`RunDispatcher.ts:1274-1284`), which `SpendService.parseModel` splits into provider
   `"unknown"` / model `""` (`SpendService.ts:156-160`). The model is known at dispatch
   (`handle.model`) and is already used for `recordHarnessCalls`, so it just needs threading into
   the `spend.record` path.
2. **The 31M is a misleading thing to show a user as "tokens burned."** It sums cache-read-inclusive
   per-turn input. If we surface a headline token number, it should separate fresh vs cached (or
   show cache-adjusted cost) so a near-100%-cached run does not read as a 31M-token blowout.

Where the 31M is surfaced today: `RunStateMachine.attachStepMetrics` -> `summarizeByExecution`
(`RunStateMachine.ts:297-319`), `sum(prompt_tokens)` in `telemetry.ts:326-327`,
`buildLlmMetricsExport` (`observability.logic.ts:200-252`), `ExecutionController.ts:140-168`, and
frontend `StepMetricsBar.vue` / `ObservabilityPanel.vue`.

## 2. "Review & approve" does nothing on a parked pr-review step

### Symptom

For a `pr-reviewer` step parked `waiting_decision` / `awaiting_selection`, clicking
"Review & approve" (from the board or from run details) opens the generic prose step panel, offers
no findings to select, and never resolves the review.

### Root cause

A parked `pr-reviewer` step carries both `approval.status = 'pending'` and
`prReview.status = 'awaiting_selection'`. This is by design: the backend parks the step with the
same primitive fork-decision uses (`PrReviewController.recordFindings:117-129` ->
`parkStepOnDecision`), which creates the pending approval.

Every surface renders the **generic approval-gate "Review & approve" button** purely because
`approval.status === 'pending'`:

- Board: `TaskPipelineMini.vue:138-151`, `TaskCard.vue:176`, `BlockNode.vue:118`.
- Run details: `PipelineProgress.vue:620-633` -> `BlockFocusView.vue:57-58`.
- Inspector: `TaskExecution.vue:376-406` -> `openApprovalFor` (`:139-140`).

They all call `ui.openApprovalDetail` -> `dispatchStepView` (`stores/ui/resultViews.ts:52-96`).
`dispatchStepView` routes a step to its dedicated window by the step's agent-kind `resultView`:

```
const view = step?.consensus?.enabled ? 'consensus-session'
           : step ? agentKindMeta(step.agentKind).resultView : undefined
if (view && instance) { resultView.value = {...}; return }   // dedicated window
stepDetail.value = { instanceId, stepIndex }                 // else generic prose panel
```

`pr-reviewer` is absent from the frontend agent catalog (`utils/catalog.ts` has no entry in
`AGENT_ARCHETYPES` / `SYSTEM_AGENT_META` / `COMPANION_ARCHETYPES`), so `agentKindMeta('pr-reviewer')`
falls back to `FALLBACK_AGENT_META`, which has no `resultView` (`catalog.ts:626-650`), unless the
per-workspace backend manifest happens to inject one (`catalog.ts:331-339`). With no `resultView`,
`dispatchStepView` falls through to the generic `AgentStepDetail` panel, which has no findings UI
and whose approve action calls the wrong endpoint (`useStepApproval.approve()` ->
`execution.approveStep`, the generic gate), not `resolvePrReview`.

The findings-selection window `PrReviewWindow.vue` does work: findings are selectable under
`v-if="awaiting"` (`:232-239`) and `onResolve` calls `resolvePrReview` (`:280-314`,
`stores/prReview.ts:64-83`, `composables/api/prReview.ts:19-28`). But it is opened only by
`ui.openPrReview`, which is called from exactly one place: the `pr_review_ready` notification card
(`NotificationsInbox.vue:216`). It was never wired to the board, pipeline rail, or inspector.

Contrast the sibling fork-decision flow (the code says pr-review "mirrors" it): fork-decision has a
dedicated chip on every surface that calls `ui.openForkDecision` explicitly, ahead of the generic
approval button (`PipelineProgress.vue:577-608`, `TaskExecution.vue:386`). pr-review has no such
chip. Commit `a552283c9` (#1125) added the pr-review window and the notification entry point but did
not touch the board/pipeline/inspector surfaces or the catalog.

The correct backend resolution path is `POST /executions/:id/pr-review/resolve`
(`contracts/src/routes/prReview.ts:24-28` -> `server/.../PrReviewController.ts:29-39` ->
`orchestration/.../PrReviewController.resolve:145-219`), which requires
`agentKind === 'pr-reviewer' && state === 'waiting_decision' && approval.status === 'pending' &&
prReview.status === 'awaiting_selection'`. It is reachable only through `PrReviewWindow`.

### Fix plan

Route a parked pr-review step to `PrReviewWindow` reliably, and give it a proper affordance:

1. **Primary (surface-independent): special-case `dispatchStepView`.** Add a branch mirroring the
   existing `consensus` special-case so a step carrying `prReview` opens the `'pr-review'` view
   regardless of catalog/manifest state:

   ```
   const view = step?.consensus?.enabled ? 'consensus-session'
              : step?.prReview ? 'pr-review'
              : step ? agentKindMeta(step.agentKind).resultView : undefined
   ```

   This makes the existing "Review & approve" button open the working window on the board, the
   pipeline rail, and the inspector, since they all funnel through `openApprovalDetail`.

2. **Root-cause: add `pr-reviewer` to the frontend catalog** with `resultView: 'pr-review'`, so the
   kind is modelled and every code path that reads `agentKindMeta('pr-reviewer')` behaves, not just
   the special-case above.

3. **Consistency (optional but recommended): a dedicated pr-review chip** on the board card,
   pipeline rail, and inspector that calls `ui.openPrReview(instanceId, stepIndex)`, mirroring the
   fork-decision `forkPhase` chip, so the pr-review park has a purpose-built entry point rather than
   riding the generic approval button.

Items 1 and 2 together fix the reported bug; item 3 aligns the UX with fork-decision.

## 3. Session transcripts are deleted immediately; keep them for 3 days

### Symptom

Per-turn transcripts for a finished run are gone by the time anyone goes to debug it. During this
investigation the container's `/tmp/cf-claude-*` config dir (which held the main session and all 5
sub-agent JSONL transcripts) had already been removed, so the exact per-call detail was
unrecoverable and had to be reconstructed from `telemetry.llm_call_metrics`.

### Root cause

The claude-code subscription runner creates an isolated config home and deletes it in `finally`:

- `runClaudeCode`: `const configHome = ... mkdtemp(join(tmpdir(), 'cf-claude-'))`
  (`agent-runner.ts:320`), then `finally { rm(configHome, {recursive, force}) }`
  (`agent-runner.ts:402-405`). Claude Code writes session transcripts under
  `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/...` (including per-sub-agent JSONL), inside that dir.
- `runCodex` is symmetric: `codexHome = mkdtemp('cf-codex-')` (`:517`), `finally { rm(codexHome) }`
  (`:622-624`); Codex transcripts live under `$CODEX_HOME/sessions/`.

The teardown exists for a real reason (comment at `:403`): the config home also holds the leased
credential, and it must not be left on disk. So we cannot simply keep the whole dir around.

### Fix plan

Lift only the transcript subtree out before deleting the credential-bearing home, and prune on a
TTL. The credential lives at the config-home root; the transcripts live in a subdir (`projects/` for
claude-code, `sessions/` for codex), so moving just that subdir keeps the debugging artifact while
the existing `rm` still removes the credential.

1. **New module `transcript-retention.ts`** with `retainSessionTranscripts(home, subdirs, {label, log})`:
   - `rename` each present subdir out to `join(tmpdir(), 'cf-agent-transcripts', '<timestamp>-<home-suffix>')`
     (same filesystem as the home, so no cross-device copy).
   - Then sweep that retention root, `rm`-ing entries older than the TTL.
   - TTL default 3 days, overridable via env (e.g. `HARNESS_TRANSCRIPT_TTL_MS`); retention root
     overridable via env for operators. Best-effort throughout: a retention failure must never fail
     an otherwise-successful run.
2. **Call it from both `finally` blocks** before the `rm`: `retainSessionTranscripts(configHome,
['projects'], ...)` in `runClaudeCode`, `retainSessionTranscripts(codexHome, ['sessions'], ...)`
   in `runCodex`, then the existing `rm(home)`.
3. **Thread the per-job logger** so the retained path is logged with `jobId`: add `log?: Logger` to
   `SubscriptionRunOptions` and forward `opts.log` from `runAgentInWorkspace` (`pi-workspace.ts`).
   `RunOptions.log` already carries the job's correlation fields (`runner.ts:39,267`).
4. **Add a unit test** for the move-then-prune behavior, following the existing harness test style
   (`test/agent-runner.test.ts`).

Notes and scope:

- This is meaningful only where the container filesystem outlives the job: the local warm-pool
  container (which is reused across jobs, so a 3-day TTL is honored by the next run's sweep). A
  cloud container is torn down with the run, so retention is a no-op there in practice.
- The credential-safety property holds: only `projects/` / `sessions/` is retained; the config-home
  root (where the OAuth credential is cached) is still deleted. This must be called out in review.
- Transcripts can contain repo contents and any secret an agent happened to print. They stay
  local to the container and are pruned on the TTL, but reviewers should weigh that against the
  debugging benefit.

## Summary of proposed work (for the follow-up PRs)

1. Efficiency: thread the real model into the container `spend.record` path so `token_usage` stops
   recording `provider="unknown"` / `model=""`; separate fresh vs cached in whatever token number we
   surface to users; consider handing the pr-reviewer the diff + changed-file list up front to cut
   turn count.
2. Approve bug: special-case `dispatchStepView` for `prReview`, add `pr-reviewer` to the frontend
   catalog with `resultView: 'pr-review'`, and (optionally) add a dedicated pr-review chip mirroring
   fork-decision.
3. Transcript retention: add `transcript-retention.ts`, call it from both subscription runners
   before deleting the config home, thread the job logger, default the TTL to 3 days, and add a test.
