---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
`local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
are simply dropped):

- the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
  into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
  block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
- the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
  consumers — the Tester's run mode is now derived from the service's provision type;
- the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
  `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
the new `EnvironmentConnectionService.resolveHandlerForType` /
`EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
step) tests against it regardless of declared type, and an undeclared service runs with no infra.
The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
service inspector replaces the local/ephemeral toggle with a provision-type selector.
