---
'@cat-factory/orchestration': patch
---

Fix the requirements reviewer ignoring its per-workspace default model (it always ran
on the routing default, e.g. Qwen, even when a model was pinned for it in Default Models).

The `requirements` → `requirements-review` rename left `RequirementReviewService`'s
`REQUIREMENTS_AGENT_KIND` constant on the old `'requirements'` key. The Default Models UI
saves a kind's default under the catalog archetype kind (`requirements-review`), so the
reviewer looked up the default under a key nothing writes, found nothing, and fell through
to the deployment routing default. Aligned the constant to `'requirements-review'`, matching
the catalog, the seeded pipelines' step kind, and the observability tag.
