---
'@cat-factory/app': patch
---

Surface the shared run-details metadata (step position, duration, model, run id, call count and
token usage) on the two Plan Initiative windows, which previously showed none of it.

The initiative planning Q&A and tracker windows are reachable both from the run timeline and from
the board card / inspector, and the off-path entry point carries no step index — so wiring
`StepRunMeta` straight off `useResultView` would still leave them blank on the route people
actually use. The new auto-imported `useResultViewRunMeta` composable resolves the prop bundle for
both routes, falling back to the block's live run and the step whose agent kind declares the view.
