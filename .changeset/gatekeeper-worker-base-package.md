---
'@cat-factory/gatekeeper-worker': minor
---

First release of the Cloudflare OS Gatekeeper machinery as an installable library: the Cap'n Web
capability surface compiled from `@cat-factory/gatekeeper-bindings`, per-actor API-key minting, the
verified outbound-webhook receiver and the approval inbox that answers every park a run stops on.

A deployment supplies only its policy, through `createGatekeeperWorker({ policy })`, and gets the
policy vocabulary from the runtime-free `@cat-factory/gatekeeper-worker/policy` entry point.
`deploy/gatekeeper` is the template that installs it; it was previously a copy of all of the above.
