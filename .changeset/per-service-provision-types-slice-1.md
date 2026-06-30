---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Per-service provision types (slice 1 — additive foundation). Adds the
`provisionType`/`infraEngine`/`serviceProvisioning`/`infraHandlerConfig` and
custom-manifest-type contracts, a `provisioning` field on the service-frame `Block`
(persisted as a JSON column on both runtimes and settable via the block update endpoint),
and `provisionType`/`engine` fields on the environment handle. Introduces the per-user
infra handler override table (`environment_user_handlers`, local-mode) and the workspace
custom-manifest-type catalog (`custom_manifest_types`) — mirrored across D1 and Drizzle
with a cross-runtime conformance suite — plus `provision_type`/`engine` columns on the
`environments` registry. No behaviour is wired yet; the single→multi reshape of
`environment_connections`, the resolver, and the UI follow in later slices. See
`docs/initiatives/per-service-provision-types.md`.
