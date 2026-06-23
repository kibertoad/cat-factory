---
'@cat-factory/orchestration': patch
---

Extract `AgentContextBuilder` out of `ExecutionService` (first step of decomposing
the ~4,100-line engine). The per-step agent-context assembly — the (possibly
reworked) requirements/clarified-report substitution, linked docs/tracker issues,
the live environment, the service-frame config + account-default cloud provider, the
best-practice fragments, and the revision-context — moves into a focused collaborator
that only reads repositories. It's also the single home for service-frame resolution
(`resolveServiceFrameId`/`resolveServiceConfig`), which a few other engine paths reuse.
Pure refactor (methods moved verbatim, dependencies injected); `ExecutionService`'s
public surface and behaviour are unchanged. Trims ~325 lines from the engine.
