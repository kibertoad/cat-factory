---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': patch
---

Add binary-output agent steps: a kind carrying the new `binary-output` trait (image generation is
the canonical example) generates binary artifacts and stores them through a FOUNDATIONAL SERVICE
its step selects from the workspace catalog (`stepOptions.binaryOutput.storageServiceId`, which
must carry the `binary-storage` capability tag), consulting further selected catalog services for
the SCOPE of the generation — what entities exist, which lack an asset, how each is described
(`contextServiceIds`).

The engine injects a `.cat-context/binary-output/` brief naming the selected services plus their
API contracts, refuses at pipeline save and run admission a generator step whose selection is
missing or does not resolve (`binary_output_service_invalid`), and records the agent's
machine-readable declaration of what it stored — with every loss bookkept (undeclared /
parse-failed / invalid / omitted / unknown service ids) — onto `PipelineStep.binaryOutputs`.
No built-in kind carries the trait; a deployment's generator opts in via
`registerAgentKind({ traits: ['binary-output'] })`.
