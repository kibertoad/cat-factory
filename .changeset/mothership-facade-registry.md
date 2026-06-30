---
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Wire the mothership-mode persistence-RPC endpoint into both runtime facades: each attaches
its repository registry as `ServerContainer.repositories`, so a Node or Cloudflare deployment
can act as a mothership and serve `POST /internal/persistence` for mothership-mode local
nodes. The attachment is symmetric (sourced identically from each facade's `dependencies`),
and a cross-runtime conformance assertion guards it — a facade that forgot to attach its
registry would 503 instead of 403 on an unauthenticated machine call and fail the suite.
