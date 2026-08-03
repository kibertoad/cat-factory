---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Per-workspace capability credentials: the secrets a tool server or generative binary integration
declares are now stored per TENANT, sealed at rest, instead of only being read off the deployment's
environment.

An environment variable is a single-tenant answer: one process serves many workspaces, so one
variable served them all: every tenant's runs authenticated as whoever set it, no tenant could bring
its own vendor account, and rotating one tenant's key was a redeploy that rotated everyone's. Every
other credential in the platform is already a per-tenant sealed row; capabilities were the subsystem
that had not caught up.

New: `capability_credentials` (D1 + Postgres), `CapabilityCredentialsService`,
`createWorkspaceToolSecretResolver` / `composeToolSecretResolvers`, and a `secrets.manage`-gated
`/workspaces/:workspaceId/capability-credentials` surface that lists which credentials the
deployment's registered capabilities DECLARE alongside which this workspace has stored.

No behaviour change for an existing deployment: the environment resolver is composed BEHIND the
store per key, so a workspace that has stored nothing resolves exactly as before. The SPA panel is
the next slice; the API is usable now.
