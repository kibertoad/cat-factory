---
'@cat-factory/server': minor
---

Add the mothership-mode persistence-RPC spine (the pilot core of the mothership-mode
initiative). A new machine-token audience (`TOKEN_AUDIENCE.machine`) and a reflective
`POST /internal/persistence` endpoint let a mothership-mode local node forward its
org/durable repository calls to a hosted mothership: the controller reflects over a
facade-attached repository registry (`ServerContainer.repositories`) and enforces a per-repo
method allow-list plus per-call account scoping (an out-of-scope call is a 404, no existence
leak). The client side ships `createRemoteRepositories` — a `Proxy`-backed `CoreRepositories`
subset whose wire envelope round-trips `undefined`/`null`, writes a mutated `execution.rev`
back in place (the optimistic-concurrency contract), and re-throws `DomainError`s. The
endpoint 503s on any facade that has not attached its repository registry, so existing
deployments are unaffected.
