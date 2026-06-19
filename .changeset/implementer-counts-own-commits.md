---
'@cat-factory/executor-harness': patch
---

Fix false "no file changes" failures in the container coding agents, and converge
the implementation (`/run`) and CI-fixer (`/ci-fix`) paths onto one shared flow.

The build/ci-fix roles commit their work themselves, so by the end of a successful
run the working tree is often clean — and the harness's trailing `commitAll` then
found nothing and reported "no changes" (a hard failure for `/run`, a lost fix for
`/ci-fix`) even though the branch carried real changes. The harness now judges the
_whole run_ against the branch's pre-run tip (`branchHasChanges`): it counts the
agent's own commits as well as any still-uncommitted edits, ignores the
harness-written `AGENTS.md`, and only treats nothing-at-all as a no-op.

The two paths were near-duplicates (clone → write context → run Pi → push), so they
now share `runCodingAgent` (and `noChangesReason`) and diverge only in what is truly
different: implementation branches off the base onto a fresh PR branch and opens a
pull request; the CI-fixer works directly on the PR branch and treats a no-op as
non-fatal. The fix therefore applies to both without being written twice. Bumps
`@cat-factory/executor-harness` (its image logic changed).
