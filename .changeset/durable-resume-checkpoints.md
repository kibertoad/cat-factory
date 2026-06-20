---
'@cat-factory/executor-harness': patch
'@cat-factory/worker': patch
---

Make container coding runs durable and restart-resilient, and stop the harness
committing files the agent didn't choose.

- **Agent owns commits, harness owns push.** The harness no longer blanket-stages
  (`git add -A`) the working tree — which would sweep in scratch scripts and build
  artifacts the agent created while exploring. The agent commits its own work (only it
  knows what belongs); the harness pushes those commits and opens the PR. A safety net
  (`commitTrackedEdits` → `git add -u`) still captures forgotten edits to ALREADY
  tracked files, but never untracked junk. A run is a no-op only when the branch never
  advanced past its pre-run tip.
- **Checkpoint + resume.** The harness pushes the branch periodically during a run
  (`JOB_CHECKPOINT_INTERVAL_MS`, default 60s), so an evicted container's commits
  survive on the branch. The work branch is now deterministic per task
  (`cat-factory/<blockId>`), so a retry (fresh execution id) or a sweeper re-drive
  targets the SAME branch; the harness detects it already exists and RESUMES on it
  (cloning it and continuing on its commits) instead of starting over. `openPullRequest`
  is now idempotent (a resumed branch's existing PR is reused, not re-failed).
  A checkpoint only pushes once the branch has actually advanced past its pre-run tip,
  so a run that never commits leaves no empty work branch behind (which would otherwise
  make a later retry treat the base commit as resumable work and fail to open a PR).
