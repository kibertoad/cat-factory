---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Add a built-in `media` task type, so generating images (or 3D models, audio, video) is a thing a
fresh deployment can do rather than a feature it has to build.

The binary-output machinery already did the hard part: a generating step selects its integrations
and its content types, an admission pass refuses a selection that cannot deliver them, a
comparison parks the run so a person keeps the renders worth keeping, and the step's report
records where every artifact went. All of it was reachable only by a deployment that first
registered an agent kind, an object store as a foundational service with an OpenAPI document, and
a pipeline. This ships the defaults: a `media` task type and pipeline purpose, a `media-generator`
agent kind, a `pl_media` preset with a working selection, and a storage target that exists
everywhere.

That target is the platform's own asset storage, registered as the ONE service
`defaultFoundationalServiceRegistry()` now holds (it returned an empty registry before). Its
bytes land in the account's binary-artifact store, which a local deployment defaults to the
filesystem, so an unconfigured laptop runs the whole flow; a deployment with no content storage
at all is refused up front by the `binary-storage` precondition rather than at the end of a paid
generation. A deployment that stores assets in its own bucket registers its own service and
tombstones this one, exactly as it can any other `builtin`.

Because the platform holds those bytes, it can serve them back: a stored artifact renders in the
comparison window before the choice and in the step's report after it, with links to open it and
to save a copy elsewhere. Artifacts stored this way are a new `asset` artifact kind and are EXEMPT
from the age-based retention sweep, which is sized for a run's screenshots and is the wrong clock
for the thing the run was started to produce.

Two things to watch for. `GET /api/v1/runs/{runId}/artifacts` gains an `asset` member in its kind
enum (public API 1.55.0, additive): a caller pairing screenshots against reference designs must
filter it out rather than treat it as an unmatched capture. And the foundational-services catalog
is no longer empty by default, so a surface or test that assumed an unregistered deployment
resolves zero services now sees one.
