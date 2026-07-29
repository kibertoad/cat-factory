---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
---

Record inline (non-proxied) LLM calls into `llm_call_metrics`, so an inline agent step's model
activity is visible in-app instead of only in an external trace backend.

`InstrumentedModelProvider` was the one LLM feeder that wrote to no repository: it called
`traceSink.recordGeneration` and nothing else. So every inline call site — the judges, consensus,
the requirements writer, the fragment selector, the fork chat, and the inline agent kinds
(`doc-researcher`, `doc-outliner`, the document interviewer) — was invisible to
`ObservabilityPanel`, to a step's token rollup and to `/api/v1/debug/*`. A run made entirely of
inline steps reported zero model activity no matter what it spent, on the surfaces an operator
actually opens. This is the coverage half of C2 in `docs/initiatives/observability-logging-gaps.md`
(slice 5.6); its privacy half landed earlier.

The provider now has a second exit, the kernel `InlineLlmCallRecorder` port, implemented by
orchestration's `makeInlineCallRecorder` over the same `LlmObservabilityService` the proxy and the
subscription harnesses already feed — so all three producers converge on one store rather than a
third recording path being invented.

Two things a reviewer should look at closely. First, the provider takes **exactly one** exit per
call: the service behind the recorder performs the trace-sink fan-out itself, so a recorded call
must not also be emitted to the provider's own sink — doing both would double every inline
generation on Langfuse/OTel. Because that invariant binds two objects a facade could easily build
from different sinks (which typechecks, and merely splits the trace), neither facade assembles the
pair: `createInlineInstrumentation` composes both exits from one sink instance, and leaves the
provider's `traceSink` as the fallback for a call carrying no `workspaceId` (the metric store is
workspace-scoped, so such a call has no row to be filed under — the same deliberate fail-open the
body gate already takes for an untagged call). Second, bodies now reach the recorder ungated: the
service applies the identical `LLM_RECORD_PROMPTS` + `storeAgentContext` gate from the same kernel
factory, plus `redactSecrets` and the prompt delta chain. Re-gating in the provider was rejected
because it would withhold text the store is entitled to keep and restore the two-places-one-rule
shape that produced C2's privacy half in the first place; instead the bodies cross as thunks and
`record` resolves its gate before touching one, so a prompts-off deployment never serialises a
prompt that is about to be discarded.

**A second, pre-existing instance of C2's privacy half is fixed here too.** On both runtimes
`makeHarnessCallRecorder`'s `LlmObservabilityService` was built with no `workspaceSettingsRepository`,
and an absent repository makes `createStoreAgentContextGate` a constant `true` — so a subscription
harness's full `stream-json` prompt and response were retained for a workspace that had explicitly
opted out. It went unnoticed because that failure is silent by construction: nothing errors, the
rows simply keep their bodies. Both facades now thread the repository. Existing rows are not
rewritten; the fix applies from the next recorded call.

The row mapping deliberately reports what an inline call does not know rather than filling
proxy-shaped fields with plausible values: `turnIndex` null, `httpStatus` null, `phase` `''`,
`streaming` false, and `upstreamMs === totalMs` so the derived overhead is a real 0. Conformance
pins each of those on both runtimes' real stores, since each is one a store could quietly flatten.
Anything reading these rows should expect inline calls in the unattributed `phase=""` slice —
`backend/docs/debug-api.md` and the `investigate-telemetry` skill now say so.

**A live bug on the existing trace-sink path is fixed on the way through:** the inline feeder read
`finishReason` as a bare string, but the current AI-SDK spec reports it as `{ unified, raw }` — so
every inline call has been exporting `finishReason: null`, which reads in telemetry as "the
provider didn't say" rather than as a parse miss. It survived because the tests fed the reader a
hand-rolled result carrying the shape the reader wanted; they now drive the SDK's own
`MockLanguageModelV3` through a real `generateText`, which is what surfaced it. Both provider test
suites are consolidated into the one beside the class (they had drifted into two packages).

Behaviour note: an `InstrumentedModelProvider` built with neither exit wired now throws at
construction. Nothing in-tree does that, and it would previously have been a silent no-op wrapper
that still satisfied the facades' wiring assertions.
