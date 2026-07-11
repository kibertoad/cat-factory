---
'@cat-factory/app': minor
---

Apriori branches (slice 4): a task's Run settings now expose the pre-existing branches
of its target repo as run input. Add branches from the repo's branch projection, toggle
each between `reference` (read-only context) and the single `working` branch the run
builds inside, with the working slot disabled on multi-repo tasks and frozen once a PR
exists, plus a protected-branch push warning. Fully translated across all locales.
