---
'@cat-factory/agents': patch
---

Spec reviewer (`spec-companion`) now judges only what the Spec Writer controls.

The reviewer kept faulting the writer for things the writer was never allowed to add:
error paths, validation rules, and status codes the requirements never stated (or
explicitly put out of scope), plus open questions like "is an extra field discarded?".
That is reviewing the requirements, not the spec — exactly what the writer's mandate
forbids it from filling.

The prompt now: covers the happy path for every stated behaviour plus only the
error/edge/boundary cases the requirements explicitly call for or that a stated
requirement cannot be satisfied without; honours the requirements' own non-goals,
assumptions, and exclusions instead of penalising the spec for leaving them out; and
never asks the writer to "clarify" or "decide" a question the requirements left open.
