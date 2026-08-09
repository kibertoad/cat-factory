---
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/gatekeeper-worker': minor
---

Serve the Cloudflare OS object model, with the workspace's approval queue in front of every call.

`@cat-factory/gatekeeper-worker` gains four factories a deployment exports under the names the
workspace resolves: `GatekeeperVendor` (the entrypoint a `GATEKEEPER_*` service binding targets),
`CatFactoryAccount`, `CatFactoryResource` and `CatFactoryVerifier`. A resource is the paired
cat-factory workspace, named by a URLPattern over the deployment origin, because the provisioning
key this Worker holds is scoped to one. On that path each read is authorized before its result is
returned and each write is submitted and performed only when the workspace applies it; the tier
policy stays the floor underneath. `/rpc` and the admin routes are unchanged and still bearer-gated.

`@cat-factory/gatekeeper-bindings` gains `SESSION_METHOD_SIGNATURES` (generated, one TypeScript
method signature per operation) and `renderSessionTypes`, which composes the `.d.ts` a granted
session serves.

Policy files gain `autoProvisionedTier`, and a deployment that wants Cloudflare OS discovery must
set it. It does not inherit from `defaultTier`: a workspace mints accounts with no identity, so no
account can match a `grants` entry, and sharing one knob would mean turning discovery on also
widened the `/rpc` door. Existing policies are unaffected and keep working with discovery off.
