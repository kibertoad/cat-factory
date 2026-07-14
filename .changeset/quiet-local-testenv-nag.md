---
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

fix(infra-setup): stop the false "test environment not configured" nag in local mode, and make the remaining nag actionable

Local mode on a Docker-family runtime stands the Tester's dependencies up with the
zero-config in-container `local-compose` backend, so a missing ephemeral-environment
_provider_ connection is not actually a setup gap there. The infra-setup projection
now gates the `ephemeralEnvironments` area on a new
`ephemeralEnvironmentsRequireProvider` container flag (derived from the deployment's
test-env capability via `testEnvHasZeroConfigDefault`) — exactly like
`agentExecutorRequiresRunnerPool` gates the executor area — so the banner stays quiet
where docker-compose already works and only fires where a provider is genuinely
mandatory (the Worker, stock Node, and local Apple `container`).

Where the nag still applies, its copy now tells the user what to do: open Test
environments and connect a Kubernetes cluster or a custom HTTP environment provider.
