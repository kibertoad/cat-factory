---
'@cat-factory/delegation-github-actions': minor
---

`GitHubActionsWorkflowScope` gains `baseBranch`, the work repository's base branch from the brief's
`branches.base`. A caller shim committed to each onboarded repository is dispatched on that branch,
and a resolver had no way to name it, so every deployment restated its default-branch name per
repository. It is guaranteed the way `repo` is: a poll or cancel whose handle carries no branch
pair (a record written before branches were persisted) is refused rather than defaulted. A literal
`workflow` builds no scope and is unaffected.
