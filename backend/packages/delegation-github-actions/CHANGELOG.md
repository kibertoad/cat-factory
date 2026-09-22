# @cat-factory/delegation-github-actions

## 0.1.0

### Minor Changes

- bc073ab: Delegated executors: a pipeline step can now run in a system the deployment already operates (its own GitHub-Actions loop, job runner or PR bot) while cat-factory keeps the intake, the standards, the CI gate, the merge policy and the notifications around it.
  
  A deployment registers a `DelegatedExecutorDefinition` on the new app-owned `DelegatedExecutorRegistry` and points an agent kind at it with `agent: { surface: 'delegated', executor }`. The executor is handed the same brief the container harness composes, so a workspace's prompt overrides and agreed standards reach both identically; its credentials resolve per call through the existing `ToolSecretResolver` port and never touch the brief.
  
  Each definition declares who creates the work branch its dispatches name. `workBranch: 'platform-creates'` has the engine create it at the base head just before `start`, idempotently, which is what an external CI runner needs: `actions/checkout` on a branch that is not there fails the job before any of the work begins, and a runner that quietly substitutes a branch of its own publishes to a ref the platform never recorded. `workBranch: 'executor-creates'` writes nothing, so a run whose external work never landed leaves no empty ref behind. Either way the branch is the one the rest of the run uses: a task's own apriori working branch when it declared one (probed, never created, exactly as the container dispatch treats it), else `cat-factory/<blockId>`.
  
  Two things the platform states rather than guesses. A delegated step's model calls never reach this deployment's proxy, so the step card says "usage not reported by <executor>" and the run rollups carry `llm.reporting.delegatedStepsWithoutUsage` instead of rendering a zero. And a run stopped while external work is still running records whether it actually stopped: an executor that declares no `cancel` leaves its run alive, and the record says so.
  
  Ships with `@cat-factory/delegation-github-actions` (a `DelegatedExecutor` over Actions: correlation by run name, since `workflow_dispatch` returns no run id) and a runnable example under `backend/internal/example-delegated-executor`. Its `workflow` is a location or a function of the dispatch, so one registration can dispatch against every repository a deployment onboards; the resolver sees only facts a brief and a handle both carry, because `poll` and `cancel` run hours later holding just the handle.
  
  A failure the executor calls `retryable` (a cancelled run, a runner-pool restart, a rate limit) buys one fresh dispatch on an engine-set budget, and everything else is terminal. Registered executors reach their own systems through a fetch the platform has already guarded: the deployment's outbound-URL policy on the first URL and on every redirect hop (the same guard the notification webhook sender uses), a deadline so a hung endpoint cannot hold a poll open indefinitely, and a running byte cap on what one response may return.
  
  Two declaration-time refusals, because neither has a reading under which it does something. A definition whose credentials resolve to the same injection name is refused at registration: the bag an executor is handed is keyed by the name it reads, so one name can carry only one value. And a delegated kind naming an executor this process does not register is refused by name at dispatch rather than falling through to the container harness, which is the mothership-mode case where nothing boot-validates the kinds a node resolves.
  
  Public API 1.75.0, both additive: `AgentFailureKind` gains `delegated_failed`, so an external system's verdict is classified as its own thing rather than as a container that was shut down, and the `llm` totals on the two debug run surfaces gain `reporting`, saying how many of a run's steps ran on an executor that files no usage.
  
  Internals: `AgentSurface` gains `delegated`, `AsyncAgentExecutor.reclaimRun` may return a `RunReclaimReport`, `AgentJobHandle` and `DelegationHandle` carry the run's block (so a poll and a cancel resolve credentials in the scope the dispatch used), and `PipelineStep` gains `delegated` plus `delegatedRetries`. Five new `error.details.reason` values, all additive: `delegated_executor_unwired` (409), `delegated_step_async_only` (409), `delegated_claim_missing` (409), `delegated_executor_failed` (503) and `delegated_work_branch_unprepared` (503, the platform's own VCS write rather than the executor's system).

### Patch Changes

- Updated dependencies [1fc4ff1]
- Updated dependencies [bc073ab]
- Updated dependencies [09bd94b]
  - @cat-factory/kernel@0.349.0
