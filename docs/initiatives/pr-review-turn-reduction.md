# Initiative: pr-review token-burn reduction

**Status:** in progress (Slices 1–2 landed) · **Owner:** core · **Started:** 2026-07-20

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
- **Slice 2 — cut what each turn CARRIES (DONE).** Originally scoped as "curb sub-agent fan-out";
  the measurement below refuted that framing (the fan-out is what keeps a big review affordable —
  see the gotchas). What actually costs is what sits in context while the turns tick by, so the
  slice became: stop folding standards into the delegating agent's prompt, stop pre-inlining a
  large diff nobody reads, hand over a computed slicing instead of a file the agent has to probe,
  group existing comments so a slice greps only its own, and state the context discipline
  (ranged reads, no re-reads, no whole-file dumps, no reading a slice you are about to delegate)
  in the prompt.
- **Slice 3 — measure (todo).** Re-run a representative review after Slice 2 and compare turn
  count + fresh-vs-cache token split (the sibling `token-telemetry-per-class-and-cost` initiative
  makes that split honest) to confirm the reduction. Fold the result back here.
- **Slice 4 — make the cost estimate honest (todo).** `claudeUsage` folds
  `cache_read_input_tokens` + `cache_creation_input_tokens` into `AgentTokenUsage.inputTokens`
  (kernel `ports/agent-executor.ts`), and `estimateCost` (`spend/src/pricing.ts`) prices all of it
  at the full input rate — so a run's cache reads are billed at 10× their real cost. Needs cache
  dimensions on `AgentTokenUsage` + cache multipliers on `SpendPricing`, mirrored across runtimes.
  Separately: the measured run recorded `token_usage.model = ''`, which fell through `priceFor`
  to the cheapest default entry — worth fixing in the same slice.

### Measurement (2026-07-23, run `exec_a7d46b8`, ~450-file PR)

Summed from the CLI's own per-turn `usage` across the parent transcript + all 5 subagent
transcripts. This is the baseline Slice 3 re-measures against:

|                   | turns   | cache read     | cache write   | output      |
| ----------------- | ------- | -------------- | ------------- | ----------- |
| parent            | 96      | 12,103,867     | 412,498       | 119,411     |
| 5 slice subagents | 341     | 27,421,548     | 1,828,332     | 132,841     |
| **total**         | **437** | **39,525,415** | **2,240,830** | **252,252** |

Cost ≈ Σ(context at each turn) ≈ turns × average context, so anything loaded early is re-paid on
every later turn. Measuring each tool result's "carry cost" (its size × turns remaining after it
landed) accounted for ~12.9M tokens, ~31% of the run. The specific findings Slice 2 acts on:

- The parent's first user turn was 154,591 chars — the 5 selected C# standards (145,711 chars,
  ~36k tokens) folded in, re-sent on all 96 parent turns ≈ **3.7M tokens**. The parent does not
  review code; the slice subagents do, and they never received the standards. The parent
  paraphrased them into each subagent prompt instead, so `fragmentAdherence` was rated from a
  one-line compression of each standard rather than its text. A correctness bug as much as a cost
  one.
- `pr-diff.md` was 319 KB. Across all 5 subagents it is referenced **once**; they ran **141**
  `git diff` / `git show` calls to re-derive their diffs. The parent then spent 21 `grep`/`awk`/
  `sed`/`wc` calls probing the injected file's own structure, each probe's output carried for the
  rest of the run (~431k combined).
- The parent's single largest carried item was `Read pr-existing-comments.md`: 7,957 tokens at
  turn 21 × 75 remaining turns ≈ **597k**.
- Subagent carry was dominated by whole-file reads and the CLI's tool-result spill/read-back loop
  (a spilled Bash result read back in full, then carried): top items 1,129k / 739k / 732k / 473k,
  and one subagent read the same spill file **three times** (781k combined).
- One slice ran 115 turns / 48 Bash calls — more turns than the parent — for ~11.6M tokens on its
  own. Because cost is turns × context, an oversized slice is superlinear: three ~40-turn slices
  in its place run roughly 3.7M.

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

