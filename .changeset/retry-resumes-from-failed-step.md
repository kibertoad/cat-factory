---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/worker': patch
---

Make pipeline runs resilient to a failed/evicted `coder` (or any container) step:

- **Retry resumes from the failed step.** `ExecutionService.retry` no longer
  restarts the pipeline from step 0 — it re-drives from the step that actually
  failed, preserving the steps that already completed. A `coder` failure in
  `pl_full` no longer re-runs the human-gated `requirements`/`architect` steps
  before it. The failed step and everything after it are reset to a clean,
  re-runnable state and dispatched to a fresh container (a new execution id ⇒ a new
  container). Resume planning lives in the pure, unit-tested `planResumedSteps`.
- **Automatic single recovery from a container eviction/crash.** When a job poll
  reports the container vanished (`…container evicted or crashed`), the engine now
  re-dispatches the same step to a fresh container **once** instead of failing the
  whole run on the first blip; a second eviction of the same step is treated as
  deterministic and fails the run with the new `evicted` failure kind (its hint
  points at the container logs / a heavier instance type). The recovery count is
  tracked on the step (`PipelineStep.evictionRecoveries`); a genuine agent/job
  failure is never auto-recovered. New `job_evicted` advance result + `job.logic`
  helpers (`isContainerEvictionError`, `MAX_EVICTION_RECOVERIES = 1`).
