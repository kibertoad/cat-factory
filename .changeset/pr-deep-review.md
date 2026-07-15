---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/app': minor
---

Add a **Review** task type for deep-reviewing an existing open pull request.

A `review` task defaults to the new `pl_review` pipeline, which runs a built-in read-only
`pr-reviewer` agent: it slices the PR's diff into cohesive chunks, reviews each within a
bounded context (so token usage scales on huge PRs), and returns prioritized findings
rendered in the generic structured result view. The create-task form gains a Review type
with a target-PR field and an optional review focus.

Foundations for the tracked follow-ups (human finding-selection + fix/inline-comment
resolutions): a new provider-neutral `VcsClient`/`GitHubClient.listChangedFiles` method
(implemented for GitHub), and a no-PR terminal path so read-only pipelines that open no PR
finish cleanly as `done` instead of stranding on a confirm-and-merge notification.