| #   | Slice                      | Scope                                                                                                                                                   | Status  | PR  |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | Diff up front              | `RepoFiles.listChangedFiles?` + forward; `RepoOpResult.contextFiles`/`AgentRunContext.injectedContextFiles` bridge; pr-reviewer preOp + prompt; tests   | ✅ done |     |
| 2   | Cut what each turn carries | `standardsDelivery: 'context-files'` + standards preOp; manifest-first `pr-diff.md` + `planSlices`; comments grouped by file; context-discipline prompt | ✅ done |     |
| 3   | Measure the reduction      | Re-run a representative review; compare turns + fresh/cache split against the baseline table above                                                      | ⬜ todo |     |
| 4   | Honest cost estimate       | Cache dimensions on `AgentTokenUsage` + cache multipliers in `estimateCost`; fix the empty `token_usage.model` fallthrough                              | ⬜ todo |     |

## Conventions / gotchas carried between iterations

- **Do NOT remove full-source access.** ADR 0023 dropped a patch-only inline reviewer precisely
  because it couldn't follow call sites / read unchanged neighbours. The injected diff is an
  ADDITIONAL input; keep `clone: { branch: 'base', full: true }` and the git fallback.
- **Inline the diff all-or-nothing.** Patches inline only when the WHOLE diff fits 64 KiB (a small
  PR then reviews in one pass with no git turns). Past that, none inline: the file is a manifest
  and each slice pulls its own diffs, which is what the slice subagents do regardless. A
  PARTIALLY inlined file — the original 256 KiB budget — is the worst case: big enough to carry on
  every turn AND incomplete, so the agent burns turns probing to find out what is missing. The
  changed-file LIST is always complete; it is the cheap slicing signal.
- **Fan-out is the CURE, not the disease.** Slice 2 was originally scoped to curb subagent
  fan-out. The measurement says the opposite: a subagent starts with a fresh context, so its
  reading never accumulates onto the parent's transcript. The parent's OWN accumulation is what
  costs. Steer the parent to plan, dispatch and aggregate — and to read as little as possible
  itself — rather than to do slices in-loop.
- **A delegating agent must not carry what its subagents need.** Anything the parent holds is
  re-sent every parent turn; anything a subagent reads is paid once, in a context that is
  discarded. That is the whole reason for `standardsDelivery: 'context-files'`. When adding new
  reference material to this kind, ask "which agent actually reads this?" before folding it in.
- **Never let the parent paraphrase a standard.** A summary in a subagent prompt is not the
  standard, and `fragmentAdherence` ratings derived from it are not grounded. Route subagents to
  the `.cat-context/standard-<id>.md` files and have them read the text.
- **`context-files` delivery has TWO halves that must agree.** Suppressing the fold
  (`composeBlockSystemPrompt`) is only safe once the files were actually written. So: (1) the
  reviewer's adherence guidance must point at `.cat-context/standards.md`, NOT "folded into this
  prompt above" — the wrong variant tells the model to return an empty `fragmentAdherence` on
  every run; (2) if the standards preOp can't run (run-repo resolver unwired), the engine falls
  back to folding via `standardsDeliveredAsFiles`, so the standards are never lost through both
  channels. The delivery argument is required, so a missed call site can't silently re-fold.
- **Sanitized standard filenames must be unique.** `standard-<id>.md` replaces unsafe chars with
  `-`, so two ids can collide to one filename and the harness (which dedupes context files by
  path) drops the second — losing a standard while the index still lists it. A short hash of the
  raw id is appended whenever sanitizing changed it.
- **Pass-through when unwired.** No `listChangedFiles` on the bound client, no resolvable PR
  number, or an empty PR ⇒ inject nothing and let the prompt's git path run. Tests / GitHub-off
  deployments are unaffected.
- **Runtime-symmetric for free.** The change rides `ContainerAgentExecutor` + `RepoFiles` (both
  shared / HTTP-only), so all three facades get it with no per-facade wiring. `listChangedFiles`
  is an optional `RepoFiles` method with a pass-through, so the custom-agent conformance suite's
  fake (which omits it) exercises the pass-through; a facade wiring the real client gets the diff.
- **No image bump.** `.cat-context/` materialisation is existing harness behaviour — the backend
  only populates more entries. Don't bump the harness for this.
