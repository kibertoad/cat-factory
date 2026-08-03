---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': patch
---

Serve the foundational-service catalog's `builtin` tier over the mothership machine API. A
mothership deployment is two processes, so a code-registered estate had to be registered on both
entry points and the copies matched only while both ran the same build — with a local node one
build behind being the normal case, and the skew silent (a run's catalog simply omits a service,
which reads like an Architect judging it irrelevant).

The tier is now read through the kernel `FoundationalBuiltinSource` port: the in-process registry by
default, `GET /internal/foundational-services` (+ the batched
`POST /internal/foundational-services/contracts`) on a mothership-mode node, which no longer consults
its own registry and warns at boot naming any ids it ignores. The remote read throws rather than
answering with an empty tier — on the 404 from a mothership older than the node, and on a 200 whose
payload it cannot read — and the injected context files STATE that outage rather than being omitted
(`FoundationalCatalogRead` / `FoundationalIndexRead` gain an `unavailable` variant), so a best-effort
dispatch cannot turn the throw back into "no shared services are registered".

Compatibility break (pre-1.0, no shim): `FoundationalServiceCatalogService` takes `builtins`
(a `FoundationalBuiltinSource`) in place of `registry`; wrap a registry with
`registryBuiltinSource(registry)`. `CoreDependencies.foundationalServiceRegistry` and the facade
options are unchanged.
