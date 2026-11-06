---
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/integrations': minor
---

`startLocal()` now takes `seedAccountRunnerPool`, the same `(account) => { config, secrets } |
undefined` callback the Node `start()` takes, on the Postgres path. It stores a runner pool once per
account at boot and on a board's creation, and every board of the account inherits it. Agents still
run in host containers unless a board turns on `delegateAgentsToRunnerPool`. The local start-time
check for that setting now reads the inherited account pool too, where it used to read only the
board's own pool and refused a run that dispatch would have served.

In mothership mode the option is ignored with a boot warning, and the node wires no account tier:
it opens pool secrets with its own key, and account rows are sealed with the mothership's. A board
on such a node needs a pool registered on it from the node.

A refused delegating run now says why in `details.runnerPool`: `none`, `inheritance_off` (the board
opted out of its account's pool), `unknown_kind` (the stored backend kind is not registered, with
`details.kind`) or `integration_off`.

`@cat-factory/node-server` exports `buildNodeRunnerPoolService` and `runnerPoolResolveTransport`,
the two halves of `buildNodeResolveTransport`, so a facade can share one connection service between
dispatch and its own checks.
