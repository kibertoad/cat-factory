---
'@cat-factory/app': patch
---

Inspector: add a quick-link to a task's work branch on GitHub, shown once the
agent has pushed one (a PR branch is recorded on the block). The repo is resolved
via the task's owning service frame, falling back to deriving the repo base from
the PR url. Complements the existing service-repo link on a frame's inspector.
