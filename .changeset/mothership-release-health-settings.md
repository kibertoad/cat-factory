---
'@cat-factory/server': patch
---

mothership: allow-list the post-release-health / observability settings surface

In mothership mode the observability connection, per-block release-health config, and
incident-enrichment connection repositories were not remotely callable over
`/internal/persistence`, so a mothership-mode SPA could not manage the post-release-health
flow's settings panels (every call came back `unknown_method`). This widens
`REMOTE_PERSISTENCE_METHODS` to their full management surface, member-level and workspace-scoped
(the controllers mount under `/workspaces/:workspaceId`, none is admin-gated) — matching the
settings-panel policy already exposed:

- `observabilityConnectionRepository` / `incidentEnrichmentConnectionRepository` — `get` +
  `delete` via the `workspace` rule (arg0 = workspaceId), `upsert(record)` via a new
  `workspaceField` scope rule.
- `releaseHealthConfigRepository` — `getByBlock` / `listByWorkspace` / `delete` via `workspace`,
  `upsert(record)` via `workspaceField`.

The new `workspaceField` scope rule binds a call whose workspaceId is a FIELD of the record arg
(not a positional arg): the write targets exactly `record.workspaceId`, so binding on it means a
record can only be persisted into an in-scope workspace; a missing/non-string field or an
out-of-scope workspace is refused as 404. Server-only allow-list change, symmetric by construction
(the dispatcher reflects over each facade's registry). Round-trip + cross-account-scope tests cover
every new method; the static drift guard moves them out of `pending`.

Scope: this makes the settings PANELS functional end-to-end (persist + read back the redacted
summary). It does NOT yet make a saved observability connection drive a post-release-health gate
probe in mothership mode — decrypting the sealed connection cipher at gate-probe time is the later
secrets-delegation slice.
