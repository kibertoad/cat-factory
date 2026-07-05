---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/app': minor
---

Make the **Deployer the single environment provisioner** and fix environment-lifecycle
correctness so a `kubernetes`/`custom` service can no longer dead-end inside the Tester.

- **Deployer in every tester/human-test built-in pipeline.** A type-aware `deployer` is seeded
  before the first tester / human-test / playwright step in the 12 relevant built-ins. It
  provisions `kubernetes`/`custom`, a `docker-compose` service with a resolvable compose handler,
  or an undeclared service on a workspace with a legacy connection, and is a fast **no-op** for
  `infraless`/frontend frames (and for `docker-compose` with no compose handler configured yet) — so
  the injection is safe everywhere. Touched built-ins get a `version` bump (reseed offer).
- **Docker-compose provisions through the Deployer** (single-provisioner direction) whenever a
  compose handler resolves; the Tester then targets that provisioned env (`testerInfraSpec` already
  prefers a provisioned URL for any type). Until the shared-stacks compose-connection setup wizard
  lands, docker-compose with no handler stays a Deployer no-op and the Tester falls back to its
  in-container compose bring-up (no regression). See the initiative trackers for the full
  centralization owed once the wizard ships.
- **`human-test` no longer self-provisions.** The gate READS the environment the upstream Deployer
  provisioned (the one env is shared by the AI tester + the human), and its recreate / fix-loop /
  pull-main rebuild now **loops back to the Deployer** to re-provision, rather than standing up its
  own env. No deployer before it (an infraless service) ⇒ the gate degrades to manual mode.
- **Fail-fast run-start guard.** Starting a `kubernetes`/`custom` pipeline whose enabled chain
  reaches a tester/human-test with no enabled `deployer` before it is now refused with an actionable
  `deployer_required_before_tester` conflict (new `ConflictReason`) instead of the silent
  ephemeral-with-no-coordinates dead-end inside the Tester.
- **Environment teardown correctness.** Superseding a provisioned env now tears the old infra down
  when the new provision targets a DIFFERENT provider identity (a config-change namespace switch, a
  provider/type change, or the `infraless` flip) — best-effort, with the TTL reaper as the backstop
  — instead of only tombstoning the registry row. Teardown + status now resolve the provider from
  the env RECORD's stored provision type/engine (the handler that stood it up), not the
  workspace-primary handler.
- **Named-gate pipeline authoring.** Built-in pipelines are authored with `definePipeline` +
  named-step specs (`{ kind, gate, enabled }`) instead of fragile index-aligned `gates`/`enabled`
  boolean arrays, so a gate is declared on its step by name and inserting a step can't shift a flag
  onto the wrong one. The persisted wire shape is unchanged.
- Frontend: a `deployer` palette/step metadata entry (renders as "Deployer" rather than a generic
  agent) and the localized `deployer_required_before_tester` conflict title.

Breaking (pre-1.0, acceptable): persisted built-in pipeline copies are offered a reseed to gain the
deployer step; a `kubernetes`/`custom` pipeline that previously relied on the Tester dead-ending is
now refused at launch until a Deployer is added or the service is set to docker-compose/infraless.
