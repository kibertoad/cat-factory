---
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/gatekeeper-worker': minor
---

Serve the Cloudflare OS object model, with the workspace's approval queue in front of every call.

`@cat-factory/gatekeeper-worker` gains four factories a deployment exports under the names the
workspace resolves: `GatekeeperVendor` (the entrypoint a `GATEKEEPER_*` service binding targets),
`CatFactoryAccount`, `CatFactoryResource` and `CatFactoryVerifier`. A resource is the paired
cat-factory workspace, named by a URLPattern over the deployment origin, because the provisioning
key this Worker holds is scoped to one. On that path each read is authorized before it is MADE (a
refused observation means the upstream call never happened, which matters most for the reads that
serve captured agent text) and each write is submitted and performed only when the workspace
applies it; the tier policy stays the floor underneath. A session owns the queue it was opened
with: disposing it releases the queue and refuses every action it left undecided, so a resource
object holds pending work for live sessions only. `/rpc` and the admin routes are unchanged and
still bearer-gated.

`GET /health` gains an `os` section reporting whether a Cloudflare OS deployment could discover and
install this Worker: `{ ok: true, os: { discoverable, blockers } }`, where a blocker is a missing
object-model export or a policy naming no `autoProvisionedTier`. It is reported rather than folded
into the status, because a Gatekeeper serving `/rpc` and nothing else is a supported deployment and
its monitors must not go red on a version bump.

`@cat-factory/gatekeeper-bindings` gains `SESSION_METHOD_SIGNATURES` (generated, one TypeScript
method signature per operation) and `renderSessionTypes`, which composes the `.d.ts` a granted
session serves.

Policy files gain `autoProvisionedTier`, and a deployment that wants Cloudflare OS discovery must
set it. It does not inherit from `defaultTier`: a workspace mints accounts with no identity, so no
account can match a `grants` entry, and sharing one knob would mean turning discovery on also
widened the `/rpc` door. Existing policies are unaffected and keep working with discovery off.
