---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

Move private package registries into the Infrastructure window, and stop requiring package scopes.

The registries a checkout installs from are part of where agent containers RUN, not an optional
external system a workspace links in, so they are now a tab of the Infrastructure window
(alongside Agent containers / Test environments / Shared stacks) rather than an Integrations-hub
row with a modal of its own. The tab still gates on the module's own probe, so an unconfigured
backend shows no dead tab. `ui.infrastructureTab` is typed against the window's full tab
vocabulary rather than the two provider-connection kinds, so the non-connection tabs (shared
stacks, package registries) are reachable by deep link instead of only by opening the window and
clicking across.

Package scopes are now OPTIONAL on an entry, and leaving them empty is often the right answer: an
npmrc scope mapping is all-or-nothing, so routing `@org` to a private registry makes every
`@org/*` package resolve from it — which breaks an organisation that publishes part of that scope
publicly. A scope-less entry still emits the registry host's `_authToken` line, which is all a
checkout needs whenever the ROUTING is already settled elsewhere: the repository commits its own
`.npmrc` (project config wins over the user config the harness writes), single dependencies carry
a named-registry prefix (`"@acme/private": "gh:^1.0.0"` — pnpm >= 11.1.0, pnpm/pnpm#11324), or the
vendor simply IS the default registry, where a scope mapping back to `registry.npmjs.org` was
always a no-op and only the credential was missing. The form explains this next to the field and
previews the scopes it parsed, so an empty save reads as deliberate rather than as a field that
silently swallowed what was typed.

Compatibility: a scope-less entry needs harness image `1.73.0` or newer. Note the blast radius —
an older image does not skip the entry, it fails `parseJob`, so EVERY container dispatch in that
workspace dies (`packageRegistries[i].scopes must be a non-empty array`), not just dependency
installs. The backend has no signal for what image a pool pins, so this cannot be gated
server-side: a self-hosted runner pool must be updated before a workspace configures a scope-less
entry. Deployments on the managed image are carried by the pin bump in this release.

Also: a package-registries read that fails for any reason OTHER than the module being
unconfigured now propagates instead of being swallowed, so the panel reports it. Previously a
`503` (no module) and an unreachable backend both rendered as an empty, silent surface — and with
the panel behind an availability-gated tab, the second case had no surface at all.
