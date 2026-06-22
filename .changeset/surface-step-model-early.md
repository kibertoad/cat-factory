---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
---

Surface a step's model the moment it starts, not only once its work finishes.

A pipeline step's `model` was recorded on the step only after the work returned: a
container step got its model from the job handle once `startJob` (which blocks for
the whole cold-boot dispatch) returned, and an inline step from the result once the
LLM query was over. But the model is fixed the instant its ref resolves (block pin >
workspace per-kind default > env routing) — well before the container is up or the
query runs — so the board showed "Spinning up container…" / a working step with no
model for that whole window.

The executor port gains an optional, side-effect-free `resolveModel(context)` that
previews the `provider:model` without dispatching (implemented by the inline
`AiAgentExecutor` and the `ContainerAgentExecutor`, forwarded by
`CompositeAgentExecutor`). The execution engine calls it up front and sets
`step.model` before the first "spinning up container" emit (container steps) and
before the blocking LLM call (inline steps), so the model rides the same emit that
shows the step starting. The job handle / result still re-assert the same value, and
the preview is best-effort (an executor that can't preview, or a resolution failure,
simply falls back to the old timing). No wire-contract change — the SPA already
renders `step.model` whenever present, so it now appears immediately. A cross-runtime
conformance assertion pins that `step.model` is set on the booting/querying emit.
