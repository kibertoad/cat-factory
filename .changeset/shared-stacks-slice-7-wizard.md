---
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/contracts': patch
'@cat-factory/app': minor
---

Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

**Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

- `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
- `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
- `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
- (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

**Environment setup wizard (in progress).** Adds the SPA scaffolding for the guided detect → review → preflight → save flow: a `preflights` API + store (`POST /workspaces/:ws/preflights/run`), a `provisionEnvironment` API for the optional trial provision, the `environmentWizard` store (detect, run-deep-analysis via `pl_environment_analysis`, analyst draft-merge, candidate→step conversion, save the compose handler + frame recipe), and the `ui` open/close plumbing. The wizard UI components, the frame nudge, i18n, and the e2e spec are the remaining work on this branch.

Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.
