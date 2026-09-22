# `@cat-factory/delegation-github-actions`: a DelegatedExecutor over GitHub Actions

A deployment plugs its own implement/review/test loop in as the executor of a pipeline step
(`docs/flow-index.md` → "Delegated executors"). When that loop is a GitHub Actions workflow, three problems
stand between it and the seam, and none of them is about that company's workflow, so they are
solved once, here, rather than in every deployment repo.

**Entry:** `src/index.ts` → `githubActionsDelegatedExecutor(description, deps)`. A deployment's
registration becomes a description of its own workflow (`workflow`, `inputs(brief)`) plus an
optional `resultFrom`.

**`workflow` is a location OR a function of the dispatch**, and the function is what a multi-repo
deployment needs: a caller shim committed to each onboarded repository means the workflow lives
wherever the work does, so one registration dispatches against every repo the deployment onboards.
The resolver is handed a `GitHubActionsWorkflowScope`, deliberately narrowed to the INTERSECTION of
what a brief and a handle carry: `start` holds a brief and `poll`/`cancel` hold a handle written
hours earlier in another process, so a resolver reading a brief-only fact would dispatch into one
repository and poll another, reporting a live run as one that never appeared. Every field of the
scope is guaranteed, not best-effort: the engine refuses a poll whose handle is short of one rather
than filling it in, which is the other half of the property. A handle that names no work repository
(a record written before it was persisted) is REFUSED rather than defaulted, for the reason the
result reader refuses a handle with no branches. It is asked ONCE per call and threaded down, so a
resolver that reads a config map or counts a metric sees one addressing decision per call.

**The three problems, and where each is solved:**

- **`workflow_dispatch` answers `204` with no run id**, and the run does not exist yet when it
  answers, so there is nothing to poll and nothing to look up. `correlation.ts` solves it with the
  brief's `correlationKey`: the caller workflow renders `correlationRunName(key)` into its own
  `run-name:`, and the run becomes findable by a string the platform chose. **The marker is matched
  against `display_title`**, which is where GitHub puts an evaluated `run-name:`; `name` keeps the
  workflow's own `name:` and is read only as a fallback for an Enterprise release with no
  `display_title`. **`start` is idempotent because it looks first**, which is the whole point: both
  durable drivers replay, and a second dispatch means two workflows on one branch and two pull
  requests for one task.
- **Actions' conclusions are not the platform's vocabulary.** `executor.ts` maps them, including
  the three (`cancelled` / `timed_out` / `stale`) that are the only ones a fresh attempt could
  survive, reported as `retryable: true` so the engine spends its one bounded re-dispatch
  (`MAX_DELEGATED_RETRIES`) on them. Everything else is a verdict the workflow itself reached, and
  re-running it burns somebody else's runner to reach the same one.
- **A `workflow_dispatch` workflow declares no outputs**, so what it PRODUCED is recovered from the
  repository: `result.ts` finds the open pull request whose head is the run's work branch, **in the
  repo the WORK targeted**. Both facts come off the delegation HANDLE, which the platform persists
  for exactly this. The repo matters as much as the branch and for a sharper reason: `ref` is a
  branch that holds the WORKFLOW, so a central automation repo dispatching against many product
  repos is one of the two ordinary shapes, and reading the result out of the automation repo finds
  nothing on every run. When a record carries no branch the reader **refuses to guess**: a wrong pull request
  on the block becomes the `ci` gate's checks and the merger's diff.

**Key files:** `executor.ts` (the `DelegatedExecutor`), `correlation.ts` (finding the run),
`result.ts` (finding the pull request), `http.ts` (the two REST calls).

**See also:** `docs/flow-index.md` → "Delegated executors"; kernel `ports/delegated-executor.ts`;
`backend/internal/example-delegated-executor` (a runnable registration, with no GitHub in it).
