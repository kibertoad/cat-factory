---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/integrations': patch
'@cat-factory/conformance': patch
---

Setup advisories now go to the people who can act on them. The workspace snapshot carries
`infraSetupOwners` beside `infraSetup`, naming who can close each gap: a board admin
(`workspace_admin`), an account admin (`account_admin`) or the deployment operator (`operator`).
Content storage falls to the operator when the deployment gives an account admin no backend to
select (`AccountSettingsService.canSelectContentStorage`).

In the SPA, the infra-setup and provider-config cards render only for a caller who can save the
fix, and never on the designer surface. Everyone else gets one compact line for a gap that stops
every run (today, a missing or unreachable runner pool) that names who can fix it. The default
test-environment prompt is also kept off the designer surface.

On the repository-host gate, a caller without `integrations.manage` reads that a board admin can
connect the host, instead of "this deployment has nothing configured, ask an operator", and the
gate offers the board switcher. The AI setup dialog sends a member to the direct keys on their own
"My keys" scope, where their save lands, instead of the workspace pool they cannot write.

The new snapshot field is optional and internal: an older SPA ignores it, and this SPA falls back
to "a board admin" when a backend does not send it.
