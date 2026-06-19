---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Make the container LLM proxy runtime-neutral and move it into `@cat-factory/server`,
completing the migration of every HTTP controller into the shared package. The
controller keeps session verification, the spend gate, request hardening, the
OpenAI-compatible HTTP forward and streaming metering; the runtime-specific bits —
resolving an OpenAI-compatible upstream and the in-process Workers AI binding path —
move behind a new `LlmUpstream` gateway. The Worker supplies `WorkersAiLlmUpstream`
(env-keyed upstreams + the `AI` binding, with the OpenAI⇄AI-SDK translation), and
`ContainerSessionService` moves to the shared package. The Worker `app.ts` now mounts
only the shared controllers; behaviour is unchanged.
