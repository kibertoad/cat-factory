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
must carry the `asset-storage` capability tag), consulting further selected catalog services for
the SCOPE of the generation — what entities exist, which lack an asset, how each is described
(`contextServiceIds`).

The engine injects a `.cat-context/binary-output/` brief naming the selected services plus their
API contracts, refuses at pipeline save and run admission a generator step whose selection is
missing or does not resolve (`binary_output_service_invalid`), and records the agent's
machine-readable declaration of what it stored — with every loss bookkept (undeclared /
parse-failed / invalid / omitted / unknown service ids) — onto `PipelineStep.binaryOutputs`.
No built-in kind carries the trait; a deployment's generator opts in via
`registerAgentKind({ traits: ['binary-output'] })`.

Two behaviour changes reach existing code. A declaration block is now found by the shared
`extractFencedDeclaration`, which takes the LAST matching block rather than the first — the
guidance asks agents to END their reply with it, and a model that illustrates the shape earlier
had its example parsed instead of its answer. This applies to the FOUNDATIONAL-SERVICES
declaration too, which reads through the same helper: an architect whose reply showed an example
block before its real one now has the real one recorded. And the whole-catalog storage capability
tag is `asset-storage`, deliberately distinct from the agents package's `binary-storage` TRAIT
(which marks a kind needing the platform's own artifact store for run evidence) — the two meant
opposite things about opposite subjects while sharing one literal.
