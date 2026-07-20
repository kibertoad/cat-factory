---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/agents': patch
---

Make the `pr-reviewer` agent comment-aware. A second preOp injects the PR's existing review threads (prior review rounds, human reviewers, other bots) as `.cat-context/pr-existing-comments.md` via a new optional `RepoFiles.listReviewThreads`, and the reviewer prompt now de-dups against them — skip issues already raised, focus on what is new or still unaddressed. Reuses the `listReviewThreads` read already implemented for the `human-review` gate (forwarded by `vcsBackedGitHubClient`, so GitLab gets it for free); passes through unchanged when the client can't read threads.
