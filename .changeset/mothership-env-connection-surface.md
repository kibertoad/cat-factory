---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
---

Mothership mode: allow-list the ephemeral-environment connection management surface.

The environment provider-connection + per-type infra-handler settings panels
(`EnvironmentController` → `EnvironmentConnectionService`: connect / list / disconnect a
backend, register / test / re-secret / unregister a per-type engine handler) are now
functional in mothership mode, alongside the workspace-defined custom-manifest-type catalog
the infra configurator reads + edits.

- Newly allow-listed in `REMOTE_PERSISTENCE_METHODS`: the whole `environmentConnectionRepository`
  (`listByWorkspace`/`getByWorkspaceAndType`/`softDelete` via the `workspace` rule, the
  record-based `upsert` via the `workspaceField` rule) and the whole `customManifestTypeRepository`
  (`listByWorkspace`/`remove` via `workspace`, `upsert` via `workspaceField`). Member-level,
  workspace-scoped — the same policy as the observability / other settings panels.
- Safe to expose like the observability connection: the connection record carries handler secrets
  as a **sealed** `secretsCipher` blob (the repo returns it verbatim; sealing/decryption live in
  the service under the local key), so no plaintext credential crosses the machine API and the
  mothership only ever stores ciphertext. Custom-manifest-type rows carry no secrets.
- `customManifestTypeRepository` (built directly over `db` by `selectNodeEnvironmentsDeps`) is now
  routed through the `pickRepoSource`/`remoteRepos` seam in `buildNodeContainer` so it resolves
  from the remote registry when there is no Postgres (`environmentConnectionRepository` was already
  routed).

Deliberately still off (a later secrets-delegation slice): actually provisioning an environment
(`environmentRegistryRepository.insert`/`update`) + decrypting a remotely-sealed access cipher.
Server-only allow-list change + one routing line, symmetric by construction.
