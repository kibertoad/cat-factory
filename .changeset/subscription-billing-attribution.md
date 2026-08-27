---
'@cat-factory/orchestration': patch
'@cat-factory/conformance': patch
'@cat-factory/contracts': patch
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/kernel': patch
'@cat-factory/spend': patch
'@cat-factory/app': patch
---

Attribute an inline agent step's tokens to the credential that served them, not to the path it
ran on. A deployment serving inline steps through a subscription harness (the local facade's
ambient claude/codex CLI, or a container on a leased subscription token) filed every
non-containerised kind as metered spend with a blank vendor, so companion and research steps
were counted as money on a plan that costs nothing per token. A resolved model now declares
its billing, both metering sites forward it, and a subscription row always names a vendor.

The step-level rollup carries the billing kind too (`PipelineStep.usageBilling`), so
`metrics.costEstimate`, which is a list-price estimate for both billing kinds, renders labelled
instead of reading as spend.

The declaration travels on the resolved model, so it has to survive the provider decorators
stacked above it: the AI SDK's `wrapLanguageModel` returns a fresh object that keeps only the
members it knows about, and the inline concurrency limiter wraps every subscription vendor by
default. Both decorators now wrap through `wrapModelPreservingMarkers`, which also keeps the
existing `reportsOwnLlmCalls` marker readable wherever a decorator sits above the model that
declares it.

A consensus panel reports the billing its models agree on, so a diverted step on one
subscription credential stops filing as metered too. A panel straddling two credentials keeps
the metered default, because it did spend real money and one ledger row cannot state both.
