---
'@cat-factory/executor-harness': minor
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/local-server': patch
---

Bugfix reproduction proof — the harness verification phase (Phase B)

The container now RUNS the reproduction declaration Phase A threaded to it, so a bugfix run
carries captured evidence that the defect was real instead of the model's own claim that it was.
Between the agent settling and the pull request opening, the harness runs the declared check
against two trees of the same clone and computes the verdict from the exit codes:

- **`reproduced`** — red on the pre-fix tree, green on the tree the PR opens from. The only shape
  that is proof.
- **`inconclusive`** — every other shape (green at base ⇒ the check does not demonstrate the
  defect; red at both ⇒ the change does not fix it, or the environment is broken), recorded
  honestly with both captured outputs and a one-line note saying which.

**Symmetry is the safety property.** A non-zero exit at the base proves nothing on its own — a
missing toolchain, an uninstalled dependency, or an unrelated pre-existing breakage all produce
one. Both phases therefore run in freshly-created `git worktree` checkouts with the SAME setup
command and the byte-identical declared test files (applied path-by-path onto the base tree, never
a whole-tree checkout, which would drag the fix across and green it). An environmental defect
fails both and is reported as `inconclusive`, never as proof. Red-for-the-wrong-_reason_ is not
detected — both outputs ride the report precisely so a human can see why the base was red.

**A failed verification is a REPAIR, not a run failure.** The captured output goes back to the
agent — with an explicit rule against weakening the reproduction — while budget remains, and
exhausting it degrades to `inconclusive` with the PR still opening. Deliberately a different
disposition from pre-PR validation, which opens nothing: a red check means the WORK is broken; an
unproven reproduction means the EVIDENCE is weak, which is a reviewer's call. A setup failure
spends no repair rounds at all, since the agent cannot change a setup command it did not declare.

Also in this slice:

- The verdict reaches the engine both LIVE (`RunnerJobView.reproductionReport`, republished with a
  fresh timestamp each round so a failed verification is visible while the loop still runs) and
  terminally, on the success path, the failure path, and through a self-hosted runner pool (a new
  `reproductionReportPath` response-manifest mapping, so a pool-backed run is not left with a
  silently missing section).
- The proof runs BEFORE the pre-PR validation loop, so validation stays the last thing to touch
  the tree and "only a green checkout opens a PR" is preserved unconditionally.
- Per-job by construction: the worktree root is a fresh `mkdtemp` and every command, cwd and
  environment arrives as an argument, so two concurrent bugfix runs on the ONE local-native host
  process cannot check out over each other's base trees — which would surface as a false verdict
  on a pull request, not a crash. Pinned by a concurrency test.
- A declared test file that was never `git add`ed is reported as such (the proof runs against
  committed trees, and the push would miss it too) instead of yielding a verdict computed without
  the reproduction in it.

Unconfigured means unchanged: no `reproduction` on the job body ⇒ the harness's existing path,
byte for byte.

Runner image bumped to `1.57.0`. The PR-report section that renders this is Phase C.

Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.
