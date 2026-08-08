---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Narrow the pipeline builder's saved-pipeline library on the purpose being edited, and make a
pipeline's purpose mandatory

The purpose dial narrowed the agent palette beside it and gated the save, but the library in the
third column listed the whole workspace catalog whatever the draft was for. `pipelineMatchesPurpose`
is the membership predicate, applied through `narrowPipelineLibrary` alongside the label and archive
filters. Each of those dials now counts what relaxing IT alone would reveal, so the "Archived (n)"
toggle no longer promises rows the current purpose is hiding either way, and the purpose hint is
itself the control that lists every purpose again: the draft's purpose is an authoring field that is
saved, so browsing past it may not require editing it.

Breaking change (internal surfaces, pre-1.0). `Pipeline.purpose` is now REQUIRED, which is what lets
those four narrowings drop their private policies for the pipelines that skipped it:

- `POST /workspaces/:ws/pipelines` requires `purpose`; `PATCH` still treats it as an optional patch
  field. Not part of `/api/v1`, so no published SDK or external integration is affected.
- `PipelineRegistry.register` requires it at compile time, so a deployment's own pipeline can no
  longer land unclassified and fall silently out of a narrowed picker. Same for the built-in seed
  catalog, where it was previously only asserted in a test.
- A row persisted before the field was mandatory still reads: the shared `rowToPipeline` resolves an
  empty column to `build`, which is byte-for-byte the behaviour such a row already had. A stored
  classifier this build cannot NAME passes through untouched instead, and every narrowing predicate
  reads it default-open, because "never set" and "a member this build has no name for" are different
  facts that must not render the same.
