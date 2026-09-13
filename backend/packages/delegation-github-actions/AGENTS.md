# `@cat-factory/delegation-github-actions`: a DelegatedExecutor over GitHub Actions

A deployment plugs its own implement/review/test loop in as the executor of a pipeline step
(`CLAUDE.md` → "Delegated executors"). When that loop is a GitHub Actions workflow, three problems
stand between it and the seam, and none of them is about that company's workflow, so they are
solved once, here, rather than in every deployment repo.

**Entry:** `src/index.ts` → `githubActionsDelegatedExecutor(description, deps)`. A deployment's
registration becomes a description of its own workflow (`owner`, `repo`, `workflowFile`, `ref`,
`inputs(brief)`) plus an optional `resultFrom`.

**The three problems, and where each is solved:**

- **`workflow_dispatch` answers `204` with no run id**, and the run does not exist yet when it
  answers, so there is nothing to poll and nothing to look up. `correlation.ts` solves it with the
  brief's `correlationKey`: the caller workflow renders `correlationRunName(key)` into its own
  `run-name:`, and the run becomes findable by a string the platform chose. **`start` is idempotent
  because it looks first**, which is the whole point: both durable drivers replay, and a second
  dispatch means two workflows on one branch and two pull requests for one task.
- **Actions' conclusions are not the platform's vocabulary.** `executor.ts` maps them, including
  the three (`cancelled` / `timed_out` / `stale`) that are the only ones a fresh attempt could
  survive. Everything else is a verdict the workflow itself reached, and re-running it spends the
  job-failure budget to reach the same one.
- **A `workflow_dispatch` workflow declares no outputs**, so what it PRODUCED is recovered from the
  repository: `result.ts` finds the open pull request whose head is the run's work branch. The
  branch comes off the delegation HANDLE (the platform persists it for exactly this), and when a
  record carries none the reader **refuses to guess**: a wrong pull request on the block becomes
  the `ci` gate's checks and the merger's diff.

**Key files:** `executor.ts` (the `DelegatedExecutor`), `correlation.ts` (finding the run),
`result.ts` (finding the pull request), `http.ts` (the two REST calls).

**See also:** `CLAUDE.md` → "Delegated executors"; kernel `ports/delegated-executor.ts`;
`backend/internal/example-delegated-executor` (a runnable registration, with no GitHub in it).
