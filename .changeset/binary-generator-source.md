---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Let a mothership-mode node read the deployment's generative binary integrations from the mothership instead of from its own build.

`BinaryGeneratorRegistry` shipped registry-only, which meant a mothership deployment — two processes — had to register its integrations on both entry points, with the copies matching only while both ran the same build. A local node one build behind is the normal state of running one, and the resulting failure was both loud and misattributed: the pipeline builder's picker is fed from the workspace snapshot the mothership serves, so a human selects an integration from the product's own picker and every run of that step is then refused by the node with `unknown_generator` — naming a step configuration that is correct, with the half-wired deployment invisible in the message.

The new kernel `BinaryGeneratorSource` port (`views()` + batched `documentsFor(ids)`) mirrors `FoundationalBuiltinSource` file for file: `GET /internal/binary-generators` (+ `POST .../contracts`) is machine-token gated, mounted on both facades, and reads this process's OWN registry; `HttpBinaryGeneratorSource` throws on every unreadable outcome — a transport error, a refusal, the 404 of a mothership older than the node — rather than answering with an empty set. A mothership-mode node injects it and no longer consults its own registry for a run, warning at boot naming any ids it will ignore; the registry is still boot-validated and is what the route serves when the process is itself a mothership.

The disposition differs from the estate's in the one place that matters. Those integrations gate ADMISSION, not just prompt enrichment, so an unreachable source is re-thrown as a 503-shaped, retryable `binary_generators_unreachable` and never softened to an empty set — which would refuse correctly configured steps as `unknown_generator` for the duration of an outage. That refusal carries translated copy of its own: user-reachable 503 reasons now live in a `UNAVAILABLE_REASONS` union with an exhaustive `Record` in the SPA, because the status class's generic wording ("this deployment has not configured the capability") is the same misattribution one layer up.

The best-effort readers keep their own dispositions. The dispatch brief injects nothing, which the trait guidance already defines as "do not attempt any upload; report it". The settled-step read-back records the artifacts and the storage-side verdict — both resolve against the workspace catalog, which an unreachable mothership says nothing about — and marks only the generative judgement withheld, via a new `BinaryOutputReport.generatorsUnverified` rendered as its own warning line. An empty `unknownGenerators` means "every claimed id checked out", so the two may not be spelled alike.

Within one dispatch the two halves of a selection share ONE `views()` read (`memoizeBinaryGeneratorViews`), scoped to that read wave and discarded with it — one round trip instead of two, with no staleness window to reason about. The workspace snapshot's projection joins the board-load read wave rather than following it, for the same reason.

The workspace snapshot's picker projection reads the same source, because routing only the engine would have moved the drift to the surface that OFFERS the id rather than removing it. It carries a new `binaryGeneratorsUnavailable` flag for the state a list cannot express: an empty picker is a claim about the deployment's build, and acting on it during an outage sends someone to the wrong repository. The SPA renders that as its own message and disables the selector rather than reporting the selection as invalid.

Version floor: a node on this release needs a mothership new enough to serve the route. An older one answers 404, which surfaces as an outage rather than as a deployment that registers nothing.
