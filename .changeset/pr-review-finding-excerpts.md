---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
---

A PR review's findings now carry the code they point at. When the reviewer's findings are recorded,
the engine reads each anchored file at the commit the review started on and stores the anchor line
plus up to three lines either side (`excerpt: { startLine, endLine, side, text }`, at most 2 KB, at
most 40 files per review). The excerpt is null for a finding with no line, one on the base side, or
a file that is deleted, binary or unreadable at that commit, and every finding is recorded without
one when the review has no head sha or no repository is bound.

`/api/v1` (OpenAPI 1.90.0) serves both: `reviewedHeadSha` on the `pr-review` decision and `excerpt`
on each of its findings. Additive.

The `pr-reviewer` prompt asks for a finding's `detail` as one impact sentence followed by two to
four short evidence bullets, with the fix kept in `suggestedFix`.
