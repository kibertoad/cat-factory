---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

feat: scope Review tasks to the PR-review pipeline and surface brand-new built-in pipelines

A `review` task deep-reviews an existing pull request, so a build/document/test pipeline is useless for it. The task pickers now offer a `review` task ONLY `purpose: 'review'` pipelines — exactly as a `document` task is scoped to document pipelines — via the shared `pipelineAllowedForTaskType` predicate, and the add-task form defaults a review task to the `pl_review` PR-review pipeline so its (now purpose-narrowed) picker is never empty.

Fixes the "I don't see a review pipeline when creating a Review task" gap: existing workspaces are seeded with the pipeline catalog only at creation, and — unlike the risk-policy and model-preset catalogs — pipelines had no mechanism to surface a built-in that shipped afterwards. `PipelineService.reseed` now MATERIALISES a brand-new built-in the workspace lacks (keyed off the catalog, inserting the row when absent instead of 404ing), and the startup pipeline-health advisory (`usePipelineHealth` → `PipelineHealthModal`) lists new built-ins to add, mirroring `useRiskPolicyHealth` / `useModelPresetHealth`.

The `pl_review` description now explains it is built for large PRs: it slices the diff into cohesive chunks and reviews each, so it works through a big change over a longer run rather than choking on it in one pass. Its `version` is bumped, so existing workspaces are offered a reseed that adopts the new copy.
