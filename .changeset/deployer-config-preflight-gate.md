---
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/app': minor
---

Deployer run-start config gate: when a pipeline includes an enabled `deployer` step, validate the service's ephemeral-environment provisioning (the in-repo "what/where") AND the workspace's infra handler (the "how") are complete + correct BEFORE starting, and — best-effort — probe the resolved deployment integration's live connection. A gap now fails loudly at start with an actionable, deep-linked toast (fix the service config / configure the handler / re-test the connection) instead of an async failed environment (or a silent docker-compose no-op) mid-run.

- New pure decision logic (`decideDeployerConfig` / `deployerServiceConfigIssues` / `hasEnabledDeployerStep`) drives a new `ExecutionService` start guard shared by start/retry/restart.
- New `EnvironmentProvisioningService.testProvisioning` probes the already-saved handler's connection; `canProvision` now honors the run initiator's local per-user handler overrides. The run initiator is threaded through every handler-resolution path — the new gate, the Tester infra gate, and the deployer's own dispatch decision — so a valid override-only local compose setup resolves identically at start and at provision time (a run that passes the gate provisions instead of silently no-opping).
- New wire conflict reasons `deployer_service_provisioning_incomplete` and `deployer_connection_test_failed`; `provision_type_unhandled` toasts now carry a "Configure infrastructure" jump.
