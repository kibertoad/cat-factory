---
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
---

`startLocal()` now takes `seedAccountRunnerPool`, the same `(account) => { config, secrets } |
undefined` callback the Node `start()` takes, on the Postgres path. It stores a runner pool once per
account at boot and on a board's creation, and every board of the account inherits it. Agents still
run in host containers unless a board turns on `delegateAgentsToRunnerPool`. The local start-time
check for that setting now reads the inherited account pool too, where it used to read only the
board's own pool and refused a run that dispatch would have served.

In mothership mode the option is ignored with a boot warning: the account rows live on the
mothership, and a seed from the node would seal their secrets with the node's own key.

`@cat-factory/node-server` exports `buildNodeRunnerPoolService` and `runnerPoolResolveTransport`,
the two halves of `buildNodeResolveTransport`, so a facade can share one connection service between
dispatch and its own checks.
