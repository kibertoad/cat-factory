# Initiative: pr-review token-burn reduction

**Status:** in progress (Slice 1 landed) · **Owner:** core · **Started:** 2026-07-20

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

A single deep PR review burned an enormous number of tokens for what it produced. The #1261
investigation (`docs/pr-review-run-efficiency-and-parking-fixes-2026-07.md`, §1) measured one
run: **350 model calls** (164 tool-call turns + 5 sub-agents), **31.1M summed prompt tokens**
of which **99.998% were cache reads** — because the single agentic conversation grows and is
re-sent every turn (per-call prompt ramped ~18K → ~219K). Cache reads are cheap per token but
not free, and the turn count is the real driver.

The investigation named the dominant, avoidable cost: the reviewer **cloned the base branch and
reconstructed the PR diff by hand** — multiple `git diff` runs to scratch files plus grep passes
— before it could even start slicing. Those early discovery turns each re-send the whole
transcript. The backend already has the diff via the GitHub integration
(`GitHubClient.listChangedFiles`), so handing it to the agent up front removes them.

### End state

- **Slice 1 — hand the reviewer the diff up front (DONE).** A `pr-reviewer` preOp computes the
  changed-file list + per-file patches on the backend and injects them as
  `.cat-context/pr-diff.md`, so the agent plans its slices from a prepared artifact instead of
  reconstructing the diff. The full base clone stays (the ADR requires full-source access for
  reading unchanged neighbours), so this is a pure accelerant with a git fallback.
- **Slice 2 — curb sub-agent fan-out (todo).** The investigation flagged 5 sub-agents multiplying
  the re-sent-context effect. Audit the reviewer prompt for whether it encourages sub-agents where
  a direct read would do, and steer it toward in-loop reads for small slices.
- **Slice 3 — measure (todo).** Re-run a representative review after Slice 1/2 and compare turn
  count + fresh-vs-cache token split (the sibling `token-telemetry-per-class-and-cost` initiative
  makes that split honest) to confirm the reduction. Fold the result back here.

## Target pattern (Slice 1 — the reference implementation)

The mechanism reuses two existing seams end to end, so it is backend-only, needs **no harness
image bump**, and is runtime-symmetric (the shared `ContainerAgentExecutor` + the HTTP-only
`RepoFiles` port work identically on Worker/Node/local):

1. **`RepoFiles.listChangedFiles?`** (kernel `ports/repo-files.ts`) — a new optional method,
   forwarded from the wired `GitHubClient.listChangedFiles` in `makeRepoFiles`
   (server `repoFiles.ts`), mirroring the existing `pullRequestHeadRef?`/`createReview?` optionals.
   Optional so a client that can't enumerate PR files (or a GitLab provider without it) makes the
   preOp pass through.
2. **PreOp → dispatch context bridge.** A preOp couldn't return prompt content before (only
   `pullRequest`). `RepoOpResult.contextFiles?: InjectedContextFile[]` (kernel) is the general
   extension: `runRepoOps` concatenates them, `RunRepoOpsController.runRegisteredPreOps` writes
   them onto `AgentRunContext.injectedContextFiles` (the SAME context object the executor
   dispatches with), and `ContainerAgentExecutor` folds them into the job's `contextFiles` so the
   harness materialises them under `.cat-context/` (the existing linked-doc seam). `InjectedContextFile`
   lives in kernel `domain/types.ts` so the port and the run context share one shape.
3. **The `pr-reviewer` preOp** (`agents/kinds/pr-reviewer.ts`, `prReviewerDiffPreOp`): resolve the
   PR number (`taskTypeFields.prNumber`, else parse `prUrl`), call `repo.listChangedFiles`, and
   render `pr-diff.md` — the full changed-file list always, plus per-file patches up to a 256 KiB
   budget (over budget → listed but patch omitted with a note; the agent reads those from the
   checkout per slice). Pass-through when unwired / no number / no files.
4. **Prompt** (same file): read `.cat-context/pr-diff.md` FIRST; the `git fetch`/`git diff` path
   is kept as the fallback and for on-demand full-file reads. The per-slice todo-list instruction
   (load-bearing for live progress) is unchanged. Not a versioned (`versions.ts`) prompt, so no
   version bump.

## Per-slice checklist

| #   | Slice                  | Scope                                                                                                                                                 | Status  | PR  |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | Diff up front          | `RepoFiles.listChangedFiles?` + forward; `RepoOpResult.contextFiles`/`AgentRunContext.injectedContextFiles` bridge; pr-reviewer preOp + prompt; tests | ✅ done |     |
| 2   | Curb sub-agent fan-out | Audit + adjust the reviewer prompt's sub-agent guidance                                                                                               | ⬜ todo |     |
| 3   | Measure the reduction  | Re-run a representative review; compare turns + fresh/cache split; record here                                                                        | ⬜ todo |     |

## Conventions / gotchas carried between iterations

- **Do NOT remove full-source access.** ADR 0023 dropped a patch-only inline reviewer precisely
  because it couldn't follow call sites / read unchanged neighbours. The injected diff is an
  ADDITIONAL input; keep `clone: { branch: 'base', full: true }` and the git fallback.
- **Bound the injected diff.** A huge PR's patches are capped (256 KiB) — the changed-file LIST is
  always complete (it's the cheap slicing signal), patches beyond the budget are read from the
  checkout per slice. Never let the injected file become unbounded.
- **Pass-through when unwired.** No `listChangedFiles` on the bound client, no resolvable PR
  number, or an empty PR ⇒ inject nothing and let the prompt's git path run. Tests / GitHub-off
  deployments are unaffected.
- **Runtime-symmetric for free.** The change rides `ContainerAgentExecutor` + `RepoFiles` (both
  shared / HTTP-only), so all three facades get it with no per-facade wiring. `listChangedFiles`
  is an optional `RepoFiles` method with a pass-through, so the custom-agent conformance suite's
  fake (which omits it) exercises the pass-through; a facade wiring the real client gets the diff.
- **No image bump.** `.cat-context/` materialisation is existing harness behaviour — the backend
  only populates more entries. Don't bump the harness for this.
