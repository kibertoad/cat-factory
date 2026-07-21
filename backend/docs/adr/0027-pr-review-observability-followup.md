# ADR 0027: PR-review observability, follow-up — D2.1 and D3 don't work for the parallel-subagent shape

- **Status:** Accepted — both confirmed defects fixed (see the **Landed** note under each fix)
- **Date:** 2026-07-21
- **Context layer:** backend (`@cat-factory/executor-harness`, `@cat-factory/agents`, `@cat-factory/orchestration`)
- **Relates to:** ADR 0026 (marks D2.1/D3/D4 "landed"), ADR 0023 (PR deep review)

## Context

ADR 0026 records D2.1 (live per-slice progress off the parent stream) and D3 (sum subagent token usage) as "Fully implemented — landed." A second `pr-reviewer` run against the same PR (`checkboxsurvey/Checkbox-Application#4558`, 518 files) shows neither works for the shape they were written for.

The run is `exec_1c129edbc1754247896a3755`, pipeline `pl_review`, executor image `1.50.10` (D2.1/D3/D4 all present, per the `@cat-factory/executor-harness` changelog for 1.50.8), backend `@cat-factory/server@0.140.5` + `@cat-factory/orchestration@0.131.5` (both carry the D3.1 heartbeat forwarding). I investigated it live in local mode (Docker executor, Postgres on 5433) and after it parked at `awaiting_selection`.

What the operator saw during the ~12-minute review matched the pre-ADR-0026 complaint almost exactly: the run heartbeats, so it's clearly not hung, but there is no slice breakdown, `progress` sits at 0, and `token_usage` shows a single row that undercounts the real spend. The two mechanisms that were supposed to close this are both defeated, for different reasons. This ADR records both with the evidence, and proposes fixes.

### What the run actually did

Healthy, and the same parallel shape ADR 0026 described. Timeline from the executor logs (`docker logs` on the job container):

- 18:51:15 dispatched; base-branch clone + PR head prefetch done by 18:51:47 (clone phase 16.7s).
- 18:51:47 → 19:03:35 the `claude -p` agent phase ran for 708.8s (~11.8 min), 100 tool calls. It grouped the diff and fanned the review out across parallel `Task` subagents whose descriptions were `Review identity/auth slice`, `Review security/ACL slice`, `Review contact services + repos slice`, `Review migration SQL slice` (plus smaller verification subagents). Four subagent transcripts of 272-514 KB.
- 19:03:35 `retained session transcripts` + `done (structured)`; 19:03:36 `job finished`.
- The run coerced to 5 slices + 11 findings + a summary and parked at `awaiting_selection`.

The slice/finding data is real and correct. The problem is purely observability, as in 0026.

## Defect A — subagent token usage is never counted: the watcher watches a directory that never exists

`token_usage` for the execution holds one row: 155,651 input / 9,135 output, `billing=subscription`. That is the parent agent's terminal `result` usage only. The four `Review … slice` subagents (272-514 KB of transcript each) contributed nothing, which is the exact failure D3 was written to fix.

### Root cause

`backend/internal/executor-harness/src/agent-runner.ts:454`:

```ts
const subagents = configHome
  ? startSubagentWatcher(join(configHome, 'subagents'), { ... })   // <configHome>/subagents
```

The watcher is pointed at `<configHome>/subagents`. The Claude CLI does not write there. It writes subagent transcripts under the per-session tree:

```
<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/*.jsonl
```

Recovered verbatim from the retained copy on the job container:

```
/tmp/cf-agent-transcripts/2026-07-21T19-03-35-820Z-cf-claude-YtWnwe/projects/-tmp-agent-explore-Z0Fhxx/aeb3854a-0ff9-42a2-8b82-b60615a3834e/subagents/agent-*.jsonl
```

and confirmed by `transcript-retention.ts:61`, which lifts the whole `projects` subtree out of the config home at job end. So `<configHome>/subagents` is never created. In `subagents.ts:229-232`, `readdir(dir)` throws `ENOENT` on every poll, the `catch { return }` swallows it, and the watcher lifts nothing. `subagents.usage()` returns `{0,0}`, so the merge at `agent-runner.ts:508-514` reduces to parent-only.

