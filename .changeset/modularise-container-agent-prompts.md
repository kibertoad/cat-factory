---
'@cat-factory/server': patch
---

Internal refactor: extract the per-kind prompt material (the blueprint/spec-writer/merger/
on-call system prompts, the structured-output shape hints, and the
`blueprintUserPrompt`/`specWriterUserPrompt`/`mergerUserPrompt`/`onCallUserPrompt`/
`testerInfraSpec`/`prBody` builders) out of `ContainerAgentExecutor.ts` into a dedicated
`prompts.ts` module, with co-located characterisation tests. Pure code move — no behaviour,
API, or wiring change.
