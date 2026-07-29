---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

Move private package registries into the Infrastructure window, and stop requiring package scopes.

The registries a checkout installs from are part of where agent containers RUN, not an optional
external system a workspace links in, so they are now a tab of the Infrastructure window
(alongside Agent containers / Test environments / Shared stacks) rather than an Integrations-hub
row with a modal of its own. The tab still gates on the module's own probe, so an unconfigured
backend shows no dead tab.

Package scopes are now OPTIONAL on an entry, and leaving them empty is often the right answer: an
npmrc scope mapping is all-or-nothing, so routing `@org` to a private registry makes every
`@org/*` package resolve from it — which breaks an organisation that publishes part of that scope
publicly. A scope-less entry still emits the registry host's `_authToken` line, so individual
dependencies can be pinned to it through their version specifier (pnpm's per-dependency registry
prefix) while the rest of the scope keeps resolving from the default registry. The form explains
this next to the field.

Compatibility: a scope-less entry needs harness image `1.73.0` or newer — an older image rejects
the job body outright (`packageRegistries[i].scopes must be a non-empty array`). A self-hosted
runner pool that pins its own image must be updated before a workspace configures one.
