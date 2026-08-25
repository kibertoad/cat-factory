---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/conformance': patch
'@cat-factory/acceptance-kit': patch
---

Close the two accepted findings from the second acceptance-suite gap report (now
[ADR 0060](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0060-headless-caller-diagnosability.md)).

The four SDK transports no longer render every transport failure as `failed to reach <baseUrl>`,
which is a reachability verdict made without classifying the cause and the one provably false
reading when the deployment answered nine calls a moment earlier and then restarted. Each client
classifies the cause from its own runtime's codes, states only what that cause supports, adds what
the client had already seen from the origin, and keeps the runtime's chain verbatim at the end. The
error class and its cause are unchanged, so this is additive.

On `/api/v1` (surface version 1.61.0, additive): `GET /api/v1/environments/manifest-types` publishes
every id a service's `custom` provisioning may pin, because nothing validates a pin on the way in
and an unserved id currently fails at the `deployer` step of a run already paid for. Alongside it,
the service provisioning variant gains an `infraless` member, which
`PATCH /api/v1/services/{serviceId}` accepts to TAKE A PIN BACK; omitting the key still leaves the
stored pin alone, so no request a consumer sends today changes meaning. The undo is a member rather
than a `provisioning: null` because a null-valued optional field is not expressible from the Go,
Java or Python clients, which each drop one when serializing.
