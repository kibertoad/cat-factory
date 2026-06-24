---
'@cat-factory/executor-harness': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
---

Make the conflict-resolver actually see the conflict, and stop it churning to 10 attempts.

Telemetry on a failed run showed the `conflict-resolver` was handed `userPromptFor(context)`
— the full task brief plus every prior agent's output (~53 KB) — with no mention of which
files conflicted or that there were conflicts at all. The model drifted onto the original
feature task (it returned a "test report is ready" answer) and never touched the markers,
so the gate re-dispatched 10 times with the PR head SHA never moving, then failed the run.

- Harness: when the base merge surfaces conflicts, build a conflict-focused prompt that
  leads with the exact conflicted files and their `git diff` hunks (new `conflictDiff`
  helper), keeping the task only as a trailing reference. Clean merges and no-op
  "already up to date" cases are now logged distinctly so the "GitHub says conflicting but
  the local merge is clean" loop is diagnosable. Bumps the harness image (1.7.1 -> 1.7.2).
- Server: the conflict-resolver job body no longer renders `userPromptFor(context)`; it
  sends only a compact task reference (title + description). The harness supplies the
  actual conflict material.
- Orchestration: the conflicts gate now caps escalations at 3 (was CI's default of 10) via
  its own `attemptBudget` — a conflict retry re-merges the same base with no new signal, so
  it fails fast to a manual-resolution notification instead of burning containers.
