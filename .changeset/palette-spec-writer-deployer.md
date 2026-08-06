---
'@cat-factory/agents': minor
'@cat-factory/app': minor
'@cat-factory/orchestration': patch
---

Spec Writer, Blueprinter and Deployer are addable in the pipeline builder again

The catalog collapse dropped the requirements review, the spec increment, the map refresh and the
rest of the optional phases out of every build preset on one stated condition: that each remained
available in the builder as an opt-in step. For `spec-writer`, `blueprints` and `deployer` that
condition was never met, so the collapse did not move those steps out of the presets, it removed
them from the product.

A step reaches the palette through two independent gates and each of the three failed at least one.
A registered kind is offered only when it declares `presentation` (the filter
`snapshotCustomAgentKinds` applies), and `spec-writer` / `blueprints` deliberately declared none,
recorded in code as "pipeline-internal, not palette kinds". Separately, the SPA's
`SYSTEM_AGENT_META` shadows the backend catalog: an entry there DROPS the registry's copy, so all
three were suppressed on the client too. Both halves are fixed, the two kinds now declaring their
presentation next to the definition rather than the SPA restating it uninvited.

`spec-writer` also took a second kind down with it. A companion is never placed directly, it is a
toggle rendered on its producer step, so with no placeable Spec Writer the Spec Reviewer had
nowhere to attach and the whole spec pair was unreachable.

`deployer` was the sharpest case, because the engine already refuses runs over its absence:
`assertDeployerBeforeConsumer` rejects a chain that reaches a tester, human-test or playwright step
with no Deployer in front of it on a kubernetes / custom / compose service. The SPA's own copy for
that refusal says "Add a Deployer step to the pipeline", which nobody could do. The backend message
said to reseed the pipeline instead, which was the honest advice while adding one was impossible and
is now the second-best of two, so it leads with the builder.

Reviewing: `deployer` is a bare engine step with no registered kind, so it is modelled statically in
the SPA catalog like `disposer`; the other two are registered kinds and are ALSO mirrored statically,
for the reason `pr-reviewer` already is, so a `pl_bugfix` timeline names its steps before the
workspace manifest hydrates. That mirroring is the drift risk worth a look. The rest of the palette
is untouched: no preset changed, so no reseed advisory fires and no existing pipeline runs
differently.
