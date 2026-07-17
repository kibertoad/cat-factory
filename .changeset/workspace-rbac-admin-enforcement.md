---
'@cat-factory/server': minor
---

Workspace RBAC (slice 6): admin-tier enforcement across the settings / integrations / secrets
route groups.

Adds `requireWorkspacePermission(perm)` — a method-shaped Hono middleware mounted once at the top
of each admin controller — so every WRITE it serves requires the group's `WorkspacePermission`
(`settings.manage` / `integrations.manage` / `secrets.manage`) while GET/HEAD reads stay open to
any resolved role (`workspace.read`). It runs before the handler's service-availability guard, so
an unauthorized member gets a clean 403 without learning whether the underlying integration is
wired, and — being co-located with the controller mount rather than a central path→permission
table — a newly added route inherits the correct gate automatically.

Applied whole-controller (each admin controller maps to exactly one permission):
`settings.manage` covers workspace settings, board rename/description/delete, tracker settings,
model presets, risk/merge presets, the workspace-scoped prompt-fragment library, and
observability / release-health / incident-enrichment config; `integrations.manage` covers the
GitHub / Slack / environments / runner-pool / task-source / document-source surfaces, package
registries, shared stacks, sandbox, bootstrap + reference architectures, and preview;
`secrets.manage` covers vendor credentials, workspace API keys, public-API keys, and test secrets.
`WorkspaceController.update`/`delete` gate per-handler (the controller also serves the ungated
`POST /workspaces` create + the `workspace.read` snapshot GET). The cross-runtime conformance
suite asserts a plain member is refused these writes (403) while the account admin is not.
