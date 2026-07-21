---
'@cat-factory/executor-harness': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
---

pr-reviewer: prefetch the reviewed PR head so the review can see the proposed code.

A `pr-reviewer` clones only the base branch and the container agent holds no git credential of its own, so files the PR ADDS (not on the base checkout) and the head version of modified files were unreachable — the review was silently limited to the ~256 KiB of patches inlined in `.cat-context/pr-diff.md`, and the prompt's `git fetch origin pull/<n>/head` fallback fails on a private repo. On a 518-file PR that meant only ~29 files were fully reviewable.

The engine now resolves the reviewed PR number (new `AgentCloneSpec.prHead`, set on the pr-reviewer kind) into the job's `reviewPrNumber`, and the harness fetches `pull/<n>/head` (GitHub) / `merge-requests/<n>/head` (GitLab) into `origin/pr-head` with its own token before the run — mirroring the reference-branch prefetch. The reviewer prompt + injected diff now point at `origin/pr-head` for full head file bodies. Best-effort: a failed fetch leaves the review on the base checkout + injected diff as before.

The injected `.cat-context/pr-diff.md` also gains a per-file patch cap (32 KiB): a single oversized patch (a lockfile, a snapshot, a vendored blob) is now stubbed with an `origin/pr-head` pointer instead of being inlined, and no longer draws down the global 256 KiB budget — so one giant generated diff can't starve the many small, reviewable source patches. The head prefetch makes the stubbed files readable on demand.

Harness (image bump): the `agent` job gains an optional `reviewPrNumber?: number`.
