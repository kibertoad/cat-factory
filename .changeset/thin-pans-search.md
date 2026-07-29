---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Validate a review task's target pull request when the task is created, and surface that pull
request in the inspector.

A `review` task carries a reference to an EXISTING pull request, and until now nothing checked it.
A typo'd number was accepted silently and only surfaced much later as a run that dispatched a
container, cloned the repo and found nothing to review. Creation now probes the PR through the
same run-repo seam the review itself uses (`RepoFiles.getPullRequest`, new and optional on the
`GitHubClient` / `VcsClient` ports, implemented for GitHub and GitLab), so the reference is checked
against precisely the repository the reviewer will read.

Only a POSITIVE "no such pull request" refuses — the provider's own 404, which the new port method
reports as `null` while every other failure throws. An outage, a revoked token or a rate limit
answers "unknown", not "absent", so those are logged and the task is created: making task creation
depend on the provider being up would be a worse failure than the one this prevents. Same for
every unwired case (no VCS connection, a provider that can't read a PR, a reference with no
resolvable number) — all pass through unchanged.

One case that looks like validation but is really a correctness fix: a pasted link belonging to a
DIFFERENT repository is now refused (`review_pr_repo_mismatch`). The reviewer fetches the PR by
NUMBER from the service's linked repo (ADR 0023 — a cross-repo `prUrl` is not resolved to another
repo), so such a link previously reviewed whatever PR happened to carry that number on the linked
repo, with nothing anywhere saying so.

A confirmed reference is then rewritten to the provider's own URL for that PR, which is what makes
the second half possible: the block inspector leads a review task's body with an "Under review"
panel linking the reviewed pull request. That is the task's SUBJECT and it had no affordance at
all before — only the Execution panel's link to the PR a run PRODUCED, which a review task never
has. A task created while no VCS was connected keeps just the number, and the panel renders it as
text rather than pretending to be a link.