The INVARIANT comment at `agent-runner.ts:501-507` states plainly that the subagent tokens "live exclusively in the `subagents/*.jsonl` transcripts … which the watcher reads and nothing else does." That is exactly right about where they live, and the watcher is aimed one tree too shallow, so nothing reads them. The doc comments at `subagents.ts:25` and `agent-runner.ts:450` both assert the wrong `<configHome>/subagents` location. The wrong assumption about the CLI's on-disk layout is the whole bug.

The D3 heartbeat still advanced, but only incidentally: `onActivity` also fires on every parent-stdout chunk (`agent-runner.ts:184`), independent of the watcher. Liveness survived; token accounting did not.

### Fix

Point the watcher at the real location. The session UUID isn't known before the CLI creates it, so either:

- watch `<configHome>/projects` recursively and treat any `**/subagents/*.jsonl` as a subagent transcript, or
- resolve the project/session directory first — it's the same subtree `retainSessionTranscripts` already walks — and watch `<that>/subagents`.

Either way, add a harness test against a recorded transcript fixture laid out the way the CLI actually writes it. ADR 0026's own consequences section asked for exactly this fixture test ("covered by a harness test against a recorded transcript fixture"); it would have caught this.

**Landed.** Took the first option: `startSubagentWatcher` now takes the `projects` root and `findSubagentTranscripts` walks it, collecting any `*.jsonl` under a `subagents/` directory while EXCLUDING the sibling parent session transcript (so the parent's usage — already totalled by the `result` event — is never double-counted). `agent-runner.ts` watches `join(configHome, 'projects')`. `test/subagents.test.ts` lays the `projects/<encoded-cwd>/<session-uuid>/subagents/` tree out exactly as the CLI writes it and asserts the parent transcript is skipped; `test/agent-runner.test.ts`'s fake `claude` was writing to the old (never-created) `<configHome>/subagents` — it now writes to the real per-session path, so the suite exercises the fix instead of the bug.

## Defect B — no live slice progress: the todo-plan source and the D2.1 fallback cancel out

`progress` stayed 0 for the whole review and the deep-review window showed no slice breakdown until the findings landed. The end-to-end wiring is intact (verified `subtasks: view.progress` and `lastActivityAt: view.heartbeatAt` in the installed `server@0.140.5`, and `applySubtaskProgress` in the installed orchestration), so this is not a missing-code or version problem. Two design facts combine to produce zero live signal.

### 1. The real slice plan is a job-end artifact by design

`prReview.logic.ts:51` (`initialPrReviewState`) seeds `slices: []` at dispatch; `coercePrReview` fills the slices + findings in only when the reviewer returns. Nothing streams `prReview.slices` while the run is live. So the deep-review window has no real slice data for the whole run; the only intended live signal is `step.subtasks` ("slices reviewed / total", per the comment at `prReview.logic.ts:45`).

### 2. `sawTodoPlan` disables the D2.1 fallback exactly when the prompt trips it

The pr-reviewer prompt (`pr-reviewer.ts:91-98`) instructs a sequential, todo-driven review: "record the plan as a todo list with ONE entry per slice … Review ONE slice at a time … then mark that slice's todo entry done." That `TodoWrite`-driven flow is what `todosToProgress` surfaces as subtasks, and D2.1's slice tracker is only the fallback "for the parallel-subagent shape that writes no parent plan" (`agent-runner.ts:328-332`).

The CLI does not follow the sequential instruction. It writes the todo plan once at grouping time (prompt step 2), then fans the review out across parallel subagents. That single write is enough to flip `sawTodoPlan = true` (`agent-runner.ts:356-360`), which permanently gates off the fallback (`agent-runner.ts:336`, `if (sawTodoPlan || !opts.onProgress) return`). But because the work went to parallel subagents that don't return until the end, the agent never marks entries done mid-run (prompt step 3 never runs sequentially). So:

- the todo-plan source sits at 0-of-N done for the entire review, and
- the fallback that D2.1 added specifically to derive progress from the parallel `Task` dispatches is switched off by that one todo write.

The two mechanisms undercut each other. The prompt satisfies `sawTodoPlan`'s precondition (so the fallback disables itself) without delivering the incremental updates the fallback was meant to replace. Progress pinned at 0 for the whole run is the exact symptom.

Even with the gate removed, the fallback alone is weak for this shape: `SliceTracker.progress()` (`subagents.ts:92-105`) derives `completed` from `Task` tool_results, and parallel subagents all return in a burst at the end, so it reports 0/N until the finish then jumps to N/N. D2.1 restored slice _items_ but cannot produce an incremental percentage for the parallel shape.

### One unverified detail

The job container was reaped before I could poll the live harness view, so I could not capture the exact `step.subtasks` contents mid-run. The snapshot I did catch (at the throttled `updated_at` of 19:01:16) had no `subtasks` field and `progress: 0`. The 0% mechanism above is solid from the source; whether the once-written todo items were briefly visible is the only part inferred rather than observed.

### Fix

Any of, roughly in order of value:

- **Don't gate the fallback on `sawTodoPlan` alone.** Prefer whichever source is actually advancing, or merge them, so a stale once-written todo plan doesn't mask live `Task` progress.
- **Count in-flight `Task` dispatches as signal.** Surface "N slices in progress" rather than a 0% bar, since a parallel review has no completed slices until the end.
- **Reconcile the prompt with reality.** If the CLI parallelizes regardless, either tell it to update the parent todo as each subagent returns, or drop the sequential-todo instruction and rely on the tracker. The prompt currently claims "keeping this todo list up to date is what surfaces review progress," which is not what happens.

**Landed.** Took the first two together. The `sawTodoPlan` gate is gone; a new pure `pickProgress(todo, slice)` (`subagents.ts`) reconciles the parent TodoWrite plan and the slice tracker on every update, preferring whichever is further along — more `completed`, then more `inProgress` (so live in-flight `Task` slices beat an all-pending, once-written plan), then more `total`, else the todo plan. So the parallel shape now surfaces "N in progress → N/N" off the `Task` dispatches, and a genuinely sequential run still rides its advancing todo plan. The pr-reviewer prompt's progress sentence is corrected to say progress comes from the todo list AND from parallel subagent dispatches (the prompt is unversioned, so no version bump). `pickProgress` is unit-tested for both shapes and the tie-breaks.

## Consequences

- ADR 0026's "landed" status for D2.1 and D3 is wrong for the parallel-subagent shape those items name. The correct status is: the code shipped, the wiring is intact, and neither delivers its signal on the shape it targeted. This ADR supersedes those two status claims; D1, D4, D5, D6, D7 are unaffected.
- Defect A undercounts cost on every subscription-billed subagent-parallel run, not just pr-review. Any kind that fans out via `Task` has the same blind spot.
- Both fixes are small and independent. Defect A is a path change plus a fixture test. Defect B is a change to the fallback gate and/or the prompt.

## Appendix: evidence

- Run `exec_1c129edbc1754247896a3755`, pipeline `pl_review`, `pr-reviewer`, model `anthropic:claude-opus-4-8`, executor image `1.50.10`.
- `token_usage`: one row, `agent_kind=pr-reviewer`, 155,651 input / 9,135 output, `billing=subscription` — parent only.
- Recovered subagent transcripts under `…/projects/-tmp-agent-explore-Z0Fhxx/aeb3854a-…/subagents/`: four files, 272-514 KB, last written 18:59-19:01.
- Watcher target `<configHome>/subagents` (`agent-runner.ts:454`) vs actual `<configHome>/projects/<cwd>/<session>/subagents` (`transcript-retention.ts:61`).
- `sawTodoPlan` gate: `agent-runner.ts:334-339`, set at `356-360`, read at `336`.
- Installed backend carries the forwarding path: `subtasks: view.progress` + `lastActivityAt: view.heartbeatAt` in `@cat-factory/server@0.140.5`, `applySubtaskProgress` in `@cat-factory/orchestration@0.131.5`.
- Terminal state: `agent_runs.status = blocked`, `detail.steps[0].prReview.status = awaiting_selection`, 5 slices, 11 findings, `progress = 0`.
